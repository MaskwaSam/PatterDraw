import { useEffect, useRef } from "react";
import { ProtractorIcon, RulerIcon } from "./Icons";
import { createDualScaleRulerAsset } from "../lib/math-tools/ruler";
import { createProtractorAsset } from "../lib/math-tools/protractor";

const RULER_PREVIEW = createDualScaleRulerAsset();
const PROTRACTOR_PREVIEW = createProtractorAsset();

interface MathToolsDialogProps {
  onCancel: () => void;
  onInsertProtractor: () => void;
  onInsertRuler: () => void;
}

export function MathToolsDialog({ onCancel, onInsertProtractor, onInsertRuler }: MathToolsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((control) => control.getClientRects().length > 0);
      if (!controls.length) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeyDown, true);
    return () => window.removeEventListener("keydown", handleDialogKeyDown, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="math-tools-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="math-tools-title"
        aria-describedby="math-tools-help"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">Classroom manipulatives</span>
            <h2 id="math-tools-title">Math tools</h2>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close math tools">×</button>
        </div>
        <p id="math-tools-help" className="math-tools-help">Add a movable, rotatable tool to the current board or page.</p>
        <div className="math-tools-grid" role="group" aria-label="Available math tools">
          <button
            className="math-tool-card"
            type="button"
            data-testid="math-tool-ruler"
            aria-labelledby="math-tool-ruler-title"
            aria-describedby="math-tool-ruler-scale math-tool-ruler-help"
            autoFocus
            onClick={onInsertRuler}
          >
            <span className="math-tool-card-heading"><RulerIcon /><strong id="math-tool-ruler-title">Ruler</strong></span>
            <img src={RULER_PREVIEW.dataUrl} alt="" />
            <span id="math-tool-ruler-scale">12 inches / 30 centimetres</span>
            <small id="math-tool-ruler-help">Inserted at the same 72-point-per-inch scale as a standard Letter PDF. Resizing changes the measurement scale.</small>
          </button>
          <button
            className="math-tool-card"
            type="button"
            data-testid="math-tool-protractor"
            aria-labelledby="math-tool-protractor-title"
            aria-describedby="math-tool-protractor-scale math-tool-protractor-help"
            onClick={onInsertProtractor}
          >
            <span className="math-tool-card-heading"><ProtractorIcon /><strong id="math-tool-protractor-title">Protractor</strong></span>
            <img src={PROTRACTOR_PREVIEW.dataUrl} alt="" />
            <span id="math-tool-protractor-scale">6 inches / 180 degrees</span>
            <small id="math-tool-protractor-help">Inserted at the same 72-point-per-inch scale as a standard Letter PDF. Resizing changes the measurement scale.</small>
          </button>
        </div>
      </section>
    </div>
  );
}
