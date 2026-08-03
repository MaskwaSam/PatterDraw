import PptxGenJS from "pptxgenjs";
import { exportToCanvas } from "@excalidraw/excalidraw";
import type { ClassroomProject, ClassroomSlide } from "../types";
import { getSlideRenderData, type SlideRenderData } from "./slide-render";
import {
  getSlidePdfExportDimensions,
} from "./pdf/export-pdf";
import {
  getBrowserPdfRasterBudget,
  getPdfExportRasterBudget,
  pdfRasterCanvasToPngBytes,
  releasePdfRasterCanvas,
  type PdfRasterBudget,
} from "./pdf/raster-limits";
import { bytesForBlob } from "./blob-bytes";

export type PptxDeckFormat = "16:9" | "4:3";

export const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const MAX_PPTX_RASTER_EDGE = 4_096;
export const MAX_PPTX_RASTER_PIXELS_PER_SLIDE = 8_000_000;
export const MAX_PPTX_RASTER_PIXELS_PER_DECK = 32_000_000;
export const MAX_PPTX_PNG_BYTES_PER_SLIDE = 12 * 1_024 * 1_024;
export const MAX_PPTX_PNG_BYTES_PER_DECK = 48 * 1_024 * 1_024;
export const MAX_PPTX_SLIDES = 500;

export interface PptxDeckDimensions {
  width: number;
  height: number;
}

export interface PptxContainPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolves the single aspect ratio used by an image-snapshot deck. Freeform
 * and legacy projects use widescreen because a PPTX presentation has one
 * global page size and the current PatterDraw default is 16:9.
 */
export function resolvePptxDeckFormat(project: ClassroomProject): PptxDeckFormat {
  if (!project || typeof project !== "object") throw new Error("Project must be an object.");
  return project.slideFrameAspectRatio === "4:3" ? "4:3" : "16:9";
}

export function getPptxDeckDimensions(format: PptxDeckFormat): PptxDeckDimensions {
  if (format === "4:3") return { width: 10, height: 7.5 };
  if (format === "16:9") return { width: 10, height: 5.625 };
  throw new Error("PPTX deck format must be 16:9 or 4:3.");
}

/**
 * Returns the letterboxed placement for a source image in a PPTX slide.
 * Dimensions are in the same units as the target slide (PptxGenJS uses
 * inches). The image is never stretched and the remaining slide is left
 * white by the caller.
 */
export function getPptxContainPlacement(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): PptxContainPlacement {
  if (
    !Number.isFinite(sourceWidth)
    || !Number.isFinite(sourceHeight)
    || !Number.isFinite(targetWidth)
    || !Number.isFinite(targetHeight)
    || sourceWidth <= 0
    || sourceHeight <= 0
    || targetWidth <= 0
    || targetHeight <= 0
  ) {
    throw new Error("PPTX image and slide dimensions must be positive finite numbers.");
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

/** Alias retained as a descriptive name for callers that build slide images. */
export const getPptxImagePlacement = getPptxContainPlacement;

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("PPTX image encoding requires a browser base64 encoder.");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function pngBytesToDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

function isSlideRecord(value: unknown): value is ClassroomSlide {
  if (!value || typeof value !== "object") return false;
  const slide = value as Partial<ClassroomSlide>;
  return typeof slide.id === "string"
    && slide.id.length > 0
    && typeof slide.sceneId === "string"
    && slide.sceneId.length > 0
    && typeof slide.frameId === "string"
    && slide.frameId.length > 0
    && typeof slide.title === "string";
}

interface OrderedSlideRender {
  slide: ClassroomSlide;
  renderData: SlideRenderData;
}

function orderedSlideRenders(project: ClassroomProject): OrderedSlideRender[] {
  if (!project || typeof project !== "object") throw new Error("Project must be an object.");
  if (!Array.isArray(project.slideOrder)) throw new Error("Slide order must be a list.");
  if (!project.slideOrder.length) throw new Error("Add at least one frame slide before exporting.");
  if (project.slideOrder.length > MAX_PPTX_SLIDES) {
    throw new Error(`PowerPoint export supports up to ${MAX_PPTX_SLIDES} slides at a time.`);
  }

  const slideIds = new Set<string>();
  const frameRefs = new Set<string>();
  for (const candidate of project.slideOrder) {
    if (!isSlideRecord(candidate)) throw new Error("A slide record is malformed.");
    if (slideIds.has(candidate.id)) {
      throw new Error("Slide order contains a duplicate slide identity.");
    }
    const frameRef = JSON.stringify([candidate.sceneId, candidate.frameId]);
    if (frameRefs.has(frameRef)) {
      throw new Error("Slide order contains a duplicate frame.");
    }
    slideIds.add(candidate.id);
    frameRefs.add(frameRef);
  }

  const ordered: OrderedSlideRender[] = [];
  for (const candidate of project.slideOrder) {
    const scene = project.scenes?.[candidate.sceneId];
    if (!scene) {
      throw new Error(`Slide "${candidate.title}" references a missing scene. Remove or repair that slide before exporting.`);
    }
    const renderData = getSlideRenderData(scene, candidate.frameId);
    if (!renderData) {
      throw new Error(`Slide "${candidate.title}" references a missing frame. Remove or repair that slide before exporting.`);
    }
    ordered.push({ slide: candidate, renderData });
  }
  return ordered;
}

function asPptxBlob(value: unknown): Promise<Blob> {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return Promise.resolve(new Blob([value], { type: PPTX_MIME_TYPE }));
  }
  if (value instanceof ArrayBuffer) {
    return Promise.resolve(new Blob([value], { type: PPTX_MIME_TYPE }));
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
    return Promise.resolve(new Blob([bytesForBlob(bytes)], { type: PPTX_MIME_TYPE }));
  }
  throw new Error("PPTX export did not produce a browser Blob.");
}

export interface PptxEncodedByteBudget {
  maxBytesPerSlide: number;
  maxBytesPerDeck: number;
}

export interface PptxExportOptions {
  rasterBudget?: Readonly<PdfRasterBudget>;
  /** Tests and constrained hosts may lower, but never raise, the built-in limits. */
  encodedByteBudget?: Readonly<PptxEncodedByteBudget>;
}

const DEFAULT_PPTX_ENCODED_BYTE_BUDGET: Readonly<PptxEncodedByteBudget> = Object.freeze({
  maxBytesPerSlide: MAX_PPTX_PNG_BYTES_PER_SLIDE,
  maxBytesPerDeck: MAX_PPTX_PNG_BYTES_PER_DECK,
});

function getPptxRasterBudget(
  browserBudget: Readonly<PdfRasterBudget>,
): Readonly<PdfRasterBudget> {
  return {
    maxEdge: Math.min(browserBudget.maxEdge, MAX_PPTX_RASTER_EDGE),
    maxPixelsPerPage: Math.min(
      browserBudget.maxPixelsPerPage,
      MAX_PPTX_RASTER_PIXELS_PER_SLIDE,
    ),
    maxPixelsPerDocument: Math.min(
      browserBudget.maxPixelsPerDocument,
      MAX_PPTX_RASTER_PIXELS_PER_DECK,
    ),
  };
}

function validateEncodedByteBudget(
  budget: Readonly<PptxEncodedByteBudget>,
): void {
  if (
    !Number.isSafeInteger(budget.maxBytesPerSlide)
    || budget.maxBytesPerSlide <= 0
    || !Number.isSafeInteger(budget.maxBytesPerDeck)
    || budget.maxBytesPerDeck <= 0
    || budget.maxBytesPerSlide > budget.maxBytesPerDeck
  ) {
    throw new Error("PPTX encoded-image limits must be positive safe integers within the deck limit.");
  }
}

/**
 * Exports the ordered PatterDraw frame slides as a visual-snapshot PPTX.
 * Each PowerPoint slide contains one local PNG, preserving all Excalidraw
 * rendering details while keeping the operation entirely offline and local.
 */
export async function exportSlidesPptx(
  project: ClassroomProject,
  format: PptxDeckFormat = resolvePptxDeckFormat(project),
  options: PptxExportOptions = {},
): Promise<Blob> {
  const ordered = orderedSlideRenders(project);
  const deck = getPptxDeckDimensions(format);
  const rasterBudget = getPdfExportRasterBudget(
    getPptxRasterBudget(options.rasterBudget ?? getBrowserPdfRasterBudget()),
    ordered.length,
  );
  const requestedEncodedByteBudget = options.encodedByteBudget ?? DEFAULT_PPTX_ENCODED_BYTE_BUDGET;
  validateEncodedByteBudget(requestedEncodedByteBudget);
  const encodedByteBudget: Readonly<PptxEncodedByteBudget> = {
    maxBytesPerSlide: Math.min(
      requestedEncodedByteBudget.maxBytesPerSlide,
      DEFAULT_PPTX_ENCODED_BYTE_BUDGET.maxBytesPerSlide,
    ),
    maxBytesPerDeck: Math.min(
      requestedEncodedByteBudget.maxBytesPerDeck,
      DEFAULT_PPTX_ENCODED_BYTE_BUDGET.maxBytesPerDeck,
    ),
  };
  let encodedPngBytes = 0;

  const pptx = new PptxGenJS();
  pptx.layout = format === "4:3" ? "LAYOUT_4x3" : "LAYOUT_16x9";
  pptx.title = project.title || "PatterDraw slides";
  pptx.subject = "PatterDraw visual-snapshot slide deck";
  pptx.author = "PatterDraw";
  pptx.company = "PatterDraw";
  pptx.revision = "1";

  for (const { slide: classroomSlide, renderData } of ordered) {
    const dimensions = getSlidePdfExportDimensions(
      renderData.frame.width,
      renderData.frame.height,
      rasterBudget,
    );
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await exportToCanvas({
        elements: renderData.elements,
        files: renderData.files,
        exportingFrame: renderData.frame,
        appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
        exportPadding: 0,
        getDimensions: () => dimensions,
      });
      if (!canvas) throw new Error("Slide rasterization failed.");
      const pngBytes = await pdfRasterCanvasToPngBytes(canvas);
      if (pngBytes.byteLength > encodedByteBudget.maxBytesPerSlide) {
        throw new Error(
          "A slide image is too complex to export to PowerPoint safely. Reduce large photos or split the content across slides.",
        );
      }
      encodedPngBytes += pngBytes.byteLength;
      if (encodedPngBytes > encodedByteBudget.maxBytesPerDeck) {
        throw new Error(
          "This deck is too large to export to PowerPoint safely. Export fewer slides at a time or reduce large photos.",
        );
      }
      const imageData = pngBytesToDataUrl(pngBytes);
      const placement = getPptxContainPlacement(
        renderData.frame.width,
        renderData.frame.height,
        deck.width,
        deck.height,
      );
      const pptxSlide = pptx.addSlide();
      pptxSlide.background = { color: "FFFFFF" };
      pptxSlide.addImage({
        data: imageData,
        x: placement.x,
        y: placement.y,
        w: placement.width,
        h: placement.height,
        altText: classroomSlide.title,
      });
    } finally {
      // pdfRasterCanvasToPngBytes releases on successful and failed encoding;
      // this outer guard also handles mocked/alternate encoders and failures
      // before the helper is reached.
      if (canvas) releasePdfRasterCanvas(canvas);
    }
  }

  const output = await pptx.write({ outputType: "blob" });
  return asPptxBlob(output);
}
