import type { RefObject } from "react";
import type { WorkspaceMode } from "../lib/workspace-mode";
import {
  EnterFullscreenIcon,
  ExitFullscreenIcon,
  HideBottomBarIcon,
  InkIcon,
  MinusIcon,
  NextIcon,
  PlusIcon,
  PresentIcon,
  PreviousIcon,
  RedoIcon,
  ShowPanelIcon,
  UndoIcon,
} from "./Icons";

interface WorkspaceStatusControlsProps {
  variant: "footer" | "bottom";
  workspaceMode: WorkspaceMode;
  zoom: number;
  pdfPageIndex: number;
  pdfPageCount: number;
  onOpenPdfPage: (index: number) => void;
  isPdfRailVisible: boolean;
  onShowPdfRail: () => void;
  activeSlideIndex: number;
  slideCount: number;
  onOpenSlide: (index: number) => void;
  isSlideRailVisible: boolean;
  slideRailShowButtonRef: RefObject<HTMLButtonElement>;
  onShowSlideRail: () => void;
  onHideFooter: () => void;
  onEditorControl: (selector: string) => void;
  onPresent: () => void;
  isPdfToolbarVisible: boolean;
  onTogglePdfToolbar: () => void;
  obsCaptureArea: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

export function WorkspaceStatusControls({
  variant,
  workspaceMode,
  zoom,
  pdfPageIndex,
  pdfPageCount,
  onOpenPdfPage,
  isPdfRailVisible,
  onShowPdfRail,
  activeSlideIndex,
  slideCount,
  onOpenSlide,
  isSlideRailVisible,
  slideRailShowButtonRef,
  onShowSlideRail,
  onHideFooter,
  onEditorControl,
  onPresent,
  isPdfToolbarVisible,
  onTogglePdfToolbar,
  obsCaptureArea,
  isFullscreen,
  onToggleFullscreen,
}: WorkspaceStatusControlsProps) {
  const pageControls = (
    <div className="page-status">
      {variant === "footer" ? (
        <button
          className="footer-hide"
          type="button"
          aria-label="Hide footer"
          title="Hide footer (Ctrl/⌘ + Shift + F)"
          onClick={onHideFooter}
        >
          <HideBottomBarIcon />
        </button>
      ) : null}
      {workspaceMode === "pdf" && !isPdfRailVisible ? (
        <button
          className="pdf-rail-show"
          type="button"
          onClick={onShowPdfRail}
          aria-label="Show PDF pages"
          title="Show PDF pages"
        >
          <ShowPanelIcon />
          <span className="icon-label">Pages</span>
        </button>
      ) : null}
      {workspaceMode === "slides" && !isSlideRailVisible ? (
        <button
          ref={slideRailShowButtonRef}
          className="slide-rail-show"
          type="button"
          onClick={onShowSlideRail}
          aria-label="Show slide navigator"
          aria-controls="slide-rail"
          aria-expanded="false"
          title="Show slide navigator"
        >
          <ShowPanelIcon />
          <span className="icon-label">Slides</span>
        </button>
      ) : null}
      {pdfPageIndex >= 0 ? (
        <>
          <button type="button" disabled={pdfPageIndex === 0} onClick={() => onOpenPdfPage(pdfPageIndex - 1)} aria-label="Previous PDF page"><PreviousIcon /></button>
          <span>Page {pdfPageIndex + 1} of {pdfPageCount}</span>
          <button type="button" disabled={pdfPageIndex >= pdfPageCount - 1} onClick={() => onOpenPdfPage(pdfPageIndex + 1)} aria-label="Next PDF page"><NextIcon /></button>
        </>
      ) : workspaceMode === "slides" ? (
        <>
          <button type="button" disabled={activeSlideIndex <= 0} onClick={() => onOpenSlide(activeSlideIndex - 1)} aria-label="Previous slide"><PreviousIcon /></button>
          <span data-testid="slide-page-indicator" aria-live="polite">
            {activeSlideIndex >= 0
              ? `Slide ${activeSlideIndex + 1} of ${slideCount}`
              : `Overview · ${slideCount} slide${slideCount === 1 ? "" : "s"}`}
          </span>
          <button type="button" disabled={slideCount === 0 || activeSlideIndex >= slideCount - 1} onClick={() => onOpenSlide(activeSlideIndex + 1)} aria-label="Next slide"><NextIcon /></button>
        </>
      ) : variant === "footer" ? <span>Board</span> : null}
    </div>
  );

  const controls = (
    <>
      {pageControls}
      <div className="footer-zoom-controls" role="group" aria-label={`${workspaceMode === "pdf" ? "PDF" : workspaceMode === "slides" ? "Slides" : "Board"} zoom controls`}>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => onEditorControl(".zoom-out-button")}><MinusIcon /></button>
        <button className="footer-reset-zoom" type="button" aria-label="Reset zoom" title="Reset zoom" onClick={() => onEditorControl(".reset-zoom-button")}>{zoom}%</button>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => onEditorControl(".zoom-in-button")}><PlusIcon /></button>
      </div>
      <div className="statusbar-actions">
        {workspaceMode === "slides" || workspaceMode === "pdf" ? (
          <button
            className="present-button"
            type="button"
            onClick={onPresent}
            aria-label={workspaceMode === "pdf" ? "Present PDF" : "Present"}
            title={workspaceMode === "pdf" ? "Present PDF" : "Start presentation"}
          >
            <PresentIcon /><span className="icon-label">Present</span>
          </button>
        ) : null}
        {workspaceMode === "pdf" && !obsCaptureArea ? (
          <button
            className={`pdf-toolbar-toggle ${isPdfToolbarVisible ? "is-active" : ""}`}
            type="button"
            aria-label={isPdfToolbarVisible ? "Hide drawing tools" : "Show drawing tools"}
            aria-pressed={isPdfToolbarVisible}
            title={isPdfToolbarVisible ? "Hide drawing tools" : "Show drawing tools"}
            onClick={onTogglePdfToolbar}
          >
            <InkIcon />
          </button>
        ) : null}
        <button className="footer-history-button" type="button" aria-label="Undo" title="Undo" onClick={() => onEditorControl('[data-testid="button-undo"]')}><UndoIcon /></button>
        <button className="footer-history-button" type="button" aria-label="Redo" title="Redo" onClick={() => onEditorControl('[data-testid="button-redo"]')}><RedoIcon /></button>
        <button
          className={`fullscreen-button ${isFullscreen ? "is-active" : ""}`}
          type="button"
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
        </button>
      </div>
    </>
  );

  if (variant === "bottom") {
    return <div className="bottom-interface-status" aria-label="Canvas status and controls">{controls}</div>;
  }
  return <footer className="statusbar">{controls}</footer>;
}
