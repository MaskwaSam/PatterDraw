import { describe, expect, it } from "vitest";
import {
  createDualScaleRulerAsset,
  LETTER_HEIGHT_POINTS,
  LETTER_WIDTH_POINTS,
  PDF_POINTS_PER_CENTIMETRE,
  PDF_POINTS_PER_INCH,
  RULER_HEIGHT_POINTS,
  RULER_WIDTH_POINTS,
} from "./ruler";
import { isSafeLocalImageSource } from "../safety";

describe("dual-scale ruler", () => {
  it("uses PDF point units so its marks match a standard Letter PDF", () => {
    expect(PDF_POINTS_PER_INCH).toBe(72);
    expect(PDF_POINTS_PER_CENTIMETRE).toBeCloseTo(28.3464567, 7);
    expect(LETTER_WIDTH_POINTS).toBe(612);
    expect(LETTER_HEIGHT_POINTS).toBe(792);
    expect(RULER_WIDTH_POINTS).toBe(864);
    expect(RULER_HEIGHT_POINTS).toBe(90);
  });

  it("places the Letter-width and terminal marks at calibrated coordinates", () => {
    const { svg } = createDualScaleRulerAsset();
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const eightAndHalfInches = document.querySelector('line[data-unit="in"][data-value="8.5"]');
    const twelveInches = document.querySelector('line[data-unit="in"][data-value="12"]');
    const thirtyCentimetres = document.querySelector('line[data-unit="cm"][data-value="30"]');

    expect(document.querySelectorAll('line[data-unit="in"]')).toHaveLength(193);
    expect(document.querySelectorAll('line[data-unit="cm"]')).toHaveLength(301);
    expect(Number(eightAndHalfInches?.getAttribute("x1"))).toBe(LETTER_WIDTH_POINTS);
    expect(Number(twelveInches?.getAttribute("x1"))).toBe(RULER_WIDTH_POINTS);
    expect(Number(thirtyCentimetres?.getAttribute("x1"))).toBeCloseTo(
      30 * PDF_POINTS_PER_CENTIMETRE,
      3,
    );
  });

  it("creates a local SVG data URL without executable or linked content", () => {
    const asset = createDualScaleRulerAsset();
    expect(asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(isSafeLocalImageSource(asset.dataUrl)).toBe(true);
    expect(asset.svg).not.toMatch(/<(?:script|foreignObject|iframe)\b/i);
    expect(asset.svg).not.toMatch(/\b(?:href|src)\s*=/i);
    expect(asset.svg).toContain("CENTIMETRES");
    expect(asset.svg).toContain("INCHES");
  });
});
