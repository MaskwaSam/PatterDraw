import {
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PdfDocumentSource,
  PdfPageWorkspace,
  SerializedScene,
} from "../../types";
import { createLocalId } from "../id";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../safety";
import { sha256Hex } from "../sha256";
import {
  getBrowserPdfRasterBudget,
  encodedDataUrlByteLength,
  getPdfImportEncodedByteBudget,
  getPdfJsRasterOptions,
  getPdfImportRasterScale,
  pdfRasterCanvasToPngDataUrl,
  releasePdfRasterCanvas,
  type PdfEncodedByteBudget,
  type PdfRasterBudget,
  type PdfPageRasterSize,
} from "./raster-limits";
import {
  awaitPdfOperation,
  pdfAbortError,
  reportPdfOperationProgress,
  throwIfPdfOperationAborted,
  type PdfOperationPhase,
  type PdfOperationProgressCallback,
} from "./operation-progress";
import { withPdfWorkerMimeQuery } from "./worker-url";

GlobalWorkerOptions.workerSrc = withPdfWorkerMimeQuery(pdfWorkerUrl);

// PDF.js 6.2.108 still consumes these legacy hardening flags at runtime, but
// its public DocumentInitParameters type no longer declares them. Keep the
// explicit values in the request while documenting the narrow compatibility
// cast at this wrapper boundary.
type SafePdfDocumentInitParameters = NonNullable<Parameters<typeof getDocument>[0]> & {
  enableScripting?: boolean;
  isEvalSupported?: boolean;
};

function localPdfStandardFontDataUrl(): string {
  // Keep the directory relative to the loaded application so both Vite dev
  // middleware and a copied static build resolve the same local assets.
  return new URL("./pdfjs/standard_fonts/", window.location.href).toString();
}

export interface PdfImportRasterUsage {
  encodedBytes: number;
  pixels: number;
}

export interface ImportedPdf {
  source: PdfDocumentSource;
  bytes: Uint8Array;
  scenes: SerializedScene[];
  /** Generated page-image resources retained by these scenes. */
  rasterUsage: Readonly<PdfImportRasterUsage>;
}

interface ParsedPdfPages {
  documentId: string;
  sourcePageCount: number;
  selectedPageCount: number;
  scenes: SerializedScene[];
  sourceSha256: string;
  rasterUsage: Readonly<PdfImportRasterUsage>;
}

export interface InspectedPdfFile {
  sha256: string;
  pageCount: number;
  /** Present only when the caller explicitly asks to retain the verified bytes. */
  bytes?: Uint8Array;
}

interface PdfDocumentProgressOptions {
  /** Structured progress for local UI. Positions are one-based; zero means document-level work. */
  onProgress?: PdfOperationProgressCallback;
  /** One-based position of this source document in a sequential batch. */
  documentPosition?: number;
  /** Total number of source documents in the sequential batch. */
  documentTotal?: number;
}

export interface InspectPdfFileOptions extends PdfDocumentProgressOptions {
  signal?: AbortSignal;
  /**
   * Retaining source bytes avoids one later local read but should only be used
   * by callers that can keep their complete batch within a bounded budget.
   */
  retainBytes?: boolean;
}

export interface ImportPdfOptions extends PdfDocumentProgressOptions {
  /** Abort an obsolete import when a newer open/navigation generation wins. */
  signal?: AbortSignal;
  /** Maximum number of pages that can still fit in the destination project. */
  maxPages?: number;
  /** Override the device-sensitive raster envelope in focused callers/tests. */
  rasterBudget?: Readonly<PdfRasterBudget>;
  /** Remaining project-wide pixel capacity available to generated page PNGs. */
  maxRasterPixelsForImport?: number;
  /** Remaining project-content budget available for generated page PNGs. */
  maxEncodedBytesPerDocument?: number;
  /** Existing immutable-document identity when identical source bytes are reused. */
  documentId?: string;
  /** Identity of this file occurrence, independent of source-byte deduplication. */
  sourceInstanceId?: string;
  /** Original local display name for this file occurrence. */
  sourceName?: string;
  /** Ordered zero-based source pages to import. Repeated indices are permitted. */
  sourcePageIndices?: readonly number[];
  /** Optional result from inspectPdfFile used to detect a changed local source. */
  inspection?: Readonly<Pick<InspectedPdfFile, "sha256" | "pageCount">>;
}

type PdfImportRasterState = PdfImportRasterUsage;

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PDF_HEADER_SCAN_BYTES = 1_024;

/** Detect a PDF from its bytes instead of trusting an extension or MIME label. */
export function hasPdfByteSignature(bytes: Uint8Array): boolean {
  const lastStart = Math.min(bytes.byteLength - PDF_HEADER.length, PDF_HEADER_SCAN_BYTES);
  for (let offset = 0; offset <= lastStart; offset += 1) {
    if (PDF_HEADER.every((byte, index) => bytes[offset + index] === byte)) return true;
  }
  return false;
}

function assertPdfByteSignature(bytes: Uint8Array): void {
  if (!hasPdfByteSignature(bytes)) {
    throw new Error("This file does not contain a valid PDF header. Choose a PDF file.");
  }
}

function validateDocumentProgress(options: PdfDocumentProgressOptions): void {
  const documentPosition = options.documentPosition ?? 1;
  const documentTotal = options.documentTotal ?? 1;
  if (
    !Number.isSafeInteger(documentPosition)
    || !Number.isSafeInteger(documentTotal)
    || documentPosition < 1
    || documentTotal < 1
    || documentPosition > documentTotal
  ) {
    throw new Error("The PDF batch progress position is invalid.");
  }
}

function assertSafePdfId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function normalizedSourceName(file: File, sourceName?: string): string {
  const name = sourceName ?? file.name;
  if (typeof name !== "string" || !name.trim()) throw new Error("The PDF source name is invalid.");
  return name;
}

function normalizeSelectedPageIndices(
  sourcePageIndices: readonly number[] | undefined,
  sourcePageCount: number,
): number[] {
  const indices = sourcePageIndices === undefined
    ? Array.from({ length: sourcePageCount }, (_, index) => index)
    : Array.from(sourcePageIndices);
  if (!indices.length) throw new Error("Select at least one PDF page to import.");
  if (indices.length > MAX_PDF_PAGES) {
    throw new Error(`The PDF selection has more than ${MAX_PDF_PAGES} pages.`);
  }
  for (const pageIndex of indices) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= sourcePageCount) {
      throw new Error("The PDF selection contains a source page that does not exist.");
    }
  }
  return indices;
}

function translatePdfLoadError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/password/i.test(message)) return new Error("Password-protected PDFs are not supported.");
  return error instanceof Error ? error : new Error(message);
}

function reportImportProgress(
  file: File,
  options: PdfDocumentProgressOptions & { signal?: AbortSignal },
  phase: PdfOperationPhase,
  pagePosition = 0,
  pageTotal = 0,
): void {
  reportPdfOperationProgress(options.onProgress, {
    operation: "import",
    phase,
    documentPosition: options.documentPosition ?? 1,
    documentTotal: options.documentTotal ?? 1,
    pagePosition,
    pageTotal,
    documentName: file.name,
  }, options.signal);
}

function safePdfDocumentParameters(
  bytes: Uint8Array,
  rasterBudget: Readonly<PdfRasterBudget>,
): SafePdfDocumentInitParameters {
  return {
    data: bytes,
    enableScripting: false,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: localPdfStandardFontDataUrl(),
    ...getPdfJsRasterOptions(rasterBudget),
  } as SafePdfDocumentInitParameters;
}

/**
 * Performs the lightweight dialog preflight without rasterizing any pages.
 * Full embedded-image and render-budget checks still run inside importPdf.
 */
export async function inspectPdfFile(
  file: File,
  options: InspectPdfFileOptions = {},
): Promise<InspectedPdfFile> {
  validateDocumentProgress(options);
  throwIfPdfOperationAborted(options.signal);
  if (file.size > MAX_PDF_BYTES) throw new Error("The PDF is larger than the PatterDraw limit.");

  reportImportProgress(file, options, "reading");
  const parseBytes = new Uint8Array(await awaitPdfOperation(file.arrayBuffer(), options.signal));
  throwIfPdfOperationAborted(options.signal);
  reportImportProgress(file, options, "validating");
  assertPdfByteSignature(parseBytes);
  const sha256 = await sha256Hex(parseBytes);
  throwIfPdfOperationAborted(options.signal);
  const retainedBytes = options.retainBytes ? parseBytes.slice() : undefined;

  reportImportProgress(file, options, "loading");
  const loadingTask = getDocument(safePdfDocumentParameters(
    parseBytes,
    getBrowserPdfRasterBudget(),
  ));
  let destroyPromise: Promise<unknown> | undefined;
  const destroyLoadingTask = (): Promise<unknown> => {
    destroyPromise ??= loadingTask.destroy();
    return destroyPromise;
  };
  const onAbort = () => { void destroyLoadingTask().catch(() => undefined); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const document = await awaitPdfOperation(loadingTask.promise, options.signal);
    throwIfPdfOperationAborted(options.signal);
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`The PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new Error("The PDF does not contain any importable pages.");
    }
    reportImportProgress(file, options, "validating", document.numPages, document.numPages);
    return {
      sha256,
      pageCount: document.numPages,
      ...(retainedBytes ? { bytes: retainedBytes } : {}),
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : pdfAbortError();
    }
    throw translatePdfLoadError(error);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await destroyLoadingTask();
  }
}

function assertRenderedPageBudget(
  canvasWidth: number,
  canvasHeight: number,
  dataURL: string,
  rasterBudget: Readonly<PdfRasterBudget>,
  encodedBudget: Readonly<PdfEncodedByteBudget>,
  state: PdfImportRasterState,
): void {
  const pixels = canvasWidth * canvasHeight;
  const encodedBytes = encodedDataUrlByteLength(dataURL);
  const nextPixels = state.pixels + pixels;
  const nextEncodedBytes = state.encodedBytes + encodedBytes;
  if (
    !Number.isSafeInteger(pixels)
    || pixels <= 0
    || canvasWidth > rasterBudget.maxEdge
    || canvasHeight > rasterBudget.maxEdge
    || pixels > rasterBudget.maxPixelsPerPage
    || encodedBytes > encodedBudget.maxBytesPerPage
    || !Number.isSafeInteger(nextPixels)
    || nextPixels > rasterBudget.maxPixelsPerDocument
    || !Number.isSafeInteger(nextEncodedBytes)
    || nextEncodedBytes > encodedBudget.maxBytesPerDocument
  ) {
    throw new Error("The PDF's rendered pages are too large to retain safely.");
  }
  state.pixels = nextPixels;
  state.encodedBytes = nextEncodedBytes;
}

function normalizedRotation(value: number): 0 | 90 | 180 | 270 {
  const rotation = ((value % 360) + 360) % 360;
  if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) return rotation;
  return 0;
}

async function renderPageScene(
  pdfDocument: PDFDocumentProxy,
  documentId: string,
  sourceInstanceId: string,
  pageIndex: number,
  sourceName: string,
  rasterScale: number,
  rasterBudget: Readonly<PdfRasterBudget>,
  encodedBudget: Readonly<PdfEncodedByteBudget>,
  rasterState: PdfImportRasterState,
  signal?: AbortSignal,
): Promise<SerializedScene> {
  throwIfPdfOperationAborted(signal);
  const page = await pdfDocument.getPage(pageIndex + 1);
  try {
    throwIfPdfOperationAborted(signal);
    const viewport = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: rasterScale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    try {
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser cannot render PDF pages.");

      const renderTask = page.render({ canvas, canvasContext: context, viewport: renderViewport });
      const onAbort = () => renderTask.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await renderTask.promise;
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : pdfAbortError();
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      throwIfPdfOperationAborted(signal);
      const sceneId = createLocalId();
      const backgroundElementId = createLocalId();
      const fileId = createLocalId() as FileId;
      const workspace: PdfPageWorkspace = {
        documentId,
        sourceInstanceId,
        sourceName,
        pageIndex,
        width: viewport.width,
        height: viewport.height,
        rotation: normalizedRotation(viewport.rotation),
        backgroundElementId,
      };
      const dataURL = pdfRasterCanvasToPngDataUrl(canvas) as DataURL;
      assertRenderedPageBudget(
        canvas.width || Math.ceil(renderViewport.width),
        canvas.height || Math.ceil(renderViewport.height),
        dataURL,
        rasterBudget,
        encodedBudget,
        rasterState,
      );
      throwIfPdfOperationAborted(signal);
      const file: BinaryFileData = {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: Date.now(),
      };
      const elements = convertToExcalidrawElements(
        [
          {
            id: backgroundElementId,
            type: "image",
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
            fileId,
            status: "saved",
            locked: true,
            strokeColor: "transparent",
            backgroundColor: "transparent",
            customData: {
              classroomRole: "pdf-background",
              pdfDocumentId: documentId,
              pdfPageIndex: pageIndex,
            },
          },
        ],
        { regenerateIds: false },
      );

      return {
        id: sceneId,
        name: `${sourceName} — page ${pageIndex + 1}`,
        elements: elements as unknown as readonly Record<string, unknown>[],
        appState: {
          viewBackgroundColor: "#f2f4f7",
          scrollX: 80,
          scrollY: 60,
          zoom: { value: 0.9 },
        },
        files: {
          [fileId]: file as unknown as Record<string, unknown>,
        },
        pdfPage: workspace,
      };
    } finally {
      // Also covers failures before PNG conversion (for example, a missing 2D
      // context or a rejected PDF.js render).
      releasePdfRasterCanvas(canvas);
    }
  } finally {
    page.cleanup();
  }
}

async function parsePdfPages(file: File, options: ImportPdfOptions = {}): Promise<ParsedPdfPages> {
  throwIfPdfOperationAborted(options.signal);
  const rasterBudget = options.rasterBudget ?? getBrowserPdfRasterBudget();
  const outputRasterBudget: Readonly<PdfRasterBudget> = {
    ...rasterBudget,
    maxPixelsPerDocument: Math.min(
      rasterBudget.maxPixelsPerDocument,
      options.maxRasterPixelsForImport ?? rasterBudget.maxPixelsPerDocument,
    ),
  };
  const outputEncodedBudget = getPdfImportEncodedByteBudget(
    rasterBudget,
    options.maxEncodedBytesPerDocument,
  );
  const sourceEncodedBudget = getPdfImportEncodedByteBudget(rasterBudget);
  const rasterOptions = getPdfJsRasterOptions(rasterBudget);
  reportImportProgress(file, options, "reading");
  const parseBytes = new Uint8Array(await awaitPdfOperation(file.arrayBuffer(), options.signal));
  throwIfPdfOperationAborted(options.signal);
  reportImportProgress(file, options, "validating");
  assertPdfByteSignature(parseBytes);
  const sourceSha256 = await sha256Hex(parseBytes);
  throwIfPdfOperationAborted(options.signal);
  if (options.inspection && sourceSha256 !== options.inspection.sha256) {
    throw new Error("The local PDF changed after it was selected.");
  }
  const { assertPdfEmbeddedImageLimit } = await import("./embedded-image-limits");
  reportImportProgress(file, options, "preflighting");
  await awaitPdfOperation(assertPdfEmbeddedImageLimit(parseBytes, rasterOptions.maxImageSize, {
    immutableSha256: sourceSha256,
    maxEdge: rasterBudget.maxEdge,
    maxTotalPixels: rasterBudget.maxPixelsPerDocument,
    maxTotalEncodedBytes: sourceEncodedBudget.maxBytesPerDocument,
    signal: options.signal,
  }), options.signal);
  throwIfPdfOperationAborted(options.signal);
  reportImportProgress(file, options, "loading");
  const loadingTask = getDocument({
    // PDF.js may transfer this buffer to its worker. Do not keep a second
    // full-size copy alive just to preserve the immutable source; reread the
    // local File only after the parser and its canvases have been released.
    ...safePdfDocumentParameters(parseBytes, rasterBudget),
    ...rasterOptions,
  } as SafePdfDocumentInitParameters);
  let destroyPromise: Promise<unknown> | undefined;
  const destroyLoadingTask = (): Promise<unknown> => {
    destroyPromise ??= loadingTask.destroy();
    return destroyPromise;
  };
  const onAbort = () => { void destroyLoadingTask().catch(() => undefined); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const document = await awaitPdfOperation(loadingTask.promise, options.signal);
    throwIfPdfOperationAborted(options.signal);
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`The PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new Error("The PDF does not contain any importable pages.");
    }
    if (options.inspection && document.numPages !== options.inspection.pageCount) {
      throw new Error("The local PDF changed after it was selected.");
    }
    const selectedPageIndices = normalizeSelectedPageIndices(
      options.sourcePageIndices,
      document.numPages,
    );
    if (options.maxPages !== undefined && selectedPageIndices.length > options.maxPages) {
      const noun = options.maxPages === 1 ? "page" : "pages";
      throw new Error(
        `This selection has ${selectedPageIndices.length} pages, but only ${options.maxPages} more ${noun} can fit in this project.`,
      );
    }
    const documentId = options.documentId ?? createLocalId();
    const sourceInstanceId = options.sourceInstanceId ?? createLocalId();
    const sourceName = normalizedSourceName(file, options.sourceName);
    const pageSizes: PdfPageRasterSize[] = [];
    for (let selectionIndex = 0; selectionIndex < selectedPageIndices.length; selectionIndex += 1) {
      const pageIndex = selectedPageIndices[selectionIndex];
      reportImportProgress(file, options, "measuring", selectionIndex + 1, selectedPageIndices.length);
      const page = await document.getPage(pageIndex + 1);
      try {
        throwIfPdfOperationAborted(options.signal);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      } finally {
        page.cleanup();
      }
    }
    const rasterScale = getPdfImportRasterScale(
      pageSizes,
      window.devicePixelRatio || 1,
      outputRasterBudget,
    );
    const scenes: SerializedScene[] = [];
    const rasterState: PdfImportRasterState = { encodedBytes: 0, pixels: 0 };
    for (let selectionIndex = 0; selectionIndex < selectedPageIndices.length; selectionIndex += 1) {
      const pageIndex = selectedPageIndices[selectionIndex];
      reportImportProgress(file, options, "rendering", selectionIndex + 1, selectedPageIndices.length);
      scenes.push(await renderPageScene(
        document,
        documentId,
        sourceInstanceId,
        pageIndex,
        sourceName,
        rasterScale,
        outputRasterBudget,
        outputEncodedBudget,
        rasterState,
        options.signal,
      ));
    }
    throwIfPdfOperationAborted(options.signal);
    return {
      documentId,
      sourcePageCount: document.numPages,
      selectedPageCount: selectedPageIndices.length,
      scenes,
      sourceSha256,
      rasterUsage: { ...rasterState },
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : pdfAbortError();
    }
    throw translatePdfLoadError(error);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await destroyLoadingTask();
  }
}

export async function importPdf(file: File, options: ImportPdfOptions = {}): Promise<ImportedPdf> {
  validateDocumentProgress(options);
  throwIfPdfOperationAborted(options.signal);
  if (file.size > MAX_PDF_BYTES) throw new Error("The PDF is larger than the PatterDraw limit.");
  if (
    options.maxPages !== undefined
    && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 0)
  ) {
    throw new Error("The remaining PDF page capacity is invalid.");
  }
  if (
    options.maxRasterPixelsForImport !== undefined
    && (!Number.isSafeInteger(options.maxRasterPixelsForImport)
      || options.maxRasterPixelsForImport < 0)
  ) {
    throw new Error("The remaining PDF raster capacity is invalid.");
  }
  if (options.maxRasterPixelsForImport === 0) {
    throw new Error("This project has no remaining image capacity for another PDF page.");
  }
  if (
    options.maxEncodedBytesPerDocument !== undefined
    && (!Number.isSafeInteger(options.maxEncodedBytesPerDocument)
      || options.maxEncodedBytesPerDocument < 0)
  ) {
    throw new Error("The PDF encoded-image byte limit is invalid.");
  }
  if (options.documentId !== undefined) assertSafePdfId(options.documentId, "The PDF document identity");
  if (options.sourceInstanceId !== undefined) {
    assertSafePdfId(options.sourceInstanceId, "The PDF source-instance identity");
  }
  normalizedSourceName(file, options.sourceName);
  if (options.sourcePageIndices !== undefined && !Array.isArray(options.sourcePageIndices)) {
    throw new Error("The PDF page selection must be a list.");
  }
  if (
    options.inspection
    && (
      typeof options.inspection.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(options.inspection.sha256)
      || !Number.isSafeInteger(options.inspection.pageCount)
      || options.inspection.pageCount < 1
      || options.inspection.pageCount > MAX_PDF_PAGES
    )
  ) {
    throw new Error("The inspected PDF metadata is invalid.");
  }

  const parsed = await parsePdfPages(file, options);
  throwIfPdfOperationAborted(options.signal);
  reportImportProgress(
    file,
    options,
    "validating",
    parsed.selectedPageCount,
    parsed.selectedPageCount,
  );
  const bytes = new Uint8Array(await awaitPdfOperation(file.arrayBuffer(), options.signal));
  if (bytes.byteLength !== file.size) {
    throw new Error("The local PDF changed while it was being imported.");
  }
  const sourceSha256 = await sha256Hex(bytes);
  throwIfPdfOperationAborted(options.signal);
  if (sourceSha256 !== parsed.sourceSha256) {
    throw new Error("The local PDF changed while it was being imported.");
  }
  return {
    source: {
      id: parsed.documentId,
      name: normalizedSourceName(file, options.sourceName),
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      sha256: sourceSha256,
      pageCount: parsed.sourcePageCount,
      archivePath: `documents/${parsed.documentId}.pdf`,
    },
    bytes,
    scenes: parsed.scenes,
    rasterUsage: parsed.rasterUsage,
  };
}
