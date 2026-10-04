import { mutateElement, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, PointerDownState } from "@excalidraw/excalidraw/types";
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
    nativePointerDownState: PointerDownState | null;
    samples: Array<{ x: number; y: number; pressure: number }>;
  }
  let stroke: Stroke | null = null;
  let frame: number | null = null;

  const apply = (notify: boolean) => {
    const current = stroke;
    if (!current || inputBlocked()) return;
    let native = api.getAppState().newElement;
    if (!native || native.type !== "freedraw" || native.isDeleted) return;
    // Capture-phase pointerdown runs before native creation. If the engine
    // consumes/rejects this down, never adopt its previous unfinished stroke.
    if (native.id === current.elementBeforeDownId) return;
    if (current.element && current.element.id !== native.id) return;
    const nativeId = native.id;
    // Drain the same gesture's pending native move before replacing its
    // geometry. Otherwise a later native RAF can append an older point after
    // our canonical batch, including after cancellation or exit persistence.
    current.nativePointerDownState?.eventListeners.onMove?.flush();
    if (stroke !== current || inputBlocked()) return;
    native = api.getAppState().newElement;
    if (!native || native.type !== "freedraw" || native.isDeleted) return;
    if (native.id !== nativeId) return;
    current.element = native;
    const points = current.samples.map(({ x, y }) => [x - native.x, y - native.y] as ExcalidrawFreeDrawElement["points"][number]);
    const pressures = native.simulatePressure ? [] : current.samples.map(sample => sample.pressure);
    // One mutation per frame preserves every sample without drawing once for
    // each hardware event. On release, native finalization adds the endpoint.
    mutateElement(native, { points, pressures }, notify);
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
      element: null, nativePointerDownState: null, samples: [],
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
    const current = stroke;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    // Native pointerup first flushes its pending throttled move. Reconcile
    // after that flush, before the engine adds release and finalizes history.
    // Cancellation/exit can also observe a native append after our last frame.
    apply(false);
    if (stroke !== current) return;
    const element = current.element;
    stroke = null;
    if (interrupted && element && !inputBlocked() && api.getAppState().newElement?.id === element.id) {
      // The engine leaves newElement set after pointercancel. Persist the
      // actual captured ink without manufacturing pointerup/history entries.
      onInterrupted(element.id);
    }
  };
  const release = (event: PointerEvent) => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    apply(false);
    // Keep the captured stroke until the public native pre-finalization hook.
    // A capture-phase write alone precedes the engine's pending-move flush.
  };
  const unsubscribeNativeUp = api.onPointerUp((_tool, state, event) => {
    // Missing-up cleanup may emit the previous gesture's up with a new down
    // event and a reused pointer ID. Only finish this exact native gesture.
    if (stroke?.nativePointerDownState === state) finish(event);
  });
  const unsubscribeNativeDown = api.onPointerDown((tool, state, event) => {
    if (stroke && tool.type === "freedraw" && event.pointerId === stroke.pointerId) {
      stroke.nativePointerDownState = state;
    }
  });
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
    unsubscribeNativeUp();
    unsubscribeNativeDown();
    host.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("visibilitychange", captureWhenHidden, true);
    window.removeEventListener("pagehide", captureBeforeExit, true);
    window.removeEventListener("beforeunload", captureBeforeExit, true);
  };
}
