import type { CalculatorScreenCapture } from "../vendor/ti36x/runtime.js";

export interface CalculatorScreenDragSession {
  signal: AbortSignal;
  canDrop(point: { clientX: number; clientY: number }): boolean;
  drop(image: CalculatorScreenCapture, point: { clientX: number; clientY: number }, signal: AbortSignal): Promise<boolean>;
  cancel(): void;
}

/** Pointer capture works with mouse, touch and pen without clipboard permission. */
export function attachCalculatorScreenDrag(
  screen: HTMLElement,
  capture: () => Promise<CalculatorScreenCapture>,
  begin: () => CalculatorScreenDragSession | null,
  status: (message: string) => void,
) {
  let gesture: {
    pointerId: number; x: number; y: number; started: boolean; released: boolean;
    controller: AbortController; session: CalculatorScreenDragSession | null;
    image: Promise<CalculatorScreenCapture> | null; preview: HTMLDivElement | null; url: string | null;
  } | null = null;
  let suppressClick = false;
  let destroyed = false;
  const release = () => {
    if (gesture && screen.hasPointerCapture?.(gesture.pointerId)) screen.releasePointerCapture(gesture.pointerId);
  };
  const cancel = () => {
    const current = gesture;
    if (!current) return;
    gesture = null;
    current.controller.abort();
    current.session?.cancel();
    current.preview?.remove();
    if (current.url) URL.revokeObjectURL(current.url);
    if (screen.hasPointerCapture?.(current.pointerId)) screen.releasePointerCapture(current.pointerId);
  };
  const onDown = (event: PointerEvent) => {
    if (destroyed || event.button !== 0 || !event.isPrimary) return;
    cancel();
    suppressClick = false;
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false, released: false,
      controller: new AbortController(), session: null, image: null, preview: null, url: null };
    screen.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    const current = gesture;
    if (!current || current.released || event.pointerId !== current.pointerId) return;
    if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 7) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!current.started) {
      current.started = true;
      suppressClick = true;
      current.session = begin();
      if (!current.session || current.session.signal.aborted) { cancel(); return; }
      current.session.signal.addEventListener("abort", cancel, { once: true, signal: current.controller.signal });
      const preview = document.createElement("div");
      preview.className = "calculator-screen-drag-preview";
      preview.dataset.testid = "calculator-screen-drag-preview";
      preview.setAttribute("aria-hidden", "true");
      preview.textContent = "Calculator screen";
      document.body.appendChild(preview);
      current.preview = preview;
      // capture paints synchronously, then encodes asynchronously: later entries
      // cannot alter the image selected by this gesture.
      current.image = capture();
      void current.image.then((image) => {
        if (gesture !== current || destroyed) return;
        current.url = URL.createObjectURL(image.blob);
        const img = document.createElement("img"); img.src = current.url; img.alt = "";
        preview.replaceChildren(img);
      }).catch(() => { if (gesture === current) { status("Calculator screen could not be captured."); cancel(); } });
      status("Drag the calculator screen onto the canvas. Escape cancels.");
    }
    if (current.preview) {
      current.preview.style.left = `${event.clientX + 12}px`;
      current.preview.style.top = `${event.clientY + 12}px`;
      current.preview.dataset.validDrop = String(current.session?.canDrop(event));
    }
  };
  const onUp = (event: PointerEvent) => {
    const current = gesture;
    if (!current || current.released || event.pointerId !== current.pointerId) return;
    if (!current.started) { cancel(); return; } // ordinary click still copies
    event.preventDefault(); event.stopImmediatePropagation();
    current.released = true;
    release();
    const point = { clientX: event.clientX, clientY: event.clientY };
    if (!current.session?.canDrop(point) || !current.image) { status("Screen drop cancelled."); cancel(); return; }
    const session = current.session;
    void current.image.then(async (image) => {
      if (gesture !== current || current.controller.signal.aborted || session.signal.aborted || destroyed) return;
      const inserted = await session.drop(image, point, current.controller.signal);
      if (gesture === current) status(inserted ? "Calculator screen added to the canvas." : "Screen drop cancelled.");
    }).catch(() => { if (gesture === current) status("Calculator screen could not be added."); })
      .finally(() => { if (gesture === current) cancel(); });
  };
  const onCancel = (event: PointerEvent) => {
    if (gesture?.pointerId === event.pointerId && (event.type === "pointercancel" || !gesture.released)) cancel();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !gesture?.started) return;
    event.preventDefault(); event.stopImmediatePropagation(); status("Screen drop cancelled."); cancel();
  };
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  screen.addEventListener("pointerdown", onDown);
  screen.addEventListener("click", onClick, true);
  window.addEventListener("pointermove", onMove, { capture: true, passive: false });
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  screen.addEventListener("lostpointercapture", onCancel);
  return {
    cancel,
    destroy() {
      destroyed = true; cancel();
      screen.removeEventListener("pointerdown", onDown);
      screen.removeEventListener("click", onClick, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
      screen.removeEventListener("lostpointercapture", onCancel);
    },
  };
}
