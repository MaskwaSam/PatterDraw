import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../types";
import { PdfPageRail } from "./PdfPageRail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.includes(label));
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount() {
  const project = createBlankProject(new Date("2026-08-20T12:00:00.000Z"));
  const callbacks = {
    onOpenPage: vi.fn(),
    onMovePage: vi.fn(),
    onShiftPage: vi.fn(),
    onAddBlankPage: vi.fn(),
    onInsertPdfPages: vi.fn(),
    onDeletePage: vi.fn(),
    onWidthChange: vi.fn(),
    onHide: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(PdfPageRail, {
    project,
    pages: [],
    activeSceneId: project.activeSceneId,
    width: 224,
    ...callbacks,
  })));
  return { callbacks, container };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("PdfPageRail add-page menu", () => {
  it("offers separate blank-page and multi-PDF actions", () => {
    const { callbacks, container } = mount();
    const trigger = button(container, "Add page");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    act(() => trigger.click());
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    act(() => button(container, "Blank page").click());
    expect(callbacks.onAddBlankPage).toHaveBeenCalledOnce();

    act(() => trigger.click());
    act(() => button(container, "Insert PDF pages").click());
    expect(callbacks.onInsertPdfPages).toHaveBeenCalledOnce();
  });

  it("closes on Escape and restores focus to the menu trigger", () => {
    const { container } = mount();
    const trigger = button(container, "Add page");
    act(() => trigger.click());
    expect(container.querySelector('[role="menu"]')).toBeTruthy();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the user points outside the menu", () => {
    const { container } = mount();
    act(() => button(container, "Add page").click());
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
