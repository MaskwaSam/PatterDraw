import { describe, expect, it } from "vitest";
import { isSafeLocalImageSource } from "../safety";
import { LETTER_WIDTH_POINTS } from "./ruler";
import {
  createProtractorAsset,
  PROTRACTOR_DIAMETER_INCHES,
  PROTRACTOR_HEIGHT_POINTS,
  PROTRACTOR_MAX_ANGLE_DEGREES,
  PROTRACTOR_RADIUS_POINTS,
  PROTRACTOR_SMALLEST_DIVISION_DEGREES,
  PROTRACTOR_WIDTH_POINTS,
} from "./protractor";

describe("semicircular protractor", () => {
  it("uses the same PDF point scale as a standard Letter page", () => {
    expect(PROTRACTOR_DIAMETER_INCHES).toBe(6);
    expect(PROTRACTOR_WIDTH_POINTS).toBe(432);
    expect(PROTRACTOR_RADIUS_POINTS).toBe(216);
    expect(PROTRACTOR_HEIGHT_POINTS).toBe(216);
    expect(PROTRACTOR_MAX_ANGLE_DEGREES).toBe(180);
    expect(PROTRACTOR_SMALLEST_DIVISION_DEGREES).toBe(1);
    expect(PROTRACTOR_WIDTH_POINTS / LETTER_WIDTH_POINTS).toBeCloseTo(12 / 17, 10);
  });

  it("draws every degree and both reading directions", () => {
    const { svg } = createProtractorAsset();
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const zero = document.querySelector('line[data-degree="0"]');
    const ninety = document.querySelector('line[data-degree="90"]');
    const oneEighty = document.querySelector('line[data-degree="180"]');
    const oneDegree = document.querySelector('line[data-degree="1"]');
    const fiveDegrees = document.querySelector('line[data-degree="5"]');
    const tenDegrees = document.querySelector('line[data-degree="10"]');
    const tickLength = (line: Element | null) => Math.hypot(
      Number(line?.getAttribute("x1")) - Number(line?.getAttribute("x2")),
      Number(line?.getAttribute("y1")) - Number(line?.getAttribute("y2")),
    );

    expect(document.querySelectorAll("line[data-degree]")).toHaveLength(181);
    expect(document.querySelectorAll('text[data-scale="clockwise"]')).toHaveLength(19);
    expect(document.querySelectorAll('text[data-scale="counterclockwise"]')).toHaveLength(19);
    expect(Number(zero?.getAttribute("x1"))).toBe(430);
    expect(Number(ninety?.getAttribute("x1"))).toBe(PROTRACTOR_RADIUS_POINTS);
    expect(Number(ninety?.getAttribute("y1"))).toBe(2);
    expect(Number(oneEighty?.getAttribute("x1"))).toBe(2);
    expect(tickLength(oneDegree)).toBeCloseTo(8, 3);
    expect(tickLength(fiveDegrees)).toBeCloseTo(14, 3);
    expect(tickLength(tenDegrees)).toBeCloseTo(22, 3);
    expect(document.querySelector('text[data-scale="clockwise"][data-angle-position="0"]')?.textContent).toBe("0");
    expect(document.querySelector('text[data-scale="counterclockwise"][data-angle-position="0"]')?.textContent).toBe("180");
    expect(document.querySelector('text[data-scale="clockwise"][data-angle-position="90"]')?.textContent).toBe("90");
    expect(document.querySelector('text[data-scale="counterclockwise"][data-angle-position="90"]')?.textContent).toBe("90");
    expect(document.querySelector('[data-part="degree-labels"]')?.getAttribute("font-size")).toBe("14");
    expect(document.querySelector('[data-part="caption"]')?.getAttribute("font-size")).toBe("14");
  });

  it("creates a local SVG data URL without executable or linked content", () => {
    const asset = createProtractorAsset();
    expect(asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(isSafeLocalImageSource(asset.dataUrl)).toBe(true);
    expect(asset.svg).not.toMatch(/<(?:script|foreignObject|iframe|object|embed|image|use|style)\b/i);
    expect(asset.svg).not.toMatch(/\b(?:href|src)\s*=/i);
    expect(asset.svg).not.toMatch(/url\s*\(/i);
    expect(asset.svg).toContain("DEGREES");
  });
});
