import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredScreenshot } from "../lib/screenshots/persistence";
import type { SerializedScene } from "../types";

// React 18's `act` helper checks this flag before flushing updates from
// visibility callbacks and effect cleanups. Keep the test environment honest
// so preview lifecycle assertions do not emit a warning for every update.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { renderSlideThumbnailMock, slidePreviewRevisionMock } = vi.hoisted(() => ({
  renderSlideThumbnailMock: vi.fn(),
  slidePreviewRevisionMock: vi.fn(),
}));

vi.mock("../lib/slide-thumbnail", () => ({
  renderSlideThumbnail: renderSlideThumbnailMock,
}));

vi.mock("../lib/slide-render", () => ({
  slidePreviewRevision: slidePreviewRevisionMock,
}));

import { ScreenshotLibrary } from "./ScreenshotLibrary";
import { SlidePreview } from "./SlidePreview";

const emptyRect: DOMRectReadOnly = {
  bottom: 0,
  height: 0,
  left: 0,
  right: 0,
  top: 0,
  width: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};

class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds: readonly number[];
  readonly targets = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root || null;
    this.rootMargin = options.rootMargin || "0px";
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold || 0];
    MockIntersectionObserver.instances.push(this);
  }

  disconnect() {
    this.targets.clear();
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  setIntersecting(target: Element, isIntersecting: boolean) {
    this.callback([{
      boundingClientRect: emptyRect,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: emptyRect,
      isIntersecting,
      rootBounds: null,
      target,
      time: 0,
    }], this);
  }
}

function observerFor(target: Element): MockIntersectionObserver {
  const observer = MockIntersectionObserver.instances.find((candidate) => (
    candidate.targets.has(target)
  ));
  if (!observer) throw new Error("No visibility observer was registered for the preview.");
  return observer;
}

function screenshot(id: string): StoredScreenshot {
  return {
    id,
    createdAt: Date.UTC(2026, 6, 30, 12),
    blob: new Blob([id], { type: "image/png" }),
    width: 640,
    height: 480,
    sceneWidth: 320,
    sceneHeight: 240,
  };
}

function scene(elements: readonly Record<string, unknown>[] = []): SerializedScene {
  return {
    id: "scene",
    name: "Board",
    elements,
    appState: {},
    files: {},
  };
}

const roots: Root[] = [];

function render(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  MockIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.spyOn(URL, "createObjectURL")
    .mockImplementationOnce(() => "blob:test-1")
    .mockImplementationOnce(() => "blob:test-2");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  renderSlideThumbnailMock.mockReset();
  slidePreviewRevisionMock.mockReset();
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("low-memory preview visibility", () => {
  it("creates and decodes screenshot URLs only while their cards are near the viewport", () => {
    const items = [screenshot("one"), screenshot("two")];
    const container = render(createElement(ScreenshotLibrary, {
      busy: false,
      loading: false,
      items,
      onCaptureArea: vi.fn(),
      onCopy: vi.fn(),
      onDelete: vi.fn(),
      onDownload: vi.fn(),
      onInsert: vi.fn(),
    }));
    const thumbnails = [...container.querySelectorAll<HTMLButtonElement>(
      ".screenshot-card-thumbnail",
    )];

    expect(thumbnails).toHaveLength(2);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".screenshot-card-thumbnail img")).toHaveLength(0);
    expect(observerFor(thumbnails[0]).root)
      .toBe(container.querySelector(".screenshot-library"));
    expect(observerFor(thumbnails[0]).rootMargin).toBe("240px 0px");

    act(() => observerFor(thumbnails[0]).setIntersecting(thumbnails[0], true));

    const image = thumbnails[0].querySelector("img");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(items[0].blob);
    expect(image?.getAttribute("src")).toBe("blob:test-1");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
    expect(thumbnails[1].querySelector("img")).toBeNull();

    act(() => observerFor(thumbnails[0]).setIntersecting(thumbnails[0], false));

    expect(thumbnails[0].querySelector("img")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
  });

  it("defers slide revision and rendering work, then reuses the revision while unchanged", async () => {
    const input = scene([{ id: "frame", version: 1 }]);
    slidePreviewRevisionMock.mockReturnValue("revision-1");
    renderSlideThumbnailMock.mockResolvedValue(new Blob(["preview"], { type: "image/png" }));
    const container = render(createElement(SlidePreview, {
      scene: input,
      frameId: "frame",
    }));
    const preview = container.querySelector<HTMLElement>(".slide-preview");
    if (!preview) throw new Error("Slide preview was not rendered.");
    const observer = observerFor(preview);

    expect(slidePreviewRevisionMock).not.toHaveBeenCalled();
    expect(renderSlideThumbnailMock).not.toHaveBeenCalled();
    expect(observer.rootMargin).toBe("180px 0px");

    act(() => observer.setIntersecting(preview, true));
    expect(slidePreviewRevisionMock).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderSlideThumbnailMock).toHaveBeenCalledOnce();
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("blob:test-1");

    act(() => observer.setIntersecting(preview, false));
    expect(preview.querySelector("img")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");

    act(() => observer.setIntersecting(preview, true));
    expect(slidePreviewRevisionMock).toHaveBeenCalledOnce();

    act(() => observer.setIntersecting(preview, false));
    const changedScene = scene([{ id: "frame", version: 2 }]);
    const root = roots.at(-1);
    if (!root) throw new Error("Slide preview root was not retained.");
    act(() => root.render(createElement(SlidePreview, {
      scene: changedScene,
      frameId: "frame",
    })));
    act(() => observer.setIntersecting(preview, true));
    expect(slidePreviewRevisionMock).toHaveBeenCalledTimes(2);
  });
});
