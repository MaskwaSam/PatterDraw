import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfCompatibilityImportDialog } from "./PdfCompatibilityImportDialog";
import type { PdfImportRecovery } from "../lib/pdf/import-compatibility";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof PdfCompatibilityImportDialog>[0]> = {}) {
  const callbacks = {
    onCancel: vi.fn(),
    onRetrySafetyCheck: vi.fn(),
    onSelectConvertedCopy: vi.fn(),
  };
  const recovery: PdfImportRecovery = {
    kind: "choose-converted-copy",
    code: "content-uninspectable",
    explanation: "Choose a locally converted image-only or Print to PDF copy.",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(PdfCompatibilityImportDialog, {
    fileNames: ["main.pdf"],
    recovery,
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

describe("PdfCompatibilityImportDialog", () => {
  it("offers a converted copy without decoding or retaining the rejected original", () => {
    const { callbacks, container } = mount();

    expect(container.textContent).toContain("main.pdf");
    expect(container.textContent).toContain("not an unrestricted override");
    expect(container.textContent).toContain("will not decode or store the rejected original");
    expect(container.textContent).toContain("exact same page count");
    expect(container.textContent).toContain("Searchable text, forms, links, layers");
    expect(document.activeElement).toBe(button(container, "Cancel"));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.accept).toContain("application/pdf");
    const converted = new File(["converted"], "main-flat.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { configurable: true, value: [converted] });
    act(() => input?.dispatchEvent(new Event("change", { bubbles: true })));
    expect(callbacks.onSelectConvertedCopy).toHaveBeenCalledWith(converted);
    expect(callbacks.onRetrySafetyCheck).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it("retries a worker failure without claiming to bypass the safety check", () => {
    const { callbacks, container } = mount({
      recovery: {
        kind: "retry-safety-check",
        code: "safety-worker-unavailable",
        explanation: "The safety checker did not complete.",
      },
    });

    expect(container.textContent).toContain("Retry the PDF safety check?");
    expect(container.textContent).toContain("does not bypass inspection");
    expect(container.querySelector('input[type="file"]')).toBeNull();
    act(() => button(container, "Retry safety check").click());
    expect(callbacks.onRetrySafetyCheck).toHaveBeenCalledOnce();
    expect(callbacks.onSelectConvertedCopy).not.toHaveBeenCalled();
  });

  it("summarizes a batch without exposing untrusted names as markup", () => {
    const { container } = mount({
      fileNames: ["<img src=x onerror=alert(1)>.pdf", "supplement.pdf"],
    });

    expect(container.textContent).toContain("2 selected PDFs");
    expect(container.querySelector("img")).toBeNull();
  });

  it("locks every action while the retry is running", () => {
    const { callbacks, container } = mount({
      processing: true,
      recovery: {
        kind: "retry-safety-check",
        code: "safety-inspection-timeout",
        explanation: "The safety checker timed out.",
      },
    });

    expect(button(container, "Retrying safety check…").disabled).toBe(true);
    expect(button(container, "Cancel").disabled).toBe(true);
    act(() => container.querySelector<HTMLElement>(".pdf-compatibility-import-backdrop")
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));

    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(callbacks.onRetrySafetyCheck).not.toHaveBeenCalled();
    expect(callbacks.onSelectConvertedCopy).not.toHaveBeenCalled();
  });
});
