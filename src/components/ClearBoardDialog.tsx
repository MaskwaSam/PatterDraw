import { useId, useRef, useState, type RefObject } from "react";
import { useModalDialog } from "./useModalDialog";
import "./ClearBoardDialog.css";

export interface ClearBoardDialogProps {
  objectCount: number;
  slideCount: number;
  processing?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocusRef?: RefObject<HTMLElement>;
}

export function ClearBoardDialog({
  objectCount,
  slideCount,
  processing = false,
  onCancel,
  onConfirm,
  returnFocusRef,
}: ClearBoardDialogProps) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledgedSlideCount, setAcknowledgedSlideCount] = useState<number | null>(null);
  const slidesAcknowledged = slideCount === 0 || acknowledgedSlideCount === slideCount;
  const canClear = objectCount > 0 && slidesAcknowledged && !processing;
  const cancel = () => { if (!processing) onCancel(); };
  const dialogRef = useModalDialog<HTMLFormElement>({
    initialFocusRef: cancelRef,
    onClose: cancel,
    returnFocusRef,
  });

  return (
    <div
      className="modal-backdrop clear-board-backdrop"
      role="presentation"
      onMouseDown={cancel}
    >
      <form
        ref={dialogRef}
        className="clear-board-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description ${id}-safety`}
        aria-busy={processing}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canClear) onConfirm();
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">Start fresh</span>
            <h2 id={`${id}-title`}>Clear main board?</h2>
          </div>
        </div>

        <p id={`${id}-description`} className="clear-board-description">
          This clears all <strong>{objectCount} {objectCount === 1 ? "object" : "objects"}</strong> on the main board,
          including off-screen content. PDF pages and your personal library are left untouched.
        </p>

        {slideCount > 0 ? (
          <label className="clear-board-slide-acknowledgement">
            <input
              type="checkbox"
              checked={slidesAcknowledged}
              disabled={processing}
              onChange={(event) => setAcknowledgedSlideCount(event.target.checked ? slideCount : null)}
            />
            <span>Also clear the {slideCount} {slideCount === 1 ? "slide" : "slides"} on this board</span>
          </label>
        ) : null}

        <p id={`${id}-safety`} className="clear-board-safety">
          An automatic local copy is saved in <strong>Recovery history</strong> before clearing.
          You can use <strong>Undo</strong> until you leave the board or reload,
          and Recovery history afterward.
        </p>

        <div className="dialog-actions clear-board-actions">
          <button
            ref={cancelRef}
            className="dialog-cancel"
            type="button"
            onClick={cancel}
            disabled={processing}
          >
            Cancel
          </button>
          <button className="dialog-danger" type="submit" disabled={!canClear}>
            {processing ? "Protecting board…" : "Clear board"}
          </button>
        </div>
      </form>
    </div>
  );
}
