import {
  CLASSROOM_TIME_SCHEMA_VERSION,
  MAX_CLASSROOM_TIME_LABEL_LENGTH,
  MAX_TIMER_DURATION_MS,
  MIN_TIMER_DURATION_MS,
  SAFE_HEX_COLOR_PATTERN,
} from "./constants";
import {
  parseProjectCalendarTransferCache,
  type ProjectCalendarTransferCacheV1,
} from "./calendar";

export type {
  ClassroomCalendarEventV1,
  ClassroomCalendarStoreV1,
  ClassroomDeviceCalendarStoreV1,
  ClassroomProjectCalendarStoreV1,
  ProjectCalendarTransferCacheV1,
} from "./calendar";

export const CLASSROOM_TIME_WIDGET_KINDS = [
  "clock",
  "timer",
  "pomodoro",
  "calendar",
  "dashboard",
] as const;
export type ClassroomTimeWidgetKind = typeof CLASSROOM_TIME_WIDGET_KINDS[number];

export const CLASSROOM_TIME_WIDGET_ROLES = [
  "anchor",
  "shell",
  "title",
  "label",
  "primary-value",
  "primary-text",
  "secondary-value",
  "secondary-text",
  "date",
  "date-text",
  "weekday",
  "calendar-text",
  "hour-hand",
  "clock-hour-hand",
  "minute-hand",
  "clock-minute-hand",
  "second-hand",
  "clock-second-hand",
  "progress-ring",
  "progress-track",
  "progress-value",
  "phase-label",
  "cycle-label",
  "calendar-month",
  "dashboard-clock-primary",
  "dashboard-clock-secondary",
  "dashboard-timer-primary",
  "dashboard-timer-secondary",
  "dashboard-pomodoro-primary",
  "dashboard-pomodoro-secondary",
  "dashboard-calendar-month",
] as const;
type ClassroomTimeFixedWidgetRole = typeof CLASSROOM_TIME_WIDGET_ROLES[number];
type ClassroomTimeIndexedWidgetRole =
  | `calendar-day-${number}`
  | `calendar-weekday-${number}`
  | `calendar-event-${number}`
  | `dashboard-calendar-day-${number}`;
export type ClassroomTimeWidgetRole = ClassroomTimeFixedWidgetRole | ClassroomTimeIndexedWidgetRole;

export const ALARM_TONES = ["warm-chime", "gentle-bell", "bright-marimba"] as const;
export type ClassroomAlarmTone = typeof ALARM_TONES[number];

export const TIMER_STATUSES = ["idle", "running", "paused", "completed"] as const;
export type ClassroomTimerStatus = typeof TIMER_STATUSES[number];

export const POMODORO_PHASES = ["focus", "short-break", "long-break"] as const;
export type ClassroomPomodoroPhase = typeof POMODORO_PHASES[number];

export interface ClassroomTimeChildDataV1 {
  version: 1;
  ownerId: string;
  role: ClassroomTimeWidgetRole;
}

export interface ClassroomTimeAppearanceV1 {
  foregroundColor: string;
  backgroundColor: string;
  accentColor: string;
  borderColor: string;
  opacity: number;
  theme: "light" | "dark" | "auto";
}

export interface ClassroomAlarmSettingsV1 {
  enabled: boolean;
  tone: ClassroomAlarmTone;
  repeat: boolean;
}

export interface ClassroomClockSettingsV1 {
  display: "digital" | "analog";
  hourCycle: 12 | 24;
  showSeconds: boolean;
  showDate: boolean;
  showWeekday: boolean;
  showTimezone: boolean;
  timeZone: string | null;
}

export interface ClassroomTimerSettingsV1 {
  durationMs: number;
  progressStyle: "ring" | "bar" | "none";
}

export interface ClassroomTimerRuntimeV1 {
  status: ClassroomTimerStatus;
  remainingMs: number;
  deadlineMs: number | null;
  completedAtMs: number | null;
}

export interface ClassroomPomodoroSettingsV1 {
  focusDurationMs: number;
  shortBreakDurationMs: number;
  longBreakDurationMs: number;
  cyclesBeforeLongBreak: number;
  autoStartFocus: boolean;
  autoStartBreaks: boolean;
  progressStyle: "ring" | "bar" | "none";
}

export interface ClassroomPomodoroRuntimeV1 {
  status: ClassroomTimerStatus;
  phase: ClassroomPomodoroPhase;
  completedFocusSessions: number;
  remainingMs: number;
  deadlineMs: number | null;
  completedAtMs: number | null;
}

export type ClassroomCalendarTransferCacheV1 = ProjectCalendarTransferCacheV1;

export interface ClassroomCalendarSettingsV1 {
  view: "month" | "week" | "agenda";
  showProjectEvents: boolean;
  showDeviceEvents: boolean;
  showWeekends: boolean;
  showWeekNumbers: boolean;
  highlightToday: boolean;
  density: "comfortable" | "compact";
  projectEventIds: string[];
  transferCache: ClassroomCalendarTransferCacheV1 | null;
}

export interface ClassroomDashboardPanelsV1 {
  clock: boolean;
  timer: boolean;
  pomodoro: boolean;
  calendar: boolean;
}

interface ClassroomTimeWidgetBaseV1 {
  version: 1;
  ownerId: string;
  label: string;
  appearance: ClassroomTimeAppearanceV1;
}

export interface ClassroomClockWidgetMetadataV1 extends ClassroomTimeWidgetBaseV1 {
  kind: "clock";
  clock: ClassroomClockSettingsV1;
}

export interface ClassroomTimerWidgetMetadataV1 extends ClassroomTimeWidgetBaseV1 {
  kind: "timer";
  timer: ClassroomTimerSettingsV1;
  runtime: ClassroomTimerRuntimeV1;
  alarm: ClassroomAlarmSettingsV1;
}

export interface ClassroomPomodoroWidgetMetadataV1 extends ClassroomTimeWidgetBaseV1 {
  kind: "pomodoro";
  pomodoro: ClassroomPomodoroSettingsV1;
  runtime: ClassroomPomodoroRuntimeV1;
  alarm: ClassroomAlarmSettingsV1;
}

export interface ClassroomCalendarWidgetMetadataV1 extends ClassroomTimeWidgetBaseV1 {
  kind: "calendar";
  calendar: ClassroomCalendarSettingsV1;
}

export interface ClassroomDashboardWidgetMetadataV1 extends ClassroomTimeWidgetBaseV1 {
  kind: "dashboard";
  panels: ClassroomDashboardPanelsV1;
  clock: ClassroomClockSettingsV1;
  timer: ClassroomTimerSettingsV1;
  timerRuntime: ClassroomTimerRuntimeV1;
  pomodoro: ClassroomPomodoroSettingsV1;
  pomodoroRuntime: ClassroomPomodoroRuntimeV1;
  calendar: ClassroomCalendarSettingsV1;
  alarm: ClassroomAlarmSettingsV1;
}

export type ClassroomTimeWidgetMetadataV1 =
  | ClassroomClockWidgetMetadataV1
  | ClassroomTimerWidgetMetadataV1
  | ClassroomPomodoroWidgetMetadataV1
  | ClassroomCalendarWidgetMetadataV1
  | ClassroomDashboardWidgetMetadataV1;

export const DEFAULT_CLASSROOM_TIME_APPEARANCE: Readonly<ClassroomTimeAppearanceV1> = Object.freeze({
  foregroundColor: "#1f2937",
  backgroundColor: "#ffffff",
  accentColor: "#2563eb",
  borderColor: "#94a3b8",
  opacity: 1,
  theme: "auto",
});

export const DEFAULT_CLASSROOM_ALARM_SETTINGS: Readonly<ClassroomAlarmSettingsV1> = Object.freeze({
  enabled: true,
  tone: "warm-chime",
  repeat: false,
});

export const DEFAULT_CLASSROOM_CLOCK_SETTINGS: Readonly<ClassroomClockSettingsV1> = Object.freeze({
  display: "digital",
  hourCycle: 12,
  showSeconds: true,
  showDate: true,
  showWeekday: true,
  showTimezone: false,
  timeZone: null,
});

export const DEFAULT_CLASSROOM_TIMER_SETTINGS: Readonly<ClassroomTimerSettingsV1> = Object.freeze({
  durationMs: 5 * 60 * 1_000,
  progressStyle: "ring",
});

export const DEFAULT_CLASSROOM_POMODORO_SETTINGS: Readonly<ClassroomPomodoroSettingsV1> = Object.freeze({
  focusDurationMs: 25 * 60 * 1_000,
  shortBreakDurationMs: 5 * 60 * 1_000,
  longBreakDurationMs: 15 * 60 * 1_000,
  cyclesBeforeLongBreak: 4,
  autoStartFocus: false,
  autoStartBreaks: false,
  progressStyle: "ring",
});

export const DEFAULT_CLASSROOM_CALENDAR_SETTINGS: Readonly<ClassroomCalendarSettingsV1> = Object.freeze({
  view: "month",
  showProjectEvents: true,
  showDeviceEvents: true,
  showWeekends: true,
  showWeekNumbers: false,
  highlightToday: true,
  density: "comfortable",
  projectEventIds: Object.freeze([]) as unknown as string[],
  transferCache: null,
});

export const DEFAULT_CLASSROOM_TIME_WIDGET_LABELS: Readonly<Record<ClassroomTimeWidgetKind, string>> = Object.freeze({
  clock: "Class Clock",
  timer: "Class Timer",
  pomodoro: "Focus Session",
  calendar: "Class Calendar",
  dashboard: "Classroom Dashboard",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function isClassroomTimeWidgetRole(value: unknown): value is ClassroomTimeWidgetRole {
  if (isEnum(value, CLASSROOM_TIME_WIDGET_ROLES)) return true;
  if (typeof value !== "string") return false;
  const match = /^(calendar-day|calendar-weekday|calendar-event|dashboard-calendar-day)-(\d+)$/.exec(value);
  if (!match) return false;
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) return false;
  if (match[1] === "calendar-day") return index < 42;
  if (match[1] === "calendar-weekday") return index < 7;
  if (match[1] === "calendar-event") return index < 6;
  return index < 14;
}

export function isClassroomTimeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export function isSafeClassroomTimeColor(value: unknown): value is string {
  return typeof value === "string" && SAFE_HEX_COLOR_PATTERN.test(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= MIN_TIMER_DURATION_MS
    && value <= MAX_TIMER_DURATION_MS;
}

function isRemaining(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_TIMER_DURATION_MS;
}

function validTimeZone(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseClassroomTimeChildData(value: unknown): ClassroomTimeChildDataV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "ownerId", "role"])) return null;
  if (value.version !== CLASSROOM_TIME_SCHEMA_VERSION
    || !isClassroomTimeId(value.ownerId)
    || !isClassroomTimeWidgetRole(value.role)) return null;
  return { version: 1, ownerId: value.ownerId, role: value.role };
}

export function parseClassroomTimeAppearance(value: unknown): ClassroomTimeAppearanceV1 | null {
  const keys = ["foregroundColor", "backgroundColor", "accentColor", "borderColor", "opacity", "theme"];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  if (!isSafeClassroomTimeColor(value.foregroundColor)
    || !isSafeClassroomTimeColor(value.backgroundColor)
    || !isSafeClassroomTimeColor(value.accentColor)
    || !isSafeClassroomTimeColor(value.borderColor)
    || typeof value.opacity !== "number"
    || !Number.isFinite(value.opacity)
    || value.opacity < 0
    || value.opacity > 1
    || !isEnum(value.theme, ["light", "dark", "auto"] as const)) return null;
  return {
    foregroundColor: value.foregroundColor,
    backgroundColor: value.backgroundColor,
    accentColor: value.accentColor,
    borderColor: value.borderColor,
    opacity: value.opacity,
    theme: value.theme,
  };
}

export function parseClassroomAlarmSettings(value: unknown): ClassroomAlarmSettingsV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["enabled", "tone", "repeat"])) return null;
  if (typeof value.enabled !== "boolean"
    || !isEnum(value.tone, ALARM_TONES)
    || typeof value.repeat !== "boolean") return null;
  return { enabled: value.enabled, tone: value.tone, repeat: value.repeat };
}

export function parseClassroomClockSettings(value: unknown): ClassroomClockSettingsV1 | null {
  const keys = ["display", "hourCycle", "showSeconds", "showDate", "showWeekday", "showTimezone", "timeZone"];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  if (!isEnum(value.display, ["digital", "analog"] as const)
    || (value.hourCycle !== 12 && value.hourCycle !== 24)
    || typeof value.showSeconds !== "boolean"
    || typeof value.showDate !== "boolean"
    || typeof value.showWeekday !== "boolean"
    || typeof value.showTimezone !== "boolean"
    || !validTimeZone(value.timeZone)) return null;
  return {
    display: value.display,
    hourCycle: value.hourCycle,
    showSeconds: value.showSeconds,
    showDate: value.showDate,
    showWeekday: value.showWeekday,
    showTimezone: value.showTimezone,
    timeZone: value.timeZone,
  };
}

export function parseClassroomTimerSettings(value: unknown): ClassroomTimerSettingsV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["durationMs", "progressStyle"])) return null;
  if (!isDuration(value.durationMs)
    || !isEnum(value.progressStyle, ["ring", "bar", "none"] as const)) return null;
  return { durationMs: value.durationMs, progressStyle: value.progressStyle };
}

export function parseClassroomTimerRuntime(value: unknown, durationMs: number): ClassroomTimerRuntimeV1 | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["status", "remainingMs", "deadlineMs", "completedAtMs"])) return null;
  if (!isEnum(value.status, TIMER_STATUSES)
    || !isRemaining(value.remainingMs)
    || value.remainingMs > durationMs
    || !(value.deadlineMs === null || isFiniteTimestamp(value.deadlineMs))
    || !(value.completedAtMs === null || isFiniteTimestamp(value.completedAtMs))) return null;
  if ((value.status === "running") !== (value.deadlineMs !== null)) return null;
  if ((value.status === "completed") !== (value.completedAtMs !== null)) return null;
  if (value.status === "completed" && value.remainingMs !== 0) return null;
  return {
    status: value.status,
    remainingMs: value.remainingMs,
    deadlineMs: value.deadlineMs,
    completedAtMs: value.completedAtMs,
  };
}

export function parseClassroomPomodoroSettings(value: unknown): ClassroomPomodoroSettingsV1 | null {
  const keys = ["focusDurationMs", "shortBreakDurationMs", "longBreakDurationMs", "cyclesBeforeLongBreak", "autoStartFocus", "autoStartBreaks", "progressStyle"];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  if (!isDuration(value.focusDurationMs)
    || !isDuration(value.shortBreakDurationMs)
    || !isDuration(value.longBreakDurationMs)
    || typeof value.cyclesBeforeLongBreak !== "number"
    || !Number.isSafeInteger(value.cyclesBeforeLongBreak)
    || value.cyclesBeforeLongBreak < 1
    || value.cyclesBeforeLongBreak > 12
    || typeof value.autoStartFocus !== "boolean"
    || typeof value.autoStartBreaks !== "boolean"
    || !isEnum(value.progressStyle, ["ring", "bar", "none"] as const)) return null;
  return {
    focusDurationMs: value.focusDurationMs,
    shortBreakDurationMs: value.shortBreakDurationMs,
    longBreakDurationMs: value.longBreakDurationMs,
    cyclesBeforeLongBreak: value.cyclesBeforeLongBreak,
    autoStartFocus: value.autoStartFocus,
    autoStartBreaks: value.autoStartBreaks,
    progressStyle: value.progressStyle,
  };
}

export function pomodoroPhaseDurationMs(
  settings: ClassroomPomodoroSettingsV1,
  phase: ClassroomPomodoroPhase,
): number {
  if (phase === "focus") return settings.focusDurationMs;
  return phase === "short-break" ? settings.shortBreakDurationMs : settings.longBreakDurationMs;
}

export function parseClassroomPomodoroRuntime(value: unknown, settings: ClassroomPomodoroSettingsV1): ClassroomPomodoroRuntimeV1 | null {
  const keys = ["status", "phase", "completedFocusSessions", "remainingMs", "deadlineMs", "completedAtMs"];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  if (!isEnum(value.status, TIMER_STATUSES)
    || !isEnum(value.phase, POMODORO_PHASES)
    || typeof value.completedFocusSessions !== "number"
    || !Number.isSafeInteger(value.completedFocusSessions)
    || value.completedFocusSessions < 0
    || !isRemaining(value.remainingMs)
    || value.remainingMs > pomodoroPhaseDurationMs(settings, value.phase)
    || !(value.deadlineMs === null || isFiniteTimestamp(value.deadlineMs))
    || !(value.completedAtMs === null || isFiniteTimestamp(value.completedAtMs))) return null;
  if ((value.status === "running") !== (value.deadlineMs !== null)) return null;
  if ((value.status === "completed") !== (value.completedAtMs !== null)) return null;
  if (value.status === "completed" && value.remainingMs !== 0) return null;
  return {
    status: value.status,
    phase: value.phase,
    completedFocusSessions: value.completedFocusSessions,
    remainingMs: value.remainingMs,
    deadlineMs: value.deadlineMs,
    completedAtMs: value.completedAtMs,
  };
}

export function parseClassroomCalendarSettings(value: unknown): ClassroomCalendarSettingsV1 | null {
  const keys = ["view", "showProjectEvents", "showDeviceEvents", "showWeekends", "showWeekNumbers", "highlightToday", "density", "projectEventIds", "transferCache"];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  if (!isEnum(value.view, ["month", "week", "agenda"] as const)
    || typeof value.showProjectEvents !== "boolean"
    || typeof value.showDeviceEvents !== "boolean"
    || typeof value.showWeekends !== "boolean"
    || typeof value.showWeekNumbers !== "boolean"
    || typeof value.highlightToday !== "boolean"
    || !isEnum(value.density, ["comfortable", "compact"] as const)
    || !Array.isArray(value.projectEventIds)
    || value.projectEventIds.length > 500
    || value.projectEventIds.some((id) => !isClassroomTimeId(id))) return null;
  const uniqueIds = [...new Set(value.projectEventIds as string[])];
  if (uniqueIds.length !== value.projectEventIds.length) return null;
  const transferCache = value.transferCache === null ? null : parseProjectCalendarTransferCache(value.transferCache);
  if (value.transferCache !== null && transferCache === null) return null;
  return { ...value, projectEventIds: uniqueIds, transferCache } as ClassroomCalendarSettingsV1;
}

function parsePanels(value: unknown): ClassroomDashboardPanelsV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CLASSROOM_TIME_WIDGET_KINDS.slice(0, 4))) return null;
  if (typeof value.clock !== "boolean" || typeof value.timer !== "boolean"
    || typeof value.pomodoro !== "boolean" || typeof value.calendar !== "boolean") return null;
  if (!value.clock && !value.timer && !value.pomodoro && !value.calendar) return null;
  return {
    clock: value.clock,
    timer: value.timer,
    pomodoro: value.pomodoro,
    calendar: value.calendar,
  };
}

export function parseClassroomTimeWidgetMetadata(value: unknown): ClassroomTimeWidgetMetadataV1 | null {
  if (!isRecord(value)) return null;
  const commonKeys = ["version", "ownerId", "kind", "label", "appearance"];
  if (value.version !== 1
    || !isClassroomTimeId(value.ownerId)
    || !isEnum(value.kind, CLASSROOM_TIME_WIDGET_KINDS)
    || typeof value.label !== "string"
    || Array.from(value.label).length > MAX_CLASSROOM_TIME_LABEL_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value.label)
    || (value.label.length > 0 && value.label.trim() !== value.label)) return null;
  const appearance = parseClassroomTimeAppearance(value.appearance);
  if (!appearance) return null;

  const base = { version: 1 as const, ownerId: value.ownerId, label: value.label, appearance };
  if (value.kind === "clock") {
    if (!hasOnlyKeys(value, [...commonKeys, "clock"])) return null;
    const clock = parseClassroomClockSettings(value.clock);
    return clock ? { ...base, kind: "clock", clock } : null;
  }
  if (value.kind === "timer") {
    if (!hasOnlyKeys(value, [...commonKeys, "timer", "runtime", "alarm"])) return null;
    const timer = parseClassroomTimerSettings(value.timer);
    const runtime = timer ? parseClassroomTimerRuntime(value.runtime, timer.durationMs) : null;
    const alarm = parseClassroomAlarmSettings(value.alarm);
    return timer && runtime && alarm ? { ...base, kind: "timer", timer, runtime, alarm } : null;
  }
  if (value.kind === "pomodoro") {
    if (!hasOnlyKeys(value, [...commonKeys, "pomodoro", "runtime", "alarm"])) return null;
    const pomodoro = parseClassroomPomodoroSettings(value.pomodoro);
    const runtime = pomodoro ? parseClassroomPomodoroRuntime(value.runtime, pomodoro) : null;
    const alarm = parseClassroomAlarmSettings(value.alarm);
    return pomodoro && runtime && alarm ? { ...base, kind: "pomodoro", pomodoro, runtime, alarm } : null;
  }
  if (value.kind === "calendar") {
    if (!hasOnlyKeys(value, [...commonKeys, "calendar"])) return null;
    const calendar = parseClassroomCalendarSettings(value.calendar);
    return calendar ? { ...base, kind: "calendar", calendar } : null;
  }
  if (!hasOnlyKeys(value, [...commonKeys, "panels", "clock", "timer", "timerRuntime", "pomodoro", "pomodoroRuntime", "calendar", "alarm"])) return null;
  const panels = parsePanels(value.panels);
  const clock = parseClassroomClockSettings(value.clock);
  const timer = parseClassroomTimerSettings(value.timer);
  const timerRuntime = timer ? parseClassroomTimerRuntime(value.timerRuntime, timer.durationMs) : null;
  const pomodoro = parseClassroomPomodoroSettings(value.pomodoro);
  const pomodoroRuntime = pomodoro ? parseClassroomPomodoroRuntime(value.pomodoroRuntime, pomodoro) : null;
  const calendar = parseClassroomCalendarSettings(value.calendar);
  const alarm = parseClassroomAlarmSettings(value.alarm);
  return panels && clock && timer && timerRuntime && pomodoro && pomodoroRuntime && calendar && alarm
    ? { ...base, kind: "dashboard", panels, clock, timer, timerRuntime, pomodoro, pomodoroRuntime, calendar, alarm }
    : null;
}

/** Strict validator used at archive, paste, library, and scene boundaries. */
export function sanitizeClassroomTimeWidgetMetadata(value: unknown): ClassroomTimeWidgetMetadataV1 {
  const parsed = parseClassroomTimeWidgetMetadata(value);
  if (!parsed) throw new TypeError("Classroom time widget metadata is invalid.");
  return parsed;
}

export function createIdleTimerRuntime(durationMs: number): ClassroomTimerRuntimeV1 {
  if (!isDuration(durationMs)) throw new RangeError("Timer duration is outside the supported range.");
  return { status: "idle", remainingMs: durationMs, deadlineMs: null, completedAtMs: null };
}

export function createIdlePomodoroRuntime(settings: ClassroomPomodoroSettingsV1): ClassroomPomodoroRuntimeV1 {
  if (!parseClassroomPomodoroSettings(settings)) throw new RangeError("Pomodoro settings are invalid.");
  return {
    status: "idle",
    phase: "focus",
    completedFocusSessions: 0,
    remainingMs: settings.focusDurationMs,
    deadlineMs: null,
    completedAtMs: null,
  };
}

function defaultCalendarSettings(): ClassroomCalendarSettingsV1 {
  return {
    ...DEFAULT_CLASSROOM_CALENDAR_SETTINGS,
    projectEventIds: [],
    transferCache: null,
  };
}

export function createDefaultClassroomTimeWidgetMetadata(
  kind: ClassroomTimeWidgetKind,
  ownerId: string,
): ClassroomTimeWidgetMetadataV1 {
  if (!isClassroomTimeId(ownerId)) throw new TypeError("Classroom time widget owner ID is invalid.");
  const base = {
    version: 1 as const,
    ownerId,
    label: DEFAULT_CLASSROOM_TIME_WIDGET_LABELS[kind],
    appearance: { ...DEFAULT_CLASSROOM_TIME_APPEARANCE },
  };
  if (kind === "clock") {
    return { ...base, kind, clock: { ...DEFAULT_CLASSROOM_CLOCK_SETTINGS } };
  }
  if (kind === "timer") {
    const timer = { ...DEFAULT_CLASSROOM_TIMER_SETTINGS };
    return {
      ...base,
      kind,
      timer,
      runtime: createIdleTimerRuntime(timer.durationMs),
      alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
    };
  }
  if (kind === "pomodoro") {
    const pomodoro = { ...DEFAULT_CLASSROOM_POMODORO_SETTINGS };
    return {
      ...base,
      kind,
      pomodoro,
      runtime: createIdlePomodoroRuntime(pomodoro),
      alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
    };
  }
  if (kind === "calendar") {
    return { ...base, kind, calendar: defaultCalendarSettings() };
  }
  const timer = { ...DEFAULT_CLASSROOM_TIMER_SETTINGS };
  const pomodoro = { ...DEFAULT_CLASSROOM_POMODORO_SETTINGS };
  return {
    ...base,
    kind,
    panels: { clock: true, timer: true, pomodoro: true, calendar: true },
    clock: { ...DEFAULT_CLASSROOM_CLOCK_SETTINGS },
    timer,
    timerRuntime: createIdleTimerRuntime(timer.durationMs),
    pomodoro,
    pomodoroRuntime: createIdlePomodoroRuntime(pomodoro),
    calendar: defaultCalendarSettings(),
    alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
  };
}
