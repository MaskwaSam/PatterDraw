import { useEffect, useRef, useState } from "react";
import type { RenderedLatex } from "../lib/latex/render-latex";

const SYMBOLS = [
  { label: "Fraction", value: "\\frac{}{}" },
  { label: "Square root", value: "\\sqrt{}" },
  { label: "Power", value: "^{}" },
  { label: "Pi", value: "\\pi" },
  { label: "Theta", value: "\\theta" },
  { label: "Sum", value: "\\sum_{}^{}" },
  { label: "Integral", value: "\\int_{}^{}" },
  { label: "Plus or minus", value: "\\pm" },
];

interface EquationDialogProps {
  initialSource: string;
  editing: boolean;
  onCancel: () => void;
  onSubmit: (rendered: RenderedLatex) => void;
}

export function EquationDialog({ initialSource, editing, onCancel, onSubmit }: EquationDialogProps) {
  const [source, setSource] = useState(initialSource);
  const [preview, setPreview] = useState<RenderedLatex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const trimmed = source.trim();
    if (!trimmed) {
      setPreview(null);
      setError(null);
      setRendering(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setRendering(true);
    const timer = window.setTimeout(() => {
      import("../lib/latex/render-latex")
        .then(({ renderLatexToSvg }) => renderLatexToSvg(trimmed, controller.signal))
        .then((result) => {
          if (!cancelled) {
            setPreview(result);
            setError(null);
          }
        })
        .catch((reason) => {
          if (!cancelled) {
            setPreview(null);
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        })
        .finally(() => { if (!cancelled) setRendering(false); });
    }, 260);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [source]);

  function insertSymbol(value: string): void {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? source.length;
    const end = textarea?.selectionEnd ?? source.length;
    const next = `${source.slice(0, start)}${value}${source.slice(end)}`;
    setSource(next);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + value.length, start + value.length);
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="equation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="equation-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (preview && !rendering) onSubmit(preview);
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">Offline MathJax</span>
            <h2 id="equation-title">{editing ? "Edit equation" : "Insert equation"}</h2>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close equation editor">×</button>
        </div>
        <label className="equation-label" htmlFor="latex-source">LaTeX</label>
        <textarea
          ref={textareaRef}
          id="latex-source"
          value={source}
          rows={5}
          autoFocus
          spellCheck={false}
          placeholder="Example: x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"
          onChange={(event) => setSource(event.target.value)}
        />
        <div className="equation-symbols" aria-label="Common LaTeX symbols">
          {SYMBOLS.map((symbol) => (
            <button key={symbol.label} type="button" onClick={() => insertSymbol(symbol.value)} title={symbol.label}>
              {symbol.value}
            </button>
          ))}
        </div>
        <div className={`equation-preview ${error ? "has-error" : ""}`} aria-live="polite">
          {rendering ? <span className="preview-message">Rendering preview…</span>
            : error ? <span className="preview-error">{error}</span>
              : preview ? <img src={preview.dataUrl} alt={`Preview of ${preview.source}`} />
                : <span className="preview-message">Enter an equation to preview it.</span>}
        </div>
        <p className="equation-help">Use math LaTeX without <code>$</code> delimiters. Links, HTML, external files, and custom command definitions are disabled.</p>
        <div className="dialog-actions">
          <button className="dialog-cancel" type="button" onClick={onCancel}>Cancel</button>
          <button className="dialog-primary" type="submit" disabled={!preview || rendering}>
            {editing ? "Update equation" : "Insert equation"}
          </button>
        </div>
      </form>
    </div>
  );
}
