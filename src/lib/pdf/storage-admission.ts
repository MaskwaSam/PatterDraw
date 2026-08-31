import type { ClassroomProject, PdfDocumentId } from "../../types";
import { getProjectContentSize } from "../project-budget";

const MEBIBYTE = 1024 * 1024;

/**
 * Browser quota estimates are approximate and can change between the estimate
 * and IndexedDB's commit. Keep a small, bounded reserve without multiplying a
 * large classroom PDF into an unnecessarily large admission requirement.
 */
export const PDF_STORAGE_ADMISSION_MIN_HEADROOM_BYTES = MEBIBYTE;
export const PDF_STORAGE_ADMISSION_MAX_HEADROOM_BYTES = 8 * MEBIBYTE;
export const PDF_STORAGE_ADMISSION_HEADROOM_RATIO = 0.1;

export interface PdfStorageAdmissionRequirement {
  /** Exact complete logical size of the project before the PDF operation. */
  currentContentBytes: number;
  /** Exact complete logical size after rendered scenes/files and PDF bytes exist. */
  candidateContentBytes: number;
  /** Positive final-size growth only; existing/deduplicated content is not counted twice. */
  additionalContentBytes: number;
  /** Bounded reserve for IndexedDB/browser quota-estimate overhead. */
  safetyHeadroomBytes: number;
  /** Bytes passed to navigator.storage admission. */
  requiredBytes: number;
}

export interface PdfStorageAdmissionOptions {
  /**
   * Exact size of the last durably saved project, when it differs from the
   * current live project. This prevents unsaved edits from being mistaken for
   * already occupied storage. Values above the current live size are clamped
   * conservatively to the current live size.
   */
  persistedContentBytes?: number;
  /** Focused deterministic-test seams; production uses the constants above. */
  minimumHeadroomBytes?: number;
  maximumHeadroomBytes?: number;
  headroomRatio?: number;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
}

/**
 * Measure the post-render candidate rather than estimating from source PDF
 * file sizes. getProjectContentSize walks the complete persisted manifest, so
 * encoded page backgrounds and any stored thumbnails/files are included.
 * Comparing complete before/after payloads naturally handles SHA-deduplicated
 * PDF sources and same-sized source replacement without double-counting them.
 */
export function getPdfStorageAdmissionRequirement(
  currentProject: ClassroomProject,
  currentPdfBytes: Record<PdfDocumentId, Uint8Array>,
  candidateProject: ClassroomProject,
  candidatePdfBytes: Record<PdfDocumentId, Uint8Array>,
  options: PdfStorageAdmissionOptions = {},
): Readonly<PdfStorageAdmissionRequirement> {
  const current = getProjectContentSize(currentProject, currentPdfBytes);
  const candidate = getProjectContentSize(candidateProject, candidatePdfBytes);
  const persistedContentBytes = options.persistedContentBytes ?? current.totalBytes;
  const minimumHeadroomBytes = options.minimumHeadroomBytes
    ?? PDF_STORAGE_ADMISSION_MIN_HEADROOM_BYTES;
  const maximumHeadroomBytes = options.maximumHeadroomBytes
    ?? PDF_STORAGE_ADMISSION_MAX_HEADROOM_BYTES;
  const headroomRatio = options.headroomRatio ?? PDF_STORAGE_ADMISSION_HEADROOM_RATIO;

  assertNonNegativeSafeInteger(persistedContentBytes, "Persisted project size");
  assertNonNegativeSafeInteger(minimumHeadroomBytes, "Minimum PDF storage reserve");
  assertNonNegativeSafeInteger(maximumHeadroomBytes, "Maximum PDF storage reserve");
  if (
    maximumHeadroomBytes < minimumHeadroomBytes
    || !Number.isFinite(headroomRatio)
    || headroomRatio < 0
    || headroomRatio > 1
  ) {
    throw new Error("The PDF storage reserve is invalid.");
  }

  // A stale/larger persistence receipt cannot prove that arbitrary bytes in
  // browser storage belong to this current project. Clamp it to the exact live
  // payload, while a smaller receipt correctly includes unsaved live growth.
  const durableBaselineBytes = Math.min(persistedContentBytes, current.totalBytes);
  const additionalContentBytes = Math.max(
    0,
    candidate.totalBytes - durableBaselineBytes,
  );
  const proportionalHeadroom = Math.ceil(additionalContentBytes * headroomRatio);
  const safetyHeadroomBytes = Math.min(
    maximumHeadroomBytes,
    Math.max(minimumHeadroomBytes, proportionalHeadroom),
  );
  const requiredBytes = additionalContentBytes + safetyHeadroomBytes;
  if (!Number.isSafeInteger(requiredBytes)) {
    throw new Error("The PDF storage requirement is too large to measure safely.");
  }

  return Object.freeze({
    currentContentBytes: current.totalBytes,
    candidateContentBytes: candidate.totalBytes,
    additionalContentBytes,
    safetyHeadroomBytes,
    requiredBytes,
  });
}
