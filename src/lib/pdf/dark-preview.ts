import type { DataURL } from "@excalidraw/excalidraw/types";
import {
  GlobalWorkerOptions,
  OPS,
  getDocument,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  getBrowserPdfRasterBudget,
  getPdfEmbeddedImagePixelBudget,
  getPdfImportEncodedByteBudget,
  getPdfJsRasterOptions,
  pdfRasterCanvasToPngDataUrl,
  releasePdfRasterCanvas,
  type PdfRasterBudget,
} from "./raster-limits";
import { withPdfWorkerCacheRevision } from "./worker-url";

GlobalWorkerOptions.workerSrc = withPdfWorkerCacheRevision(pdfWorkerUrl);

// PDF.js 6.2.108 still consumes these legacy hardening flags at runtime, but
// its public DocumentInitParameters type no longer declares them. Keep the
// explicit values in the request while documenting the narrow compatibility
// cast at this wrapper boundary.
type SafePdfDocumentInitParameters = NonNullable<Parameters<typeof getDocument>[0]> & {
  enableScripting?: boolean;
  isEvalSupported?: boolean;
};

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
  "fill",
  "fillRect",
  "fillText",
  "stroke",
  "strokeRect",
  "strokeText",
]);

export interface PdfRasterDimensions {
  width: number;
  height: number;
}

export interface DarkPdfPreviewRequest extends PdfRasterDimensions {
  bytes: Uint8Array;
  /** Verified hash for wrapper-owned immutable source bytes. */
  immutableSha256?: string;
  pageIndex: number;
  rasterBudget?: Readonly<PdfRasterBudget>;
  signal?: AbortSignal;
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

export function assertDarkPdfRasterSize(
  width: number,
  height: number,
  rasterBudget: Readonly<PdfRasterBudget> = getBrowserPdfRasterBudget(),
): PdfRasterDimensions {
  const { width: safeWidth, height: safeHeight } = assertPdfRasterDimensions(width, height);
  if (
    safeWidth > rasterBudget.maxEdge
    || safeHeight > rasterBudget.maxEdge
    || safeWidth > Math.floor(rasterBudget.maxPixelsPerPage / safeHeight)
  ) {
    throw new Error("The PDF page preview is too large to render safely.");
  }
  return { width: safeWidth, height: safeHeight };
}

function assertPdfRasterDimensions(width: number, height: number): PdfRasterDimensions {
  return {
    width: safePixelDimension(width, "preview width"),
    height: safePixelDimension(height, "preview height"),
  };
}

/**
 * Fits a source raster into the current PDF budget without ever upscaling it.
 * The optional cap limits the longest output edge (thumbnail callers use 256).
 */
export function fitPdfRasterDimensions(
  source: PdfRasterDimensions,
  rasterBudget: Readonly<PdfRasterBudget> = getBrowserPdfRasterBudget(),
  longestEdgeCap?: number,
): PdfRasterDimensions {
  const { width, height } = assertPdfRasterDimensions(source.width, source.height);
  const edgeCap = longestEdgeCap === undefined
    ? Number.POSITIVE_INFINITY
    : safePixelDimension(longestEdgeCap, "preview edge cap");
  const maximumPixels = Math.min(
    rasterBudget.maxPixelsPerPage,
    rasterBudget.maxPixelsPerDocument,
  );
  const scale = Math.min(
    1,
    rasterBudget.maxEdge / width,
    rasterBudget.maxEdge / height,
    Math.sqrt(maximumPixels) / Math.sqrt(width) / Math.sqrt(height),
    edgeCap / Math.max(width, height),
  );
  return assertDarkPdfRasterSize(
    Math.max(1, Math.floor(width * scale)),
    Math.max(1, Math.floor(height * scale)),
    rasterBudget,
  );
}

function darkPdfAbortError(): Error {
  const error = new Error("The dark PDF preview was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfDarkPdfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw darkPdfAbortError();
}

function waitForDarkPdfTask<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  cancel: () => void,
): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) {
    cancel();
    return Promise.reject(darkPdfAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cancel();
      reject(darkPdfAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

const PNG_DATA_URL_PATTERN = /^data:image\/png;base64,/i;
const PNG_DATA_URL_FULL_PATTERN = /^data:image\/png;base64,[a-z\d+/]*={0,2}$/i;
const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";

interface NormalizedPngDataUrl {
  value: string;
  payloadOffset: number;
}

/**
 * Keep PNG data-url handling in step with image-safety's parser.  Canvas
 * implementations normally return a lower-case prefix without whitespace,
 * but persisted projects can contain either case and harmless surrounding
 * whitespace.  Validate the alphabet without copying the (potentially very
 * large) payload so dimension inspection remains header-only.
 */
function normalizePngDataUrl(dataURL: string): NormalizedPngDataUrl {
  const normalized = dataURL.trim();
  const prefix = PNG_DATA_URL_PATTERN.exec(normalized)?.[0];
  if (!prefix || !PNG_DATA_URL_FULL_PATTERN.test(normalized)) {
    throw new Error("The PDF page preview format is unsupported.");
  }
  const payloadOffset = prefix.length;
  const payloadLength = normalized.length - payloadOffset;
  if (payloadLength <= 0 || payloadLength % 4 !== 0) {
    throw new Error("The PDF page preview format is unsupported.");
  }
  return { value: normalized, payloadOffset };
}

function base64PayloadByteLength(
  dataURL: NormalizedPngDataUrl,
): number {
  const payloadLength = dataURL.value.length - dataURL.payloadOffset;
  const padding = dataURL.value.endsWith("==") ? 2 : dataURL.value.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(payloadLength * 3 / 4) - padding;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("The PDF page preview format is unsupported.");
  }
  return bytes;
}

function base64EncodedLength(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return Number.POSITIVE_INFINITY;
  return 4 * Math.ceil(byteLength / 3);
}

function darkPdfEncodedOutputLimit(
  rasterBudget: Readonly<PdfRasterBudget>,
): number {
  const encodedBudget = getPdfImportEncodedByteBudget(rasterBudget);
  return Math.min(encodedBudget.maxBytesPerPage, encodedBudget.maxBytesPerDocument);
}

function darkPdfSvgSourceLength(
  pngDataURLLength: number,
  width: number,
  height: number,
): number {
  const svgPrefix = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="`;
  const svgSuffix = `"/></svg>`;
  const sourceLength = svgPrefix.length + pngDataURLLength + svgSuffix.length;
  return Number.isSafeInteger(sourceLength) ? sourceLength : Number.POSITIVE_INFINITY;
}

/**
 * Reject a PNG before it is nested in a base64 SVG.  The SVG wrapper adds a
 * second encoded copy of the PNG data URL, so checking only the PNG byte
 * count would still allow a final string to exceed the selected device
 * budget.  This estimate is exact for the ASCII-only wrapper generated below
 * and avoids allocating either the SVG source or its base64 output on error.
 */
function assertNormalizedDarkPdfEncodedOutputBudget(
  normalized: NormalizedPngDataUrl,
  width: number,
  height: number,
  rasterBudget: Readonly<PdfRasterBudget> = getBrowserPdfRasterBudget(),
): void {
  const { width: safeWidth, height: safeHeight } = assertPdfRasterDimensions(width, height);
  const pngBytes = base64PayloadByteLength(normalized);
  const svgSourceLength = darkPdfSvgSourceLength(normalized.value.length, safeWidth, safeHeight);
  const encodedOutputBytes = Number.isFinite(svgSourceLength)
    ? SVG_DATA_URL_PREFIX.length + base64EncodedLength(svgSourceLength)
    : Number.POSITIVE_INFINITY;
  const maxEncodedBytes = darkPdfEncodedOutputLimit(rasterBudget);
  if (
    pngBytes > maxEncodedBytes
    || !Number.isSafeInteger(encodedOutputBytes)
    || encodedOutputBytes > maxEncodedBytes
  ) {
    throw new Error("The dark PDF preview output is too large to retain safely.");
  }
}

export function assertDarkPdfEncodedOutputBudget(
  pngDataURL: string,
  width: number,
  height: number,
  rasterBudget: Readonly<PdfRasterBudget> = getBrowserPdfRasterBudget(),
): void {
  assertNormalizedDarkPdfEncodedOutputBudget(
    normalizePngDataUrl(pngDataURL),
    width,
    height,
    rasterBudget,
  );
}

function pngRasterAsSvgDataUrl(
  pngDataURL: string,
  width: number,
  height: number,
  rasterBudget: Readonly<PdfRasterBudget>,
): DataURL {
  const normalized = normalizePngDataUrl(pngDataURL);
  assertNormalizedDarkPdfEncodedOutputBudget(normalized, width, height, rasterBudget);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="${normalized.value}"/></svg>`;
  // The source PNG data URL is now copied into the SVG source. Drop the
  // separate reference before btoa allocates the final encoded string.
  normalized.value = "";
  const encoded = window.btoa(svg);
  const maxEncodedBytes = darkPdfEncodedOutputLimit(rasterBudget);
  if (SVG_DATA_URL_PREFIX.length + encoded.length > maxEncodedBytes) {
    // Keep this defensive check in case a browser's btoa implementation
    // differs from the ASCII length estimate above.
    throw new Error("The dark PDF preview output is too large to retain safely.");
  }
  return `${SVG_DATA_URL_PREFIX}${encoded}` as DataURL;
}

/** Reads and validates the PNG header without decoding a potentially huge bitmap. */
export function getPdfRasterDimensions(dataURL: string): Promise<PdfRasterDimensions> {
  try {
    const normalized = normalizePngDataUrl(dataURL);
    // The PNG signature and IHDR dimensions fit in the first 24 decoded
    // bytes. Avoid decoding the full data URL just to inspect its dimensions.
    const header = window.atob(normalized.value.slice(
      normalized.payloadOffset,
      normalized.payloadOffset + 32,
    ));
    const bytes = Uint8Array.from(header, (character) => character.charCodeAt(0));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const validSignature = bytes.length >= 24
      && signature.every((value, index) => bytes[index] === value)
      && String.fromCharCode(...bytes.slice(12, 16)) === "IHDR";
    if (!validSignature) throw new Error("The PDF page preview could not be decoded.");
    const width = (
      bytes[16] * 0x1000000
      + bytes[17] * 0x10000
      + bytes[18] * 0x100
      + bytes[19]
    );
    const height = (
      bytes[20] * 0x1000000
      + bytes[21] * 0x10000
      + bytes[22] * 0x100
      + bytes[23]
    );
    return Promise.resolve(assertPdfRasterDimensions(width, height));
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : new Error("The PDF page preview could not be decoded."));
  }
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
  immutableSha256,
  pageIndex,
  rasterBudget: requestedRasterBudget,
  width,
  height,
  signal,
}: DarkPdfPreviewRequest): Promise<DataURL> {
  const rasterBudget = requestedRasterBudget ?? getBrowserPdfRasterBudget();
  assertDarkPdfRasterSize(width, height, rasterBudget);
  throwIfDarkPdfAborted(signal);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error("The PDF page number is invalid.");
  }

  let currentOperation: number | null = null;
  const rasterOptions = getPdfJsRasterOptions(rasterBudget);
  const embeddedImageBudget = getPdfImportEncodedByteBudget(rasterBudget);
  const { assertPdfEmbeddedImageLimit } = await import("./embedded-image-limits");
  await assertPdfEmbeddedImageLimit(bytes, rasterOptions.maxImageSize, {
    immutableSha256,
    maxEdge: rasterBudget.maxEdge,
    maxTotalPixels: getPdfEmbeddedImagePixelBudget(rasterBudget),
    maxTotalEncodedBytes: embeddedImageBudget.maxBytesPerDocument,
    signal,
  });
  throwIfDarkPdfAborted(signal);

  /**
   * PDF.js renders more than the page into a canvas. Tiling patterns, Type3
   * glyphs, image masks, soft masks, and isolated groups all get temporary
   * surfaces from CanvasFactory. Keeping this small amount of ownership data
   * beside the canvas lets us distinguish a paint operation from a
   * surface-to-surface composite without depending on PDF.js' private
   * CanvasGraphics implementation.
   */
  interface RenderSurfaceInfo {
    /** This canvas is eligible for per-paint darkening. */
    isRenderSurface: boolean;
    /** A raster put into this canvas came from an image-like PDF operation. */
    rasterKind: "image" | "generated" | null;
    /** A nested image was painted into this surface. */
    containsColourImage: boolean;
    /** At least one vector paint has already received the dark filter. */
    containsFilteredPaint: boolean;
    /** PDF.js configured a drawing transform before painting this surface. */
    hasTransformSetup: boolean;
  }

  const surfaceInfo = new WeakMap<HTMLCanvasElement, RenderSurfaceInfo>();
  const preRenderedPatterns = new WeakSet<CanvasPattern>();
  const allocatedRasterPixels = new WeakMap<HTMLCanvasElement, number>();
  let workingRasterPixels = 0;

  const reserveRasterCanvas = (
    canvas: HTMLCanvasElement,
    canvasWidth: number,
    canvasHeight: number,
  ) => {
    assertDarkPdfRasterSize(canvasWidth, canvasHeight, rasterBudget);
    const nextPixels = canvasWidth * canvasHeight;
    const previousPixels = allocatedRasterPixels.get(canvas) ?? 0;
    if (
      nextPixels > rasterBudget.maxPixelsPerDocument
        - (workingRasterPixels - previousPixels)
    ) {
      throw new Error("The PDF page preview requires too much working memory.");
    }
    workingRasterPixels = workingRasterPixels - previousPixels + nextPixels;
    allocatedRasterPixels.set(canvas, nextPixels);
  };

  const releaseTrackedRasterCanvas = (canvas: HTMLCanvasElement) => {
    workingRasterPixels = Math.max(
      0,
      workingRasterPixels - (allocatedRasterPixels.get(canvas) ?? 0),
    );
    allocatedRasterPixels.delete(canvas);
    releasePdfRasterCanvas(canvas);
  };

  const getSurfaceInfo = (canvas: HTMLCanvasElement): RenderSurfaceInfo | undefined => surfaceInfo.get(canvas);
  const ensureSurfaceInfo = (canvas: HTMLCanvasElement): RenderSurfaceInfo => {
    const existing = surfaceInfo.get(canvas);
    if (existing) return existing;
    const created: RenderSurfaceInfo = {
      isRenderSurface: true,
      rasterKind: null,
      containsColourImage: false,
      containsFilteredPaint: false,
      hasTransformSetup: false,
    };
    surfaceInfo.set(canvas, created);
    return created;
  };

  const isCanvasPattern = (value: unknown): boolean => (
    typeof value === "object"
    && value !== null
    && preRenderedPatterns.has(value as CanvasPattern)
  );

  const wrapRenderContext = (
    context: CanvasRenderingContext2D,
  ): CanvasRenderingContext2D => new Proxy(context, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;

      // Pattern objects retain their source canvas after PDF.js destroys the
      // temporary entry. Marking a pattern as pre-rendered means that its
      // nested vector/image content has already been handled on the tile
      // surface, so filtering the final fill would darken it a second time.
      if (property === "createPattern") {
        return (...args: unknown[]) => {
          const pattern = Reflect.apply(value, target, args) as unknown;
          const source = args[0];
          if (typeof pattern === "object" && pattern !== null && typeof source === "object" && source !== null) {
            const sourceInfo = getSurfaceInfo(source as HTMLCanvasElement);
            if (sourceInfo?.containsColourImage || sourceInfo?.containsFilteredPaint) {
              preRenderedPatterns.add(pattern as CanvasPattern);
            }
          }
          return pattern;
        };
      }

      // putBinaryImageData/putBinaryImageMask are intentionally not filtered.
      // Their first write is enough to tell image-like rasters (offset 0, 0)
      // from mesh/shading rasters (which PDF.js writes with a border offset).
      // The eventual fillRect that applies an image-mask colour still goes
      // through the operation-aware filter below.
      if (property === "putImageData") {
        return (...args: unknown[]) => {
          const info = ensureSurfaceInfo(target.canvas);
          const offsetX = typeof args[1] === "number" ? args[1] : 0;
          const offsetY = typeof args[2] === "number" ? args[2] : 0;
          if (info.rasterKind === null) {
            info.rasterKind = offsetX === 0 && offsetY === 0 ? "image" : "generated";
          }
          return Reflect.apply(value, target, args);
        };
      }

      // Image XObjects are composited with drawImage. Do not put the dark
      // filter on that composite: doing so is exactly what turns an RGB image
      // nested in a Type3 glyph or tiling pattern into a negative. Remember
      // the image on the destination instead, so a later CanvasPattern fill
      // can also avoid applying the filter to the already-composited pixels.
      if (property === "drawImage") {
        return (...args: unknown[]) => {
          const source = args[0];
          const targetInfo = ensureSurfaceInfo(target.canvas);
          const sourceInfo = typeof source === "object" && source !== null
            ? getSurfaceInfo(source as HTMLCanvasElement)
            : undefined;
          const unknownImageSource = !sourceInfo
            && typeof source === "object"
            && source !== null
            // Mesh shading's GPU path also uses drawImage, but its fresh
            // canvas has no PDF transform yet. A 1x1 target, on the other
            // hand, is PDF.js' image-scaling scratch surface.
            && (targetInfo.hasTransformSetup || target.canvas.width <= 1 || target.canvas.height <= 1);
          if (
            sourceInfo?.rasterKind === "image"
            || sourceInfo?.containsColourImage
            || unknownImageSource
          ) {
            targetInfo.containsColourImage = true;
          }
          if (sourceInfo?.containsFilteredPaint) {
            targetInfo.containsFilteredPaint = true;
          }
          return Reflect.apply(value, target, args);
        };
      }

      if (property === "translate" || property === "transform" || property === "scale" || property === "setTransform" || property === "resetTransform" || property === "clip") {
        return (...args: unknown[]) => {
          ensureSurfaceInfo(target.canvas).hasTransformSetup = true;
          return Reflect.apply(value, target, args);
        };
      }

      if (!FILTERED_CANVAS_METHODS.has(property)) return value.bind(target);
      return (...args: unknown[]) => {
        const targetInfo = ensureSurfaceInfo(target.canvas);
        const style = property === "stroke" || property === "strokeRect" || property === "strokeText"
          ? target.strokeStyle
          : target.fillStyle;
        const darkenVectorPaint = targetInfo.isRenderSurface
          && !isCanvasPattern(style)
          && (currentOperation === null || VECTOR_PAINT_OPERATORS.has(currentOperation));
        const previousFilter = target.filter;
        if (darkenVectorPaint) {
          targetInfo.containsFilteredPaint = true;
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
      throwIfDarkPdfAborted(signal);
      const canvas = window.document.createElement("canvas");
      reserveRasterCanvas(canvas, width, canvasHeight);
      try {
        canvas.width = width;
        canvas.height = canvasHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("This browser cannot render dark PDF pages.");
        // Every CanvasFactory canvas is a PDF render surface. This includes
        // image/mask scratch canvases and nested pattern/glyph canvases;
        // marking all of them is what lets their vector fill/text operations
        // receive the filter even when nested lists bypass operationsFilter.
        ensureSurfaceInfo(canvas);
        return { canvas, context: wrapRenderContext(context) };
      } catch (error) {
        releaseTrackedRasterCanvas(canvas);
        throw error;
      }
    }

    reset(
      entry: { canvas: HTMLCanvasElement | null },
      width: number,
      canvasHeight: number,
    ) {
      if (!entry.canvas) throw new Error("Canvas is not specified");
      throwIfDarkPdfAborted(signal);
      reserveRasterCanvas(entry.canvas, width, canvasHeight);
      entry.canvas.width = width;
      entry.canvas.height = canvasHeight;
      const info = getSurfaceInfo(entry.canvas);
      if (info) {
        info.rasterKind = null;
        info.containsColourImage = false;
        info.containsFilteredPaint = false;
        info.hasTransformSetup = false;
      }
    }

    destroy(entry: {
      canvas: HTMLCanvasElement | null;
      context: CanvasRenderingContext2D | null;
    }) {
      if (!entry.canvas) throw new Error("Canvas is not specified");
      releaseTrackedRasterCanvas(entry.canvas);
      entry.canvas = null;
      entry.context = null;
    }
  }

  const loadingTask = getDocument({
    // PDF.js may transfer this copy to its worker. The project-owned bytes stay
    // immutable for autosave, project archives, and annotated PDF export.
    data: Uint8Array.from(bytes),
    enableScripting: false,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: localPdfStandardFontDataUrl(),
    CanvasFactory: DarkPdfCanvasFactory,
    ...rasterOptions,
  } as SafePdfDocumentInitParameters);
  let desiredDarkCanvas: HTMLCanvasElement | null = null;
  let precompensatedCanvas: HTMLCanvasElement | null = null;
  try {
    const cancelLoading = () => { void loadingTask.destroy(); };
    const document = await waitForDarkPdfTask(loadingTask.promise, signal, cancelLoading);
    throwIfDarkPdfAborted(signal);
    if (pageIndex >= document.numPages) throw new Error("The PDF page no longer exists.");
    const page = await waitForDarkPdfTask(
      document.getPage(pageIndex + 1),
      signal,
      cancelLoading,
    );
    try {
      throwIfDarkPdfAborted(signal);
      const unitViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(width / unitViewport.width, height / unitViewport.height);
      const viewport = page.getViewport({ scale });
      const operatorList = await waitForDarkPdfTask(
        page.getOperatorList(),
        signal,
        cancelLoading,
      );
      throwIfDarkPdfAborted(signal);
      desiredDarkCanvas = window.document.createElement("canvas");
      reserveRasterCanvas(desiredDarkCanvas, width, height);
      desiredDarkCanvas.width = width;
      desiredDarkCanvas.height = height;
      const desiredDarkContext = desiredDarkCanvas.getContext("2d", { alpha: false });
      if (!desiredDarkContext) throw new Error("This browser cannot render dark PDF pages.");
      ensureSurfaceInfo(desiredDarkCanvas);
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
      await waitForDarkPdfTask(
        renderTask.promise,
        signal,
        () => renderTask.cancel(),
      );
      throwIfDarkPdfAborted(signal);

      precompensatedCanvas = window.document.createElement("canvas");
      reserveRasterCanvas(precompensatedCanvas, width, height);
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
      releaseTrackedRasterCanvas(desiredDarkCanvas);
      desiredDarkCanvas = null;

      // A generated SVG wrapper makes Excalidraw identify this transient file
      // as SVG and skip its extra PNG image filter. The editor's one canvas
      // filter can then invert the page while compensated picture pixels keep
      // their natural colour polarity and hue instead of becoming negatives.
      let pngDataURL = pdfRasterCanvasToPngDataUrl(precompensatedCanvas);
      releaseTrackedRasterCanvas(precompensatedCanvas);
      precompensatedCanvas = null;
      try {
        return pngRasterAsSvgDataUrl(
          pngDataURL,
          width,
          height,
          rasterBudget,
        );
      } finally {
        // Do not retain the large intermediate PNG data URL after the SVG
        // wrapper has either succeeded or rejected its bounded size check.
        pngDataURL = "";
      }
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy().catch(() => undefined);
    if (desiredDarkCanvas) {
      releaseTrackedRasterCanvas(desiredDarkCanvas);
      desiredDarkCanvas = null;
    }
    if (precompensatedCanvas) {
      releaseTrackedRasterCanvas(precompensatedCanvas);
      precompensatedCanvas = null;
    }
  }
}
