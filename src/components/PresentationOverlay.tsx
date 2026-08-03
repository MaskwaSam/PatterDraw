import { useEffect, type CSSProperties } from "react";
import type { ClassroomSlide } from "../types";
import {
  PRESENTATION_INK_COLOURS,
  PRESENTATION_INK_WIDTHS,
  type PresentationInkColour,
  type PresentationInkWidth,
} from "../lib/presentation-ink";
import { CloseIcon, InkIcon, LaserIcon, NextIcon, PreviousIcon } from "./Icons";

interface PresentationOverlayProps {
  slides: readonly ClassroomSlide[];
  index: number;
  tool: "laser" | "freedraw";
  inkColour: PresentationInkColour;
  inkWidth: PresentationInkWidth;
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
  onIndexChange,
  onToolChange,
  onInkColourChange,
  onInkWidthChange,
  onExit,
}: PresentationOverlayProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onExit();
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, select, textarea, [contenteditable='true']")) {
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
  }, [index, onExit, onIndexChange, slides.length]);

  return (
    <div className="presentation-controls" role="toolbar" aria-label="Presentation controls">
      <div className="presentation-main-controls">
        <button type="button" onClick={() => onIndexChange(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous slide"><PreviousIcon /></button>
        <span className="presentation-count">{index + 1} / {slides.length}</span>
        <button type="button" onClick={() => onIndexChange(Math.min(slides.length - 1, index + 1))} disabled={index >= slides.length - 1} aria-label="Next slide"><NextIcon /></button>
        <span className="presentation-separator" />
        <button type="button" className={tool === "laser" ? "is-active" : ""} onClick={() => onToolChange("laser")} aria-label="Laser" aria-pressed={tool === "laser"} title="Laser"><LaserIcon /><span className="icon-label">Laser</span></button>
        <button type="button" className={tool === "freedraw" ? "is-active" : ""} onClick={() => onToolChange("freedraw")} aria-label="Ink" aria-pressed={tool === "freedraw"} title="Ink"><InkIcon /><span className="icon-label">Ink</span></button>
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
  );
}
