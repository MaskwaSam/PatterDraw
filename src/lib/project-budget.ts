import type { ClassroomProject, PdfDocumentId } from "../types";
import { MAX_PROJECT_BYTES } from "./safety";

const textEncoder = new TextEncoder();

export interface ProjectContentSize {
  manifestBytes: number;
  pdfBytes: number;
  totalBytes: number;
}

/**
 * Measures the complete uncompressed payload used by both autosave and the
 * portable project archive. Callers must sanitize and validate the project
 * before measuring it.
 */
export function getProjectContentSize(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
): ProjectContentSize {
  const manifestBytes = textEncoder.encode(JSON.stringify(project, null, 2)).byteLength;
  let pdfBytes = 0;

  for (const [id, source] of Object.entries(project.pdfDocuments)) {
    const bytes = pdfData[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    pdfBytes += bytes.byteLength;
    if (!Number.isSafeInteger(pdfBytes)) {
      throw new Error("The complete project is too large to save safely.");
    }
  }

  const totalBytes = manifestBytes + pdfBytes;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error("The complete project is too large to save safely.");
  }
  return { manifestBytes, pdfBytes, totalBytes };
}

export function assertProjectFitsContentBudget(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  maxBytes = MAX_PROJECT_BYTES,
): ProjectContentSize {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  const size = getProjectContentSize(project, pdfData);
  if (size.totalBytes > maxBytes) {
    throw new Error("The complete project is too large to save safely.");
  }
  return size;
}

export function assertProjectCanAcceptAdditionalBytes(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  additionalBytes: number,
  maxBytes = MAX_PROJECT_BYTES,
): ProjectContentSize {
  if (
    !Number.isSafeInteger(additionalBytes)
    || additionalBytes < 0
    || !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
  ) {
    throw new Error("The project size limit is invalid.");
  }
  const size = getProjectContentSize(project, pdfData);
  if (
    !Number.isSafeInteger(size.totalBytes + additionalBytes)
    || size.totalBytes + additionalBytes > maxBytes
  ) {
    throw new Error("The complete project is too large to save safely.");
  }
  return size;
}
