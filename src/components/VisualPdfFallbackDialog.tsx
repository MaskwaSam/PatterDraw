import { useRef, type RefObject } from "react";
import { useModalDialog } from "./useModalDialog";

export interface VisualPdfFallbackDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef?: RefObject<HTMLElement>;
}

/**
 * One-shot consent for the raster annotation path. The caller must render a
 * fresh dialog for every fallback export; this component deliberately exposes
 * no persistence or "remember" control.
 */
export function VisualPdfFallbackDialog({
  onCancel,
  onConfirm,
  returnFocusRef,
}: VisualPdfFallbackDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog<HTMLFormElement>({
    initialFocusRef: cancelRef,
    onClose: onCancel,
    returnFocusRef,
  });

  return (
    <div
      className="modal-backdrop pdf-clear-annotations-backdrop visual-pdf-fallback-backdrop"
      role="presentation"
      onMouseDown={onCancel}
    >
      <form
        ref={dialogRef}
        className="pdf-clear-annotations-dialog visual-pdf-fallback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="visual-pdf-fallback-title"
        aria-describedby="visual-pdf-fallback-description visual-pdf-fallback-limitations visual-pdf-fallback-consent"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="dialog-heading pdf-clear-annotations-heading">
          <div>
            <span className="dialog-kicker">PDF export fallback</span>
            <h2 id="visual-pdf-fallback-title">Use visual PDF fallback?</h2>
          </div>
        </div>

        <p id="visual-pdf-fallback-description" className="pdf-clear-annotations-description">
          PatterDraw could not complete the higher-fidelity PDF export for this document.
        </p>

        <p id="visual-pdf-fallback-limitations" className="pdf-clear-annotations-safety">
          The visual fallback keeps the original PDF pages but flattens PatterDraw annotations into page images. Fine details may look softer when zoomed, and annotation text and shapes will not be individually selectable or editable.
        </p>

        <p id="visual-pdf-fallback-consent" className="pdf-clear-annotations-description">
          This confirmation applies only to this export. PatterDraw will ask again every time and will not change your project or original source PDFs.
        </p>

        <div className="dialog-actions pdf-clear-annotations-actions">
          <button ref={cancelRef} className="dialog-cancel" type="button" onClick={onCancel}>Cancel</button>
          <button className="dialog-primary" type="submit">Continue with visual PDF</button>
        </div>
      </form>
    </div>
  );
}
