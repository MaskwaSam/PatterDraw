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
        onExit();
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest("button, input, select, textarea, a[href], [contenteditable='true']")) {
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        onIndexChange(Math.min(slides.length - 1, index + 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        onIndexChange(Math.max(0, index - 1));
      } else if (event.key === "Home") onIndexChange(0);
      else if (event.key === "End") onIndexChange(slides.length - 1);
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
        <button type="button" className={tool === "laser" ? "is-active" : ""} onClick={() => onToolChange("laser")} aria-pressed={tool === "laser"}><LaserIcon />Laser</button>
        <button type="button" className={tool === "freedraw" ? "is-active" : ""} onClick={() => onToolChange("freedraw")} aria-pressed={tool === "freedraw"}><InkIcon />Ink</button>
        <button type="button" onClick={onExit}><CloseIcon />Exit</button>
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
