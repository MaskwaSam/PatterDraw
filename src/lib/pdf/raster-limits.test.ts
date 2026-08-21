import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF_RASTER_BUDGET,
  MAX_PDF_ENCODED_PNG_BYTES_PER_DOCUMENT,
  MAX_PDF_RASTER_EDGE,
  MAX_PDF_RASTER_PIXELS_PER_DOCUMENT,
  MAX_PDF_RASTER_PIXELS_PER_PAGE,
  getPdfJsRasterOptions,
  getPdfImportEncodedByteBudget,
  getPdfImportRasterScale,
  getPdfExportRasterBudget,
  getPdfExportResourceLimits,
  getPdfRasterBudget,
  getPdfRasterDeviceTier,
  pdfRasterCanvasToPngBytes,
  pdfRasterCanvasToPngDataUrl,
  releasePdfRasterCanvas,
} from "./raster-limits";

describe("PDF import raster limits", () => {
  it("derives encoded PNG limits from the remaining project-content budget", () => {
    expect(getPdfImportEncodedByteBudget(DEFAULT_PDF_RASTER_BUDGET, 1_024)).toEqual({
      maxBytesPerPage: 1_024,
      maxBytesPerDocument: 1_024,
    });
    expect(getPdfImportEncodedByteBudget(DEFAULT_PDF_RASTER_BUDGET))
      .toMatchObject({ maxBytesPerDocument: MAX_PDF_ENCODED_PNG_BYTES_PER_DOCUMENT });
    expect(() => getPdfImportEncodedByteBudget(DEFAULT_PDF_RASTER_BUDGET, -1))
      .toThrow(/encoded-image byte limit/i);
  });
  it("bounds PDF.js embedded images and worker canvases to the raster budget", () => {
    expect(getPdfJsRasterOptions(DEFAULT_PDF_RASTER_BUDGET)).toEqual({
      maxImageSize: MAX_PDF_RASTER_PIXELS_PER_PAGE,
      canvasMaxAreaInBytes: MAX_PDF_RASTER_PIXELS_PER_PAGE * 4,
    });
    expect(getPdfJsRasterOptions({
      maxEdge: 1_000,
      maxPixelsPerPage: 2_000_000,
      maxPixelsPerDocument: 3_000_000,
    })).toEqual({
      maxImageSize: 1_000_000,
      canvasMaxAreaInBytes: 4_000_000,
    });
  });

  it("keeps the preferred high-resolution scale for an ordinary worksheet", () => {
    expect(getPdfImportRasterScale([{ width: 612, height: 792 }], 2)).toBe(3);
  });

  it("keeps ordinary one-page worksheets sharp on a 4 GB device", () => {
    const budget = getPdfRasterBudget({ deviceMemory: 4, hardwareConcurrency: 4 });
    expect(getPdfImportRasterScale([{ width: 612, height: 792 }], 2, budget)).toBe(3);
  });

  it("uses progressively smaller aggregate budgets on low-memory devices", () => {
    const normal = getPdfRasterBudget({ deviceMemory: 8, hardwareConcurrency: 8 });
    const low = getPdfRasterBudget({ deviceMemory: 4, hardwareConcurrency: 4 });
    const veryLow = getPdfRasterBudget({ deviceMemory: 2, hardwareConcurrency: 2 });
    expect(normal).toEqual(DEFAULT_PDF_RASTER_BUDGET);
    expect(low).toEqual({
      maxEdge: 6_144,
      maxPixelsPerPage: 8_000_000,
      maxPixelsPerDocument: 32_000_000,
    });
    expect(veryLow).toEqual({
      maxEdge: 4_096,
      maxPixelsPerPage: 4_000_000,
      maxPixelsPerDocument: 16_000_000,
    });

    const pages = Array.from({ length: 20 }, () => ({ width: 612, height: 792 }));
    expect(getPdfImportRasterScale(pages, 2, low))
      .toBeLessThan(getPdfImportRasterScale(pages, 2, normal));
    expect(getPdfImportRasterScale(pages, 2, veryLow))
      .toBeLessThan(getPdfImportRasterScale(pages, 2, low));
  });

  it("classifies the same discrete device tiers used by the raster budgets", () => {
    expect(getPdfRasterDeviceTier({ deviceMemory: 8, hardwareConcurrency: 2 }))
      .toBe("standard");
    expect(getPdfRasterDeviceTier({ deviceMemory: 4, hardwareConcurrency: 8 }))
      .toBe("low");
    expect(getPdfRasterDeviceTier({ deviceMemory: 2, hardwareConcurrency: 8 }))
      .toBe("very-low");
    expect(getPdfRasterDeviceTier({ hardwareConcurrency: 4 })).toBe("low");
    expect(getPdfRasterDeviceTier({ hardwareConcurrency: 2 })).toBe("very-low");
    expect(getPdfRasterDeviceTier({})).toBe("standard");
  });

  it("shares the document raster budget across multi-page exports", () => {
    expect(getPdfExportRasterBudget(DEFAULT_PDF_RASTER_BUDGET, 1).maxPixelsPerPage)
      .toBe(MAX_PDF_RASTER_PIXELS_PER_PAGE);
    expect(getPdfExportRasterBudget(DEFAULT_PDF_RASTER_BUDGET, 20).maxPixelsPerPage)
      .toBe(3_200_000);
    expect(() => getPdfExportRasterBudget(DEFAULT_PDF_RASTER_BUDGET, 0))
      .toThrow(/at least one page/);
  });

  it("uses core count only when the browser does not report memory", () => {
    expect(getPdfRasterBudget({ deviceMemory: 8, hardwareConcurrency: 2 }))
      .toEqual(DEFAULT_PDF_RASTER_BUDGET);
    expect(getPdfRasterBudget({ hardwareConcurrency: 2 })).toEqual({
      maxEdge: 4_096,
      maxPixelsPerPage: 4_000_000,
      maxPixelsPerDocument: 16_000_000,
    });
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

describe("PDF raster canvas lifecycle", () => {
  it("discards a canvas backing store after data URL encoding", () => {
    const canvas = {
      width: 2_000,
      height: 3_000,
      toDataURL: () => "data:image/png;base64,AA==",
    } as unknown as HTMLCanvasElement;
    expect(pdfRasterCanvasToPngDataUrl(canvas)).toBe("data:image/png;base64,AA==");
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 0, height: 0 });
  });

  it("discards a canvas backing store before converting the PNG blob to bytes", async () => {
    const canvas = {
      width: 2_000,
      height: 3_000,
      toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([1, 2, 3])])),
    } as unknown as HTMLCanvasElement;
    const bytes = await pdfRasterCanvasToPngBytes(canvas);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 0, height: 0 });
  });

  it("discards a canvas backing store when PNG encoding fails", async () => {
    const canvas = {
      width: 2_000,
      height: 3_000,
      toBlob: (callback: BlobCallback) => callback(null),
    } as unknown as HTMLCanvasElement;
    await expect(pdfRasterCanvasToPngBytes(canvas)).rejects.toThrow(/PNG export failed/);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 0, height: 0 });
  });

  it("can explicitly release an abandoned PDF raster canvas", () => {
    const canvas = { width: 8_192, height: 4_096 };
    releasePdfRasterCanvas(canvas);
    expect(canvas).toEqual({ width: 0, height: 0 });
  });
});

describe("PDF export resource limits", () => {
  it("returns immutable defaults and accepts narrow test/device overrides", () => {
    const defaults = getPdfExportResourceLimits();
    expect(defaults.maxRasterPixels).toBe(MAX_PDF_RASTER_PIXELS_PER_DOCUMENT);
    expect(defaults.maxOutputBytes).toBeGreaterThan(defaults.maxRasterBytes);
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(getPdfExportResourceLimits({ maxHybridRuns: 7 }).maxHybridRuns).toBe(7);
  });

  it("rejects zero, fractional, and non-finite export guards", () => {
    expect(() => getPdfExportResourceLimits({ maxRasterBytes: 0 }))
      .toThrow(/maxRasterBytes limit is invalid/);
    expect(() => getPdfExportResourceLimits({ maxVectorElements: 1.5 }))
      .toThrow(/maxVectorElements limit is invalid/);
    expect(() => getPdfExportResourceLimits({ maxOutputBytes: Number.POSITIVE_INFINITY }))
      .toThrow(/maxOutputBytes limit is invalid/);
  });
});
