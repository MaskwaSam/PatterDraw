import type { ClassroomProject, PdfDocumentId } from "../../types";
import { getProjectContentSize } from "../project-budget";
import { MAX_PROJECT_BYTES } from "../safety";
import {
  undoPdfAnnotationClear,
  type PdfAnnotationClearTransaction,
} from "./annotations";

export const PDF_ANNOTATION_UNDO_RESERVATION_ERROR =
  "This PDF cannot be added while annotation Undo is available because it would leave too little room to restore the cleared annotations. Use Undo now or wait a few seconds, then try again.";

export interface PdfAnnotationUndoReservationOptions {
  now?: number;
  maxBytes?: number;
}

/**
 * Preflight an additive PDF transaction against the state that a still-live
 * annotation Undo would restore. This prevents inserted source bytes from
 * consuming space that the visible Undo affordance has implicitly reserved.
 */
export function pdfAdditionPreservesAnnotationUndo(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  transaction: PdfAnnotationClearTransaction | undefined,
  options: PdfAnnotationUndoReservationOptions = {},
): boolean {
  if (!transaction) return true;
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? MAX_PROJECT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  if (now >= transaction.expiresAt) return true;
  const restored = undoPdfAnnotationClear(project, transaction, {
    now,
    updatedAt: project.updatedAt,
  });
  return getProjectContentSize(restored.project, pdfData).totalBytes <= maxBytes;
}

export function assertPdfAdditionPreservesAnnotationUndo(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  transaction: PdfAnnotationClearTransaction | undefined,
  options: PdfAnnotationUndoReservationOptions = {},
): void {
  if (!pdfAdditionPreservesAnnotationUndo(project, pdfData, transaction, options)) {
    throw new Error(PDF_ANNOTATION_UNDO_RESERVATION_ERROR);
  }
}
