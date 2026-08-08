import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement as StableExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  CaptureUpdateAction,
  isFrameLikeElement,
  isPointInElement,
  newElementWith,
  newLinearElement,
} from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import { pointFrom } from "@excalidraw/math";
import type { GlobalPoint, LocalPoint } from "@excalidraw/math";
import {
  computeBucketFillPolygon,
  isBucketGeometryElement,
  isBucketFillCompatible,
  isRestylableFill,
  type BucketFillFailureReason,
  type BucketFillGeometryResult,
} from "./geometry";
import {
  effectiveBucketFillColor,
  effectiveBucketFillOpacity,
  effectiveBucketFillStyle,
} from "./settings";

export type BucketFillResult =
  | { status: "filled" | "restyled" | "unchanged" }
  | { status: "failed"; reason: BucketFillFailureReason };

const BUCKET_FILL_METADATA_KEY = "classroomBucketFill";
type SuccessfulBucketFillGeometry = Extract<BucketFillGeometryResult, { ok: true }>;
type BucketFillMetadata = {
  version: 1;
  ownerId: string | null;
  boundaryElementIds: string[];
};

function metadataForRegion(result: SuccessfulBucketFillGeometry): BucketFillMetadata {
  return {
    version: 1,
    ownerId: result.ownerId,
    boundaryElementIds: [...new Set(result.boundaryElementIds)].sort(),
  };
}

function fillBelongsToRegion(
  element: ExcalidrawElement,
  result: SuccessfulBucketFillGeometry,
): boolean {
  const value = element.customData?.[BUCKET_FILL_METADATA_KEY] as Record<string, unknown> | undefined;
  if (
    !value
    || value.version !== 1
    || !(value.ownerId === null || typeof value.ownerId === "string")
    || !Array.isArray(value.boundaryElementIds)
    || !value.boundaryElementIds.every((id) => typeof id === "string")
  ) {
    return false;
  }
  const expected = metadataForRegion(result);
  const actualBoundaryIds = [...new Set(value.boundaryElementIds)].sort();
  return value.ownerId === expected.ownerId
    && actualBoundaryIds.length === expected.boundaryElementIds.length
    && actualBoundaryIds.every((id, index) => id === expected.boundaryElementIds[index]);
}

function elementAtPoint(
  point: GlobalPoint,
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): NonDeletedExcalidrawElement | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element.opacity <= 0) continue;
    if (isPointInElement(point, element, elementsMap)) return element;
  }
  return null;
}

function restyleFill(
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
  element: NonDeletedExcalidrawElement,
): BucketFillResult {
  const appState = api.getAppState();
  const backgroundColor = effectiveBucketFillColor(appState.currentItemBackgroundColor);
  const fillStyle = effectiveBucketFillStyle(appState.currentItemFillStyle);
  const opacity = effectiveBucketFillOpacity(appState.currentItemOpacity);
  if (
    element.backgroundColor === backgroundColor
    && element.fillStyle === fillStyle
    && element.opacity === opacity
  ) {
    return { status: "unchanged" };
  }
  const updated = newElementWith(element, {
    backgroundColor,
    fillStyle,
    opacity,
  });
  api.updateScene({
    elements: elements.map(
      (candidate) => candidate.id === element.id ? updated : candidate,
    ) as unknown as readonly StableExcalidrawElement[],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return { status: "restyled" };
}

function commonBoundaryGroups(
  ids: readonly string[],
  elementsMap: ElementsMap,
): readonly string[] {
  let common: readonly string[] | null = null;
  for (const id of ids) {
    const groupIds = elementsMap.get(id)?.groupIds;
    if (!Array.isArray(groupIds) || !groupIds.every((groupId) => typeof groupId === "string")) continue;
    common = common === null
      ? groupIds
      : common.filter((groupId) => groupIds.includes(groupId));
  }
  return common || [];
}

function frameAtPoint(
  point: GlobalPoint,
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): string | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (isFrameLikeElement(element) && isPointInElement(point, element, elementsMap)) {
      return element.id;
    }
  }
  return null;
}

function pointSize(points: readonly GlobalPoint[]): { width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * Applies the upstream bucket-fill geometry to the live stable Excalidraw scene.
 * The heavy geometry module is loaded only after the wrapper tool is used.
 */
export function applyBucketFill(
  api: ExcalidrawImperativeAPI,
  scenePoint: { x: number; y: number },
): BucketFillResult {
  const elements = (api.getSceneElements() as unknown as readonly ExcalidrawElement[])
    .filter(isBucketGeometryElement);
  // updateScene() replaces the complete scene. Keep deleted tombstones in
  // that replacement so bucket fill cannot silently erase undo/history data.
  const allElements = api.getSceneElementsIncludingDeleted() as unknown as readonly ExcalidrawElement[];
  const elementsMap = new Map(elements.map((element) => [element.id, element])) as ElementsMap;
  const point = pointFrom<GlobalPoint>(scenePoint.x, scenePoint.y);
  const hitElement = elementAtPoint(point, elements, elementsMap);
  const result = computeBucketFillPolygon({ point, elements, elementsMap });

  if (!result.ok) {
    if (hitElement && isBucketFillCompatible(hitElement)) {
      return restyleFill(api, allElements, hitElement);
    }
    return { status: "failed", reason: result.reason };
  }

  // The region owner is normally above its generated fill, so a coarse
  // topmost hit-test finds the owner first. Generated metadata ties the fill
  // to that owner/boundary set; matching geometry alone is ambiguous when a
  // same-bounds shape has since been drawn on top. A directly clicked legacy
  // fill remains restylable, while an untagged fill underneath an owner is
  // safely replaced once instead of risking a recolour of the wrong region.
  const existingFill = [...elements].reverse().find((candidate) =>
    isRestylableFill({
      hitElement: candidate,
      scenePoints: result.scenePoints,
      elementsMap,
    }) && (
      candidate.id === hitElement?.id
      || fillBelongsToRegion(candidate, result)
    ));
  if (existingFill) {
    return restyleFill(api, allElements, existingFill);
  }

  const appState = api.getAppState();
  const { width, height } = pointSize(result.scenePoints);
  const [originX, originY] = result.scenePoints[0];
  const points = result.scenePoints.map(([x, y]) =>
    pointFrom<LocalPoint>(x - originX, y - originY));
  const owner = result.ownerId ? elementsMap.get(result.ownerId) : null;
  const frameId = owner
    ? isFrameLikeElement(owner) ? owner.id : typeof owner.frameId === "string" ? owner.frameId : null
    : frameAtPoint(point, elements, elementsMap);
  const ownerGroupIds = owner?.groupIds;
  const groupIds = Array.isArray(ownerGroupIds)
    && ownerGroupIds.every((groupId) => typeof groupId === "string")
    ? ownerGroupIds
    : commonBoundaryGroups(result.boundaryElementIds, elementsMap);
  const fill = newLinearElement({
    type: "line",
    x: originX,
    y: originY,
    width,
    height,
    points,
    polygon: true,
    strokeColor: "transparent",
    backgroundColor: effectiveBucketFillColor(appState.currentItemBackgroundColor),
    fillStyle: effectiveBucketFillStyle(appState.currentItemFillStyle),
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    opacity: effectiveBucketFillOpacity(appState.currentItemOpacity),
    frameId,
    groupIds,
    customData: {
      [BUCKET_FILL_METADATA_KEY]: metadataForRegion(result),
    },
  });

  const nextElements: ExcalidrawElement[] = [...allElements];
  const anchorIndex = nextElements.findIndex((element) => element.id === result.insertion.elementId);
  const insertionIndex = anchorIndex < 0
    ? nextElements.length
    : result.insertion.placement === "above" ? anchorIndex + 1 : anchorIndex;
  nextElements.splice(insertionIndex, 0, fill);
  api.updateScene({
    elements: nextElements as unknown as readonly StableExcalidrawElement[],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return { status: "filled" };
}
