import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ClassroomProject, ClassroomSlide } from "../types";
import { isSlideFrame } from "./slides";

export function boardClearSummary(project: ClassroomProject, sceneId: string) {
  const scene = project.scenes[sceneId];
  if (!scene || scene.pdfPage) throw new Error("Only the main board can be cleared here.");
  return {
    objectCount: scene.elements.filter((element) => !element.isDeleted).length,
    slideCount: project.slideOrder.filter((slide) => slide.sceneId === sceneId).length,
  };
}

/** Native history restores frames, but not wrapper-owned slide IDs/order. */
export function slideOrderForBoardClearUndo(
  current: readonly ClassroomSlide[],
  retained: readonly ClassroomSlide[],
  sceneId: string,
  elements: readonly ExcalidrawElement[],
): readonly ClassroomSlide[] {
  if (!retained.length) return current;
  const key = (slide: ClassroomSlide) => JSON.stringify([slide.sceneId, slide.frameId]);
  const frames = new Set(elements.filter(isSlideFrame).map((element) => element.id));
  const known = new Set(current.map(key));
  const restored = retained.filter((slide) => (
    slide.sceneId === sceneId && frames.has(slide.frameId) && !known.has(key(slide))
  ));
  if (!restored.length) return current;
  const result = [...current];
  for (const slide of restored) {
    const originalIndex = retained.indexOf(slide);
    const next = retained.slice(originalIndex + 1).find((candidate) => (
      result.some((existing) => key(existing) === key(candidate))
    ));
    const previous = retained.slice(0, originalIndex).reverse().find((candidate) => (
      result.some((existing) => key(existing) === key(candidate))
    ));
    const insertion = next
      ? result.findIndex((existing) => key(existing) === key(next))
      : previous
        ? result.findIndex((existing) => key(existing) === key(previous)) + 1
        : result.length;
    result.splice(insertion, 0, slide);
  }
  return result;
}
