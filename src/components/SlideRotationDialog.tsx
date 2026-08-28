import { useMemo, useRef, useState, type RefObject } from "react";
import { useModalDialog } from "./useModalDialog";

type RotationDirection = "left" | "right";

const MAX_ROTATION_DEGREES = 180;
const ROTATION_PRESETS = [1, 5, 15, 45, 90] as const;

interface SlideRotationDialogProps {
  slideTitle: string;
  onCancel: () => void;
  onSubmit: (degrees: number) => void;
  returnFocusRef?: RefObject<HTMLElement>;
}

function formatDegrees(value: number): string {
  return `${Number(value.toFixed(2))}°`;
}

export function SlideRotationDialog({
  slideTitle,
  onCancel,
  onSubmit,
  returnFocusRef,
}: SlideRotationDialogProps) {
  const [direction, setDirection] = useState<RotationDirection>("left");
  const [degreesText, setDegreesText] = useState("1");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog<HTMLFormElement>({
    initialFocusRef: inputRef,
    onClose: onCancel,
    returnFocusRef,
  });
  const degrees = Number(degreesText);
  const valid = Number.isFinite(degrees) && degrees > 0 && degrees <= MAX_ROTATION_DEGREES;
  const signedDegrees = direction === "left" ? -degrees : degrees;
  const actionLabel = useMemo(() => (
    valid
      ? `Rotate ${direction} ${formatDegrees(degrees)}`
      : "Rotate slide"
  ), [degrees, direction, valid]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        ref={dialogRef}
        className="slide-rotation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slide-rotation-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit(signedDegrees);
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="dialog-kicker">{slideTitle}</span>
            <h2 id="slide-rotation-title">Rotate slide content</h2>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} aria-label="Close slide rotation">×</button>
        </div>

        <p className="slide-rotation-intro">
          Turn everything visible inside this slide around its centre. The slide boundary stays upright,
          so presentation tools and exports remain aligned.
        </p>

        <fieldset className="slide-rotation-direction">
          <legend>Direction</legend>
          <div className="slide-rotation-direction-options">
            <button
              type="button"
              className={direction === "left" ? "is-active" : ""}
              aria-pressed={direction === "left"}
              onClick={() => setDirection("left")}
            >
              ↺ Turn left
            </button>
            <button
              type="button"
              className={direction === "right" ? "is-active" : ""}
              aria-pressed={direction === "right"}
              onClick={() => setDirection("right")}
            >
              Turn right ↻
            </button>
          </div>
        </fieldset>

        <label className="slide-rotation-angle" htmlFor="slide-rotation-degrees">
          <span>Degrees</span>
          <span className="slide-rotation-input-wrap">
            <input
              ref={inputRef}
              id="slide-rotation-degrees"
              type="number"
              inputMode="decimal"
              min="0.1"
              max={MAX_ROTATION_DEGREES}
              step="0.1"
              value={degreesText}
              aria-describedby="slide-rotation-help"
              aria-invalid={!valid}
              onChange={(event) => setDegreesText(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
            <span aria-hidden="true">°</span>
          </span>
        </label>

        <div className="slide-rotation-presets" aria-label="Common rotation amounts">
          {ROTATION_PRESETS.map((preset) => (
            <button key={preset} type="button" onClick={() => setDegreesText(String(preset))}>
              {preset}°
            </button>
          ))}
        </div>

        <p id="slide-rotation-help" className="slide-rotation-help">
          Example: if a slide leans 33° to the right, choose <strong>Turn left</strong> and enter <strong>33</strong>.
          Images, ink, text, shapes, and their bindings rotate together. You can undo the change normally.
        </p>

        <div className="dialog-actions">
          <button className="dialog-cancel" type="button" onClick={onCancel}>Cancel</button>
          <button className="dialog-primary" type="submit" disabled={!valid}>{actionLabel}</button>
        </div>
      </form>
    </div>
  );
}
