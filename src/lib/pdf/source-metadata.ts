import { PDFDocument } from "pdf-lib";
import type {
  ClassroomProject,
  PdfDocumentId,
  PdfPageWorkspace,
  SerializedScene,
} from "../../types";
import { getSourcePageUserUnit, getVisibleSourcePageBox } from "./source-page";

/**
 * The workspace dimensions are persisted as PDF points after applying the
 * source page's UserUnit. Keep the same relative tolerance used by export so
 * harmless decimal serialization does not invalidate an otherwise faithful
 * project while a materially stale page cannot reach hydration/export.
 */
export const PDF_SOURCE_GEOMETRY_TOLERANCE = 0.005;

const MAX_VALIDATED_SOURCE_METADATA_ENTRIES = 64;
const validatedSourceMetadata = new Map<string, string>();

export interface PdfSourceMetadataPreflightOptions {
  /** Cancel an obsolete restore before another source page is parsed. */
  signal?: AbortSignal;
}

type PdfScene = SerializedScene & {
  pdfPage: NonNullable<SerializedScene["pdfPage"]>;
};

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : abortError();
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

function normalizedRotation(value: number): 0 | 90 | 180 | 270 | null {
  if (!Number.isFinite(value)) return null;
  const rotation = ((value % 360) + 360) % 360;
  if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) return rotation;
  return null;
}

function expectedWorkspaceGeometry(
  sourceBox: ReturnType<typeof getVisibleSourcePageBox>,
  sourceUserUnit: number,
  sourceRotation: 0 | 90 | 180 | 270,
): { width: number; height: number } {
  const sourceWidth = sourceBox.right - sourceBox.left;
  const sourceHeight = sourceBox.top - sourceBox.bottom;
  const width = (
    sourceRotation === 0 || sourceRotation === 180 ? sourceWidth : sourceHeight
  ) * sourceUserUnit;
  const height = (
    sourceRotation === 0 || sourceRotation === 180 ? sourceHeight : sourceWidth
  ) * sourceUserUnit;
  return { width, height };
}

function geometryMatches(actual: number, expected: number): boolean {
  const mismatch = Math.abs(actual / expected - 1);
  return Number.isFinite(mismatch) && mismatch <= PDF_SOURCE_GEOMETRY_TOLERANCE;
}

function sourcePageGeometryError(
  sourceName: string,
  pageIndex: number,
  workspace: PdfPageWorkspace,
  expected: { width: number; height: number },
  sourceRotation: number,
): Error {
  const dimensionsMatch = geometryMatches(workspace.width, expected.width)
    && geometryMatches(workspace.height, expected.height);
  const rotationMatch = workspace.rotation === sourceRotation;
  const detail = !dimensionsMatch
    ? `saved ${workspace.width}×${workspace.height}, source ${expected.width}×${expected.height}`
    : `saved rotation ${workspace.rotation}, source ${sourceRotation}`;
  return new Error(
    `The saved PDF page geometry no longer matches its original source page `
    + `(${sourceName}, page ${pageIndex + 1}: ${detail}).`,
  );
}

function retainedScenesByDocument(
  project: ClassroomProject,
): Map<PdfDocumentId, PdfScene[]> {
  const retained = new Map<PdfDocumentId, PdfScene[]>();
  for (const scene of Object.values(project.scenes)) {
    if (!scene.pdfPage) continue;
    const pages = retained.get(scene.pdfPage.documentId);
    if (pages) pages.push(scene as PdfScene);
    else retained.set(scene.pdfPage.documentId, [scene as PdfScene]);
  }
  return retained;
}

function sourceMetadataSignature(
  source: ClassroomProject["pdfDocuments"][string],
  scenes: readonly PdfScene[],
): string {
  return JSON.stringify({
    pageCount: source.pageCount,
    pages: scenes
      .map(({ id, pdfPage }) => ({
        id,
        pageIndex: pdfPage.pageIndex,
        width: pdfPage.width,
        height: pdfPage.height,
        rotation: pdfPage.rotation,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function cachedSourceMetadata(
  source: ClassroomProject["pdfDocuments"][string],
  scenes: readonly PdfScene[],
): boolean {
  if (!source.sha256) return false;
  const key = source.sha256.toLowerCase();
  const signature = sourceMetadataSignature(source, scenes);
  if (validatedSourceMetadata.get(key) !== signature) return false;
  // Keep frequently restored sources warm without growing the cache without
  // bound. This cache stores only tiny metadata signatures, never PDF bytes.
  validatedSourceMetadata.delete(key);
  validatedSourceMetadata.set(key, signature);
  return true;
}

function rememberSourceMetadata(
  source: ClassroomProject["pdfDocuments"][string],
  scenes: readonly PdfScene[],
): void {
  if (!source.sha256) return;
  const key = source.sha256.toLowerCase();
  validatedSourceMetadata.delete(key);
  validatedSourceMetadata.set(key, sourceMetadataSignature(source, scenes));
  while (validatedSourceMetadata.size > MAX_VALIDATED_SOURCE_METADATA_ENTRIES) {
    const oldest = validatedSourceMetadata.keys().next().value as string | undefined;
    if (!oldest) break;
    validatedSourceMetadata.delete(oldest);
  }
}

/**
 * Verify immutable PDF source metadata against the project manifest before a
 * restored scene can be hydrated or autosaved.
 *
 * The parser receives each project-owned Uint8Array directly. It is processed
 * one source at a time and released before the next source is opened; no
 * second full-size copy is created merely to preserve the caller's bytes.
 */
export async function assertPdfSourceMetadata(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  options: PdfSourceMetadataPreflightOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const scenesByDocument = retainedScenesByDocument(project);

  for (const [documentId, source] of Object.entries(project.pdfDocuments)) {
    throwIfAborted(options.signal);
    const bytes = pdfBytes[documentId];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`Loaded project is missing PDF data for ${source.name}.`);
    }
    const retainedScenes = scenesByDocument.get(documentId) || [];
    if (cachedSourceMetadata(source, retainedScenes)) continue;

    let sourceDocument: PDFDocument;
    try {
      // Pass the immutable project-owned buffer directly. PDFDocument parses
      // synchronously on the current thread and does not transfer/detach it
      // like a PDF.js worker load would.
      sourceDocument = await awaitWithAbort(
        PDFDocument.load(bytes, { updateMetadata: false }),
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason instanceof Error
        ? options.signal.reason
        : abortError();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`The source PDF ${source.name} could not be parsed safely: ${detail}`);
    }
    throwIfAborted(options.signal);
    const actualPageCount = sourceDocument.getPageCount();
    if (actualPageCount !== source.pageCount) {
      throw new Error(
        `The source PDF page count no longer matches its saved metadata for ${source.name} `
        + `(saved ${source.pageCount}, actual ${actualPageCount}).`,
      );
    }

    for (const scene of retainedScenes) {
      throwIfAborted(options.signal);
      const workspace = scene.pdfPage;
      if (
        !Number.isInteger(workspace.pageIndex)
        || workspace.pageIndex < 0
        || workspace.pageIndex >= actualPageCount
      ) {
        throw new Error(
          `The saved PDF page index no longer exists in ${source.name} `
          + `(page ${workspace.pageIndex + 1}).`,
        );
      }

      const sourcePage = sourceDocument.getPage(workspace.pageIndex);
      const sourceRotation = sourcePage.getRotation().angle;
      const normalizedSourceRotation = normalizedRotation(sourceRotation);
      if (normalizedSourceRotation === null) {
        throw sourcePageGeometryError(
          source.name,
          workspace.pageIndex,
          workspace,
          { width: Number.NaN, height: Number.NaN },
          sourceRotation,
        );
      }

      let expected: { width: number; height: number };
      try {
        expected = expectedWorkspaceGeometry(
          getVisibleSourcePageBox(sourcePage),
          getSourcePageUserUnit(sourcePage),
          normalizedSourceRotation,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `The source PDF page geometry could not be read safely for ${source.name} `
          + `(page ${workspace.pageIndex + 1}): ${detail}`,
        );
      }
      if (
        !Number.isFinite(expected.width)
        || expected.width <= 0
        || !Number.isFinite(expected.height)
        || expected.height <= 0
        || !geometryMatches(workspace.width, expected.width)
        || !geometryMatches(workspace.height, expected.height)
        || workspace.rotation !== normalizedSourceRotation
      ) {
        throw sourcePageGeometryError(
          source.name,
          workspace.pageIndex,
          workspace,
          expected,
          normalizedSourceRotation,
        );
      }
    }
    rememberSourceMetadata(source, retainedScenes);
  }
  throwIfAborted(options.signal);
}
