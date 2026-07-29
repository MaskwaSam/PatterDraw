import type { SerializedScene } from "../../types";

const PDF_BACKGROUND_ROLE = "pdf-background";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasCanonicalBackgroundGeometry(
  element: Record<string, unknown>,
  scene: SerializedScene,
  persisted: Record<string, unknown>,
): boolean {
  const workspace = scene.pdfPage;
  if (!workspace) return true;
  const customData = element.customData;
  return (
    element.type === "image"
    && element.x === 0
    && element.y === 0
    && element.width === workspace.width
    && element.height === workspace.height
    && element.angle === 0
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
 * Restores the wrapper-owned PDF image to the immutable page geometry.
 *
 * The original file id is taken from the last serialized scene so an editor
 * gesture cannot replace the page raster with another local image.
 */
export function canonicalizePdfBackground(
  scene: SerializedScene,
  liveElements: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const workspace = scene.pdfPage;
  if (!workspace) return liveElements;

  const persisted = scene.elements.find((element) => element.id === workspace.backgroundElementId);
  if (!persisted || persisted.type !== "image" || typeof persisted.fileId !== "string") {
    return liveElements;
  }

  const matches = liveElements.filter((element) => element.id === workspace.backgroundElementId);
  const live = matches[0];
  if (
    matches.length === 1
    && liveElements[0] === live
    && live.fileId === persisted.fileId
    && hasCanonicalBackgroundGeometry(live, scene, persisted)
  ) {
    return liveElements;
  }

  const source = persisted;
  const version = Math.max(
    isFiniteNumber(persisted.version) ? persisted.version : 0,
    live && isFiniteNumber(live.version) ? live.version : 0,
  ) + 1;
  const repaired: Record<string, unknown> = {
    ...source,
    id: workspace.backgroundElementId,
    type: "image",
    x: 0,
    y: 0,
    width: workspace.width,
    height: workspace.height,
    angle: 0,
    locked: true,
    isDeleted: false,
    opacity: 100,
    frameId: null,
    boundElements: null,
    groupIds: [],
    scale: [1, 1],
    crop: null,
    link: null,
    fileId: persisted.fileId,
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

  return [
    repaired,
    ...liveElements.filter((element) => element.id !== workspace.backgroundElementId),
  ];
}
