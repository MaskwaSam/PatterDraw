import {
  PROTRACTOR_DIAMETER_INCHES,
  PROTRACTOR_MAX_ANGLE_DEGREES,
  PROTRACTOR_SMALLEST_DIVISION_DEGREES,
  createProtractorAsset,
} from "./protractor";
import {
  PDF_POINTS_PER_INCH,
  RULER_LENGTH_CENTIMETRES,
  RULER_LENGTH_INCHES,
  createDualScaleRulerAsset,
} from "./ruler";
import {
  DEFAULT_CARTESIAN_PLANE,
  DEFAULT_NUMBER_LINE,
  createCartesianPlaneAsset,
  createGeometryStencilAsset,
  createGridAsset,
  createNumberLineAsset,
  createSetSquareAsset,
  createUnitCircleAsset,
} from "./static-tools";
import {
  createAlgebraTileKit,
  createFractionKit,
  createIntegerChipKit,
  createProbabilityKit,
} from "./manipulatives";
import { DEFAULT_FUNCTION_PLOT, createFunctionPlotAsset } from "./function-plotter";
import { createAngleMeasurement, createCompassConstruction, createTransformationPreview } from "./interactive";
import type {
  ClassroomMathToolMetadata,
  GeneratedMathToolInsertion,
  MathToolAsset,
  MathToolCategory,
  MathToolConfiguration,
  MathToolKind,
  ClassroomTimeToolCardDefinition,
  ProtractorMathToolMetadata,
  RulerMathToolMetadata,
} from "./types";

export const MATH_TOOL_CATEGORIES: readonly { id: MathToolCategory; label: string }[] = [
  { id: "instruments", label: "Instruments" },
  { id: "graphs", label: "Graphs" },
  { id: "manipulatives", label: "Manipulatives" },
  { id: "classroom", label: "Classroom" },
];

export const CLASSROOM_TIME_TOOL_CARDS: readonly ClassroomTimeToolCardDefinition[] = Object.freeze([
  {
    id: "classroom-clock",
    kind: "clock",
    category: "classroom",
    title: "Clock",
    description: "Live digital or analog classroom clock",
    detail: "Show the time, date, weekday, seconds, and timezone on the board.",
    preview: "clock",
  },
  {
    id: "classroom-timer",
    kind: "timer",
    category: "classroom",
    title: "Timer",
    description: "Custom countdown with a local alarm",
    detail: "Set a duration, progress style, colours, tone, and repeat behaviour.",
    preview: "timer",
  },
  {
    id: "classroom-pomodoro",
    kind: "pomodoro",
    category: "classroom",
    title: "Pomodoro",
    description: "Focus and break cycles for class work",
    detail: "Use classic 25/5/15 timing or customize every phase and cycle.",
    preview: "pomodoro",
  },
  {
    id: "classroom-calendar",
    kind: "calendar",
    category: "classroom",
    title: "Class Calendar",
    description: "Project and device-local classroom events",
    detail: "Show a month, week, or agenda view with colour-coded class events.",
    preview: "calendar",
  },
  {
    id: "classroom-dashboard",
    kind: "dashboard",
    category: "classroom",
    title: "Dashboard",
    description: "Clock, timers, and calendar in one widget",
    detail: "Choose the panels your class needs and customize them together.",
    preview: "dashboard",
  },
]);

interface MathToolDefinitionCore {
  id: string;
  kind: MathToolKind;
  category: MathToolCategory;
  title: string;
  description: string;
  detail: string;
  calibrationNotice?: string;
  configurable: boolean;
  interaction?: MathInteractionKind;
  defaultConfiguration: MathToolConfiguration;
  generate: (configuration: MathToolConfiguration) => GeneratedMathToolInsertion;
}

export interface MathToolDefinition extends MathToolDefinitionCore {
  availabilityState: "available";
  configurationSchema: {
    kind: MathToolConfiguration["kind"];
    fields: readonly string[];
  };
  insertionStrategy: "batch" | "interaction" | "single";
  previewFactory: () => MathToolAsset;
}

export type MathInteractionKind = "angle-measurement" | "compass" | "transformation";

function completeMetadata<T extends ClassroomMathToolMetadata>(
  asset: MathToolAsset,
  metadata: Omit<T, "category" | "kind" | "naturalHeight" | "naturalWidth" | "schemaVersion">,
  kind: T["kind"],
  category: T["category"],
): T {
  return {
    schemaVersion: 1,
    kind,
    category,
    naturalWidth: asset.width,
    naturalHeight: asset.height,
    ...metadata,
  } as T;
}

function requireKind<K extends MathToolConfiguration["kind"]>(configuration: MathToolConfiguration, kind: K): Extract<MathToolConfiguration, { kind: K }> {
  if (configuration.kind !== kind) throw new Error(`Expected ${kind} math-tool configuration.`);
  return configuration as Extract<MathToolConfiguration, { kind: K }>;
}

const RAW_MATH_TOOL_CATALOGUE: readonly MathToolDefinitionCore[] = [
  {
    id: "ruler",
    kind: "ruler",
    category: "instruments",
    title: "Ruler",
    description: "12 inches / 30 centimetres",
    detail: "Dual-scale ruler for calibrated PDF measurement.",
    calibrationNotice: "Inserted at 72 points per inch. Resizing changes the measurement scale.",
    configurable: false,
    defaultConfiguration: { kind: "ruler" },
    generate(configuration) {
      requireKind(configuration, "ruler");
      const asset = createDualScaleRulerAsset();
      return {
        asset: { ...asset, svg: asset.svg },
        metadata: completeMetadata<RulerMathToolMetadata>(asset, {
          calibration: "pdf-points",
          sceneUnitsPerInch: PDF_POINTS_PER_INCH,
          imperialLengthInches: RULER_LENGTH_INCHES,
          metricLengthCentimetres: RULER_LENGTH_CENTIMETRES,
        }, "ruler", "instruments"),
        toastMessage: "Calibrated ruler added.",
      };
    },
  },
  {
    id: "protractor",
    kind: "protractor",
    category: "instruments",
    title: "Protractor",
    description: "6 inches / 180 degrees",
    detail: "Dual-scale semicircular protractor with one-degree divisions.",
    calibrationNotice: "Inserted at 72 points per inch. Resizing changes the measurement scale.",
    configurable: false,
    defaultConfiguration: { kind: "protractor" },
    generate(configuration) {
      requireKind(configuration, "protractor");
      const asset = createProtractorAsset();
      return {
        asset: { ...asset, svg: asset.svg },
        metadata: completeMetadata<ProtractorMathToolMetadata>(asset, {
          calibration: "pdf-points",
          sceneUnitsPerInch: PDF_POINTS_PER_INCH,
          diameterInches: PROTRACTOR_DIAMETER_INCHES,
          angleRangeDegrees: PROTRACTOR_MAX_ANGLE_DEGREES,
          smallestDivisionDegrees: PROTRACTOR_SMALLEST_DIVISION_DEGREES,
          dualScale: true,
        }, "protractor", "instruments"),
        toastMessage: "Calibrated protractor added.",
      };
    },
  },
  {
    id: "set-square",
    kind: "set-square",
    category: "instruments",
    title: "Set square",
    description: "45° or 30°/60° calibrated triangle",
    detail: "Transparent edge-scaled triangle for geometric constructions.",
    calibrationNotice: "Inserted at 72 points per inch. Resizing changes the measurement scale.",
    configurable: true,
    defaultConfiguration: { kind: "set-square", variant: "45-45-90" },
    generate(configuration) {
      const config = requireKind(configuration, "set-square");
      const generated = createSetSquareAsset(config.variant);
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "set-square", "instruments"), toastMessage: `${config.variant} set square added.` };
    },
  },
  {
    id: "compass",
    kind: "compass",
    category: "instruments",
    title: "Compass",
    description: "Construct a circle or arc from two points",
    detail: "Choose the centre and radius directly on the live board.",
    configurable: false,
    interaction: "compass",
    defaultConfiguration: { kind: "compass", fullCircle: true, arcExtentDegrees: 180, direction: "clockwise", centerMark: true },
    generate(configuration) {
      const config = requireKind(configuration, "compass");
      return createCompassConstruction({ x: 0, y: 0 }, { x: 120, y: 0 }, config);
    },
  },
  {
    id: "angle-measurer",
    kind: "angle-measurement",
    category: "instruments",
    title: "Angle measurer",
    description: "Measure interior or reflex angles",
    detail: "Place a vertex and two ray points, then commit a local annotation.",
    configurable: false,
    interaction: "angle-measurement",
    defaultConfiguration: { kind: "angle-measurement", reflex: false, precision: 1 },
    generate(configuration) {
      const config = requireKind(configuration, "angle-measurement");
      return createAngleMeasurement({ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 0, y: -120 }, config);
    },
  },
  {
    id: "geometry-stencil",
    kind: "geometry-stencil",
    category: "instruments",
    title: "Geometry stencil",
    description: "Nine common shape cut-outs",
    detail: "Calibrated transparent stencil for tracing plane figures.",
    calibrationNotice: "Inserted at 72 points per inch. Resizing changes the measurement scale.",
    configurable: false,
    defaultConfiguration: { kind: "geometry-stencil" },
    generate(configuration) {
      requireKind(configuration, "geometry-stencil");
      const generated = createGeometryStencilAsset();
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "geometry-stencil", "instruments"), toastMessage: "Geometry stencil added." };
    },
  },
  {
    id: "cartesian-plane",
    kind: "cartesian-plane",
    category: "graphs",
    title: "Cartesian plane",
    description: "Configurable coordinate grid",
    detail: "Choose ranges, spacing, labels, axes, and grid visibility.",
    configurable: true,
    defaultConfiguration: { kind: "cartesian-plane", ...DEFAULT_CARTESIAN_PLANE },
    generate(configuration) {
      const config = requireKind(configuration, "cartesian-plane");
      const generated = createCartesianPlaneAsset(config);
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "cartesian-plane", "graphs"), toastMessage: "Cartesian plane added." };
    },
  },
  {
    id: "number-line",
    kind: "number-line",
    category: "graphs",
    title: "Number line",
    description: "Integers, decimals, or fractions",
    detail: "Configure the range, intervals, labels, and endpoint arrows.",
    configurable: true,
    defaultConfiguration: { kind: "number-line", ...DEFAULT_NUMBER_LINE },
    generate(configuration) {
      const config = requireKind(configuration, "number-line");
      const generated = createNumberLineAsset(config);
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "number-line", "graphs"), toastMessage: "Number line added." };
    },
  },
  {
    id: "unit-circle",
    kind: "unit-circle",
    category: "graphs",
    title: "Unit circle",
    description: "Special angles and exact coordinates",
    detail: "Degrees, radians, and optional exact coordinate labels.",
    configurable: true,
    defaultConfiguration: { kind: "unit-circle", labelMode: "both", showCoordinates: true },
    generate(configuration) {
      const config = requireKind(configuration, "unit-circle");
      const generated = createUnitCircleAsset(config.labelMode, config.showCoordinates);
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "unit-circle", "graphs"), toastMessage: "Unit circle added." };
    },
  },
  {
    id: "function-plotter",
    kind: "function-plot",
    category: "graphs",
    title: "Function plotter",
    description: "Safe local y = f(x) plots",
    detail: "Validate, preview, and insert an explicit function without eval or remote graphing.",
    configurable: true,
    defaultConfiguration: { kind: "function-plot", ...DEFAULT_FUNCTION_PLOT },
    generate(configuration) {
      const config = requireKind(configuration, "function-plot");
      const generated = createFunctionPlotAsset(config);
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "function-plot", "graphs"), toastMessage: "Function plot added." };
    },
  },
  {
    id: "grid",
    kind: "grid",
    category: "graphs",
    title: "Grid pack",
    description: "Square, isometric, dot, or polar",
    detail: "Insert a movable construction grid that can be locked behind work.",
    configurable: true,
    defaultConfiguration: { kind: "grid", variant: "square" },
    generate(configuration) {
      const config = requireKind(configuration, "grid");
      const generated = createGridAsset(config.variant);
      return { asset: generated.asset, metadata: completeMetadata(generated.asset, generated.metadata, "grid", "graphs"), toastMessage: `${config.variant[0].toUpperCase()}${config.variant.slice(1)} grid added.` };
    },
  },
  {
    id: "transformation-tool",
    kind: "transformation",
    category: "graphs",
    title: "Transformation tool",
    description: "Translate, rotate, reflect, or dilate",
    detail: "Select supported objects first, then preview settings and commit transformed copies.",
    configurable: false,
    interaction: "transformation",
    defaultConfiguration: { kind: "transformation", transformationType: "translate", translateX: 100, translateY: 0, angleDegrees: 90, scaleFactor: 2, mirrorLineAngleDegrees: 45 },
    generate(configuration) {
      const config = requireKind(configuration, "transformation");
      return createTransformationPreview(config);
    },
  },
  {
    id: "fraction-kit",
    kind: "fraction-piece",
    category: "manipulatives",
    title: "Fraction kit",
    description: "Bars or circles through eighths",
    detail: "Insert one whole and independently movable unit-fraction pieces.",
    configurable: true,
    defaultConfiguration: { kind: "fraction-piece", representation: "bar", maximumDenominator: 6 },
    generate(configuration) {
      const config = requireKind(configuration, "fraction-piece");
      return createFractionKit(config.representation, config.maximumDenominator);
    },
  },
  {
    id: "algebra-tiles",
    kind: "algebra-tile",
    category: "manipulatives",
    title: "Algebra tiles",
    description: "Positive and negative 1, x, and x² tiles",
    detail: "Build and rearrange bounded polynomial models piece by piece.",
    configurable: true,
    defaultConfiguration: { kind: "algebra-tile", positiveUnits: 3, negativeUnits: 2, positiveX: 2, negativeX: 1, positiveXSquared: 1, negativeXSquared: 1 },
    generate(configuration) {
      const config = requireKind(configuration, "algebra-tile");
      return createAlgebraTileKit(config);
    },
  },
  {
    id: "integer-chips",
    kind: "integer-chip",
    category: "manipulatives",
    title: "Integer chips",
    description: "Positive and negative chips",
    detail: "Model signed operations and form zero pairs with independent pieces.",
    configurable: true,
    defaultConfiguration: { kind: "integer-chip", positiveCount: 5, negativeCount: 5 },
    generate(configuration) {
      const config = requireKind(configuration, "integer-chip");
      return createIntegerChipKit(config.positiveCount, config.negativeCount);
    },
  },
  {
    id: "probability-kit",
    kind: "probability-piece",
    category: "manipulatives",
    title: "Probability kit",
    description: "Dice, coins, spinner, and number cards",
    detail: "Static sample-space pieces for probability tasks; no simulated randomness.",
    configurable: true,
    defaultConfiguration: { kind: "probability-piece", includeDice: true, includeCoins: true, includeSpinner: true, includeCards: false },
    generate(configuration) {
      const config = requireKind(configuration, "probability-piece");
      return createProbabilityKit(config);
    },
  },
];

const BATCH_MATH_TOOL_KINDS = new Set<MathToolKind>(["algebra-tile", "fraction-piece", "integer-chip", "probability-piece"]);

function completeDefinition(definition: MathToolDefinitionCore): MathToolDefinition {
  return {
    ...definition,
    availabilityState: "available",
    configurationSchema: {
      kind: definition.defaultConfiguration.kind,
      fields: Object.freeze(Object.keys(definition.defaultConfiguration).filter((field) => field !== "kind")),
    },
    insertionStrategy: definition.interaction
      ? "interaction"
      : BATCH_MATH_TOOL_KINDS.has(definition.kind) ? "batch" : "single",
    previewFactory: () => {
      const generated = definition.generate(definition.defaultConfiguration);
      const asset = "pieces" in generated ? generated.pieces[0]?.asset : generated.asset;
      if (!asset) throw new Error(`Math tool ${definition.id} did not generate a preview.`);
      return asset;
    },
  };
}

export const MATH_TOOL_CATALOGUE: readonly MathToolDefinition[] = Object.freeze(
  RAW_MATH_TOOL_CATALOGUE.map(completeDefinition),
);

const definitionById = new Map<string, MathToolDefinition>();
const definitionByKind = new Map<MathToolKind, MathToolDefinition>();
for (const definition of MATH_TOOL_CATALOGUE) {
  if (definitionById.has(definition.id) || definitionByKind.has(definition.kind)) {
    throw new Error(`Duplicate math-tool catalogue definition: ${definition.id}.`);
  }
  if (!MATH_TOOL_CATEGORIES.some((category) => category.id === definition.category)) {
    throw new Error(`Unknown math-tool category: ${definition.category}.`);
  }
  definitionById.set(definition.id, definition);
  definitionByKind.set(definition.kind, definition);
}

const previewCache = new Map<string, MathToolAsset>();

export function mathToolsForCategory(category: MathToolCategory): readonly MathToolDefinition[] {
  return MATH_TOOL_CATALOGUE.filter((definition) => definition.category === category);
}

export function mathToolPreview(definition: MathToolDefinition): MathToolAsset {
  const cached = previewCache.get(definition.id);
  if (cached) return cached;
  const asset = definition.previewFactory();
  previewCache.set(definition.id, asset);
  return asset;
}
