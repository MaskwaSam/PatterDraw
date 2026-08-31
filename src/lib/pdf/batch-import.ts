import type {
  ClassroomProject,
  LoadedClassroomProject,
  PdfDocumentId,
  PdfInsertionPlacement,
  SceneId,
} from "../../types";
import {
  MAX_PROJECT_BYTES,
} from "../safety";
import {
  assertProjectCanAcceptAdditionalBytes,
  assertProjectFitsContentBudget,
} from "../project-budget";
import {
  addLocalProjectRasterUsage,
  inspectLocalProjectRasterUsage,
  remainingLocalProjectRasterCapacity,
} from "../image-safety";
import {
  getBrowserPdfRasterBudget,
  type PdfRasterBudget,
} from "./raster-limits";
import {
  assertProjectCanAcceptPdfPages,
  remainingProjectPdfPageCapacity,
} from "./capacity";
import {
  buildPdfPageOrderAfterInsertion,
  type PdfImportSelection,
} from "./import-selection";
import type {
  ImportedPdf,
  ImportPdfOptions,
} from "./import-pdf";
import {
  throwIfPdfOperationAborted,
  type PdfOperationProgressCallback,
} from "./operation-progress";
import { reconcilePdfPageOrder } from "./page-order";

export interface AtomicPdfBatchImportOptions {
  signal?: AbortSignal;
  onProgress?: PdfOperationProgressCallback;
  /** Allows deterministic lower-budget tests without changing production limits. */
  maxProjectBytes?: number;
  /** Allows deterministic device-raster tests without changing production limits. */
  rasterBudget?: Readonly<PdfRasterBudget>;
  /** Test seam for proving failure atomicity without a browser PDF renderer. */
  importOne?: (file: File, options: ImportPdfOptions) => Promise<ImportedPdf>;
  now?: () => string;
}

export interface AtomicPdfBatchImportResult extends LoadedClassroomProject {
  insertedSceneIds: SceneId[];
}

/** Identifies the exact staged source that failed without exposing partial state. */
export class PdfBatchImportSelectionError extends Error {
  readonly selectionIndex: number;
  readonly sourceInstanceId: string;
  readonly fileName: string;
  override readonly cause: unknown;

  constructor(
    selectionIndex: number,
    selection: Pick<PdfImportSelection, "sourceInstanceId" | "file">,
    cause: unknown,
  ) {
    const detail = cause instanceof Error && cause.message
      ? cause.message
      : "This PDF could not be imported.";
    super(detail, { cause });
    this.name = "PdfBatchImportSelectionError";
    this.selectionIndex = selectionIndex;
    this.sourceInstanceId = selection.sourceInstanceId;
    this.fileName = selection.file.name;
    this.cause = cause;
  }
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || Boolean(
      error
      && typeof error === "object"
      && (error as { name?: unknown }).name === "AbortError",
    );
}

function totalSelectedPages(selections: readonly PdfImportSelection[]): number {
  let total = 0;
  const sourceInstances = new Set<string>();
  for (const selection of selections) {
    if (!selection.sourceInstanceId || sourceInstances.has(selection.sourceInstanceId)) {
      throw new Error("Each selected PDF must have a unique source identity.");
    }
    sourceInstances.add(selection.sourceInstanceId);
    if (!selection.sourcePageIndices.length) {
      throw new Error(`Select at least one page from ${selection.file.name}.`);
    }
    total += selection.sourcePageIndices.length;
    if (!Number.isSafeInteger(total)) throw new Error("The PDF selection is too large.");
  }
  if (!total) throw new Error("Select at least one PDF page to insert.");
  return total;
}

function documentIdBySha(project: ClassroomProject): Map<string, PdfDocumentId> {
  const result = new Map<string, PdfDocumentId>();
  for (const source of Object.values(project.pdfDocuments)) {
    if (source.sha256 && !result.has(source.sha256)) result.set(source.sha256, source.id);
  }
  return result;
}

function assertMatchingDeduplicatedSource(
  project: ClassroomProject,
  documentId: PdfDocumentId,
  selection: PdfImportSelection,
): void {
  const source = project.pdfDocuments[documentId];
  if (
    !source
    || source.sha256 !== selection.sha256
    || source.byteLength !== selection.file.size
    || source.pageCount !== selection.pageCount
  ) {
    throw new Error(`The stored PDF source does not match ${selection.file.name}.`);
  }
}

/**
 * Imports an ordered batch without mutating the supplied project or byte map.
 * Rendering happens sequentially to bound memory; only the returned aggregate
 * represents a commit. A rejection or AbortError therefore has no partial
 * project state for callers to apply.
 */
export async function importPdfBatchAtomically(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  selections: readonly PdfImportSelection[],
  placement: PdfInsertionPlacement,
  selectedPageId: SceneId | undefined,
  options: AtomicPdfBatchImportOptions = {},
): Promise<AtomicPdfBatchImportResult> {
  const selectedPageCount = totalSelectedPages(selections);
  assertProjectCanAcceptPdfPages(project, selectedPageCount);
  throwIfPdfOperationAborted(options.signal);

  const maxProjectBytes = options.maxProjectBytes ?? MAX_PROJECT_BYTES;
  const rasterBudget = options.rasterBudget ?? getBrowserPdfRasterBudget();
  let rasterUsage = await inspectLocalProjectRasterUsage(project, {
    rasterBudget,
    signal: options.signal,
  });
  let remainingRaster = remainingLocalProjectRasterCapacity(rasterUsage, rasterBudget);
  const importOne = options.importOne
    ?? (await import("./import-pdf")).importPdf;
  const knownDocumentIds = documentIdBySha(project);
  const currentOrder = reconcilePdfPageOrder(project);
  let stagedProject = project;
  let stagedPdfBytes = pdfBytes;
  const insertedSceneIds: SceneId[] = [];

  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    if (remainingRaster.pixels < 1 || remainingRaster.encodedBytes < 1) {
      throw new Error("This project has no remaining image capacity for another PDF page.");
    }
    const reusedDocumentId = knownDocumentIds.get(selection.sha256);
    if (reusedDocumentId) {
      assertMatchingDeduplicatedSource(stagedProject, reusedDocumentId, selection);
    }
    const additionalSourceBytes = reusedDocumentId ? 0 : selection.file.size;
    const currentSize = assertProjectCanAcceptAdditionalBytes(
      stagedProject,
      stagedPdfBytes,
      additionalSourceBytes,
      maxProjectBytes,
    );
    const maxEncodedBytesPerDocument = Math.min(
      remainingRaster.encodedBytes,
      Math.max(0, Math.floor(
        (maxProjectBytes - currentSize.totalBytes - additionalSourceBytes) * 3 / 4,
      )),
    );
    let imported: ImportedPdf;
    try {
      imported = await importOne(selection.file, {
        documentId: reusedDocumentId,
        documentPosition: index + 1,
        documentTotal: selections.length,
        inspection: {
          pageCount: selection.pageCount,
          sha256: selection.sha256,
        },
        maxEncodedBytesPerDocument,
        maxPages: remainingProjectPdfPageCapacity(stagedProject),
        maxRasterPixelsForImport: remainingRaster.pixels,
        onProgress: options.onProgress,
        rasterBudget,
        signal: options.signal,
        sourceInstanceId: selection.sourceInstanceId,
        sourceName: selection.sourceName ?? selection.file.name,
        sourcePageIndices: selection.sourcePageIndices,
      });
    } catch (error) {
      // Cancellation remains AbortError so existing operation teardown and UI
      // never mistake it for a compatibility-recovery opportunity.
      if (isAbortFailure(error, options.signal)) throw error;
      throw new PdfBatchImportSelectionError(index, selection, error);
    }
    throwIfPdfOperationAborted(options.signal);
    if (imported.source.sha256 !== selection.sha256) {
      throw new Error(`The local PDF ${selection.file.name} changed while it was being imported.`);
    }
    if (imported.scenes.length !== selection.sourcePageIndices.length) {
      throw new Error(`Not every selected page from ${selection.file.name} was imported.`);
    }
    rasterUsage = addLocalProjectRasterUsage(rasterUsage, imported.rasterUsage, rasterBudget);
    remainingRaster = remainingLocalProjectRasterCapacity(rasterUsage, rasterBudget);

    const documentId = reusedDocumentId ?? imported.source.id;
    if (reusedDocumentId && imported.source.id !== reusedDocumentId) {
      throw new Error(`The reused PDF source identity changed for ${selection.file.name}.`);
    }
    const scenes = Object.fromEntries(imported.scenes.map((scene) => [scene.id, scene]));
    const nextDocuments = reusedDocumentId
      ? stagedProject.pdfDocuments
      : { ...stagedProject.pdfDocuments, [documentId]: imported.source };
    const nextPdfBytes = reusedDocumentId
      ? stagedPdfBytes
      : { ...stagedPdfBytes, [documentId]: imported.bytes };
    stagedProject = {
      ...stagedProject,
      scenes: { ...stagedProject.scenes, ...scenes },
      pdfDocuments: nextDocuments,
    };
    stagedPdfBytes = nextPdfBytes;
    insertedSceneIds.push(...imported.scenes.map((scene) => scene.id));
    knownDocumentIds.set(selection.sha256, documentId);
    assertProjectFitsContentBudget(stagedProject, stagedPdfBytes, maxProjectBytes);
  }

  const pdfPageOrder = buildPdfPageOrderAfterInsertion(
    currentOrder,
    insertedSceneIds,
    placement,
    selectedPageId,
  );
  const nextProject: ClassroomProject = {
    ...stagedProject,
    updatedAt: options.now?.() ?? new Date().toISOString(),
    activeSceneId: insertedSceneIds[0],
    pdfPageOrder,
  };
  assertProjectFitsContentBudget(nextProject, stagedPdfBytes, maxProjectBytes);
  return {
    project: nextProject,
    pdfBytes: stagedPdfBytes,
    insertedSceneIds,
  };
}
