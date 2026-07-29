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
import { getPdfImportRasterScale, type PdfPageRasterSize } from "./raster-limits";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ImportedPdf {
  source: PdfDocumentSource;
  bytes: Uint8Array;
  scenes: SerializedScene[];
}

function normalizedRotation(value: number): 0 | 90 | 180 | 270 {
  const rotation = ((value % 360) + 360) % 360;
  if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) return rotation;
  return 0;
}

function canvasToPngDataUrl(canvas: HTMLCanvasElement): DataURL {
  const dataURL = canvas.toDataURL("image/png");
  if (!dataURL.startsWith("data:image/png")) {
    throw new Error("This PDF page is too large for the browser to render safely.");
  }
  return dataURL as DataURL;
}

async function renderPageScene(
  pdfDocument: PDFDocumentProxy,
  documentId: string,
  pageIndex: number,
  name: string,
  rasterScale: number,
): Promise<SerializedScene> {
  const page = await pdfDocument.getPage(pageIndex + 1);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: rasterScale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser cannot render PDF pages.");

    await page.render({ canvas, canvasContext: context, viewport: renderViewport }).promise;
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
    const dataURL = canvasToPngDataUrl(canvas);
    canvas.width = 1;
    canvas.height = 1;
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
    page.cleanup();
  }
}

export async function importPdf(file: File): Promise<ImportedPdf> {
  if (file.type && file.type !== "application/pdf") throw new Error("Choose a PDF file.");
  if (file.size > MAX_PDF_BYTES) throw new Error("The PDF is larger than the classroom limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
  });

  let document: PDFDocumentProxy | null = null;
  try {
    document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`The PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    const documentId = createLocalId();
    const pageSizes: PdfPageRasterSize[] = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      } finally {
        page.cleanup();
      }
    }
    const rasterScale = getPdfImportRasterScale(pageSizes, window.devicePixelRatio || 1);
    const scenes: SerializedScene[] = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      scenes.push(await renderPageScene(document, documentId, pageIndex, file.name, rasterScale));
    }
    return {
      source: {
        id: documentId,
        name: file.name,
        mimeType: "application/pdf",
        byteLength: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        pageCount: document.numPages,
        archivePath: `documents/${documentId}.pdf`,
      },
      bytes,
      scenes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new Error("Password-protected PDFs are not supported.");
    throw error;
  } finally {
    await loadingTask.destroy();
  }
}
