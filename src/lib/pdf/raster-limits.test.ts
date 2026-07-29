import { describe, expect, it } from "vitest";
import {
  MAX_PDF_RASTER_EDGE,
  MAX_PDF_RASTER_PIXELS_PER_DOCUMENT,
  MAX_PDF_RASTER_PIXELS_PER_PAGE,
  getPdfImportRasterScale,
} from "./raster-limits";

describe("PDF import raster limits", () => {
  it("keeps the preferred high-resolution scale for an ordinary worksheet", () => {
    expect(getPdfImportRasterScale([{ width: 612, height: 792 }], 2)).toBe(3);
  });

  it("caps every edge, page bitmap, and aggregate document bitmap", () => {
    const pages = Array.from({ length: 250 }, () => ({ width: 612, height: 792 }));
    const scale = getPdfImportRasterScale(pages, 2);
    const width = Math.ceil(612 * scale);
    const height = Math.ceil(792 * scale);
    expect(width).toBeLessThanOrEqual(MAX_PDF_RASTER_EDGE);
    expect(height).toBeLessThanOrEqual(MAX_PDF_RASTER_EDGE);
    expect(width * height).toBeLessThanOrEqual(MAX_PDF_RASTER_PIXELS_PER_PAGE);
    expect(width * height * pages.length).toBeLessThanOrEqual(
      MAX_PDF_RASTER_PIXELS_PER_DOCUMENT + pages.length * (width + height + 1),
    );
    expect(scale).toBeLessThan(1);
  });

  it("rejects malformed or oversized source page geometry", () => {
    expect(() => getPdfImportRasterScale([{ width: Number.POSITIVE_INFINITY, height: 792 }]))
      .toThrow(/unsupported dimensions/);
    expect(() => getPdfImportRasterScale([{ width: 14_401, height: 792 }]))
      .toThrow(/unsupported dimensions/);
  });
});
