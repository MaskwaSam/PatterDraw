import {
  Component, Fragment, createElement, memo, startTransition, useCallback, useLayoutEffect,
  useMemo, useState, type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import tunnel from "tunnel-rat";
import { describe, expect, it } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";
import { useAutosaveStatus } from "./autosave-status";
import { createSceneNavigationProjectUpdate } from "./scene-navigation";

function threePageProject() {
  const project = createBlankProject();
  const first = project.scenes[project.activeSceneId];
  const second = { ...first, id: "page-two", name: "Page 2" };
  const third = { ...first, id: "page-three", name: "Page 3" };
  return { ...project, scenes: { ...project.scenes, [second.id]: second, [third.id]: third } };
}

function editedCalendar(): NonNullable<ClassroomProject["projectCalendar"]> {
  return {
    schemaVersion: 1, layer: "project",
    events: [{
      schemaVersion: 1, id: "retained-event", date: "2026-10-04", title: "Field trip",
      color: "#7950f2", allDay: true, startTime: "09:00", endTime: "10:00",
      createdAt: "2026-10-04T09:00:00.000Z", updatedAt: "2026-10-04T09:00:00.000Z",
    }],
  };
}

describe("scene navigation publication", () => {
  it("reuses each input's result across A/B/A replay, with a separate cache for each intent", () => {
    const first = threePageProject();
    const second = { ...first, title: "Concurrent title" };
    const update = createSceneNavigationProjectUpdate("page-three");
    const firstResult = update(first);
    const secondResult = update(second);
    expect(firstResult).not.toBe(first);
    expect(secondResult).not.toBe(second);
    expect(update(first)).toBe(firstResult);
    expect(update(second)).toBe(secondResult);
    expect(createSceneNavigationProjectUpdate("page-three")(first)).not.toBe(firstResult);
  });

  it("preserves no-op outcomes and merges the target into each current project", () => {
    const project = threePageProject();
    const update = createSceneNavigationProjectUpdate("page-three");
    expect(update(project)?.activeSceneId).toBe("page-three");
    expect(update(null)).toBeNull();
    const missing = { ...project, scenes: { [project.activeSceneId]: project.scenes[project.activeSceneId] } };
    expect(update(missing)).toBe(missing);
    const active = { ...project, activeSceneId: "page-three" };
    expect(update(active)).toBe(active);
    const calendar = editedCalendar();
    const otherScene = { ...project.scenes["page-two"], name: "Concurrent annotation" };
    const concurrent = { ...project, title: "Edited lesson", projectCalendar: calendar, scenes: { ...project.scenes, "page-two": otherScene } };
    const merged = update(concurrent)!;
    expect(merged.activeSceneId).toBe("page-three");
    expect(merged.title).toBe(concurrent.title);
    expect(merged.projectCalendar).toBe(calendar);
    expect(merged.scenes).toBe(concurrent.scenes);
    expect(merged.scenes["page-two"]).toBe(otherScene);
    expect(project.activeSceneId).not.toBe("page-three");
  });

  it.each(["default", "transition"] as const)(
    "terminates %s-lane replay through the native onChange and menu tunnel boundary",
    async (priority) => {
      const initial = threePageProject();
      const calendar = editedCalendar();
      const otherScene = { ...initial.scenes["page-two"], name: "Retained annotation" };
      const menu = tunnel();
      const errors: Error[] = [];
      const replayed: Array<{ input: ClassroomProject | null; output: ClassroomProject | null }> = [];
      let nativeUpdates = 0;
      let layouts = 0;
      let controls!: { project: ClassroomProject | null; setProject: Dispatch<SetStateAction<ClassroomProject | null>> };
      class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch(error: Error) { errors.push(error); }
        render() { return this.state.failed ? createElement("p", null, "Editor failed") : this.props.children; }
      }
      const NativeEditor = memo(class extends Component<{ children: ReactNode; onChange: () => void }> {
        componentDidUpdate() {
          nativeUpdates += 1;
          // The pinned native editor publishes onChange after a prop update;
          // the host mirrors ordinary UI state even when its value is equal.
          this.props.onChange();
        }
        render() { return createElement(Fragment, null, this.props.children, createElement(menu.Out)); }
      });
      function Harness() {
        const [project, setProject] = useState<ClassroomProject | null>(initial);
        const [zoom, setZoom] = useState(100);
        const [status, publish] = useAutosaveStatus();
        controls = { project, setProject };
        const onChange = useCallback(() => setZoom(100), []);
        const sidebar = useMemo(() => createElement(menu.In, null, createElement("span", null, project?.title)), [project]);
        useLayoutEffect(() => { layouts += 1; publish("saving"); }, [project, publish]);
        return createElement(Fragment, null, createElement("div", null, `${zoom}:${status}`), createElement(NativeEditor, { onChange, children: sidebar }));
      }
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const actEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      // act() changes lane scheduling and can conceal this mixed-priority bug.
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        flushSync(() => root.render(createElement(Boundary, null, createElement(Harness))));
        const scheduleEdit = () => {
          controls.setProject(current => current && ({ ...current, title: "Concurrent lesson", projectCalendar: calendar, scenes: { ...current.scenes, "page-two": otherScene } }));
        };
        if (priority === "transition") startTransition(scheduleEdit);
        else scheduleEdit();
        const update = createSceneNavigationProjectUpdate("page-three");
        flushSync(() => controls.setProject(current => {
          const output = update(current);
          replayed.push({ input: current, output });
          return output;
        }));
        expect(errors).toEqual([]);
        await expect.poll(() => controls.project?.title).toBe("Concurrent lesson");
        expect(errors).toEqual([]);
        expect(controls.project?.activeSceneId).toBe("page-three");
        expect(controls.project?.projectCalendar).toBe(calendar);
        expect(controls.project?.scenes["page-two"]).toBe(otherScene);
        const repeated = replayed.filter(({ input }) => input === initial);
        expect(repeated.length).toBeGreaterThan(1);
        expect(repeated.every(({ output }) => output === repeated[0].output)).toBe(true);
        expect(nativeUpdates).toBeGreaterThan(0);
        expect(layouts).toBeLessThan(10);
      } finally {
        flushSync(() => root.unmount());
        container.remove();
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    },
  );
});
