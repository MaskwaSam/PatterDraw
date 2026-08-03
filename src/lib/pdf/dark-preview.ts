import type { DataURL } from "@excalidraw/excalidraw/types";
import {
  GlobalWorkerOptions,
  OPS,
  getDocument,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  pdfRasterCanvasToPngDataUrl,
  releasePdfRasterCanvas,
} from "./raster-limits";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Matches Excalidraw's dark-canvas transform used for page previews. */
export const DARK_PDF_CANVAS_FILTER = "invert(93%) hue-rotate(180deg)";
const DARK_PDF_CANVAS_INVERSE_FILTER = "hue-rotate(180deg) invert(100%) contrast(116.2790698%)";

// Colour image XObjects are deliberately absent so pictures retain their
// natural colours. Image masks stay with vector content: PDF authors commonly
// use them for text, glyphs, and single-colour artwork.
const VECTOR_PAINT_OPERATORS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
  OPS.shadingFill,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
  // PDF.js folds optimized path painting into constructPath and passes the
  // actual fill/stroke operator as an argument rather than a second op.
  OPS.constructPath,
  OPS.rawFillPath,
]);

const FILTERED_CANVAS_METHODS = new Set<PropertyKey>([
  "drawImage",
  "fill",
  "fillRect",
  "fillText",
  "stroke",
  "strokeRect",
  "strokeText",
]);

const RENDER_SURFACE_CREATING_OPERATORS = new Set<number>([
  OPS.beginGroup,
  OPS.endGroup,
  OPS.setGState,
  OPS.restore,
  OPS.beginAnnotation,
  OPS.endAnnotation,
]);

export interface PdfRasterDimensions {
  width: number;
  height: number;
}

export interface DarkPdfPreviewRequest extends PdfRasterDimensions {
  bytes: Uint8Array;
  pageIndex: number;
}

function localPdfStandardFontDataUrl(): string {
  return new URL("./pdfjs/standard_fonts/", window.location.href).toString();
}

function safePixelDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The PDF ${label} is invalid.`);
  }
  return value;
}

function pngRasterAsSvgDataUrl(
  pngDataURL: string,
  width: number,
  height: number,
): DataURL {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="${pngDataURL}"/></svg>`;
  return `data:image/svg+xml;base64,${window.btoa(svg)}` as DataURL;
}

/** Reads the already-budgeted light raster size without retaining another bitmap. */
export function getPdfRasterDimensions(dataURL: string): Promise<PdfRasterDimensions> {
  if (!dataURL.startsWith("data:image/")) {
    return Promise.reject(new Error("The PDF page preview is missing."));
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        resolve({
          width: safePixelDimension(image.naturalWidth, "preview width"),
          height: safePixelDimension(image.naturalHeight, "preview height"),
        });
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error("The PDF page preview could not be decoded."));
    image.src = dataURL;
  });
}

/**
 * Creates a display-only raster prepared for Excalidraw's dark canvas filter.
 * PDF.js renders vector operations through the dark filter while leaving
 * colour-image operators alone. This preserves operator order, transparent
 * picture pixels, and vector marks drawn above or below a picture. The final
 * raster is then pre-compensated for Excalidraw's unavoidable canvas filter.
 */
export async function renderDarkPdfPreview({
  bytes,
  pageIndex,
  width,
  height,
}: DarkPdfPreviewRequest): Promise<DataURL> {
  safePixelDimension(width, "preview width");
  safePixelDimension(height, "preview height");
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error("The PDF page number is invalid.");
  }

  let currentOperation: number | null = null;
  const renderSurfaces = new WeakSet<HTMLCanvasElement>();
  const wrapRenderContext = (
    context: CanvasRenderingContext2D,
  ): CanvasRenderingContext2D => new Proxy(context, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (!FILTERED_CANVAS_METHODS.has(property)) return value.bind(target);
      return (...args: unknown[]) => {
        const previousFilter = target.filter;
        const source = property === "drawImage" ? args[0] : null;
        const compositesRenderedSurface = source instanceof HTMLCanvasElement
          && renderSurfaces.has(source);
        const darkenVectorPaint = renderSurfaces.has(target.canvas)
          && !compositesRenderedSurface
          && (currentOperation === null || VECTOR_PAINT_OPERATORS.has(currentOperation));
        if (darkenVectorPaint) {
          target.filter = previousFilter && previousFilter !== "none"
            ? `${previousFilter} ${DARK_PDF_CANVAS_FILTER}`
            : DARK_PDF_CANVAS_FILTER;
        }
        try {
          return Reflect.apply(value, target, args);
        } finally {
          target.filter = previousFilter;
        }
      };
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as CanvasRenderingContext2D;

  class DarkPdfCanvasFactory {
    constructor(_options: unknown) {}

    create(width: number, canvasHeight: number) {
      if (width <= 0 || canvasHeight <= 0) throw new Error("Invalid canvas size");
      const canvas = window.document.createElement("canvas");
      canvas.width = width;
      canvas.height = canvasHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("This browser cannot render dark PDF pages.");
      // Page transparency is created before the first operator. Isolated
      // groups, soft masks, and annotation surfaces are created by structural
      // operators. Their contents are filtered per paint operation and their
      // later surface-to-surface composites must therefore remain unfiltered.
      if (
        currentOperation === null
        || RENDER_SURFACE_CREATING_OPERATORS.has(currentOperation)
      ) renderSurfaces.add(canvas);
      return { canvas, context: wrapRenderContext(context) };
    }

    reset(
      entry: { canvas: HTMLCanvasElement | null },
      width: number,
      canvasHeight: number,
    ) {
      if (!entry.canvas) throw new Error("Canvas is not specified");
      if (width <= 0 || canvasHeight <= 0) throw new Error("Invalid canvas size");
      entry.canvas.width = width;
      entry.canvas.height = canvasHeight;
    }

    destroy(entry: {
      canvas: HTMLCanvasElement | null;
      context: CanvasRenderingContext2D | null;
    }) {
      if (!entry.canvas) throw new Error("Canvas is not specified");
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.canvas = null;
      entry.context = null;
    }
  }

  const loadingTask = getDocument({
    // PDF.js may transfer this copy to its worker. The project-owned bytes stay
    // immutable for autosave, project archives, and annotated PDF export.
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: localPdfStandardFontDataUrl(),
    CanvasFactory: DarkPdfCanvasFactory,
  });
  let desiredDarkCanvas: HTMLCanvasElement | null = null;
  let precompensatedCanvas: HTMLCanvasElement | null = null;
  try {
    const document = await loadingTask.promise;
    if (pageIndex >= document.numPages) throw new Error("The PDF page no longer exists.");
    const page = await document.getPage(pageIndex + 1);
    try {
      const unitViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(width / unitViewport.width, height / unitViewport.height);
      const viewport = page.getViewport({ scale });
      const operatorList = await page.getOperatorList();
      desiredDarkCanvas = window.document.createElement("canvas");
      desiredDarkCanvas.width = width;
      desiredDarkCanvas.height = height;
      const desiredDarkContext = desiredDarkCanvas.getContext("2d", { alpha: false });
      if (!desiredDarkContext) throw new Error("This browser cannot render dark PDF pages.");
      renderSurfaces.add(desiredDarkCanvas);
      const operationAwareContext = wrapRenderContext(desiredDarkContext);

      const renderTask = page.render({
        canvas: null,
        canvasContext: operationAwareContext,
        viewport,
        background: "#ffffff",
        operationsFilter: (index) => {
          currentOperation = operatorList.fnArray[index];
          return true;
        },
      });
      await renderTask.promise;

      precompensatedCanvas = window.document.createElement("canvas");
      precompensatedCanvas.width = width;
      precompensatedCanvas.height = height;
      const precompensatedContext = precompensatedCanvas.getContext("2d", { alpha: false });
      if (!precompensatedContext) throw new Error("This browser cannot preserve PDF pictures in dark mode.");
      // The inverse of Excalidraw's 93% invert is an exact 100% invert plus
      // 1 / 0.86 contrast. Hue rotation is its own inverse at 180 degrees.
      // Extremal image channels are necessarily clipped to Excalidraw's 7%
      // dark-mode gamut, while every in-gamut colour round-trips.
      precompensatedContext.filter = DARK_PDF_CANVAS_INVERSE_FILTER;
      precompensatedContext.drawImage(desiredDarkCanvas, 0, 0);
      precompensatedContext.filter = "none";

      // A generated SVG wrapper makes Excalidraw identify this transient file
      // as SVG and skip its extra PNG image filter. The editor's one canvas
      // filter can then invert the page while compensated picture pixels keep
      // their natural colour polarity and hue instead of becoming negatives.
      return pngRasterAsSvgDataUrl(
        pdfRasterCanvasToPngDataUrl(precompensatedCanvas),
        width,
        height,
      );
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
    if (desiredDarkCanvas) releasePdfRasterCanvas(desiredDarkCanvas);
    if (precompensatedCanvas) releasePdfRasterCanvas(precompensatedCanvas);
  }
}
