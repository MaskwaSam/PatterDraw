import { useEffect, useRef, useState } from "react";
import { exportToBlob } from "@excalidraw/excalidraw";
import type { RenderedMermaid } from "../lib/mermaid/safe-mermaid";

const MERMAID_EXAMPLE = `flowchart LR
  A[Question] --> B{Ready?}
  B -->|Yes| C[Explain]
  B -->|No| D[Try an example]`;

interface MermaidDialogProps {
  initialSource: string;
  editing: boolean;
  onCancel: () => void;
  onSubmit: (rendered: RenderedMermaid) => void;
}

export function MermaidDialog({ initialSource, editing, onCancel, onSubmit }: MermaidDialogProps) {
  const [source, setSource] = useState(initialSource || MERMAID_EXAMPLE);
  const [preview, setPreview] = useState<RenderedMermaid | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => () => {
    requestRef.current += 1;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function clearPreview(): void {
    requestRef.current += 1;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreview(null);
    setError(null);
    setRendering(false);
  }

  async function renderPreview(): Promise<void> {
    const request = ++requestRef.current;
    setRendering(true);
    setError(null);
    try {
      const { renderMermaidToElements } = await import("../lib/mermaid/safe-mermaid");
      const rendered = await renderMermaidToElements(source);
      const blob = await exportToBlob({
        elements: rendered.elements,
        files: {},
        mimeType: "image/png",
        exportPadding: 24,
        appState: {
          exportBackground: true,
          exportEmbedScene: false,
          exportWithDarkMode: false,
          viewBackgroundColor: "#ffffff",
        },
        getDimensions: (width: number, height: number) => {
          const scale = Math.max(0.1, Math.min(1.5, 900 / Math.max(1, width), 520 / Math.max(1, height)));
          return {
            width: Math.max(1, Math.floor(width * scale)),
            height: Math.max(1, Math.floor(height * scale)),
            scale,
          };
        },
      });
      if (request !== requestRef.current) return;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreview(rendered);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (reason) {
      if (request !== requestRef.current) return;
      setPreview(null);
      setPreviewUrl(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request === requestRef.current) setRendering(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="mermaid-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mermaid-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">Offline Mermaid · no AI</span>
            <h2 id="mermaid-title">{editing ? "Edit Mermaid diagram" : "Insert Mermaid diagram"}</h2>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close Mermaid editor">×</button>
        </div>
        <div className="mermaid-workspace">
          <div className="mermaid-source-panel">
            <label htmlFor="mermaid-source">Mermaid source</label>
            <textarea
              id="mermaid-source"
              value={source}
              rows={15}
              autoFocus
              spellCheck={false}
              onChange={(event) => {
                clearPreview();
                setSource(event.target.value);
              }}
            />
            <span className="mermaid-source-count">{source.length.toLocaleString()} / 10,000 characters</span>
          </div>
          <div className={`mermaid-preview ${error ? "has-error" : ""}`} aria-live="polite">
            {rendering ? <span className="preview-message">Building local preview…</span>
              : error ? <span className="preview-error">{error}</span>
                : previewUrl ? <img src={previewUrl} alt="Preview of the Mermaid diagram" />
                  : <span className="preview-message">Press Preview to render this diagram locally.</span>}
          </div>
        </div>
        <p className="mermaid-help">
          Supports editable flowchart, sequence, class, ER, and state diagrams. Links, HTML, custom CSS, configuration directives, remote resources, and image fallbacks are disabled.
        </p>
        <div className="dialog-actions">
          <button className="dialog-cancel" type="button" onClick={onCancel}>Cancel</button>
          <button className="dialog-preview" type="button" onClick={() => void renderPreview()} disabled={rendering}>Preview</button>
          <button className="dialog-primary" type="button" onClick={() => preview && onSubmit(preview)} disabled={!preview || rendering}>
            {editing ? "Update diagram" : "Insert diagram"}
          </button>
        </div>
      </section>
    </div>
  );
}
