import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";

vi.mock("./SlidePreview", () => ({
  SlidePreview: () => createElement("span", { className: "slide-preview" }, "Preview"),
}));

import { SlideRail } from "./SlideRail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function project(): ClassroomProject {
  const base = createBlankProject(new Date("2026-08-08T12:00:00.000Z"));
  const sceneId = base.activeSceneId;
  return {
    ...base,
    scenes: {
      [sceneId]: {
        ...base.scenes[sceneId],
        elements: [
          { id: "frame-one", type: "frame" },
          { id: "frame-two", type: "frame" },
        ],
      },
    },
    slideOrder: [
      { id: "slide-one", sceneId, frameId: "frame-one", title: "Opening" },
      { id: "slide-two", sceneId, frameId: "frame-two", title: "Practice" },
    ],
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof SlideRail>[0]> = {}) {
  const callbacks = {
    onAddSlide: vi.fn(),
    onToggleFrameDrawing: vi.fn(),
    onToggleQuickDraw: vi.fn(),
    onOpenSlide: vi.fn(),
    onMoveSlide: vi.fn(),
    onRotateSlide: vi.fn(),
    onDeleteSlide: vi.fn(),
    onHide: vi.fn(),
    onToggleFrames: vi.fn(),
    onFrameAspectRatioChange: vi.fn(),
    onToggleMorph: vi.fn(),
    onMorphDurationChange: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(SlideRail, {
    project: project(),
    activeSlideId: "slide-one",
    frameDrawingActive: false,
    quickDrawEnabled: false,
    framesVisible: true,
    frameAspectRatio: "freeform",
    morphEnabled: false,
    morphDurationMs: 650,
    ...callbacks,
    ...overrides,
  })));
  return { callbacks, container };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("SlideRail compact controls", () => {
  it("keeps thumbnails first and opens project presentation controls on demand", () => {
    const { callbacks, container } = mount();

    expect(container.querySelector(".slide-settings-popover")).toBeNull();
    expect(container.querySelectorAll(".slide-thumbnail")).toHaveLength(2);
    act(() => button(container, "Slide settings").click());

    const dialog = container.querySelector<HTMLElement>(".slide-settings-popover");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    act(() => button(container, "Hide slide frames").click());
    expect(callbacks.onToggleFrames).toHaveBeenCalledOnce();

    act(() => button(container, "Draw slide").click());
    expect(callbacks.onToggleFrameDrawing).toHaveBeenCalledOnce();
    act(() => button(container, "Quick draw").click());
    expect(callbacks.onToggleQuickDraw).toHaveBeenCalledOnce();
    expect(container.querySelector(".slide-settings-popover")).toBeTruthy();
  });

  it("keeps reorder, rotation, and delete actions available in the selected slide menu", () => {
    const { callbacks, container } = mount();

    act(() => button(container, "Slide 1 actions: Opening").click());
    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).toBeTruthy();
    const moveLater = [...menu?.querySelectorAll<HTMLButtonElement>("button") || []]
      .find((candidate) => candidate.textContent?.includes("Move later"));
    act(() => moveLater?.click());
    expect(callbacks.onMoveSlide).toHaveBeenCalledWith("slide-one", "slide-two");

    act(() => button(container, "Slide 1 actions: Opening").click());
    const rotateSlide = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((candidate) => candidate.textContent?.includes("Rotate slide"));
    act(() => rotateSlide?.click());
    expect(callbacks.onRotateSlide).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slide-one" }),
      button(container, "Slide 1 actions: Opening"),
    );

    act(() => button(container, "Slide 1 actions: Opening").click());
    const deleteSlide = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((candidate) => candidate.textContent?.includes("Delete slide"));
    act(() => deleteSlide?.click());
    expect(callbacks.onDeleteSlide).toHaveBeenCalledWith(expect.objectContaining({ id: "slide-one" }));
  });

  it("returns keyboard focus to the slide action trigger when Escape closes its menu", () => {
    const { container } = mount();
    const trigger = button(container, "Slide 1 actions: Opening");
    act(() => trigger.click());
    const moveLater = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((candidate) => candidate.textContent?.includes("Move later"));
    moveLater?.focus();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Escape",
    })));

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a drag target cue and exposes a direct collapse control", () => {
    const { callbacks, container } = mount();
    const firstCard = container.querySelectorAll<HTMLButtonElement>(".slide-thumbnail")[0];
    const secondCard = container.querySelectorAll<HTMLButtonElement>(".slide-thumbnail")[1];
    const dragData = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => dragData.get(type) || "",
      setData: (type: string, value: string) => dragData.set(type, value),
    };
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    act(() => firstCard.dispatchEvent(dragStart));
    const dragEnter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, "dataTransfer", { value: dataTransfer });
    act(() => secondCard.dispatchEvent(dragEnter));
    expect(secondCard.closest(".slide-thumbnail-wrap")?.getAttribute("data-drop-target")).toBe("true");
    expect(secondCard.closest(".slide-thumbnail-wrap")?.getAttribute("data-drop-position")).toBe("after");

    act(() => button(container, "Hide slide navigator").click());
    expect(callbacks.onHide).toHaveBeenCalledOnce();
  });
});
