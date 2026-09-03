import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClearBoardDialog, type ClearBoardDialogProps } from "./ClearBoardDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<ClearBoardDialogProps> = {}) {
  const callbacks = { onCancel: vi.fn(), onConfirm: vi.fn() };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const props = { objectCount: 4, slideCount: 0, ...callbacks, ...overrides };
  act(() => root.render(createElement(ClearBoardDialog, props)));
  return {
    callbacks,
    container,
    rerender: (next: Partial<ClearBoardDialogProps>) => {
      act(() => root.render(createElement(ClearBoardDialog, { ...props, ...next })));
    },
  };
}

function submit(container: ParentNode) {
  act(() => container.querySelector("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ClearBoardDialog", () => {
  it("focuses Cancel and explains the exact scope and recovery choices", () => {
    const { callbacks, container } = mount();
    const dialog = container.querySelector('[role="dialog"]');

    expect(document.activeElement).toBe(button(container, "Cancel"));
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(container.textContent).toContain("Clear main board?");
    expect(container.textContent).toContain("4 objects");
    expect(container.textContent).toContain("including off-screen content");
    expect(container.textContent).toContain("PDF pages and your personal library are left untouched");
    expect(container.textContent).toContain("An automatic local copy is saved in Recovery history before clearing");
    expect(container.textContent).toContain("Undo until you leave the board or reload");
    expect(container.textContent).toContain("Recovery history afterward");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    act(() => button(container, "Clear board").click());
    expect(callbacks.onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels from Cancel, Escape, and the backdrop without clearing", () => {
    const { callbacks, container } = mount();

    act(() => button(container, "Cancel").click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    act(() => container.querySelector(".clear-board-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => container.querySelector("form")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    expect(callbacks.onCancel).toHaveBeenCalledTimes(3);
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  });

  it("requires an unchecked slide acknowledgement before allowing submission", () => {
    const { callbacks, container } = mount({ slideCount: 2 });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(container.textContent).toContain("Also clear the 2 slides on this board");
    expect(checkbox?.checked).toBe(false);
    expect(button(container, "Clear board").disabled).toBe(true);

    submit(container);
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
    act(() => checkbox?.click());
    expect(button(container, "Clear board").disabled).toBe(false);
    act(() => button(container, "Clear board").click());
    expect(callbacks.onConfirm).toHaveBeenCalledOnce();

    act(() => checkbox?.click());
    submit(container);
    expect(button(container, "Clear board").disabled).toBe(true);
    expect(callbacks.onConfirm).toHaveBeenCalledOnce();
  });

  it("uses singular counts and requires a fresh acknowledgement when the slide count changes", () => {
    const { container, rerender } = mount({ objectCount: 1, slideCount: 1 });
    expect(container.textContent).toContain("1 object");
    expect(container.textContent).toContain("Also clear the 1 slide on this board");
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    expect(button(container, "Clear board").disabled).toBe(false);

    rerender({ objectCount: 2, slideCount: 2 });
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(button(container, "Clear board").disabled).toBe(true);
  });

  it("does not clear an empty board even when a submit event is dispatched", () => {
    const { callbacks, container } = mount({ objectCount: 0 });
    expect(button(container, "Clear board").disabled).toBe(true);
    act(() => button(container, "Clear board").click());
    submit(container);
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  });

  it("blocks cancellation and resubmission while processing, including after props change", () => {
    const { callbacks, container, rerender } = mount({ slideCount: 1 });
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    rerender({ processing: true });

    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
    expect(button(container, "Protecting board…").disabled).toBe(true);
    expect(button(container, "Cancel").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    act(() => button(container, "Cancel").click());
    act(() => button(container, "Protecting board…").click());
    submit(container);
    act(() => container.querySelector(".clear-board-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));

    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  });

  it("traps focus and returns it to the clear-board trigger on cancellation", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return createElement("div", null,
        createElement("button", {
          ref: triggerRef,
          type: "button",
          onClick: () => setOpen(true),
        }, "Clear main board"),
        open ? createElement(ClearBoardDialog, {
          objectCount: 3,
          slideCount: 0,
          onCancel: () => setOpen(false),
          onConfirm: vi.fn(),
          returnFocusRef: triggerRef,
        }) : null,
      );
    }

    act(() => root.render(createElement(Harness)));
    const trigger = button(container, "Clear main board");
    act(() => trigger.click());
    expect(document.activeElement).toBe(button(container, "Cancel"));

    button(container, "Clear board").focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    })));
    expect(document.activeElement).toBe(button(container, "Cancel"));

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
