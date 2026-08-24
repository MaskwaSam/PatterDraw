import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label
      || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof KeyboardShortcutsDialog>[0]> = {}) {
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(KeyboardShortcutsDialog, {
    onClose,
    platform: "apple",
    ...overrides,
  })));
  return { container, onClose };
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

describe("KeyboardShortcutsDialog", () => {
  it("renders a labelled modal, focuses search, and uses semantic platform-aware keys", () => {
    const { container } = mount();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const search = container.querySelector<HTMLInputElement>('#keyboard-shortcuts-search');

    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("keyboard-shortcuts-title");
    expect(document.activeElement).toBe(search);
    expect(container.textContent).toContain("Toggle clean fullscreen");
    expect(container.textContent).toContain("Export image");
    expect(container.textContent).toContain("Collapse or expand presentation toolbar");
    expect([...container.querySelectorAll("kbd")].map((key) => key.textContent)).toContain("Cmd");
    expect(container.querySelectorAll("kbd").length).toBeGreaterThan(50);
  });

  it("filters across aliases and reports an accessible empty result", () => {
    const { container } = mount();
    const search = container.querySelector<HTMLInputElement>('#keyboard-shortcuts-search');
    if (!search) throw new Error("Search input was not rendered.");

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(search, "bucket colour");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Bucket fill");
    expect(container.textContent).not.toContain("Selection tool");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 shortcut found");

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(search, "remote collaboration");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("No shortcuts found");
    expect(container.querySelectorAll(".keyboard-shortcut-row")).toHaveLength(0);

    act(() => button(container, "Show all shortcuts").click());
    expect(document.activeElement).toBe(search);
    expect(container.textContent).toContain("Selection tool");
  });

  it("closes from Escape, the close button, Done, and the backdrop", () => {
    const { container, onClose } = mount();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    act(() => button(container, "Close keyboard shortcuts").click());
    act(() => button(container, "Done").click());
    act(() => container.querySelector<HTMLElement>(".keyboard-shortcuts-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("restores focus to the invoking settings control", () => {
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
        }, "Keyboard shortcuts"),
        open ? createElement(KeyboardShortcutsDialog, {
          onClose: () => setOpen(false),
          platform: "other",
          returnFocusRef: triggerRef,
        }) : null,
      );
    }

    act(() => root.render(createElement(Harness)));
    const trigger = button(container, "Keyboard shortcuts");
    act(() => trigger.click());
    expect(document.activeElement).toBe(container.querySelector("#keyboard-shortcuts-search"));

    act(() => button(container, "Done").click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
