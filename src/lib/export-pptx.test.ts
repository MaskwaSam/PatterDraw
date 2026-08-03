import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassroomProject } from "../types";

const mocks = vi.hoisted(() => {
  class MockSlide {
    background: unknown;
    images: unknown[] = [];

    addImage(options: unknown): this {
      this.images.push(options);
      return this;
    }
  }

  class MockPptxGenJS {
    static instances: MockPptxGenJS[] = [];

    layout = "";
    title = "";
    subject = "";
    author = "";
    company = "";
    revision = "";
    slides: MockSlide[] = [];
    output: unknown = new Uint8Array([80, 75, 3, 4]);

    constructor() {
      MockPptxGenJS.instances.push(this);
    }

    addSlide(): MockSlide {
      const slide = new MockSlide();
      this.slides.push(slide);
      return slide;
    }

    write = vi.fn(async () => this.output);
  }

  return {
    MockPptxGenJS,
    exportToCanvas: vi.fn(),
    getSlideRenderData: vi.fn(),
    getSlidePdfExportDimensions: vi.fn(),
    getBrowserPdfRasterBudget: vi.fn(),
    getPdfExportRasterBudget: vi.fn(),
    pdfRasterCanvasToPngBytes: vi.fn(),
    releasePdfRasterCanvas: vi.fn(),
  };
});

vi.mock("pptxgenjs", () => ({ default: mocks.MockPptxGenJS }));
vi.mock("@excalidraw/excalidraw", () => ({ exportToCanvas: mocks.exportToCanvas }));
vi.mock("./slide-render", () => ({ getSlideRenderData: mocks.getSlideRenderData }));
vi.mock("./pdf/export-pdf", () => ({
  getSlidePdfExportDimensions: mocks.getSlidePdfExportDimensions,
}));
vi.mock("./pdf/raster-limits", () => ({
  getBrowserPdfRasterBudget: mocks.getBrowserPdfRasterBudget,
  getPdfExportRasterBudget: mocks.getPdfExportRasterBudget,
  pdfRasterCanvasToPngBytes: mocks.pdfRasterCanvasToPngBytes,
  releasePdfRasterCanvas: mocks.releasePdfRasterCanvas,
}));

import {
  exportSlidesPptx,
  getPptxContainPlacement,
  getPptxDeckDimensions,
  MAX_PPTX_PNG_BYTES_PER_DECK,
  MAX_PPTX_PNG_BYTES_PER_SLIDE,
  MAX_PPTX_RASTER_EDGE,
  MAX_PPTX_RASTER_PIXELS_PER_DECK,
  MAX_PPTX_RASTER_PIXELS_PER_SLIDE,
  MAX_PPTX_SLIDES,
  resolvePptxDeckFormat,
  PPTX_MIME_TYPE,
} from "./export-pptx";

function frame(width: number, height: number, id: string) {
  return { id, width, height } as never;
}

function projectWithSlides(
  slides: Array<{ id: string; sceneId: string; frameId: string; title: string }>,
): ClassroomProject {
  return {
    schemaVersion: 1,
    id: "project-id",
    title: "Geometry lesson",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activeSceneId: "scene-a",
    scenes: {
      "scene-a": {
        id: "scene-a",
        name: "Board",
        elements: [],
        appState: {},
        files: {},
      },
    },
    slideOrder: slides,
    pdfDocuments: {},
  };
}

function configureRenderData(
  dimensions: Record<string, { width: number; height: number } | null>,
): void {
  mocks.getSlideRenderData.mockImplementation((_scene, frameId: string) => {
    const value = dimensions[frameId];
    if (!value) return null;
    return {
      frame: frame(value.width, value.height, frameId),
      elements: [],
      files: {},
    };
  });
}

beforeEach(() => {
  mocks.MockPptxGenJS.instances.length = 0;
  mocks.exportToCanvas.mockReset();
  mocks.getSlideRenderData.mockReset();
  mocks.getSlidePdfExportDimensions.mockReset();
  mocks.getBrowserPdfRasterBudget.mockReset();
  mocks.getPdfExportRasterBudget.mockReset();
  mocks.pdfRasterCanvasToPngBytes.mockReset();
  mocks.releasePdfRasterCanvas.mockReset();

  mocks.getBrowserPdfRasterBudget.mockReturnValue({
    maxEdge: 8192,
    maxPixelsPerPage: 16_000_000,
    maxPixelsPerDocument: 64_000_000,
  });
  mocks.getPdfExportRasterBudget.mockImplementation((budget) => budget);
  mocks.getSlidePdfExportDimensions.mockImplementation((width: number, height: number) => ({
    width: Math.round(width),
    height: Math.round(height),
    scale: 1,
  }));
  mocks.exportToCanvas.mockImplementation(async ({ exportingFrame }: { exportingFrame: { id: string } }) => ({
    width: 40,
    height: 30,
    id: exportingFrame.id,
  }));
  mocks.pdfRasterCanvasToPngBytes.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  mocks.releasePdfRasterCanvas.mockImplementation((canvas: { width: number; height: number }) => {
    canvas.width = 0;
    canvas.height = 0;
  });
});

describe("PPTX deck policy and contain geometry", () => {
  it("resolves 4:3 explicitly and defaults freeform/legacy projects to 16:9", () => {
    expect(resolvePptxDeckFormat({ slideFrameAspectRatio: "4:3" } as ClassroomProject)).toBe("4:3");
    expect(resolvePptxDeckFormat({ slideFrameAspectRatio: "freeform" } as ClassroomProject)).toBe("16:9");
    expect(resolvePptxDeckFormat({} as ClassroomProject)).toBe("16:9");
    expect(getPptxDeckDimensions("16:9")).toEqual({ width: 10, height: 5.625 });
    expect(getPptxDeckDimensions("4:3")).toEqual({ width: 10, height: 7.5 });
    expect(() => getPptxDeckDimensions("bad" as never)).toThrow(/format/i);
  });

  it("letterboxes without distorting a portrait image in a widescreen deck", () => {
    expect(getPptxContainPlacement(600, 800, 10, 5.625)).toEqual({
      x: 2.890625,
      y: 0,
      width: 4.21875,
      height: 5.625,
    });
    expect(getPptxContainPlacement(1600, 900, 10, 5.625)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 5.625,
    });
    expect(() => getPptxContainPlacement(0, 1, 10, 10)).toThrow(/dimensions/i);
  });
});

describe("exportSlidesPptx", () => {
  it("rejects an empty slide order", async () => {
    await expect(exportSlidesPptx(projectWithSlides([]))).rejects.toThrow(/at least one frame slide/i);
    expect(mocks.MockPptxGenJS.instances).toHaveLength(0);
  });

  it("rejects an excessive slide count before resolving or rasterizing frames", async () => {
    const slides = Array.from({ length: MAX_PPTX_SLIDES + 1 }, (_, index) => ({
      id: `slide-${index}`,
      sceneId: "scene-a",
      frameId: `frame-${index}`,
      title: `Slide ${index + 1}`,
    }));
    await expect(exportSlidesPptx(projectWithSlides(slides))).rejects.toThrow(
      new RegExp(`up to ${MAX_PPTX_SLIDES} slides`, "i"),
    );
    expect(mocks.getSlideRenderData).not.toHaveBeenCalled();
    expect(mocks.MockPptxGenJS.instances).toHaveLength(0);
  });

  it("rejects malformed slide records before rasterizing", async () => {
    const project = projectWithSlides([
      { id: "", sceneId: "scene-a", frameId: "frame", title: "Malformed" },
    ]);
    await expect(exportSlidesPptx(project)).rejects.toThrow(/slide record is malformed/i);
    expect(mocks.exportToCanvas).not.toHaveBeenCalled();
  });

  it("rejects duplicate slide identities or frame references", async () => {
    const duplicateIdentity = projectWithSlides([
      { id: "same", sceneId: "scene-a", frameId: "wide", title: "One" },
      { id: "same", sceneId: "scene-a", frameId: "portrait", title: "Two" },
    ]);
    await expect(exportSlidesPptx(duplicateIdentity)).rejects.toThrow(/duplicate slide identity/i);

    const duplicateFrame = projectWithSlides([
      { id: "one", sceneId: "scene-a", frameId: "wide", title: "One" },
      { id: "two", sceneId: "scene-a", frameId: "wide", title: "Two" },
    ]);
    await expect(exportSlidesPptx(duplicateFrame)).rejects.toThrow(/duplicate frame/i);
    expect(mocks.exportToCanvas).not.toHaveBeenCalled();
  });

  it("rejects missing scenes before rasterizing a partial deck", async () => {
    const project = projectWithSlides([
      { id: "missing-scene", sceneId: "nope", frameId: "missing", title: "Missing scene" },
    ]);
    await expect(exportSlidesPptx(project)).rejects.toThrow(/Missing scene.*missing scene/i);
    expect(mocks.exportToCanvas).not.toHaveBeenCalled();
  });

  it("rejects stale frames instead of silently exporting fewer slides", async () => {
    const project = projectWithSlides([
      { id: "first", sceneId: "scene-a", frameId: "wide", title: "First" },
      { id: "stale", sceneId: "scene-a", frameId: "gone", title: "Removed" },
      { id: "last", sceneId: "scene-a", frameId: "portrait", title: "Last" },
    ]);
    configureRenderData({
      wide: { width: 1600, height: 900 },
      gone: null,
      portrait: { width: 600, height: 800 },
    });
    await expect(exportSlidesPptx(project)).rejects.toThrow(/Removed.*missing frame/i);
    expect(mocks.exportToCanvas).not.toHaveBeenCalled();
    expect(mocks.MockPptxGenJS.instances).toHaveLength(0);
  });

  it("renders valid slides in explicit order with titles, placement, white background, and metadata", async () => {
    const project = projectWithSlides([
      { id: "slide-b", sceneId: "scene-a", frameId: "portrait", title: "Second" },
      { id: "slide-a", sceneId: "scene-a", frameId: "wide", title: "First" },
    ]);
    configureRenderData({
      portrait: { width: 600, height: 800 },
      wide: { width: 1600, height: 900 },
    });

    const output = await exportSlidesPptx(project);
    expect(output).toBeInstanceOf(Blob);
    expect(output.type).toBe(PPTX_MIME_TYPE);
    expect(mocks.getPdfExportRasterBudget).toHaveBeenCalledWith({
      maxEdge: MAX_PPTX_RASTER_EDGE,
      maxPixelsPerPage: MAX_PPTX_RASTER_PIXELS_PER_SLIDE,
      maxPixelsPerDocument: MAX_PPTX_RASTER_PIXELS_PER_DECK,
    }, 2);
    expect(mocks.exportToCanvas.mock.calls.map(([options]) => options.exportingFrame.id)).toEqual([
      "portrait",
      "wide",
    ]);

    const pptx = mocks.MockPptxGenJS.instances[0];
    expect(pptx.layout).toBe("LAYOUT_16x9");
    expect(pptx.title).toBe("Geometry lesson");
    expect(pptx.subject).toMatch(/visual-snapshot/i);
    expect(pptx.author).toBe("PatterDraw");
    expect(pptx.company).toBe("PatterDraw");
    expect(pptx.slides).toHaveLength(2);
    expect(pptx.slides.map((slide) => slide.background)).toEqual([
      { color: "FFFFFF" },
      { color: "FFFFFF" },
    ]);
    expect(pptx.slides[0].images[0]).toMatchObject({
      altText: "Second",
      x: 2.890625,
      y: 0,
      w: 4.21875,
      h: 5.625,
    });
    expect(pptx.slides[1].images[0]).toMatchObject({
      altText: "First",
      x: 0,
      y: 0,
      w: 10,
      h: 5.625,
      data: "data:image/png;base64,iVBORw==",
    });
    expect(mocks.releasePdfRasterCanvas).toHaveBeenCalledTimes(2);
  });

  it("uses the project 4:3 default when no explicit format is supplied", async () => {
    const project = projectWithSlides([
      { id: "slide-a", sceneId: "scene-a", frameId: "wide", title: "Title" },
    ]);
    project.slideFrameAspectRatio = "4:3";
    configureRenderData({ wide: { width: 1600, height: 900 } });
    await exportSlidesPptx(project);
    expect(mocks.MockPptxGenJS.instances[0].layout).toBe("LAYOUT_4x3");
    expect(mocks.MockPptxGenJS.instances[0].slides[0].images[0]).toMatchObject({
      x: 0,
      y: 0.9375,
      w: 10,
      h: 5.625,
    });
  });

  it("rejects invalid frame dimensions and encoder/output errors while releasing canvases", async () => {
    const project = projectWithSlides([
      { id: "slide-a", sceneId: "scene-a", frameId: "bad", title: "Bad" },
    ]);
    configureRenderData({ bad: { width: -1, height: 100 } });
    mocks.getSlidePdfExportDimensions.mockImplementation(() => {
      throw new Error("invalid raster dimensions");
    });
    await expect(exportSlidesPptx(project)).rejects.toThrow(/invalid raster dimensions/i);
    expect(mocks.exportToCanvas).not.toHaveBeenCalled();

    configureRenderData({ bad: { width: 100, height: 100 } });
    mocks.getSlidePdfExportDimensions.mockImplementation((width: number, height: number) => ({
      width: Math.round(width),
      height: Math.round(height),
      scale: 1,
    }));
    mocks.exportToCanvas.mockRejectedValueOnce(new Error("canvas failed"));
    await expect(exportSlidesPptx(project)).rejects.toThrow(/canvas failed/i);

    configureRenderData({ bad: { width: 100, height: 100 } });
    mocks.pdfRasterCanvasToPngBytes.mockRejectedValueOnce(new Error("PNG failed"));
    await expect(exportSlidesPptx(project)).rejects.toThrow(/PNG failed/i);
    expect(mocks.releasePdfRasterCanvas).toHaveBeenCalled();

    configureRenderData({ bad: { width: 100, height: 100 } });
    await exportSlidesPptx(project);
    const invalidOutput = exportSlidesPptx(project);
    mocks.MockPptxGenJS.instances.at(-1)!.output = "not-a-blob";
    await expect(invalidOutput).rejects.toThrow(/browser Blob/i);
  });

  it("normalizes a typed-array writer result to the PPTX Blob MIME type", async () => {
    const project = projectWithSlides([
      { id: "slide-a", sceneId: "scene-a", frameId: "wide", title: "Title" },
    ]);
    configureRenderData({ wide: { width: 1600, height: 900 } });
    const instanceOutput = new Uint8Array([1, 2, 3]);
    const exportPromise = exportSlidesPptx(project);
    mocks.MockPptxGenJS.instances.at(-1)!.output = instanceOutput;
    const output = await exportPromise;
    expect(output.type).toBe(PPTX_MIME_TYPE);
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(instanceOutput);
  });

  it("rejects unsafe encoded slide and deck sizes before retaining base64 images", async () => {
    const oneSlide = projectWithSlides([
      { id: "slide-a", sceneId: "scene-a", frameId: "wide", title: "Title" },
    ]);
    configureRenderData({ wide: { width: 1600, height: 900 } });
    mocks.pdfRasterCanvasToPngBytes.mockResolvedValueOnce(new Uint8Array(5));
    await expect(exportSlidesPptx(oneSlide, "16:9", {
      encodedByteBudget: { maxBytesPerSlide: 4, maxBytesPerDeck: 8 },
    })).rejects.toThrow(/slide image is too complex/i);
    expect(mocks.MockPptxGenJS.instances.at(-1)!.slides).toHaveLength(0);

    const twoSlides = projectWithSlides([
      { id: "slide-a", sceneId: "scene-a", frameId: "wide", title: "One" },
      { id: "slide-b", sceneId: "scene-a", frameId: "portrait", title: "Two" },
    ]);
    configureRenderData({
      wide: { width: 1600, height: 900 },
      portrait: { width: 600, height: 800 },
    });
    mocks.pdfRasterCanvasToPngBytes
      .mockResolvedValueOnce(new Uint8Array(3))
      .mockResolvedValueOnce(new Uint8Array(3));
    await expect(exportSlidesPptx(twoSlides, "16:9", {
      encodedByteBudget: { maxBytesPerSlide: 4, maxBytesPerDeck: 5 },
    })).rejects.toThrow(/deck is too large/i);
    expect(mocks.MockPptxGenJS.instances.at(-1)!.slides).toHaveLength(1);

    expect(MAX_PPTX_PNG_BYTES_PER_SLIDE).toBeLessThan(MAX_PPTX_PNG_BYTES_PER_DECK);
    expect(MAX_PPTX_PNG_BYTES_PER_DECK).toBeLessThanOrEqual(48 * 1_024 * 1_024);
  });

  it("rejects invalid encoded-image budgets before rasterizing", async () => {
    const project = projectWithSlides([
      { id: "slide-a", sceneId: "scene-a", frameId: "wide", title: "Title" },
    ]);
    configureRenderData({ wide: { width: 1600, height: 900 } });
    await expect(exportSlidesPptx(project, "16:9", {
      encodedByteBudget: { maxBytesPerSlide: 10, maxBytesPerDeck: 5 },
    })).rejects.toThrow(/encoded-image limits/i);
    expect(mocks.exportToCanvas).not.toHaveBeenCalled();
  });
});
