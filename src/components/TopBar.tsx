import { useEffect, useRef, useState, type RefObject } from "react";
import {
  BoardIcon,
  ChevronDownIcon,
  EquationIcon,
  ExportIcon,
  HideTopBarIcon,
  LibraryIcon,
  MermaidIcon,
  OpenIcon,
  PdfIcon,
  SaveIcon,
  SearchIcon,
  SizePositionIcon,
  SlidesIcon,
} from "./Icons";
import { SettingsMenu } from "./SettingsMenu";
import type {
  FeaturePreferenceKey,
  FeaturePreferences,
} from "../lib/feature-preferences";
import type { WorkspaceMode } from "../lib/workspace-mode";
import type { ThemePreference } from "../lib/theme-preference";

interface TopBarProps {
  title: string;
  status: "saved" | "saving" | "error";
  featurePreferences: FeaturePreferences;
  themePreference: ThemePreference;
  onTitleChange: (title: string) => void;
  onFeaturePreferenceChange: (key: FeaturePreferenceKey, enabled: boolean) => void;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onRestoreFeaturePreferences: () => void;
  onOpen: () => void;
  onSave: () => void;
  onEquation: () => void;
  onMermaid: () => void;
  onExportAll: () => void;
  onExportOptions: () => void;
  insertButtonRef: RefObject<HTMLButtonElement>;
  exportOptionsButtonRef: RefObject<HTMLButtonElement>;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  pdfAvailable: boolean;
  libraryAvailable: boolean;
  libraryOpen: boolean;
  onLibraryToggle: () => void;
  sizePositionOpen: boolean;
  onSizePositionToggle: () => void;
  projectFindOpen: boolean;
  onProjectFindToggle: () => void;
  onHide: () => void;
}

function InsertMenu({
  insertButtonRef,
  onEquation,
  onMermaid,
}: Pick<TopBarProps, "insertButtonRef" | "onEquation" | "onMermaid">) {
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
        ref={insertButtonRef}
        className="topbar-menu-trigger"
        type="button"
        aria-label="Insert"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Insert"
        onClick={() => setOpen((current) => !current)}
      >
        <EquationIcon /><span className="icon-label">Insert</span><ChevronDownIcon className="menu-chevron" />
      </button>
      {open && (
        <div className="topbar-menu-popover" role="menu">
          <button type="button" role="menuitem" aria-label="Equation" title="Equation — Local MathJax" onClick={() => {
            setOpen(false);
            onEquation();
          }}><EquationIcon /><span className="icon-label"><strong>Equation</strong><small>Local MathJax</small></span></button>
          <button type="button" role="menuitem" aria-label="Diagram" title="Diagram — Mermaid preview" onClick={() => {
            setOpen(false);
            onMermaid();
          }}><MermaidIcon /><span className="icon-label"><strong>Diagram</strong><small>Mermaid preview</small></span></button>
        </div>
      )}
    </div>
  );
}

export function TopBar({
  title,
  status,
  featurePreferences,
  themePreference,
  onTitleChange,
  onFeaturePreferenceChange,
  onThemePreferenceChange,
  onRestoreFeaturePreferences,
  onOpen,
  onSave,
  onEquation,
  onMermaid,
  onExportAll,
  onExportOptions,
  insertButtonRef,
  exportOptionsButtonRef,
  mode,
  onModeChange,
  pdfAvailable,
  libraryAvailable,
  libraryOpen,
  onLibraryToggle,
  sizePositionOpen,
  onSizePositionToggle,
  projectFindOpen,
  onProjectFindToggle,
  onHide,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-document">
        <SettingsMenu
          preferences={featurePreferences}
          themePreference={themePreference}
          onPreferenceChange={onFeaturePreferenceChange}
          onThemePreferenceChange={onThemePreferenceChange}
          onRestoreDefaults={onRestoreFeaturePreferences}
        />
        <div className="brand-mark" role="img" aria-label="PatterDraw">P</div>
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
          aria-label="Board"
          aria-pressed={mode === "board"}
          title="Board"
          onClick={() => onModeChange("board")}
        >
          <BoardIcon /><span className="icon-label">Board</span>
        </button>
        {featurePreferences.slides ? (
          <button
            className={`workspace-toggle ${mode === "slides" ? "is-active" : ""}`}
            type="button"
            aria-label="Slides"
            aria-pressed={mode === "slides"}
            aria-controls="slide-rail"
            title="Slides"
            onClick={() => onModeChange("slides")}
          >
            <SlidesIcon /><span className="icon-label">Slides</span>
          </button>
        ) : null}
        {featurePreferences.pdf ? (
          <button
            className={`workspace-toggle ${mode === "pdf" ? "is-active" : ""}`}
            type="button"
            aria-label="PDF"
            aria-pressed={mode === "pdf"}
            aria-controls="pdf-page-rail"
            disabled={!pdfAvailable}
            title={pdfAvailable ? "Arrange imported PDF pages" : "Open a PDF to enable PDF mode"}
            onClick={() => onModeChange("pdf")}
          >
            <PdfIcon /><span className="icon-label">PDF</span>
          </button>
        ) : null}
      </div>
      <nav className="file-actions" aria-label="File actions">
        <button className="topbar-action" type="button" aria-label="Open" onClick={onOpen} title="Open a project or PDF"><OpenIcon /><span className="icon-label">Open</span></button>
        <button className="topbar-action" type="button" aria-label="Save" onClick={onSave} title="Download a complete PatterDraw project"><SaveIcon /><span className="icon-label">Save</span></button>
        {featurePreferences.insert ? (
          <InsertMenu insertButtonRef={insertButtonRef} onEquation={onEquation} onMermaid={onMermaid} />
        ) : null}
        <div className="export-split">
          <button type="button" aria-label="Export all" title="Export all" onClick={onExportAll}><ExportIcon /><span className="icon-label">Export all</span></button>
          <button
            ref={exportOptionsButtonRef}
            className="export-options-button"
            type="button"
            aria-label="More export options"
            title="More export options"
            onClick={onExportOptions}
          >
            <ChevronDownIcon />
          </button>
        </div>
        {featurePreferences.library ? (
          <button
            className={`sidebar-trigger topbar-library ${libraryOpen ? "is-active" : ""}`}
            type="button"
            aria-label="Library"
            aria-expanded={libraryOpen}
            title={libraryOpen ? "Close Library" : "Open Library"}
            disabled={!libraryAvailable}
            onClick={onLibraryToggle}
          >
            <LibraryIcon />
          </button>
        ) : null}
        {featurePreferences.projectFind ? (
          <button
            className={`topbar-tool ${projectFindOpen ? "is-active" : ""}`}
            type="button"
            aria-label="Find in project"
            aria-expanded={projectFindOpen}
            title="Find in project (Ctrl/⌘ + F)"
            onClick={onProjectFindToggle}
          >
            <SearchIcon />
          </button>
        ) : null}
        {featurePreferences.sizePosition ? (
          <button
            className={`topbar-tool ${sizePositionOpen ? "is-active" : ""}`}
            type="button"
            aria-label="Size & Position"
            aria-pressed={sizePositionOpen}
            title="Size & Position"
            onClick={onSizePositionToggle}
          >
            <SizePositionIcon />
          </button>
        ) : null}
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
