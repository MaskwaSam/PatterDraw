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
  SLIDE_FRAME_HINT,
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
