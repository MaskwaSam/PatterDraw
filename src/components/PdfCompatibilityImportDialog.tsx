import { useRef, type RefObject } from "react";
import type { PdfImportRecovery } from "../lib/pdf/import-compatibility";
import { useModalDialog } from "./useModalDialog";

export interface PdfCompatibilityImportDialogProps {
  fileNames: readonly string[];
  onCancel: () => void;
  onRetrySafetyCheck: () => void;
  onSelectConvertedCopy: (file: File) => void;
  processing?: boolean;
  recovery: PdfImportRecovery;
  returnFocusRef?: RefObject<HTMLElement>;
}

function fileSummary(fileNames: readonly string[]): string {
  if (fileNames.length === 1) return fileNames[0];
  return `${fileNames.length} selected PDFs`;
}

/** One-shot consent for a still-bounded PDF import compatibility pass. */
export function PdfCompatibilityImportDialog({
  fileNames,
  onCancel,
  onRetrySafetyCheck,
  onSelectConvertedCopy,
  processing = false,
  recovery,
  returnFocusRef,
}: PdfCompatibilityImportDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const convertedCopyInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog<HTMLDivElement>({
    initialFocusRef: cancelRef,
    onClose: () => {
      if (!processing) onCancel();
    },
    returnFocusRef,
  });

  return (
    <div
      className="modal-backdrop pdf-compatibility-import-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!processing) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="pdf-clear-annotations-dialog pdf-compatibility-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-compatibility-import-title"
        aria-describedby="pdf-compatibility-import-description pdf-compatibility-import-safety"
        aria-busy={processing}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">PDF import recovery</span>
            <h2 id="pdf-compatibility-import-title">
              {recovery.kind === "retry-safety-check"
                ? "Retry the PDF safety check?"
                : "Use a converted PDF copy?"}
            </h2>
          </div>
        </div>

        <p id="pdf-compatibility-import-description" className="pdf-clear-annotations-description">
          PatterDraw could not safely finish checking <strong>{fileSummary(fileNames)}</strong>.
          {" "}{recovery.explanation}
        </p>
        {recovery.kind === "choose-converted-copy" ? (
          <>
            <p id="pdf-compatibility-import-safety" className="pdf-clear-annotations-safety">
              This is not an unrestricted override. First use a trusted local tool such as Print to PDF to make
              an image-only copy with the same pages. Searchable text, forms, links, layers, and native PDF
              annotations may be flattened.
            </p>
            <p className="pdf-clear-annotations-description">
              PatterDraw will not decode or store the rejected original. It requires a different file with the exact
              same page count, rechecks that copy with every normal size and memory limit, and commits nothing unless
              the complete import succeeds.
            </p>
          </>
        ) : (
          <p id="pdf-compatibility-import-safety" className="pdf-clear-annotations-safety">
            Retrying does not bypass inspection. If the checker is still unavailable or the PDF exceeds a safety
            limit, the import remains blocked and nothing is added.
          </p>
        )}

        <div className="dialog-actions">
          <button
            ref={cancelRef}
            className="dialog-cancel"
            type="button"
            disabled={processing}
            onClick={onCancel}
          >
            Cancel
          </button>
          {recovery.kind === "retry-safety-check" ? (
            <button
              className="dialog-primary"
              type="button"
              disabled={processing}
              onClick={onRetrySafetyCheck}
            >
              {processing ? "Retrying safety check…" : "Retry safety check"}
            </button>
          ) : (
            <>
              <input
                ref={convertedCopyInputRef}
                className="visually-hidden"
                type="file"
                accept="application/pdf,.pdf,application/octet-stream"
                aria-label="Choose converted PDF copy"
                disabled={processing}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file && !processing) onSelectConvertedCopy(file);
                }}
              />
              <button
                className="dialog-primary"
                type="button"
                disabled={processing}
                onClick={() => convertedCopyInputRef.current?.click()}
              >
                {processing ? "Checking converted copy…" : "Choose converted PDF…"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
