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
  getPdfEmbeddedImagePixelBudget,
  getPdfImportEncodedByteBudget,
  getPdfJsRasterOptions,
  getPdfImportRasterScale,
  pdfRasterCanvasToPngDataUrl,
  releasePdfRasterCanvas,
  type PdfEncodedByteBudget,
  type PdfRasterBudget,
  type PdfPageRasterSize,
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

function localPdfStandardFontDataUrl(): string {
  // Keep the directory relative to the loaded application so both Vite dev
  // middleware and a copied static build resolve the same local assets.
  return new URL("./pdfjs/standard_fonts/", window.location.href).toString();
}

export interface ImportedPdf {
  source: PdfDocumentSource;
  bytes: Uint8Array;
  scenes: SerializedScene[];
}

interface ParsedPdfPages {
  documentId: string;
  pageCount: number;
  scenes: SerializedScene[];
  sourceSha256: string;
}

export interface ImportPdfOptions {
  /** Abort an obsolete import when a newer open/navigation generation wins. */
  signal?: AbortSignal;
  /** Override the device-sensitive raster envelope in focused callers/tests. */
  rasterBudget?: Readonly<PdfRasterBudget>;
  /** Remaining project-content budget available for generated page PNGs. */
  maxEncodedBytesPerDocument?: number;
  /** Remaining scene capacity in the destination project. */
  maxPages?: number;
}

interface PdfImportRasterState {
  encodedBytes: number;
  rasterPixels: number;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
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
  const nextPixels = state.rasterPixels + pixels;
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
  state.rasterPixels = nextPixels;
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
  pageIndex: number,
  name: string,
  rasterScale: number,
  rasterBudget: Readonly<PdfRasterBudget>,
  encodedBudget: Readonly<PdfEncodedByteBudget>,
  rasterState: PdfImportRasterState,
  signal?: AbortSignal,
): Promise<SerializedScene> {
  throwIfAborted(signal);
  const page = await pdfDocument.getPage(pageIndex + 1);
  try {
    throwIfAborted(signal);
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
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      throwIfAborted(signal);
      const sceneId = createLocalId();
      const backgroundElementId = createLocalId();
      const fileId = createLocalId() as FileId;
      const workspace: PdfPageWorkspace = {
        documentId,
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
      throwIfAborted(signal);
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
        name: `${name} — page ${pageIndex + 1}`,
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
  throwIfAborted(options.signal);
  const rasterBudget = options.rasterBudget ?? getBrowserPdfRasterBudget();
  const encodedBudget = getPdfImportEncodedByteBudget(
    rasterBudget,
    options.maxEncodedBytesPerDocument,
  );
  const rasterOptions = getPdfJsRasterOptions(rasterBudget);
  const parseBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(options.signal);
  const sourceSha256 = await sha256Hex(parseBytes);
  const { assertPdfEmbeddedImageLimit } = await import("./embedded-image-limits");
  await assertPdfEmbeddedImageLimit(parseBytes, rasterOptions.maxImageSize, {
    immutableSha256: sourceSha256,
    maxEdge: rasterBudget.maxEdge,
    maxTotalPixels: getPdfEmbeddedImagePixelBudget(rasterBudget),
    maxTotalEncodedBytes: encodedBudget.maxBytesPerDocument,
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  const loadingTask = getDocument({
    // PDF.js may transfer this buffer to its worker. Do not keep a second
    // full-size copy alive just to preserve the immutable source; reread the
    // local File only after the parser and its canvases have been released.
    data: parseBytes,
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
    destroyPromise ??= loadingTask.destroy();
    return destroyPromise;
  };
  const onAbort = () => { void destroyLoadingTask().catch(() => undefined); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const document = await awaitWithAbort(loadingTask.promise, options.signal);
    throwIfAborted(options.signal);
    const maxPages = options.maxPages ?? MAX_PDF_PAGES;
    if (document.numPages > maxPages) {
      throw new Error(`The PDF has more than the ${maxPages}-page capacity remaining in this project.`);
    }
    const documentId = createLocalId();
    const pageSizes: PdfPageRasterSize[] = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      throwIfAborted(options.signal);
      const page = await document.getPage(pageIndex + 1);
      try {
        throwIfAborted(options.signal);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      } finally {
        page.cleanup();
      }
    }
    const rasterScale = getPdfImportRasterScale(
      pageSizes,
      window.devicePixelRatio || 1,
      rasterBudget,
    );
    const scenes: SerializedScene[] = [];
    const rasterState: PdfImportRasterState = { encodedBytes: 0, rasterPixels: 0 };
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      throwIfAborted(options.signal);
      scenes.push(await renderPageScene(
        document,
        documentId,
        pageIndex,
        file.name,
        rasterScale,
        rasterBudget,
        encodedBudget,
        rasterState,
        options.signal,
      ));
    }
    throwIfAborted(options.signal);
    return { documentId, pageCount: document.numPages, scenes, sourceSha256 };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : abortError();
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new Error("Password-protected PDFs are not supported.");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await destroyLoadingTask();
  }
}

export async function importPdf(file: File, options: ImportPdfOptions = {}): Promise<ImportedPdf> {
  throwIfAborted(options.signal);
  if (file.type && file.type !== "application/pdf") throw new Error("Choose a PDF file.");
  if (file.size > MAX_PDF_BYTES) throw new Error("The PDF is larger than the PatterDraw limit.");
  if (
    options.maxEncodedBytesPerDocument !== undefined
    && (!Number.isSafeInteger(options.maxEncodedBytesPerDocument)
      || options.maxEncodedBytesPerDocument < 0)
  ) {
    throw new Error("The PDF encoded-image byte limit is invalid.");
  }
  if (
    options.maxPages !== undefined
    && (!Number.isSafeInteger(options.maxPages)
      || options.maxPages <= 0
      || options.maxPages > MAX_PDF_PAGES)
  ) {
    throw new Error("The PDF page limit is invalid.");
  }

  const parsed = await parsePdfPages(file, options);
  throwIfAborted(options.signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new Error("The local PDF changed while it was being imported.");
  }
  const sourceSha256 = await sha256Hex(bytes);
  throwIfAborted(options.signal);
  if (sourceSha256 !== parsed.sourceSha256) {
    throw new Error("The local PDF changed while it was being imported.");
  }
  return {
    source: {
      id: parsed.documentId,
      name: file.name,
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      sha256: sourceSha256,
      pageCount: parsed.pageCount,
      archivePath: `documents/${parsed.documentId}.pdf`,
    },
    bytes,
    scenes: parsed.scenes,
  };
}
