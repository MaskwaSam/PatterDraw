import type {
  ClassroomPomodoroPhase,
  ClassroomPomodoroRuntimeV1,
  ClassroomPomodoroSettingsV1,
  ClassroomTimeWidgetMetadataV1,
  ClassroomTimerRuntimeV1,
} from "./types";
import {
  parseClassroomPomodoroSettings,
  pomodoroPhaseDurationMs,
} from "./types";
import { MAX_TIMER_DURATION_MS, MIN_TIMER_DURATION_MS } from "./constants";

export interface ClassroomTimerSnapshot {
  status: ClassroomTimerRuntimeV1["status"];
  remainingMs: number;
  progress: number;
  expired: boolean;
}

export interface ClassroomPomodoroSnapshot extends ClassroomTimerSnapshot {
  phase: ClassroomPomodoroPhase;
  completedFocusSessions: number;
}

export interface ClassroomTimeWidgetSnapshot {
  capturedAtMs: number;
  timer: ClassroomTimerSnapshot | null;
  pomodoro: ClassroomPomodoroSnapshot | null;
}

function assertNow(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError("A non-negative integer timestamp is required.");
}

function clampRemaining(remainingMs: number): number {
  return Math.max(0, Math.floor(remainingMs));
}

function assertDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs)
    || durationMs < MIN_TIMER_DURATION_MS
    || durationMs > MAX_TIMER_DURATION_MS) {
    throw new RangeError("Timer duration is outside the supported range.");
  }
}

function assertPomodoroSettings(settings: ClassroomPomodoroSettingsV1): void {
  if (!parseClassroomPomodoroSettings(settings)) throw new RangeError("Pomodoro settings are invalid.");
}

function safeDeadline(nowMs: number, remainingMs: number): number {
  const deadlineMs = nowMs + remainingMs;
  if (!Number.isSafeInteger(deadlineMs)) throw new RangeError("Timer deadline exceeds the supported timestamp range.");
  return deadlineMs;
}

export function snapshotTimerRuntime(
  runtime: ClassroomTimerRuntimeV1,
  durationMs: number,
  nowMs: number,
): ClassroomTimerSnapshot {
  assertNow(nowMs);
  assertDuration(durationMs);
  const remainingMs = runtime.status === "running" && runtime.deadlineMs !== null
    ? clampRemaining(runtime.deadlineMs - nowMs)
    : runtime.remainingMs;
  const status = runtime.status === "running" && remainingMs === 0 ? "completed" : runtime.status;
  return {
    status,
    remainingMs,
    progress: durationMs <= 0 ? 0 : Math.min(1, Math.max(0, 1 - remainingMs / durationMs)),
    expired: runtime.status === "running" && remainingMs === 0,
  };
}

export function startTimerRuntime(
  runtime: ClassroomTimerRuntimeV1,
  durationMs: number,
  nowMs: number,
): ClassroomTimerRuntimeV1 {
  assertNow(nowMs);
  assertDuration(durationMs);
  if (runtime.status === "running") return runtime;
  const remainingMs = runtime.status === "completed" || runtime.remainingMs <= 0
    ? durationMs
    : runtime.remainingMs;
  return { status: "running", remainingMs, deadlineMs: safeDeadline(nowMs, remainingMs), completedAtMs: null };
}

export function pauseTimerRuntime(
  runtime: ClassroomTimerRuntimeV1,
  durationMs: number,
  nowMs: number,
): ClassroomTimerRuntimeV1 {
  assertNow(nowMs);
  assertDuration(durationMs);
  if (runtime.status !== "running") return runtime;
  const snapshot = snapshotTimerRuntime(runtime, durationMs, nowMs);
  return snapshot.remainingMs === 0
    ? { status: "completed", remainingMs: 0, deadlineMs: null, completedAtMs: runtime.deadlineMs ?? nowMs }
    : { status: "paused", remainingMs: snapshot.remainingMs, deadlineMs: null, completedAtMs: null };
}

export function completeTimerRuntime(
  runtime: ClassroomTimerRuntimeV1,
  durationMs: number,
  nowMs: number,
): ClassroomTimerRuntimeV1 {
  const snapshot = snapshotTimerRuntime(runtime, durationMs, nowMs);
  return snapshot.expired
    ? { status: "completed", remainingMs: 0, deadlineMs: null, completedAtMs: runtime.deadlineMs ?? nowMs }
    : runtime;
}

export function resetTimerRuntime(durationMs: number): ClassroomTimerRuntimeV1 {
  assertDuration(durationMs);
  return { status: "idle", remainingMs: durationMs, deadlineMs: null, completedAtMs: null };
}

export function snapshotPomodoroRuntime(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: ClassroomPomodoroSettingsV1,
  nowMs: number,
): ClassroomPomodoroSnapshot {
  assertPomodoroSettings(settings);
  const timer = snapshotTimerRuntime(runtime, pomodoroPhaseDurationMs(settings, runtime.phase), nowMs);
  return { ...timer, phase: runtime.phase, completedFocusSessions: runtime.completedFocusSessions };
}

export function startPomodoroRuntime(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: ClassroomPomodoroSettingsV1,
  nowMs: number,
): ClassroomPomodoroRuntimeV1 {
  assertNow(nowMs);
  assertPomodoroSettings(settings);
  if (runtime.status === "running") return runtime;
  const duration = pomodoroPhaseDurationMs(settings, runtime.phase);
  const remainingMs = runtime.status === "completed" || runtime.remainingMs <= 0 ? duration : runtime.remainingMs;
  return { ...runtime, status: "running", remainingMs, deadlineMs: safeDeadline(nowMs, remainingMs), completedAtMs: null };
}

export function pausePomodoroRuntime(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: ClassroomPomodoroSettingsV1,
  nowMs: number,
): ClassroomPomodoroRuntimeV1 {
  assertNow(nowMs);
  assertPomodoroSettings(settings);
  if (runtime.status !== "running") return runtime;
  if (runtime.deadlineMs !== null && nowMs >= runtime.deadlineMs) {
    const advanced = advancePomodoroRuntime(runtime, settings, nowMs).runtime;
    if (advanced.status !== "running" || advanced.deadlineMs === null) return advanced;
    return {
      ...advanced,
      status: "paused",
      remainingMs: advanced.deadlineMs - nowMs,
      deadlineMs: null,
      completedAtMs: null,
    };
  }
  const snapshot = snapshotPomodoroRuntime(runtime, settings, nowMs);
  return snapshot.remainingMs === 0
    ? { ...runtime, status: "completed", remainingMs: 0, deadlineMs: null, completedAtMs: runtime.deadlineMs ?? nowMs }
    : { ...runtime, status: "paused", remainingMs: snapshot.remainingMs, deadlineMs: null, completedAtMs: null };
}

function nextPomodoroPhase(
  phase: ClassroomPomodoroPhase,
  completedFocusSessions: number,
  cyclesBeforeLongBreak: number,
): ClassroomPomodoroPhase {
  if (phase !== "focus") return "focus";
  return completedFocusSessions > 0 && completedFocusSessions % cyclesBeforeLongBreak === 0
    ? "long-break"
    : "short-break";
}

function shouldAutoStartPhase(phase: ClassroomPomodoroPhase, settings: ClassroomPomodoroSettingsV1): boolean {
  return phase === "focus" ? settings.autoStartFocus : settings.autoStartBreaks;
}

export interface PomodoroAdvanceResult {
  runtime: ClassroomPomodoroRuntimeV1;
  completedPhases: ClassroomPomodoroPhase[];
}

export function advancePomodoroRuntime(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: ClassroomPomodoroSettingsV1,
  nowMs: number,
): PomodoroAdvanceResult {
  assertNow(nowMs);
  assertPomodoroSettings(settings);
  if (runtime.status !== "running" || runtime.deadlineMs === null || nowMs < runtime.deadlineMs) {
    return { runtime, completedPhases: [] };
  }

  let deadlineMs = runtime.deadlineMs;
  let phase = runtime.phase;
  let completedFocusSessions = runtime.completedFocusSessions;
  const completedPhases: ClassroomPomodoroPhase[] = [];

  // A single wake-up may span many automatically started phases. Durations are
  // bounded to at least one second, so this hard ceiling also bounds malformed
  // or extreme device-clock jumps without blocking the UI thread.
  for (let transitions = 0; transitions < 10_000; transitions += 1) {
    completedPhases.push(phase);
    if (phase === "focus") completedFocusSessions += 1;
    const nextPhase = nextPomodoroPhase(phase, completedFocusSessions, settings.cyclesBeforeLongBreak);
    const nextDurationMs = pomodoroPhaseDurationMs(settings, nextPhase);
    if (!shouldAutoStartPhase(nextPhase, settings)) {
      return {
        completedPhases,
        runtime: {
          status: "paused",
          phase: nextPhase,
          completedFocusSessions,
          remainingMs: nextDurationMs,
          deadlineMs: null,
          completedAtMs: null,
        },
      };
    }
    phase = nextPhase;
    deadlineMs = safeDeadline(deadlineMs, nextDurationMs);
    if (nowMs < deadlineMs) {
      return {
        completedPhases,
        runtime: {
          status: "running",
          phase,
          completedFocusSessions,
          remainingMs: deadlineMs - nowMs,
          deadlineMs,
          completedAtMs: null,
        },
      };
    }
  }

  return {
    completedPhases,
    runtime: {
      status: "paused",
      phase,
      completedFocusSessions,
      remainingMs: pomodoroPhaseDurationMs(settings, phase),
      deadlineMs: null,
      completedAtMs: nowMs,
    },
  };
}

export function resetPomodoroRuntime(settings: ClassroomPomodoroSettingsV1): ClassroomPomodoroRuntimeV1 {
  assertPomodoroSettings(settings);
  return {
    status: "idle",
    phase: "focus",
    completedFocusSessions: 0,
    remainingMs: settings.focusDurationMs,
    deadlineMs: null,
    completedAtMs: null,
  };
}

export function materializeClassroomTimeWidgetSnapshot(
  metadata: ClassroomTimeWidgetMetadataV1,
  capturedAtMs: number,
): ClassroomTimeWidgetSnapshot {
  assertNow(capturedAtMs);
  if (metadata.kind === "timer") {
    return { capturedAtMs, timer: snapshotTimerRuntime(metadata.runtime, metadata.timer.durationMs, capturedAtMs), pomodoro: null };
  }
  if (metadata.kind === "pomodoro") {
    return { capturedAtMs, timer: null, pomodoro: snapshotPomodoroRuntime(metadata.runtime, metadata.pomodoro, capturedAtMs) };
  }
  if (metadata.kind === "dashboard") {
    return {
      capturedAtMs,
      timer: metadata.panels.timer
        ? snapshotTimerRuntime(metadata.timerRuntime, metadata.timer.durationMs, capturedAtMs)
        : null,
      pomodoro: metadata.panels.pomodoro
        ? snapshotPomodoroRuntime(metadata.pomodoroRuntime, metadata.pomodoro, capturedAtMs)
        : null,
    };
  }
  return { capturedAtMs, timer: null, pomodoro: null };
}

export const resolveClassroomTimeWidgetSnapshot = materializeClassroomTimeWidgetSnapshot;

/**
 * Produces the fork-safe runtime used by duplicate, paste, and library insert.
 * Running timers are frozen at the exact captured remainder; idle, paused,
 * completed, clock, and calendar widgets remain unchanged.
 */
export function pauseClassroomTimeWidget(
  metadata: ClassroomTimeWidgetMetadataV1,
  nowMs: number,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind === "timer") {
    return {
      ...metadata,
      runtime: pauseTimerRuntime(metadata.runtime, metadata.timer.durationMs, nowMs),
    };
  }
  if (metadata.kind === "pomodoro") {
    return {
      ...metadata,
      runtime: pausePomodoroRuntime(metadata.runtime, metadata.pomodoro, nowMs),
    };
  }
  if (metadata.kind === "dashboard") {
    return {
      ...metadata,
      timerRuntime: pauseTimerRuntime(metadata.timerRuntime, metadata.timer.durationMs, nowMs),
      pomodoroRuntime: pausePomodoroRuntime(metadata.pomodoroRuntime, metadata.pomodoro, nowMs),
    };
  }
  return metadata;
}
