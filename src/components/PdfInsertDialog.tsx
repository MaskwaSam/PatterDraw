import { useMemo, useRef, useState, type RefObject } from "react";
import { parsePdfPageRange as parseCorePdfPageRange } from "../lib/pdf/import-selection";
import type { PdfInsertionPlacement } from "../types";
import { DownIcon, TrashIcon, UpIcon } from "./Icons";
import { useModalDialog } from "./useModalDialog";

export type PdfInsertPlacement = PdfInsertionPlacement;

export interface PdfInsertFileRowMetadata {
  id: string;
  name: string;
  pageCount: number;
  rangeText: string;
}

export interface PdfInsertSelection {
  id: string;
  /** Zero-based source page indices. Repeats are intentional and preserved. */
  pageIndices: number[];
}

export interface PdfInsertSubmission {
  selections: PdfInsertSelection[];
  placement: PdfInsertPlacement;
}

export interface PdfInsertOperationProgress {
  phase: string;
  documentPosition: number;
  documentTotal: number;
  pagePosition: number;
  pageTotal: number;
  message?: string;
}

interface PdfInsertDialogProps {
  files: readonly PdfInsertFileRowMetadata[];
  remainingPageCapacity: number;
  onCancel: () => void;
  onSubmit: (submission: PdfInsertSubmission) => void;
  processing?: boolean;
  cancelling?: boolean;
  progress?: PdfInsertOperationProgress | null;
  onCancelProcessing?: () => void;
  returnFocusRef?: RefObject<HTMLElement>;
}

interface ParsedPageRange {
  pageIndices: number[];
  error: string | null;
}

export function defaultPdfPageRange(pageCount: number): string {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return "";
  return pageCount === 1 ? "1" : `1-${pageCount}`;
}

/**
 * Parse a human-facing, one-based page range while preserving the user's
 * order and intentional repeats. The import pipeline consumes zero-based
 * source page indices.
 */
export function parsePdfPageRange(rangeText: string, pageCount: number): ParsedPageRange {
  const source = rangeText.trim();
  if (!source) return { pageIndices: [], error: "Enter at least one page." };
  try {
    return { pageIndices: parseCorePdfPageRange(source, pageCount), error: null };
  } catch (reason) {
    return {
      pageIndices: [],
      error: reason instanceof Error ? reason.message : "The PDF page range is invalid.",
    };
  }
}

function progressLabel(progress: PdfInsertOperationProgress | null | undefined): string {
  if (!progress) return "Preparing PDF pages…";
  const parts = [progress.phase];
  if (progress.documentTotal > 0) {
    parts.push(`Document ${Math.min(progress.documentPosition, progress.documentTotal)} of ${progress.documentTotal}`);
  }
  if (progress.pageTotal > 0) {
    parts.push(`Page ${Math.min(progress.pagePosition, progress.pageTotal)} of ${progress.pageTotal}`);
  }
  return parts.filter(Boolean).join(" · ");
}

export function PdfInsertDialog({
  files,
  remainingPageCapacity,
  onCancel,
  onSubmit,
  processing = false,
  cancelling = false,
  progress,
  onCancelProcessing,
  returnFocusRef,
}: PdfInsertDialogProps) {
  const [rows, setRows] = useState<PdfInsertFileRowMetadata[]>(() => files.map((file) => ({
    ...file,
    rangeText: file.rangeText || defaultPdfPageRange(file.pageCount),
  })));
  const [placement, setPlacement] = useState<PdfInsertPlacement>("after");
  const firstRangeRef = useRef<HTMLInputElement>(null);
  const closeOrCancel = () => {
    if (processing) onCancelProcessing?.();
    else onCancel();
  };
  const dialogRef = useModalDialog<HTMLFormElement>({
    initialFocusRef: firstRangeRef,
    onClose: closeOrCancel,
    returnFocusRef,
  });
  const parsedRows = useMemo(() => rows.map((row) => ({
    row,
    parsed: parsePdfPageRange(row.rangeText, row.pageCount),
  })), [rows]);
  const selectedPageCount = parsedRows.reduce((total, item) => total + item.parsed.pageIndices.length, 0);
  const availableCapacity = Number.isSafeInteger(remainingPageCapacity)
    ? Math.max(0, remainingPageCapacity)
    : 0;
  const rangesValid = rows.length > 0 && parsedRows.every((item) => !item.parsed.error) && selectedPageCount > 0;
  const exceedsCapacity = rangesValid && selectedPageCount > availableCapacity;
  const valid = rangesValid && !exceedsCapacity;
  const status = progressLabel(progress);

  const updateRange = (id: string, rangeText: string) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, rangeText } : row));
  };
  const moveRow = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    setRows((current) => {
      const next = [...current];
      const [moving] = next.splice(index, 1);
      next.splice(targetIndex, 0, moving);
      return next;
    });
  };

  return (
    <div className="modal-backdrop pdf-insert-backdrop" role="presentation" onMouseDown={closeOrCancel}>
      <form
        ref={dialogRef}
        className="pdf-insert-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-insert-title"
        aria-describedby="pdf-insert-description"
        aria-busy={processing}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || processing) return;
          onSubmit({
            selections: parsedRows.map(({ row, parsed }) => ({
              id: row.id,
              pageIndices: parsed.pageIndices,
            })),
            placement,
          });
        }}
      >
        <div className="dialog-heading pdf-insert-heading">
          <div>
            <span className="dialog-kicker">PDF pages</span>
            <h2 id="pdf-insert-title">Insert PDF pages</h2>
          </div>
          <button
            className="dialog-close"
            type="button"
            onClick={closeOrCancel}
            disabled={processing && !onCancelProcessing}
            aria-label={processing ? "Cancel PDF insertion" : "Close PDF insertion"}
          >×</button>
        </div>
        <p id="pdf-insert-description" className="pdf-insert-description">
          Choose pages, arrange the source PDFs, and select where the new pages belong. Nothing changes until the whole batch succeeds.
        </p>

        <section className="pdf-insert-files" aria-labelledby="pdf-insert-files-heading">
          <div className="pdf-insert-section-heading">
            <h3 id="pdf-insert-files-heading">Source PDFs</h3>
            <span>{rows.length} {rows.length === 1 ? "file" : "files"}</span>
          </div>
          {rows.length ? (
            <ol className="pdf-insert-file-list">
              {parsedRows.map(({ row, parsed }, index) => {
                const rangeId = `pdf-insert-range-${row.id}`;
                const rangeHelpId = `${rangeId}-help`;
                const rangeErrorId = `${rangeId}-error`;
                return (
                  <li className="pdf-insert-file-row" key={row.id}>
                    <span className="pdf-insert-order" aria-hidden="true">{index + 1}</span>
                    <div className="pdf-insert-file-details">
                      <strong title={row.name}>{row.name}</strong>
                      <span>{row.pageCount} {row.pageCount === 1 ? "page" : "pages"}</span>
                    </div>
                    <label className="pdf-insert-range" htmlFor={rangeId}>
                      <span>Pages</span>
                      <input
                        ref={index === 0 ? firstRangeRef : undefined}
                        id={rangeId}
                        type="text"
                        inputMode="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={row.rangeText}
                        disabled={processing}
                        aria-invalid={parsed.error ? "true" : undefined}
                        aria-describedby={`${rangeHelpId}${parsed.error ? ` ${rangeErrorId}` : ""}`}
                        onChange={(event) => updateRange(row.id, event.currentTarget.value)}
                      />
                    </label>
                    <div className="pdf-insert-row-actions" aria-label={`Reorder or remove ${row.name}`}>
                      <button
                        type="button"
                        disabled={processing || index === 0}
                        aria-label={`Move ${row.name} earlier`}
                        title="Move earlier"
                        onClick={() => moveRow(index, -1)}
                      ><UpIcon /></button>
                      <button
                        type="button"
                        disabled={processing || index === rows.length - 1}
                        aria-label={`Move ${row.name} later`}
                        title="Move later"
                        onClick={() => moveRow(index, 1)}
                      ><DownIcon /></button>
                      <button
                        className="is-danger"
                        type="button"
                        disabled={processing}
                        aria-label={`Remove ${row.name}`}
                        title="Remove"
                        onClick={() => setRows((current) => current.filter((candidate) => candidate.id !== row.id))}
                      ><TrashIcon /></button>
                    </div>
                    <span id={rangeHelpId} className="pdf-insert-range-help">Example: 1-3, 5, 5</span>
                    {parsed.error ? <span id={rangeErrorId} className="pdf-insert-range-error" role="alert">{parsed.error}</span> : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="pdf-insert-empty" role="status">All source PDFs were removed. Cancel and choose files again.</p>
          )}
        </section>

        <fieldset className="pdf-insert-placement" disabled={processing}>
          <legend>Insert pages</legend>
          <label>
            <input type="radio" name="pdf-insert-placement" value="after" checked={placement === "after"} onChange={() => setPlacement("after")} />
            <span><strong>After selected page</strong><small>Recommended</small></span>
          </label>
          <label>
            <input type="radio" name="pdf-insert-placement" value="before" checked={placement === "before"} onChange={() => setPlacement("before")} />
            <span><strong>Before selected page</strong></span>
          </label>
          <label>
            <input type="radio" name="pdf-insert-placement" value="end" checked={placement === "end"} onChange={() => setPlacement("end")} />
            <span><strong>End of document</strong></span>
          </label>
        </fieldset>

        <div className={`pdf-insert-capacity ${exceedsCapacity ? "has-error" : ""}`} role={exceedsCapacity ? "alert" : "status"}>
          {exceedsCapacity ? (
            <>
              <strong>Too many pages selected.</strong>
              <span>
                This batch has {selectedPageCount} pages, which is {selectedPageCount - availableCapacity} more than the remaining capacity of {availableCapacity}. Remove pages or shorten the ranges.
              </span>
            </>
          ) : (
            <>
              <strong>{availableCapacity} page {availableCapacity === 1 ? "slot" : "slots"} available.</strong>
              <span>
                {rangesValid
                  ? `${availableCapacity - selectedPageCount} will remain after inserting this batch.`
                  : "The estimate updates after every valid page range."}
              </span>
            </>
          )}
        </div>

        {processing ? (
          <div className="pdf-insert-progress" role="status" aria-live="polite">
            <div><strong>{cancelling ? "Cancelling…" : status}</strong>{progress?.message ? <span>{progress.message}</span> : null}</div>
            <progress
              aria-label="PDF insertion progress"
              value={progress && progress.pageTotal > 0 ? Math.min(progress.pagePosition, progress.pageTotal) : undefined}
              max={progress && progress.pageTotal > 0 ? progress.pageTotal : undefined}
            />
          </div>
        ) : null}

        <div className="dialog-actions pdf-insert-actions">
          <span aria-live="polite">
            {valid
              ? `${selectedPageCount} ${selectedPageCount === 1 ? "page" : "pages"} selected from ${rows.length} ${rows.length === 1 ? "PDF" : "PDFs"}.`
              : exceedsCapacity
                ? `Reduce the selection by ${selectedPageCount - availableCapacity} ${selectedPageCount - availableCapacity === 1 ? "page" : "pages"} to continue.`
                : rows.length ? "Correct the page ranges to continue." : "Choose at least one PDF to continue."}
          </span>
          <button
            className="dialog-cancel"
            type="button"
            onClick={closeOrCancel}
            disabled={processing && (!onCancelProcessing || cancelling)}
          >{processing ? (cancelling ? "Cancelling…" : "Cancel insertion") : "Cancel"}</button>
          <button className="dialog-primary" type="submit" disabled={!valid || processing}>
            {processing ? "Inserting…" : `Insert ${selectedPageCount || ""} ${selectedPageCount === 1 ? "page" : "pages"}`.replace("  ", " ")}
          </button>
        </div>
      </form>
    </div>
  );
}
