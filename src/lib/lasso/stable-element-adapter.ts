import {
  computeBoundTextPosition,
  doBoundsIntersect,
  getBoundTextElement,
  getElementBounds,
  getElementLineSegments,
  intersectElementWithLineSegment,
} from "@excalidraw/element";
import type {
  ElementsMap as SnapshotElementsMap,
  ExcalidrawElement as SnapshotElement,
} from "@excalidraw/element/types";
import {
  lineSegment,
  polygonFromPoints,
  polygonIncludesPointNonZero,
} from "@excalidraw/math";
import type {
  ElementsSegmentsMap,
  GlobalPoint,
} from "@excalidraw/math/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { simplify } from "points-on-curve";

export type LassoPoint = readonly [number, number];
type Bounds = [number, number, number, number];

export interface LassoGeometrySnapshot {
  getSelectedElementIds(path: readonly LassoPoint[], simplifyDistance?: number): string[];
}

export function simplifyLassoPath(
  path: readonly LassoPoint[],
  distance: number,
): LassoPoint[] {
  return simplify(path, distance);
}

function asGlobalPoints(points: readonly LassoPoint[]): GlobalPoint[] {
  return points as unknown as GlobalPoint[];
}

function enclosureTest(
  lassoPath: GlobalPoint[],
  element: SnapshotElement,
  elementsSegments: ElementsSegmentsMap,
): boolean {
  const lassoPolygon = polygonFromPoints(lassoPath);
  const segments = elementsSegments.get(element.id);
  return Boolean(segments?.some((segment) =>
    segment.some((point) => polygonIncludesPointNonZero(point, lassoPolygon))));
}

function intersectionTest(
  lassoPath: GlobalPoint[],
  element: SnapshotElement,
  elementsMap: SnapshotElementsMap,
): boolean {
  const lassoSegments = lassoPath
    .slice(1)
    .map((point, index) => lineSegment(lassoPath[index], point))
    .concat([lineSegment(lassoPath[lassoPath.length - 1], lassoPath[0])]);
  const boundText = getBoundTextElement(element, elementsMap);

  return lassoSegments.some((segment) =>
    intersectElementWithLineSegment(element, elementsMap, segment, 0, true).length > 0
    || Boolean(boundText && intersectElementWithLineSegment(
      { ...boundText, ...computeBoundTextPosition(element, boundText, elementsMap) },
      elementsMap,
      segment,
      0,
      true,
    ).length > 0));
}

/**
 * Adapter around Excalidraw's commit-matched geometry packages. The hit-testing
 * sequence is adapted from packages/excalidraw/lasso/utils.ts (MIT), while the
 * live editor remains on the stable @excalidraw/excalidraw component.
 */
export function createLassoGeometrySnapshot(
  stableElements: readonly ExcalidrawElement[],
): LassoGeometrySnapshot {
  const elements = stableElements as unknown as readonly SnapshotElement[];
  const elementsMap = new Map(elements.map((element) => [element.id, element])) as SnapshotElementsMap;
  const elementsSegments = new Map<string, ReturnType<typeof getElementLineSegments>>();
  for (const element of elements) {
    elementsSegments.set(element.id, getElementLineSegments(element, elementsMap));
  }

  return {
    getSelectedElementIds(inputPath, simplifyDistance) {
      if (inputPath.length < 2) return [];
      const originalPath = asGlobalPoints(inputPath);
      const path = simplifyDistance
        ? asGlobalPoints(simplifyLassoPath(inputPath, simplifyDistance))
        : originalPath;
      if (path.length < 2) return [];

      const lassoBounds = originalPath.reduce<Bounds>((bounds, point) => [
        Math.min(bounds[0], point[0]),
        Math.min(bounds[1], point[1]),
        Math.max(bounds[2], point[0]),
        Math.max(bounds[3], point[1]),
      ], [Infinity, Infinity, -Infinity, -Infinity]);

      const selected: string[] = [];
      for (const element of elements) {
        if (element.locked || element.isDeleted) continue;
        const elementBounds = getElementBounds(element, elementsMap);
        if (!doBoundsIntersect(lassoBounds, elementBounds)) continue;
        if (
          enclosureTest(path, element, elementsSegments as ElementsSegmentsMap)
          || intersectionTest(path, element, elementsMap)
        ) selected.push(element.id);
      }
      return selected;
    },
  };
}
