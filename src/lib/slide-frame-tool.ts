import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/excalidraw/element/types";
import type { SlideFrameAspectRatio } from "../types";
import { createLocalId } from "./id";

type SlideFrameApi = Pick<
  ExcalidrawImperativeAPI,
  "setActiveTool" | "setToast" | "updateFrameRendering"
>;

export const SLIDE_FRAME_HINT = "Frame tool ready — drag on the board to set the slide bounds.";
export const BLANK_SLIDE_WIDTH = 960;
export const BLANK_SLIDE_HEIGHT = 540;
export const BLANK_SLIDE_GAP = 160;
export const WIDESCREEN_SLIDE_ASPECT_RATIO = 16 / 9;
export const STANDARD_SLIDE_ASPECT_RATIO = 4 / 3;

export function slideFrameAspectRatioValue(mode: SlideFrameAspectRatio): number | null {
  if (mode === "16:9") return WIDESCREEN_SLIDE_ASPECT_RATIO;
  if (mode === "4:3") return STANDARD_SLIDE_ASPECT_RATIO;
  return null;
}

export function activateSlideFrameTool(
  api: SlideFrameApi,
  aspectMode: SlideFrameAspectRatio = "freeform",
): void {
  api.updateFrameRendering({ outline: true, name: true, clip: false });
  api.setActiveTool({ type: "frame" });
  api.setToast({
    message: aspectMode === "freeform"
      ? SLIDE_FRAME_HINT
      : `${aspectMode} frame tool ready — drag around the content to set the slide bounds.`,
  });
}

export function frameBoundsAtAspectRatio(
  frame: Pick<ExcalidrawFrameElement, "x" | "y" | "width" | "height">,
  aspectRatio = WIDESCREEN_SLIDE_ASPECT_RATIO,
): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new Error("Slide frame aspect ratio must be a positive finite number.");
  }
  const left = Math.min(frame.x, frame.x + frame.width);
  const right = Math.max(frame.x, frame.x + frame.width);
  const top = Math.min(frame.y, frame.y + frame.height);
  const bottom = Math.max(frame.y, frame.y + frame.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const nextWidth = width / height < aspectRatio ? height * aspectRatio : width;
  const nextHeight = width / height > aspectRatio ? width / aspectRatio : height;
  return {
    x: centerX - nextWidth / 2,
    y: centerY - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
  };
}

/** Expands only newly drawn frames to an aspect ratio while preserving the dragged area. */
export function constrainNewSlideFramesToAspectRatio(
  elements: readonly ExcalidrawElement[],
  existingFrameIds: ReadonlySet<string>,
  aspectRatio: number,
): readonly ExcalidrawElement[] {
  let changed = false;
  const nextElements = elements.map((element) => {
    if (element.type !== "frame" || element.isDeleted || existingFrameIds.has(element.id)) return element;
    const bounds = frameBoundsAtAspectRatio(element, aspectRatio);
    if (
      Math.abs(element.x - bounds.x) < 0.000_001
      && Math.abs(element.y - bounds.y) < 0.000_001
      && Math.abs(element.width - bounds.width) < 0.000_001
      && Math.abs(element.height - bounds.height) < 0.000_001
    ) return element;
    changed = true;
    return newElementWith(element, bounds);
  });
  return changed ? nextElements : elements;
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
