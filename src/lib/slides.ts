import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/excalidraw/element/types";
import type { ClassroomSlide, SceneId } from "../types";
import { createLocalId } from "./id";

export function isFrame(element: ExcalidrawElement): element is ExcalidrawFrameElement {
  return !element.isDeleted && element.type === "frame";
}

export function reconcileSlides(
  sceneId: SceneId,
  elements: readonly ExcalidrawElement[],
  current: readonly ClassroomSlide[],
): ClassroomSlide[] {
  const frames = elements.filter(isFrame);
  const frameIds = new Set(frames.map((frame) => frame.id));
  const retained = current.filter(
    (slide) => slide.sceneId !== sceneId || frameIds.has(slide.frameId),
  );
  const known = new Set(retained.map((slide) => `${slide.sceneId}:${slide.frameId}`));
  const newFrames = frames
    .filter((frame) => !known.has(`${sceneId}:${frame.id}`))
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((frame, index) => ({
      id: createLocalId(),
      sceneId,
      frameId: frame.id,
      title: frame.name?.trim() || `Slide ${retained.length + index + 1}`,
    }));
  return [...retained, ...newFrames];
}

export function moveSlide(
  slides: readonly ClassroomSlide[],
  slideId: string,
  targetId: string,
): ClassroomSlide[] {
  const from = slides.findIndex((slide) => slide.id === slideId);
  const to = slides.findIndex((slide) => slide.id === targetId);
  if (from < 0 || to < 0 || from === to) return [...slides];
  const next = [...slides];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function focusSlide(
  api: ExcalidrawImperativeAPI,
  frameId: string,
  animate = true,
  duration = animate ? 300 : 0,
): boolean {
  const frame = api.getSceneElements().find((element) => element.id === frameId && isFrame(element));
  if (!frame) return false;
  api.scrollToContent(frame, {
    fitToViewport: true,
    viewportZoomFactor: 0.92,
    animate,
    duration,
  });
  return true;
}

export function elementsForSlide(
  elements: readonly ExcalidrawElement[],
  frameId: string,
): ExcalidrawElement[] {
  return elements.filter(
    (element) => !element.isDeleted && (element.id === frameId || element.frameId === frameId),
  );
}
