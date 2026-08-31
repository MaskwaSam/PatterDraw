import { useRef, type RefObject } from "react";
import { useModalDialog } from "./useModalDialog";

export interface ProjectSwitchDialogProps {
  currentProjectTitle: string;
  nextFileName: string;
  onBackupAndOpen: () => void;
  onCancel: () => void;
  onOpenWithoutBackup: () => void;
  processing?: boolean;
  returnFocusRef?: RefObject<HTMLElement>;
}

/**
 * A deliberate three-way gate before one classroom project replaces another.
 * Cancel receives initial focus because replacing the live board is the only
 * potentially destructive choice in this dialog.
 */
export function ProjectSwitchDialog({
  currentProjectTitle,
  nextFileName,
  onBackupAndOpen,
  onCancel,
  onOpenWithoutBackup,
  processing = false,
  returnFocusRef,
}: ProjectSwitchDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog<HTMLDivElement>({
    initialFocusRef: cancelRef,
    onClose: () => {
      if (!processing) onCancel();
    },
    returnFocusRef,
  });

  return (
    <div
      className="modal-backdrop project-switch-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!processing) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="pdf-clear-annotations-dialog project-switch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-switch-title"
        aria-describedby="project-switch-description project-switch-safety"
        aria-busy={processing}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">Protect the current board</span>
            <h2 id="project-switch-title">Open another project?</h2>
          </div>
        </div>

        <p id="project-switch-description" className="pdf-clear-annotations-description">
          Opening <strong>{nextFileName}</strong> will replace <strong>{currentProjectTitle}</strong> in this tab.
        </p>
        <p id="project-switch-safety" className="pdf-clear-annotations-safety">
          Downloading a <strong>.patterdraw</strong> backup first is the safest choice. It preserves every board,
          slide, PDF source, annotation, and classroom-time setting in one portable file.
        </p>

        <div className="dialog-actions project-switch-actions">
          <button
            ref={cancelRef}
            className="dialog-cancel"
            type="button"
            disabled={processing}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="dialog-cancel project-switch-without-backup"
            type="button"
            disabled={processing}
            onClick={onOpenWithoutBackup}
          >
            Open without downloading
          </button>
          <button
            className="dialog-primary"
            type="button"
            disabled={processing}
            onClick={onBackupAndOpen}
          >
            {processing ? "Preparing backup…" : "Download backup & open"}
          </button>
        </div>
      </div>
    </div>
  );
}
