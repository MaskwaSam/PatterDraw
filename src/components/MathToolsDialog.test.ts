import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPERIMENTAL_FEATURES_STORAGE_KEY } from "../lib/experimental-features";
import { MathToolsDialog } from "./MathToolsDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.setItem(EXPERIMENTAL_FEATURES_STORAGE_KEY, "enabled");
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

describe("MathToolsDialog classroom category", () => {
  it("shows five live-widget cards and routes each through the wrapper callback", () => {
    const onOpenClassroomTimeTool = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(createElement(MathToolsDialog, {
      onCancel: vi.fn(),
      onOpenGeoGon: vi.fn(),
      onOpenClassroomTimeTool,
      onInsert: vi.fn(),
      onStartInteraction: vi.fn(),
    })));

    act(() => button(container, "Classroom").click());
    expect(container.querySelectorAll(".classroom-time-tool-card")).toHaveLength(5);
    for (const [id, kind] of [
      ["classroom-clock", "clock"],
      ["classroom-timer", "timer"],
      ["classroom-pomodoro", "pomodoro"],
      ["classroom-calendar", "calendar"],
      ["classroom-dashboard", "dashboard"],
    ] as const) {
      const card = container.querySelector<HTMLButtonElement>(`[data-testid="math-tool-${id}"]`);
      if (!card) throw new Error(`Classroom card ${id} was not rendered.`);
      act(() => card.click());
      expect(onOpenClassroomTimeTool).toHaveBeenLastCalledWith(kind);
    }
  });
});
