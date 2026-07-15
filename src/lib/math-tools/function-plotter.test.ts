import { describe, expect, it } from "vitest";
import { DEFAULT_FUNCTION_PLOT, compileFunctionExpression, createFunctionPlotAsset, functionPlotConfigurationFromMetadata } from "./function-plotter";

describe("safe local function plotter", () => {
  it("evaluates documented arithmetic, constants, powers, and functions", () => {
    expect(compileFunctionExpression("2*x + 3").evaluator(4)).toBe(11);
    expect(compileFunctionExpression("x^2 - 4").evaluator(3)).toBe(5);
    expect(compileFunctionExpression("sin(pi/2) + cos(0)").evaluator(0)).toBeCloseTo(2, 12);
    expect(compileFunctionExpression("abs(-x) + sqrt(4) + ln(e)").evaluator(-3)).toBeCloseTo(6, 12);
    expect(compileFunctionExpression("2^3^2").evaluator(0)).toBe(512);
  });

  it.each([
    ["x = 2", /Assignments/],
    ["window.alert(1)", /Assignments/],
    ["unknown(x)", /Unknown/],
    ["sin x", /parentheses/],
    ["x +", /ended unexpectedly/],
    ["2x", /Unexpected token/],
  ])("rejects code and unsupported syntax", (source, message) => {
    expect(() => compileFunctionExpression(source)).toThrow(message);
  });

  it("plots deterministic linear, quadratic, trigonometric, and discontinuous functions", () => {
    for (const expression of ["2*x+1", "x^2-4", "sin(x)", "1/x"]) {
      const plot = createFunctionPlotAsset({ ...DEFAULT_FUNCTION_PLOT, expression });
      expect(plot.asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(plot.asset.svg).toContain('data-part="function"');
      expect(plot.metadata.expression).toBe(expression);
      expect(plot.metadata.sampleCount).toBe(401);
      expect(plot.metadata).toMatchObject({ plotStrokeColor: "#d63c54", plotStrokeWidth: 2.8 });
    }
    const rationalPath = new DOMParser().parseFromString(createFunctionPlotAsset({ ...DEFAULT_FUNCTION_PLOT, expression: "1/x" }).asset.svg, "image/svg+xml").querySelector('[data-part="function"]')?.getAttribute("d") || "";
    expect((rationalPath.match(/M /g) || []).length).toBeGreaterThan(1);
    const source = createFunctionPlotAsset({ ...DEFAULT_FUNCTION_PLOT, expression: "cos(x)", showGrid: false });
    expect(createFunctionPlotAsset(functionPlotConfigurationFromMetadata({ ...source.metadata, schemaVersion: 1, kind: "function-plot", category: "graphs", naturalWidth: source.asset.width, naturalHeight: source.asset.height })).asset.svg).toBe(source.asset.svg);
  });

  it("rejects invalid ranges and functions with no visible finite samples", () => {
    expect(() => createFunctionPlotAsset({ ...DEFAULT_FUNCTION_PLOT, xMin: 5, xMax: 5 })).toThrow(/minimum/);
    expect(() => createFunctionPlotAsset({ ...DEFAULT_FUNCTION_PLOT, xMin: -100, xMax: 100 })).toThrow(/100 units/);
    expect(() => createFunctionPlotAsset({ ...DEFAULT_FUNCTION_PLOT, expression: "sqrt(-1)" })).toThrow(/no visible/);
  });
});
