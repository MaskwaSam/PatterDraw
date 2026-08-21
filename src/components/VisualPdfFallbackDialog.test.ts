import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualPdfFallbackDialog } from "./VisualPdfFallbackDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof VisualPdfFallbackDialog>[0]> = {}) {
  const callbacks = { onCancel: vi.fn(), onConfirm: vi.fn() };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(VisualPdfFallbackDialog, {
    ...callbacks,
    ...overrides,
  })));
  return { callbacks, container };
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

describe("VisualPdfFallbackDialog", () => {
  it("states the visual fidelity limits and requires an explicit one-shot confirmation", () => {
    const { callbacks, container } = mount();

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("visual-pdf-fallback-title");
    expect(container.textContent).toContain("flattens PatterDraw annotations into page images");
    expect(container.textContent).toContain("Fine details may look softer when zoomed");
    expect(container.textContent).toContain("will ask again every time");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    act(() => button(container, "Continue with visual PDF").click());
    expect(callbacks.onConfirm).toHaveBeenCalledTimes(1);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it("cancels on the Cancel button and on the backdrop", () => {
    const { callbacks, container } = mount();

    act(() => button(container, "Cancel").click());
    act(() => container.querySelector<HTMLElement>(".visual-pdf-fallback-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    expect(callbacks.onCancel).toHaveBeenCalledTimes(2);
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  });

  it("traps focus, closes on Escape, and restores focus to the invoking control", () => {
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
        }, "Export annotated PDF"),
        open ? createElement(VisualPdfFallbackDialog, {
          onCancel: () => setOpen(false),
          onConfirm: vi.fn(),
          returnFocusRef: triggerRef,
        }) : null,
      );
    }

    act(() => root.render(createElement(Harness)));
    const trigger = button(container, "Export annotated PDF");
    act(() => trigger.click());

    const cancel = button(container, "Cancel");
    const confirm = button(container, "Continue with visual PDF");
    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    })));
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    })));
    expect(document.activeElement).toBe(confirm);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
