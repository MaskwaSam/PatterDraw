import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mountCalculator } from "./runtime.js";

const cleanups: Array<() => void> = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
});
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function calculator() {
  const host = document.body.appendChild(document.createElement("div"));
  const instance = mountCalculator(host);
  cleanups.push(instance.destroy);
  return { host, instance, root: host.shadowRoot!.querySelector<HTMLElement>("#calc")! };
}
function press(host: HTMLElement, key: string) {
  host.shadowRoot!.querySelector<HTMLButtonElement>(`[data-k="${key}"]`)!.click();
}

describe("embedded TI calculator lifecycle", () => {
  it("performs arithmetic and scientific calculations through the original keypad", () => {
    const { host } = calculator();
    for (const key of ["2", "add", "3", "enter"]) press(host, key);
    expect(host.shadowRoot!.querySelector(".screen")!.textContent).toContain("5");
    for (const key of ["clear", "9", "sq", "enter"]) press(host, key);
    expect(host.shadowRoot!.querySelector(".screen")!.textContent).toContain("81");
    expect(localStorage.getItem("patterdraw-ti36x-v1")).not.toBeNull();
    expect(localStorage.getItem("pro-scientific-calc-v1")).toBeNull();
    expect((window as unknown as { TI?: unknown }).TI).toBeUndefined();
  });

  it("keeps focus inside the recorder after successful clipboard copying rerenders its controls", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { host } = calculator();
    const shadow = host.shadowRoot!;
    shadow.querySelector<HTMLButtonElement>(".solar")!.click();
    press(host, "7");
    const copy = shadow.querySelector<HTMLButtonElement>('[data-recorder="text"]')!;
    copy.focus();
    expect(document.activeElement).toBe(host);
    expect(shadow.activeElement).toBe(copy);
    copy.click();
    await vi.waitFor(() => expect(shadow.querySelector(".recorder-status")!.textContent).toContain("copied"));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain("7");
    const replacement = shadow.querySelector<HTMLButtonElement>('[data-recorder="text"]')!;
    expect(replacement).not.toBe(copy);
    expect(shadow.activeElement).toBe(replacement);
    expect(document.activeElement).toBe(host);
  });

  it("owns only root keyboard events and tears down its timer and handler", () => {
    vi.useFakeTimers();
    const { host, root, instance } = calculator();
    const before = root.querySelector(".screen")!.textContent;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "7", bubbles: true }));
    expect(root.querySelector(".screen")!.textContent).toBe(before);
    // Digit keydown does not need a browser CSS.escape implementation for flash.
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "7", bubbles: true }));
    expect(root.querySelector(".screen")!.textContent).toContain("7");
    vi.advanceTimersByTime(120);
    expect(vi.getTimerCount()).toBe(1);
    instance.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.shadowRoot!.querySelector("#calc")).toBeNull();
    const second = mountCalculator(host);
    cleanups.push(second.destroy);
    expect(vi.getTimerCount()).toBe(1);
  });
});
