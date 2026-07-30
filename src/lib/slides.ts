import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/excalidraw/element/types";
import type { ClassroomSlide, SceneId } from "../types";
import { createLocalId } from "./id";

export const CLASSROOM_SLIDE_CUSTOM_DATA_KEY = "classroomSlide";
export const CLASSROOM_SLIDE_METADATA_VERSION = 1 as const;

export interface ClassroomSlideMetadata {
  kind: "slide";
  version: typeof CLASSROOM_SLIDE_METADATA_VERSION;
}

export const CLASSROOM_SLIDE_METADATA: ClassroomSlideMetadata = Object.freeze({
  kind: "slide",
  version: CLASSROOM_SLIDE_METADATA_VERSION,
});

const AUTOMATIC_SLIDE_TITLE = /^Slide [1-9]\d*$/;

function updateElement<T extends ExcalidrawElement>(
  element: T,
  updates: Partial<T>,
): T {
  return {
    ...element,
    ...updates,
    version: element.version + 1,
    updated: Date.now(),
  } as T;
}

export function sanitizeClassroomSlideMetadata(value: unknown): ClassroomSlideMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  return metadata.kind === "slide" && metadata.version === CLASSROOM_SLIDE_METADATA_VERSION
    ? { ...CLASSROOM_SLIDE_METADATA }
    : null;
}

export function isAutomaticSlideTitle(value: string): boolean {
  return AUTOMATIC_SLIDE_TITLE.test(value.trim());
}

export function reconcileSlideTitleModes(
  slides: readonly ClassroomSlide[],
): ClassroomSlide[] {
  return slides.map((slide, index) => {
    if (slide.titleMode === "automatic" || slide.titleMode === "custom") return slide;
    const titleMode = slide.title.trim() === `Slide ${index + 1}` ? "automatic" : "custom";
    return { ...slide, titleMode };
  });
}

export function isFrame(element: ExcalidrawElement): element is ExcalidrawFrameElement {
  return !element.isDeleted && element.type === "frame";
}

export function isSlideFrame(element: ExcalidrawElement): element is ExcalidrawFrameElement {
  return isFrame(element)
    && !!sanitizeClassroomSlideMetadata(element.customData?.[CLASSROOM_SLIDE_CUSTOM_DATA_KEY]);
}

export function slideFrameCustomData(
  customData: ExcalidrawElement["customData"] | undefined,
): Record<string, unknown> {
  return {
    ...(customData || {}),
    [CLASSROOM_SLIDE_CUSTOM_DATA_KEY]: { ...CLASSROOM_SLIDE_METADATA },
  };
}

export function renumberAutomaticSlides(slides: readonly ClassroomSlide[]): ClassroomSlide[] {
  return slides.map((slide, index) => {
    if (slide.titleMode !== "automatic") return slide;
    const title = `Slide ${index + 1}`;
    return title === slide.title ? slide : { ...slide, title };
  });
}

export function reconcileSlides(
  sceneId: SceneId,
  elements: readonly ExcalidrawElement[],
  current: readonly ClassroomSlide[],
): ClassroomSlide[] {
  const normalizedCurrent = reconcileSlideTitleModes(current);
  const frames = elements.filter(isSlideFrame);
  const framesById = new Map(frames.map((frame) => [frame.id, frame]));
  const retained = normalizedCurrent
    .filter((slide) => slide.sceneId !== sceneId || framesById.has(slide.frameId))
    .map((slide) => {
      if (slide.sceneId !== sceneId) return slide;
      const frameName = framesById.get(slide.frameId)?.name?.trim();
      return frameName && frameName !== slide.title
        ? { ...slide, title: frameName, titleMode: "custom" as const }
        : slide;
    });
  const known = new Set(retained.map((slide) => `${slide.sceneId}:${slide.frameId}`));
  const newFrames = frames
    .filter((frame) => !known.has(`${sceneId}:${frame.id}`))
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((frame, index) => {
      const automaticTitle = `Slide ${retained.length + index + 1}`;
      const frameTitle = frame.name?.trim();
      return {
        id: createLocalId(),
        sceneId,
        frameId: frame.id,
        title: frameTitle || automaticTitle,
        titleMode: !frameTitle || frameTitle === automaticTitle ? "automatic" as const : "custom" as const,
      };
    });
  return renumberAutomaticSlides([...retained, ...newFrames]);
}

export function moveSlide(
  slides: readonly ClassroomSlide[],
  slideId: string,
  targetId: string,
): ClassroomSlide[] {
  const normalized = reconcileSlideTitleModes(slides);
  const from = normalized.findIndex((slide) => slide.id === slideId);
  const to = normalized.findIndex((slide) => slide.id === targetId);
  if (from < 0 || to < 0 || from === to) return normalized;
  const next = [...normalized];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumberAutomaticSlides(next);
}

export function removeSlide(
  slides: readonly ClassroomSlide[],
  slideId: string,
): ClassroomSlide[] {
  return renumberAutomaticSlides(
    reconcileSlideTitleModes(slides).filter((slide) => slide.id !== slideId),
  );
}

/**
 * Synchronizes frame labels with authoritative slide metadata. Only tagged
 * frames are changed; native Excalidraw frames are left completely alone.
 */
export function syncSlideFrameNames(
  elements: readonly ExcalidrawElement[],
  slides: readonly ClassroomSlide[],
): readonly ExcalidrawElement[] {
  const titles = new Map(slides.map((slide) => [slide.frameId, slide.title]));
  let changed = false;
  const next = elements.map((element) => {
    if (!isSlideFrame(element)) return element;
    const title = titles.get(element.id);
    if (!title || element.name === title) return element;
    changed = true;
    return updateElement(element, { name: title } as Partial<typeof element>);
  });
  return changed ? next : elements;
}

/** Detaches only objects owned by tagged slide frames. */
export function detachElementsFromSlideFrames(
  elements: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] {
  const slideFrameIds = new Set<string>();
  for (const element of elements) {
    if (isSlideFrame(element)) slideFrameIds.add(element.id);
  }
  if (!slideFrameIds.size) return elements;
  let changed = false;
  const next = elements.map((element) => {
    if (!element.frameId || !slideFrameIds.has(element.frameId)) return element;
    changed = true;
    return updateElement(element, { frameId: null } as Partial<typeof element>);
  });
  return changed ? next : elements;
}

/**
 * Removes one rail slide boundary. Content survives, including content that
 * Excalidraw temporarily attached to the slide, and group IDs shared with the
 * deleted boundary are removed from every remaining member.
 */
export function deleteSlideBoundary(
  elements: readonly ExcalidrawElement[],
  frameId: string,
): readonly ExcalidrawElement[] {
  const frame = elements.find((element) => element.id === frameId && isSlideFrame(element));
  if (!frame) return elements;
  const obsoleteGroupIds = new Set(frame.groupIds);
  return elements
    .filter((element) => element.id !== frameId)
    .map((element) => {
      const frameIdUpdate = element.frameId === frameId;
      const groupIds = obsoleteGroupIds.size
        ? element.groupIds.filter((groupId) => !obsoleteGroupIds.has(groupId))
        : element.groupIds;
      if (!frameIdUpdate && groupIds.length === element.groupIds.length) return element;
      return updateElement(element, {
        ...(frameIdUpdate ? { frameId: null } : {}),
        ...(groupIds.length !== element.groupIds.length ? { groupIds } : {}),
      } as Partial<typeof element>);
    });
}

export function focusSlide(
  api: ExcalidrawImperativeAPI,
  frameId: string,
  animate = true,
  duration = animate ? 300 : 0,
): boolean {
  const frame = api.getSceneElements().find(
    (element) => element.id === frameId && isSlideFrame(element),
  );
  if (!frame) return false;
  api.scrollToContent(frame, {
    fitToViewport: true,
    viewportZoomFactor: 0.92,
    animate,
    duration,
  });
  return true;
}
