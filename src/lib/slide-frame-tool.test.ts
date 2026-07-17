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
  blankSlidePosition,
  BLANK_SLIDE_GAP,
  BLANK_SLIDE_HEIGHT,
  BLANK_SLIDE_WIDTH,
  constrainNewSlideFramesToAspectRatio,
  frameBoundsAtAspectRatio,
  slideFrameAspectRatioValue,
  SLIDE_FRAME_HINT,
  STANDARD_SLIDE_ASPECT_RATIO,
  WIDESCREEN_SLIDE_ASPECT_RATIO,
} from "./slide-frame-tool";

describe("slide frame tool", () => {
  it("enables visible native frames and selects the one-shot frame tool", () => {
    const api = {
      updateFrameRendering: vi.fn(),
      setActiveTool: vi.fn(),
      setToast: vi.fn(),
    };

    activateSlideFrameTool(api as never);

    expect(api.updateFrameRendering).toHaveBeenCalledWith({ outline: true, name: true, clip: false });
    expect(api.setActiveTool).toHaveBeenCalledWith({ type: "frame" });
    expect(api.setToast).toHaveBeenCalledWith({ message: SLIDE_FRAME_HINT });
  });

  it("announces the selected aspect-ratio constraint", () => {
    const api = {
      updateFrameRendering: vi.fn(),
      setActiveTool: vi.fn(),
      setToast: vi.fn(),
    };

    activateSlideFrameTool(api as never, "16:9");

    expect(api.setToast).toHaveBeenCalledWith({ message: expect.stringContaining("16:9 frame tool ready") });

    activateSlideFrameTool(api as never, "4:3");
    expect(api.setToast).toHaveBeenLastCalledWith({ message: expect.stringContaining("4:3 frame tool ready") });
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
      { id: "first", type: "frame", x: 0, y: 50, width: 960, height: 540, isDeleted: false },
      { id: "second", type: "frame", x: 1200, y: 80, width: 960, height: 540, isDeleted: false },
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
