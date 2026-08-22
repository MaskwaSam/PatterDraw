import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  ClassroomProjectCalendarStoreV1,
  ClassroomDeviceCalendarStoreV1,
  ClassroomCalendarEventV1,
} from "./calendar";
import { MAX_TIMER_DURATION_MS } from "./constants";
import type { ClassroomTimePreferencesPatch, ClassroomTimePreferencesV1 } from "./preferences";
import {
  advancePomodoroRuntime,
  completeTimerRuntime,
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
  classroomTimeWidgetMetadata,
  classroomTimeWidgetOwnerId,
  type ClassroomTimeBoardTheme,
  type ClassroomTimeCalendarEventDisplay,
  type ClassroomTimeRenderContext,
} from "./scene";
import {
  createDefaultClassroomTimeWidgetMetadata,
  type ClassroomAlarmTone,
  type ClassroomTimeWidgetKind,
  type ClassroomTimeWidgetMetadataV1,
  type ClassroomTimerRuntimeV1,
  type ClassroomPomodoroRuntimeV1,
} from "./types";

export type ClassroomTimeControlTarget = "timer" | "pomodoro";
export type ClassroomTimeControlCommand = "add-minute" | "pause" | "reset" | "skip" | "start";

export interface SelectedClassroomTimeWidget {
  anchorId: string;
  elementIds: readonly string[];
  metadata: ClassroomTimeWidgetMetadataV1;
  ownerId: string;
}

export interface ClassroomTimeAlarmDescriptor {
  id: string;
  sourceProjectId: string;
  ownerId: string;
  widgetKind: "timer" | "pomodoro" | "dashboard";
  target: ClassroomTimeControlTarget;
  label: string;
  deadlineMs: number;
  createdAtMs: number;
  tone: ClassroomAlarmTone;
  repeat: boolean;
}

export interface AdvancedClassroomTimeWidget {
  metadata: ClassroomTimeWidgetMetadataV1;
  completedTargets: readonly ClassroomTimeControlTarget[];
}

function cloneCalendarSettings<T extends { projectEventIds: string[]; transferCache: unknown }>(settings: T): T {
  return {
    ...settings,
    projectEventIds: [...settings.projectEventIds],
    transferCache: settings.transferCache === null
      ? null
      : JSON.parse(JSON.stringify(settings.transferCache)) as T["transferCache"],
  };
}

function calendarPreferencePatch(
  settings: ClassroomTimePreferencesV1["calendar"],
): NonNullable<ClassroomTimePreferencesPatch["calendar"]> {
  return {
    view: settings.view,
    showProjectEvents: settings.showProjectEvents,
    showDeviceEvents: settings.showDeviceEvents,
    showWeekends: settings.showWeekends,
    showWeekNumbers: settings.showWeekNumbers,
    highlightToday: settings.highlightToday,
    density: settings.density,
  };
}

export function createClassroomTimeMetadataFromPreferences(
  kind: ClassroomTimeWidgetKind,
  ownerId: string,
  preferences: ClassroomTimePreferencesV1,
): ClassroomTimeWidgetMetadataV1 {
  const base = createDefaultClassroomTimeWidgetMetadata(kind, ownerId);
  const appearance = { ...preferences.appearance };
  if (base.kind === "clock") return { ...base, appearance, clock: { ...preferences.clock } };
  if (base.kind === "timer") {
    return {
      ...base,
      appearance,
      timer: { ...preferences.timer },
      runtime: resetTimerRuntime(preferences.timer.durationMs),
      alarm: { ...preferences.alarm },
    };
  }
  if (base.kind === "pomodoro") {
    return {
      ...base,
      appearance,
      pomodoro: { ...preferences.pomodoro },
      runtime: resetPomodoroRuntime(preferences.pomodoro),
      alarm: { ...preferences.alarm },
    };
  }
  if (base.kind === "calendar") {
    return { ...base, appearance, calendar: cloneCalendarSettings(preferences.calendar) };
  }
  return {
    ...base,
    appearance,
    panels: { ...preferences.dashboardPanels },
    clock: { ...preferences.clock },
    timer: { ...preferences.timer },
    timerRuntime: resetTimerRuntime(preferences.timer.durationMs),
    pomodoro: { ...preferences.pomodoro },
    pomodoroRuntime: resetPomodoroRuntime(preferences.pomodoro),
    calendar: cloneCalendarSettings(preferences.calendar),
    alarm: { ...preferences.alarm },
  };
}

export function classroomTimePreferencePatchForMetadata(
  metadata: ClassroomTimeWidgetMetadataV1,
): ClassroomTimePreferencesPatch {
  const patch: ClassroomTimePreferencesPatch = { appearance: { ...metadata.appearance } };
  if (metadata.kind === "clock") return { ...patch, clock: { ...metadata.clock } };
  if (metadata.kind === "timer") return { ...patch, timer: { ...metadata.timer }, alarm: { ...metadata.alarm } };
  if (metadata.kind === "pomodoro") return { ...patch, pomodoro: { ...metadata.pomodoro }, alarm: { ...metadata.alarm } };
  if (metadata.kind === "calendar") return { ...patch, calendar: calendarPreferencePatch(metadata.calendar) };
  return {
    ...patch,
    dashboardPanels: { ...metadata.panels },
    clock: { ...metadata.clock },
    timer: { ...metadata.timer },
    pomodoro: { ...metadata.pomodoro },
    calendar: calendarPreferencePatch(metadata.calendar),
    alarm: { ...metadata.alarm },
  };
}

export function selectedClassroomTimeWidget(
  elements: readonly ExcalidrawElement[],
  selectedElementIds: Readonly<Record<string, boolean>>,
): SelectedClassroomTimeWidget | null {
  const selectedOwners = new Set<string>();
  for (const element of elements) {
    if (!element.isDeleted && selectedElementIds[element.id]) {
      const ownerId = classroomTimeWidgetOwnerId(element);
      if (ownerId) selectedOwners.add(ownerId);
    }
  }
  if (selectedOwners.size !== 1) return null;
  const ownerId = [...selectedOwners][0];
  const members = elements.filter((element) => !element.isDeleted && classroomTimeWidgetOwnerId(element) === ownerId);
  const anchor = members.find((element) => classroomTimeWidgetMetadata(element) !== null);
  const metadata = anchor ? classroomTimeWidgetMetadata(anchor) : null;
  if (!anchor || !metadata) return null;
  return { anchorId: anchor.id, elementIds: members.map((element) => element.id), metadata, ownerId };
}

function addMinuteToTimer(
  runtime: ClassroomTimerRuntimeV1,
  durationMs: number,
  addedMs: number,
  nowMs: number,
): ClassroomTimerRuntimeV1 {
  const snapshot = snapshotTimerRuntime(runtime, durationMs, nowMs);
  const remainingMs = Math.min(MAX_TIMER_DURATION_MS, snapshot.remainingMs + addedMs);
  if (runtime.status === "running" && snapshot.remainingMs > 0) {
    const deadlineMs = nowMs + remainingMs;
    if (!Number.isSafeInteger(deadlineMs)) throw new RangeError("Timer deadline exceeds the supported timestamp range.");
    return { status: "running", remainingMs, deadlineMs, completedAtMs: null };
  }
  return { status: snapshot.status === "completed" ? "paused" : runtime.status, remainingMs, deadlineMs: null, completedAtMs: null };
}

function addMinuteToPomodoro(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: Parameters<typeof snapshotPomodoroRuntime>[1],
  addedMs: number,
  nowMs: number,
): ClassroomPomodoroRuntimeV1 {
  const snapshot = snapshotPomodoroRuntime(runtime, settings, nowMs);
  const remainingMs = Math.min(MAX_TIMER_DURATION_MS, snapshot.remainingMs + addedMs);
  if (runtime.status === "running" && snapshot.remainingMs > 0) {
    const deadlineMs = nowMs + remainingMs;
    if (!Number.isSafeInteger(deadlineMs)) throw new RangeError("Timer deadline exceeds the supported timestamp range.");
    return { ...runtime, status: "running", remainingMs, deadlineMs, completedAtMs: null };
  }
  return { ...runtime, status: snapshot.status === "completed" ? "paused" : runtime.status, remainingMs, deadlineMs: null, completedAtMs: null };
}

function skipPomodoro(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: Parameters<typeof advancePomodoroRuntime>[1],
  nowMs: number,
): ClassroomPomodoroRuntimeV1 {
  return advancePomodoroRuntime({
    ...runtime,
    status: "running",
    remainingMs: 0,
    deadlineMs: nowMs,
    completedAtMs: null,
  }, settings, nowMs).runtime;
}

function updateTimerRuntime(
  runtime: ClassroomTimerRuntimeV1,
  durationMs: number,
  command: ClassroomTimeControlCommand,
  nowMs: number,
): ClassroomTimerRuntimeV1 {
  if (command === "pause") return pauseTimerRuntime(runtime, durationMs, nowMs);
  if (command === "reset") return resetTimerRuntime(durationMs);
  if (command === "add-minute") return addMinuteToTimer(runtime, durationMs, Math.min(60_000, MAX_TIMER_DURATION_MS - durationMs), nowMs);
  if (command === "skip") return runtime;
  const completed = completeTimerRuntime(runtime, durationMs, nowMs);
  return startTimerRuntime(completed, durationMs, nowMs);
}

function updatePomodoroRuntime(
  runtime: ClassroomPomodoroRuntimeV1,
  settings: Parameters<typeof startPomodoroRuntime>[1],
  command: ClassroomTimeControlCommand,
  nowMs: number,
): ClassroomPomodoroRuntimeV1 {
  if (command === "pause") return pausePomodoroRuntime(runtime, settings, nowMs);
  if (command === "reset") return resetPomodoroRuntime(settings);
  if (command === "add-minute") {
    const phaseDuration = runtime.phase === "focus"
      ? settings.focusDurationMs
      : runtime.phase === "short-break"
        ? settings.shortBreakDurationMs
        : settings.longBreakDurationMs;
    return addMinuteToPomodoro(runtime, settings, Math.min(60_000, MAX_TIMER_DURATION_MS - phaseDuration), nowMs);
  }
  if (command === "skip") return skipPomodoro(runtime, settings, nowMs);
  const advanced = runtime.status === "running" && runtime.deadlineMs !== null && nowMs >= runtime.deadlineMs
    ? advancePomodoroRuntime(runtime, settings, nowMs).runtime
    : runtime;
  return startPomodoroRuntime(advanced, settings, nowMs);
}

export function applyClassroomTimeControl(
  metadata: ClassroomTimeWidgetMetadataV1,
  target: ClassroomTimeControlTarget,
  command: ClassroomTimeControlCommand,
  nowMs: number,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind === "timer" && target === "timer") {
    if (command === "add-minute") {
      const durationMs = Math.min(MAX_TIMER_DURATION_MS, metadata.timer.durationMs + 60_000);
      const addedMs = durationMs - metadata.timer.durationMs;
      return {
        ...metadata,
        timer: { ...metadata.timer, durationMs },
        runtime: addMinuteToTimer(metadata.runtime, metadata.timer.durationMs, addedMs, nowMs),
      };
    }
    return { ...metadata, runtime: updateTimerRuntime(metadata.runtime, metadata.timer.durationMs, command, nowMs) };
  }
  if (metadata.kind === "pomodoro" && target === "pomodoro") {
    if (command === "add-minute") {
      const field = metadata.runtime.phase === "focus"
        ? "focusDurationMs"
        : metadata.runtime.phase === "short-break"
          ? "shortBreakDurationMs"
          : "longBreakDurationMs";
      const durationMs = Math.min(MAX_TIMER_DURATION_MS, metadata.pomodoro[field] + 60_000);
      const addedMs = durationMs - metadata.pomodoro[field];
      return {
        ...metadata,
        pomodoro: { ...metadata.pomodoro, [field]: durationMs },
        runtime: addMinuteToPomodoro(metadata.runtime, metadata.pomodoro, addedMs, nowMs),
      };
    }
    return { ...metadata, runtime: updatePomodoroRuntime(metadata.runtime, metadata.pomodoro, command, nowMs) };
  }
  if (metadata.kind === "dashboard" && target === "timer" && metadata.panels.timer) {
    if (command === "add-minute") {
      const durationMs = Math.min(MAX_TIMER_DURATION_MS, metadata.timer.durationMs + 60_000);
      const addedMs = durationMs - metadata.timer.durationMs;
      return {
        ...metadata,
        timer: { ...metadata.timer, durationMs },
        timerRuntime: addMinuteToTimer(metadata.timerRuntime, metadata.timer.durationMs, addedMs, nowMs),
      };
    }
    return { ...metadata, timerRuntime: updateTimerRuntime(metadata.timerRuntime, metadata.timer.durationMs, command, nowMs) };
  }
  if (metadata.kind === "dashboard" && target === "pomodoro" && metadata.panels.pomodoro) {
    if (command === "add-minute") {
      const field = metadata.pomodoroRuntime.phase === "focus"
        ? "focusDurationMs"
        : metadata.pomodoroRuntime.phase === "short-break"
          ? "shortBreakDurationMs"
          : "longBreakDurationMs";
      const durationMs = Math.min(MAX_TIMER_DURATION_MS, metadata.pomodoro[field] + 60_000);
      const addedMs = durationMs - metadata.pomodoro[field];
      return {
        ...metadata,
        pomodoro: { ...metadata.pomodoro, [field]: durationMs },
        pomodoroRuntime: addMinuteToPomodoro(metadata.pomodoroRuntime, metadata.pomodoro, addedMs, nowMs),
      };
    }
    return { ...metadata, pomodoroRuntime: updatePomodoroRuntime(metadata.pomodoroRuntime, metadata.pomodoro, command, nowMs) };
  }
  return metadata;
}

export function advanceExpiredClassroomTimeWidget(
  metadata: ClassroomTimeWidgetMetadataV1,
  nowMs: number,
): AdvancedClassroomTimeWidget {
  const completedTargets: ClassroomTimeControlTarget[] = [];
  if (metadata.kind === "timer") {
    const runtime = completeTimerRuntime(metadata.runtime, metadata.timer.durationMs, nowMs);
    if (runtime !== metadata.runtime) completedTargets.push("timer");
    return { metadata: runtime === metadata.runtime ? metadata : { ...metadata, runtime }, completedTargets };
  }
  if (metadata.kind === "pomodoro") {
    const advanced = advancePomodoroRuntime(metadata.runtime, metadata.pomodoro, nowMs);
    if (advanced.completedPhases.length) completedTargets.push("pomodoro");
    return { metadata: advanced.runtime === metadata.runtime ? metadata : { ...metadata, runtime: advanced.runtime }, completedTargets };
  }
  if (metadata.kind !== "dashboard") return { metadata, completedTargets };
  const timerRuntime = completeTimerRuntime(metadata.timerRuntime, metadata.timer.durationMs, nowMs);
  const pomodoroAdvance = advancePomodoroRuntime(metadata.pomodoroRuntime, metadata.pomodoro, nowMs);
  if (timerRuntime !== metadata.timerRuntime) completedTargets.push("timer");
  if (pomodoroAdvance.completedPhases.length) completedTargets.push("pomodoro");
  return {
    metadata: timerRuntime === metadata.timerRuntime && pomodoroAdvance.runtime === metadata.pomodoroRuntime
      ? metadata
      : { ...metadata, timerRuntime, pomodoroRuntime: pomodoroAdvance.runtime },
    completedTargets,
  };
}

function alarmDescriptor(
  projectId: string,
  metadata: ClassroomTimeWidgetMetadataV1,
  target: ClassroomTimeControlTarget,
  runtime: ClassroomTimerRuntimeV1 | ClassroomPomodoroRuntimeV1,
): ClassroomTimeAlarmDescriptor | null {
  if (runtime.status !== "running" || runtime.deadlineMs === null) return null;
  const alarm = metadata.kind === "timer" || metadata.kind === "pomodoro" || metadata.kind === "dashboard"
    ? metadata.alarm
    : null;
  if (!alarm?.enabled || (metadata.kind !== "timer" && metadata.kind !== "pomodoro" && metadata.kind !== "dashboard")) return null;
  const createdAtMs = Math.max(0, runtime.deadlineMs - runtime.remainingMs);
  return {
    id: `${metadata.ownerId}:${target}`,
    sourceProjectId: projectId,
    ownerId: metadata.ownerId,
    widgetKind: metadata.kind,
    target,
    label: metadata.label || (target === "timer" ? "Timer" : "Pomodoro"),
    deadlineMs: runtime.deadlineMs,
    createdAtMs,
    tone: alarm.tone,
    repeat: alarm.repeat,
  };
}

export function activeClassroomTimeAlarmDescriptors(
  projectId: string,
  elements: readonly ExcalidrawElement[],
): readonly ClassroomTimeAlarmDescriptor[] {
  const descriptors: ClassroomTimeAlarmDescriptor[] = [];
  for (const element of elements) {
    if (element.isDeleted) continue;
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata) continue;
    if (metadata.kind === "timer") {
      const descriptor = alarmDescriptor(projectId, metadata, "timer", metadata.runtime);
      if (descriptor) descriptors.push(descriptor);
    } else if (metadata.kind === "pomodoro") {
      const descriptor = alarmDescriptor(projectId, metadata, "pomodoro", metadata.runtime);
      if (descriptor) descriptors.push(descriptor);
    } else if (metadata.kind === "dashboard") {
      if (metadata.panels.timer) {
        const descriptor = alarmDescriptor(projectId, metadata, "timer", metadata.timerRuntime);
        if (descriptor) descriptors.push(descriptor);
      }
      if (metadata.panels.pomodoro) {
        const descriptor = alarmDescriptor(projectId, metadata, "pomodoro", metadata.pomodoroRuntime);
        if (descriptor) descriptors.push(descriptor);
      }
    }
  }
  return descriptors.sort((left, right) => left.deadlineMs - right.deadlineMs || left.id.localeCompare(right.id));
}

function eventSortKey(event: ClassroomCalendarEventV1, today: string): readonly [string, string, string, string] {
  return [event.date >= today ? "0" : "1", event.date >= today ? event.date : `~${event.date}`, event.startTime ?? "", event.id];
}

function compareEvent(left: ClassroomCalendarEventV1, right: ClassroomCalendarEventV1, today: string): number {
  const leftKey = eventSortKey(left, today);
  const rightKey = eventSortKey(right, today);
  for (let index = 0; index < leftKey.length; index += 1) {
    const order = leftKey[index].localeCompare(rightKey[index]);
    if (order) return order;
  }
  return 0;
}

function localDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function eventLabel(event: ClassroomCalendarEventV1): string {
  const date = event.date.slice(5);
  return `${date} · ${event.title}`;
}

export function classroomTimeRenderContext(
  elements: readonly ExcalidrawElement[],
  projectCalendar: ClassroomProjectCalendarStoreV1 | null | undefined,
  deviceCalendar: ClassroomDeviceCalendarStoreV1 | null | undefined,
  nowMs: number,
  boardTheme: ClassroomTimeBoardTheme = "light",
): ClassroomTimeRenderContext {
  const labelsByOwner: Record<string, readonly string[]> = {};
  const eventsByOwner: Record<string, readonly ClassroomTimeCalendarEventDisplay[]> = {};
  const today = localDateKey(nowMs);
  for (const element of elements) {
    if (element.isDeleted) continue;
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")) continue;
    const settings = metadata.calendar;
    const referencedProjectIds = new Set(settings.projectEventIds);
    const events = [
      ...(settings.showProjectEvents && projectCalendar?.layer === "project"
        ? projectCalendar.events.filter((event) => (
          referencedProjectIds.size === 0 || referencedProjectIds.has(event.id)
        ))
        : []),
      ...(settings.showDeviceEvents && deviceCalendar?.layer === "device" ? deviceCalendar.events : []),
    ];
    const visibleEvents = events
      .slice()
      .sort((left, right) => compareEvent(left, right, today))
      .slice(0, 6);
    labelsByOwner[metadata.ownerId] = visibleEvents.map(eventLabel);
    eventsByOwner[metadata.ownerId] = visibleEvents.map((event) => ({
      date: event.date,
      label: event.title,
      ...(event.note ? { note: event.note } : {}),
      color: event.color.toUpperCase(),
    }));
  }
  return {
    boardTheme,
    calendarEventsByOwner: eventsByOwner,
    calendarEventLabelsByOwner: labelsByOwner,
  };
}
