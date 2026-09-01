import { describe, expect, it } from "vitest";
import {
  MAX_SHARED_PDF_ZOOM,
  MIN_SHARED_PDF_ZOOM,
  centeredPdfViewport,
  normalizeSharedPdfZoom,
} from "./shared-viewport";

describe("shared PDF viewport", () => {
  it("clamps invalid and out-of-range zoom values", () => {
    expect(normalizeSharedPdfZoom(Number.NaN)).toBe(1);
    expect(normalizeSharedPdfZoom(0.01)).toBe(MIN_SHARED_PDF_ZOOM);
    expect(normalizeSharedPdfZoom(45)).toBe(MAX_SHARED_PDF_ZOOM);
    expect(normalizeSharedPdfZoom(1.75)).toBe(1.75);
  });

  it("centers differently sized pages without changing the shared zoom", () => {
    const portrait = centeredPdfViewport(
      { x: 100, y: 200, width: 600, height: 800 },
      1200,
      900,
      1.5,
    );
    const landscape = centeredPdfViewport(
      { x: -50, y: 25, width: 900, height: 500 },
      1200,
      900,
      portrait.zoom,
    );

    expect(portrait.zoom).toBe(1.5);
    expect(landscape.zoom).toBe(1.5);
    expect((100 + 600 / 2 + portrait.scrollX) * portrait.zoom).toBeCloseTo(600);
    expect((200 + 800 / 2 + portrait.scrollY) * portrait.zoom).toBeCloseTo(450);
    expect((-50 + 900 / 2 + landscape.scrollX) * landscape.zoom).toBeCloseTo(600);
    expect((25 + 500 / 2 + landscape.scrollY) * landscape.zoom).toBeCloseTo(450);
  });
});
