import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/excalidraw/element/types";
import { createLocalId } from "./id";

type SlideFrameApi = Pick<
  ExcalidrawImperativeAPI,
  "setActiveTool" | "setToast" | "updateFrameRendering"
>;

export const SLIDE_FRAME_HINT = "Frame tool ready — drag on the board to set the slide bounds.";
export const BLANK_SLIDE_WIDTH = 960;
export const BLANK_SLIDE_HEIGHT = 540;
export const BLANK_SLIDE_GAP = 160;

export function activateSlideFrameTool(api: SlideFrameApi): void {
  api.updateFrameRendering({ outline: true, name: true, clip: false });
  api.setActiveTool({ type: "frame" });
  api.setToast({ message: SLIDE_FRAME_HINT });
}

export function blankSlidePosition(
  elements: readonly ExcalidrawElement[],
  api: Pick<ExcalidrawImperativeAPI, "getAppState">,
): { x: number; y: number } {
  const frames = elements.filter(
    (element): element is ExcalidrawFrameElement => element.type === "frame" && !element.isDeleted,
  );
  if (frames.length) {
    const rightmost = frames.reduce((current, candidate) => {
      const currentRight = Math.max(current.x, current.x + current.width);
      const candidateRight = Math.max(candidate.x, candidate.x + candidate.width);
      return candidateRight > currentRight ? candidate : current;
    });
    return {
      x: Math.max(rightmost.x, rightmost.x + rightmost.width) + BLANK_SLIDE_GAP,
      y: Math.min(rightmost.y, rightmost.y + rightmost.height),
    };
  }

  const appState = api.getAppState();
  const center = viewportCoordsToSceneCoords(
    {
      clientX: appState.offsetLeft + appState.width / 2,
      clientY: appState.offsetTop + appState.height / 2,
    },
    appState,
  );
  return {
    x: center.x - BLANK_SLIDE_WIDTH / 2,
    y: center.y - BLANK_SLIDE_HEIGHT / 2,
  };
}

/** Adds a native, empty Excalidraw frame without replacing or remounting the editor. */
export function addBlankSlideFrame(
  api: ExcalidrawImperativeAPI,
  name: string,
  frameId = createLocalId(),
): ExcalidrawFrameElement {
  const elements = api.getSceneElements();
  const position = blankSlidePosition(elements, api);
  const [frame] = convertToExcalidrawElements(
    [{
      id: frameId,
      type: "frame",
      children: [],
      name,
      x: position.x,
      y: position.y,
      width: BLANK_SLIDE_WIDTH,
      height: BLANK_SLIDE_HEIGHT,
    }],
    { regenerateIds: false },
  ) as [ExcalidrawFrameElement];

  api.updateFrameRendering({ outline: true, name: true, clip: false });
  api.setActiveTool({ type: "selection" });
  api.updateScene({
    elements: [...elements, frame],
    appState: { selectedElementIds: { [frame.id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.scrollToContent(frame, {
    fitToViewport: true,
    viewportZoomFactor: 0.86,
    maxZoom: 1,
    animate: true,
    duration: 240,
  });
  api.setToast({ message: "Slide added — draw on or beyond the frame." });
  return frame;
}
