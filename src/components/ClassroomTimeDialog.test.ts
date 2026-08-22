import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLASSROOM_ALARM_SETTINGS,
  DEFAULT_CLASSROOM_CALENDAR_SETTINGS,
  DEFAULT_CLASSROOM_CLOCK_SETTINGS,
  DEFAULT_CLASSROOM_POMODORO_SETTINGS,
  DEFAULT_CLASSROOM_TIME_APPEARANCE,
  DEFAULT_CLASSROOM_TIMER_SETTINGS,
  createIdlePomodoroRuntime,
  createIdleTimerRuntime,
  type ClassroomTimeWidgetMetadataV1,
} from "../lib/classroom-time/types";
import {
  ClassroomTimeDialog,
  durationFromParts,
  durationParts,
  type ClassroomCalendarEventCreateResult,
} from "./ClassroomTimeDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const appearance = () => ({ ...DEFAULT_CLASSROOM_TIME_APPEARANCE });
const alarm = () => ({ ...DEFAULT_CLASSROOM_ALARM_SETTINGS });
const clock = () => ({ ...DEFAULT_CLASSROOM_CLOCK_SETTINGS });
const timer = () => ({ ...DEFAULT_CLASSROOM_TIMER_SETTINGS });
const pomodoro = () => ({ ...DEFAULT_CLASSROOM_POMODORO_SETTINGS });
const calendar = () => ({ ...DEFAULT_CLASSROOM_CALENDAR_SETTINGS, projectEventIds: [], transferCache: null });

function timerMetadata(): ClassroomTimeWidgetMetadataV1 {
  const settings = timer();
  return {
    version: 1,
    ownerId: "timer-1",
    kind: "timer",
    label: "Class Timer",
    appearance: appearance(),
    timer: settings,
    runtime: createIdleTimerRuntime(settings.durationMs),
    alarm: alarm(),
  };
}

function clockMetadata(): ClassroomTimeWidgetMetadataV1 {
  return {
    version: 1,
    ownerId: "clock-1",
    kind: "clock",
    label: "Class Clock",
    appearance: appearance(),
    clock: clock(),
  };
}

function calendarMetadata(): ClassroomTimeWidgetMetadataV1 {
  return {
    version: 1,
    ownerId: "calendar-1",
    kind: "calendar",
    label: "Class Calendar",
    appearance: appearance(),
    calendar: calendar(),
  };
}

function dashboardMetadata(): ClassroomTimeWidgetMetadataV1 {
  const timerSettings = timer();
  const pomodoroSettings = pomodoro();
  return {
    version: 1,
    ownerId: "dashboard-1",
    kind: "dashboard",
    label: "Classroom Dashboard",
    appearance: appearance(),
    panels: { clock: true, timer: true, pomodoro: true, calendar: true },
    clock: clock(),
    timer: timerSettings,
    timerRuntime: createIdleTimerRuntime(timerSettings.durationMs),
    pomodoro: pomodoroSettings,
    pomodoroRuntime: createIdlePomodoroRuntime(pomodoroSettings),
    calendar: calendar(),
    alarm: alarm(),
  };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function controlInLabel<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(container: ParentNode, label: string): T {
  const match = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.textContent?.includes(label))
    ?.querySelector<T>("input, select, textarea");
  if (!match) throw new Error(`Control ${label} was not rendered.`);
  return match;
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = control instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function mount(metadata: ClassroomTimeWidgetMetadataV1, overrides: Partial<Parameters<typeof ClassroomTimeDialog>[0]> = {}) {
  const callbacks = {
    onAlarmPreferencesChange: vi.fn(),
    onCancel: vi.fn(),
    onCreateCalendarEvent: vi.fn(async () => ({ status: "created" } as const)),
    onRestoreDefaults: vi.fn(() => metadata),
    onSubmit: vi.fn(),
    onTestAlarm: vi.fn(),
    onUseAsDefault: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ClassroomTimeDialog, {
    metadata,
    alarmMuted: false,
    alarmVolume: 0.7,
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

describe("ClassroomTimeDialog duration helpers", () => {
  it("round-trips bounded hour, minute, and second values", () => {
    expect(durationParts(durationFromParts(2, 3, 4))).toEqual({ hours: 2, minutes: 3, seconds: 4 });
    expect(durationParts(durationFromParts(100, 90, 90))).toEqual({ hours: 99, minutes: 59, seconds: 59 });
    expect(durationFromParts(0, 0, 0)).toBe(1_000);
  });
});

describe("ClassroomTimeDialog", () => {
  it("describes project-saved and device-local data without implying the whole widget is device-only", () => {
    const { container } = mount(calendarMetadata());
    const help = container.querySelector("#classroom-time-dialog-help")?.textContent;
    expect(help).toContain("Widgets and project events are saved in this PatterDraw project");
    expect(help).toContain("Alarm sound and new-widget defaults stay on this device");
    expect(help).toContain("device events are not added to project files");
    expect(help).not.toContain("Everything stays on this device");
  });

  it("previews explicit themes and follows the current board theme", () => {
    const { container } = mount(clockMetadata(), { boardTheme: "dark" });
    const preview = container.querySelector<HTMLElement>(".classroom-time-dialog-preview")!;
    expect(preview.dataset.theme).toBe("dark");
    const followedBackground = preview.style.background;

    act(() => setControlValue(controlInLabel(container, "Theme"), "light"));
    expect(preview.dataset.theme).toBe("light");
    expect(preview.style.background).not.toBe(followedBackground);

    act(() => setControlValue(controlInLabel(container, "Theme"), "dark"));
    expect(preview.dataset.theme).toBe("dark");
    expect(preview.style.background).toBe(followedBackground);
  });

  it("customizes timer and alarm settings and tests the selected local tone", () => {
    const { callbacks, container } = mount(timerMetadata());

    act(() => button(container, "Timer").click());
    act(() => setControlValue(container.querySelector<HTMLInputElement>('[aria-label="Timer minutes"]')!, "7"));
    act(() => setControlValue(controlInLabel(container, "Progress style"), "bar"));

    act(() => button(container, "Alarm").click());
    act(() => setControlValue(controlInLabel(container, "Tone"), "bright-marimba"));
    act(() => controlInLabel<HTMLInputElement>(container, "Repeat every").click());
    act(() => button(container, "Test alarm").click());
    expect(callbacks.onTestAlarm).toHaveBeenCalledWith("bright-marimba");

    act(() => button(container, "Add Timer").click());
    const submitted = callbacks.onSubmit.mock.calls[0][0] as ClassroomTimeWidgetMetadataV1;
    expect(submitted.kind).toBe("timer");
    if (submitted.kind !== "timer") throw new Error("Expected timer metadata.");
    expect(submitted.timer).toMatchObject({ durationMs: 7 * 60_000, progressStyle: "bar" });
    expect(submitted.runtime).toMatchObject({ status: "idle", remainingMs: 7 * 60_000 });
    expect(submitted.alarm).toMatchObject({ tone: "bright-marimba", repeat: true });
  });

  it("supports clock display, format, visibility, and timezone controls", () => {
    const { callbacks, container } = mount(clockMetadata(), { mode: "update" });
    act(() => button(container, "Clock").click());
    act(() => button(container, "Analog").click());
    act(() => setControlValue(controlInLabel(container, "Time format"), "24"));
    act(() => controlInLabel<HTMLInputElement>(container, "Show seconds").click());
    act(() => controlInLabel<HTMLInputElement>(container, "Show timezone label").click());
    act(() => setControlValue(controlInLabel(container, "Timezone"), "America/Edmonton"));
    act(() => button(container, "Save changes").click());

    const submitted = callbacks.onSubmit.mock.calls[0][0] as ClassroomTimeWidgetMetadataV1;
    expect(submitted.kind).toBe("clock");
    if (submitted.kind !== "clock") throw new Error("Expected clock metadata.");
    expect(submitted.clock).toMatchObject({ display: "analog", hourCycle: 24, showSeconds: false, showTimezone: true, timeZone: "America/Edmonton" });
  });

  it("adds a device-local timed calendar event and keeps event layers independently toggleable", async () => {
    const { callbacks, container } = mount(calendarMetadata(), { projectEventCount: 3, deviceEventCount: 2 });
    act(() => button(container, "Calendar").click());
    expect(container.textContent).toContain("Project events (3)");
    expect(container.textContent).toContain("Device events (2)");

    act(() => setControlValue(controlInLabel(container, "Save to"), "device"));
    act(() => setControlValue(controlInLabel(container, "Title"), "Chemistry lab"));
    act(() => setControlValue(controlInLabel(container, "Optional note"), "Bring goggles"));
    act(() => controlInLabel<HTMLInputElement>(container, "All-day event").click());
    act(() => setControlValue(controlInLabel(container, "Starts"), "13:15"));
    act(() => setControlValue(controlInLabel(container, "Ends"), "14:30"));
    await act(async () => {
      button(container, "Add event").click();
      await Promise.resolve();
    });

    expect(callbacks.onCreateCalendarEvent).toHaveBeenCalledWith("device", expect.objectContaining({
      title: "Chemistry lab",
      note: "Bring goggles",
      allDay: false,
      startTime: "13:15",
      endTime: "14:30",
    }));
    expect(controlInLabel<HTMLInputElement>(container, "Title").value).toBe("");
    expect(container.textContent).toContain("Event saved on this device");
  });

  it("references a newly created project event in an explicitly filtered widget", async () => {
    const metadata = calendarMetadata();
    if (metadata.kind !== "calendar") throw new Error("Expected calendar metadata.");
    metadata.calendar.projectEventIds = ["project-event-existing"];
    const { callbacks, container } = mount(metadata, {
      onCreateCalendarEvent: vi.fn(async () => ({ status: "created", projectEventId: "project-event-1" } as const)),
    });
    act(() => button(container, "Calendar").click());
    act(() => setControlValue(controlInLabel(container, "Title"), "Unit test"));
    await act(async () => {
      button(container, "Add event").click();
      await Promise.resolve();
    });
    act(() => button(container, "Add Class Calendar").click());

    const submitted = callbacks.onSubmit.mock.calls[0][0] as ClassroomTimeWidgetMetadataV1;
    expect(submitted.kind).toBe("calendar");
    if (submitted.kind !== "calendar") throw new Error("Expected calendar metadata.");
    expect(submitted.calendar.projectEventIds).toEqual(["project-event-existing", "project-event-1"]);
  });

  it("preserves the empty all-project-events sentinel after project event creation", async () => {
    const { callbacks, container } = mount(calendarMetadata(), {
      onCreateCalendarEvent: vi.fn(async () => ({ status: "created", projectEventId: "project-event-1" } as const)),
    });
    act(() => button(container, "Calendar").click());
    act(() => setControlValue(controlInLabel(container, "Title"), "Whole-class event"));
    await act(async () => {
      button(container, "Add event").click();
      await Promise.resolve();
    });
    act(() => button(container, "Add Class Calendar").click());

    const submitted = callbacks.onSubmit.mock.calls[0][0] as ClassroomTimeWidgetMetadataV1;
    if (submitted.kind !== "calendar") throw new Error("Expected calendar metadata.");
    expect(submitted.calendar.projectEventIds).toEqual([]);
  });

  it("shows pending state and suppresses duplicate event submissions", async () => {
    const operation = deferred<ClassroomCalendarEventCreateResult>();
    const onCreateCalendarEvent = vi.fn(() => operation.promise);
    const { container } = mount(calendarMetadata(), { onCreateCalendarEvent });
    act(() => button(container, "Calendar").click());
    act(() => setControlValue(controlInLabel(container, "Title"), "Pending event"));

    act(() => {
      const submit = button(container, "Add event");
      submit.click();
      submit.click();
    });
    expect(onCreateCalendarEvent).toHaveBeenCalledOnce();
    expect(button(container, "Saving event…").disabled).toBe(true);
    expect(container.querySelector(".classroom-time-event-form")?.getAttribute("aria-busy")).toBe("true");
    expect(controlInLabel<HTMLInputElement>(container, "Title").value).toBe("Pending event");

    await act(async () => {
      operation.resolve({ status: "created" });
      await operation.promise;
    });
    expect(button(container, "Add event").disabled).toBe(true);
    expect(controlInLabel<HTMLInputElement>(container, "Title").value).toBe("");
  });

  it("retains the complete event draft when persistence rejects", async () => {
    const operation = deferred<ClassroomCalendarEventCreateResult>();
    const { container } = mount(calendarMetadata(), {
      onCreateCalendarEvent: vi.fn(() => operation.promise),
    });
    act(() => button(container, "Calendar").click());
    act(() => setControlValue(controlInLabel(container, "Title"), "Do not lose me"));
    act(() => setControlValue(controlInLabel(container, "Optional note"), "Important details"));
    act(() => button(container, "Add event").click());
    await act(async () => {
      operation.reject(new Error("storage unavailable"));
      try { await operation.promise; } catch { /* The dialog handles this rejection. */ }
    });

    expect(controlInLabel<HTMLInputElement>(container, "Title").value).toBe("Do not lose me");
    expect(controlInLabel<HTMLTextAreaElement>(container, "Optional note").value).toBe("Important details");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your draft is still here");
    expect(button(container, "Add event").disabled).toBe(false);
  });

  it("prevents an empty dashboard and exposes explicit default actions", () => {
    const metadata = dashboardMetadata();
    const restored = { ...metadata, label: "Restored dashboard" } as ClassroomTimeWidgetMetadataV1;
    const { callbacks, container } = mount(metadata, { onRestoreDefaults: vi.fn(() => restored) });
    act(() => button(container, "Dashboard").click());
    for (const panel of ["Clock", "Timer", "Pomodoro", "Calendar"]) {
      act(() => controlInLabel<HTMLInputElement>(container, panel).click());
    }
    expect(button(container, "Add Classroom Dashboard").disabled).toBe(true);
    expect(container.textContent).toContain("Keep at least one dashboard panel on");

    act(() => button(container, "Restore defaults").click());
    act(() => button(container, "Use as default").click());
    expect(callbacks.onUseAsDefault).toHaveBeenCalledWith(expect.objectContaining({ label: "Restored dashboard" }));
    expect(container.textContent).toContain("Saved as the default for new widgets");
  });

  it("traps Escape through the shared modal contract and restores trigger focus", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return createElement("div", null,
        createElement("button", { ref: triggerRef, type: "button", onClick: () => setOpen(true) }, "Open clock"),
        open ? createElement(ClassroomTimeDialog, {
          metadata: clockMetadata(),
          alarmMuted: false,
          alarmVolume: 0.7,
          onAlarmPreferencesChange: vi.fn(),
          onCancel: () => setOpen(false),
          onCreateCalendarEvent: vi.fn(async () => ({ status: "created" } as const)),
          onRestoreDefaults: () => clockMetadata(),
          onSubmit: vi.fn(),
          onTestAlarm: vi.fn(),
          onUseAsDefault: vi.fn(),
          returnFocusRef: triggerRef,
        }) : null,
      );
    }

    act(() => root.render(createElement(Harness)));
    const trigger = button(container, "Open clock");
    act(() => trigger.click());
    expect(document.activeElement?.getAttribute("type")).toBe("text");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
