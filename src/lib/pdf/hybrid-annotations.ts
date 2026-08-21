import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { getStroke } from "perfect-freehand";
import {
  degrees,
  LineCapStyle,
  rgb,
  type PDFPage,
} from "pdf-lib";

export type HybridAnnotationRunKind = "vector" | "raster";

export type HybridRasterReason =
  | "unsupported-type"
  | "frame-clipping"
  | "visual-style"
  | "invalid-geometry"
  | "vector-budget";

export interface HybridVectorInstruction {
  elementId: string;
  path: string;
  pathOperations: number;
  localCenterX: number;
  localCenterY: number;
  fill: ParsedPdfColor | null;
  stroke: ParsedPdfColor | null;
  strokeWidth: number;
  opacity: number;
  angle: number;
  x: number;
  y: number;
}

export interface HybridAnnotationRun {
  kind: HybridAnnotationRunKind;
  elements: readonly NonDeletedExcalidrawElement[];
  /** Present for vector runs and kept one-to-one with `elements`. */
  vectorInstructions?: readonly HybridVectorInstruction[];
  /** Why each element in a raster run was not emitted as a vector. */
  rasterReasons?: readonly HybridRasterReason[];
}

export interface HybridAnnotationPlan {
  runs: readonly HybridAnnotationRun[];
  vectorElementCount: number;
  vectorPathOperations: number;
  rasterElementCount: number;
  rasterizedTypes: readonly string[];
  rasterReasons: Readonly<Record<HybridRasterReason, number>>;
}

export interface HybridAnnotationPlanOptions {
  maxRuns: number;
  maxVectorElements: number;
  maxVectorPathOperations: number;
}

export class HybridAnnotationPlanError extends Error {
  constructor(
    message: string,
    public readonly code: "too-many-runs" | "dependent-elements-separated",
    public readonly runCount: number,
    public readonly maxRuns: number,
  ) {
    super(message);
    this.name = "HybridAnnotationPlanError";
  }
}

export interface HybridVectorPlacement {
  /** Scene-space x=0 mapped into target PDF coordinates. */
  originX: number;
  /** Scene-space y=0 measured down from the target page's top edge. */
  originFromTop: number;
  targetHeight: number;
  scale: number;
}

interface ParsedPdfColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

interface VectorClassification {
  instruction?: HybridVectorInstruction;
  reason?: HybridRasterReason;
}

const SVG_PATH_COMMAND = /[MmLlHhVvCcSsQqTtAaZz]/g;
const SVG_PATH_NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const SAFE_SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;
const FREE_DRAW_PATH_PRECISION = /(\s?[A-Z]?,?-?[0-9]*\.[0-9]{0,2})(([0-9]|e|-)*)/g;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseHexColor(value: unknown): ParsedPdfColor | null | undefined {
  if (value === "transparent") return null;
  if (typeof value !== "string" || !value.startsWith("#")) return undefined;
  const hex = value.slice(1);
  const expanded = hex.length === 3 || hex.length === 4
    ? Array.from(hex, (character) => `${character}${character}`).join("")
    : hex;
  if (
    (expanded.length !== 6 && expanded.length !== 8)
    || !/^[0-9a-f]+$/i.test(expanded)
  ) return undefined;
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16) / 255,
    green: Number.parseInt(expanded.slice(2, 4), 16) / 255,
    blue: Number.parseInt(expanded.slice(4, 6), 16) / 255,
    alpha: expanded.length === 8
      ? Number.parseInt(expanded.slice(6, 8), 16) / 255
      : 1,
  };
}

function validBaseGeometry(element: NonDeletedExcalidrawElement): boolean {
  return isFiniteNumber(element.x)
    && isFiniteNumber(element.y)
    && isFiniteNumber(element.width)
    && isFiniteNumber(element.height)
    && element.width >= 0
    && element.height >= 0
    && isFiniteNumber(element.angle)
    && isFiniteNumber(element.opacity)
    && element.opacity >= 0
    && element.opacity <= 100
    && isFiniteNumber(element.strokeWidth)
    && element.strokeWidth >= 0;
}

function finitePoints(
  element: Extract<ExcalidrawElement, { type: "line" | "arrow" | "freedraw" }>,
): boolean {
  return Array.isArray(element.points)
    && element.points.length > 0
    && element.points.every((point) => (
      Array.isArray(point)
      && point.length >= 2
      && isFiniteNumber(point[0])
      && isFiniteNumber(point[1])
    ));
}

function pointCenter(
  element: Extract<ExcalidrawElement, { type: "line" | "arrow" | "freedraw" }>,
): readonly [number, number] {
  let minX = element.points[0][0];
  let maxX = minX;
  let minY = element.points[0][1];
  let maxY = minY;
  for (let index = 1; index < element.points.length; index += 1) {
    const [x, y] = element.points[index];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function midpoint(
  first: readonly number[],
  second: readonly number[],
): readonly [number, number] {
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
}

function freeDrawSvgPath(
  element: Extract<ExcalidrawElement, { type: "freedraw" }>,
): string {
  const inputPoints = element.simulatePressure
    ? element.points.map(([x, y]) => [x, y])
    : element.points.length
      ? element.points.map(([x, y], index) => [x, y, element.pressures[index]])
      : [[0, 0, 0.5]];
  const stroke = getStroke(inputPoints, {
    simulatePressure: element.simulatePressure,
    size: element.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (value) => Math.sin(value * Math.PI / 2),
    last: !!element.lastCommittedPoint,
  });
  if (!stroke.length) return "";
  const lastIndex = stroke.length - 1;
  return stroke.reduce<Array<string | readonly number[]>>(
    (parts, point, index, points) => {
      if (index === lastIndex) {
        parts.push(point, midpoint(point, points[0]), "L", points[0], "Z");
      } else {
        parts.push(point, midpoint(point, points[index + 1]));
      }
      return parts;
    },
    ["M", stroke[0], "Q"],
  ).join(" ").replace(FREE_DRAW_PATH_PRECISION, "$1");
}

export function countSvgPathOperations(path: string): number {
  const commands = path.match(SVG_PATH_COMMAND)?.length ?? 0;
  const coordinatePairs = Math.ceil((path.match(SVG_PATH_NUMBER)?.length ?? 0) / 2);
  return Math.max(commands, coordinatePairs);
}

function instruction(
  element: NonDeletedExcalidrawElement,
  path: string,
  localCenter: readonly [number, number],
  fill: ParsedPdfColor | null,
  stroke: ParsedPdfColor | null,
): VectorClassification {
  if (!path || !SAFE_SVG_PATH.test(path)) return { reason: "invalid-geometry" };
  const pathOperations = countSvgPathOperations(path);
  if (!pathOperations) return { reason: "invalid-geometry" };
  return {
    instruction: {
      elementId: element.id,
      path,
      pathOperations,
      localCenterX: localCenter[0],
      localCenterY: localCenter[1],
      fill,
      stroke,
      strokeWidth: element.strokeWidth,
      opacity: element.opacity / 100,
      angle: element.angle,
      x: element.x,
      y: element.y,
    },
  };
}

/**
 * Return a vector instruction only for elements whose stored geometry maps
 * directly to PDF/SVG path semantics. Everything else is intentionally sent
 * through Excalidraw's visual raster renderer instead of being approximated.
 */
export function classifyHybridAnnotationElement(
  element: NonDeletedExcalidrawElement,
): VectorClassification {
  if (!validBaseGeometry(element)) return { reason: "invalid-geometry" };
  if (element.frameId) return { reason: "frame-clipping" };
  if (
    element.type !== "freedraw"
    && element.type !== "rectangle"
    && element.type !== "diamond"
    && element.type !== "ellipse"
    && element.type !== "line"
  ) {
    // Includes text, images, embeds, arrows, and future element types.
    // Rasterizing is deliberate: no unknown annotation is omitted from output.
    return { reason: "unsupported-type" };
  }
  if (element.boundElements?.some((bound) => bound.type === "text")) {
    // A bound label is positioned/rendered with its container. Keep both on
    // Excalidraw's renderer rather than vectorizing only the container.
    return { reason: "visual-style" };
  }

  const stroke = parseHexColor(element.strokeColor);
  const background = parseHexColor(element.backgroundColor);
  if (stroke === undefined || background === undefined) {
    return { reason: "visual-style" };
  }

  if (element.type === "freedraw") {
    if (!finitePoints(element) || background !== null) {
      return { reason: !finitePoints(element) ? "invalid-geometry" : "visual-style" };
    }
    const [centerX, centerY] = pointCenter(element);
    try {
      return instruction(
        element,
        freeDrawSvgPath(element),
        [centerX, centerY],
        stroke,
        null,
      );
    } catch {
      return { reason: "invalid-geometry" };
    }
  }

  // Rough, patterned, rounded, or non-solid shapes must retain Excalidraw's
  // own renderer. The zero-roughness subset below has a direct path mapping.
  if (
    element.roughness !== 0
    || element.strokeStyle !== "solid"
    || element.roundness !== null
    || element.fillStyle !== "solid"
  ) return { reason: "visual-style" };

  if (element.type === "rectangle") {
    const { width, height } = element;
    return instruction(
      element,
      `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`,
      [width / 2, height / 2],
      background,
      stroke,
    );
  }

  if (element.type === "diamond") {
    const { width, height } = element;
    return instruction(
      element,
      `M ${width / 2} 0 L ${width} ${height / 2} L ${width / 2} ${height} L 0 ${height / 2} Z`,
      [width / 2, height / 2],
      background,
      stroke,
    );
  }

  if (element.type === "ellipse") {
    // Four cubic Bézier segments use the same standard circle approximation
    // used by PDF/canvas renderers. Keeping this to roughness=0 avoids
    // approximating Excalidraw's hand-drawn double-stroke ellipse.
    const { width, height } = element;
    const radiusX = width / 2;
    const radiusY = height / 2;
    const controlX = radiusX * 0.5522847498307936;
    const controlY = radiusY * 0.5522847498307936;
    return instruction(
      element,
      [
        `M ${radiusX} 0`,
        `C ${radiusX + controlX} 0 ${width} ${radiusY - controlY} ${width} ${radiusY}`,
        `C ${width} ${radiusY + controlY} ${radiusX + controlX} ${height} ${radiusX} ${height}`,
        `C ${radiusX - controlX} ${height} 0 ${radiusY + controlY} 0 ${radiusY}`,
        `C 0 ${radiusY - controlY} ${radiusX - controlX} 0 ${radiusX} 0 Z`,
      ].join(" "),
      [radiusX, radiusY],
      background,
      stroke,
    );
  }

  if (element.type === "line") {
    if (
      !finitePoints(element)
      || element.points.length !== 2
      || element.startArrowhead !== null
      || element.endArrowhead !== null
      || background !== null
    ) return { reason: finitePoints(element) ? "visual-style" : "invalid-geometry" };
    const [start, end] = element.points;
    const [centerX, centerY] = pointCenter(element);
    return instruction(
      element,
      `M ${start[0]} ${start[1]} L ${end[0]} ${end[1]}`,
      [centerX, centerY],
      null,
      stroke,
    );
  }

  // The supported type union above makes this unreachable, but retain a
  // conservative raster classification if that union grows unexpectedly.
  return { reason: "unsupported-type" };
}

function emptyReasonCounts(): Record<HybridRasterReason, number> {
  return {
    "unsupported-type": 0,
    "frame-clipping": 0,
    "visual-style": 0,
    "invalid-geometry": 0,
    "vector-budget": 0,
  };
}

export function planHybridAnnotationRuns(
  elements: readonly NonDeletedExcalidrawElement[],
  options: Readonly<HybridAnnotationPlanOptions>,
): HybridAnnotationPlan {
  if (!Number.isSafeInteger(options.maxRuns) || options.maxRuns <= 0) {
    throw new Error("The hybrid annotation maxRuns limit is invalid.");
  }
  for (const [name, value] of Object.entries({
    maxVectorElements: options.maxVectorElements,
    maxVectorPathOperations: options.maxVectorPathOperations,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`The hybrid annotation ${name} limit is invalid.`);
    }
  }

  const runs: Array<{
    kind: HybridAnnotationRunKind;
    elements: NonDeletedExcalidrawElement[];
    vectorInstructions?: HybridVectorInstruction[];
    rasterReasons?: HybridRasterReason[];
  }> = [];
  const rasterizedTypes = new Set<string>();
  const rasterReasons = emptyReasonCounts();
  let vectorElementCount = 0;
  let vectorPathOperations = 0;
  let rasterElementCount = 0;

  const append = (
    kind: HybridAnnotationRunKind,
    element: NonDeletedExcalidrawElement,
    vectorInstruction?: HybridVectorInstruction,
    rasterReason?: HybridRasterReason,
  ) => {
    let run = runs.at(-1);
    if (!run || run.kind !== kind) {
      run = { kind, elements: [] };
      if (kind === "vector") run.vectorInstructions = [];
      else run.rasterReasons = [];
      runs.push(run);
    }
    run.elements.push(element);
    if (vectorInstruction) run.vectorInstructions!.push(vectorInstruction);
    if (rasterReason) run.rasterReasons!.push(rasterReason);
  };

  for (const element of elements) {
    const classification = classifyHybridAnnotationElement(element);
    const candidate = classification.instruction;
    const withinVectorBudget = !!candidate
      && vectorElementCount + 1 <= options.maxVectorElements
      && vectorPathOperations + candidate.pathOperations <= options.maxVectorPathOperations;
    if (candidate && withinVectorBudget) {
      vectorElementCount += 1;
      vectorPathOperations += candidate.pathOperations;
      append("vector", element, candidate);
    } else {
      const reason = candidate ? "vector-budget" : classification.reason ?? "unsupported-type";
      rasterElementCount += 1;
      rasterizedTypes.add(String(element.type));
      rasterReasons[reason] += 1;
      append("raster", element, undefined, reason);
    }
  }

  if (runs.length > options.maxRuns) {
    throw new HybridAnnotationPlanError(
      "The annotation stack has too many alternating vector and visual layers for safe hybrid export.",
      "too-many-runs",
      runs.length,
      options.maxRuns,
    );
  }

  const runByElementId = new Map<string, number>();
  runs.forEach((run, runIndex) => {
    run.elements.forEach((element) => runByElementId.set(element.id, runIndex));
  });
  for (const element of elements) {
    if (element.type !== "text" || !element.containerId) continue;
    const textRun = runByElementId.get(element.id);
    const containerRun = runByElementId.get(element.containerId);
    if (textRun === undefined || containerRun === undefined || textRun !== containerRun) {
      throw new HybridAnnotationPlanError(
        "A bound annotation label is separated from its container by another visual layer.",
        "dependent-elements-separated",
        runs.length,
        options.maxRuns,
      );
    }
  }

  return Object.freeze({
    runs: Object.freeze(runs.map((run) => Object.freeze({
      kind: run.kind,
      elements: Object.freeze(run.elements.slice()),
      ...(run.vectorInstructions
        ? { vectorInstructions: Object.freeze(run.vectorInstructions.slice()) }
        : {}),
      ...(run.rasterReasons
        ? { rasterReasons: Object.freeze(run.rasterReasons.slice()) }
        : {}),
    }))),
    vectorElementCount,
    vectorPathOperations,
    rasterElementCount,
    rasterizedTypes: Object.freeze(Array.from(rasterizedTypes).sort()),
    rasterReasons: Object.freeze({ ...rasterReasons }),
  });
}

function pdfColor(color: ParsedPdfColor) {
  return rgb(color.red, color.green, color.blue);
}

/** Draw a planned vector run without changing its element order. */
export function drawHybridVectorRun(
  page: PDFPage,
  run: HybridAnnotationRun,
  placement: Readonly<HybridVectorPlacement>,
): void {
  if (run.kind !== "vector" || !run.vectorInstructions) {
    throw new Error("Only planned vector annotation runs can be drawn as vectors.");
  }
  if (
    !isFiniteNumber(placement.originX)
    || !isFiniteNumber(placement.originFromTop)
    || !isFiniteNumber(placement.targetHeight)
    || !isFiniteNumber(placement.scale)
    || placement.targetHeight <= 0
    || placement.scale <= 0
  ) throw new Error("The hybrid annotation placement is invalid.");

  const sceneTopInPdf = placement.targetHeight - placement.originFromTop;
  for (const vector of run.vectorInstructions) {
    const cosine = Math.cos(vector.angle);
    const sine = Math.sin(vector.angle);
    const desiredCenterX = placement.originX
      + (vector.x + vector.localCenterX) * placement.scale;
    const desiredCenterY = sceneTopInPdf
      - (vector.y + vector.localCenterY) * placement.scale;
    // pdf-lib flips SVG's y-axis before rotating it. A negative angle maps the
    // editor's clockwise-positive, y-down rotation into PDF coordinates.
    const transformedCenterX = placement.scale * (
      cosine * vector.localCenterX - sine * vector.localCenterY
    );
    const transformedCenterY = placement.scale * (
      -sine * vector.localCenterX - cosine * vector.localCenterY
    );
    const fillOpacity = vector.fill
      ? vector.opacity * vector.fill.alpha
      : undefined;
    const strokeOpacity = vector.stroke
      ? vector.opacity * vector.stroke.alpha
      : undefined;

    page.drawSvgPath(vector.path, {
      x: desiredCenterX - transformedCenterX,
      y: desiredCenterY - transformedCenterY,
      scale: placement.scale,
      rotate: degrees(-vector.angle * 180 / Math.PI),
      ...(vector.fill ? {
        color: pdfColor(vector.fill),
        opacity: fillOpacity,
      } : {}),
      ...(vector.stroke ? {
        borderColor: pdfColor(vector.stroke),
        borderOpacity: strokeOpacity,
        // drawSvgPath's transform scales both geometry and stroke width.
        borderWidth: vector.strokeWidth,
        borderLineCap: LineCapStyle.Round,
      } : {}),
    });
  }
}
