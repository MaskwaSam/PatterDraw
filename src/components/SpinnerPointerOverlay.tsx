import type { CSSProperties } from "react";

export interface SpinnerPointerAnimation {
  angle: number;
  endPointerAngle: number;
  height: number;
  id: string;
  left: number;
  scaleX: number;
  scaleY: number;
  startPointerAngle: number;
  top: number;
  width: number;
}

interface SpinnerPointerOverlayProps {
  durationMs: number;
  spinners: readonly SpinnerPointerAnimation[];
}

const SECTORS = Array.from({ length: 8 }, (_, index) => {
  const rayAngle = index * Math.PI / 4;
  const labelAngle = (index + 0.5) * Math.PI / 4;
  return {
    label: index + 1,
    labelX: 76 + 48 * Math.cos(labelAngle),
    labelY: 80 + 48 * Math.sin(labelAngle),
    rayX: 76 + 68 * Math.cos(rayAngle),
    rayY: 76 + 68 * Math.sin(rayAngle),
  };
});

export function SpinnerPointerOverlay({ durationMs, spinners }: SpinnerPointerOverlayProps) {
  return (
    <div className="spinner-pointer-overlays" aria-hidden="true">
      {spinners.map((spinner) => {
        const overlayStyle: CSSProperties = {
          height: spinner.height,
          left: spinner.left,
          top: spinner.top,
          transform: `rotate(${spinner.angle}rad) scale(${spinner.scaleX}, ${spinner.scaleY})`,
          width: spinner.width,
        };
        const pointerStyle = {
          animationDuration: `${durationMs}ms`,
          "--spinner-pointer-end-angle": `${spinner.endPointerAngle}deg`,
          "--spinner-pointer-start-angle": `${spinner.startPointerAngle}deg`,
        } as CSSProperties;
        return (
          <div
            className="spinner-pointer-overlay"
            data-spinner-id={spinner.id}
            data-testid="spinner-pointer-animation"
            key={spinner.id}
            style={overlayStyle}
          >
            <svg className="spinner-pointer-overlay__wheel" viewBox="0 0 152 152">
              <circle cx="76" cy="76" r="70" fill="#e8f1ff" stroke="#204aa5" strokeWidth="2" />
              <g stroke="#55708f">
                {SECTORS.map((sector) => (
                  <line key={`ray-${sector.label}`} x1="76" y1="76" x2={sector.rayX} y2={sector.rayY} />
                ))}
              </g>
              <g fill="#172033" fontFamily="Arial, Helvetica, sans-serif" fontSize="12" fontWeight="700">
                {SECTORS.map((sector) => (
                  <text key={`label-${sector.label}`} x={sector.labelX} y={sector.labelY} textAnchor="middle">{sector.label}</text>
                ))}
              </g>
              <circle cx="76" cy="76" r="5" fill="#204aa5" />
            </svg>
            <div className="spinner-pointer-overlay__pointer" style={pointerStyle}>
              <svg viewBox="0 0 152 152">
                <line x1="76" y1="76" x2="76" y2="28" stroke="#b83232" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}
