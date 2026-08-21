import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PdfAnnotationClearScope,
  PdfAnnotationScopeSummary,
} from "../lib/pdf/annotations";
import {
  ClearPdfAnnotationsDialog,
  type PdfAnnotationScopeSummaries,
} from "./ClearPdfAnnotationsDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function summary(
  scope: PdfAnnotationClearScope,
  annotationCount: number,
  affectedPageCount: number,
): PdfAnnotationScopeSummary {
  const affectedPageIds = Array.from({ length: affectedPageCount }, (_, index) => `page-${index + 1}`);
  return {
    scope,
    anchorPageId: "page-1",
    annotationCount,
    affectedPageCount,
    affectedPageIds,
    pages: affectedPageIds.map((sceneId, index) => ({
      sceneId,
      annotationCount: index === 0 ? annotationCount : 0,
    })),
    sourceIdentity: scope === "source-document" ? "source-1" : undefined,
  };
}

function summaries(
  page: [number, number],
  source: [number, number],
  all: [number, number],
): PdfAnnotationScopeSummaries {
  return {
    page: summary("page", ...page),
    "source-document": summary("source-document", ...source),
    "all-pdf-pages": summary("all-pdf-pages", ...all),
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(
  scopeSummaries: PdfAnnotationScopeSummaries,
  overrides: Partial<Parameters<typeof ClearPdfAnnotationsDialog>[0]> = {},
) {
  const callbacks = { onCancel: vi.fn(), onConfirm: vi.fn() };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ClearPdfAnnotationsDialog, {
    summaries: scopeSummaries,
    sourceName: "periodic-table.pdf",
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
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ClearPdfAnnotationsDialog", () => {
  it("shows exact scope counts, defaults to this page, and confirms the chosen scope", () => {
    const { callbacks, container } = mount(summaries([1, 1], [3, 2], [8, 4]));

    expect(container.textContent).toContain("This page");
    expect(container.textContent).toContain("1 annotation on 1 affected page");
    expect(container.textContent).toContain("Pages from this source PDF");
    expect(container.textContent).toContain("3 annotations on 2 affected pages · periodic-table.pdf");
    expect(container.textContent).toContain("8 annotations on 4 affected pages");

    const pageScope = container.querySelector<HTMLInputElement>('input[value="page"]');
    const sourceScope = container.querySelector<HTMLInputElement>('input[value="source-document"]');
    expect(pageScope?.checked).toBe(true);
    expect(document.activeElement).toBe(pageScope);
    expect(button(container, "Clear 1 annotation").disabled).toBe(false);

    act(() => sourceScope?.click());
    act(() => button(container, "Clear 3 annotations").click());
    expect(callbacks.onConfirm).toHaveBeenCalledWith("source-document");
  });

  it("disables empty scopes and chooses the first scope containing annotations", () => {
    const { container } = mount(summaries([0, 0], [2, 1], [2, 1]));
    const pageScope = container.querySelector<HTMLInputElement>('input[value="page"]');
    const sourceScope = container.querySelector<HTMLInputElement>('input[value="source-document"]');

    expect(pageScope?.disabled).toBe(true);
    expect(pageScope?.checked).toBe(false);
    expect(sourceScope?.checked).toBe(true);
    expect(container.textContent).toContain("0 annotations on 0 affected pages");
    expect(button(container, "Clear 2 annotations").disabled).toBe(false);
  });

  it("disables confirmation when every scope is empty", () => {
    const { callbacks, container } = mount(summaries([0, 0], [0, 0], [0, 0]));
    const confirm = button(container, "Clear 0 annotations");
    expect(confirm.disabled).toBe(true);
    act(() => confirm.click());
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  });

  it("prevents Escape and backdrop cancellation during an active clear", () => {
    const { callbacks, container } = mount(
      summaries([1, 1], [1, 1], [1, 1]),
      { processing: true },
    );
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
    expect(button(container, "Clearing annotations…").disabled).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    act(() => container.querySelector<HTMLElement>(".pdf-clear-annotations-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it("explains that original PDF content and native annotations remain", () => {
    const { container } = mount(summaries([1, 1], [1, 1], [1, 1]));
    expect(container.textContent).toContain(
      "does not remove text, forms, graphics, or annotations already contained in the original PDF",
    );
  });

  it("closes on Escape and restores focus to the persistent page-actions trigger", () => {
    const scopeSummaries = summaries([1, 1], [1, 1], [1, 1]);
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
        }, "Page actions"),
        open ? createElement(ClearPdfAnnotationsDialog, {
          summaries: scopeSummaries,
          onCancel: () => setOpen(false),
          onConfirm: vi.fn(),
          returnFocusRef: triggerRef,
        }) : null,
      );
    }

    act(() => root.render(createElement(Harness)));
    const trigger = button(container, "Page actions");
    act(() => trigger.click());
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
