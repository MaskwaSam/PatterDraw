import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PdfInsertDialog,
  parsePdfPageRange,
  type PdfInsertFileRowMetadata,
} from "./PdfInsertDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(files: readonly PdfInsertFileRowMetadata[], overrides: Partial<Parameters<typeof PdfInsertDialog>[0]> = {}) {
  const callbacks = {
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    onCancelProcessing: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(PdfInsertDialog, {
    files,
    remainingPageCapacity: 20,
    ...callbacks,
    ...overrides,
  })));
  return { callbacks, container };
}

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("parsePdfPageRange", () => {
  it("returns zero-based indices while preserving order and repeated pages", () => {
    expect(parsePdfPageRange("1-3, 2, 5, 5", 5)).toEqual({
      pageIndices: [0, 1, 2, 1, 4, 4],
      error: null,
    });
  });

  it("reports malformed, descending, and out-of-bounds ranges", () => {
    expect(parsePdfPageRange("1-", 5).error).toMatch(/valid PDF page range/i);
    expect(parsePdfPageRange("4-2", 5).error).toMatch(/lower page/i);
    expect(parsePdfPageRange("6", 5).error).toMatch(/outside/i);
  });
});

describe("PdfInsertDialog", () => {
  const files: readonly PdfInsertFileRowMetadata[] = [
    { id: "main", name: "main.pdf", pageCount: 3, rangeText: "1-3" },
    { id: "periodic", name: "periodic-table.pdf", pageCount: 2, rangeText: "2, 2" },
  ];

  it("submits the edited file order, repeated source pages, and placement", () => {
    const { callbacks, container } = mount(files);
    act(() => button(container, "Move periodic-table.pdf earlier").click());
    const before = container.querySelector<HTMLInputElement>('input[value="before"]');
    act(() => before?.click());
    act(() => button(container, "Insert 5 pages").click());

    expect(callbacks.onSubmit).toHaveBeenCalledWith({
      selections: [
        { id: "periodic", pageIndices: [1, 1] },
        { id: "main", pageIndices: [0, 1, 2] },
      ],
      placement: "before",
    });
  });

  it("disables insertion and explains a capacity overflow", () => {
    const { callbacks, container } = mount(files, { remainingPageCapacity: 4 });
    const submit = button(container, "Insert 5 pages");
    expect(submit.disabled).toBe(true);
    expect(container.textContent).toContain("1 more than the remaining capacity of 4");
    act(() => submit.click());
    expect(callbacks.onSubmit).not.toHaveBeenCalled();
  });

  it("shows structured progress and routes cancellation to the active operation", () => {
    const { callbacks, container } = mount(files, {
      processing: true,
      progress: {
        phase: "rendering",
        documentPosition: 2,
        documentTotal: 3,
        pagePosition: 4,
        pageTotal: 6,
      },
    });
    expect(container.textContent).toContain("rendering · Document 2 of 3 · Page 4 of 6");
    act(() => button(container, "Cancel insertion").click());
    expect(callbacks.onCancelProcessing).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });
});
