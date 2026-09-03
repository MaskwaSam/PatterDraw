import { createElement, startTransition, useLayoutEffect, useState, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useAutosaveStatus, type SaveStatus } from "./autosave-status";

type Project = { page: string; title: string; calendar: string[]; otherScene: { note: string } };
type Priority = "default" | "transition";
const schedule = (priority: Priority, callback: () => void) => {
  if (priority === "transition") startTransition(callback);
  else callback();
};

function mount() {
  const initial: Project = { page: "one", title: "Lesson", calendar: [], otherScene: { note: "Kept" } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const actEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  // act() changes lane scheduling and can hide the replay being tested.
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  let layouts = 0;
  let controls!: {
    project: Project;
    setProject: Dispatch<SetStateAction<Project>>;
    status: SaveStatus;
    publish: (next: SaveStatus) => void;
    settled: number;
    setSettled: Dispatch<SetStateAction<number>>;
  };
  function Harness() {
    const [project, setProject] = useState(initial);
    const [status, publish] = useAutosaveStatus();
    const [settled, setSettled] = useState(0);
    controls = { project, setProject, status, publish, settled, setSettled };
    useLayoutEffect(() => {
      layouts += 1;
      // Match App: content changes request Saving unconditionally. Status-only
      // updates must not restart this effect or schedule another save.
      publish("saving");
    }, [project, publish]);
    return createElement("div", null, `${project.page}:${status}`);
  }
  flushSync(() => root.render(createElement(Harness)));
  return {
    initial,
    controls: () => controls,
    layouts: () => layouts,
    cleanup: () => {
      flushSync(() => root.unmount());
      container.remove();
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

describe("autosave status publication", () => {
  it.each(["default", "transition"] as const)(
    "terminates allocating scene-switch replay with pending %s-lane edits",
    async (priority) => {
      const app = mount();
      try {
        const ahead = { ...app.initial, title: "Queued lesson" };
        const calendar = ["Field trip"];
        const otherScene = { note: "Concurrent annotation" };
        schedule(priority, () => {
          app.controls().setProject(ahead);
          app.controls().setProject(current => ({ ...current, calendar, otherScene }));
        });
        const inputs: Project[] = [];
        // Deliberately no project memoization: openScene's ordinary functional
        // update allocates for every different active page, including replays.
        flushSync(() => app.controls().setProject(current => {
          inputs.push(current);
          return current.page === "three" ? current : { ...current, page: "three" };
        }));
        await vi.waitFor(() => expect(app.controls().project.calendar).toBe(calendar));
        expect(inputs).toContain(app.initial);
        expect(inputs.some(input => input !== app.initial)).toBe(true);
        expect(app.controls().project).toEqual({ ...ahead, page: "three", calendar, otherScene });
        expect(app.controls().project.otherScene).toBe(otherScene);
        expect(app.controls().status).toBe("saving");
        expect(app.layouts()).toBeLessThan(10);
      } finally { app.cleanup(); }
    },
  );

  it.each(["default", "transition"] as const)(
    "supersedes a queued %s-lane Saved completion when new content becomes dirty",
    async (priority) => {
      const app = mount();
      try {
        const publish = app.controls().publish;
        schedule(priority, () => {
          publish("saved");
          // This witness must not change the project and restart autosave:
          // the queued Saved completion must be superseded on its own.
          app.controls().setSettled(1);
        });
        flushSync(() => app.controls().setProject(current => ({ ...current, page: "two" })));
        expect(app.controls().status).toBe("saving");
        await vi.waitFor(() => expect(app.controls().settled).toBe(1));
        expect(app.controls().project.page).toBe("two");
        expect(app.controls().status).toBe("saving");
        expect(app.controls().publish).toBe(publish);
        expect(app.layouts()).toBeLessThan(10);
      } finally { app.cleanup(); }
    },
  );

  it.each(["default", "transition"] as const)(
    "promotes a pending %s-lane Saving request before a dirty page is painted",
    async (priority) => {
      const app = mount();
      try {
        flushSync(() => app.controls().publish("saved"));
        expect(app.controls().status).toBe("saved");
        schedule(priority, () => {
          app.controls().publish("saving");
          app.controls().setSettled(1);
        });
        flushSync(() => app.controls().setProject(current => ({ ...current, page: "two" })));
        // Check before yielding: a requested-only guard leaves Saved visible
        // until the lower-priority queue runs, despite the dirty page commit.
        expect(app.controls().status).toBe("saving");
        await vi.waitFor(() => expect(app.controls().settled).toBe(1));
        expect(app.controls().status).toBe("saving");
        expect(app.layouts()).toBeLessThan(10);
      } finally { app.cleanup(); }
    },
  );

  it.each(["saved", "error"] as const)(
    "publishes %s without treating status as a content edit or scheduling another save",
    (next) => {
      const app = mount();
      try {
        const layoutsBefore = app.layouts();
        const publish = app.controls().publish;
        flushSync(() => publish(next));
        expect(app.controls().status).toBe(next);
        expect(app.controls().project).toBe(app.initial);
        expect(app.layouts()).toBe(layoutsBefore);
        expect(app.controls().publish).toBe(publish);
        flushSync(() => publish(next));
        expect(app.controls().status).toBe(next);
        expect(app.layouts()).toBe(layoutsBefore);
      } finally { app.cleanup(); }
    },
  );
});
