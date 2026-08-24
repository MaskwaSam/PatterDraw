import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ClassroomSlide } from "../types";
import { isEditableKeyboardTarget } from "../lib/keyboard-targets";
import {
  PRESENTATION_INK_COLOURS,
  PRESENTATION_INK_WIDTHS,
  type PresentationInkColour,
  type PresentationInkWidth,
} from "../lib/presentation-ink";
import {
  CloseIcon,
  HidePanelIcon,
  InkIcon,
  LaserIcon,
  NextIcon,
  PreviousIcon,
  ShowPanelIcon,
} from "./Icons";

const PRESENTATION_CONTROLS_TOGGLE_SETTLE_MS = 350;

interface PresentationOverlayProps {
  slides: readonly ClassroomSlide[];
  index: number;
  tool: "laser" | "freedraw";
  inkColour: PresentationInkColour;
  inkWidth: PresentationInkWidth;
  /** Pauses wrapper-owned global shortcuts while another app surface owns the keyboard. */
  shortcutsPaused?: boolean;
  onIndexChange: (index: number) => void;
  onToolChange: (tool: "laser" | "freedraw") => void;
  onInkColourChange: (colour: PresentationInkColour) => void;
  onInkWidthChange: (width: PresentationInkWidth) => void;
  onExit: () => void;
}

export function PresentationOverlay({
  slides,
  index,
  tool,
  inkColour,
  inkWidth,
  shortcutsPaused = false,
  onIndexChange,
  onToolChange,
  onInkColourChange,
  onInkWidthChange,
  onExit,
}: PresentationOverlayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedButtonRef = useRef<HTMLButtonElement>(null);
  const expandedCollapseButtonRef = useRef<HTMLButtonElement>(null);
  const wasCollapsedRef = useRef(false);
  const toggleSettleTimerRef = useRef<number | null>(null);

  const toggleControls = useCallback(() => {
    if (toggleSettleTimerRef.current !== null) return;
    // Absorb rapid discrete taps as well as key-repeat. The first intent wins,
    // then the toggle becomes available again after the visual change settles.
    toggleSettleTimerRef.current = window.setTimeout(() => {
      toggleSettleTimerRef.current = null;
    }, PRESENTATION_CONTROLS_TOGGLE_SETTLE_MS);
    setCollapsed((current) => !current);
  }, []);

  useEffect(() => () => {
    if (toggleSettleTimerRef.current !== null) {
      window.clearTimeout(toggleSettleTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsPaused) return;
      if (isEditableKeyboardTarget(event.target)) return;

      const target = event.target instanceof Element ? event.target : null;
      const isPresentationControl = Boolean(target?.closest(
        ".presentation-controls, .presentation-controls-collapsed",
      ));
      if (
        !isPresentationControl
        && target?.closest([
          "dialog",
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[role="menu"]',
          '[role="listbox"]',
          '[aria-modal="true"]',
          '[aria-busy="true"]',
          ".modal-backdrop",
          ".Modal",
          ".context-menu",
          ".dropdown-menu",
        ].join(", "))
      ) {
        return;
      }

      const isPlainCollapseShortcut = event.key.toLowerCase() === "c"
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey;
      if (isPlainCollapseShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) toggleControls();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onExit();
        return;
      }
      if (
        (event.key === " " || event.key === "Enter")
        && target?.closest("button, a[href]")
      ) {
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        onIndexChange(Math.min(slides.length - 1, index + 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        onIndexChange(Math.max(0, index - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        onIndexChange(0);
      } else if (event.key === "End") {
        event.preventDefault();
        onIndexChange(slides.length - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [index, onExit, onIndexChange, shortcutsPaused, slides.length, toggleControls]);

  useEffect(() => {
    if (collapsed) {
      collapsedButtonRef.current?.focus();
    } else if (wasCollapsedRef.current) {
      expandedCollapseButtonRef.current?.focus();
    }
    wasCollapsedRef.current = collapsed;
  }, [collapsed]);

  const slideStatus = (
    <span
      className="visually-hidden"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      Slide {index + 1} of {slides.length}
    </span>
  );

  if (collapsed) {
    return (
      <>
        {slideStatus}
        <div
          className="presentation-controls-collapsed"
          role="toolbar"
          aria-label="Collapsed presentation controls"
        >
          <button
            ref={collapsedButtonRef}
            className="presentation-collapse-toggle"
            type="button"
            onClick={toggleControls}
            aria-label="Expand presentation controls"
            aria-expanded="false"
            aria-keyshortcuts="C"
            title="Show presentation controls (C)"
          >
            <ShowPanelIcon />
            <span aria-hidden="true">{index + 1} / {slides.length}</span>
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {slideStatus}
      <div className="presentation-controls" role="toolbar" aria-label="Presentation controls">
        <div className="presentation-main-controls">
          <button type="button" onClick={() => onIndexChange(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous slide"><PreviousIcon /></button>
          <span className="presentation-count" aria-hidden="true">{index + 1} / {slides.length}</span>
          <button type="button" onClick={() => onIndexChange(Math.min(slides.length - 1, index + 1))} disabled={index >= slides.length - 1} aria-label="Next slide"><NextIcon /></button>
          <span className="presentation-separator" />
          <button type="button" className={tool === "laser" ? "is-active" : ""} onClick={() => onToolChange("laser")} aria-label="Laser" aria-pressed={tool === "laser"} title="Laser"><LaserIcon /><span className="icon-label">Laser</span></button>
          <button type="button" className={tool === "freedraw" ? "is-active" : ""} onClick={() => onToolChange("freedraw")} aria-label="Ink" aria-pressed={tool === "freedraw"} title="Ink"><InkIcon /><span className="icon-label">Ink</span></button>
          <button ref={expandedCollapseButtonRef} className="presentation-collapse-toggle" type="button" onClick={toggleControls} aria-label="Collapse presentation controls" aria-expanded="true" aria-keyshortcuts="C" title="Collapse controls to bottom-left (C)"><HidePanelIcon /><span className="icon-label">Collapse</span></button>
          <button type="button" onClick={onExit} aria-label="Exit" title="Exit presentation"><CloseIcon /><span className="icon-label">Exit</span></button>
        </div>
        <div className="presentation-ink-palette" role="group" aria-label="Ink colours">
          <span className="presentation-palette-label">Ink colour</span>
          {PRESENTATION_INK_COLOURS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={`presentation-colour-swatch ${inkColour === value ? "is-selected" : ""}`}
              style={{ "--swatch-colour": value } as CSSProperties}
              onClick={() => onInkColourChange(value)}
              aria-label={`${label} ink`}
              aria-pressed={inkColour === value}
              title={`${label} ink`}
            >
              <span className="visually-hidden">{label}</span>
            </button>
          ))}
        </div>
        <div className="presentation-width-picker" role="group" aria-label="Ink widths">
          <span className="presentation-palette-label">Ink width</span>
          {PRESENTATION_INK_WIDTHS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={`presentation-width-button ${inkWidth === value ? "is-selected" : ""}`}
              onClick={() => onInkWidthChange(value)}
              aria-label={`${label} ink width`}
              aria-pressed={inkWidth === value}
              title={`${label} — ${value}px on screen`}
            >
              <span className="presentation-width-line" style={{ height: value }} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
