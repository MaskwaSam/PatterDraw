import { describe, expect, it } from "vitest";
import { createBlankProject, type SerializedScene } from "../../types";
import { MAX_PROJECT_SCENES } from "../structural-limits";
import {
  assertProjectCanAcceptPdfPages,
  remainingProjectSceneCapacity,
} from "./capacity";

function fillProjectToSceneCount(count: number) {
  const project = createBlankProject();
  const scenes: Record<string, SerializedScene> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `scene-${index}`;
    scenes[id] = {
      id,
      name: `Scene ${index + 1}`,
      elements: [],
      appState: {},
      files: {},
    };
  }
  project.scenes = scenes;
  project.activeSceneId = "scene-0";
  return project;
}

describe("PDF scene capacity", () => {
  it("counts the board scene and every PDF scene against the structural limit", () => {
    const project = fillProjectToSceneCount(MAX_PROJECT_SCENES - 1);
    expect(remainingProjectSceneCapacity(project)).toBe(1);
    expect(assertProjectCanAcceptPdfPages(project, 1)).toBe(0);
  });

  it("rejects before another page can make the project structurally unsavable", () => {
    const project = fillProjectToSceneCount(MAX_PROJECT_SCENES);
    expect(() => assertProjectCanAcceptPdfPages(project, 1)).toThrow(
      "This project has reached its page and scene limit",
    );
  });

  it("reports the remaining capacity for a batch", () => {
    const project = fillProjectToSceneCount(MAX_PROJECT_SCENES - 2);
    expect(() => assertProjectCanAcceptPdfPages(project, 3)).toThrow(
      "This project can add at most 2 more PDF pages.",
    );
  });

  it("rejects invalid capacity requests", () => {
    const project = createBlankProject();
    expect(() => assertProjectCanAcceptPdfPages(project, -1)).toThrow("capacity request is invalid");
    expect(() => assertProjectCanAcceptPdfPages(project, 1.5)).toThrow("capacity request is invalid");
  });
});
