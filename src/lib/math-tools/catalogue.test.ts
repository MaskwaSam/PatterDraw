import { describe, expect, it } from "vitest";
import { CLASSROOM_TIME_TOOL_CARDS, MATH_TOOL_CATALOGUE, MATH_TOOL_CATEGORIES, mathToolPreview, mathToolsForCategory } from "./catalogue";
import {
  DEFAULT_CARTESIAN_PLANE,
  DEFAULT_NUMBER_LINE,
  GEOMETRY_STENCIL_SHAPES,
  createCartesianPlaneAsset,
  createGeometryStencilAsset,
  createGridAsset,
  createNumberLineAsset,
  createSetSquareAsset,
  createUnitCircleAsset,
  validateCartesianPlaneConfiguration,
  validateNumberLineConfiguration,
} from "./static-tools";
import { sanitizeClassroomMathToolMetadata } from "./types";

function svgDocument(svg: string): XMLDocument {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

describe("math tool catalogue", () => {
  it("contains unique typed definitions in stable complete categories", () => {
    expect(MATH_TOOL_CATEGORIES.map((category) => category.id)).toEqual(["instruments", "graphs", "manipulatives", "classroom"]);
    expect(new Set(MATH_TOOL_CATALOGUE.map((tool) => tool.id)).size).toBe(MATH_TOOL_CATALOGUE.length);
    expect(new Set(MATH_TOOL_CATALOGUE.map((tool) => tool.kind)).size).toBe(MATH_TOOL_CATALOGUE.length);
    expect(MATH_TOOL_CATALOGUE.every((tool) => tool.availabilityState === "available")).toBe(true);
    expect(MATH_TOOL_CATALOGUE.every((tool) => tool.configurationSchema.kind === tool.kind)).toBe(true);
    expect(MATH_TOOL_CATALOGUE.find((tool) => tool.kind === "ruler")?.insertionStrategy).toBe("single");
    expect(MATH_TOOL_CATALOGUE.find((tool) => tool.kind === "fraction-piece")?.insertionStrategy).toBe("batch");
    expect(MATH_TOOL_CATALOGUE.find((tool) => tool.kind === "compass")?.insertionStrategy).toBe("interaction");
    expect(mathToolsForCategory("instruments").map((tool) => tool.kind)).toEqual(["ruler", "protractor", "set-square", "compass", "angle-measurement", "geometry-stencil"]);
    expect(mathToolsForCategory("graphs").map((tool) => tool.kind)).toEqual(["cartesian-plane", "number-line", "unit-circle", "function-plot", "grid", "transformation"]);
    expect(mathToolsForCategory("manipulatives").map((tool) => tool.kind)).toEqual(["fraction-piece", "algebra-tile", "integer-chip", "probability-piece"]);
    expect(mathToolsForCategory("classroom")).toEqual([]);
    expect(CLASSROOM_TIME_TOOL_CARDS.map((tool) => tool.kind)).toEqual(["clock", "timer", "pomodoro", "calendar", "dashboard"]);
    expect(new Set(CLASSROOM_TIME_TOOL_CARDS.map((tool) => tool.id)).size).toBe(CLASSROOM_TIME_TOOL_CARDS.length);
    expect(CLASSROOM_TIME_TOOL_CARDS.every((tool) => tool.category === "classroom")).toBe(true);
  });

  it("generates a safe local preview and valid metadata for every definition", () => {
    for (const definition of MATH_TOOL_CATALOGUE) {
      const preview = mathToolPreview(definition);
      const generated = definition.generate(definition.defaultConfiguration);
      const metadata = "pieces" in generated ? generated.pieces.map((piece) => piece.metadata) : [generated.metadata];
      expect(preview.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(preview.width).toBeGreaterThan(0);
      expect(preview.height).toBeGreaterThan(0);
      expect(metadata.length).toBeGreaterThan(0);
      for (const item of metadata) {
        expect(item.kind).toBe(definition.kind);
        expect(item.category).toBe(definition.category);
        expect(sanitizeClassroomMathToolMetadata(item)).toEqual(item);
      }
    }
  });

  it("normalizes legacy baseline metadata and rejects malformed metadata", () => {
    const generated = MATH_TOOL_CATALOGUE.find((tool) => tool.kind === "ruler")!.generate({ kind: "ruler" });
    if ("pieces" in generated) throw new Error("Ruler must be a single tool.");
    const ruler = generated.metadata;
    const { category: _category, ...legacy } = ruler;
    expect(sanitizeClassroomMathToolMetadata(legacy)?.category).toBe("instruments");
    expect(sanitizeClassroomMathToolMetadata({ ...ruler, kind: "unknown" })).toBeNull();
    expect(sanitizeClassroomMathToolMetadata({ ...ruler, naturalWidth: Number.NaN })).toBeNull();
    expect(sanitizeClassroomMathToolMetadata({ ...ruler, sceneUnitsPerInch: 96 })).toBeNull();
    expect(sanitizeClassroomMathToolMetadata({ ...ruler, category: "graphs" })).toBeNull();
    expect(sanitizeClassroomMathToolMetadata({ ...ruler, unexpectedRemoteField: "https://example.com" })).toBeNull();
  });
});

describe("static math tools", () => {
  it("creates both calibrated set-square geometries", () => {
    const square45 = createSetSquareAsset("45-45-90");
    const square30 = createSetSquareAsset("30-60-90");
    expect(square45.asset.width).toBe(7 * 72);
    expect(square45.asset.height).toBe(7 * 72);
    expect(square30.asset.width / square30.asset.height).toBeCloseTo(Math.sqrt(3), 10);
    expect(square45.metadata.markedAngles).toEqual([45, 45, 90]);
    expect(square30.metadata.markedAngles).toEqual([30, 60, 90]);
    expect(svgDocument(square30.asset.svg).querySelector('[data-angle="60"]')?.textContent).toBe("60°");
    expect(svgDocument(square30.asset.svg).querySelector('[data-angle="30"]')?.textContent).toBe("30°");
    expect(svgDocument(square45.asset.svg).querySelectorAll("[data-edge-tick]")).toHaveLength(29);
  });

  it("creates a calibrated stencil with the required cut-outs", () => {
    const stencil = createGeometryStencilAsset();
    expect(stencil.asset.width).toBe(720);
    expect(stencil.asset.height).toBe(432);
    expect(stencil.metadata.includedShapeIds).toEqual([...GEOMETRY_STENCIL_SHAPES]);
    const ids = new Set(Array.from(svgDocument(stencil.asset.svg).querySelectorAll("[data-shape-id]"), (element) => element.getAttribute("data-shape-id")));
    expect(ids).toEqual(new Set(GEOMETRY_STENCIL_SHAPES));
    expect(stencil.metadata.cutoutWidths).toHaveLength(GEOMETRY_STENCIL_SHAPES.length);
    expect(stencil.metadata.cutoutHeights).toHaveLength(GEOMETRY_STENCIL_SHAPES.length);
  });

  it("builds equal-scale Cartesian planes and rejects unsafe ranges", () => {
    const plane = createCartesianPlaneAsset(DEFAULT_CARTESIAN_PLANE);
    expect(plane.asset.width).toBe(plane.asset.height);
    expect(plane.metadata.scenePointsPerUnit).toBeGreaterThanOrEqual(4);
    const document = svgDocument(plane.asset.svg);
    expect(document.querySelectorAll('[data-axis="x"], [data-axis="y"]')).toHaveLength(2);
    expect(document.querySelectorAll("[data-axis-arrow]")).toHaveLength(4);
    expect(document.querySelector('[data-number-axis="x"][data-value="-10"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-quadrant-label]")).toHaveLength(4);
    expect(() => validateCartesianPlaneConfiguration({ ...DEFAULT_CARTESIAN_PLANE, xMin: 4, xMax: 4 })).toThrow(/minimum/);
    expect(() => validateCartesianPlaneConfiguration({ ...DEFAULT_CARTESIAN_PLANE, xMin: -100, xMax: 100 })).toThrow(/40 units/);
    expect(() => validateCartesianPlaneConfiguration({ ...DEFAULT_CARTESIAN_PLANE, majorStep: 0 })).toThrow(/greater than zero/);
  });

  it("formats bounded number lines as integers, decimals, and fractions", () => {
    const integer = createNumberLineAsset(DEFAULT_NUMBER_LINE);
    const fraction = createNumberLineAsset({ ...DEFAULT_NUMBER_LINE, minimum: -1, maximum: 1, majorStep: 0.5, labelFormat: "fraction" });
    const offsetDecimal = createNumberLineAsset({ ...DEFAULT_NUMBER_LINE, minimum: 0.25, maximum: 1.25, majorStep: 0.5, minorDivisions: 2, labelFormat: "decimal" });
    expect(svgDocument(integer.asset.svg).querySelectorAll("[data-label-value]")).toHaveLength(21);
    expect(fraction.asset.svg).toContain(">-1/2<");
    expect(fraction.asset.svg).toContain(">1/2<");
    const offsetDocument = svgDocument(offsetDecimal.asset.svg);
    expect(offsetDocument.querySelector('[data-tick-value="0.25"]')).not.toBeNull();
    expect(offsetDocument.querySelector('[data-tick-value="1.25"]')).not.toBeNull();
    expect(offsetDocument.querySelectorAll("[data-label-value]")).toHaveLength(3);
    expect(() => validateNumberLineConfiguration({ ...DEFAULT_NUMBER_LINE, minimum: 5, maximum: 1 })).toThrow(/minimum/);
    expect(() => validateNumberLineConfiguration({ ...DEFAULT_NUMBER_LINE, majorStep: 0 })).toThrow(/greater than zero/);
    expect(() => validateNumberLineConfiguration({ ...DEFAULT_NUMBER_LINE, majorStep: 0.5 })).toThrow(/Integer labels/);
  });

  it("places every standard unit-circle angle and exact coordinate", () => {
    const circle = createUnitCircleAsset("both", true);
    const document = svgDocument(circle.asset.svg);
    expect(document.querySelectorAll("[data-angle-label]")).toHaveLength(16);
    expect(document.querySelectorAll("[data-coordinate-label]")).toHaveLength(16);
    expect(circle.asset.svg).toContain("11π/6");
    expect(circle.asset.svg).toContain("(-√2/2, -√2/2)");
    for (const mode of ["degrees", "radians", "both"] as const) {
      const variant = createUnitCircleAsset(mode, false);
      expect(variant.metadata.labelMode).toBe(mode);
      expect(svgDocument(variant.asset.svg).querySelectorAll("[data-angle-label]")).toHaveLength(16);
      expect(svgDocument(variant.asset.svg).querySelectorAll("[data-coordinate-label]")).toHaveLength(0);
    }
  });

  it("embeds sanitized MathJax geometry for stacked unit-circle notation", () => {
    const degrees = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
    const rendered = {
      aspectRatio: 2,
      body: '<g data-mml-node="mfrac"><path d="M0 0L20 10"/></g>',
      viewBox: "0 0 20 10",
    };
    const circle = createUnitCircleAsset("radians", true, {
      angles: new Map(degrees.map((degree) => [degree, rendered])),
      coordinates: new Map(degrees.map((degree) => [degree, rendered])),
    });
    const document = svgDocument(circle.asset.svg);

    expect(document.querySelector('[data-part="labels"]')?.getAttribute("data-label-renderer")).toBe("mathjax");
    expect(document.querySelectorAll('svg[data-angle-label][data-label-renderer="mathjax"]')).toHaveLength(16);
    expect(document.querySelectorAll('svg[data-coordinate-label][data-label-renderer="mathjax"]')).toHaveLength(16);
    expect(document.querySelectorAll("use,[href]")).toHaveLength(0);
    expect(circle.asset.svg).not.toContain("11π/6");
  });

  it("creates bounded square, isometric, dot, and polar grids", () => {
    const square = svgDocument(createGridAsset("square").asset.svg);
    const isometric = svgDocument(createGridAsset("isometric").asset.svg);
    const dot = svgDocument(createGridAsset("dot").asset.svg);
    const polar = svgDocument(createGridAsset("polar").asset.svg);
    expect(square.querySelectorAll("[data-grid-column]")).toHaveLength(25);
    expect(square.querySelectorAll("[data-grid-row]")).toHaveLength(17);
    expect(isometric.querySelectorAll('[data-grid-slope="60"]')).not.toHaveLength(0);
    expect(dot.querySelectorAll("[data-grid-dot]")).toHaveLength(425);
    expect(square.querySelectorAll('[data-major="true"]')).not.toHaveLength(0);
    expect(isometric.querySelectorAll('[data-major="true"]')).not.toHaveLength(0);
    expect(dot.querySelectorAll('[data-major="true"]')).not.toHaveLength(0);
    expect(polar.querySelectorAll("[data-grid-ring]")).toHaveLength(8);
    expect(polar.querySelectorAll("[data-grid-ray]")).toHaveLength(24);
    expect(polar.querySelectorAll('[data-major="true"]')).not.toHaveLength(0);
  });
});
