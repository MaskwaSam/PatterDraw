import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateElement } from "@excalidraw/excalidraw";
import { captureFreehandInput } from "./freehand-input";

vi.mock("@excalidraw/excalidraw", () => ({
  mutateElement: vi.fn((element, update) => Object.assign(element, update)),
  viewportCoordsToSceneCoords: (event: PointerEvent, state: { zoom: { value: number } }) => ({
    x: event.clientX / state.zoom.value,
    y: event.clientY / state.zoom.value,
  }),
}));

describe("native freehand input capture", () => {
  let cleanup: (() => void) | undefined;
  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let frames: Map<number, FrameRequestCallback>;
  let serial: number;
  const pointer = (type: string, x: number, y: number, overrides: object = {}) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 });
    Object.assign(event, { pointerId: 7, isPrimary: true, pressure: 0.2, ...overrides });
    return event;
  };
  const setup = (simulatePressure = false, onInterrupted = vi.fn()) => {
    const element = { id: "first", type: "freedraw", isDeleted: false, x: 50, y: 100, points: [[0, 0]], pressures: [0.2], simulatePressure };
    const state = { activeTool: { type: "freedraw" }, zoom: { value: 2 }, newElement: null as typeof element | null };
    let nextElement = element;
    // Native pointerdown creates its stroke after our host capture listener.
    canvas.addEventListener("pointerdown", () => { state.newElement = nextElement; });
    let blocked = false;
    cleanup = captureFreehandInput(host, { getAppState: () => state } as never, () => blocked, onInterrupted);
    return {
      element, state, onInterrupted, block: () => { blocked = true; },
      nextStroke: (next: typeof element) => { nextElement = next; state.newElement = null; },
    };
  };
  const runFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(frame => frame(0));
  };
  beforeEach(() => {
    frames = new Map();
    serial = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    host = document.createElement("div");
    canvas = document.createElement("canvas");
    canvas.className = "excalidraw__canvas interactive";
    host.append(canvas);
    document.body.append(host);
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    host.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("captures a coalesced packet with pressure before visibility persistence when its frame has not run", () => {
    const { element } = setup();
    canvas.dispatchEvent(pointer("pointerdown", 100, 200));
    canvas.dispatchEvent(pointer("pointermove", 130, 240, {
      getCoalescedEvents: () => [pointer("pointermove", 110, 210, { pressure: 0.4 }), pointer("pointermove", 130, 240, { pressure: 0.8 })],
    }));
    expect(mutateElement).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(element.points).toEqual([[0, 0], [5, 5], [15, 20]]);
    expect(element.pressures).toEqual([0.2, 0.4, 0.8]);
    expect(mutateElement).toHaveBeenCalledWith(element, expect.anything(), false);
  });

  it("retains ordinary moves without coalesced support and batches their notification", () => {
    const { element } = setup(true);
    canvas.dispatchEvent(pointer("pointerdown", 100, 200));
    canvas.dispatchEvent(pointer("pointermove", 110, 220));
    canvas.dispatchEvent(pointer("pointermove", 120, 240));
    expect(mutateElement).not.toHaveBeenCalled();
    runFrames();
    expect(element.points).toEqual([[0, 0], [5, 10], [10, 20]]);
    expect(element.pressures).toEqual([]);
    expect(mutateElement).toHaveBeenCalledOnce();
  });

  it("flushes cancelled ink before notifying persistence and isolates the next stroke", () => {
    const { element, state, onInterrupted, nextStroke } = setup(false, vi.fn(() => {
      expect(element.points).toEqual([[0, 0], [10, 10]]);
    }));
    canvas.dispatchEvent(pointer("pointerdown", 100, 200));
    canvas.dispatchEvent(pointer("pointermove", 500, 500, { pointerId: 99 }));
    canvas.dispatchEvent(pointer("pointermove", 120, 220));
    canvas.dispatchEvent(pointer("pointercancel", 120, 220));
    expect(element.points).toEqual([[0, 0], [10, 10]]);
    expect(onInterrupted).toHaveBeenCalledExactlyOnceWith("first");
    canvas.dispatchEvent(pointer("lostpointercapture", 120, 220));
    nextStroke({ ...element, id: "second", x: 300, y: 100, points: [[0, 0]], pressures: [0.2] });
    canvas.dispatchEvent(pointer("pointerdown", 600, 200));
    canvas.dispatchEvent(pointer("pointermove", 620, 240));
    runFrames();
    expect(state.newElement!.points).toEqual([[0, 0], [10, 20]]);
  });

  it("never adopts a pre-existing native stroke when a new pointerdown is consumed", () => {
    const { element, state, onInterrupted } = setup();
    state.newElement = element;
    canvas.dispatchEvent(pointer("pointerdown", 600, 200));
    canvas.dispatchEvent(pointer("pointermove", 620, 240));
    runFrames();
    canvas.dispatchEvent(pointer("pointercancel", 620, 240));
    expect(element.points).toEqual([[0, 0]]);
    expect(mutateElement).not.toHaveBeenCalled();
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it("keeps collecting after capture loss without interrupting persistence", () => {
    const { element, onInterrupted } = setup();
    canvas.dispatchEvent(pointer("pointerdown", 100, 200));
    canvas.dispatchEvent(pointer("pointermove", 120, 220));
    canvas.dispatchEvent(pointer("lostpointercapture", 120, 220));
    canvas.dispatchEvent(pointer("pointermove", 140, 240));
    canvas.dispatchEvent(pointer("pointerup", 140, 240));
    expect(element.points).toEqual([[0, 0], [10, 10], [20, 20]]);
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it("does not mutate a different native element or a blocked scene", () => {
    const { element, state, block } = setup();
    canvas.dispatchEvent(pointer("pointerdown", 100, 200));
    canvas.dispatchEvent(pointer("pointermove", 120, 220));
    runFrames();
    const another = { ...element, id: "another", points: [[0, 0]], pressures: [0.2] };
    state.newElement = another;
    canvas.dispatchEvent(pointer("pointermove", 160, 260));
    runFrames();
    expect(another.points).toEqual([[0, 0]]);
    state.newElement = element;
    block();
    canvas.dispatchEvent(pointer("pointermove", 200, 300));
    runFrames();
    expect(element.points).toEqual([[0, 0], [10, 10]]);
  });

  it("removes all input and exit callbacks on teardown", () => {
    const { element } = setup();
    canvas.dispatchEvent(pointer("pointerdown", 100, 200));
    canvas.dispatchEvent(pointer("pointermove", 120, 220));
    cleanup?.();
    cleanup = undefined;
    canvas.dispatchEvent(pointer("pointermove", 140, 240));
    window.dispatchEvent(new Event("pagehide"));
    runFrames();
    expect(element.points).toEqual([[0, 0]]);
    expect(mutateElement).not.toHaveBeenCalled();
  });
});
