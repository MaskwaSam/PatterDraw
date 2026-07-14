import { useEffect, useRef, useState } from "react";
import {
  BoardIcon,
  ChevronDownIcon,
  EquationIcon,
  ExportIcon,
  HideTopBarIcon,
  MermaidIcon,
  OpenIcon,
  PdfIcon,
  SaveIcon,
  SlidesIcon,
} from "./Icons";
import type { WorkspaceMode } from "../lib/workspace-mode";

interface TopBarProps {
  title: string;
  status: "saved" | "saving" | "error";
  onTitleChange: (title: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onEquation: () => void;
  onMermaid: () => void;
  onExportAll: () => void;
  onExportOptions: () => void;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  pdfAvailable: boolean;
  onHide: () => void;
}

function InsertMenu({ onEquation, onMermaid }: Pick<TopBarProps, "onEquation" | "onMermaid">) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={menuRef} className={`topbar-menu ${open ? "is-open" : ""}`}>
      <button
        className="topbar-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <EquationIcon /><span>Insert</span><ChevronDownIcon className="menu-chevron" />
      </button>
      {open && (
        <div className="topbar-menu-popover" role="menu">
          <button type="button" role="menuitem" onClick={() => {
            setOpen(false);
            onEquation();
          }}><EquationIcon /><span><strong>Equation</strong><small>Local MathJax</small></span></button>
          <button type="button" role="menuitem" onClick={() => {
            setOpen(false);
            onMermaid();
          }}><MermaidIcon /><span><strong>Diagram</strong><small>Mermaid preview</small></span></button>
        </div>
      )}
    </div>
  );
}

export function TopBar({
  title,
  status,
  onTitleChange,
  onOpen,
  onSave,
  onEquation,
  onMermaid,
  onExportAll,
  onExportOptions,
  mode,
  onModeChange,
  pdfAvailable,
  onHide,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-document">
        <div className="brand-mark" aria-hidden="true">C</div>
        <div className="project-identity">
          <input
            className="document-title"
            value={title}
            aria-label="Project title"
            onChange={(event) => onTitleChange(event.target.value)}
          />
          <div className={`save-state save-state-${status}`} aria-live="polite">
            <span className="offline-dot" />
            {status === "saving" ? "Saving locally" : status === "error" ? "Save error" : "Saved locally"}
          </div>
        </div>
      </div>
      <div className="workspace-tabs" aria-label="Workspace mode">
        <button
          className={`workspace-toggle ${mode === "board" ? "is-active" : ""}`}
          type="button"
          aria-pressed={mode === "board"}
          onClick={() => onModeChange("board")}
        >
          <BoardIcon /><span>Board</span>
        </button>
        <button
          className={`workspace-toggle ${mode === "slides" ? "is-active" : ""}`}
          type="button"
          aria-pressed={mode === "slides"}
          aria-controls="slide-rail"
          onClick={() => onModeChange("slides")}
        >
          <SlidesIcon /><span>Slides</span>
        </button>
        <button
          className={`workspace-toggle ${mode === "pdf" ? "is-active" : ""}`}
          type="button"
          aria-pressed={mode === "pdf"}
          aria-controls="pdf-page-rail"
          disabled={!pdfAvailable}
          title={pdfAvailable ? "Arrange imported PDF pages" : "Open a PDF to enable PDF mode"}
          onClick={() => onModeChange("pdf")}
        >
          <PdfIcon /><span>PDF</span>
        </button>
      </div>
      <nav className="file-actions" aria-label="File actions">
        <button className="topbar-action" type="button" onClick={onOpen} title="Open a project or PDF"><OpenIcon /><span>Open</span></button>
        <button className="topbar-action" type="button" onClick={onSave} title="Download a complete classroom project"><SaveIcon /><span>Save</span></button>
        <InsertMenu onEquation={onEquation} onMermaid={onMermaid} />
        <div className="export-split">
          <button type="button" onClick={onExportAll}><ExportIcon /><span>Export all</span></button>
          <button
            className="export-options-button"
            type="button"
            aria-label="More export options"
            title="More export options"
            onClick={onExportOptions}
          >
            <ChevronDownIcon />
          </button>
        </div>
        <button
          className="topbar-hide"
          type="button"
          aria-label="Hide navigation"
          title="Hide navigation (Ctrl/⌘ + Shift + H)"
          onClick={onHide}
        >
          <HideTopBarIcon />
        </button>
      </nav>
    </header>
  );
}
