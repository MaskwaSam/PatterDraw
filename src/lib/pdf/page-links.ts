import { getDocument } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../safety";
import { hasPdfByteSignature, safePdfDocumentParameters } from "./import-pdf";
import { sanitizePdfLinkUrl } from "./link-url";
import {
  awaitPdfOperation,
  throwIfPdfOperationAborted,
} from "./operation-progress";
import { getBrowserPdfRasterBudget } from "./raster-limits";

export { sanitizePdfLinkUrl } from "./link-url";

export interface PdfPageLink {
  url: string;
  /** Scale-one PDF.js display coordinates, including the source page rotation. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAX_PDF_PAGE_LINKS = 256;
const MAX_PDF_PAGE_ANNOTATIONS_TO_SCAN = 4_096;
const NON_DISPLAY_ANNOTATION_FLAGS = 1 | 2 | 32;

type LinkRectangle = Omit<PdfPageLink, "url">;
type LinkViewport = Pick<PageViewport, "width" | "height" | "convertToViewportPoint">;

/** Rotate/translate through the same viewport used by import, then clip to it. */
export function normalizePdfLinkRectangle(
  rectangle: unknown,
  viewport: LinkViewport,
): LinkRectangle | null {
  if (
    !Array.isArray(rectangle)
    || rectangle.length !== 4
    || !rectangle.every((value) => typeof value === "number" && Number.isFinite(value))
    || !Number.isFinite(viewport.width)
    || !Number.isFinite(viewport.height)
    || viewport.width <= 0
    || viewport.height <= 0
  ) return null;
  const [x1, y1, x2, y2] = rectangle as number[];
  const corners = [
    viewport.convertToViewportPoint(x1, y1),
    viewport.convertToViewportPoint(x2, y1),
    viewport.convertToViewportPoint(x1, y2),
    viewport.convertToViewportPoint(x2, y2),
  ];
  if (corners.some((corner) => corner.length !== 2 || !corner.every(Number.isFinite))) return null;
  const xs = corners.map((corner) => corner[0] as number);
  const ys = corners.map((corner) => corner[1] as number);
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  const right = Math.min(viewport.width, Math.max(...xs));
  const bottom = Math.min(viewport.height, Math.max(...ys));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Reads only the requested immutable source page. No targets are fetched and
 * no annotation HTML, actions, scripts, attachments, or forms are installed.
 */
export async function extractPdfPageLinks(
  bytes: Uint8Array,
  pageIndex: number,
  options: { signal?: AbortSignal } = {},
): Promise<PdfPageLink[]> {
  const { signal } = options;
  throwIfPdfOperationAborted(signal);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= MAX_PDF_PAGES) {
    throw new Error("The PDF link source page is invalid.");
  }
  if (bytes.byteLength > MAX_PDF_BYTES || !hasPdfByteSignature(bytes)) {
    throw new Error("The PDF link source bytes are invalid.");
  }

  // PDF.js may transfer its data buffer to the worker. Never detach retained
  // project bytes, which still serve autosave, project backup, and PDF export.
  const loadingTask = getDocument(safePdfDocumentParameters(
    bytes.slice(),
    getBrowserPdfRasterBudget(),
  ));
  let destroyPromise: Promise<unknown> | undefined;
  const destroyLoadingTask = (): Promise<unknown> => {
    destroyPromise ??= loadingTask.destroy();
    return destroyPromise;
  };
  const onAbort = () => { void destroyLoadingTask().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const document = await awaitPdfOperation(loadingTask.promise, signal);
    throwIfPdfOperationAborted(signal);
    if (!Number.isSafeInteger(document.numPages) || pageIndex >= document.numPages) {
      throw new Error("The PDF link source page does not exist.");
    }
    const page = await awaitPdfOperation(document.getPage(pageIndex + 1), signal);
    try {
      throwIfPdfOperationAborted(signal);
      const viewport = page.getViewport({ scale: 1 });
      const annotations: unknown[] = await awaitPdfOperation(
        page.getAnnotations({ intent: "display" }),
        signal,
      );
      throwIfPdfOperationAborted(signal);
      const links: PdfPageLink[] = [];
      for (const candidate of annotations.slice(0, MAX_PDF_PAGE_ANNOTATIONS_TO_SCAN)) {
        if (!candidate || typeof candidate !== "object") continue;
        const annotation = candidate as Record<string, unknown>;
        if (
          annotation.subtype !== "Link"
          || annotation.hidden === true
          || (typeof annotation.annotationFlags === "number"
            && (annotation.annotationFlags & NON_DISPLAY_ANNOTATION_FLAGS) !== 0)
        ) continue;
        // PDF.js's normalized `url` can add a protocol or strip controls. Check
        // its original string whenever present instead of trusting that repair.
        const url = sanitizePdfLinkUrl(annotation.unsafeUrl ?? annotation.url);
        const rectangle = normalizePdfLinkRectangle(annotation.rect, viewport);
        if (!url || !rectangle) continue;
        links.push({ url, ...rectangle });
        if (links.length >= MAX_PDF_PAGE_LINKS) break;
      }
      return links;
    } finally {
      page.cleanup();
    }
  } catch (error) {
    throwIfPdfOperationAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await destroyLoadingTask();
  }
}
