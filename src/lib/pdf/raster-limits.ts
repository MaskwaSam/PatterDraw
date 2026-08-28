export const MAX_PDF_RASTER_EDGE = 8_192;
export const MAX_PDF_RASTER_PIXELS_PER_PAGE = 16_000_000;
export const MAX_PDF_RASTER_PIXELS_PER_DOCUMENT = 64_000_000;
export const MAX_PDF_PAGE_EDGE_POINTS = 14_400;
/** Encoded page PNG output is charged before it is retained in a scene. */
export const MAX_PDF_ENCODED_PNG_BYTES_PER_PAGE = 64 * 1024 * 1024;
/**
 * Large, text-heavy PDFs can produce more PNG data than their compact source
 * bytes suggest. Callers still clamp this ceiling to the destination
 * project's remaining 150 MiB content budget before rasterization.
 */
export const MAX_PDF_ENCODED_PNG_BYTES_PER_DOCUMENT = 110 * 1024 * 1024;

export interface PdfRasterBudget {
  maxEdge: number;
  maxPixelsPerPage: number;
  maxPixelsPerDocument: number;
}

export interface PdfJsRasterOptions {
  /** Maximum decoded embedded-image area, in source pixels. */
  maxImageSize: number;
  /** Maximum worker canvas area, expressed in bytes as required by PDF.js. */
  canvasMaxAreaInBytes: number;
}

export interface PdfEncodedByteBudget {
  maxBytesPerPage: number;
  maxBytesPerDocument: number;
}

export function getPdfImportEncodedByteBudget(
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
  maxDocumentBytes = MAX_PDF_ENCODED_PNG_BYTES_PER_DOCUMENT,
): PdfEncodedByteBudget {
  if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 0) {
    throw new Error("The PDF encoded-image byte limit is invalid.");
  }
  const maxBytesPerPage = Math.max(
    maxDocumentBytes === 0 ? 0 : 1,
    Math.min(
      MAX_PDF_ENCODED_PNG_BYTES_PER_PAGE,
      rasterBudget.maxPixelsPerPage * 4,
      maxDocumentBytes,
    ),
  );
  const maxBytesPerDocument = Math.max(
    maxDocumentBytes === 0 ? 0 : maxBytesPerPage,
    Math.min(
      MAX_PDF_ENCODED_PNG_BYTES_PER_DOCUMENT,
      rasterBudget.maxPixelsPerDocument * 4,
      maxDocumentBytes,
    ),
  );
  return { maxBytesPerPage, maxBytesPerDocument };
}

export function encodedDataUrlByteLength(dataURL: string): number {
  const comma = dataURL.indexOf(",");
  if (comma < 0) throw new Error("PNG export produced invalid local data.");
  const payload = dataURL.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(payload.length * 3 / 4) - padding;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("PNG export produced invalid local data.");
  }
  return bytes;
}

export interface PdfRasterEnvironment {
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

export const DEFAULT_PDF_RASTER_BUDGET: Readonly<PdfRasterBudget> = Object.freeze({
  maxEdge: MAX_PDF_RASTER_EDGE,
  maxPixelsPerPage: MAX_PDF_RASTER_PIXELS_PER_PAGE,
  maxPixelsPerDocument: MAX_PDF_RASTER_PIXELS_PER_DOCUMENT,
});

export function getPdfJsRasterOptions(
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
): PdfJsRasterOptions {
  // PDF.js otherwise leaves maxImageSize and canvasMaxAreaInBytes unlimited.
  // A high-resolution source image can safely be larger than its downscaled
  // page canvas. Keep that decoder allocation device-sensitive while retaining
  // the stricter page-canvas bound.
  const maxImageSize = Math.max(
    1,
    Math.floor(Math.min(
      rasterBudget.maxPixelsPerDocument,
      rasterBudget.maxEdge * rasterBudget.maxEdge,
    )),
  );
  const maxCanvasPixels = Math.max(
    1,
    Math.floor(Math.min(
      rasterBudget.maxPixelsPerPage,
      rasterBudget.maxPixelsPerDocument,
      rasterBudget.maxEdge * rasterBudget.maxEdge,
    )),
  );
  return {
    maxImageSize,
    canvasMaxAreaInBytes: maxCanvasPixels * 4,
  };
}

export function getPdfEmbeddedImagePixelBudget(
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
): number {
  // PDF pages and their source images are decoded and cleaned up sequentially,
  // so cumulative source pixels are a work limit rather than a peak-memory
  // allocation. Keep enough headroom for ordinary image-based books even on a
  // low-memory device, while retaining a firm document-wide ceiling.
  return Math.min(
    256 * 1024 * 1024,
    Math.max(128_000_000, rasterBudget.maxPixelsPerDocument * 4),
  );
}

const LOW_MEMORY_PDF_RASTER_BUDGET: Readonly<PdfRasterBudget> = Object.freeze({
  maxEdge: 6_144,
  maxPixelsPerPage: 8_000_000,
  maxPixelsPerDocument: 32_000_000,
});

const VERY_LOW_MEMORY_PDF_RASTER_BUDGET: Readonly<PdfRasterBudget> = Object.freeze({
  maxEdge: 4_096,
  maxPixelsPerPage: 4_000_000,
  maxPixelsPerDocument: 16_000_000,
});

export interface PdfPageRasterSize {
  width: number;
  height: number;
}

function positiveFinite(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value : undefined;
}

export function getPdfRasterBudget(
  environment: PdfRasterEnvironment = {},
): Readonly<PdfRasterBudget> {
  const deviceMemory = positiveFinite(environment.deviceMemory);
  const hardwareConcurrency = positiveFinite(environment.hardwareConcurrency);

  // Chromium reports deviceMemory in coarse buckets. Prefer it when available
  // because a low core count alone does not imply low available memory.
  if (deviceMemory !== undefined) {
    if (deviceMemory <= 2) return VERY_LOW_MEMORY_PDF_RASTER_BUDGET;
    if (deviceMemory <= 4) return LOW_MEMORY_PDF_RASTER_BUDGET;
    return DEFAULT_PDF_RASTER_BUDGET;
  }
  if (hardwareConcurrency !== undefined && hardwareConcurrency <= 2) {
    return VERY_LOW_MEMORY_PDF_RASTER_BUDGET;
  }
  if (hardwareConcurrency !== undefined && hardwareConcurrency <= 4) {
    return LOW_MEMORY_PDF_RASTER_BUDGET;
  }
  return DEFAULT_PDF_RASTER_BUDGET;
}

export function getBrowserPdfRasterBudget(): Readonly<PdfRasterBudget> {
  if (typeof navigator === "undefined") return DEFAULT_PDF_RASTER_BUDGET;
  const browserNavigator = navigator as Navigator & { deviceMemory?: number };
  return getPdfRasterBudget({
    deviceMemory: browserNavigator.deviceMemory,
    hardwareConcurrency: browserNavigator.hardwareConcurrency,
  });
}

export function getPdfExportRasterBudget(
  rasterBudget: Readonly<PdfRasterBudget>,
  pageCount: number,
): Readonly<PdfRasterBudget> {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
    throw new Error("PDF export must contain at least one page.");
  }
  return {
    ...rasterBudget,
    maxPixelsPerPage: Math.min(
      rasterBudget.maxPixelsPerPage,
      Math.max(1, Math.floor(rasterBudget.maxPixelsPerDocument / pageCount)),
    ),
  };
}

export function releasePdfRasterCanvas(
  canvas: Pick<HTMLCanvasElement, "width" | "height">,
): void {
  // Resetting both dimensions discards the backing bitmap instead of waiting
  // for garbage collection. A zero-sized canvas cannot accidentally retain a
  // multi-megapixel allocation after its PNG has already been encoded.
  canvas.width = 0;
  canvas.height = 0;
}

export function pdfRasterCanvasToPngDataUrl(canvas: HTMLCanvasElement): string {
  try {
    const dataURL = canvas.toDataURL("image/png");
    if (!dataURL.startsWith("data:image/png")) {
      throw new Error("This PDF page is too large for the browser to render safely.");
    }
    return dataURL;
  } finally {
    releasePdfRasterCanvas(canvas);
  }
}

export async function pdfRasterCanvasToPngBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array> {
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        // The browser has completed PNG encoding by the time this callback
        // runs, so the large bitmap can be discarded before allocating bytes.
        releasePdfRasterCanvas(canvas);
        if (value) resolve(value);
        else reject(new Error("PNG export failed."));
      }, "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Covers synchronous toBlob failures and browsers that return null.
    releasePdfRasterCanvas(canvas);
  }
}

export function getPdfImportRasterScale(
  pages: readonly PdfPageRasterSize[],
  devicePixelRatio = 1,
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
): number {
  if (!pages.length) throw new Error("The PDF has no pages.");
  const preferredScale = Math.min(Math.max(devicePixelRatio, 1), 2) * 1.5;
  let scale = preferredScale;
  let totalArea = 0;

  for (const page of pages) {
    if (
      !Number.isFinite(page.width)
      || !Number.isFinite(page.height)
      || page.width <= 0
      || page.height <= 0
      || page.width > MAX_PDF_PAGE_EDGE_POINTS
      || page.height > MAX_PDF_PAGE_EDGE_POINTS
    ) {
      throw new Error("A PDF page has unsupported dimensions.");
    }
    totalArea += page.width * page.height;
    scale = Math.min(
      scale,
      rasterBudget.maxEdge / page.width,
      rasterBudget.maxEdge / page.height,
      Math.sqrt(rasterBudget.maxPixelsPerPage) / Math.sqrt(page.width) / Math.sqrt(page.height),
    );
  }

  scale = Math.min(
    scale,
    Math.sqrt(rasterBudget.maxPixelsPerDocument) / Math.sqrt(totalArea),
  );
  const fitsRoundedCanvasBudget = (candidate: number): boolean => {
    let roundedPixels = 0;
    for (const page of pages) {
      const width = Math.ceil(page.width * candidate);
      const height = Math.ceil(page.height * candidate);
      const pixels = width * height;
      if (
        width <= 0
        || height <= 0
        || width > rasterBudget.maxEdge
        || height > rasterBudget.maxEdge
        || !Number.isSafeInteger(pixels)
        || pixels > rasterBudget.maxPixelsPerPage
      ) return false;
      roundedPixels += pixels;
      if (
        !Number.isSafeInteger(roundedPixels)
        || roundedPixels > rasterBudget.maxPixelsPerDocument
      ) return false;
    }
    return true;
  };
  if (!fitsRoundedCanvasBudget(scale)) {
    // The area formula uses fractional dimensions, while real canvases round
    // every page edge up. Binary-search the largest scale whose actual canvas
    // allocations remain inside the same unchanged budget.
    let lower = 0;
    let upper = scale;
    for (let iteration = 0; iteration < 48; iteration += 1) {
      const candidate = (lower + upper) / 2;
      if (fitsRoundedCanvasBudget(candidate)) lower = candidate;
      else upper = candidate;
    }
    scale = lower;
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("The PDF is too large to rasterize safely.");
  }
  return scale;
}
