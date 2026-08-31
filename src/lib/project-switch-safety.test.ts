import { describe, expect, it } from "vitest";
import { createBlankProject } from "../types";
import { projectNeedsSwitchProtection } from "./project-switch-safety";

describe("project switch safety", () => {
  it("does not interrupt opening from a untouched startup board", () => {
    expect(projectNeedsSwitchProtection(createBlankProject())).toBe(false);
  });

  it.each([
    ["custom title", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      title: "Tuesday lesson",
      titleMode: "custom" as const,
    })],
    ["drawing", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      scenes: {
        [project.activeSceneId]: {
          ...project.scenes[project.activeSceneId],
          elements: [{ id: "shape-1", type: "rectangle", isDeleted: false }],
        },
      },
    })],
    ["extra scene", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      scenes: {
        ...project.scenes,
        extra: { id: "extra", name: "Page 2", elements: [], appState: {}, files: {} },
      },
    })],
    ["project calendar event", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      projectCalendar: {
        schemaVersion: 1 as const,
        layer: "project" as const,
        events: [{
          schemaVersion: 1 as const,
          id: "event-1",
          date: "2026-09-01",
          title: "Quiz",
          color: "#7950f2",
          allDay: false,
          startTime: "09:00",
          endTime: "10:00",
          createdAt: "2026-08-30T12:00:00.000Z",
          updatedAt: "2026-08-30T12:00:00.000Z",
        }],
      },
    })],
    ["custom canvas background", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      scenes: {
        [project.activeSceneId]: {
          ...project.scenes[project.activeSceneId],
          appState: { viewBackgroundColor: "#fff3bf" },
        },
      },
    })],
    ["custom grid size", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      scenes: {
        [project.activeSceneId]: {
          ...project.scenes[project.activeSceneId],
          appState: { gridSize: 40 },
        },
      },
    })],
    ["custom grid step", (project: ReturnType<typeof createBlankProject>) => ({
      ...project,
      scenes: {
        [project.activeSceneId]: {
          ...project.scenes[project.activeSceneId],
          appState: { gridStep: 2 },
        },
      },
    })],
  ])("protects a project containing a %s", (_label, mutate) => {
    expect(projectNeedsSwitchProtection(mutate(createBlankProject()))).toBe(true);
  });

  it("ignores deleted elements, default appearance, and transient or device-only app state", () => {
    const project = createBlankProject();
    const scene = project.scenes[project.activeSceneId];
    expect(projectNeedsSwitchProtection({
      ...project,
      scenes: {
        [scene.id]: {
          ...scene,
          appState: {
            scrollX: 120,
            scrollY: -80,
            zoom: { value: 1.25 },
            selectedElementIds: { temporary: true },
            activeTool: { type: "rectangle" },
            zenModeEnabled: true,
            theme: "dark",
            gridModeEnabled: true,
            viewBackgroundColor: "#FFFFFF",
            gridSize: 20,
            gridStep: 5,
          },
          elements: [{ id: "gone", type: "rectangle", isDeleted: true }],
        },
      },
    })).toBe(false);
  });
});
