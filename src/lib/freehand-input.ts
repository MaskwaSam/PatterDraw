import { mutateElement, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawFreeDrawElement } from "@excalidraw/excalidraw/element/types";

/** Keep actual browser input samples while native rendering stays frame paced.
 * The pinned engine throttles pointermove and otherwise retains only its last
 * position. Keep ownership of the stroke, finalization and history in the engine.
 */
export function captureFreehandInput(
  host: HTMLElement,
  api: ExcalidrawImperativeAPI,
  inputBlocked: () => boolean,
  onInterrupted: (elementId: string) => void = () => {},
): () => void {
  interface Stroke {
    pointerId: number;
    elementBeforeDownId: string | null;
    element: ExcalidrawFreeDrawElement | null;
    samples: Array<{ x: number; y: number; pressure: number }>;
    applied: number;
  }
  let stroke: Stroke | null = null;
  let frame: number | null = null;

  const apply = (notify: boolean) => {
    const current = stroke;
    if (!current || inputBlocked()) return;
    const native = api.getAppState().newElement;
    if (!native || native.type !== "freedraw" || native.isDeleted) return;
    // Capture-phase pointerdown runs before native creation. If the engine
    // consumes/rejects this down, never adopt its previous unfinished stroke.
    if (native.id === current.elementBeforeDownId) return;
    if (current.element && current.element.id !== native.id) return;
    current.element = native;
    if (current.applied === current.samples.length) return;
    const points = current.samples.map(({ x, y }) => [x - native.x, y - native.y] as ExcalidrawFreeDrawElement["points"][number]);
    const pressures = native.simulatePressure ? [] : current.samples.map(sample => sample.pressure);
    // One mutation per frame preserves every sample without drawing once for
    // each hardware event. On release, native finalization adds the endpoint.
    mutateElement(native, { points, pressures }, notify);
    current.applied = current.samples.length;
  };
  const append = (event: PointerEvent) => {
    const current = stroke;
    if (!current || event.pointerId !== current.pointerId || inputBlocked()) return;
    const state = api.getAppState();
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const events = coalesced.length ? coalesced : [event];
    for (const sample of events) {
      if (
        !Number.isFinite(sample.clientX)
        || !Number.isFinite(sample.clientY)
        || !Number.isFinite(sample.pressure)
      ) continue;
      const point = viewportCoordsToSceneCoords(sample, state);
      const last = current.samples.at(-1);
      if (last?.x === point.x && last.y === point.y) continue;
      current.samples.push({ ...point, pressure: sample.pressure });
    }
  };
  const down = (event: PointerEvent) => {
    if (
      inputBlocked()
      || event.button !== 0
      || !event.isPrimary
      || !(event.target instanceof HTMLCanvasElement)
      || !event.target.matches(".excalidraw__canvas.interactive")
      || !host.contains(event.target)
      || api.getAppState().activeTool.type !== "freedraw"
    ) return;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    stroke = {
      pointerId: event.pointerId,
      elementBeforeDownId: api.getAppState().newElement?.id ?? null,
      element: null, samples: [], applied: 0,
    };
    append(event);
  };
  const move = (event: PointerEvent) => {
    if (!stroke || event.pointerId !== stroke.pointerId || !event.buttons) return;
    append(event);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      apply(true);
    });
  };
  const finish = (event: PointerEvent, interrupted = false) => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    // Flush before the engine's window pointerup finalizes its undo entry.
    // Keep release pressure/endpoint handling in the native engine.
    apply(false);
    const element = stroke.element;
    stroke = null;
    if (interrupted && element && !inputBlocked() && api.getAppState().newElement?.id === element.id) {
      // The engine leaves newElement set after pointercancel. Persist the
      // actual captured ink without manufacturing pointerup/history entries.
      onInterrupted(element.id);
    }
  };
  const release = (event: PointerEvent) => finish(event);
  const cancel = (event: PointerEvent) => finish(event, true);
  const captureBeforeExit = () => apply(false);
  const captureWhenHidden = () => {
    if (document.visibilityState === "hidden") captureBeforeExit();
  };
  host.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", cancel, true);
  // Capture loss alone does not end the physical gesture. These window
  // listeners keep its samples until pointerup/cancel, including outside host.
  // Capture samples before the wrapper's existing exit/visibility handlers
  // read the native scene, even when the pending animation frame is suspended.
  document.addEventListener("visibilitychange", captureWhenHidden, true);
  window.addEventListener("pagehide", captureBeforeExit, true);
  window.addEventListener("beforeunload", captureBeforeExit, true);
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    stroke = null;
    host.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("visibilitychange", captureWhenHidden, true);
    window.removeEventListener("pagehide", captureBeforeExit, true);
    window.removeEventListener("beforeunload", captureBeforeExit, true);
  };
}
