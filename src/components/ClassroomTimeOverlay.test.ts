import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLASSROOM_ALARM_SETTINGS,
  DEFAULT_CLASSROOM_POMODORO_SETTINGS,
  DEFAULT_CLASSROOM_TIME_APPEARANCE,
  DEFAULT_CLASSROOM_TIMER_SETTINGS,
  createIdlePomodoroRuntime,
  createIdleTimerRuntime,
  type ClassroomTimeWidgetMetadataV1,
} from "../lib/classroom-time/types";
import { ClassroomTimeOverlay } from "./ClassroomTimeOverlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function timerMetadata(status: "idle" | "running" | "completed" = "idle"): ClassroomTimeWidgetMetadataV1 {
  const timer = { ...DEFAULT_CLASSROOM_TIMER_SETTINGS };
  const idle = createIdleTimerRuntime(timer.durationMs);
  return {
    version: 1,
    ownerId: "timer-1",
    kind: "timer",
    label: "Exit ticket",
    appearance: { ...DEFAULT_CLASSROOM_TIME_APPEARANCE },
    timer,
    runtime: status === "running"
      ? { status: "running", remainingMs: timer.durationMs, deadlineMs: 400_000, completedAtMs: null }
      : status === "completed"
        ? { status: "completed", remainingMs: 0, deadlineMs: null, completedAtMs: 100_000 }
        : idle,
    alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
  };
}

function dashboardMetadata(): ClassroomTimeWidgetMetadataV1 {
  const timer = { ...DEFAULT_CLASSROOM_TIMER_SETTINGS };
  const pomodoro = { ...DEFAULT_CLASSROOM_POMODORO_SETTINGS };
  return {
    version: 1,
    ownerId: "dashboard-1",
    kind: "dashboard",
    label: "Class 9A",
    appearance: { ...DEFAULT_CLASSROOM_TIME_APPEARANCE },
    panels: { clock: true, timer: true, pomodoro: true, calendar: true },
    clock: {
      display: "digital",
      hourCycle: 12,
      showSeconds: true,
      showDate: true,
      showWeekday: true,
      showTimezone: false,
      timeZone: null,
    },
    timer,
    timerRuntime: createIdleTimerRuntime(timer.durationMs),
    pomodoro,
    pomodoroRuntime: createIdlePomodoroRuntime(pomodoro),
    calendar: {
      view: "month",
      showProjectEvents: true,
      showDeviceEvents: true,
      showWeekends: true,
      showWeekNumbers: false,
      highlightToday: true,
      density: "comfortable",
      projectEventIds: [],
      transferCache: null,
    },
    alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(metadata: ClassroomTimeWidgetMetadataV1, overrides: Partial<Parameters<typeof ClassroomTimeOverlay>[0]> = {}) {
  const callbacks = {
    onCommand: vi.fn(),
    onConvertToOrdinaryElements: vi.fn(),
    onCustomize: vi.fn(),
    onDeleteWidget: vi.fn(),
    onDismissCompletion: vi.fn(),
    onDuplicate: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ClassroomTimeOverlay, {
    metadata,
    nowMs: 100_000,
    ...callbacks,
    ...overrides,
  })));
  return { callbacks, container, root };
}

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
});

describe("ClassroomTimeOverlay", () => {
  it("shows selected timer state and routes compact controls", () => {
    const { callbacks, container } = mount(timerMetadata("running"));
    expect(container.textContent).toContain("Exit ticket");
    expect(container.querySelector("output")?.textContent).toBe("05:00");

    act(() => button(container, "Pause").click());
    act(() => button(container, "Reset").click());
    act(() => button(container, "Add one minute").click());
    act(() => button(container, "Customize").click());

    expect(callbacks.onCommand.mock.calls).toEqual([
      ["pause", "timer"],
      ["reset", "timer"],
      ["add-minute", "timer"],
    ]);
    expect(callbacks.onCustomize).toHaveBeenCalledOnce();
  });

  it("opens an accessible action menu and routes explicit widget actions", () => {
    const { callbacks, container } = mount(timerMetadata());
    const more = button(container, "More classroom time actions");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");

    act(() => more.click());
    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Classroom time widget actions");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(button(container, "Duplicate"));
    act(() => button(container, "Duplicate").click());
    expect(callbacks.onDuplicate).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(more);

    act(() => more.click());
    act(() => button(container, "Convert to ordinary elements").click());
    expect(callbacks.onConvertToOrdinaryElements).toHaveBeenCalledOnce();

    act(() => more.click());
    act(() => button(container, "Delete widget").click());
    expect(callbacks.onDeleteWidget).toHaveBeenCalledOnce();
  });

  it("supports menu arrow keys, Escape, outside dismissal, and trigger focus restoration", () => {
    const { container } = mount(timerMetadata());
    const more = button(container, "More classroom time actions");
    act(() => more.click());
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(button(container, "Convert to ordinary elements"));

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);

    act(() => more.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("targets the selected dashboard Pomodoro and exposes skip", () => {
    const { callbacks, container } = mount(dashboardMetadata(), { activeTarget: "pomodoro" });
    expect(container.textContent).toContain("focus");
    act(() => button(container, "Start").click());
    act(() => button(container, "Skip").click());
    expect(callbacks.onCommand.mock.calls).toEqual([
      ["start", "pomodoro"],
      ["skip", "pomodoro"],
    ]);
  });

  it("announces completion only when a completion notice is explicitly supplied", () => {
    const { container, root } = mount(timerMetadata("completed"));
    expect(container.querySelector('[role="alert"]')).toBeNull();

    const onCommand = vi.fn();
    const onDismissCompletion = vi.fn();
    act(() => root.render(createElement(ClassroomTimeOverlay, {
      metadata: timerMetadata("completed"),
      nowMs: 100_000,
      completionNotice: "Exit ticket timer finished.",
      onCommand,
      onConvertToOrdinaryElements: vi.fn(),
      onCustomize: vi.fn(),
      onDeleteWidget: vi.fn(),
      onDismissCompletion,
      onDuplicate: vi.fn(),
    })));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Time is up");
    expect(alert?.textContent).toContain("Exit ticket timer finished");
    expect(container.querySelector("output")?.getAttribute("aria-live")).toBeNull();
    act(() => button(alert!, "Dismiss").click());
    expect(onDismissCompletion).toHaveBeenCalledOnce();
    act(() => button(alert!, "Reset").click());
    expect(onCommand).toHaveBeenCalledWith("reset", "timer");
    expect(onDismissCompletion).toHaveBeenCalledTimes(2);
  });
});
