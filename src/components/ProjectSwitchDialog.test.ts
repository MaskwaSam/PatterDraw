import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitchDialog } from "./ProjectSwitchDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof ProjectSwitchDialog>[0]> = {}) {
  const callbacks = {
    onBackupAndOpen: vi.fn(),
    onCancel: vi.fn(),
    onOpenWithoutBackup: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ProjectSwitchDialog, {
    currentProjectTitle: "Tuesday lesson",
    nextFileName: "Wednesday lesson.patterdraw",
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

describe("ProjectSwitchDialog", () => {
  it("names both projects and exposes three explicit choices", () => {
    const { callbacks, container } = mount();

    expect(container.textContent).toContain("Tuesday lesson");
    expect(container.textContent).toContain("Wednesday lesson.patterdraw");
    expect(document.activeElement).toBe(button(container, "Cancel"));

    act(() => button(container, "Download backup & open").click());
    act(() => button(container, "Open without downloading").click());
    act(() => button(container, "Cancel").click());

    expect(callbacks.onBackupAndOpen).toHaveBeenCalledOnce();
    expect(callbacks.onOpenWithoutBackup).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it("prevents dismissal and replacement while a backup is being prepared", () => {
    const { callbacks, container } = mount({ processing: true });

    expect(button(container, "Preparing backup…").disabled).toBe(true);
    expect(button(container, "Open without downloading").disabled).toBe(true);
    expect(button(container, "Cancel").disabled).toBe(true);
    act(() => container.querySelector<HTMLElement>(".project-switch-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));

    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(callbacks.onBackupAndOpen).not.toHaveBeenCalled();
    expect(callbacks.onOpenWithoutBackup).not.toHaveBeenCalled();
  });

  it("traps focus and restores the invoking Open control on cancel", () => {
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
        }, "Open project"),
        open ? createElement(ProjectSwitchDialog, {
          currentProjectTitle: "Current",
          nextFileName: "Next.patterdraw",
          onBackupAndOpen: vi.fn(),
          onCancel: () => setOpen(false),
          onOpenWithoutBackup: vi.fn(),
          returnFocusRef: triggerRef,
        }) : null,
      );
    }

    act(() => root.render(createElement(Harness)));
    const trigger = button(container, "Open project");
    act(() => trigger.click());
    const cancel = button(container, "Cancel");
    const backup = button(container, "Download backup & open");
    expect(document.activeElement).toBe(cancel);

    backup.focus();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    })));
    expect(document.activeElement).toBe(cancel);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
