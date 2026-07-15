import { useEffect } from "react";
import type { MathInteractionKind } from "../lib/math-tools/catalogue";
import type { AngleMeasurementOptions, CompassOptions, MathPoint, TransformationOptions } from "../lib/math-tools/interactive";

export interface CapturedMathPoint {
  scene: MathPoint;
  viewport: MathPoint;
}

interface MathInteractionOverlayProps {
  kind: MathInteractionKind;
  points: CapturedMathPoint[];
  compassOptions: CompassOptions;
  angleOptions: AngleMeasurementOptions;
  sourceElementCount: number;
  transformationOptions: TransformationOptions;
  onAngleOptionsChange: (options: AngleMeasurementOptions) => void;
  onCancel: () => void;
  onCommit: () => void;
  onCompassOptionsChange: (options: CompassOptions) => void;
  onReset: () => void;
  onTransformationOptionsChange: (options: TransformationOptions) => void;
}

export function MathInteractionOverlay({
  kind,
  points,
  compassOptions,
  angleOptions,
  sourceElementCount,
  transformationOptions,
  onAngleOptionsChange,
  onCancel,
  onCommit,
  onCompassOptionsChange,
  onReset,
  onTransformationOptionsChange,
}: MathInteractionOverlayProps) {
  const requiredPoints = kind === "compass" ? 2 : kind === "angle-measurement" ? 3 : 0;
  const labels = kind === "compass" ? ["Centre", "Radius point"] : kind === "angle-measurement" ? ["Vertex", "First ray", "Second ray"] : [];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);

  return (
    <div className="math-interaction-overlay" data-testid={`math-interaction-${kind}`}>
      <svg className="math-interaction-guides" aria-hidden="true">
        {points.slice(1).map((point, index) => (
          <line key={`line-${index}`} x1={points[0].viewport.x} y1={points[0].viewport.y} x2={point.viewport.x} y2={point.viewport.y} />
        ))}
        {points.map((point, index) => (
          <g key={`point-${index}`}><circle cx={point.viewport.x} cy={point.viewport.y} r="7" /><text x={point.viewport.x + 10} y={point.viewport.y - 10}>{index + 1}</text></g>
        ))}
      </svg>
      <section className="math-interaction-panel" role="dialog" aria-modal="false" aria-label={kind === "compass" ? "Compass construction" : kind === "angle-measurement" ? "Angle measurement" : "Transformation tool"}>
        <span className="dialog-kicker">Wrapper-owned interaction mode</span>
        <h3>{kind === "compass" ? "Compass" : kind === "angle-measurement" ? "Angle measurer" : "Transformation tool"}</h3>
        {kind === "transformation"
          ? <p>{sourceElementCount} supported source object{sourceElementCount === 1 ? "" : "s"} selected. The originals will remain unchanged.</p>
          : <p>Click {labels[points.length] || "Insert"} on the board. {points.length} of {requiredPoints} points selected.</p>}

        {kind === "compass" ? (
          <div className="math-interaction-options">
            <label><input type="checkbox" checked={compassOptions.fullCircle} onChange={(event) => onCompassOptionsChange({ ...compassOptions, fullCircle: event.target.checked })} /> Full circle</label>
            {!compassOptions.fullCircle ? (
              <>
                <label>Arc extent<input type="number" min="1" max="359" value={compassOptions.arcExtentDegrees} onChange={(event) => onCompassOptionsChange({ ...compassOptions, arcExtentDegrees: event.target.valueAsNumber })} /></label>
                <label>Direction<select value={compassOptions.direction} onChange={(event) => onCompassOptionsChange({ ...compassOptions, direction: event.target.value as CompassOptions["direction"] })}><option value="clockwise">Clockwise</option><option value="counterclockwise">Counterclockwise</option></select></label>
              </>
            ) : null}
            <label><input type="checkbox" checked={compassOptions.centerMark} onChange={(event) => onCompassOptionsChange({ ...compassOptions, centerMark: event.target.checked })} /> Centre mark</label>
          </div>
        ) : kind === "angle-measurement" ? (
          <div className="math-interaction-options">
            <label><input type="checkbox" checked={angleOptions.reflex} onChange={(event) => onAngleOptionsChange({ ...angleOptions, reflex: event.target.checked })} /> Reflex angle</label>
            <label>Decimal places<select value={angleOptions.precision} onChange={(event) => onAngleOptionsChange({ ...angleOptions, precision: Number(event.target.value) })}><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label>
          </div>
        ) : (
          <div className="math-interaction-options">
            <label>Transformation
              <select value={transformationOptions.transformationType} onChange={(event) => onTransformationOptionsChange({ ...transformationOptions, transformationType: event.target.value as TransformationOptions["transformationType"] })}>
                <option value="translate">Translate</option><option value="rotate">Rotate</option><option value="reflect-vertical">Reflect vertically</option><option value="reflect-horizontal">Reflect horizontally</option><option value="reflect-line">Reflect across a line</option><option value="dilate">Dilate</option>
              </select>
            </label>
            {transformationOptions.transformationType === "translate" ? <><label>Horizontal change<input type="number" value={transformationOptions.translateX} onChange={(event) => onTransformationOptionsChange({ ...transformationOptions, translateX: event.target.valueAsNumber })} /></label><label>Vertical change<input type="number" value={transformationOptions.translateY} onChange={(event) => onTransformationOptionsChange({ ...transformationOptions, translateY: event.target.valueAsNumber })} /></label></> : null}
            {transformationOptions.transformationType === "rotate" ? <label>Angle in degrees<input type="number" min="-360" max="360" value={transformationOptions.angleDegrees} onChange={(event) => onTransformationOptionsChange({ ...transformationOptions, angleDegrees: event.target.valueAsNumber })} /></label> : null}
            {transformationOptions.transformationType === "reflect-line" ? <label>Mirror line angle<input type="number" min="-360" max="360" value={transformationOptions.mirrorLineAngleDegrees} onChange={(event) => onTransformationOptionsChange({ ...transformationOptions, mirrorLineAngleDegrees: event.target.valueAsNumber })} /></label> : null}
            {transformationOptions.transformationType === "dilate" ? <label>Scale factor<input type="number" min="0.05" max="20" step="0.05" value={transformationOptions.scaleFactor} onChange={(event) => onTransformationOptionsChange({ ...transformationOptions, scaleFactor: event.target.valueAsNumber })} /></label> : null}
          </div>
        )}

        <div className="math-interaction-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          {kind !== "transformation" ? <button type="button" onClick={onReset} disabled={!points.length}>Reset points</button> : null}
          <button type="button" className="is-primary" onClick={onCommit} disabled={kind === "transformation" ? sourceElementCount === 0 : points.length !== requiredPoints}>Insert</button>
        </div>
      </section>
    </div>
  );
}
