import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject, type SerializedScene } from "../types";
import { PdfPageRail } from "./PdfPageRail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.includes(label));
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function rect(top: number, bottom: number, width = 180): DOMRect {
  const height = Math.max(0, bottom - top);
  return {
    x: 0,
    y: top,
    top,
    right: width,
    bottom,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  };
}

function mount(options: {
  project?: ClassroomProject;
  pages?: readonly SerializedScene[];
} = {}) {
  const project = options.project ?? createBlankProject(new Date("2026-08-20T12:00:00.000Z"));
  const callbacks = {
    onOpenPage: vi.fn(),
    onMovePage: vi.fn(),
    onShiftPage: vi.fn(),
    onAddBlankPage: vi.fn(),
    onInsertPdfPages: vi.fn(),
    onRequestClearAnnotations: vi.fn(),
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
    pages: options.pages ?? [],
    activeSceneId: project.activeSceneId,
    width: 224,
    ...callbacks,
  })));
  return { callbacks, container };
}

function pdfProject() {
  const project = createBlankProject(new Date("2026-08-20T12:00:00.000Z"));
  const page: SerializedScene = {
    id: "pdf-page-1",
    name: "periodic-table.pdf — Page 1",
    elements: [
      { id: "pdf-background", type: "image", isDeleted: false },
      { id: "shape", type: "rectangle", isDeleted: false },
      { id: "text", type: "text", isDeleted: false },
      { id: "deleted", type: "freedraw", isDeleted: true },
    ],
    appState: {},
    files: {},
    pdfPage: {
      documentId: "pdf-document-1",
      sourceInstanceId: "source-1",
      sourceName: "periodic-table.pdf",
      pageIndex: 0,
      width: 612,
      height: 792,
      rotation: 0,
      backgroundElementId: "pdf-background",
    },
  };
  project.activeSceneId = page.id;
  project.scenes = { [page.id]: page };
  project.pdfPageOrder = [page.id];
  project.pdfDocuments = {
    "pdf-document-1": {
      id: "pdf-document-1",
      name: "periodic-table.pdf",
      mimeType: "application/pdf",
      byteLength: 100,
      pageCount: 1,
      archivePath: "pdf/pdf-document-1.pdf",
    },
  };
  return { page, project };
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
  vi.restoreAllMocks();
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

describe("PdfPageRail selected-page actions", () => {
  it("opens an accessible More menu and routes clear and delete actions", () => {
    const { page, project } = pdfProject();
    const { callbacks, container } = mount({ project, pages: [page] });
    const trigger = button(container, "More actions for output page 1");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    act(() => trigger.click());
    const menu = container.querySelector('[role="menu"][aria-label="Actions for output page 1"]');
    expect(menu).toBeTruthy();
    expect(trigger.closest(".pdf-page-item")?.classList.contains("is-actions-open")).toBe(true);
    act(() => button(container, "Clear annotations…").click());
    expect(callbacks.onRequestClearAnnotations).toHaveBeenCalledWith(page.id);
    expect(trigger.closest(".pdf-page-item")?.classList.contains("is-actions-open")).toBe(false);

    act(() => trigger.click());
    act(() => button(container, "Delete page").click());
    expect(callbacks.onDeletePage).toHaveBeenCalledWith(page.id);
  });

  it("uses the canonical PDF annotation count for its badge", () => {
    const { page, project } = pdfProject();
    const { container } = mount({ project, pages: [page] });
    expect(container.querySelector(".pdf-annotation-count")?.textContent).toBe("2");
  });

  it("supports arrow navigation, Escape, and focus restoration", () => {
    const { page, project } = pdfProject();
    const pageActionsTriggerRef = { current: null as HTMLButtonElement | null };
    const callbacks = {
      onOpenPage: vi.fn(),
      onMovePage: vi.fn(),
      onShiftPage: vi.fn(),
      onAddBlankPage: vi.fn(),
      onInsertPdfPages: vi.fn(),
      onRequestClearAnnotations: vi.fn(),
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
      pages: [page],
      activeSceneId: page.id,
      width: 224,
      pageActionsTriggerRef,
      ...callbacks,
    })));

    const trigger = button(container, "More actions for output page 1");
    expect(pageActionsTriggerRef.current).toBe(trigger);
    act(() => trigger.click());
    expect(document.activeElement?.textContent).toContain("Clear annotations");

    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
    expect(document.activeElement?.textContent).toContain("Delete page");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(container.querySelector('[role="menu"][aria-label="Actions for output page 1"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })));
    expect(document.activeElement?.textContent).toContain("Delete page");
  });

  it("closes the page-actions menu when the user points outside", () => {
    const { page, project } = pdfProject();
    const { container } = mount({ project, pages: [page] });
    act(() => button(container, "More actions for output page 1").click());
    expect(container.querySelector('[role="menu"][aria-label="Actions for output page 1"]')).toBeTruthy();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="menu"][aria-label="Actions for output page 1"]')).toBeNull();
  });

  it("opens below or above the trigger to stay inside the rail scroll viewport", () => {
    let triggerTop = 20;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("rail-scroll")) return rect(0, 200, 224);
      if (this.classList.contains("pdf-page-actions-menu")) return rect(0, 70, 172);
      if (this.getAttribute("aria-label") === "More actions for output page 1") {
        return rect(triggerTop, triggerTop + 27, 27);
      }
      return rect(0, 0, 0);
    });

    const { page, project } = pdfProject();
    const { container } = mount({ project, pages: [page] });
    const trigger = button(container, "More actions for output page 1");

    act(() => trigger.click());
    expect(container.querySelector(".pdf-page-actions-menu")?.classList.contains("is-below")).toBe(true);

    triggerTop = 160;
    act(() => container.querySelector(".rail-scroll")?.dispatchEvent(new Event("scroll")));
    expect(container.querySelector(".pdf-page-actions-menu")?.classList.contains("is-above")).toBe(true);

    triggerTop = 20;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(container.querySelector(".pdf-page-actions-menu")?.classList.contains("is-below")).toBe(true);
    act(() => trigger.click());

    // Seventy pixels below exactly matches the menu height, but the five-pixel
    // visual gap means it is not actually enough room.
    triggerTop = 103;
    act(() => trigger.click());
    expect(container.querySelector(".pdf-page-actions-menu")?.classList.contains("is-above")).toBe(true);
    act(() => trigger.click());

    triggerTop = 160;
    act(() => trigger.click());
    expect(container.querySelector(".pdf-page-actions-menu")?.classList.contains("is-above")).toBe(true);
  });
});
