export type MathToolCategory = "instruments" | "graphs" | "manipulatives";
export type MathToolCalibration = "logical-units" | "pdf-points" | "scene-geometry";

export type MathToolKind =
  | "algebra-tile"
  | "angle-measurement"
  | "cartesian-plane"
  | "compass"
  | "fraction-piece"
  | "function-plot"
  | "geometry-stencil"
  | "grid"
  | "integer-chip"
  | "number-line"
  | "protractor"
  | "probability-piece"
  | "ruler"
  | "set-square"
  | "transformation"
  | "unit-circle";

export interface MathToolAsset {
  dataUrl: string;
  height: number;
  svg: string;
  width: number;
}

interface MathToolMetadataBase<K extends MathToolKind, C extends MathToolCalibration> {
  schemaVersion: 1;
  kind: K;
  category: MathToolCategory;
  calibration: C;
  naturalWidth: number;
  naturalHeight: number;
  sceneUnitsPerInch?: number;
}

export interface RulerMathToolMetadata extends MathToolMetadataBase<"ruler", "pdf-points"> {
  imperialLengthInches: number;
  metricLengthCentimetres: number;
  sceneUnitsPerInch: 72;
}

export interface ProtractorMathToolMetadata extends MathToolMetadataBase<"protractor", "pdf-points"> {
  diameterInches: number;
  angleRangeDegrees: number;
  smallestDivisionDegrees: number;
  dualScale: boolean;
  sceneUnitsPerInch: 72;
}

export interface SetSquareMathToolMetadata extends MathToolMetadataBase<"set-square", "pdf-points"> {
  variant: "30-60-90" | "45-45-90";
  legLengthInches: number;
  metricEdgeLengthCentimetres: number;
  smallestDivisionInches: number;
  markedAngles: number[];
  sceneUnitsPerInch: 72;
}

export interface GeometryStencilMathToolMetadata extends MathToolMetadataBase<"geometry-stencil", "pdf-points"> {
  stencilVersion: 1;
  physicalWidthInches: number;
  physicalHeightInches: number;
  includedShapeIds: string[];
  cutoutWidths: number[];
  cutoutHeights: number[];
  labelSet: "english";
  sceneUnitsPerInch: 72;
}

export interface CartesianPlaneMathToolMetadata extends MathToolMetadataBase<"cartesian-plane", "logical-units"> {
  configurationVersion: 1;
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
  scenePointsPerUnit: number;
}

export interface NumberLineMathToolMetadata extends MathToolMetadataBase<"number-line", "logical-units"> {
  configurationVersion: 1;
  minimum: number;
  maximum: number;
  majorStep: number;
  minorDivisions: number;
  labelFormat: "decimal" | "fraction" | "integer";
  arrowMode: "both" | "left" | "none" | "right";
  axisLabel: string;
  scenePointsPerUnit: number;
}

export interface UnitCircleMathToolMetadata extends MathToolMetadataBase<"unit-circle", "logical-units"> {
  specialAngleSetVersion: 1;
  labelMode: "both" | "degrees" | "radians";
  showCoordinates: boolean;
  radiusScenePoints: number;
}

export interface GridMathToolMetadata extends MathToolMetadataBase<"grid", "logical-units" | "pdf-points"> {
  variant: "dot" | "isometric" | "polar" | "square";
  rows: number;
  columns: number;
  rings: number;
  rays: number;
  majorInterval: number;
  spacing: number;
}

interface MathToolSetPieceMetadataBase<K extends MathToolKind> extends MathToolMetadataBase<K, "logical-units"> {
  setId: string;
  pieceIndex: number;
}

export interface FractionPieceMathToolMetadata extends MathToolSetPieceMetadataBase<"fraction-piece"> {
  representation: "bar" | "circle";
  maximumDenominator: number;
  numerator: 1;
  denominator: number;
  colourPaletteVersion: 1;
  pieceGeometry: "bar" | "sector";
  wholeSize: number;
}

export interface AlgebraTileMathToolMetadata extends MathToolSetPieceMetadataBase<"algebra-tile"> {
  variableSymbol: "x";
  tileType: "unit" | "x" | "x-squared";
  sign: "negative" | "positive";
  unitSide: number;
  xLength: number;
  paletteVersion: 1;
  requestedPositiveUnits: number;
  requestedNegativeUnits: number;
  requestedPositiveX: number;
  requestedNegativeX: number;
  requestedPositiveXSquared: number;
  requestedNegativeXSquared: number;
}

export interface IntegerChipMathToolMetadata extends MathToolSetPieceMetadataBase<"integer-chip"> {
  sign: "negative" | "positive";
  requestedPositiveCount: number;
  requestedNegativeCount: number;
  chipDiameter: number;
  paletteVersion: 1;
}

export interface ProbabilityPieceMathToolMetadata extends MathToolSetPieceMetadataBase<"probability-piece"> {
  componentType: "card" | "coin" | "die" | "spinner";
  faceOrValue: string;
  spinnerSectorCount: number;
  cardMinimum: number;
  cardMaximum: number;
  paletteVersion: 1;
  componentQuantity: number;
}

export interface FunctionPlotMathToolMetadata extends MathToolMetadataBase<"function-plot", "logical-units"> {
  configurationVersion: 1;
  parserVersion: 1;
  expression: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  sampleCount: number;
  discontinuityThreshold: number;
  showGrid: boolean;
  showAxes: boolean;
  plotStrokeColor: "#d63c54";
  plotStrokeWidth: 2.8;
}

export interface CompassMathToolMetadata extends MathToolMetadataBase<"compass", "scene-geometry"> {
  constructionVersion: 1;
  centerX: number;
  centerY: number;
  radiusPointX: number;
  radiusPointY: number;
  radiusSceneUnits: number;
  startAngleDegrees: number;
  endAngleDegrees: number;
  direction: "clockwise" | "counterclockwise";
  fullCircle: boolean;
  centerMark: boolean;
  strokeColor: "#2859c5";
  strokeWidth: 2.5;
  strokeStyle: "solid";
}

export interface AngleMeasurementMathToolMetadata extends MathToolMetadataBase<"angle-measurement", "scene-geometry"> {
  measurementVersion: 1;
  vertexX: number;
  vertexY: number;
  firstRayX: number;
  firstRayY: number;
  secondRayX: number;
  secondRayY: number;
  reflex: boolean;
  precision: number;
  measuredDegrees: number;
  commitAnnotation: true;
  unit: "degrees";
  annotationStrokeColor: "#7a3db8";
  annotationStrokeWidth: 2.2;
}

export interface TransformationMathToolMetadata extends MathToolMetadataBase<"transformation", "scene-geometry"> {
  transformationVersion: 1;
  transformationType: "dilate" | "reflect-horizontal" | "reflect-line" | "reflect-vertical" | "rotate" | "translate";
  sourceElementId: string;
  copyPolicy: "copy";
  translateX: number;
  translateY: number;
  angleDegrees: number;
  scaleFactor: number;
  centreX: number;
  centreY: number;
  mirrorLineStartX: number;
  mirrorLineStartY: number;
  mirrorLineEndX: number;
  mirrorLineEndY: number;
}

export type ClassroomMathToolMetadata =
  | AlgebraTileMathToolMetadata
  | AngleMeasurementMathToolMetadata
  | CartesianPlaneMathToolMetadata
  | CompassMathToolMetadata
  | FractionPieceMathToolMetadata
  | FunctionPlotMathToolMetadata
  | GeometryStencilMathToolMetadata
  | GridMathToolMetadata
  | IntegerChipMathToolMetadata
  | NumberLineMathToolMetadata
  | ProtractorMathToolMetadata
  | ProbabilityPieceMathToolMetadata
  | RulerMathToolMetadata
  | SetSquareMathToolMetadata
  | TransformationMathToolMetadata
  | UnitCircleMathToolMetadata;

export type MathToolConfiguration =
  | { kind: "algebra-tile"; positiveUnits: number; negativeUnits: number; positiveX: number; negativeX: number; positiveXSquared: number; negativeXSquared: number }
  | { kind: "angle-measurement"; reflex: boolean; precision: number }
  | { kind: "cartesian-plane"; xMin: number; xMax: number; yMin: number; yMax: number; majorStep: number; minorDivisions: number; showGrid: boolean; showAxes: boolean; showNumbers: boolean; showQuadrantLabels: boolean; xLabel: string; yLabel: string }
  | { kind: "compass"; fullCircle: boolean; arcExtentDegrees: number; direction: "clockwise" | "counterclockwise"; centerMark: boolean }
  | { kind: "fraction-piece"; representation: "bar" | "circle"; maximumDenominator: number }
  | { kind: "function-plot"; expression: string; xMin: number; xMax: number; yMin: number; yMax: number; showGrid: boolean; showAxes: boolean }
  | { kind: "geometry-stencil" }
  | { kind: "grid"; variant: "dot" | "isometric" | "polar" | "square" }
  | { kind: "integer-chip"; positiveCount: number; negativeCount: number }
  | { kind: "number-line"; minimum: number; maximum: number; majorStep: number; minorDivisions: number; labelFormat: "decimal" | "fraction" | "integer"; arrowMode: "both" | "left" | "none" | "right"; axisLabel: string }
  | { kind: "protractor" }
  | { kind: "probability-piece"; includeDice: boolean; includeCoins: boolean; includeSpinner: boolean; includeCards: boolean }
  | { kind: "ruler" }
  | { kind: "set-square"; variant: "30-60-90" | "45-45-90" }
  | { kind: "transformation"; transformationType: "dilate" | "reflect-horizontal" | "reflect-line" | "reflect-vertical" | "rotate" | "translate"; translateX: number; translateY: number; angleDegrees: number; scaleFactor: number; mirrorLineAngleDegrees: number }
  | { kind: "unit-circle"; labelMode: "both" | "degrees" | "radians"; showCoordinates: boolean };

export interface GeneratedMathTool {
  asset: MathToolAsset;
  metadata: ClassroomMathToolMetadata;
  scenePosition?: { x: number; y: number };
  toastMessage: string;
}

export interface GeneratedMathToolPiece {
  asset: MathToolAsset;
  metadata: ClassroomMathToolMetadata;
  offsetX: number;
  offsetY: number;
}

export interface GeneratedMathToolBatch {
  pieces: GeneratedMathToolPiece[];
  toastMessage: string;
}

export type GeneratedMathToolInsertion = GeneratedMathTool | GeneratedMathToolBatch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function categoryForKind(kind: MathToolKind): MathToolCategory {
  if (["algebra-tile", "fraction-piece", "integer-chip", "probability-piece"].includes(kind)) return "manipulatives";
  if (["cartesian-plane", "function-plot", "grid", "number-line", "transformation", "unit-circle"].includes(kind)) return "graphs";
  return "instruments";
}

const BASE_METADATA_KEYS = ["schemaVersion", "kind", "category", "calibration", "naturalWidth", "naturalHeight", "sceneUnitsPerInch"] as const;
const METADATA_KEYS: Record<MathToolKind, readonly string[]> = {
  "algebra-tile": ["setId", "pieceIndex", "variableSymbol", "tileType", "sign", "unitSide", "xLength", "paletteVersion", "requestedPositiveUnits", "requestedNegativeUnits", "requestedPositiveX", "requestedNegativeX", "requestedPositiveXSquared", "requestedNegativeXSquared"],
  "angle-measurement": ["measurementVersion", "vertexX", "vertexY", "firstRayX", "firstRayY", "secondRayX", "secondRayY", "reflex", "precision", "measuredDegrees", "commitAnnotation", "unit", "annotationStrokeColor", "annotationStrokeWidth"],
  "cartesian-plane": ["configurationVersion", "xMin", "xMax", "yMin", "yMax", "majorStep", "minorDivisions", "showGrid", "showAxes", "showNumbers", "showQuadrantLabels", "xLabel", "yLabel", "scenePointsPerUnit"],
  compass: ["constructionVersion", "centerX", "centerY", "radiusPointX", "radiusPointY", "radiusSceneUnits", "startAngleDegrees", "endAngleDegrees", "direction", "fullCircle", "centerMark", "strokeColor", "strokeWidth", "strokeStyle"],
  "fraction-piece": ["setId", "pieceIndex", "representation", "maximumDenominator", "numerator", "denominator", "colourPaletteVersion", "pieceGeometry", "wholeSize"],
  "function-plot": ["configurationVersion", "parserVersion", "expression", "xMin", "xMax", "yMin", "yMax", "sampleCount", "discontinuityThreshold", "showGrid", "showAxes", "plotStrokeColor", "plotStrokeWidth"],
  "geometry-stencil": ["stencilVersion", "physicalWidthInches", "physicalHeightInches", "includedShapeIds", "cutoutWidths", "cutoutHeights", "labelSet"],
  grid: ["variant", "rows", "columns", "rings", "rays", "majorInterval", "spacing"],
  "integer-chip": ["setId", "pieceIndex", "sign", "requestedPositiveCount", "requestedNegativeCount", "chipDiameter", "paletteVersion"],
  "number-line": ["configurationVersion", "minimum", "maximum", "majorStep", "minorDivisions", "labelFormat", "arrowMode", "axisLabel", "scenePointsPerUnit"],
  protractor: ["diameterInches", "angleRangeDegrees", "smallestDivisionDegrees", "dualScale"],
  "probability-piece": ["setId", "pieceIndex", "componentType", "faceOrValue", "spinnerSectorCount", "cardMinimum", "cardMaximum", "paletteVersion", "componentQuantity"],
  ruler: ["imperialLengthInches", "metricLengthCentimetres"],
  "set-square": ["variant", "legLengthInches", "metricEdgeLengthCentimetres", "smallestDivisionInches", "markedAngles"],
  transformation: ["transformationVersion", "transformationType", "sourceElementId", "copyPolicy", "translateX", "translateY", "angleDegrees", "scaleFactor", "centreX", "centreY", "mirrorLineStartX", "mirrorLineStartY", "mirrorLineEndX", "mirrorLineEndY"],
  "unit-circle": ["specialAngleSetVersion", "labelMode", "showCoordinates", "radiusScenePoints"],
};

export function sanitizeClassroomMathToolMetadata(value: unknown): ClassroomMathToolMetadata | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") return null;
  const kind = value.kind as MathToolKind;
  if (!["algebra-tile", "angle-measurement", "cartesian-plane", "compass", "fraction-piece", "function-plot", "geometry-stencil", "grid", "integer-chip", "number-line", "protractor", "probability-piece", "ruler", "set-square", "transformation", "unit-circle"].includes(kind)) return null;
  if (!finite(value.naturalWidth, 1, 4_096) || !finite(value.naturalHeight, 1, 4_096)) return null;
  const category = value.category === undefined ? categoryForKind(kind) : value.category;
  if (category !== categoryForKind(kind)) return null;
  const allowedKeys = new Set<string>([...BASE_METADATA_KEYS, ...METADATA_KEYS[kind]]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  const base = { ...value, schemaVersion: 1 as const, kind, category };

  switch (kind) {
    case "compass":
      return value.calibration === "scene-geometry" && value.constructionVersion === 1 && finite(value.centerX, -1_000_000, 1_000_000) && finite(value.centerY, -1_000_000, 1_000_000) && finite(value.radiusPointX, -1_000_000, 1_000_000) && finite(value.radiusPointY, -1_000_000, 1_000_000) && finite(value.radiusSceneUnits, 4, 4_096) && finite(value.startAngleDegrees, -360, 360) && finite(value.endAngleDegrees, -720, 720) && (value.direction === "clockwise" || value.direction === "counterclockwise") && typeof value.fullCircle === "boolean" && typeof value.centerMark === "boolean" && value.strokeColor === "#2859c5" && value.strokeWidth === 2.5 && value.strokeStyle === "solid"
        ? base as unknown as CompassMathToolMetadata : null;
    case "angle-measurement":
      return value.calibration === "scene-geometry" && value.measurementVersion === 1 && finite(value.vertexX, -1_000_000, 1_000_000) && finite(value.vertexY, -1_000_000, 1_000_000) && finite(value.firstRayX, -1_000_000, 1_000_000) && finite(value.firstRayY, -1_000_000, 1_000_000) && finite(value.secondRayX, -1_000_000, 1_000_000) && finite(value.secondRayY, -1_000_000, 1_000_000) && typeof value.reflex === "boolean" && Number.isInteger(value.precision) && finite(value.precision, 0, 2) && finite(value.measuredDegrees, 0, 360) && value.commitAnnotation === true && value.unit === "degrees" && value.annotationStrokeColor === "#7a3db8" && value.annotationStrokeWidth === 2.2
        ? base as unknown as AngleMeasurementMathToolMetadata : null;
    case "transformation":
      return value.calibration === "scene-geometry" && value.transformationVersion === 1 && ["dilate", "reflect-horizontal", "reflect-line", "reflect-vertical", "rotate", "translate"].includes(String(value.transformationType)) && typeof value.sourceElementId === "string" && value.sourceElementId.length >= 1 && value.sourceElementId.length <= 100 && value.copyPolicy === "copy" && finite(value.translateX, -10_000, 10_000) && finite(value.translateY, -10_000, 10_000) && finite(value.angleDegrees, -360, 360) && finite(value.scaleFactor, 0.05, 20) && finite(value.centreX, -1_000_000, 1_000_000) && finite(value.centreY, -1_000_000, 1_000_000) && finite(value.mirrorLineStartX, -1_000_000, 1_000_000) && finite(value.mirrorLineStartY, -1_000_000, 1_000_000) && finite(value.mirrorLineEndX, -1_000_000, 1_000_000) && finite(value.mirrorLineEndY, -1_000_000, 1_000_000) && (value.mirrorLineStartX !== value.mirrorLineEndX || value.mirrorLineStartY !== value.mirrorLineEndY)
        ? base as unknown as TransformationMathToolMetadata : null;
    case "fraction-piece":
      return value.calibration === "logical-units" && typeof value.setId === "string" && value.setId.length >= 4 && value.setId.length <= 100 && Number.isInteger(value.pieceIndex) && finite(value.pieceIndex, 0, 500) && (value.representation === "bar" || value.representation === "circle") && Number.isInteger(value.maximumDenominator) && finite(value.maximumDenominator, 2, 12) && value.numerator === 1 && Number.isInteger(value.denominator) && finite(value.denominator, 1, value.maximumDenominator as number) && value.colourPaletteVersion === 1 && (value.pieceGeometry === "bar" || value.pieceGeometry === "sector") && finite(value.wholeSize, 20, 500)
        ? base as unknown as FractionPieceMathToolMetadata : null;
    case "algebra-tile":
      return value.calibration === "logical-units" && typeof value.setId === "string" && value.setId.length >= 4 && value.setId.length <= 100 && Number.isInteger(value.pieceIndex) && finite(value.pieceIndex, 0, 500) && value.variableSymbol === "x" && ["unit", "x", "x-squared"].includes(String(value.tileType)) && (value.sign === "positive" || value.sign === "negative") && finite(value.unitSide, 10, 200) && finite(value.xLength, value.unitSide as number, 500) && value.paletteVersion === 1 && [value.requestedPositiveUnits, value.requestedNegativeUnits, value.requestedPositiveX, value.requestedNegativeX, value.requestedPositiveXSquared, value.requestedNegativeXSquared].every((count) => Number.isInteger(count) && finite(count, 0, 10))
        ? base as unknown as AlgebraTileMathToolMetadata : null;
    case "integer-chip":
      return value.calibration === "logical-units" && typeof value.setId === "string" && value.setId.length >= 4 && value.setId.length <= 100 && Number.isInteger(value.pieceIndex) && finite(value.pieceIndex, 0, 500) && (value.sign === "positive" || value.sign === "negative") && Number.isInteger(value.requestedPositiveCount) && finite(value.requestedPositiveCount, 0, 50) && Number.isInteger(value.requestedNegativeCount) && finite(value.requestedNegativeCount, 0, 50) && finite(value.chipDiameter, 20, 200) && value.paletteVersion === 1
        ? base as unknown as IntegerChipMathToolMetadata : null;
    case "probability-piece":
      return value.calibration === "logical-units" && typeof value.setId === "string" && value.setId.length >= 4 && value.setId.length <= 100 && Number.isInteger(value.pieceIndex) && finite(value.pieceIndex, 0, 500) && ["card", "coin", "die", "spinner"].includes(String(value.componentType)) && typeof value.faceOrValue === "string" && value.faceOrValue.length <= 24 && Number.isInteger(value.spinnerSectorCount) && finite(value.spinnerSectorCount, 0, 24) && Number.isInteger(value.cardMinimum) && finite(value.cardMinimum, 0, 100) && Number.isInteger(value.cardMaximum) && finite(value.cardMaximum, 0, 100) && value.paletteVersion === 1 && Number.isInteger(value.componentQuantity) && finite(value.componentQuantity, 1, 10)
        ? base as unknown as ProbabilityPieceMathToolMetadata : null;
    case "function-plot":
      return value.calibration === "logical-units" && value.configurationVersion === 1 && value.parserVersion === 1 && typeof value.expression === "string" && value.expression.length >= 1 && value.expression.length <= 160 && finite(value.xMin, -100, 100) && finite(value.xMax, -100, 100) && value.xMax > value.xMin && finite(value.yMin, -100, 100) && finite(value.yMax, -100, 100) && value.yMax > value.yMin && Number.isInteger(value.sampleCount) && finite(value.sampleCount, 50, 1_000) && finite(value.discontinuityThreshold, 1, 1_000) && typeof value.showGrid === "boolean" && typeof value.showAxes === "boolean" && value.plotStrokeColor === "#d63c54" && value.plotStrokeWidth === 2.8
        ? base as unknown as FunctionPlotMathToolMetadata : null;
    case "ruler":
      return value.calibration === "pdf-points" && value.sceneUnitsPerInch === 72 && finite(value.imperialLengthInches, 1, 24) && finite(value.metricLengthCentimetres, 1, 100)
        ? base as unknown as RulerMathToolMetadata : null;
    case "protractor":
      return value.calibration === "pdf-points" && value.sceneUnitsPerInch === 72 && finite(value.diameterInches, 1, 24) && finite(value.angleRangeDegrees, 1, 360) && finite(value.smallestDivisionDegrees, 0.1, 90) && typeof value.dualScale === "boolean"
        ? base as unknown as ProtractorMathToolMetadata : null;
    case "set-square":
      return value.calibration === "pdf-points" && value.sceneUnitsPerInch === 72 && (value.variant === "30-60-90" || value.variant === "45-45-90") && finite(value.legLengthInches, 1, 24) && finite(value.metricEdgeLengthCentimetres, 1, 100) && finite(value.smallestDivisionInches, 0.01, 1) && Array.isArray(value.markedAngles) && value.markedAngles.every((angle) => finite(angle, 1, 179))
        ? base as unknown as SetSquareMathToolMetadata : null;
    case "geometry-stencil":
      return value.calibration === "pdf-points" && value.sceneUnitsPerInch === 72 && value.stencilVersion === 1 && finite(value.physicalWidthInches, 1, 24) && finite(value.physicalHeightInches, 1, 24) && Array.isArray(value.includedShapeIds) && value.includedShapeIds.every((id) => typeof id === "string" && id.length <= 40) && Array.isArray(value.cutoutWidths) && value.cutoutWidths.length === value.includedShapeIds.length && value.cutoutWidths.every((size) => finite(size, 1, 500)) && Array.isArray(value.cutoutHeights) && value.cutoutHeights.length === value.includedShapeIds.length && value.cutoutHeights.every((size) => finite(size, 1, 500)) && value.labelSet === "english"
        ? base as unknown as GeometryStencilMathToolMetadata : null;
    case "cartesian-plane":
      return value.calibration === "logical-units" && value.configurationVersion === 1 && finite(value.xMin, -100, 100) && finite(value.xMax, -100, 100) && value.xMax > value.xMin && finite(value.yMin, -100, 100) && finite(value.yMax, -100, 100) && value.yMax > value.yMin && finite(value.majorStep, 0.01, 100) && Number.isInteger(value.minorDivisions) && finite(value.minorDivisions, 1, 10) && typeof value.showGrid === "boolean" && typeof value.showAxes === "boolean" && typeof value.showNumbers === "boolean" && typeof value.showQuadrantLabels === "boolean" && typeof value.xLabel === "string" && value.xLabel.length <= 12 && typeof value.yLabel === "string" && value.yLabel.length <= 12 && finite(value.scenePointsPerUnit, 4, 100)
        ? base as unknown as CartesianPlaneMathToolMetadata : null;
    case "number-line":
      return value.calibration === "logical-units" && value.configurationVersion === 1 && finite(value.minimum, -1_000, 1_000) && finite(value.maximum, -1_000, 1_000) && value.maximum > value.minimum && finite(value.majorStep, 0.01, 1_000) && Number.isInteger(value.minorDivisions) && finite(value.minorDivisions, 1, 10) && ["decimal", "fraction", "integer"].includes(String(value.labelFormat)) && ["both", "left", "none", "right"].includes(String(value.arrowMode)) && typeof value.axisLabel === "string" && value.axisLabel.length <= 24 && finite(value.scenePointsPerUnit, 2, 200)
        ? base as unknown as NumberLineMathToolMetadata : null;
    case "unit-circle":
      return value.calibration === "logical-units" && value.specialAngleSetVersion === 1 && ["both", "degrees", "radians"].includes(String(value.labelMode)) && typeof value.showCoordinates === "boolean" && finite(value.radiusScenePoints, 50, 1_000)
        ? base as unknown as UnitCircleMathToolMetadata : null;
    case "grid":
      return (value.calibration === "logical-units" || value.calibration === "pdf-points") && ["dot", "isometric", "polar", "square"].includes(String(value.variant)) && Number.isInteger(value.rows) && finite(value.rows, 0, 100) && Number.isInteger(value.columns) && finite(value.columns, 0, 100) && Number.isInteger(value.rings) && finite(value.rings, 0, 50) && Number.isInteger(value.rays) && finite(value.rays, 0, 72) && Number.isInteger(value.majorInterval) && finite(value.majorInterval, 1, 20) && finite(value.spacing, 2, 144) && (value.sceneUnitsPerInch === undefined || value.sceneUnitsPerInch === 72)
        ? base as unknown as GridMathToolMetadata : null;
  }
}
