import type { DataURL } from "@excalidraw/excalidraw/types";
import {
  GlobalWorkerOptions,
  getDocument,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  encodedDataUrlByteLength,
  getPdfImportEncodedByteBudget,
  getPdfJsRasterOptions,
  getPdfRasterBudget,
  getPdfRasterDeviceTier,
  MAX_PDF_PAGE_EDGE_POINTS,
  pdfRasterCanvasToPngDataUrl,
  releasePdfRasterCanvas,
  type PdfPageRasterSize,
  type PdfRasterBudget,
  type PdfRasterDeviceTier,
  type PdfRasterEnvironment,
} from "./raster-limits";
import {
  awaitPdfOperation,
  pdfAbortError,
  throwIfPdfOperationAborted,
} from "./operation-progress";
import { withPdfWorkerMimeQuery } from "./worker-url";

GlobalWorkerOptions.workerSrc = withPdfWorkerMimeQuery(pdfWorkerUrl);

// PDF.js 6.2.108 still consumes these legacy hardening flags at runtime, but
// its public DocumentInitParameters type no longer declares them.
type SafePdfDocumentInitParameters = NonNullable<Parameters<typeof getDocument>[0]> & {
  enableScripting?: boolean;
  isEvalSupported?: boolean;
};

export type PdfPageRotation = 0 | 90 | 180 | 270;
export type PdfPagePreviewTheme = "light" | "dark";
export type PdfPagePreviewQuality =
  | "canonical"
  | "thumbnail"
  | "sharp-2x"
  | "sharp-3x"
  | "sharp-4x";

export interface ActivePdfPagePreviewTarget extends PdfPageRasterSize {
  /** Actual scale after fitting the discrete quality request into device limits. */
  scale: number;
  /** Discrete quality avoids cache churn from fractional DPR changes. */
  quality: Extract<PdfPagePreviewQuality, `sharp-${number}x`>;
  deviceTier: PdfRasterDeviceTier;
  effectiveRotation: PdfPageRotation;
}

export interface ActivePdfPagePreviewTargetRequest {
  /**
   * Immutable PDF page display geometry in points. These dimensions already
   * include the source page rotation, as PdfPageWorkspace.width/height do.
   * Milestone 4 has no additional view rotation, so do not swap them again.
   */
  displayWidth: number;
  displayHeight: number;
  effectiveRotation: PdfPageRotation;
  devicePixelRatio?: number;
  environment?: PdfRasterEnvironment;
  rasterBudget?: Readonly<PdfRasterBudget>;
}

export interface ActivePdfPagePreviewKeyInput extends PdfPageRasterSize {
  sourceSha256: string;
  pageIndex: number;
  effectiveRotation: PdfPageRotation;
  theme: PdfPagePreviewTheme;
  quality: PdfPagePreviewQuality;
  deviceTier: PdfRasterDeviceTier;
  /** Separates repeated logical occurrences of one immutable source page. */
  occurrenceId?: string;
}

export interface LightPdfPagePreviewRequest extends PdfPageRasterSize {
  bytes: Uint8Array;
  /** Verified hash for wrapper-owned immutable source bytes. */
  immutableSha256?: string;
  pageIndex: number;
  /** Source rotation only until view rotation is introduced in Milestone 5. */
  effectiveRotation: PdfPageRotation;
  rasterBudget?: Readonly<PdfRasterBudget>;
  signal?: AbortSignal;
}

export interface LightPdfPagePreviewRaster extends PdfPageRasterSize {
  dataURL: DataURL;
}

function browserRasterEnvironment(): PdfRasterEnvironment {
  if (typeof navigator === "undefined") return {};
  const browserNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    deviceMemory: browserNavigator.deviceMemory,
    hardwareConcurrency: browserNavigator.hardwareConcurrency,
  };
}

function browserDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

function assertPageRotation(value: number): asserts value is PdfPageRotation {
  if (value !== 0 && value !== 90 && value !== 180 && value !== 270) {
    throw new Error("The PDF page rotation is invalid.");
  }
}

function assertSourcePageGeometry(width: number, height: number): void {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
    || width > MAX_PDF_PAGE_EDGE_POINTS
    || height > MAX_PDF_PAGE_EDGE_POINTS
  ) {
    throw new Error("The PDF page has unsupported dimensions.");
  }
}

function assertRasterSize(
  width: number,
  height: number,
  rasterBudget: Readonly<PdfRasterBudget>,
): void {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > rasterBudget.maxEdge
    || height > rasterBudget.maxEdge
    || !Number.isSafeInteger(pixels)
    || pixels > rasterBudget.maxPixelsPerPage
    || pixels > rasterBudget.maxPixelsPerDocument
  ) {
    throw new Error("The active PDF page preview is too large to render safely.");
  }
}

function sharpScaleForDevice(
  devicePixelRatio: number,
  deviceTier: PdfRasterDeviceTier,
): 2 | 3 | 4 {
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.min(Math.max(devicePixelRatio, 1), 2)
    : 1;
  const dprScale = Math.min(4, Math.max(2, Math.ceil(safeDpr * 2))) as 2 | 3 | 4;
  const tierCap = deviceTier === "standard" ? 4 : deviceTier === "low" ? 3 : 2;
  return Math.min(dprScale, tierCap) as 2 | 3 | 4;
}

/**
 * Derives one bounded, device-adaptive raster target for the active page.
 * Only three discrete quality buckets are emitted so ordinary DPR noise does
 * not create an unbounded series of cache identities.
 */
export function getActivePdfPagePreviewTarget({
  displayWidth,
  displayHeight,
  effectiveRotation,
  devicePixelRatio = browserDevicePixelRatio(),
  environment = browserRasterEnvironment(),
  rasterBudget: requestedRasterBudget,
}: ActivePdfPagePreviewTargetRequest): ActivePdfPagePreviewTarget {
  assertSourcePageGeometry(displayWidth, displayHeight);
  assertPageRotation(effectiveRotation);
  const deviceTier = getPdfRasterDeviceTier(environment);
  const rasterBudget = requestedRasterBudget ?? getPdfRasterBudget(environment);
  const requestedScale = sharpScaleForDevice(devicePixelRatio, deviceTier);
  const maximumPixels = Math.min(
    rasterBudget.maxPixelsPerPage,
    rasterBudget.maxPixelsPerDocument,
  );
  const scale = Math.min(
    requestedScale,
    rasterBudget.maxEdge / displayWidth,
    rasterBudget.maxEdge / displayHeight,
    Math.sqrt(maximumPixels / (displayWidth * displayHeight)),
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("The active PDF page preview is too large to render safely.");
  }
  const width = Math.max(1, Math.floor(displayWidth * scale));
  const height = Math.max(1, Math.floor(displayHeight * scale));
  assertRasterSize(width, height, rasterBudget);
  return {
    width,
    height,
    scale: Math.min(width / displayWidth, height / displayHeight),
    quality: `sharp-${requestedScale}x`,
    deviceTier,
    effectiveRotation,
  };
}

function assertSourceSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f\d]{64}$/.test(normalized)) {
    throw new Error("The PDF source identity is invalid.");
  }
  return normalized;
}

/** Stable identity for bounded active-page and thumbnail preview caches. */
export function createActivePdfPagePreviewKey({
  sourceSha256,
  pageIndex,
  effectiveRotation,
  theme,
  quality,
  deviceTier,
  width,
  height,
  occurrenceId,
}: ActivePdfPagePreviewKeyInput): string {
  const sha256 = assertSourceSha256(sourceSha256);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error("The PDF page number is invalid.");
  }
  assertPageRotation(effectiveRotation);
  if (theme !== "light" && theme !== "dark") {
    throw new Error("The PDF preview theme is invalid.");
  }
  if (
    quality !== "canonical"
    && quality !== "thumbnail"
    && quality !== "sharp-2x"
    && quality !== "sharp-3x"
    && quality !== "sharp-4x"
  ) {
    throw new Error("The PDF preview quality is invalid.");
  }
  if (deviceTier !== "standard" && deviceTier !== "low" && deviceTier !== "very-low") {
    throw new Error("The PDF preview device tier is invalid.");
  }
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error("The PDF preview dimensions are invalid.");
  }
  return JSON.stringify([
    "patterdraw-pdf-preview-v1",
    sha256,
    pageIndex,
    effectiveRotation,
    theme,
    quality,
    deviceTier,
    width,
    height,
    occurrenceId || "source-page",
  ]);
}

/**
 * A transient light refinement is unnecessary when the persisted canonical
 * PNG is already at least as dense in both dimensions.
 */
export function shouldRenderLightPdfPageRefinement(
  canonical: Readonly<PdfPageRasterSize>,
  target: Readonly<PdfPageRasterSize>,
): boolean {
  if (
    !Number.isSafeInteger(canonical.width)
    || canonical.width <= 0
    || !Number.isSafeInteger(canonical.height)
    || canonical.height <= 0
    || !Number.isSafeInteger(target.width)
    || target.width <= 0
    || !Number.isSafeInteger(target.height)
    || target.height <= 0
  ) {
    throw new Error("The PDF preview dimensions are invalid.");
  }
  return canonical.width < target.width || canonical.height < target.height;
}

function localPdfStandardFontDataUrl(): string {
  return new URL("./pdfjs/standard_fonts/", window.location.href).toString();
}

function normalizedPageRotation(value: number): PdfPageRotation | null {
  const rotation = ((value % 360) + 360) % 360;
  return rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270
    ? rotation
    : null;
}

/**
 * Renders one display-only light page from a clone of immutable source bytes.
 * The caller owns cache policy; this function never creates FileData or
 * writes project state.
 */
export async function renderLightPdfPagePreview({
  bytes,
  immutableSha256,
  pageIndex,
  effectiveRotation,
  width: targetWidth,
  height: targetHeight,
  rasterBudget: requestedRasterBudget,
  signal,
}: LightPdfPagePreviewRequest): Promise<LightPdfPagePreviewRaster> {
  throwIfPdfOperationAborted(signal);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error("The PDF page number is invalid.");
  }
  assertPageRotation(effectiveRotation);
  const rasterBudget = requestedRasterBudget ?? getPdfRasterBudget(browserRasterEnvironment());
  assertRasterSize(targetWidth, targetHeight, rasterBudget);
  const rasterOptions = getPdfJsRasterOptions(rasterBudget);
  const encodedBudget = getPdfImportEncodedByteBudget(rasterBudget);
  const { assertPdfEmbeddedImageLimit } = await import("./embedded-image-limits");
  await assertPdfEmbeddedImageLimit(bytes, rasterOptions.maxImageSize, {
    immutableSha256,
    maxEdge: rasterBudget.maxEdge,
    maxTotalPixels: rasterBudget.maxPixelsPerDocument,
    maxTotalEncodedBytes: encodedBudget.maxBytesPerDocument,
    signal,
  });
  throwIfPdfOperationAborted(signal);

  const loadingTask = getDocument({
    // PDF.js may transfer or mutate this worker-bound copy. Project-owned
    // source bytes remain untouched for archives and native-content export.
    data: Uint8Array.from(bytes),
    enableScripting: false,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: localPdfStandardFontDataUrl(),
    ...rasterOptions,
  } as SafePdfDocumentInitParameters);
  let destroyPromise: Promise<unknown> | undefined;
  const destroyLoadingTask = (): Promise<unknown> => {
    if (!destroyPromise) {
      try {
        destroyPromise = Promise.resolve(loadingTask.destroy());
      } catch (error) {
        destroyPromise = Promise.reject(error);
      }
    }
    return destroyPromise;
  };
  const onAbort = () => { void destroyLoadingTask().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });

  let canvas: HTMLCanvasElement | null = null;
  try {
    const document = await awaitPdfOperation(loadingTask.promise, signal);
    throwIfPdfOperationAborted(signal);
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new Error("The PDF does not contain any importable pages.");
    }
    if (pageIndex >= document.numPages) throw new Error("The PDF page no longer exists.");
    const page = await awaitPdfOperation(document.getPage(pageIndex + 1), signal);
    try {
      throwIfPdfOperationAborted(signal);
      const unitViewport = page.getViewport({ scale: 1 });
      const sourceRotation = normalizedPageRotation(unitViewport.rotation);
      if (sourceRotation === null || sourceRotation !== effectiveRotation) {
        throw new Error("The PDF page rotation no longer matches its original source page.");
      }
      assertSourcePageGeometry(unitViewport.width, unitViewport.height);
      const scale = Math.min(
        targetWidth / unitViewport.width,
        targetHeight / unitViewport.height,
      );
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error("The active PDF page preview is too large to render safely.");
      }
      const viewport = page.getViewport({ scale });
      const outputWidth = Math.max(1, Math.min(targetWidth, Math.floor(viewport.width)));
      const outputHeight = Math.max(1, Math.min(targetHeight, Math.floor(viewport.height)));
      assertRasterSize(outputWidth, outputHeight, rasterBudget);
      canvas = window.document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser cannot render PDF pages.");
      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        background: "#ffffff",
      });
      const cancelRender = () => {
        try {
          renderTask.cancel();
        } catch {
          // PDF.js can synchronously report an already-completed render.
        }
      };
      signal?.addEventListener("abort", cancelRender, { once: true });
      try {
        await awaitPdfOperation(renderTask.promise, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : pdfAbortError();
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancelRender);
      }
      throwIfPdfOperationAborted(signal);
      const dataURL = pdfRasterCanvasToPngDataUrl(canvas);
      canvas = null;
      if (encodedDataUrlByteLength(dataURL) > encodedBudget.maxBytesPerPage) {
        throw new Error("The active PDF page preview output is too large to retain safely.");
      }
      return { dataURL: dataURL as DataURL, width: outputWidth, height: outputHeight };
    } finally {
      page.cleanup();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await destroyLoadingTask().catch(() => undefined);
    if (canvas) {
      releasePdfRasterCanvas(canvas);
      canvas = null;
    }
  }
}
