import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCalculatorScreenDrag } from "./calculator-screen-drag";
import type { CalculatorScreenCapture } from "../vendor/ti36x/runtime.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((run) => run()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function pointer(target: EventTarget, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y });
  target.dispatchEvent(event);
}
function fixture(valid = true) {
  const screen = document.body.appendChild(document.createElement("div"));
  Object.assign(screen, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
  const scene = new AbortController();
  let resolve!: (image: CalculatorScreenCapture) => void;
  const capture = vi.fn(() => new Promise<CalculatorScreenCapture>((done) => { resolve = done; }));
  const drop = vi.fn().mockResolvedValue(true);
  const cancel = vi.fn();
  const status = vi.fn();
  const drag = attachCalculatorScreenDrag(screen, capture,
    () => ({ signal: scene.signal, canDrop: () => valid, drop, cancel }), status);
  cleanup.push(drag.destroy);
  const image = { blob: new Blob(["png"], { type: "image/png" }), width: 100, height: 40 };
  // Avoid object URLs in this DOM-only lifecycle fixture.
  vi.stubGlobal("URL", { createObjectURL: () => "blob:local-preview", revokeObjectURL: vi.fn() });
  return { screen, scene, capture, drop, cancel, drag, resolve: () => resolve(image), image };
}

describe("calculator screen pointer drag", () => {
  it("preserves clicks below threshold and inserts exactly once after an accepted drop", async () => {
    const f = fixture();
    const copy = vi.fn(); f.screen.addEventListener("click", copy);
    pointer(f.screen, "pointerdown", 10, 10); pointer(window, "pointerup", 12, 10); f.screen.click();
    expect(copy).toHaveBeenCalledOnce(); expect(f.capture).not.toHaveBeenCalled();
    pointer(f.screen, "pointerdown", 10, 10); pointer(window, "pointermove", 40, 40);
    expect(f.capture).toHaveBeenCalledOnce();
    pointer(window, "pointerup", 300, 200); pointer(window, "pointerup", 300, 200); f.screen.click();
    f.resolve();
    await vi.waitFor(() => expect(f.drop).toHaveBeenCalledOnce());
    expect(f.drop.mock.calls[0][0]).toBe(f.image);
    expect(f.drop.mock.calls[0][1]).toEqual({ clientX: 300, clientY: 200 });
    expect(copy).toHaveBeenCalledOnce();
  });

  it.each(["Escape", "pointercancel", "scene", "hide", "destroy"])("cancels %s while encoding without a late image insertion", async (reason) => {
    const f = fixture();
    pointer(f.screen, "pointerdown", 10, 10); pointer(window, "pointermove", 40, 40);
    pointer(window, "pointerup", 300, 200);
    if (reason === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    if (reason === "pointercancel") pointer(window, "pointercancel", 300, 200);
    if (reason === "scene") f.scene.abort();
    if (reason === "hide") f.drag.cancel();
    if (reason === "destroy") f.drag.destroy();
    f.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.drop).not.toHaveBeenCalled();
    expect(document.querySelector(".calculator-screen-drag-preview")).toBeNull();
  });

  it("rejects a drop outside the canvas even when its capture completes", async () => {
    const f = fixture(false);
    pointer(f.screen, "pointerdown", 10, 10); pointer(window, "pointermove", 40, 40);
    pointer(window, "pointerup", 30, 30); f.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(f.drop).not.toHaveBeenCalled();
    expect(document.querySelector(".calculator-screen-drag-preview")).toBeNull();
  });
});
