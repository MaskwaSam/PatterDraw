import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  PdfAnnotationClearScope,
  PdfAnnotationScopeSummary,
} from "../lib/pdf/annotations";
import { useModalDialog } from "./useModalDialog";

export type {
  PdfAnnotationClearScope,
  PdfAnnotationScopeSummary,
} from "../lib/pdf/annotations";

export type PdfAnnotationScopeSummaries = Readonly<Record<
  PdfAnnotationClearScope,
  PdfAnnotationScopeSummary
>>;

export interface ClearPdfAnnotationsDialogProps {
  summaries: PdfAnnotationScopeSummaries;
  sourceName?: string;
  onCancel: () => void;
  onConfirm: (scope: PdfAnnotationClearScope) => void;
  processing?: boolean;
  returnFocusRef?: RefObject<HTMLElement>;
}

const SCOPE_ORDER: readonly PdfAnnotationClearScope[] = [
  "page",
  "source-document",
  "all-pdf-pages",
];

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function defaultScope(summaries: PdfAnnotationScopeSummaries): PdfAnnotationClearScope | null {
  return SCOPE_ORDER.find((scope) => summaries[scope].annotationCount > 0) ?? null;
}

function scopeLabel(scope: PdfAnnotationClearScope): string {
  if (scope === "page") return "This page";
  if (scope === "source-document") return "Pages from this source PDF";
  return "All PDF pages";
}

function scopeDescription(summary: PdfAnnotationScopeSummary, sourceName?: string): string {
  const source = summary.scope === "source-document" && sourceName ? ` · ${sourceName}` : "";
  return `${summary.annotationCount} ${plural(summary.annotationCount, "annotation")} on ${summary.affectedPageCount} affected ${plural(summary.affectedPageCount, "page")}${source}`;
}

export function ClearPdfAnnotationsDialog({
  summaries,
  sourceName,
  onCancel,
  onConfirm,
  processing = false,
  returnFocusRef,
}: ClearPdfAnnotationsDialogProps) {
  const [selectedScope, setSelectedScope] = useState<PdfAnnotationClearScope | null>(() => defaultScope(summaries));
  const initialRadioRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog<HTMLFormElement>({
    initialFocusRef: initialRadioRef,
    onClose: () => { if (!processing) onCancel(); },
    returnFocusRef,
  });
  const selectedSummary = selectedScope ? summaries[selectedScope] : null;
  const confirmCount = selectedSummary?.annotationCount ?? 0;
  const confirmLabel = `Clear ${confirmCount} ${plural(confirmCount, "annotation")}`;
  const descriptions = useMemo(() => Object.fromEntries(SCOPE_ORDER.map((scope) => [
    scope,
    scopeDescription(summaries[scope], sourceName),
  ])) as Record<PdfAnnotationClearScope, string>, [sourceName, summaries]);

  useEffect(() => {
    if (selectedScope && summaries[selectedScope].annotationCount > 0) return;
    setSelectedScope(defaultScope(summaries));
  }, [selectedScope, summaries]);

  return (
    <div
      className="modal-backdrop pdf-clear-annotations-backdrop"
      role="presentation"
      onMouseDown={() => { if (!processing) onCancel(); }}
    >
      <form
        ref={dialogRef}
        className="pdf-clear-annotations-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-clear-annotations-title"
        aria-describedby="pdf-clear-annotations-description pdf-clear-annotations-safety"
        aria-busy={processing}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedScope || confirmCount === 0 || processing) return;
          onConfirm(selectedScope);
        }}
      >
        <div className="dialog-heading pdf-clear-annotations-heading">
          <div>
            <span className="dialog-kicker">PDF page actions</span>
            <h2 id="pdf-clear-annotations-title">Clear annotations</h2>
          </div>
          <button
            className="dialog-close"
            type="button"
            onClick={onCancel}
            disabled={processing}
            aria-label="Close clear annotations"
          >×</button>
        </div>

        <p id="pdf-clear-annotations-description" className="pdf-clear-annotations-description">
          Choose which PatterDraw-created marks to remove.
        </p>

        <fieldset className="pdf-clear-annotation-scopes" disabled={processing}>
          <legend>Clear from</legend>
          {SCOPE_ORDER.map((scope) => {
            const summary = summaries[scope];
            const disabled = summary.annotationCount === 0;
            const inputId = `pdf-clear-annotations-${scope}`;
            const descriptionId = `${inputId}-summary`;
            return (
              <label key={scope} className={disabled ? "is-disabled" : undefined} htmlFor={inputId}>
                <input
                  ref={scope === defaultScope(summaries) ? initialRadioRef : undefined}
                  id={inputId}
                  name="pdf-clear-annotation-scope"
                  type="radio"
                  value={scope}
                  checked={selectedScope === scope}
                  disabled={disabled}
                  aria-describedby={descriptionId}
                  onChange={() => setSelectedScope(scope)}
                />
                <span>
                  <strong>{scopeLabel(scope)}</strong>
                  <small id={descriptionId}>{descriptions[scope]}</small>
                </span>
              </label>
            );
          })}
        </fieldset>

        <p id="pdf-clear-annotations-safety" className="pdf-clear-annotations-safety">
          This removes only marks created in PatterDraw. It does not remove text, forms, graphics, or annotations already contained in the original PDF.
        </p>

        <div className="dialog-actions pdf-clear-annotations-actions">
          <button className="dialog-cancel" type="button" onClick={onCancel} disabled={processing}>Cancel</button>
          <button
            className="dialog-primary is-danger"
            type="submit"
            disabled={!selectedScope || confirmCount === 0 || processing}
          >
            {processing ? "Clearing annotations…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
