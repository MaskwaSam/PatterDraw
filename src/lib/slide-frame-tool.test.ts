import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (elements: Array<Record<string, unknown>>) => elements.map(
    (element, index) => ({
      isDeleted: false,
      frameId: null,
      version: 1,
      versionNonce: index + 1,
      index: `a${index}`,
      ...element,
    }),
  ),
  elementsOverlappingBBox: ({
    elements,
    bounds,
  }: {
    elements: Array<{ x: number; y: number; width: number; height: number }>;
    bounds: [number, number, number, number];
  }) => elements.filter((element) => (
    element.x >= bounds[0]
    && element.y >= bounds[1]
    && element.x + element.width <= bounds[2]
    && element.y + element.height <= bounds[3]
  )),
  newElementWith: (element: Record<string, unknown>, updates: Record<string, unknown>) => ({
    ...element,
    ...updates,
    version: Number(element.version || 0) + 1,
  }),
  viewportCoordsToSceneCoords: (
    point: { clientX: number; clientY: number },
    appState: { offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number; zoom: { value: number } },
  ) => ({
    x: (point.clientX - appState.offsetLeft) / appState.zoom.value - appState.scrollX,
    y: (point.clientY - appState.offsetTop) / appState.zoom.value - appState.scrollY,
  }),
}));

import {
  activateSlideFrameTool,
  addBlankSlideFrame,
  addSlideFrameAtBounds,
  blankSlidePosition,
  BLANK_SLIDE_GAP,
  BLANK_SLIDE_HEIGHT,
  BLANK_SLIDE_WIDTH,
  constrainNewSlideFramesToAspectRatio,
  frameBoundsAtAspectRatio,
  frameBoundsFromDrag,
  freeformFrameBoundsFromDrag,
  setNewSlideFrameBounds,
  slideFrameAspectRatioValue,
  SLIDE_FRAME_HINT,
  STANDARD_SLIDE_ASPECT_RATIO,
  WIDESCREEN_SLIDE_ASPECT_RATIO,
} from "./slide-frame-tool";

describe("slide frame tool", () => {
  it("keeps native selection active while arming the wrapper-owned slide tool", () => {
    const api = {
      updateFrameRendering: vi.fn(),
      setActiveTool: vi.fn(),
      setToast: vi.fn(),
    };

    activateSlideFrameTool(api as never);

    expect(api.updateFrameRendering).toHaveBeenCalledWith({ outline: true, name: true, clip: false });
    expect(api.setActiveTool).toHaveBeenCalledWith({ type: "selection" });
    expect(api.setToast).toHaveBeenCalledWith({ message: SLIDE_FRAME_HINT });
  });

  it("announces the selected aspect-ratio constraint", () => {
    const api = {
      updateFrameRendering: vi.fn(),
      setActiveTool: vi.fn(),
      setToast: vi.fn(),
    };

    activateSlideFrameTool(api as never, "16:9");

    expect(api.setToast).toHaveBeenCalledWith({ message: expect.stringContaining("16:9 slide ready") });

    activateSlideFrameTool(api as never, "4:3");
    expect(api.setToast).toHaveBeenLastCalledWith({ message: expect.stringContaining("4:3 slide ready") });
  });

  it("maps frame-shape modes to their numeric aspect ratios", () => {
    expect(slideFrameAspectRatioValue("freeform")).toBeNull();
    expect(slideFrameAspectRatioValue("16:9")).toBe(WIDESCREEN_SLIDE_ASPECT_RATIO);
    expect(slideFrameAspectRatioValue("4:3")).toBe(STANDARD_SLIDE_ASPECT_RATIO);
  });

  it("expands dragged bounds around their centre to reach 16:9", () => {
    expect(frameBoundsAtAspectRatio({ x: 100, y: 200, width: 300, height: 200 })).toEqual({
      x: 100 - (200 * WIDESCREEN_SLIDE_ASPECT_RATIO - 300) / 2,
      y: 200,
      width: 200 * WIDESCREEN_SLIDE_ASPECT_RATIO,
      height: 200,
    });
    expect(frameBoundsAtAspectRatio({ x: 100, y: 200, width: 400, height: 100 })).toEqual({
      x: 100,
      y: 200 - (400 / WIDESCREEN_SLIDE_ASPECT_RATIO - 100) / 2,
      width: 400,
      height: 400 / WIDESCREEN_SLIDE_ASPECT_RATIO,
    });
  });

  it("expands dragged bounds around their centre to reach 4:3", () => {
    const bounds = frameBoundsAtAspectRatio(
      { x: 100, y: 200, width: 300, height: 100 },
      STANDARD_SLIDE_ASPECT_RATIO,
    );
    expect(bounds).toEqual({
      x: 100,
      y: 200 - (300 / STANDARD_SLIDE_ASPECT_RATIO - 100) / 2,
      width: 300,
      height: 300 / STANDARD_SLIDE_ASPECT_RATIO,
    });
  });

  it("locks live drag bounds to the selected ratio while keeping the drag origin fixed", () => {
    const widescreen = frameBoundsFromDrag(
      { x: 100, y: 200 },
      { x: 400, y: 400 },
      WIDESCREEN_SLIDE_ASPECT_RATIO,
    );
    expect(widescreen.x).toBe(100);
    expect(widescreen.y).toBe(200);
    expect(widescreen.width).toBeCloseTo(200 * WIDESCREEN_SLIDE_ASPECT_RATIO, 8);
    expect(widescreen.height).toBe(200);
    expect(widescreen.width / widescreen.height).toBeCloseTo(WIDESCREEN_SLIDE_ASPECT_RATIO, 8);

    const reverse = frameBoundsFromDrag(
      { x: 400, y: 400 },
      { x: 100, y: 200 },
      STANDARD_SLIDE_ASPECT_RATIO,
    );
    expect(reverse.x + reverse.width).toBe(400);
    expect(reverse.y + reverse.height).toBe(400);
    expect(reverse.x).toBeLessThanOrEqual(100);
    expect(reverse.y).toBeLessThanOrEqual(200);
    expect(reverse.width / reverse.height).toBeCloseTo(STANDARD_SLIDE_ASPECT_RATIO, 8);
  });

  it("creates stable aspect-ratio bounds for horizontal and vertical drags", () => {
    expect(frameBoundsFromDrag(
      { x: 10, y: 20 },
      { x: 170, y: 20 },
      WIDESCREEN_SLIDE_ASPECT_RATIO,
    )).toEqual({ x: 10, y: 20, width: 160, height: 90 });

    const vertical = frameBoundsFromDrag(
      { x: 10, y: 200 },
      { x: 10, y: 80 },
      STANDARD_SLIDE_ASPECT_RATIO,
    );
    expect(vertical).toEqual({ x: 10, y: 80, width: 160, height: 120 });
  });

  it("normalizes freeform drags in every direction", () => {
    expect(freeformFrameBoundsFromDrag(
      { x: 300, y: 250 },
      { x: 100, y: 50 },
    )).toEqual({ x: 100, y: 50, width: 200, height: 200 });
  });

  it("applies the live drag bounds only to the newly created frame", () => {
    const existing = { id: "existing", type: "frame", x: 0, y: 0, width: 300, height: 200, isDeleted: false };
    const created = { id: "created", type: "frame", x: 400, y: 100, width: 20, height: 20, isDeleted: false };
    const rectangle = { id: "shape", type: "rectangle", x: 450, y: 120, width: 40, height: 40, isDeleted: false };
    const input = [existing, rectangle, created] as unknown as ExcalidrawElement[];
    const bounds = { x: 400, y: 100, width: 320, height: 180 };

    const result = setNewSlideFrameBounds(input, new Set(["existing"]), bounds);

    expect(result[0]).toBe(existing);
    expect(result[1]).toBe(rectangle);
    expect(result[2]).toMatchObject(bounds);
  });

  it("creates one undoable tagged slide without adopting enclosed content", () => {
    const inside = {
      id: "inside",
      type: "rectangle",
      x: 120,
      y: 120,
      width: 30,
      height: 30,
      isDeleted: false,
      frameId: null,
      groupIds: [],
      version: 1,
    };
    const outside = {
      id: "outside",
      type: "rectangle",
      x: 400,
      y: 400,
      width: 30,
      height: 30,
      isDeleted: false,
      frameId: null,
      groupIds: [],
      version: 1,
    };
    const updateScene = vi.fn();
    const api = {
      getSceneElements: () => [inside, outside],
      setActiveTool: vi.fn(),
      updateFrameRendering: vi.fn(),
      updateScene,
    };

    const frame = addSlideFrameAtBounds(
      api as never,
      { x: 100, y: 100, width: 160, height: 90 },
      "Slide 1",
      "touch-frame",
    );

    expect(frame).toMatchObject({ id: "touch-frame", width: 160, height: 90 });
    expect(updateScene).toHaveBeenCalledOnce();
    const update = updateScene.mock.calls[0][0];
    expect(update.captureUpdate).toBe("IMMEDIATELY");
    expect(update.elements.find((element: ExcalidrawElement) => element.id === "inside")?.frameId)
      .toBeNull();
    expect(update.elements.find((element: ExcalidrawElement) => element.id === "outside")?.frameId)
      .toBeNull();
    expect(update.appState.selectedElementIds).toEqual({ "touch-frame": true });
    expect(frame.customData?.classroomSlide).toEqual({ kind: "slide", version: 1 });
  });

  it("returns the touch-fallback frame tool to selection after one frame", () => {
    const api = {
      getSceneElements: () => [],
      setActiveTool: vi.fn(),
      updateFrameRendering: vi.fn(),
      updateScene: vi.fn(),
    };

    addSlideFrameAtBounds(
      api as never,
      { x: 100, y: 100, width: 160, height: 90 },
      "Slide 1",
      "one-shot-touch-frame",
    );

    expect(api.setActiveTool).toHaveBeenCalledWith({ type: "selection" });
  });

  it("constrains only newly drawn frames without changing existing frames or scene objects", () => {
    const existing = { id: "existing", type: "frame", x: 0, y: 0, width: 300, height: 200, isDeleted: false };
    const created = { id: "created", type: "frame", x: 400, y: 100, width: 300, height: 200, isDeleted: false };
    const rectangle = { id: "shape", type: "rectangle", x: 450, y: 120, width: 40, height: 40, isDeleted: false };
    const input = [existing, rectangle, created] as unknown as ExcalidrawElement[];

    const result = constrainNewSlideFramesToAspectRatio(
      input,
      new Set(["existing"]),
      STANDARD_SLIDE_ASPECT_RATIO,
    );

    expect(result[0]).toBe(existing);
    expect(result[1]).toBe(rectangle);
    expect(result[2].width / result[2].height).toBeCloseTo(STANDARD_SLIDE_ASPECT_RATIO, 8);
    expect(result[2].width).toBeGreaterThanOrEqual(created.width);
    expect(result[2].height).toBeGreaterThanOrEqual(created.height);
  });

  it("places the first blank slide at the viewport centre", () => {
    const api = {
      getAppState: () => ({
        offsetLeft: 0,
        offsetTop: 0,
        width: 1200,
        height: 800,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      }),
    };

    expect(blankSlidePosition([], api as never)).toEqual({
      x: 600 - BLANK_SLIDE_WIDTH / 2,
      y: 400 - BLANK_SLIDE_HEIGHT / 2,
    });
  });

  it("places later slides beside the rightmost frame", () => {
    const frames = [
      { id: "first", type: "frame", x: 0, y: 50, width: 960, height: 540, isDeleted: false, customData: { classroomSlide: { kind: "slide", version: 1 } } },
      { id: "second", type: "frame", x: 1200, y: 80, width: 960, height: 540, isDeleted: false, customData: { classroomSlide: { kind: "slide", version: 1 } } },
    ] as unknown as ExcalidrawElement[];

    expect(blankSlidePosition(frames, { getAppState: vi.fn() } as never)).toEqual({
      x: 2160 + BLANK_SLIDE_GAP,
      y: 80,
    });
  });

  it("adds and focuses a native 16:9 frame in one action", () => {
    const api = {
      getSceneElements: vi.fn(() => []),
      getAppState: vi.fn(() => ({
        offsetLeft: 0,
        offsetTop: 0,
        width: 1200,
        height: 800,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      })),
      updateFrameRendering: vi.fn(),
      setActiveTool: vi.fn(),
      updateScene: vi.fn(),
      scrollToContent: vi.fn(),
      setToast: vi.fn(),
    };

    const frame = addBlankSlideFrame(api as never, "Slide 1");

    expect(frame).toMatchObject({
      type: "frame",
      name: "Slide 1",
      width: BLANK_SLIDE_WIDTH,
      height: BLANK_SLIDE_HEIGHT,
      customData: { classroomSlide: { kind: "slide", version: 1 } },
    });
    expect(api.updateScene).toHaveBeenCalledWith(expect.objectContaining({
      elements: [frame],
      appState: { selectedElementIds: { [frame.id]: true } },
    }));
    expect(api.updateFrameRendering).toHaveBeenCalledWith({ outline: true, name: true, clip: false });
    expect(api.setActiveTool).toHaveBeenCalledWith({ type: "selection" });
    expect(api.scrollToContent).toHaveBeenCalledWith(frame, expect.objectContaining({
      fitToViewport: true,
    }));
  });
});
