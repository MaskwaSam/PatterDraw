import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { SerializedScene } from "../types";

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
  return !element.isDeleted &&
    element.type !== "embeddable" &&
    element.type !== "iframe" &&
    element.type !== "magicframe";
}

function overlapsFrame(
  element: ExcalidrawElement,
  frame: ExcalidrawFrameElement,
): boolean {
  if (![element.x, element.y, element.width, element.height, frame.x, frame.y, frame.width, frame.height]
    .every(Number.isFinite)) return false;
  const elementLeft = Math.min(element.x, element.x + element.width);
  const elementTop = Math.min(element.y, element.y + element.height);
  const elementRight = Math.max(element.x, element.x + element.width);
  const elementBottom = Math.max(element.y, element.y + element.height);
  const frameLeft = Math.min(frame.x, frame.x + frame.width);
  const frameTop = Math.min(frame.y, frame.y + frame.height);
  const frameRight = Math.max(frame.x, frame.x + frame.width);
  const frameBottom = Math.max(frame.y, frame.y + frame.height);
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
      !element.isDeleted && element.type === "frame" && element.id === frameId,
  );
  if (!frame) return null;

  const slideElements: NonDeletedExcalidrawElement[] = [];
  for (const element of elements) {
    if (!isSafeSlideElement(element)) continue;
    if (element.id === frame.id) {
      slideElements.push(element);
      continue;
    }
    if (element.type === "frame") continue;
    if (element.frameId === frame.id) {
      slideElements.push(element);
      continue;
    }
    if (overlapsFrame(element, frame)) {
      // Excalidraw's exporter honors frameId even when a different frame is not
      // part of this render. Normalize only the detached render copy so content
      // visibly enclosed by this slide cannot be discarded as another frame's child.
      slideElements.push({ ...element, frameId: frame.id } as NonDeletedExcalidrawElement);
    }
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
