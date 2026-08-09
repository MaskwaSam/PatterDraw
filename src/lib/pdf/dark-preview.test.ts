import { createCanvas, DOMMatrix, ImageData, Path2D, loadImage } from "@napi-rs/canvas";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { GlobalWorkerOptions as GlobalWorkerOptionsType } from "pdfjs-dist";
import type { OPS as OPSType } from "pdfjs-dist";
import type { getDocument as getDocumentType } from "pdfjs-dist";
import type3RgbFixtureUrl from "../../../tests/fixtures/pdf/type3-rgb-image.pdf?inline";
import tilingRgbFixtureUrl from "../../../tests/fixtures/pdf/tiling-rgb-image.pdf?inline";
import imageMaskFixtureUrl from "../../../tests/fixtures/pdf/image-mask.pdf?inline";
import tilingVectorGroupFixtureUrl from "../../../tests/fixtures/pdf/tiling-vector-group.pdf?inline";

const { getDocumentMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
}));

// The production module uses the browser build so Vite can bundle PDF.js' web
// worker. Reuse PDF.js' Node canvas backend in this unit test; the renderer and
// operator-list behavior are the same, while @napi-rs/canvas gives us pixels in
// Vitest's jsdom environment.
vi.mock("pdfjs-dist", async () => {
  const legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
  getDocumentMock.mockImplementation(legacy.getDocument);
  return {
    GlobalWorkerOptions: legacy.GlobalWorkerOptions,
    OPS: legacy.OPS,
    getDocument: getDocumentMock,
  } as {
    GlobalWorkerOptions: typeof GlobalWorkerOptionsType;
    OPS: typeof OPSType;
    getDocument: typeof getDocumentType;
  };
});

import {
  DARK_PDF_CANVAS_FILTER,
  assertDarkPdfRasterSize,
  assertDarkPdfEncodedOutputBudget,
  fitPdfRasterDimensions,
  getPdfRasterDimensions,
  renderDarkPdfPreview,
} from "./dark-preview";

interface Pixel {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

interface PixelContext {
  getImageData(x: number, y: number, width: number, height: number): ImageData;
}

function pixelAt(context: PixelContext, x: number, y: number): Pixel {
  const data = context.getImageData(x, y, 1, 1).data;
  return { red: data[0], green: data[1], blue: data[2], alpha: data[3] };
}

async function fixtureBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

function pngHeaderDataUrl(width: number, height: number): string {
  const header = new Uint8Array(24);
  header.set([137, 80, 78, 71, 13, 10, 26, 10]);
  header.set([0, 0, 0, 13], 8);
  header.set([73, 72, 68, 82], 12);
  const view = new DataView(header.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return `data:image/png;base64,${btoa(String.fromCharCode(...header))}`;
}

async function decodeSvgPng(dataUrl: string) {
  const svg = atob(dataUrl.slice("data:image/svg+xml;base64,".length));
  const pngDataUrl = /href="(data:image\/png;base64,[^"]+)"/.exec(svg)?.[1];
  if (!pngDataUrl) throw new Error("The dark preview did not contain a PNG payload.");
  const image = await loadImage(pngDataUrl);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { canvas, context };
}

const originalCreateElement = window.document.createElement.bind(window.document);

beforeAll(async () => {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  // Keep the worker path dynamic: pdfjs-dist ships the module but does not
  // publish a declaration for this Node-only test entry point.
  const workerModulePath = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  const worker = await import(workerModulePath);
  Object.assign(globalThis, { pdfjsWorker: worker });
  vi.spyOn(window.document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName.toLowerCase() === "canvas") return createCanvas(1, 1) as unknown as HTMLElement;
    return originalCreateElement(tagName, options);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("dark PDF preview nested image operations", () => {
  it("rejects oversized dimensions before allocating a dark-preview canvas", async () => {
    expect(() => assertDarkPdfRasterSize(100_000, 1)).toThrow(/too large to render safely/i);
    await expect(getPdfRasterDimensions(pngHeaderDataUrl(100_000, 1)))
      .resolves.toEqual({ width: 100_000, height: 1 });
    await expect(renderDarkPdfPreview({
      bytes: new Uint8Array(),
      pageIndex: 0,
      width: 100_000,
      height: 1,
    })).rejects.toThrow(/too large to render safely/i);
  });

  it("normalizes the PNG data-url prefix without decoding the full payload", async () => {
    const normalized = pngHeaderDataUrl(37, 19)
      .replace("data:image/png;base64,", "  DATA:IMAGE/PNG;BASE64,")
      .concat(" \n\t");
    await expect(getPdfRasterDimensions(normalized)).resolves.toEqual({
      width: 37,
      height: 19,
    });
  });

  it("bounds nested SVG output from the selected raster budget before btoa", () => {
    const boundedBudget = {
      maxEdge: 256,
      maxPixelsPerPage: 128,
      maxPixelsPerDocument: 128,
    } as const;
    const tinyPngDataUrl = "data:image/png;base64,AAAA";
    expect(() => assertDarkPdfEncodedOutputBudget(
      tinyPngDataUrl,
      32,
      32,
      boundedBudget,
    )).not.toThrow();

    // This is only a short synthetic base64 string; no image is decoded or
    // allocated. Its PNG bytes fit the budget, but the nested SVG/base64
    // representation does not, so the guard must fire before construction.
    const oversizedPngDataUrl = `data:image/png;base64,${"A".repeat(512)}`;
    expect(() => assertDarkPdfEncodedOutputBudget(
      oversizedPngDataUrl,
      32,
      32,
      boundedBudget,
    )).toThrow(/output is too large to retain safely/i);
  });

  it("fits a high-resolution source into a low-memory budget before rendering", () => {
    const lowMemoryBudget = {
      maxEdge: 4_096,
      maxPixelsPerPage: 4_000_000,
      maxPixelsPerDocument: 16_000_000,
    } as const;
    const fitted = fitPdfRasterDimensions(
      { width: 5_000, height: 3_000 },
      lowMemoryBudget,
    );
    expect(fitted.width).toBe(2_581);
    expect(fitted.height).toBe(1_549);
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(4_000_000);
    expect(fitPdfRasterDimensions(
      { width: 5_000, height: 3_000 },
      lowMemoryBudget,
      256,
    )).toEqual({ width: 256, height: 153 });
    expect(fitPdfRasterDimensions(
      { width: 4, height: 4 },
      { maxEdge: 4, maxPixelsPerPage: 7, maxPixelsPerDocument: 7 },
    )).toEqual({ width: 2, height: 2 });
    expect(fitPdfRasterDimensions(
      { width: 4, height: 4 },
      { maxEdge: 4, maxPixelsPerPage: 16, maxPixelsPerDocument: 5 },
    )).toEqual({ width: 2, height: 2 });
  });

  it("honours an already-aborted dark-preview request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderDarkPdfPreview({
      bytes: new Uint8Array(),
      pageIndex: 0,
      width: 1,
      height: 1,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("passes conservative embedded-image and worker-canvas limits to PDF.js", async () => {
    const bytes = await fixtureBytes(type3RgbFixtureUrl);
    await renderDarkPdfPreview({
      bytes,
      pageIndex: 0,
      width: 320,
      height: 240,
      rasterBudget: {
        maxEdge: 1_000,
        maxPixelsPerPage: 2_000_000,
        maxPixelsPerDocument: 3_000_000,
      },
    });
    const options = getDocumentMock.mock.calls.at(-1)?.[0] as {
      enableScripting?: boolean;
      isEvalSupported?: boolean;
      maxImageSize?: number;
      canvasMaxAreaInBytes?: number;
    } | undefined;
    expect(options).toEqual(expect.objectContaining({
      enableScripting: false,
      isEvalSupported: false,
      maxImageSize: 1_000_000,
      canvasMaxAreaInBytes: 4_000_000,
    }));
  });

  it("caps the cumulative working pixels across output and PDF.js scratch canvases", async () => {
    const bytes = await fixtureBytes(type3RgbFixtureUrl);
    await expect(renderDarkPdfPreview({
      bytes,
      pageIndex: 0,
      width: 320,
      height: 240,
      rasterBudget: {
        maxEdge: 1_000,
        maxPixelsPerPage: 100_000,
        maxPixelsPerDocument: 100_000,
      },
    })).rejects.toThrow(/too much working memory/i);
  });

  it("keeps an RGB image inside a Type3 glyph natural while darkening vectors", async () => {
    const bytes = await fixtureBytes(type3RgbFixtureUrl);
    const preview = await renderDarkPdfPreview({ bytes, pageIndex: 0, width: 320, height: 240 });
    const rendered = await decodeSvgPng(preview);

    // Reapply the editor's canvas filter to model the final on-screen result.
    // The preview raster itself is pre-compensated so this is the meaningful
    // pixel-level assertion for a dark-themed Excalidraw canvas.
    const finalCanvas = createCanvas(320, 240);
    const finalContext = finalCanvas.getContext("2d");
    finalContext.filter = DARK_PDF_CANVAS_FILTER;
    finalContext.drawImage(rendered.canvas, 0, 0);
    finalContext.filter = "none";

    // The Type3 glyph is painted at page coordinates x=34..54, y=46..66;
    // PDF.js' viewport flips the y-axis, and the fixture is rendered at 2x.
    const imagePixel = pixelAt(finalContext, 80, 112);
    expect(imagePixel.red).toBeCloseTo(180, -1);
    expect(imagePixel.green).toBeCloseTo(80, -1);
    expect(imagePixel.blue).toBeCloseTo(80, -1);

    // The ordinary red vector marker is intentionally darkened.
    const vectorPixel = pixelAt(finalContext, 20, 198);
    expect(vectorPixel.red).toBeGreaterThan(240);
    expect(vectorPixel.green).toBeGreaterThan(120);
    expect(vectorPixel.blue).toBeGreaterThan(120);
  });

  it("keeps an RGB image inside a tiling pattern natural", async () => {
    const bytes = await fixtureBytes(tilingRgbFixtureUrl);
    const preview = await renderDarkPdfPreview({ bytes, pageIndex: 0, width: 320, height: 240 });
    const rendered = await decodeSvgPng(preview);
    const finalCanvas = createCanvas(320, 240);
    const finalContext = finalCanvas.getContext("2d");
    finalContext.filter = DARK_PDF_CANVAS_FILTER;
    finalContext.drawImage(rendered.canvas, 0, 0);
    finalContext.filter = "none";
    // The first tile's red RGB quadrant is rendered at x=0..40 and
    // y=160..200 in the 2x viewport (the page's y-axis is flipped).
    const imagePixel = pixelAt(finalContext, 20, 160);
    expect(imagePixel.red).toBeGreaterThan(150);
    expect(imagePixel.green).toBeLessThan(110);
    expect(imagePixel.blue).toBeLessThan(110);
  });

  it("still darkens the fill colour of an image mask", async () => {
    const bytes = await fixtureBytes(imageMaskFixtureUrl);
    const preview = await renderDarkPdfPreview({ bytes, pageIndex: 0, width: 240, height: 200 });
    const rendered = await decodeSvgPng(preview);
    const finalCanvas = createCanvas(240, 200);
    const finalContext = finalCanvas.getContext("2d");
    finalContext.filter = DARK_PDF_CANVAS_FILTER;
    finalContext.drawImage(rendered.canvas, 0, 0);
    finalContext.filter = "none";
    // The stencil covers x=40..200 and y=20..180 at 2x viewport scale.
    const maskPixel = pixelAt(finalContext, 100, 100);
    expect(maskPixel.red).toBeGreaterThan(240);
    expect(maskPixel.green).toBeGreaterThan(120);
    expect(maskPixel.blue).toBeGreaterThan(120);
  });

  it("does not dark-filter a nested vector group twice when it becomes a pattern", async () => {
    const bytes = await fixtureBytes(tilingVectorGroupFixtureUrl);
    const preview = await renderDarkPdfPreview({ bytes, pageIndex: 0, width: 320, height: 240 });
    const rendered = await decodeSvgPng(preview);
    const finalCanvas = createCanvas(320, 240);
    const finalContext = finalCanvas.getContext("2d");
    finalContext.filter = DARK_PDF_CANVAS_FILTER;
    finalContext.drawImage(rendered.canvas, 0, 0);
    finalContext.filter = "none";

    const vectorPixel = pixelAt(finalContext, 20, 20);
    expect(vectorPixel.red).toBeCloseTo(217, -1);
    expect(vectorPixel.green).toBeCloseTo(131, -1);
    expect(vectorPixel.blue).toBeCloseTo(131, -1);
  });
});
