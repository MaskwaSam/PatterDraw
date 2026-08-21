import type { SerializedScene } from "../../types";
import {
  getPdfPageDisplayGeometry,
  getPdfPageViewRotation,
} from "./page-rotation";

const PDF_BACKGROUND_ROLE = "pdf-background";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasCanonicalBackgroundGeometry(
  element: Record<string, unknown>,
  scene: SerializedScene,
  persisted: Record<string, unknown>,
  expectedFileId: string,
): boolean {
  const workspace = scene.pdfPage;
  if (!workspace) return true;
  const display = getPdfPageDisplayGeometry(workspace);
  const viewRotation = getPdfPageViewRotation(workspace);
  const isTransientDisplay = expectedFileId !== persisted.fileId;
  const expectedAngle = viewRotation === 0
    ? 0
    : viewRotation === 90
      ? Math.PI / 2
      : viewRotation === 180
        ? Math.PI
        : -Math.PI / 2;
  const customData = element.customData;
  return (
    element.type === "image"
    && element.x === (isTransientDisplay ? 0 : (display.width - workspace.width) / 2)
    && element.y === (isTransientDisplay ? 0 : (display.height - workspace.height) / 2)
    && element.width === (isTransientDisplay ? display.width : workspace.width)
    && element.height === (isTransientDisplay ? display.height : workspace.height)
    && element.angle === (isTransientDisplay ? 0 : expectedAngle)
    && element.locked === true
    && element.isDeleted === false
    && element.opacity === 100
    && element.frameId == null
    && element.boundElements == null
    && element.crop == null
    && element.link == null
    && element.status === "saved"
    && element.index === persisted.index
    && element.strokeColor === persisted.strokeColor
    && element.backgroundColor === persisted.backgroundColor
    && element.strokeWidth === persisted.strokeWidth
    && element.strokeStyle === persisted.strokeStyle
    && element.fillStyle === persisted.fillStyle
    && element.roughness === persisted.roughness
    && element.roundness === persisted.roundness
    && Array.isArray(element.groupIds)
    && element.groupIds.length === 0
    && Array.isArray(element.scale)
    && element.scale[0] === 1
    && element.scale[1] === 1
    && customData !== null
    && typeof customData === "object"
    && (customData as Record<string, unknown>).classroomRole === PDF_BACKGROUND_ROLE
    && (customData as Record<string, unknown>).pdfDocumentId === workspace.documentId
    && (customData as Record<string, unknown>).pdfPageIndex === workspace.pageIndex
    && Object.keys(customData as Record<string, unknown>).length === 3
  );
}

/**
 * Restores the wrapper-owned PDF image to the immutable source geometry plus
 * the page's current non-destructive view rotation. Persisted source rasters
 * stay source-oriented; display-only rasters are pre-rotated and therefore
 * use the live display bounds with angle zero.
 *
 * The original file id is taken from the last serialized scene so an editor
 * gesture cannot replace the page raster with another local image.
 */
export function canonicalizePdfBackground(
  scene: SerializedScene,
  liveElements: readonly Record<string, unknown>[],
  displayFileId?: string,
): readonly Record<string, unknown>[] {
  const workspace = scene.pdfPage;
  if (!workspace) return liveElements;

  const persisted = scene.elements.find((element) => element.id === workspace.backgroundElementId);
  if (!persisted || persisted.type !== "image" || typeof persisted.fileId !== "string") {
    return liveElements;
  }
  const expectedFileId = displayFileId || persisted.fileId;

  let live: Record<string, unknown> | undefined;
  let matchCount = 0;
  for (const element of liveElements) {
    if (element.id !== workspace.backgroundElementId) continue;
    matchCount += 1;
    if (!live) live = element;
  }
  if (
    matchCount === 1
    && liveElements[0] === live
    && live.fileId === expectedFileId
    && hasCanonicalBackgroundGeometry(live, scene, persisted, expectedFileId)
  ) {
    return liveElements;
  }

  const source = persisted;
  const display = getPdfPageDisplayGeometry(workspace);
  const viewRotation = getPdfPageViewRotation(workspace);
  const angle = viewRotation === 0
    ? 0
    : viewRotation === 90
      ? Math.PI / 2
      : viewRotation === 180
        ? Math.PI
      : -Math.PI / 2;
  const isTransientDisplay = expectedFileId !== persisted.fileId;
  const version = Math.max(
    isFiniteNumber(persisted.version) ? persisted.version : 0,
    live && isFiniteNumber(live.version) ? live.version : 0,
  ) + 1;
  const repaired: Record<string, unknown> = {
    ...source,
    id: workspace.backgroundElementId,
    type: "image",
    x: isTransientDisplay ? 0 : (display.width - workspace.width) / 2,
    y: isTransientDisplay ? 0 : (display.height - workspace.height) / 2,
    width: isTransientDisplay ? display.width : workspace.width,
    height: isTransientDisplay ? display.height : workspace.height,
    angle: isTransientDisplay ? 0 : angle,
    locked: true,
    isDeleted: false,
    opacity: 100,
    frameId: null,
    boundElements: null,
    groupIds: [],
    scale: [1, 1],
    crop: null,
    link: null,
    fileId: expectedFileId,
    status: "saved",
    version,
    updated: Math.max(
      isFiniteNumber(persisted.updated) ? persisted.updated : 0,
      live && isFiniteNumber(live.updated) ? live.updated : 0,
    ),
    customData: {
      classroomRole: PDF_BACKGROUND_ROLE,
      pdfDocumentId: workspace.documentId,
      pdfPageIndex: workspace.pageIndex,
    },
  };

  const result: Record<string, unknown>[] = [repaired];
  for (const element of liveElements) {
    if (element.id !== workspace.backgroundElementId) result.push(element);
  }
  return result;
}
