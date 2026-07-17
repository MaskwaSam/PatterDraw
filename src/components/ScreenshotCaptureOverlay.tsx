import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  normalizeCaptureRect,
  type CapturePoint,
  type ViewportCaptureRect,
} from "../lib/screenshots/capture";

interface ScreenshotCaptureOverlayProps {
  onCancel: () => void;
  onCapture: (rect: ViewportCaptureRect) => void;
}

export function ScreenshotCaptureOverlay({
  onCancel,
  onCapture,
}: ScreenshotCaptureOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<CapturePoint | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    overlayRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);

  const relativePoint = (event: ReactPointerEvent<HTMLDivElement>): CapturePoint | null => {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const renderSelection = (point: CapturePoint) => {
    const start = startRef.current;
    const overlay = overlayRef.current;
    const selection = selectionRef.current;
    if (!start || !overlay || !selection) return;
    const rect = normalizeCaptureRect(start, point, {
      width: overlay.clientWidth,
      height: overlay.clientHeight,
    });
    selection.hidden = false;
    selection.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    const point = relativePoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    startRef.current = point;
    pointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic touch tests and older browsers may not expose pointer capture.
    }
    renderSelection(point);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId || !startRef.current) return;
    const point = relativePoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    renderSelection(point);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId || !startRef.current) return;
    const overlay = overlayRef.current;
    const point = relativePoint(event);
    const start = startRef.current;
    startRef.current = null;
    pointerIdRef.current = null;
    if (!overlay || !point) return onCancel();
    event.preventDefault();
    event.stopPropagation();
    const rect = normalizeCaptureRect(start, point, {
      width: overlay.clientWidth,
      height: overlay.clientHeight,
    });
    if (rect.width < 2 || rect.height < 2) return onCancel();
    onCapture(rect);
  };

  return (
    <div
      ref={overlayRef}
      className="screenshot-capture-overlay"
      data-testid="screenshot-capture-overlay"
      role="application"
      aria-label="Area screenshot capture"
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={onCancel}
    >
      <div className="screenshot-capture-instructions" aria-live="polite">
        Drag to capture an area
        <span>Press Escape to cancel</span>
      </div>
      <button type="button" className="screenshot-capture-cancel" onClick={onCancel}>
        Cancel
      </button>
      <div ref={selectionRef} className="screenshot-capture-selection" hidden />
    </div>
  );
}
