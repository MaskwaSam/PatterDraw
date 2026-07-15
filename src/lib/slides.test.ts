import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { focusSlide, moveSlide, reconcileSlides } from "./slides";

const frame = (id: string, x: number, y: number, name: string | null = null) => ({
  id, type: "frame", x, y, name, isDeleted: false,
}) as unknown as ExcalidrawElement;

describe("slides", () => {
  it("seeds new frames in row order and then preserves explicit order", () => {
    const initial = reconcileSlides("scene", [frame("b", 400, 0), frame("a", 0, 0)], []);
    expect(initial.map((slide) => slide.frameId)).toEqual(["a", "b"]);
    const reordered = moveSlide(initial, initial[1].id, initial[0].id);
    const reconciled = reconcileSlides("scene", [frame("a", 0, 0), frame("b", 400, 0)], reordered);
    expect(reconciled.map((slide) => slide.frameId)).toEqual(["b", "a"]);
  });

  it("removes slides when their frame is deleted", () => {
    const initial = reconcileSlides("scene", [frame("a", 0, 0)], []);
    expect(reconcileSlides("scene", [], initial)).toEqual([]);
  });

  it("uses the requested Morph duration when focusing a slide", () => {
    const slideFrame = frame("a", 0, 0);
    const scrollToContent = vi.fn();
    const api = {
      getSceneElements: () => [slideFrame],
      scrollToContent,
    } as unknown as ExcalidrawImperativeAPI;

    expect(focusSlide(api, "a", true, 650)).toBe(true);
    expect(scrollToContent).toHaveBeenCalledWith(slideFrame, {
      fitToViewport: true,
      viewportZoomFactor: 0.92,
      animate: true,
      duration: 650,
    });
  });
});
