import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createBlankProject, type ClassroomSlide } from "../types";
import { boardClearSummary, slideOrderForBoardClearUndo } from "./board-clear";
import { reconcileSlides, slideFrameCustomData } from "./slides";

const slide = (frameId: string, sceneId = "board"): ClassroomSlide => ({
  id: `slide-${frameId}`, frameId, sceneId, title: `Lesson ${frameId}`, titleMode: "custom",
});
const frame = (id: string, deleted = false): ExcalidrawElement => ({
  id, type: "frame", isDeleted: deleted, name: `Lesson ${id}`,
  x: 0, y: 0, customData: slideFrameCustomData(undefined),
} as unknown as ExcalidrawElement);

describe("safe board clear", () => {
  it("counts all live board content including off-screen and locked objects", () => {
    const project = createBlankProject();
    const scene = project.scenes[project.activeSceneId];
    scene.elements = [
      { id: "visible", type: "rectangle", isDeleted: false },
      { id: "locked", type: "image", isDeleted: false, locked: true, x: 999999 },
      { id: "deleted", type: "ellipse", isDeleted: true },
    ];
    expect(boardClearSummary(project, scene.id)).toEqual({ objectCount: 2, slideCount: 0 });
    expect(() => boardClearSummary(project, "missing")).toThrow("Only the main board");
    scene.pdfPage = {} as NonNullable<typeof scene.pdfPage>;
    expect(() => boardClearSummary(project, scene.id)).toThrow("Only the main board");
  });

  it("restores original slide IDs, custom names, and explicit order on native Undo", () => {
    const original = [slide("c"), slide("a"), slide("b")];
    const elements = [frame("a"), frame("b"), frame("c")];
    const seed = slideOrderForBoardClearUndo([], original, "board", elements);
    expect(reconcileSlides("board", elements, seed)).toEqual(original);
  });

  it("never resurrects metadata for cleared tombstones or another scene", () => {
    const original = [slide("a"), slide("b", "other")];
    const current: ClassroomSlide[] = [];
    expect(slideOrderForBoardClearUndo(current, original, "board", [frame("a", true), frame("b")]))
      .toBe(current);
  });

  it("keeps current metadata and inserts restored slides alongside retained neighbors", () => {
    const original = [slide("a"), slide("other", "other"), slide("b")];
    const current = [{ ...original[1], title: "Renamed elsewhere" }, slide("new", "other")];
    expect(slideOrderForBoardClearUndo(current, original, "board", [frame("a"), frame("b")]))
      .toEqual([original[0], current[0], original[2], current[1]]);
    const alreadyRestored = [{ ...original[0], title: "New title" }];
    expect(slideOrderForBoardClearUndo(alreadyRestored, original, "board", [frame("a")]))
      .toBe(alreadyRestored);
  });

  it("treats frame IDs as scene-local when restoring a slide", () => {
    const original = [slide("same"), { ...slide("same", "other"), id: "other-slide" }];
    expect(slideOrderForBoardClearUndo([original[1]], original, "board", [frame("same")]))
      .toEqual(original);
  });
});
