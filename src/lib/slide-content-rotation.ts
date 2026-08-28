import { getCommonBounds } from "@excalidraw/element";
import { randomInteger } from "@excalidraw/common";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { SerializedScene } from "../types";
import { getSlideRenderData } from "./slide-render";

export const MAX_SLIDE_ROTATION_DEGREES = 360;

export type SlideContentRotationStatus = "rotated" | "no-op" | "no-content";

export interface SlideContentRotationResult {
  elements: readonly ExcalidrawElement[];
  rotatedElementCount: number;
  status: SlideContentRotationStatus;
}

const FULL_TURN_DEGREES = 360;
const DEGREES_TO_RADIANS = Math.PI / 180;

function renderedSlideData(
  elements: readonly ExcalidrawElement[],
  frameId: string,
) {
  const scene: SerializedScene = {
    id: "slide-content-rotation",
    name: "Slide content rotation",
    elements: elements as unknown as readonly Record<string, unknown>[],
    appState: {},
    files: {},
  };
  return getSlideRenderData(scene, frameId);
}

function assertValidDegrees(degrees: number): void {
  if (!Number.isFinite(degrees) || Math.abs(degrees) > MAX_SLIDE_ROTATION_DEGREES) {
    throw new Error(
      `Enter a slide rotation angle from -${MAX_SLIDE_ROTATION_DEGREES}° to ${MAX_SLIDE_ROTATION_DEGREES}°.`,
    );
  }
}

function normalizedRotationDegrees(degrees: number): number {
  const normalized = degrees % FULL_TURN_DEGREES;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function normalizedRadians(radians: number): number {
  const fullTurn = 2 * Math.PI;
  const normalized = radians % fullTurn;
  return normalized < 0 ? normalized + fullTurn : normalized;
}

function isFrameLikeElement(
  element: ExcalidrawElement | null | undefined,
): boolean {
  return element?.type === "frame" || element?.type === "magicframe";
}

function rotatePointAround(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radians: number,
): readonly [number, number] {
  const deltaX = x - centerX;
  const deltaY = y - centerY;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    centerX + deltaX * cosine - deltaY * sine,
    centerY + deltaX * sine + deltaY * cosine,
  ];
}

function rotateElement(
  element: NonDeletedExcalidrawElement,
  elementCenter: readonly [number, number],
  centerX: number,
  centerY: number,
  radians: number,
): ExcalidrawElement {
  const [elementCenterX, elementCenterY] = elementCenter;
  const [rotatedCenterX, rotatedCenterY] = rotatePointAround(
    elementCenterX,
    elementCenterY,
    centerX,
    centerY,
    radians,
  );
  const candidateVersionNonce = randomInteger();
  return {
    ...element,
    x: element.x + rotatedCenterX - elementCenterX,
    y: element.y + rotatedCenterY - elementCenterY,
    angle: normalizedRadians(
      (Number.isFinite(element.angle) ? element.angle : 0) + radians,
    ) as ExcalidrawElement["angle"],
    version: element.version + 1,
    versionNonce: candidateVersionNonce === element.versionNonce
      ? (candidateVersionNonce + 1) % (2 ** 31)
      : candidateVersionNonce,
    updated: Date.now(),
  } as ExcalidrawElement;
}

function elementRotationCenter(
  element: NonDeletedExcalidrawElement,
  elementsMap: ReadonlyMap<string, ExcalidrawElement>,
): readonly [number, number] {
  if (element.type !== "line" && element.type !== "arrow" && element.type !== "freedraw") {
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    if (Number.isFinite(centerX) && Number.isFinite(centerY)) return [centerX, centerY];
    throw new Error("This slide contains invalid element geometry and cannot be rotated.");
  }
  if (
    !Array.isArray(element.points)
    || element.points.length === 0
    || element.points.some((point) => (
      !Array.isArray(point)
      || point.length < 2
      || !Number.isFinite(point[0])
      || !Number.isFinite(point[1])
    ))
  ) {
    throw new Error(
      "This slide contains malformed line or freehand geometry and cannot be rotated safely.",
    );
  }
  try {
    // This read-only bounds helper is already used by slide rendering. Avoid
    // the separately versioned package's Scene/transform mutation APIs: their
    // binding schema is not the live editor's schema.
    const unrotated = { ...element, angle: 0 } as NonDeletedExcalidrawElement;
    const unrotatedMap = new Map(elementsMap);
    unrotatedMap.set(element.id, unrotated);
    const bounds = getCommonBounds(
      [unrotated] as unknown as Parameters<typeof getCommonBounds>[0],
      unrotatedMap as unknown as Exclude<Parameters<typeof getCommonBounds>[1], undefined>,
    );
    if (bounds.every(Number.isFinite)) {
      return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    }
  } catch {
    // Fall through to the explicit error; persisting a guessed pivot could
    // visibly displace an older asymmetric line or freehand stroke.
  }
  throw new Error(
    "This slide contains line or freehand geometry that cannot be rotated safely.",
  );
}

function includeImplicitBoundText(
  elementsMap: ReadonlyMap<string, ExcalidrawElement>,
  rotatableIds: Set<string>,
): void {
  for (const id of [...rotatableIds]) {
    const container = elementsMap.get(id);
    for (const binding of container?.boundElements || []) {
      if (binding.type !== "text") continue;
      const text = elementsMap.get(binding.id);
      if (
        text
        && !text.isDeleted
        && text.type === "text"
        && text.containerId === container?.id
      ) {
        rotatableIds.add(text.id);
      }
    }
  }
}

function assertSafeRelationshipClosure(
  elements: readonly ExcalidrawElement[],
  elementsMap: ReadonlyMap<string, ExcalidrawElement>,
  rotatableIds: ReadonlySet<string>,
  slideFrameId: string,
): void {
  const selectedGroupIds = new Set<string>();
  for (const id of rotatableIds) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) continue;
    if (element.type === "arrow" && "elbowed" in element && element.elbowed) {
      throw new Error(
        "This slide contains an elbow arrow, which cannot yet be rotated safely. Convert or remove the elbow arrow and try again.",
      );
    }
    if (element.frameId && element.frameId !== slideFrameId) {
      const owner = elementsMap.get(element.frameId);
      if (owner && !owner.isDeleted && isFrameLikeElement(owner)) {
        throw new Error(
          "This slide contains content owned by a nested frame. Remove it from the nested frame before rotating the slide.",
        );
      }
    }
    for (const groupId of element.groupIds) selectedGroupIds.add(groupId);
  }

  for (const element of elements) {
    if (element.isDeleted) continue;
    const selected = rotatableIds.has(element.id);
    if (
      !selected
      && element.groupIds.some((groupId) => selectedGroupIds.has(groupId))
    ) {
      throw new Error(
        "This slide shares a group with content outside the slide. Ungroup or move the complete group onto the slide before rotating it.",
      );
    }
    if (element.type === "text" && element.containerId) {
      const containerSelected = rotatableIds.has(element.containerId);
      if (selected !== containerSelected) {
        throw new Error(
          "This slide has bound text connected across its boundary. Move the complete labelled shape onto the slide before rotating it.",
        );
      }
    }
    if (element.type !== "arrow") continue;
    for (const binding of [element.startBinding, element.endBinding]) {
      if (!binding) continue;
      const target = elementsMap.get(binding.elementId);
      if (!target || target.isDeleted) continue;
      if (selected !== rotatableIds.has(target.id)) {
        throw new Error(
          "This slide has an arrow connected to content outside the slide. Move or disconnect the complete arrow before rotating it.",
        );
      }
    }
  }
}

/**
 * Rotates the content rendered by one tagged slide around the fixed slide
 * centre. Positive degrees rotate clockwise in canvas coordinates. The slide
 * boundary and every other frame-like element remain axis-aligned and
 * unchanged.
 *
 * The supported input range is -360° through 360°. A zero/full-turn input
 * and an empty slide are explicit no-ops that retain the source array. Unsafe
 * relationship sets (elbow arrows, cross-boundary arrows/groups, and nested
 * frame ownership) are rejected before any output objects are created.
 */
export function rotateSlideContent(
  elements: readonly ExcalidrawElement[],
  frameId: string,
  degrees: number,
): SlideContentRotationResult {
  assertValidDegrees(degrees);

  const slideData = renderedSlideData(elements, frameId);
  if (!slideData) {
    throw new Error("That slide could not be found. Select an existing slide and try again.");
  }

  const frame = slideData.frame;
  if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) {
    throw new Error("This slide has invalid geometry and cannot be rotated.");
  }

  const rotationDegrees = normalizedRotationDegrees(degrees);
  if (rotationDegrees === 0) {
    return { elements, rotatedElementCount: 0, status: "no-op" };
  }

  const renderedIds = new Set(slideData.elements.map((element) => element.id));
  const rotatableIds = new Set(
    elements
      .filter((element): element is NonDeletedExcalidrawElement => (
        renderedIds.has(element.id)
        && !element.isDeleted
        && !isFrameLikeElement(element)
      ))
      .map((element) => element.id),
  );
  // Membership protection is based only on content actually rendered before
  // rotation. Bound text pulled in below as relationship closure must rotate
  // with its container, but should not independently veto the candidate when
  // it was not part of the original slide render selection.
  const originallyRenderedContentIds = new Set(rotatableIds);
  const elementsMap = new Map(elements.map((element) => [element.id, element]));
  includeImplicitBoundText(elementsMap, rotatableIds);
  if (!rotatableIds.size) {
    return { elements, rotatedElementCount: 0, status: "no-content" };
  }
  assertSafeRelationshipClosure(elements, elementsMap, rotatableIds, frameId);

  const centerX = Math.min(frame.x, frame.x + frame.width) + Math.abs(frame.width) / 2;
  const centerY = Math.min(frame.y, frame.y + frame.height) + Math.abs(frame.height) / 2;
  const rotationRadians = rotationDegrees * DEGREES_TO_RADIANS;
  const rotationCenters = new Map<string, readonly [number, number]>();
  for (const id of rotatableIds) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) continue;
    rotationCenters.set(id, elementRotationCenter(element, elementsMap));
  }
  const nextElements = elements.map((element) => (
    rotatableIds.has(element.id) && !element.isDeleted
      ? rotateElement(
        element,
        rotationCenters.get(element.id)!,
        centerX,
        centerY,
        rotationRadians,
      )
      : element
  ));
  const candidateSlideData = renderedSlideData(nextElements, frameId);
  const candidateRenderedIds = new Set(
    candidateSlideData?.elements
      .filter((element) => !isFrameLikeElement(element))
      .map((element) => element.id)
    || [],
  );
  const departedIds = Array.from(originallyRenderedContentIds)
    .filter((id) => !candidateRenderedIds.has(id));
  const departedCount = departedIds.length;
  if (departedCount > 0) {
    const noun = departedCount === 1 ? "object" : "objects";
    throw new Error(
      `This rotation would move ${departedCount} slide ${noun} completely outside the slide, so it was not applied. Move the ${noun} inward or use a smaller angle and try again.`,
    );
  }
  return {
    elements: nextElements,
    rotatedElementCount: rotatableIds.size,
    status: "rotated",
  };
}
