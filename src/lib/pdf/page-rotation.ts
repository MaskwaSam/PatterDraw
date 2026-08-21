import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
} from "@excalidraw/excalidraw/element/types";
import type { PdfPageWorkspace, SerializedScene } from "../../types";

/** The only rotations accepted for a PDF page view. */
export type PdfPageRotation = 0 | 90 | 180 | 270;

export type PdfPageRotationDirection = "clockwise" | "counterclockwise";

export interface PdfPageDisplayGeometry {
  width: number;
  height: number;
}

const PDF_PAGE_ROTATIONS: readonly PdfPageRotation[] = [0, 90, 180, 270];

function isPdfPageRotation(value: unknown): value is PdfPageRotation {
  return PDF_PAGE_ROTATIONS.includes(value as PdfPageRotation);
}

/**
 * Normalizes a persisted view rotation. `undefined` is deliberately accepted
 * for v1 projects written before view rotation existed; malformed values are
 * rejected at project-safety boundaries instead of being silently interpreted
 * as a different page orientation.
 */
export function normalizePdfPageViewRotation(value: unknown): PdfPageRotation {
  if (value === undefined) return 0;
  if (isPdfPageRotation(value)) return value;
  throw new Error("A PDF page has an invalid view rotation.");
}

export function getPdfPageViewRotation(
  workspace: Pick<PdfPageWorkspace, "viewRotation">,
): PdfPageRotation {
  return normalizePdfPageViewRotation(workspace.viewRotation);
}

export function normalizePdfPageRotation(value: number): PdfPageRotation {
  const normalized = ((value % 360) + 360) % 360;
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  throw new Error("The PDF page rotation is invalid.");
}

/** Source rotation plus wrapper-owned view rotation. */
export function getPdfPageEffectiveRotation(
  workspace: Pick<PdfPageWorkspace, "rotation" | "viewRotation">,
): PdfPageRotation {
  return normalizePdfPageRotation(workspace.rotation + getPdfPageViewRotation(workspace));
}

/** Dimensions of the page as presented on the live editor canvas. */
export function getPdfPageDisplayGeometry(
  workspace: Pick<PdfPageWorkspace, "width" | "height" | "viewRotation">,
): PdfPageDisplayGeometry {
  const viewRotation = getPdfPageViewRotation(workspace);
  return viewRotation === 90 || viewRotation === 270
    ? { width: workspace.height, height: workspace.width }
    : { width: workspace.width, height: workspace.height };
}

/**
 * Returns the unrotated source-page dimensions from the persisted display
 * geometry. PDF.js/import-pdf persist width/height after applying source
 * rotation, so this is needed when drawing an embedded source page with the
 * source+view rotation in the exporter.
 */
export function getPdfPageSourceGeometry(
  workspace: Pick<PdfPageWorkspace, "width" | "height" | "rotation">,
): PdfPageDisplayGeometry {
  return workspace.rotation === 90 || workspace.rotation === 270
    ? { width: workspace.height, height: workspace.width }
    : { width: workspace.width, height: workspace.height };
}

export function addPdfPageRotation(
  current: PdfPageRotation,
  delta: PdfPageRotation,
): PdfPageRotation {
  return normalizePdfPageRotation(current + delta);
}

export function nextPdfPageViewRotation(
  current: PdfPageRotation,
  direction: PdfPageRotationDirection,
): PdfPageRotation {
  return addPdfPageRotation(current, direction === "clockwise" ? 90 : 270);
}

function rotationRadians(rotation: PdfPageRotation): number {
  switch (rotation) {
    case 90: return Math.PI / 2;
    case 180: return Math.PI;
    case 270: return -Math.PI / 2;
    default: return 0;
  }
}

function normalizeElementAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let normalized = ((angle + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  // Snap the common quarter-turn values so a four-turn page action does not
  // leave a tiny floating residue in serialized scene JSON.
  for (const candidate of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    if (Math.abs(normalized - candidate) < 1e-12) return candidate === Math.PI ? -Math.PI : candidate;
  }
  if (Object.is(normalized, -0)) normalized = 0;
  return normalized;
}

function bumpElementRevision(record: Record<string, unknown>): void {
  if (typeof record.version === "number" && Number.isSafeInteger(record.version)) {
    record.version += 1;
  }
  if (typeof record.versionNonce === "number" && Number.isSafeInteger(record.versionNonce)) {
    record.versionNonce = record.versionNonce >= Number.MAX_SAFE_INTEGER
      ? 0
      : record.versionNonce + 1;
  }
}

function rotatePoint(
  point: readonly [number, number],
  center: readonly [number, number],
  angle: number,
): [number, number] {
  if (angle === 0) return [point[0], point[1]];
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point[0] - center[0];
  const y = point[1] - center[1];
  return [
    center[0] + x * cosine - y * sine,
    center[1] + x * sine + y * cosine,
  ];
}

/**
 * Maps a point in the current display coordinate system to the next one. The
 * explicit quarter-turn cases avoid accumulating trigonometric drift across
 * four successive UI rotations.
 */
export function rotatePdfPagePoint(
  point: readonly [number, number],
  currentDisplayWidth: number,
  currentDisplayHeight: number,
  rotation: PdfPageRotation,
): [number, number] {
  switch (rotation) {
    case 90: return [currentDisplayHeight - point[1], point[0]];
    case 180: return [currentDisplayWidth - point[0], currentDisplayHeight - point[1]];
    case 270: return [point[1], currentDisplayWidth - point[0]];
    default: return [point[0], point[1]];
  }
}

function isLinearElement(element: ExcalidrawElement): element is ExcalidrawLinearElement {
  return element.type === "line" || element.type === "arrow";
}

function isFreeDrawElement(element: ExcalidrawElement): boolean {
  return element.type === "freedraw";
}

function hasPoint(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === "number"
    && Number.isFinite(value[0])
    && typeof value[1] === "number"
    && Number.isFinite(value[1])
  );
}

function transformedLinearElement(
  element: ExcalidrawElement,
  currentDisplayWidth: number,
  currentDisplayHeight: number,
  rotation: PdfPageRotation,
): Record<string, unknown> {
  const record = element as unknown as Record<string, unknown>;
  const points = Array.isArray(record.points)
    ? record.points.filter(hasPoint)
    : [];
  if (!points.length) {
    return transformedRectangularElement(
      element,
      currentDisplayWidth,
      currentDisplayHeight,
      rotation,
    );
  }

  // Excalidraw linear/free-draw points are local to x/y and are then rotated
  // around the element's rendered bounds center. Resolve that exact geometry
  // before applying the page transform, then flatten the element to angle 0.
  // This keeps arrows, free-draw paths, fixed segments, and off-page writing
  // coherent instead of merely swapping width and height metadata.
  const localMinX = Math.min(...points.map((point) => point[0]));
  const localMinY = Math.min(...points.map((point) => point[1]));
  const localMaxX = Math.max(...points.map((point) => point[0]));
  const localMaxY = Math.max(...points.map((point) => point[1]));
  // Excalidraw rotates linear/free-draw geometry around the bounds of its
  // local points, not x + persisted width/2. Those differ for a line drawn
  // back toward a negative local coordinate and would otherwise displace it
  // during a page turn.
  const center: [number, number] = [
    element.x + (localMinX + localMaxX) / 2,
    element.y + (localMinY + localMaxY) / 2,
  ];
  const elementAngle = typeof record.angle === "number" && Number.isFinite(record.angle)
    ? record.angle
    : 0;
  const globalPoints = points.map((point) => {
    const global = rotatePoint(
      [element.x + point[0], element.y + point[1]],
      center,
      elementAngle,
    );
    return rotatePdfPagePoint(global, currentDisplayWidth, currentDisplayHeight, rotation);
  });
  // Anchor at the transformed path bounds rather than the first point. This
  // makes the persisted x/y + width/height center agree with the local points
  // even when a 90-degree turn introduces negative local coordinates, so four
  // turns are an exact semantic round trip.
  const globalMinX = Math.min(...globalPoints.map((point) => point[0]));
  const globalMinY = Math.min(...globalPoints.map((point) => point[1]));
  const globalMaxX = Math.max(...globalPoints.map((point) => point[0]));
  const globalMaxY = Math.max(...globalPoints.map((point) => point[1]));
  const origin: [number, number] = [globalMinX, globalMinY];
  const localPoints = globalPoints.map(([x, y]) => [x - origin[0], y - origin[1]] as [number, number]);
  const minX = 0;
  const minY = 0;
  const maxX = globalMaxX - globalMinX;
  const maxY = globalMaxY - globalMinY;
  const localizePoint = (value: unknown): unknown => {
    if (!hasPoint(value)) return value;
    const global = rotatePoint(
      [element.x + value[0], element.y + value[1]],
      center,
      elementAngle,
    );
    const transformed = rotatePdfPagePoint(
      global,
      currentDisplayWidth,
      currentDisplayHeight,
      rotation,
    );
    return [transformed[0] - origin[0], transformed[1] - origin[1]];
  };
  const next: Record<string, unknown> = {
    ...record,
    x: origin[0],
    y: origin[1],
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    angle: 0,
    points: localPoints,
  };
  if (record.lastCommittedPoint !== null && record.lastCommittedPoint !== undefined) {
    next.lastCommittedPoint = localizePoint(record.lastCommittedPoint);
  }
  if (Array.isArray(record.fixedSegments)) {
    next.fixedSegments = record.fixedSegments.map((segment) => {
      if (!segment || typeof segment !== "object") return segment;
      const fixed = segment as Record<string, unknown>;
      return {
        ...fixed,
        start: localizePoint(fixed.start),
        end: localizePoint(fixed.end),
      };
    });
  }
  bumpElementRevision(next);
  return next;
}

function transformedRectangularElement(
  element: ExcalidrawElement,
  currentDisplayWidth: number,
  currentDisplayHeight: number,
  rotation: PdfPageRotation,
): Record<string, unknown> {
  const record = element as unknown as Record<string, unknown>;
  const width = typeof record.width === "number" && Number.isFinite(record.width)
    ? record.width
    : 0;
  const height = typeof record.height === "number" && Number.isFinite(record.height)
    ? record.height
    : 0;
  const center = rotatePdfPagePoint(
    [element.x + width / 2, element.y + height / 2],
    currentDisplayWidth,
    currentDisplayHeight,
    rotation,
  );
  const angle = typeof record.angle === "number" && Number.isFinite(record.angle)
    ? record.angle
    : 0;
  const nextAngle = angle + rotationRadians(rotation);
  // The only angles emitted are a normalized quarter-turn plus the original
  // element angle. Keeping 0 and PI exact helps a four-turn round trip.
  const normalizedAngle = normalizeElementAngle(nextAngle);
  const next = {
    ...record,
    x: center[0] - width / 2,
    y: center[1] - height / 2,
    angle: Math.abs(normalizedAngle) < 1e-12 ? 0 : normalizedAngle,
  };
  bumpElementRevision(next);
  return next;
}

function transformedBackgroundElement(
  element: ExcalidrawElement,
  workspace: PdfPageWorkspace,
  nextViewRotation: PdfPageRotation,
): Record<string, unknown> {
  const record = element as unknown as Record<string, unknown>;
  const display = getPdfPageDisplayGeometry({
    width: workspace.width,
    height: workspace.height,
    viewRotation: nextViewRotation,
  });
  const angle = rotationRadians(nextViewRotation);
  const next = {
    ...record,
    id: workspace.backgroundElementId,
    type: "image",
    x: (display.width - workspace.width) / 2,
    y: (display.height - workspace.height) / 2,
    width: workspace.width,
    height: workspace.height,
    angle,
    locked: true,
    isDeleted: false,
    opacity: 100,
    frameId: null,
    boundElements: null,
    groupIds: [],
    scale: [1, 1],
    crop: null,
    link: null,
    status: "saved",
    customData: {
      classroomRole: "pdf-background",
      pdfDocumentId: workspace.documentId,
      pdfPageIndex: workspace.pageIndex,
    },
  };
  bumpElementRevision(next);
  return next;
}

/**
 * Applies one wrapper-level quarter turn to every scene element. The caller
 * can use this for either direction; it does not mutate source bytes/files or
 * regenerate element IDs. Deleted tombstones are transformed too so a later
 * undo/restore cannot resurrect marks in the wrong place.
 */
export function rotatePdfScene(
  scene: SerializedScene,
  direction: PdfPageRotationDirection | PdfPageRotation = "clockwise",
): SerializedScene {
  if (!scene.pdfPage) throw new Error("Scene is not a PDF page workspace.");
  const workspace = scene.pdfPage;
  const currentViewRotation = getPdfPageViewRotation(workspace);
  const rotation = typeof direction === "number"
    ? normalizePdfPageRotation(direction)
    : direction === "clockwise" ? 90 : 270;
  const nextViewRotation = addPdfPageRotation(currentViewRotation, rotation);
  const currentDisplay = getPdfPageDisplayGeometry({
    width: workspace.width,
    height: workspace.height,
    viewRotation: currentViewRotation,
  });
  const originalElements = scene.elements as unknown as ExcalidrawElement[];
  const nextElements = originalElements.map((element) => {
    if (element.id === workspace.backgroundElementId) {
      return transformedBackgroundElement(element, workspace, nextViewRotation);
    }
    if (isLinearElement(element) || isFreeDrawElement(element)) {
      return transformedLinearElement(
        element,
        currentDisplay.width,
        currentDisplay.height,
        rotation,
      );
    }
    return transformedRectangularElement(
      element,
      currentDisplay.width,
      currentDisplay.height,
      rotation,
    );
  });
  return {
    ...scene,
    elements: nextElements as unknown as readonly Record<string, unknown>[],
    pdfPage: {
      ...workspace,
      viewRotation: nextViewRotation,
    },
  };
}

/** Explicit alias used by UI/action code that wants to document the unit. */
export function rotatePdfSceneQuarterTurn(
  scene: SerializedScene,
  direction: PdfPageRotationDirection,
): SerializedScene {
  return rotatePdfScene(scene, direction);
}

export function isPdfPageRotationValue(value: unknown): value is PdfPageRotation {
  return isPdfPageRotation(value);
}
