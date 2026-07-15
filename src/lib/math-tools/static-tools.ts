import { PDF_POINTS_PER_INCH } from "./ruler";
import { escapeMathSvgText, mathSvgToDataUrl } from "./svg";
import type {
  CartesianPlaneMathToolMetadata,
  GeometryStencilMathToolMetadata,
  GridMathToolMetadata,
  MathToolAsset,
  NumberLineMathToolMetadata,
  SetSquareMathToolMetadata,
  UnitCircleMathToolMetadata,
} from "./types";

const FONT = "Arial, Helvetica, sans-serif";

function asset(svg: string, width: number, height: number): MathToolAsset {
  return { dataUrl: mathSvgToDataUrl(svg), height, svg, width };
}

function compact(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

export type SetSquareVariant = "30-60-90" | "45-45-90";

export function createSetSquareAsset(variant: SetSquareVariant): { asset: MathToolAsset; metadata: Omit<SetSquareMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const width = 7 * PDF_POINTS_PER_INCH;
  const height = variant === "45-45-90" ? width : width / Math.sqrt(3);
  const inset = 64;
  const innerRight = width - inset * 1.7;
  const innerBottom = height - inset;
  const innerTop = innerBottom - (innerRight - inset) * (variant === "45-45-90" ? 1 : 1 / Math.sqrt(3));
  const ticks: string[] = [];
  for (let quarter = 0; quarter <= 28; quarter += 1) {
    const x = quarter * PDF_POINTS_PER_INCH / 4;
    const length = quarter % 4 === 0 ? 20 : quarter % 2 === 0 ? 13 : 8;
    ticks.push(`<line data-edge-tick="${quarter}" x1="${compact(x)}" y1="${compact(height - 1)}" x2="${compact(x)}" y2="${compact(height - 1 - length)}"/>`);
  }
  const angles = variant === "45-45-90" ? [45, 45, 90] : [30, 60, 90];
  const topAngle = variant === "45-45-90" ? 45 : 60;
  const rightAngle = variant === "45-45-90" ? 45 : 30;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${compact(height)}" viewBox="0 0 ${compact(width)} ${compact(height)}" role="img" aria-label="${variant} calibrated set square">`,
    `<path data-part="body" d="M 1 ${compact(height - 1)} L ${compact(width - 1)} ${compact(height - 1)} L 1 1 Z M ${inset} ${compact(innerBottom)} L ${compact(innerRight)} ${compact(innerBottom)} L ${inset} ${compact(innerTop)} Z" fill="#f6c85f" fill-opacity="0.48" fill-rule="evenodd" stroke="#755815" stroke-width="1.4" stroke-linejoin="round"/>`,
    `<g data-part="edge-ticks" stroke="#59430f" stroke-width="0.9">${ticks.join("")}</g>`,
    `<g data-part="angle-labels" fill="#49370d" font-family="${FONT}" font-size="16" font-weight="700">`,
    `<text data-angle="${topAngle}" x="28" y="38">${topAngle}°</text>`,
    `<text data-angle="${rightAngle}" x="${compact(width - 66)}" y="${compact(height - 24)}">${rightAngle}°</text>`,
    `<text data-angle="90" x="24" y="${compact(height - 25)}">90°</text>`,
    `</g><text x="${compact(width / 2)}" y="${compact(height - 30)}" text-anchor="middle" fill="#59430f" font-family="${FONT}" font-size="14" font-weight="700">${variant} SET SQUARE</text></svg>`,
  ].join("");
  return {
    asset: asset(svg, width, height),
    metadata: {
      calibration: "pdf-points",
      variant,
      legLengthInches: 7,
      metricEdgeLengthCentimetres: 17.78,
      smallestDivisionInches: 0.25,
      markedAngles: angles,
      sceneUnitsPerInch: 72,
    },
  };
}

export const GEOMETRY_STENCIL_SHAPES = [
  "circle",
  "triangle",
  "square",
  "rectangle",
  "pentagon",
  "hexagon",
  "parallelogram",
  "trapezoid",
  "rhombus",
] as const;

export function createGeometryStencilAsset(): { asset: MathToolAsset; metadata: Omit<GeometryStencilMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const width = 10 * PDF_POINTS_PER_INCH;
  const height = 6 * PDF_POINTS_PER_INCH;
  const cutouts = [
    `<circle data-shape-id="circle" cx="82" cy="95" r="42"/>`,
    `<polygon data-shape-id="triangle" points="190,135 245,52 300,135"/>`,
    `<rect data-shape-id="square" x="365" y="53" width="82" height="82" rx="3"/>`,
    `<rect data-shape-id="rectangle" x="520" y="65" width="130" height="70" rx="3"/>`,
    `<polygon data-shape-id="pentagon" points="85,239 126,269 110,317 60,317 44,269"/>`,
    `<polygon data-shape-id="hexagon" points="207,238 257,238 282,279 257,320 207,320 182,279"/>`,
    `<polygon data-shape-id="parallelogram" points="350,248 460,248 435,318 325,318"/>`,
    `<polygon data-shape-id="trapezoid" points="522,248 625,248 655,318 492,318"/>`,
    `<polygon data-shape-id="rhombus" points="374,350 426,386 374,422 322,386"/>`,
  ];
  const labels = [
    [82, 158, "CIRCLE"], [245, 158, "TRIANGLE"], [406, 158, "SQUARE"], [585, 158, "RECTANGLE"],
    [85, 340, "PENTAGON"], [232, 340, "HEXAGON"], [392, 340, "PARALLELOGRAM"], [574, 340, "TRAPEZOID"], [485, 402, "RHOMBUS"],
  ].map(([x, y, label]) => `<text x="${x}" y="${y}" text-anchor="middle">${label}</text>`).join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Calibrated geometry stencil with nine shape cut-outs">`,
    `<defs><mask id="geometry-stencil-mask" maskUnits="userSpaceOnUse"><rect width="${width}" height="${height}" fill="#fff"/>`,
    `<g fill="#000">${cutouts.join("")}</g></mask></defs>`,
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="18" fill="#7cc7ff" fill-opacity="0.48" stroke="#15557d" stroke-width="2" mask="url(#geometry-stencil-mask)"/>`,
    `<g fill="none" stroke="#15557d" stroke-width="1.4">${cutouts.join("")}</g>`,
    `<g data-part="shape-labels" fill="#123f5c" font-family="${FONT}" font-size="11" font-weight="700" letter-spacing="0.5">${labels}</g>`,
    `</svg>`,
  ].join("");
  return {
    asset: asset(svg, width, height),
    metadata: {
      calibration: "pdf-points",
      stencilVersion: 1,
      physicalWidthInches: 10,
      physicalHeightInches: 6,
      includedShapeIds: [...GEOMETRY_STENCIL_SHAPES],
      cutoutWidths: [84, 110, 82, 130, 82, 100, 135, 163, 104],
      cutoutHeights: [84, 83, 82, 70, 78, 82, 70, 70, 72],
      labelSet: "english",
      sceneUnitsPerInch: 72,
    },
  };
}

export interface CartesianPlaneConfiguration {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  majorStep: number;
  minorDivisions: number;
  showGrid: boolean;
  showAxes: boolean;
  showNumbers: boolean;
  showQuadrantLabels: boolean;
  xLabel: string;
  yLabel: string;
}

export const DEFAULT_CARTESIAN_PLANE: CartesianPlaneConfiguration = {
  xMin: -10, xMax: 10, yMin: -10, yMax: 10, majorStep: 1, minorDivisions: 1,
  showGrid: true, showAxes: true, showNumbers: true, showQuadrantLabels: true, xLabel: "x", yLabel: "y",
};

export function validateCartesianPlaneConfiguration(input: CartesianPlaneConfiguration): CartesianPlaneConfiguration {
  const values = [input.xMin, input.xMax, input.yMin, input.yMax, input.majorStep];
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Coordinate ranges and step must be finite numbers.");
  if (input.xMin >= input.xMax || input.yMin >= input.yMax) throw new Error("Each coordinate minimum must be less than its maximum.");
  if (input.xMax - input.xMin > 40 || input.yMax - input.yMin > 40) throw new Error("Keep each coordinate span at 40 units or fewer.");
  if (input.majorStep <= 0 || input.majorStep > 10) throw new Error("Major step must be greater than zero and at most 10.");
  if (!Number.isInteger(input.minorDivisions) || input.minorDivisions < 1 || input.minorDivisions > 5) throw new Error("Minor divisions must be an integer from 1 to 5.");
  if (input.xLabel.length > 12 || input.yLabel.length > 12) throw new Error("Axis labels must be 12 characters or fewer.");
  const tickCount = (input.xMax - input.xMin + input.yMax - input.yMin) / input.majorStep;
  if (tickCount > 160) throw new Error("That coordinate plane would have too many labelled intervals.");
  return { ...input, xLabel: input.xLabel.trim(), yLabel: input.yLabel.trim() };
}

function gridValues(minimum: number, maximum: number, step: number): number[] {
  const first = Math.ceil(minimum / step) * step;
  const values: number[] = [];
  for (let value = first, count = 0; value <= maximum + step / 10 && count < 500; value += step, count += 1) {
    values.push(Math.abs(value) < step / 10_000 ? 0 : Number(value.toFixed(8)));
  }
  return values;
}

export function createCartesianPlaneAsset(input: CartesianPlaneConfiguration): { asset: MathToolAsset; metadata: Omit<CartesianPlaneMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const config = validateCartesianPlaneConfiguration(input);
  const xSpan = config.xMax - config.xMin;
  const ySpan = config.yMax - config.yMin;
  const scenePointsPerUnit = Math.min(36, 620 / Math.max(xSpan, ySpan));
  const padding = 42;
  const width = xSpan * scenePointsPerUnit + padding * 2;
  const height = ySpan * scenePointsPerUnit + padding * 2;
  const xFor = (value: number) => padding + (value - config.xMin) * scenePointsPerUnit;
  const yFor = (value: number) => padding + (config.yMax - value) * scenePointsPerUnit;
  const minorStep = config.majorStep / config.minorDivisions;
  const minorLines: string[] = [];
  const majorLines: string[] = [];
  if (config.showGrid) {
    for (const value of gridValues(config.xMin, config.xMax, minorStep)) {
      const target = Math.abs(value / config.majorStep - Math.round(value / config.majorStep)) < 1e-7 ? majorLines : minorLines;
      target.push(`<line data-grid-axis="x" data-value="${compact(value)}" x1="${compact(xFor(value))}" y1="${padding}" x2="${compact(xFor(value))}" y2="${compact(height - padding)}"/>`);
    }
    for (const value of gridValues(config.yMin, config.yMax, minorStep)) {
      const target = Math.abs(value / config.majorStep - Math.round(value / config.majorStep)) < 1e-7 ? majorLines : minorLines;
      target.push(`<line data-grid-axis="y" data-value="${compact(value)}" x1="${padding}" y1="${compact(yFor(value))}" x2="${compact(width - padding)}" y2="${compact(yFor(value))}"/>`);
    }
  }
  const labels: string[] = [];
  if (config.showNumbers) {
    const labelY = config.yMin <= 0 && config.yMax >= 0 ? yFor(0) + 18 : height - padding + 18;
    for (const value of gridValues(config.xMin, config.xMax, config.majorStep)) {
      if (value !== 0) labels.push(`<text data-number-axis="x" data-value="${compact(value)}" x="${compact(xFor(value))}" y="${compact(labelY)}" text-anchor="middle">${compact(value)}</text>`);
    }
    const labelX = config.xMin <= 0 && config.xMax >= 0 ? xFor(0) - 8 : padding - 8;
    for (const value of gridValues(config.yMin, config.yMax, config.majorStep)) {
      if (value !== 0) labels.push(`<text data-number-axis="y" data-value="${compact(value)}" x="${compact(labelX)}" y="${compact(yFor(value) + 4)}" text-anchor="end">${compact(value)}</text>`);
    }
  }
  const axes: string[] = [];
  if (config.showAxes) {
    if (config.yMin <= 0 && config.yMax >= 0) {
      const y = yFor(0);
      axes.push(`<line data-axis="x" x1="${padding - 8}" y1="${compact(y)}" x2="${compact(width - padding + 8)}" y2="${compact(y)}"/>`);
      axes.push(`<polyline data-axis-arrow="x-negative" points="${padding},${compact(y - 5)} ${padding - 8},${compact(y)} ${padding},${compact(y + 5)}"/><polyline data-axis-arrow="x-positive" points="${compact(width - padding)},${compact(y - 5)} ${compact(width - padding + 8)},${compact(y)} ${compact(width - padding)},${compact(y + 5)}"/>`);
    }
    if (config.xMin <= 0 && config.xMax >= 0) {
      const x = xFor(0);
      axes.push(`<line data-axis="y" x1="${compact(x)}" y1="${padding - 8}" x2="${compact(x)}" y2="${compact(height - padding + 8)}"/>`);
      axes.push(`<polyline data-axis-arrow="y-positive" points="${compact(x - 5)},${padding} ${compact(x)},${padding - 8} ${compact(x + 5)},${padding}"/><polyline data-axis-arrow="y-negative" points="${compact(x - 5)},${compact(height - padding)} ${compact(x)},${compact(height - padding + 8)} ${compact(x + 5)},${compact(height - padding)}"/>`);
    }
  }
  const quadrantLabels: string[] = [];
  if (config.showQuadrantLabels && config.showAxes) {
    const addQuadrant = (label: string, xMinimum: number, xMaximum: number, yMinimum: number, yMaximum: number) => {
      if (xMinimum >= xMaximum || yMinimum >= yMaximum) return;
      quadrantLabels.push(`<text data-quadrant-label="${label}" x="${compact(xFor((xMinimum + xMaximum) / 2))}" y="${compact(yFor((yMinimum + yMaximum) / 2))}" text-anchor="middle">${label}</text>`);
    };
    addQuadrant("I", Math.max(0, config.xMin), config.xMax, Math.max(0, config.yMin), config.yMax);
    addQuadrant("II", config.xMin, Math.min(0, config.xMax), Math.max(0, config.yMin), config.yMax);
    addQuadrant("III", config.xMin, Math.min(0, config.xMax), config.yMin, Math.min(0, config.yMax));
    addQuadrant("IV", Math.max(0, config.xMin), config.xMax, config.yMin, Math.min(0, config.yMax));
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${compact(height)}" viewBox="0 0 ${compact(width)} ${compact(height)}" role="img" aria-label="Cartesian plane from ${config.xMin} to ${config.xMax} and ${config.yMin} to ${config.yMax}">`,
    `<rect x="${padding}" y="${padding}" width="${compact(width - padding * 2)}" height="${compact(height - padding * 2)}" fill="#fff" stroke="#64748b"/>`,
    `<g data-part="minor-grid" stroke="#dbe5f0" stroke-width="0.7">${minorLines.join("")}</g>`,
    `<g data-part="major-grid" stroke="#a9bdd3" stroke-width="1">${majorLines.join("")}</g>`,
    `<g data-part="axes" stroke="#172033" stroke-width="2" stroke-linecap="round">${axes.join("")}</g>`,
    `<g data-part="number-labels" fill="#172033" font-family="${FONT}" font-size="11">${labels.join("")}</g>`,
    `<g data-part="quadrant-labels" fill="#64748b" font-family="${FONT}" font-size="14" font-weight="700">${quadrantLabels.join("")}</g>`,
    `<g data-part="axis-labels" fill="#172033" font-family="${FONT}" font-size="16" font-weight="700"><text x="${compact(width - 22)}" y="${compact(config.yMin <= 0 && config.yMax >= 0 ? yFor(0) - 8 : height - 16)}">${escapeMathSvgText(config.xLabel)}</text><text x="${compact(config.xMin <= 0 && config.xMax >= 0 ? xFor(0) + 10 : 18)}" y="24">${escapeMathSvgText(config.yLabel)}</text></g>`,
    `</svg>`,
  ].join("");
  return { asset: asset(svg, width, height), metadata: { calibration: "logical-units", configurationVersion: 1, ...config, scenePointsPerUnit } };
}

export interface NumberLineConfiguration {
  minimum: number;
  maximum: number;
  majorStep: number;
  minorDivisions: number;
  labelFormat: "decimal" | "fraction" | "integer";
  arrowMode: "both" | "left" | "none" | "right";
  axisLabel: string;
}

export const DEFAULT_NUMBER_LINE: NumberLineConfiguration = {
  minimum: -10, maximum: 10, majorStep: 1, minorDivisions: 1, labelFormat: "integer", arrowMode: "both", axisLabel: "",
};

export function validateNumberLineConfiguration(input: NumberLineConfiguration): NumberLineConfiguration {
  if (![input.minimum, input.maximum, input.majorStep].every(Number.isFinite)) throw new Error("Number-line range and step must be finite numbers.");
  if (input.minimum >= input.maximum) throw new Error("Number-line minimum must be less than its maximum.");
  if (input.maximum - input.minimum > 100) throw new Error("Keep the number-line span at 100 units or fewer.");
  if (input.majorStep <= 0) throw new Error("Major step must be greater than zero.");
  if (!Number.isInteger(input.minorDivisions) || input.minorDivisions < 1 || input.minorDivisions > 10) throw new Error("Minor divisions must be an integer from 1 to 10.");
  if ((input.maximum - input.minimum) / input.majorStep > 100) throw new Error("That number line would have too many labelled intervals.");
  if (input.labelFormat === "integer" && ![input.minimum, input.maximum, input.majorStep].every(Number.isInteger)) {
    throw new Error("Integer labels require integer endpoints and a whole-number major step.");
  }
  if (input.axisLabel.length > 24) throw new Error("Number-line label must be 24 characters or fewer.");
  return { ...input, axisLabel: input.axisLabel.trim() };
}

function gcd(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left || 1;
}

function fractionLabel(value: number): string {
  let bestNumerator = Math.round(value);
  let bestDenominator = 1;
  let bestError = Math.abs(value - bestNumerator);
  for (let denominator = 2; denominator <= 16; denominator += 1) {
    const numerator = Math.round(value * denominator);
    const error = Math.abs(value - numerator / denominator);
    if (error < bestError) [bestNumerator, bestDenominator, bestError] = [numerator, denominator, error];
  }
  const divisor = gcd(bestNumerator, bestDenominator);
  const numerator = bestNumerator / divisor;
  const denominator = bestDenominator / divisor;
  return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
}

function formatNumberLineLabel(value: number, format: NumberLineConfiguration["labelFormat"]): string {
  if (format === "fraction") return fractionLabel(value);
  if (format === "integer") return String(Math.round(value));
  return compact(value);
}

export function createNumberLineAsset(input: NumberLineConfiguration): { asset: MathToolAsset; metadata: Omit<NumberLineMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const config = validateNumberLineConfiguration(input);
  const span = config.maximum - config.minimum;
  const scenePointsPerUnit = Math.min(54, 760 / span);
  const padding = 44;
  const width = span * scenePointsPerUnit + padding * 2;
  const height = 126;
  const axisY = 54;
  const xFor = (value: number) => padding + (value - config.minimum) * scenePointsPerUnit;
  const ticks: string[] = [];
  const labels: string[] = [];
  const minorStep = config.majorStep / config.minorDivisions;
  const intervalCount = Math.floor(span / minorStep + 1e-8);
  const values = Array.from({ length: intervalCount + 1 }, (_, index) => Number((config.minimum + index * minorStep).toFixed(8)));
  if (Math.abs(values[values.length - 1] - config.maximum) > 1e-7) values.push(config.maximum);
  for (const [index, value] of values.entries()) {
    const major = index % config.minorDivisions === 0 || value === config.maximum;
    ticks.push(`<line data-tick-value="${compact(value)}" data-major="${major}" x1="${compact(xFor(value))}" y1="${axisY - (major ? 14 : 8)}" x2="${compact(xFor(value))}" y2="${axisY + (major ? 14 : 8)}"/>`);
    if (major) labels.push(`<text data-label-value="${compact(value)}" x="${compact(xFor(value))}" y="88" text-anchor="middle">${escapeMathSvgText(formatNumberLineLabel(value, config.labelFormat))}</text>`);
  }
  const leftArrow = config.arrowMode === "both" || config.arrowMode === "left" ? `<polyline data-arrow="left" points="${padding + 12},${axisY - 8} ${padding},${axisY} ${padding + 12},${axisY + 8}"/>` : "";
  const rightArrow = config.arrowMode === "both" || config.arrowMode === "right" ? `<polyline data-arrow="right" points="${compact(width - padding - 12)},${axisY - 8} ${compact(width - padding)},${axisY} ${compact(width - padding - 12)},${axisY + 8}"/>` : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${compact(width)}" height="${height}" viewBox="0 0 ${compact(width)} ${height}" role="img" aria-label="Number line from ${config.minimum} to ${config.maximum}">`,
    `<rect width="${compact(width)}" height="${height}" rx="10" fill="#fff" fill-opacity="0.92" stroke="#cbd5e1"/>`,
    `<g data-part="axis" fill="none" stroke="#162033" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="${padding}" y1="${axisY}" x2="${compact(width - padding)}" y2="${axisY}"/>${leftArrow}${rightArrow}${ticks.join("")}</g>`,
    `<g data-part="number-labels" fill="#162033" font-family="${FONT}" font-size="13" font-weight="600">${labels.join("")}</g>`,
    config.axisLabel ? `<text data-part="axis-label" x="${compact(width / 2)}" y="114" text-anchor="middle" fill="#334155" font-family="${FONT}" font-size="13">${escapeMathSvgText(config.axisLabel)}</text>` : "",
    `</svg>`,
  ].join("");
  return { asset: asset(svg, width, height), metadata: { calibration: "logical-units", configurationVersion: 1, ...config, scenePointsPerUnit } };
}

export type UnitCircleLabelMode = "both" | "degrees" | "radians";

export interface UnitCircleRenderedMathLabel {
  aspectRatio: number;
  body: string;
  viewBox: string;
}

export interface UnitCircleRenderedMathLabels {
  angles: ReadonlyMap<number, UnitCircleRenderedMathLabel>;
  coordinates: ReadonlyMap<number, UnitCircleRenderedMathLabel>;
}

const UNIT_CIRCLE_POINTS = [
  [0, "0", "0", "(1, 0)"], [30, "30°", "π/6", "(√3/2, 1/2)"], [45, "45°", "π/4", "(√2/2, √2/2)"], [60, "60°", "π/3", "(1/2, √3/2)"], [90, "90°", "π/2", "(0, 1)"],
  [120, "120°", "2π/3", "(-1/2, √3/2)"], [135, "135°", "3π/4", "(-√2/2, √2/2)"], [150, "150°", "5π/6", "(-√3/2, 1/2)"], [180, "180°", "π", "(-1, 0)"],
  [210, "210°", "7π/6", "(-√3/2, -1/2)"], [225, "225°", "5π/4", "(-√2/2, -√2/2)"], [240, "240°", "4π/3", "(-1/2, -√3/2)"], [270, "270°", "3π/2", "(0, -1)"],
  [300, "300°", "5π/3", "(1/2, -√3/2)"], [315, "315°", "7π/4", "(√2/2, -√2/2)"], [330, "330°", "11π/6", "(√3/2, -1/2)"],
] as const;

function positionedMathLabel(
  label: UnitCircleRenderedMathLabel,
  degrees: number,
  kind: "angle" | "coordinate",
  centreX: number,
  centreY: number,
  preferredHeight: number,
): string {
  const width = Math.min(kind === "angle" ? 94 : 112, preferredHeight * label.aspectRatio);
  return `<svg data-${kind}-label="${degrees}" data-label-renderer="mathjax" x="${compact(centreX - width / 2)}" y="${compact(centreY - preferredHeight / 2)}" width="${compact(width)}" height="${preferredHeight}" viewBox="${label.viewBox}" preserveAspectRatio="xMidYMid meet">${label.body}</svg>`;
}

export function createUnitCircleAsset(
  labelMode: UnitCircleLabelMode = "both",
  showCoordinates = true,
  renderedMath?: UnitCircleRenderedMathLabels,
): { asset: MathToolAsset; metadata: Omit<UnitCircleMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const width = 620;
  const height = 620;
  const centre = 310;
  const radius = 190;
  const rays: string[] = [];
  const labels: string[] = [];
  for (const [degrees, degreeLabel, radianLabel, coordinate] of UNIT_CIRCLE_POINTS) {
    const radians = -degrees * Math.PI / 180;
    const x = centre + radius * Math.cos(radians);
    const y = centre + radius * Math.sin(radians);
    const labelRadius = radius + 55;
    const labelX = centre + labelRadius * Math.cos(radians);
    const labelY = centre + labelRadius * Math.sin(radians);
    const angleText = labelMode === "degrees" ? degreeLabel : labelMode === "radians" ? radianLabel : `${degreeLabel}  ${radianLabel}`;
    rays.push(`<line data-angle="${degrees}" x1="${centre}" y1="${centre}" x2="${compact(x)}" y2="${compact(y)}"/>`);
    const renderedAngle = renderedMath?.angles.get(degrees);
    labels.push(renderedAngle
      ? positionedMathLabel(renderedAngle, degrees, "angle", labelX, labelY - (showCoordinates ? 8 : 0), labelMode === "both" ? 19 : 17)
      : `<text data-angle-label="${degrees}" x="${compact(labelX)}" y="${compact(labelY - (showCoordinates ? 5 : 0))}" text-anchor="middle">${angleText}</text>`);
    if (showCoordinates) {
      const renderedCoordinate = renderedMath?.coordinates.get(degrees);
      labels.push(renderedCoordinate
        ? positionedMathLabel(renderedCoordinate, degrees, "coordinate", labelX, labelY + 11, 15)
        : `<text data-coordinate-label="${degrees}" x="${compact(labelX)}" y="${compact(labelY + 10)}" text-anchor="middle">${coordinate}</text>`);
    }
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Unit circle with standard special angles">`,
    `<rect width="${width}" height="${height}" rx="14" fill="#fff" fill-opacity="0.94" stroke="#cbd5e1"/>`,
    `<g data-part="rays" stroke="#d6e1ee" stroke-width="0.8">${rays.join("")}</g>`,
    `<g data-part="axes" stroke="#172033" stroke-width="1.8"><line x1="65" y1="${centre}" x2="555" y2="${centre}"/><line x1="${centre}" y1="65" x2="${centre}" y2="555"/></g>`,
    `<circle data-part="unit-circle" cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke="#2d63b8" stroke-width="3"/>`,
    `<g data-part="labels" data-label-renderer="${renderedMath ? "mathjax" : "plain"}" fill="#172033" font-family="${FONT}" font-size="10" font-weight="600">${labels.join("")}</g>`,
    `<g fill="#172033" font-family="${FONT}" font-size="15" font-weight="700"><text x="565" y="302">x</text><text x="320" y="66">y</text></g>`,
    `</svg>`,
  ].join("");
  return { asset: asset(svg, width, height), metadata: { calibration: "logical-units", specialAngleSetVersion: 1, labelMode, showCoordinates, radiusScenePoints: radius } };
}

export type GridVariant = "dot" | "isometric" | "polar" | "square";

export function createGridAsset(variant: GridVariant): { asset: MathToolAsset; metadata: Omit<GridMathToolMetadata, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion"> } {
  const width = 600;
  const height = 420;
  const spacing = 24;
  const rows = 16;
  const columns = 24;
  const majorInterval = variant === "polar" ? 2 : 5;
  const marks: string[] = [];
  if (variant === "square") {
    for (let column = 0; column <= columns; column += 1) marks.push(`<line data-grid-column="${column}" data-major="${column % majorInterval === 0}" x1="${12 + column * spacing}" y1="12" x2="${12 + column * spacing}" y2="408" stroke-width="${column % majorInterval === 0 ? 1.4 : 0.7}"/>`);
    for (let row = 0; row <= rows; row += 1) marks.push(`<line data-grid-row="${row}" data-major="${row % majorInterval === 0}" x1="12" y1="${12 + row * spacing}" x2="588" y2="${12 + row * spacing}" stroke-width="${row % majorInterval === 0 ? 1.4 : 0.7}"/>`);
  } else if (variant === "dot") {
    for (let row = 0; row <= rows; row += 1) for (let column = 0; column <= columns; column += 1) {
      const major = row % majorInterval === 0 && column % majorInterval === 0;
      marks.push(`<circle data-grid-dot="${row}-${column}" data-major="${major}" cx="${12 + column * spacing}" cy="${12 + row * spacing}" r="${major ? 2.5 : 1.5}" fill="#55708f"/>`);
    }
  } else if (variant === "isometric") {
    const diagonal = Math.tan(Math.PI / 3) * height;
    let diagonalIndex = 0;
    for (let x = -diagonal; x <= width + diagonal; x += spacing * 2, diagonalIndex += 1) {
      const strokeWidth = diagonalIndex % majorInterval === 0 ? 1.4 : 0.7;
      marks.push(`<line data-grid-slope="60" data-major="${diagonalIndex % majorInterval === 0}" x1="${compact(x)}" y1="0" x2="${compact(x + diagonal)}" y2="${height}" stroke-width="${strokeWidth}"/>`);
      marks.push(`<line data-grid-slope="-60" data-major="${diagonalIndex % majorInterval === 0}" x1="${compact(x)}" y1="${height}" x2="${compact(x + diagonal)}" y2="0" stroke-width="${strokeWidth}"/>`);
    }
    for (let row = 0; row <= rows; row += 1) marks.push(`<line data-grid-slope="0" data-major="${row % majorInterval === 0}" x1="0" y1="${12 + row * spacing}" x2="${width}" y2="${12 + row * spacing}" stroke-width="${row % majorInterval === 0 ? 1.4 : 0.7}"/>`);
  } else {
    const centreX = width / 2;
    const centreY = height / 2;
    for (let ring = 1; ring <= 8; ring += 1) marks.push(`<circle data-grid-ring="${ring}" data-major="${ring % majorInterval === 0}" cx="${centreX}" cy="${centreY}" r="${ring * 24}" stroke-width="${ring % majorInterval === 0 ? 1.4 : 0.7}"/>`);
    for (let ray = 0; ray < 24; ray += 1) {
      const angle = ray * Math.PI / 12;
      marks.push(`<line data-grid-ray="${ray}" data-major="${ray % 3 === 0}" x1="${centreX}" y1="${centreY}" x2="${compact(centreX + 192 * Math.cos(angle))}" y2="${compact(centreY + 192 * Math.sin(angle))}" stroke-width="${ray % 3 === 0 ? 1.2 : 0.7}"/>`);
    }
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${variant} classroom grid">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#fff" fill-opacity="0.9" stroke="#9fb1c5"/>`,
    `<g data-part="grid-marks" fill="none" stroke="#7392b3" stroke-width="0.8">${marks.join("")}</g>`,
    `</svg>`,
  ].join("");
  return { asset: asset(svg, width, height), metadata: { calibration: "logical-units", variant, rows, columns, rings: variant === "polar" ? 8 : 0, rays: variant === "polar" ? 24 : 0, majorInterval, spacing } };
}
