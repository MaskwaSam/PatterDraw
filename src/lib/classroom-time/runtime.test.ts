import { describe, expect, it } from "vitest";

import {
  advancePomodoroRuntime,
  completeTimerRuntime,
  materializeClassroomTimeWidgetSnapshot,
  pauseClassroomTimeWidget,
  pausePomodoroRuntime,
  pauseTimerRuntime,
  resetPomodoroRuntime,
  resetTimerRuntime,
  snapshotPomodoroRuntime,
  snapshotTimerRuntime,
  startPomodoroRuntime,
  startTimerRuntime,
} from "./runtime";
import {
  createDefaultClassroomTimeWidgetMetadata,
  type ClassroomPomodoroSettingsV1,
  type ClassroomTimerRuntimeV1,
} from "./types";

const TIMER_DURATION_MS = 5_000;
const NOW_MS = 100_000;

function runningTimer(deadlineMs: number, remainingMs = TIMER_DURATION_MS): ClassroomTimerRuntimeV1 {
  return {
    status: "running",
    remainingMs,
    deadlineMs,
    completedAtMs: null,
  };
}

function shortPomodoroSettings(
  overrides: Partial<ClassroomPomodoroSettingsV1> = {},
): ClassroomPomodoroSettingsV1 {
  return {
    focusDurationMs: 1_000,
    shortBreakDurationMs: 2_000,
    longBreakDurationMs: 3_000,
    cyclesBeforeLongBreak: 4,
    autoStartFocus: false,
    autoStartBreaks: false,
    progressStyle: "ring",
    ...overrides,
  };
}

describe("timer runtime", () => {
  it("starts at an exact deadline and snapshots progress without mutating runtime", () => {
    const idle = resetTimerRuntime(TIMER_DURATION_MS);
    const running = startTimerRuntime(idle, TIMER_DURATION_MS, NOW_MS);

    expect(running).toEqual({
      status: "running",
      remainingMs: TIMER_DURATION_MS,
      deadlineMs: NOW_MS + TIMER_DURATION_MS,
      completedAtMs: null,
    });
    expect(idle).toEqual(resetTimerRuntime(TIMER_DURATION_MS));
    expect(snapshotTimerRuntime(running, TIMER_DURATION_MS, NOW_MS)).toEqual({
      status: "running",
      remainingMs: TIMER_DURATION_MS,
      progress: 0,
      expired: false,
    });
    expect(snapshotTimerRuntime(running, TIMER_DURATION_MS, NOW_MS + 2_500)).toEqual({
      status: "running",
      remainingMs: 2_500,
      progress: 0.5,
      expired: false,
    });
  });

  it("snapshots and completes exactly at the persisted deadline", () => {
    const runtime = runningTimer(NOW_MS + TIMER_DURATION_MS);
    expect(snapshotTimerRuntime(runtime, TIMER_DURATION_MS, NOW_MS + TIMER_DURATION_MS)).toEqual({
      status: "completed",
      remainingMs: 0,
      progress: 1,
      expired: true,
    });
    expect(snapshotTimerRuntime(runtime, TIMER_DURATION_MS, NOW_MS + TIMER_DURATION_MS + 60_000)).toEqual({
      status: "completed",
      remainingMs: 0,
      progress: 1,
      expired: true,
    });
    expect(completeTimerRuntime(runtime, TIMER_DURATION_MS, NOW_MS + TIMER_DURATION_MS + 60_000)).toEqual({
      status: "completed",
      remainingMs: 0,
      deadlineMs: null,
      completedAtMs: NOW_MS + TIMER_DURATION_MS,
    });
  });

  it("pauses at the exact remainder, resumes from it, and resets", () => {
    const original = runningTimer(NOW_MS + TIMER_DURATION_MS);
    const paused = pauseTimerRuntime(original, TIMER_DURATION_MS, NOW_MS + 1_750);
    expect(paused).toEqual({
      status: "paused",
      remainingMs: 3_250,
      deadlineMs: null,
      completedAtMs: null,
    });
    expect(original.status).toBe("running");

    expect(startTimerRuntime(paused, TIMER_DURATION_MS, NOW_MS + 10_000)).toEqual({
      status: "running",
      remainingMs: 3_250,
      deadlineMs: NOW_MS + 13_250,
      completedAtMs: null,
    });
    expect(resetTimerRuntime(TIMER_DURATION_MS)).toEqual({
      status: "idle",
      remainingMs: TIMER_DURATION_MS,
      deadlineMs: null,
      completedAtMs: null,
    });
  });

  it("records the deadline when a late pause observes completion", () => {
    const runtime = runningTimer(NOW_MS + TIMER_DURATION_MS);
    expect(pauseTimerRuntime(runtime, TIMER_DURATION_MS, NOW_MS + 20_000)).toEqual({
      status: "completed",
      remainingMs: 0,
      deadlineMs: null,
      completedAtMs: NOW_MS + TIMER_DURATION_MS,
    });
  });

  it("restarts a completed timer at its full duration and preserves running identity", () => {
    const completed: ClassroomTimerRuntimeV1 = {
      status: "completed",
      remainingMs: 0,
      deadlineMs: null,
      completedAtMs: NOW_MS,
    };
    expect(startTimerRuntime(completed, TIMER_DURATION_MS, NOW_MS + 1_000)).toEqual({
      status: "running",
      remainingMs: TIMER_DURATION_MS,
      deadlineMs: NOW_MS + 1_000 + TIMER_DURATION_MS,
      completedAtMs: null,
    });

    const running = runningTimer(NOW_MS + TIMER_DURATION_MS);
    expect(startTimerRuntime(running, TIMER_DURATION_MS, NOW_MS + 1_000)).toBe(running);
    expect(completeTimerRuntime(running, TIMER_DURATION_MS, NOW_MS + 1_000)).toBe(running);
  });

  it("rejects invalid capture timestamps and never reports negative remaining time", () => {
    const runtime = runningTimer(NOW_MS + TIMER_DURATION_MS);
    for (const invalidNow of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => snapshotTimerRuntime(runtime, TIMER_DURATION_MS, invalidNow)).toThrow(RangeError);
      expect(() => startTimerRuntime(resetTimerRuntime(TIMER_DURATION_MS), TIMER_DURATION_MS, invalidNow)).toThrow(RangeError);
      expect(() => completeTimerRuntime(runtime, TIMER_DURATION_MS, invalidNow)).toThrow(RangeError);
    }
    expect(snapshotTimerRuntime(runtime, TIMER_DURATION_MS, NOW_MS + 1_000_000).remainingMs).toBe(0);
  });

  it("rejects invalid durations and deadline overflow", () => {
    const idle = resetTimerRuntime(TIMER_DURATION_MS);
    expect(() => startTimerRuntime(idle, 0, NOW_MS)).toThrow(RangeError);
    expect(() => resetTimerRuntime(Number.NaN)).toThrow(RangeError);
    expect(() => startTimerRuntime(idle, TIMER_DURATION_MS, Number.MAX_SAFE_INTEGER - 1)).toThrow(/deadline/i);
  });
});

describe("pomodoro runtime", () => {
  it("manually advances focus and break phases", () => {
    const settings = shortPomodoroSettings();
    const idle = resetPomodoroRuntime(settings);
    const focus = startPomodoroRuntime(idle, settings, NOW_MS);
    expect(focus.deadlineMs).toBe(NOW_MS + settings.focusDurationMs);

    const afterFocus = advancePomodoroRuntime(focus, settings, NOW_MS + settings.focusDurationMs);
    expect(afterFocus.completedPhases).toEqual(["focus"]);
    expect(afterFocus.runtime).toEqual({
      status: "paused",
      phase: "short-break",
      completedFocusSessions: 1,
      remainingMs: settings.shortBreakDurationMs,
      deadlineMs: null,
      completedAtMs: null,
    });

    const breakRuntime = startPomodoroRuntime(afterFocus.runtime, settings, NOW_MS + 10_000);
    const afterBreak = advancePomodoroRuntime(
      breakRuntime,
      settings,
      NOW_MS + 10_000 + settings.shortBreakDurationMs,
    );
    expect(afterBreak.completedPhases).toEqual(["short-break"]);
    expect(afterBreak.runtime).toEqual({
      status: "paused",
      phase: "focus",
      completedFocusSessions: 1,
      remainingMs: settings.focusDurationMs,
      deadlineMs: null,
      completedAtMs: null,
    });
  });

  it("selects a long break after every fourth completed focus session", () => {
    const settings = shortPomodoroSettings();
    const fourthFocus = {
      status: "running" as const,
      phase: "focus" as const,
      completedFocusSessions: 3,
      remainingMs: settings.focusDurationMs,
      deadlineMs: NOW_MS + settings.focusDurationMs,
      completedAtMs: null,
    };
    const result = advancePomodoroRuntime(
      fourthFocus,
      settings,
      NOW_MS + settings.focusDurationMs,
    );
    expect(result.completedPhases).toEqual(["focus"]);
    expect(result.runtime).toEqual({
      status: "paused",
      phase: "long-break",
      completedFocusSessions: 4,
      remainingMs: settings.longBreakDurationMs,
      deadlineMs: null,
      completedAtMs: null,
    });
  });

  it("honors independent automatic break and focus transitions", () => {
    const autoBreak = shortPomodoroSettings({ autoStartBreaks: true });
    const focus = startPomodoroRuntime(resetPomodoroRuntime(autoBreak), autoBreak, NOW_MS);
    const breakResult = advancePomodoroRuntime(focus, autoBreak, NOW_MS + autoBreak.focusDurationMs);
    expect(breakResult.runtime).toMatchObject({
      status: "running",
      phase: "short-break",
      deadlineMs: NOW_MS + autoBreak.focusDurationMs + autoBreak.shortBreakDurationMs,
    });
    const focusResult = advancePomodoroRuntime(
      breakResult.runtime,
      autoBreak,
      NOW_MS + autoBreak.focusDurationMs + autoBreak.shortBreakDurationMs,
    );
    expect(focusResult.runtime).toEqual({
      status: "paused",
      phase: "focus",
      completedFocusSessions: 1,
      remainingMs: autoBreak.focusDurationMs,
      deadlineMs: null,
      completedAtMs: null,
    });
  });

  it("catches up across missed automatic phases and enters the fourth long break", () => {
    const settings = shortPomodoroSettings({
      autoStartFocus: true,
      autoStartBreaks: true,
    });
    const running = startPomodoroRuntime(resetPomodoroRuntime(settings), settings, NOW_MS);
    const capturedAtMs = NOW_MS + 12_000;
    const result = advancePomodoroRuntime(running, settings, capturedAtMs);

    expect(result.completedPhases).toEqual([
      "focus",
      "short-break",
      "focus",
      "short-break",
      "focus",
      "short-break",
      "focus",
    ]);
    expect(result.runtime).toEqual({
      status: "running",
      phase: "long-break",
      completedFocusSessions: 4,
      remainingMs: 1_000,
      deadlineMs: NOW_MS + 13_000,
      completedAtMs: null,
    });
  });

  it("pauses and snapshots a running phase at an exact remainder", () => {
    const settings = shortPomodoroSettings();
    const running = startPomodoroRuntime(resetPomodoroRuntime(settings), settings, NOW_MS);
    expect(snapshotPomodoroRuntime(running, settings, NOW_MS + 400)).toEqual({
      status: "running",
      remainingMs: 600,
      progress: 0.4,
      expired: false,
      phase: "focus",
      completedFocusSessions: 0,
    });
    expect(pausePomodoroRuntime(running, settings, NOW_MS + 400)).toEqual({
      status: "paused",
      phase: "focus",
      completedFocusSessions: 0,
      remainingMs: 600,
      deadlineMs: null,
      completedAtMs: null,
    });
  });

  it("advances a completed focus before a late pause", () => {
    const settings = shortPomodoroSettings({ autoStartBreaks: true });
    const running = startPomodoroRuntime(resetPomodoroRuntime(settings), settings, NOW_MS);
    expect(pausePomodoroRuntime(running, settings, NOW_MS + 1_400)).toEqual({
      status: "paused",
      phase: "short-break",
      completedFocusSessions: 1,
      remainingMs: 1_600,
      deadlineMs: null,
      completedAtMs: null,
    });
  });
});

describe("widget duplication and deterministic materialization", () => {
  it("pauses both running dashboard timers at the same captured instant", () => {
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "dashboard-running");
    expect(dashboard.kind).toBe("dashboard");
    if (dashboard.kind !== "dashboard") return;

    dashboard.timerRuntime = {
      status: "running",
      remainingMs: dashboard.timer.durationMs,
      deadlineMs: NOW_MS + 30_000,
      completedAtMs: null,
    };
    dashboard.pomodoroRuntime = {
      status: "running",
      phase: "focus",
      completedFocusSessions: 2,
      remainingMs: dashboard.pomodoro.focusDurationMs,
      deadlineMs: NOW_MS + 45_000,
      completedAtMs: null,
    };

    const duplicate = pauseClassroomTimeWidget(dashboard, NOW_MS + 5_000);
    expect(duplicate.kind).toBe("dashboard");
    if (duplicate.kind !== "dashboard") return;
    expect(duplicate.timerRuntime).toMatchObject({
      status: "paused",
      remainingMs: 25_000,
      deadlineMs: null,
    });
    expect(duplicate.pomodoroRuntime).toMatchObject({
      status: "paused",
      phase: "focus",
      completedFocusSessions: 2,
      remainingMs: 40_000,
      deadlineMs: null,
    });
    expect(dashboard.timerRuntime.status).toBe("running");
    expect(dashboard.pomodoroRuntime.status).toBe("running");
  });

  it("materializes identical snapshots at one capture timestamp without mutation", () => {
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "dashboard-export");
    expect(dashboard.kind).toBe("dashboard");
    if (dashboard.kind !== "dashboard") return;
    dashboard.timerRuntime = {
      status: "running",
      remainingMs: dashboard.timer.durationMs,
      deadlineMs: NOW_MS + 20_000,
      completedAtMs: null,
    };
    dashboard.pomodoroRuntime = {
      status: "running",
      phase: "focus",
      completedFocusSessions: 1,
      remainingMs: dashboard.pomodoro.focusDurationMs,
      deadlineMs: NOW_MS + 40_000,
      completedAtMs: null,
    };
    const before = structuredClone(dashboard);
    const capturedAtMs = NOW_MS + 5_000;

    const first = materializeClassroomTimeWidgetSnapshot(dashboard, capturedAtMs);
    const second = materializeClassroomTimeWidgetSnapshot(dashboard, capturedAtMs);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      capturedAtMs,
      timer: { status: "running", remainingMs: 15_000 },
      pomodoro: {
        status: "running",
        phase: "focus",
        completedFocusSessions: 1,
        remainingMs: 35_000,
      },
    });
    expect(dashboard).toEqual(before);
  });

  it("omits disabled dashboard panels and non-timed widget snapshots", () => {
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "dashboard-hidden");
    expect(dashboard.kind).toBe("dashboard");
    if (dashboard.kind !== "dashboard") return;
    dashboard.panels.timer = false;
    dashboard.panels.pomodoro = false;

    expect(materializeClassroomTimeWidgetSnapshot(dashboard, NOW_MS)).toEqual({
      capturedAtMs: NOW_MS,
      timer: null,
      pomodoro: null,
    });
    expect(materializeClassroomTimeWidgetSnapshot(
      createDefaultClassroomTimeWidgetMetadata("clock", "clock-export"),
      NOW_MS,
    )).toEqual({ capturedAtMs: NOW_MS, timer: null, pomodoro: null });
  });
});
