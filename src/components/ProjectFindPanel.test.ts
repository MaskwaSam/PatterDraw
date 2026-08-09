import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";
import { ProjectFindPanel } from "./ProjectFindPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

function projectWithText(): ClassroomProject {
  const project = createBlankProject(new Date("2026-08-08T12:00:00.000Z"));
  const scene = project.scenes[project.activeSceneId];
  if (!scene) throw new Error("The blank project did not include an active scene.");
  project.scenes[project.activeSceneId] = {
    ...scene,
    elements: [{
      id: "lesson-text",
      type: "text",
      text: "Lesson text",
      isDeleted: false,
    }],
  };
  return project;
}

function mount() {
  const parent = document.createElement("div");
  const container = document.createElement("div");
  parent.append(container);
  document.body.append(parent);
  const root = createRoot(container);
  roots.push(root);
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onOpenCanvasSearch = vi.fn();
  act(() => root.render(createElement(ProjectFindPanel, {
    project: projectWithText(),
    onActivate,
    onClose,
    onOpenCanvasSearch,
  })));
  return { container, onActivate, onClose, onOpenCanvasSearch, parent };
}

beforeEach(() => {
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
  originalScrollIntoView = undefined;
});

describe("ProjectFindPanel keyboard isolation", () => {
  it("keeps search navigation working without bubbling keys into the editor", () => {
    const { container, onActivate, onClose, parent } = mount();
    const bubbledKeyDown = vi.fn();
    const bubbledKeyUp = vi.fn();
    parent.addEventListener("keydown", bubbledKeyDown);
    parent.addEventListener("keyup", bubbledKeyUp);

    const input = container.querySelector<HTMLInputElement>(".project-find-query");
    if (!input) throw new Error("Project Find input was not rendered.");
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "lesson");
    act(() => input.dispatchEvent(new Event("input", { bubbles: true })));

    const result = container.querySelector<HTMLButtonElement>(".project-find-result");
    expect(result).not.toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBe(result?.id);
    expect(result?.getAttribute("role")).toBe("option");
    expect(result?.getAttribute("aria-selected")).toBe("true");

    const printable = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "b",
    });
    act(() => input.dispatchEvent(printable));
    act(() => input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "b" })));
    expect(printable.defaultPrevented).toBe(false);
    expect(bubbledKeyDown).not.toHaveBeenCalled();
    expect(bubbledKeyUp).not.toHaveBeenCalled();

    const arrow = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    act(() => input.dispatchEvent(arrow));
    expect(arrow.defaultPrevented).toBe(true);
    expect(bubbledKeyDown).not.toHaveBeenCalled();

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    expect(onActivate).toHaveBeenCalledOnce();
    expect(bubbledKeyDown).not.toHaveBeenCalled();

    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    act(() => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(bubbledKeyDown).not.toHaveBeenCalled();
  });

  it("isolates editor shortcuts while preserving focused button activation", () => {
    const { container, onClose, onOpenCanvasSearch, parent } = mount();
    const bubbledKeyDown = vi.fn();
    const bubbledKeyUp = vi.fn();
    parent.addEventListener("keydown", bubbledKeyDown);
    parent.addEventListener("keyup", bubbledKeyUp);

    const input = container.querySelector<HTMLInputElement>(".project-find-query");
    if (!input) throw new Error("Project Find input was not rendered.");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "lesson");
    act(() => input.dispatchEvent(new Event("input", { bubbles: true })));

    const result = container.querySelector<HTMLButtonElement>(".project-find-result");
    const canvasSearch = container.querySelector<HTMLButtonElement>(".project-find-canvas-search");
    expect(result).not.toBeNull();
    expect(canvasSearch).not.toBeNull();
    result?.focus();
    act(() => result?.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "b",
    })));
    expect(bubbledKeyDown).not.toHaveBeenCalled();

    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    act(() => result?.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();

    const activateWithKey = (button: HTMLButtonElement, key: "Enter" | " ") => {
      // Browsers synthesize a click for these keys after the keydown reaches
      // the focused button. This target listener models that default action;
      // a capture-time stopPropagation would prevent it from running.
      button.addEventListener("keydown", (event) => {
        if (event.key === key && !event.defaultPrevented) button.click();
      }, { once: true });
      act(() => button.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      })));
      act(() => button.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key })));
    };

    if (!canvasSearch) throw new Error("Canvas search button was not rendered.");
    canvasSearch.focus();
    activateWithKey(canvasSearch, "Enter");
    canvasSearch.focus();
    activateWithKey(canvasSearch, " ");

    expect(onOpenCanvasSearch).toHaveBeenCalledTimes(2);
    expect(bubbledKeyDown).not.toHaveBeenCalled();
    expect(bubbledKeyUp).not.toHaveBeenCalled();
  });
});
