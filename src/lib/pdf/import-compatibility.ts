import type { ImportedPdf, ImportPdfOptions, InspectedPdfFile } from "./import-pdf";
import { importPdf, inspectPdfFile } from "./import-pdf";
import {
  pdfEmbeddedImageFailureCode,
  type PdfEmbeddedImageFailureCode,
} from "./embedded-image-limits";

export type PdfImportRecovery = Readonly<
  | {
    kind: "choose-converted-copy";
    code: Extract<
      PdfEmbeddedImageFailureCode,
      "source-image-over-budget" | "content-uninspectable" | "filtered-image-over-budget"
    >;
    explanation: string;
  }
  | {
    kind: "retry-safety-check";
    code: Extract<
      PdfEmbeddedImageFailureCode,
      "safety-worker-unavailable" | "safety-inspection-timeout"
    >;
    explanation: string;
  }
>;

export interface PdfCompatibilityConfirmation {
  accepted: true;
  /** UI must explicitly disclose loss of searchable/native PDF structure. */
  flatteningAcknowledged: true;
}

export interface ImportPdfCompatibilityCopyOptions
  extends Omit<ImportPdfOptions, "inspection" | "sourceName"> {
  /** The typed failure from the original, failed import attempt. */
  originalFailure: unknown;
  /** Identity observed before the rejected import began. */
  rejectedOriginalInspection: Readonly<Pick<InspectedPdfFile, "sha256" | "pageCount">>;
  /** Explicit user confirmation from the compatibility dialog. */
  confirmation: PdfCompatibilityConfirmation;
}

export interface ImportedPdfCompatibilityCopy {
  imported: ImportedPdf;
  original: Readonly<Pick<InspectedPdfFile, "sha256" | "pageCount"> & { name: string }>;
  converted: Readonly<Pick<InspectedPdfFile, "sha256" | "pageCount"> & { name: string }>;
  losses: readonly string[];
}

export function getPdfImportRecovery(error: unknown): PdfImportRecovery | null {
  const code = pdfEmbeddedImageFailureCode(error);
  if (
    code === "source-image-over-budget"
    || code === "content-uninspectable"
    || code === "filtered-image-over-budget"
  ) {
    return Object.freeze({
      kind: "choose-converted-copy" as const,
      code,
      explanation: "Choose a locally converted image-only or Print to PDF copy. PatterDraw will run the converted copy through every normal safety check before importing it.",
    });
  }
  if (code === "safety-worker-unavailable" || code === "safety-inspection-timeout") {
    return Object.freeze({
      kind: "retry-safety-check" as const,
      code,
      explanation: "The safety checker did not complete. Retry it before importing; choosing the same PDF again does not bypass this protection.",
    });
  }
  return null;
}

function compatibilityDisplayName(originalName: string): string {
  const trimmed = originalName.trim();
  const withoutPdf = trimmed.replace(/\.pdf$/i, "");
  return `${withoutPdf || "PDF"} (visual compatibility copy).pdf`;
}

/**
 * Import a teacher-provided, flattened/preconverted copy after a source PDF
 * failed embedded-image inspection. This is not a decoder override: both
 * files are re-read, page identity is matched, and the replacement runs
 * through the complete ordinary import pipeline and all fixed limits.
 *
 * The returned ImportedPdf contains only the verified converted source bytes.
 * The unsafe original is deliberately not persisted or handed to a decoder.
 */
export async function importPdfCompatibilityCopy(
  originalFile: File,
  convertedFile: File,
  options: ImportPdfCompatibilityCopyOptions,
): Promise<ImportedPdfCompatibilityCopy> {
  const recovery = getPdfImportRecovery(options.originalFailure);
  if (!recovery || recovery.kind !== "choose-converted-copy") {
    throw new Error("This PDF failure is not eligible for converted-copy import.");
  }
  if (
    options.confirmation?.accepted !== true
    || options.confirmation.flatteningAcknowledged !== true
  ) {
    throw new Error("Confirm the visual compatibility-copy limitations before importing.");
  }
  if (originalFile === convertedFile) {
    throw new Error("Choose a separate converted PDF copy, not the original file.");
  }
  const {
    originalFailure: _originalFailure,
    confirmation: _confirmation,
    rejectedOriginalInspection: _rejectedOriginalInspection,
    ...importOptions
  } = options;

  const original = await inspectPdfFile(originalFile, {
    signal: options.signal,
    onProgress: options.onProgress,
    documentPosition: options.documentPosition,
    documentTotal: options.documentTotal,
  });
  if (
    original.sha256 !== options.rejectedOriginalInspection.sha256
    || original.pageCount !== options.rejectedOriginalInspection.pageCount
  ) {
    throw new Error("The original PDF changed after its rejected import attempt.");
  }
  const converted = await inspectPdfFile(convertedFile, {
    signal: options.signal,
    onProgress: options.onProgress,
    documentPosition: options.documentPosition,
    documentTotal: options.documentTotal,
  });
  if (original.sha256 === converted.sha256) {
    throw new Error("The selected compatibility copy is identical to the rejected original PDF.");
  }
  if (original.pageCount !== converted.pageCount) {
    throw new Error(
      `The compatibility copy has ${converted.pageCount} pages, but the original has ${original.pageCount}. Convert the complete PDF so page order stays exact.`,
    );
  }

  const imported = await importPdf(convertedFile, {
    ...importOptions,
    inspection: converted,
    sourceName: compatibilityDisplayName(originalFile.name),
  });
  return {
    imported,
    original: Object.freeze({
      name: originalFile.name,
      sha256: original.sha256,
      pageCount: original.pageCount,
    }),
    converted: Object.freeze({
      name: convertedFile.name,
      sha256: converted.sha256,
      pageCount: converted.pageCount,
    }),
    losses: Object.freeze([
      "Searchable text may be flattened.",
      "Forms, links, layers, and native PDF annotations may be flattened.",
      "PatterDraw stores the verified compatibility copy, not the rejected original bytes.",
    ]),
  };
}
