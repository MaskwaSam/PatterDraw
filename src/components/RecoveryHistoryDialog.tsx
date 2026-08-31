import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { AutosaveHistorySummary } from "../lib/autosave-history";
import { useModalDialog } from "./useModalDialog";

export interface RecoveryHistoryStatus {
  kind: "error" | "info" | "warning";
  message: string;
}

export interface RecoveryHistoryDialogProps {
  busy?: boolean;
  damagedSnapshotIds?: ReadonlySet<string>;
  entries: readonly AutosaveHistorySummary[];
  onClearAll: () => void;
  onClose: () => void;
  onDelete: (snapshotId: string) => void;
  onRecover: (snapshotId: string) => void;
  returnFocusRef?: RefObject<HTMLElement>;
  status?: RecoveryHistoryStatus | null;
  unreadableHistory?: boolean;
}

type PendingDeletion =
  | { kind: "selected"; snapshotId: string }
  | { kind: "all" }
  | null;

const EMPTY_DAMAGED_SNAPSHOT_IDS: ReadonlySet<string> = new Set();

function formattedBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formattedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function RecoveryHistoryDialog({
  busy = false,
  damagedSnapshotIds = EMPTY_DAMAGED_SNAPSHOT_IDS,
  entries,
  onClearAll,
  onClose,
  onDelete,
  onRecover,
  returnFocusRef,
  status = null,
  unreadableHistory = false,
}: RecoveryHistoryDialogProps) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState(entries[0]?.snapshotId ?? "");
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const listDescriptionId = useId();
  const dialogRef = useModalDialog<HTMLDivElement>({
    initialFocusRef: cancelRef,
    onClose: () => {
      if (!busy) {
        if (pendingDeletion) setPendingDeletion(null);
        else onClose();
      }
    },
    returnFocusRef,
  });

  useEffect(() => {
    if (entries.some((entry) => entry.snapshotId === selectedSnapshotId)) return;
    setSelectedSnapshotId(entries[0]?.snapshotId ?? "");
    setPendingDeletion(null);
  }, [entries, selectedSnapshotId]);

  useEffect(() => {
    if (!pendingDeletion) return;
    confirmationCancelRef.current?.focus();
  }, [pendingDeletion]);

  const selected = entries.find((entry) => entry.snapshotId === selectedSnapshotId) ?? null;
  const pendingSelected = pendingDeletion?.kind === "selected"
    ? entries.find((entry) => entry.snapshotId === pendingDeletion.snapshotId) ?? null
    : null;

  return (
    <div
      className="modal-backdrop recovery-history-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy && !pendingDeletion) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="recovery-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-history-title"
        aria-describedby={listDescriptionId}
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="recovery-history-heading">
          <div>
            <span className="dialog-kicker">Local classroom safety</span>
            <h2 id="recovery-history-title">Recovery history</h2>
          </div>
          <span>{unreadableHistory ? "Copies unavailable" : `${entries.length} of 6 copies`}</span>
        </header>

        <p id={listDescriptionId} className="recovery-history-description">
          These protected copies stay only in this browser. Choose any copy to recover or explicitly
          delete copies when this is a shared device.
        </p>

        {status ? (
          <p
            className={`recovery-history-status is-${status.kind}`}
            role={status.kind === "error" ? "alert" : "status"}
          >
            {status.message}
          </p>
        ) : null}

        {entries.length ? (
          <fieldset className="recovery-history-list" disabled={busy || pendingDeletion !== null}>
            <legend className="visually-hidden">Protected recovery copies</legend>
            {entries.map((entry) => {
              const damaged = damagedSnapshotIds.has(entry.snapshotId);
              return (
                <label
                  key={entry.snapshotId}
                  className={`recovery-history-entry ${damaged ? "is-damaged" : ""}`}
                >
                  <input
                    type="radio"
                    name="recovery-history-copy"
                    value={entry.snapshotId}
                    checked={selectedSnapshotId === entry.snapshotId}
                    onChange={() => setSelectedSnapshotId(entry.snapshotId)}
                  />
                  <span className="recovery-history-entry-copy">
                    <strong>{entry.title}</strong>
                    <span>
                      <time dateTime={entry.capturedAt}>{formattedDate(entry.capturedAt)}</time>
                      {" · "}{formattedBytes(entry.logicalBytes)}
                      {entry.pdfReferences.length
                        ? ` · ${entry.pdfReferences.length} source PDF${entry.pdfReferences.length === 1 ? "" : "s"}`
                        : ""}
                    </span>
                    {damaged ? (
                      <small>Damaged or incomplete. Recover will try an older copy of this board.</small>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <div className="recovery-history-empty" role="status">
            <strong>{unreadableHistory ? "Recovery history cannot be listed" : "No protected copies"}</strong>
            <span>
              {unreadableHistory
                ? "You can explicitly clear all local recovery data to repair this browser’s history."
                : "PatterDraw creates one before a classroom board is replaced."}
            </span>
          </div>
        )}

        {pendingDeletion ? (
          <section className="recovery-history-confirmation" role="alert" aria-live="assertive">
            <h3>Delete {pendingDeletion.kind === "all" ? "all recovery copies" : "this recovery copy"}?</h3>
            <p>
              {pendingDeletion.kind === "all"
                ? unreadableHistory
                  ? "This permanently removes all protected recovery data, including unlisted remnants, from this browser."
                  : `This permanently removes all ${entries.length} protected copies and their unused source PDFs from this browser.`
                : <>This permanently removes <strong>{pendingSelected?.title ?? "the selected copy"}</strong> and any source PDFs that no other recovery copy needs.</>}
              {" "}Your current board and downloaded <strong>.patterdraw</strong> files are not changed.
            </p>
            <div className="dialog-actions">
              <button
                ref={confirmationCancelRef}
                className="dialog-cancel"
                type="button"
                disabled={busy}
                onClick={() => setPendingDeletion(null)}
              >
                Keep recovery copies
              </button>
              <button
                className="dialog-danger"
                type="button"
                disabled={busy || (pendingDeletion.kind === "selected" && !pendingSelected)}
                onClick={() => {
                  if (pendingDeletion.kind === "all") onClearAll();
                  else if (pendingSelected) onDelete(pendingSelected.snapshotId);
                }}
              >
                {busy
                  ? "Deleting…"
                  : pendingDeletion.kind === "all"
                    ? unreadableHistory
                      ? "Delete all recovery data"
                      : `Delete all ${entries.length} ${entries.length === 1 ? "copy" : "copies"}`
                    : "Delete recovery copy"}
              </button>
            </div>
          </section>
        ) : (
          <div className="dialog-actions recovery-history-actions">
            <button
              ref={cancelRef}
              className="dialog-cancel"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              Close
            </button>
            <button
              className="dialog-cancel"
              type="button"
              disabled={busy || !selected}
              onClick={() => {
                if (selected) setPendingDeletion({ kind: "selected", snapshotId: selected.snapshotId });
              }}
            >
              Delete selected…
            </button>
            <button
              className="dialog-cancel"
              type="button"
              disabled={busy || (entries.length === 0 && !unreadableHistory)}
              onClick={() => setPendingDeletion({ kind: "all" })}
            >
              Delete all…
            </button>
            <button
              className="dialog-primary"
              type="button"
              disabled={busy || !selected}
              onClick={() => {
                if (selected) onRecover(selected.snapshotId);
              }}
            >
              {busy ? "Checking copy…" : "Recover selected"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
