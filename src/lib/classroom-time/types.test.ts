import { describe, expect, it } from "vitest";

import {
  MAX_CLASSROOM_TIME_LABEL_LENGTH,
  MAX_TIMER_DURATION_MS,
  MIN_TIMER_DURATION_MS,
} from "./constants";
import {
  CLASSROOM_TIME_WIDGET_KINDS,
  CLASSROOM_TIME_WIDGET_ROLES,
  createDefaultClassroomTimeWidgetMetadata,
  createIdlePomodoroRuntime,
  createIdleTimerRuntime,
  isClassroomTimeWidgetRole,
  parseClassroomAlarmSettings,
  parseClassroomCalendarSettings,
  parseClassroomClockSettings,
  parseClassroomPomodoroRuntime,
  parseClassroomPomodoroSettings,
  parseClassroomTimeAppearance,
  parseClassroomTimeChildData,
  parseClassroomTimerRuntime,
  parseClassroomTimerSettings,
  parseClassroomTimeWidgetMetadata,
  sanitizeClassroomTimeWidgetMetadata,
  type ClassroomTimeWidgetMetadataV1,
} from "./types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function withUnknownKey<T extends object>(value: T): T & { unexpected: true } {
  return { ...value, unexpected: true };
}

describe("classroom time metadata factories", () => {
  it.each(CLASSROOM_TIME_WIDGET_KINDS)("creates valid, strictly parseable %s metadata", (kind) => {
    const metadata = createDefaultClassroomTimeWidgetMetadata(kind, `widget-${kind}`);

    expect(metadata).toMatchObject({
      version: 1,
      ownerId: `widget-${kind}`,
      kind,
    });
    expect(metadata.label.length).toBeGreaterThan(0);
    expect(parseClassroomTimeWidgetMetadata(metadata)).toEqual(metadata);
    expect(sanitizeClassroomTimeWidgetMetadata(metadata)).toEqual(metadata);
  });

  it("creates independent nested defaults", () => {
    const first = createDefaultClassroomTimeWidgetMetadata("dashboard", "dashboard-one");
    const second = createDefaultClassroomTimeWidgetMetadata("dashboard", "dashboard-two");
    expect(first.kind).toBe("dashboard");
    expect(second.kind).toBe("dashboard");
    if (first.kind !== "dashboard" || second.kind !== "dashboard") return;

    first.appearance.accentColor = "#112233";
    first.clock.showSeconds = false;
    first.calendar.projectEventIds.push("event-one");
    first.panels.timer = false;

    expect(second.appearance.accentColor).toBe("#2563eb");
    expect(second.clock.showSeconds).toBe(true);
    expect(second.calendar.projectEventIds).toEqual([]);
    expect(second.panels.timer).toBe(true);
  });

  it("rejects invalid owner identifiers", () => {
    expect(() => createDefaultClassroomTimeWidgetMetadata("clock", "")).toThrow(TypeError);
    expect(() => createDefaultClassroomTimeWidgetMetadata("clock", "../clock")).toThrow(TypeError);
    expect(() => createDefaultClassroomTimeWidgetMetadata("clock", `x${"a".repeat(128)}`)).toThrow(TypeError);
  });
});

describe("strict classroom time metadata validation", () => {
  it.each(CLASSROOM_TIME_WIDGET_KINDS)("rejects unknown top-level keys for %s metadata", (kind) => {
    const metadata = createDefaultClassroomTimeWidgetMetadata(kind, `strict-${kind}`);
    expect(parseClassroomTimeWidgetMetadata(withUnknownKey(metadata))).toBeNull();
    expect(() => sanitizeClassroomTimeWidgetMetadata(withUnknownKey(metadata))).toThrow(TypeError);
  });

  it("accepts exact nested records and rejects unknown nested keys", () => {
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "strict-dashboard");
    expect(dashboard.kind).toBe("dashboard");
    if (dashboard.kind !== "dashboard") return;

    const exactCases: Array<{
      parse: (value: unknown) => unknown;
      value: object;
    }> = [
      { parse: parseClassroomTimeAppearance, value: dashboard.appearance },
      { parse: parseClassroomAlarmSettings, value: dashboard.alarm },
      { parse: parseClassroomClockSettings, value: dashboard.clock },
      { parse: parseClassroomTimerSettings, value: dashboard.timer },
      {
        parse: (value) => parseClassroomTimerRuntime(value, dashboard.timer.durationMs),
        value: dashboard.timerRuntime,
      },
      { parse: parseClassroomPomodoroSettings, value: dashboard.pomodoro },
      {
        parse: (value) => parseClassroomPomodoroRuntime(value, dashboard.pomodoro),
        value: dashboard.pomodoroRuntime,
      },
      { parse: parseClassroomCalendarSettings, value: dashboard.calendar },
    ];

    for (const { parse, value } of exactCases) {
      expect(parse(value)).not.toBeNull();
      expect(parse(withUnknownKey(value))).toBeNull();
    }

    expect(parseClassroomTimeWidgetMetadata({
      ...dashboard,
      panels: withUnknownKey(dashboard.panels),
    })).toBeNull();
  });

  it.each(["foregroundColor", "backgroundColor", "accentColor", "borderColor"] as const)(
    "rejects unsafe %s values",
    (field) => {
      const metadata = createDefaultClassroomTimeWidgetMetadata("clock", `unsafe-${field}`);
      const unsafe = {
        ...metadata,
        appearance: { ...metadata.appearance, [field]: "url(https://example.invalid/paint)" },
      };
      expect(parseClassroomTimeWidgetMetadata(unsafe)).toBeNull();
      expect(parseClassroomTimeAppearance(unsafe.appearance)).toBeNull();
    },
  );

  it("accepts six-digit hex colors only", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("clock", "safe-color");
    expect(parseClassroomTimeAppearance({
      ...metadata.appearance,
      accentColor: "#Aa00fF",
    })).not.toBeNull();

    for (const color of ["#fff", "#11223344", "112233", "#gg0000", "currentColor", ""] as const) {
      expect(parseClassroomTimeAppearance({ ...metadata.appearance, accentColor: color })).toBeNull();
    }
  });

  it("enforces the label boundary", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("clock", "label-boundary");
    expect(parseClassroomTimeWidgetMetadata({
      ...metadata,
      label: "x".repeat(MAX_CLASSROOM_TIME_LABEL_LENGTH),
    })).not.toBeNull();
    expect(parseClassroomTimeWidgetMetadata({
      ...metadata,
      label: "x".repeat(MAX_CLASSROOM_TIME_LABEL_LENGTH + 1),
    })).toBeNull();
    expect(parseClassroomTimeWidgetMetadata({ ...metadata, label: 42 })).toBeNull();
  });
});

describe("timer and pomodoro validation bounds", () => {
  it("accepts only integral timer durations within the supported range", () => {
    for (const durationMs of [MIN_TIMER_DURATION_MS, MAX_TIMER_DURATION_MS]) {
      expect(parseClassroomTimerSettings({ durationMs, progressStyle: "ring" })).toEqual({
        durationMs,
        progressStyle: "none",
      });
      expect(createIdleTimerRuntime(durationMs)).toEqual({
        status: "idle",
        remainingMs: durationMs,
        deadlineMs: null,
        completedAtMs: null,
      });
    }

    for (const durationMs of [
      MIN_TIMER_DURATION_MS - 1,
      MAX_TIMER_DURATION_MS + 1,
      MIN_TIMER_DURATION_MS + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(parseClassroomTimerSettings({ durationMs, progressStyle: "ring" })).toBeNull();
      expect(() => createIdleTimerRuntime(durationMs)).toThrow(RangeError);
    }
  });

  it("normalizes archived analog clocks and visual progress styles to supported text-only modes", () => {
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "legacy-visual-modes");
    if (dashboard.kind !== "dashboard") throw new Error("Expected dashboard metadata.");

    expect(parseClassroomClockSettings({ ...dashboard.clock, display: "analog" }))
      .toMatchObject({ display: "digital" });
    expect(parseClassroomTimerSettings({ ...dashboard.timer, progressStyle: "bar" }))
      .toMatchObject({ progressStyle: "none" });
    expect(parseClassroomPomodoroSettings({ ...dashboard.pomodoro, progressStyle: "ring" }))
      .toMatchObject({ progressStyle: "none" });
  });

  it("applies duration and cycle bounds to pomodoro settings", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("pomodoro", "pomodoro-bounds");
    expect(metadata.kind).toBe("pomodoro");
    if (metadata.kind !== "pomodoro") return;

    expect(parseClassroomPomodoroSettings({
      ...metadata.pomodoro,
      focusDurationMs: MIN_TIMER_DURATION_MS,
      shortBreakDurationMs: MAX_TIMER_DURATION_MS,
      longBreakDurationMs: MIN_TIMER_DURATION_MS,
      cyclesBeforeLongBreak: 1,
    })).not.toBeNull();
    expect(parseClassroomPomodoroSettings({
      ...metadata.pomodoro,
      cyclesBeforeLongBreak: 12,
    })).not.toBeNull();

    for (const patch of [
      { focusDurationMs: MIN_TIMER_DURATION_MS - 1 },
      { shortBreakDurationMs: MAX_TIMER_DURATION_MS + 1 },
      { longBreakDurationMs: 1.5 },
      { cyclesBeforeLongBreak: 0 },
      { cyclesBeforeLongBreak: 13 },
      { cyclesBeforeLongBreak: 1.5 },
    ]) {
      expect(parseClassroomPomodoroSettings({ ...metadata.pomodoro, ...patch })).toBeNull();
      expect(() => createIdlePomodoroRuntime({ ...metadata.pomodoro, ...patch })).toThrow(RangeError);
    }
  });

  it("enforces timer runtime status invariants", () => {
    const durationMs = 5_000;
    const idle = createIdleTimerRuntime(durationMs);
    expect(parseClassroomTimerRuntime(idle, durationMs)).toEqual(idle);
    expect(parseClassroomTimerRuntime({ ...idle, remainingMs: durationMs + 1 }, durationMs)).toBeNull();
    expect(parseClassroomTimerRuntime({ ...idle, deadlineMs: 10_000 }, durationMs)).toBeNull();
    expect(parseClassroomTimerRuntime({ ...idle, completedAtMs: 10_000 }, durationMs)).toBeNull();
    expect(parseClassroomTimerRuntime({ ...idle, status: "running", deadlineMs: null }, durationMs)).toBeNull();
    expect(parseClassroomTimerRuntime({
      ...idle,
      status: "completed",
      remainingMs: 0,
      completedAtMs: null,
    }, durationMs)).toBeNull();
    expect(parseClassroomTimerRuntime({
      ...idle,
      status: "completed",
      remainingMs: 1,
      completedAtMs: 10_000,
    }, durationMs)).toBeNull();
  });

  it("enforces pomodoro runtime status and phase-duration invariants", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("pomodoro", "pomodoro-runtime");
    expect(metadata.kind).toBe("pomodoro");
    if (metadata.kind !== "pomodoro") return;

    const idle = metadata.runtime;
    expect(parseClassroomPomodoroRuntime(idle, metadata.pomodoro)).toEqual(idle);
    expect(parseClassroomPomodoroRuntime({
      ...idle,
      phase: "short-break",
      remainingMs: metadata.pomodoro.shortBreakDurationMs + 1,
    }, metadata.pomodoro)).toBeNull();
    expect(parseClassroomPomodoroRuntime({ ...idle, deadlineMs: 10_000 }, metadata.pomodoro)).toBeNull();
    expect(parseClassroomPomodoroRuntime({
      ...idle,
      status: "completed",
      remainingMs: 1,
      completedAtMs: 10_000,
    }, metadata.pomodoro)).toBeNull();
  });
});

describe("classroom time child roles", () => {
  it("accepts every fixed role", () => {
    for (const role of CLASSROOM_TIME_WIDGET_ROLES) {
      expect(isClassroomTimeWidgetRole(role)).toBe(true);
      expect(parseClassroomTimeChildData({ version: 1, ownerId: "widget-one", role })).toEqual({
        version: 1,
        ownerId: "widget-one",
        role,
      });
    }
  });

  it.each([
    ["calendar-day-0", true],
    ["calendar-day-41", true],
    ["calendar-day-42", false],
    ["calendar-weekday-0", true],
    ["calendar-weekday-6", true],
    ["calendar-weekday-7", false],
    ["calendar-event-0", true],
    ["calendar-event-5", true],
    ["calendar-event-6", false],
    ["dashboard-calendar-day-0", true],
    ["dashboard-calendar-day-13", true],
    ["dashboard-calendar-day-14", false],
    ["calendar-day--1", false],
    ["calendar-day-1.5", false],
    ["calendar-day-9007199254740992", false],
    ["calendar-unknown-0", false],
  ])("validates indexed role %s", (role, expected) => {
    expect(isClassroomTimeWidgetRole(role)).toBe(expected);
  });

  it("requires exact child metadata and safe identifiers", () => {
    const child = { version: 1, ownerId: "widget:one", role: "calendar-day-0" };
    expect(parseClassroomTimeChildData(child)).toEqual(child);
    expect(parseClassroomTimeChildData(withUnknownKey(child))).toBeNull();
    expect(parseClassroomTimeChildData({ ...child, ownerId: "../widget" })).toBeNull();
    expect(parseClassroomTimeChildData({ ...child, version: 2 })).toBeNull();
    expect(parseClassroomTimeChildData({ ...child, role: "calendar-day-42" })).toBeNull();
  });
});

describe("metadata values are sanitized copies", () => {
  it("does not retain an untrusted top-level object", () => {
    const source = createDefaultClassroomTimeWidgetMetadata("clock", "copy-check");
    const parsed = parseClassroomTimeWidgetMetadata(source) as ClassroomTimeWidgetMetadataV1;
    expect(parsed).not.toBe(source);
    expect(parsed.appearance).not.toBe(source.appearance);

    const sourceCopy = clone(source);
    source.appearance.backgroundColor = "#000000";
    expect(parsed).toEqual(sourceCopy);
  });

  it("clones every nested dashboard configuration and runtime", () => {
    const source = createDefaultClassroomTimeWidgetMetadata("dashboard", "deep-copy-check");
    expect(source.kind).toBe("dashboard");
    if (source.kind !== "dashboard") return;
    const parsed = parseClassroomTimeWidgetMetadata(source);
    expect(parsed?.kind).toBe("dashboard");
    if (!parsed || parsed.kind !== "dashboard") return;
    expect(parsed.clock).not.toBe(source.clock);
    expect(parsed.timerRuntime).not.toBe(source.timerRuntime);
    expect(parsed.pomodoro).not.toBe(source.pomodoro);
    expect(parsed.pomodoroRuntime).not.toBe(source.pomodoroRuntime);
    expect(parsed.panels).not.toBe(source.panels);
  });
});
