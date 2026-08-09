import { getCommonBounds } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { SerializedScene } from "../types";
import { isBlockedEmbeddedElementType } from "./embedded-content-policy";
import { isSlideFrame } from "./slides";

export interface SlideRenderData {
  frame: ExcalidrawFrameElement;
  elements: readonly NonDeletedExcalidrawElement[];
  files: BinaryFiles;
}

function sceneElements(scene: SerializedScene): readonly ExcalidrawElement[] {
  return scene.elements as unknown as readonly ExcalidrawElement[];
}

function sceneFiles(scene: SerializedScene): BinaryFiles {
  return scene.files as unknown as BinaryFiles;
}

function isSafeSlideElement(
  element: ExcalidrawElement,
): element is NonDeletedExcalidrawElement {
  return !element.isDeleted && !isBlockedEmbeddedElementType(element.type);
}

function rotatedBoxBounds(
  element: Pick<ExcalidrawElement, "angle" | "height" | "width" | "x" | "y">,
): readonly [number, number, number, number] {
  const left = Math.min(element.x, element.x + element.width);
  const top = Math.min(element.y, element.y + element.height);
  const right = Math.max(element.x, element.x + element.width);
  const bottom = Math.max(element.y, element.y + element.height);
  const angle = Number.isFinite(element.angle) ? element.angle : 0;
  if (!angle) return [left, top, right, bottom];
  const halfWidth = (right - left) / 2;
  const halfHeight = (bottom - top) / 2;
  const centerX = left + halfWidth;
  const centerY = top + halfHeight;
  const extentX = Math.abs(Math.cos(angle)) * halfWidth + Math.abs(Math.sin(angle)) * halfHeight;
  const extentY = Math.abs(Math.sin(angle)) * halfWidth + Math.abs(Math.cos(angle)) * halfHeight;
  return [centerX - extentX, centerY - extentY, centerX + extentX, centerY + extentY];
}

function spatialBounds(element: ExcalidrawElement): readonly [number, number, number, number] {
  try {
    const bounds = getCommonBounds(
      [element] as unknown as Parameters<typeof getCommonBounds>[0],
    );
    if (bounds.every(Number.isFinite)) return bounds;
  } catch {
    // Older classroom files may contain incomplete linear-element metadata.
    // Their stored box is still safe to use and remains rotation-aware.
  }
  return rotatedBoxBounds(element);
}

function overlapsBounds(
  element: ExcalidrawElement,
  bounds: readonly [number, number, number, number],
): boolean {
  if (![element.x, element.y, element.width, element.height, ...bounds]
    .every(Number.isFinite)) return false;
  const [elementLeft, elementTop, elementRight, elementBottom] = spatialBounds(element);
  const [frameLeft, frameTop, frameRight, frameBottom] = bounds;
  return elementRight >= frameLeft &&
    elementLeft <= frameRight &&
    elementBottom >= frameTop &&
    elementTop <= frameBottom;
}

/**
 * Resolves exactly what a frame slide renders without consulting or changing
 * the live editor. Source order is retained so Excalidraw's z-order remains
 * authoritative.
 */
export function getSlideRenderData(
  scene: SerializedScene,
  frameId: string,
): SlideRenderData | null {
  const elements = sceneElements(scene);
  const frame = elements.find(
    (element): element is ExcalidrawFrameElement =>
      element.id === frameId && isSlideFrame(element),
  );
  if (!frame) return null;
  const frameBounds = spatialBounds(frame);

  const ordinaryFrameIds = new Set(
    elements
      .filter((element): element is ExcalidrawFrameElement => (
        isSafeSlideElement(element)
        && element.type === "frame"
        && !isSlideFrame(element)
        && overlapsBounds(element, frameBounds)
      ))
      .map((element) => element.id),
  );
  const slideElements: NonDeletedExcalidrawElement[] = [];
  for (const element of elements) {
    if (!isSafeSlideElement(element)) continue;
    if (element.id === frame.id) {
      slideElements.push(element);
      continue;
    }
    if (element.type === "frame" && isSlideFrame(element)) continue;
    if (!overlapsBounds(element, frameBounds)) continue;
    // Excalidraw's exporter honors frameId. Attach independent overlapping
    // elements and ordinary frame outlines to this render-only slide copy, but
    // preserve real native-frame ownership when its frame is also rendered.
    const preserveOrdinaryFrameOwnership = !!element.frameId
      && ordinaryFrameIds.has(element.frameId);
    slideElements.push(preserveOrdinaryFrameOwnership
      ? element
      : { ...element, frameId: frame.id } as NonDeletedExcalidrawElement);
  }
  const availableFiles = sceneFiles(scene);
  const files: BinaryFiles = {};
  for (const element of slideElements) {
    if (element.type !== "image" || !element.fileId) continue;
    const file = availableFiles[element.fileId];
    if (file) files[element.fileId] = file;
  }

  return { frame, elements: slideElements, files };
}

function fileRevision(file: BinaryFileData): readonly unknown[] {
  return [
    file.id,
    file.version ?? null,
    file.created,
    file.mimeType,
    file.dataURL.length,
  ];
}

/**
 * Returns a stable thumbnail revision that ignores viewport/app-state changes,
 * unrelated board elements, and unrelated local files.
 */
export function slidePreviewRevision(
  scene: SerializedScene,
  frameId: string,
): string | null {
  const data = getSlideRenderData(scene, frameId);
  if (!data) return null;
  const elementRevisions = data.elements.map((element) => [
    element.id,
    element.version,
    element.versionNonce,
    element.index,
  ]);
  const fileRevisions = Object.values(data.files)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(fileRevision);
  return JSON.stringify([elementRevisions, fileRevisions]);
}
