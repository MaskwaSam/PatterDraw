import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassroomSlide } from "../types";
import {
  DEFAULT_CLASSROOM_ALARM_SETTINGS,
  DEFAULT_CLASSROOM_CALENDAR_SETTINGS,
  DEFAULT_CLASSROOM_CLOCK_SETTINGS,
  DEFAULT_CLASSROOM_POMODORO_SETTINGS,
  DEFAULT_CLASSROOM_TIME_APPEARANCE,
  DEFAULT_CLASSROOM_TIMER_SETTINGS,
  createIdlePomodoroRuntime,
  type ClassroomTimeWidgetMetadataV1,
} from "../lib/classroom-time/types";
import { PresentationOverlay } from "./PresentationOverlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLIDES: readonly ClassroomSlide[] = [
  { id: "one", sceneId: "scene", frameId: "frame-one", title: "Welcome" },
  { id: "two", sceneId: "scene", frameId: "frame-two", title: "Practice" },
  { id: "three", sceneId: "scene", frameId: "frame-three", title: "Review" },
];

const roots: Root[] = [];

function runningTimerMetadata(): ClassroomTimeWidgetMetadataV1 {
  return {
    version: 1,
    ownerId: "presentation-timer",
    kind: "timer",
    label: "Group work",
    appearance: { ...DEFAULT_CLASSROOM_TIME_APPEARANCE },
    timer: { ...DEFAULT_CLASSROOM_TIMER_SETTINGS },
    runtime: {
      status: "running",
      remainingMs: 300_000,
      deadlineMs: 400_000,
      completedAtMs: null,
    },
    alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
  };
}

function dashboardMetadata(): ClassroomTimeWidgetMetadataV1 {
  const timer = { ...DEFAULT_CLASSROOM_TIMER_SETTINGS };
  const pomodoro = { ...DEFAULT_CLASSROOM_POMODORO_SETTINGS };
  return {
    version: 1,
    ownerId: "presentation-dashboard",
    kind: "dashboard",
    label: "Class dashboard",
    appearance: { ...DEFAULT_CLASSROOM_TIME_APPEARANCE },
    panels: { clock: true, timer: true, pomodoro: true, calendar: false },
    clock: { ...DEFAULT_CLASSROOM_CLOCK_SETTINGS },
    timer,
    timerRuntime: { status: "idle", remainingMs: timer.durationMs, deadlineMs: null, completedAtMs: null },
    pomodoro,
    pomodoroRuntime: createIdlePomodoroRuntime(pomodoro),
    calendar: { ...DEFAULT_CLASSROOM_CALENDAR_SETTINGS, projectEventIds: [], transferCache: null },
    alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof PresentationOverlay>[0]> = {}) {
  const callbacks = {
    onIndexChange: vi.fn(),
    onToolChange: vi.fn(),
    onClassroomTimeCommand: vi.fn(),
    onInkColourChange: vi.fn(),
    onInkWidthChange: vi.fn(),
    onExit: vi.fn(),
  };
  const props: Parameters<typeof PresentationOverlay>[0] = {
    slides: SLIDES,
    index: 1,
    tool: "laser",
    inkColour: "#1b1b1f",
    inkWidth: 3,
    ...callbacks,
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(PresentationOverlay, props)));
  return {
    callbacks,
    container,
    unmount() {
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
      act(() => root.unmount());
    },
  };
}

function keydown(
  target: EventTarget,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PresentationOverlay controls", () => {
  it("starts expanded with a named toggle and a polite atomic slide status", () => {
    const { container } = mount();

    expect(container.querySelector('[role="toolbar"]')?.getAttribute("aria-label"))
      .toBe("Presentation controls");
    const collapse = button(container, "Collapse presentation controls");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(collapse.getAttribute("aria-keyshortcuts")).toBe("C");
    expect(collapse.textContent).toContain("Collapse");

    const status = container.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent?.trim()).toBe("Slide 2 of 3");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
  });

  it("collapses and expands by click while transferring focus to the available toggle", () => {
    vi.useFakeTimers();
    const { container } = mount();

    act(() => button(container, "Collapse presentation controls").click());
    const expand = button(container, "Expand presentation controls");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-keyshortcuts")).toBe("C");
    expect(document.activeElement).toBe(expand);
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe("Slide 2 of 3");

    act(() => expand.click());
    expect(button(container, "Expand presentation controls")).toBe(expand);

    act(() => vi.advanceTimersByTime(350));
    act(() => expand.click());
    const collapse = button(container, "Collapse presentation controls");
    expect(document.activeElement).toBe(collapse);
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
  });

  it("owns every plain-C keydown while absorbing repeats and rapid discrete presses", () => {
    vi.useFakeTimers();
    const { container } = mount();
    const laterWindowListener = vi.fn();
    window.addEventListener("keydown", laterWindowListener, true);

    try {
      const repeated = keydown(document.body, "c", { repeat: true });
      expect(repeated.defaultPrevented).toBe(true);
      expect(laterWindowListener).not.toHaveBeenCalled();
      expect(button(container, "Collapse presentation controls")).toBeTruthy();

      const collapse = keydown(document.body, "C");
      expect(collapse.defaultPrevented).toBe(true);
      expect(laterWindowListener).not.toHaveBeenCalled();
      expect(button(container, "Expand presentation controls")).toBe(document.activeElement);

      const repeatedCollapsed = keydown(document.body, "c", { repeat: true });
      expect(repeatedCollapsed.defaultPrevented).toBe(true);
      expect(button(container, "Expand presentation controls")).toBeTruthy();

      const rapidSecondPress = keydown(document.body, "c");
      expect(rapidSecondPress.defaultPrevented).toBe(true);
      expect(button(container, "Expand presentation controls")).toBe(document.activeElement);

      act(() => vi.advanceTimersByTime(350));
      const expand = keydown(document.body, "c");
      expect(expand.defaultPrevented).toBe(true);
      expect(button(container, "Collapse presentation controls")).toBe(document.activeElement);

      const modified = keydown(document.body, "c", { ctrlKey: true });
      expect(modified.defaultPrevented).toBe(false);
      expect(laterWindowListener).toHaveBeenCalledOnce();
      expect(button(container, "Collapse presentation controls")).toBeTruthy();
    } finally {
      window.removeEventListener("keydown", laterWindowListener, true);
    }
  });

  it("keeps navigation and exit shortcuts available when no surface owns the keyboard", () => {
    const { callbacks } = mount();

    expect(keydown(document.body, "ArrowRight").defaultPrevented).toBe(true);
    expect(keydown(document.body, "Home").defaultPrevented).toBe(true);
    expect(keydown(document.body, "End").defaultPrevented).toBe(true);
    expect(keydown(document.body, "Escape").defaultPrevented).toBe(true);

    expect(callbacks.onIndexChange.mock.calls).toEqual([[2], [0], [2]]);
    expect(callbacks.onExit).toHaveBeenCalledOnce();
  });

  it("exposes a React-owned eraser and keeps tool shortcuts synchronized", () => {
    const { callbacks, container } = mount({ tool: "eraser" });
    const eraser = button(container, "Eraser");

    expect(eraser.getAttribute("aria-pressed")).toBe("true");
    expect(eraser.getAttribute("aria-keyshortcuts")).toBe("E 0");
    expect(button(container, "Ink").getAttribute("aria-keyshortcuts")).toBe("P 7");
    expect(button(container, "Laser").getAttribute("aria-keyshortcuts")).toBe("K");

    act(() => eraser.click());
    expect(keydown(document.body, "e").defaultPrevented).toBe(true);
    expect(keydown(document.body, "0").defaultPrevented).toBe(true);
    expect(keydown(document.body, "p").defaultPrevented).toBe(true);
    expect(keydown(document.body, "7").defaultPrevented).toBe(true);
    expect(keydown(document.body, "k").defaultPrevented).toBe(true);
    expect(keydown(document.body, "e", { repeat: true }).defaultPrevented).toBe(true);

    expect(callbacks.onToolChange.mock.calls).toEqual([
      ["eraser"],
      ["eraser"],
      ["eraser"],
      ["freedraw"],
      ["freedraw"],
      ["laser"],
    ]);
  });

  it("keeps selected timer controls usable during presentation", () => {
    const { callbacks, container } = mount({
      classroomTime: {
        metadata: runningTimerMetadata(),
        nowMs: 100_000,
        activeTarget: "timer",
      },
    });

    expect(container.textContent).toContain("Group work · 05:00");
    act(() => button(container, "Pause").click());
    act(() => button(container, "Reset").click());
    act(() => button(container, "Add one minute").click());

    expect(callbacks.onClassroomTimeCommand.mock.calls).toEqual([
      ["pause", "timer"],
      ["reset", "timer"],
      ["add-minute", "timer"],
    ]);
  });

  it("lets a dashboard switch between Timer and Pomodoro controls", () => {
    const onClassroomTimeTargetChange = vi.fn();
    const { container } = mount({
      classroomTime: {
        metadata: dashboardMetadata(),
        nowMs: 100_000,
        activeTarget: "timer",
      },
      onClassroomTimeTargetChange,
    });

    expect(button(container, "Control dashboard timer").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "Control dashboard Pomodoro").getAttribute("aria-pressed")).toBe("false");
    act(() => button(container, "Control dashboard Pomodoro").click());
    expect(onClassroomTimeTargetChange).toHaveBeenCalledWith("pomodoro");
  });

  it("does not intercept shortcuts from editable or modal interaction surfaces", () => {
    const { callbacks, container } = mount();
    const surfaces = [
      ["input", '<input aria-label="Speaker notes">'],
      ["dialog", '<div role="dialog"><button type="button">Dialog action</button></div>'],
      ["menu", '<div role="menu"><button role="menuitem" type="button">Menu action</button></div>'],
      ["listbox", '<div role="listbox"><div role="option" tabindex="0">Choice</div></div>'],
      ["busy", '<div aria-busy="true"><button type="button">Cancel operation</button></div>'],
      ["modal class", '<div class="modal-backdrop"><button type="button">Modal action</button></div>'],
    ] as const;

    for (const [label, markup] of surfaces) {
      const host = document.createElement("div");
      host.innerHTML = markup;
      document.body.append(host);
      const target = host.querySelector<HTMLElement>("input, button, [role='option']");
      if (!target) throw new Error(`${label} surface did not render a keyboard target.`);

      expect(keydown(target, "c").defaultPrevented, label).toBe(false);
      expect(keydown(target, "e").defaultPrevented, label).toBe(false);
      expect(keydown(target, "ArrowRight").defaultPrevented, label).toBe(false);
      expect(keydown(target, "Escape").defaultPrevented, label).toBe(false);
      host.remove();
    }

    expect(callbacks.onIndexChange).not.toHaveBeenCalled();
    expect(callbacks.onExit).not.toHaveBeenCalled();
    expect(callbacks.onToolChange).not.toHaveBeenCalled();
    expect(button(container, "Collapse presentation controls")).toBeTruthy();
  });

  it("pauses every global shortcut without disabling the presentation toolbar", () => {
    vi.useFakeTimers();
    const { callbacks, container } = mount({ shortcutsPaused: true });

    const events = [
      keydown(document.body, "c"),
      keydown(document.body, "e"),
      keydown(document.body, "ArrowRight"),
      keydown(document.body, "Home"),
      keydown(document.body, "Escape"),
    ];
    expect(events.every((event) => !event.defaultPrevented)).toBe(true);
    expect(callbacks.onIndexChange).not.toHaveBeenCalled();
    expect(callbacks.onExit).not.toHaveBeenCalled();
    expect(callbacks.onToolChange).not.toHaveBeenCalled();

    act(() => button(container, "Collapse presentation controls").click());
    expect(button(container, "Expand presentation controls")).toBe(document.activeElement);
    act(() => vi.advanceTimersByTime(350));
    act(() => button(container, "Expand presentation controls").click());
    expect(button(container, "Collapse presentation controls")).toBe(document.activeElement);
  });

  it("removes its global listener when unmounted", () => {
    const { callbacks, unmount } = mount();
    unmount();

    expect(keydown(document.body, "ArrowRight").defaultPrevented).toBe(false);
    expect(keydown(document.body, "Escape").defaultPrevented).toBe(false);
    expect(keydown(document.body, "c").defaultPrevented).toBe(false);
    expect(callbacks.onIndexChange).not.toHaveBeenCalled();
    expect(callbacks.onExit).not.toHaveBeenCalled();
  });
});
