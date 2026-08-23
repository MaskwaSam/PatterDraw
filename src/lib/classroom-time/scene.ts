import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import { createLocalId } from "../id";
import {
  isClassroomTimeId,
  parseClassroomTimeChildData,
  parseClassroomTimeWidgetMetadata,
  sanitizeClassroomTimeWidgetMetadata,
  type ClassroomTimeAppearanceV1,
  type ClassroomCalendarSettingsV1,
  type ClassroomClockSettingsV1,
  type ClassroomTimeChildDataV1,
  type ClassroomTimeWidgetKind,
  type ClassroomTimeWidgetMetadataV1,
  type ClassroomTimeWidgetRole,
} from "./types";
import {
  materializeClassroomTimeWidgetSnapshot,
  pauseClassroomTimeWidget,
} from "./runtime";
import {
  parseClassroomCalendarStoreV1,
  type ClassroomCalendarEventV1,
  type ClassroomProjectCalendarStoreV1,
} from "./calendar";

export const CLASSROOM_TIME_SCENE_VERSION = 1;
export const MAX_CLASSROOM_TIME_WIDGETS = 64;
export const MAX_CLASSROOM_TIME_PARTS = 96;

const DASHBOARD_PURPLE = "#7447C7";
type SceneRole = ClassroomTimeWidgetRole;
type PartKind = "freedraw" | "line" | "text";

interface ClassroomTimeAnchorMarker {
  readonly type: "anchor";
  readonly ownerId: string;
  readonly metadata: ClassroomTimeWidgetMetadataV1;
}

interface ClassroomTimeChildMarker {
  readonly type: "child";
  readonly ownerId: string;
  readonly role: SceneRole;
  readonly child: ClassroomTimeChildDataV1;
}

type ClassroomTimeElementMarker = ClassroomTimeAnchorMarker | ClassroomTimeChildMarker;

interface WidgetStyle {
  readonly theme: ClassroomTimeBoardTheme;
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly purple: string;
  readonly panel: string;
  readonly panelAlternate: string;
  readonly track: string;
  readonly grid: string;
  readonly opacity: number;
}

export interface ResolvedClassroomTimeAppearance {
  readonly theme: ClassroomTimeBoardTheme;
  readonly accentColor: string;
  readonly backgroundColor: string;
  readonly foregroundColor: string;
  readonly borderColor: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface PartSpecBase {
  readonly kind: PartKind;
  readonly role: SceneRole;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
}

interface TextPartSpec extends PartSpecBase {
  readonly kind: "text";
  readonly text: string;
  readonly fontSize: number;
  readonly fontWeight?: "bold" | "normal";
  readonly align?: "center" | "left" | "right";
}

interface PathPartSpec extends PartSpecBase {
  readonly kind: "freedraw" | "line";
  readonly points: readonly Point[];
  readonly strokeWidth: number;
}

type PartSpec = TextPartSpec | PathPartSpec;

interface LayoutSpec {
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly parts: readonly PartSpec[];
}

export interface ClassroomTimeWidgetCreateOptions {
  readonly metadata: ClassroomTimeWidgetMetadataV1;
  readonly x: number;
  readonly y: number;
  readonly now?: number;
  readonly frameId?: string | null;
  readonly groupIds?: readonly string[];
  readonly angle?: number;
  readonly scale?: readonly [number, number];
  readonly createId?: () => string;
  readonly renderContext?: ClassroomTimeRenderContext;
}

export interface CreatedClassroomTimeWidget {
  readonly anchorId: string;
  readonly ownerId: string;
  readonly elements: readonly ExcalidrawElement[];
  readonly files: readonly BinaryFileData[];
}

export interface ClassroomTimeSceneReconcileOptions {
  readonly now?: number;
  readonly files?: BinaryFiles;
  readonly createId?: () => string;
  readonly renderContext?: ClassroomTimeRenderContext;
}

/** Caller-supplied, non-canonical display data resolved from project/device stores. */
export type ClassroomTimeBoardTheme = "light" | "dark";

export interface ClassroomTimeCalendarEventDisplay {
  readonly date: string;
  readonly label: string;
  readonly note?: string;
  readonly color: string;
}

export interface ClassroomTimeRenderContext {
  /** The current board/export theme used only by widgets set to Follow board. */
  readonly boardTheme?: ClassroomTimeBoardTheme;
  /** Structured transient event data. Device-layer values must never cross the persistence boundary. */
  readonly calendarEventsByOwner?: Readonly<Record<string, readonly ClassroomTimeCalendarEventDisplay[]>>;
  /** Backward-compatible label-only input used by older internal callers and tests. */
  readonly calendarEventLabelsByOwner?: Readonly<Record<string, readonly string[]>>;
}

export interface ReconciledClassroomTimeScene {
  readonly elements: readonly ExcalidrawElement[];
  readonly addedFiles: readonly BinaryFileData[];
  readonly orphanedFileIds: readonly FileId[];
  readonly repairedOwnerIds: readonly string[];
}

export interface ForkedClassroomTimeWidgets {
  readonly elements: readonly ExcalidrawElement[];
  readonly ownerIdMap: Readonly<Record<string, string>>;
  /** IDs changed by this helper, keyed by its input element ID. */
  readonly elementIdMap: Readonly<Record<string, string>>;
}

export interface ForkDuplicatedClassroomTimeWidgetsOptions {
  /**
   * Excalidraw's source-group to duplicated-group map. In particular, an
   * entry for each source widget owner ID identifies the already-duplicated
   * atomic widget group that must be replaced by the new logical owner.
   */
  readonly sourceToDuplicateGroupIds: ReadonlyMap<string, string>;
  readonly now?: number;
  readonly createId?: () => string;
}

export interface CanonicalizedClassroomTimeWidgetsForPersistence {
  readonly elements: readonly ExcalidrawElement[];
  readonly files: BinaryFiles;
}

interface DynamicDisplay {
  readonly title: string;
  readonly primary: string;
  readonly secondary: string;
  readonly date: string;
  readonly weekday: string;
  readonly phase: string;
  readonly cycle: string;
  readonly progress: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly month: string;
  readonly timezone: string;
  readonly calendarDays: readonly CalendarDayDisplay[];
  readonly calendarWeekDays: readonly CalendarDayDisplay[];
  readonly calendarAgendaDays: readonly CalendarDayDisplay[];
  readonly calendarEvents: readonly ClassroomTimeCalendarEventDisplay[];
  readonly timerPrimary: string;
  readonly timerSecondary: string;
  readonly pomodoroPrimary: string;
  readonly pomodoroSecondary: string;
  readonly pomodoroProgress: number;
}

interface CalendarDayDisplay {
  readonly key: string;
  readonly day: string;
  readonly shortDate: string;
  readonly longDate: string;
  readonly weekday: number;
  readonly weekdayLabel: string;
  readonly weekNumber: number;
  readonly isToday: boolean;
}

function asRole(role: string): SceneRole {
  return role as SceneRole;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function widgetKind(metadata: ClassroomTimeWidgetMetadataV1): ClassroomTimeWidgetKind {
  return metadata.kind;
}

function mixHexColor(source: string, target: string, targetWeight: number): string {
  const weight = clamp(targetWeight, 0, 1);
  const channel = (value: string, offset: number) => Number.parseInt(value.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => Math.round(
    channel(source, offset) * (1 - weight) + channel(target, offset) * weight,
  ));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function resolveClassroomTimeAppearance(
  appearance: ClassroomTimeAppearanceV1,
  boardTheme: ClassroomTimeBoardTheme = "light",
): ResolvedClassroomTimeAppearance {
  const theme = appearance.theme === "auto" ? boardTheme : appearance.theme;
  const background = appearance.backgroundColor.toUpperCase();
  const foreground = appearance.foregroundColor.toUpperCase();
  const border = appearance.borderColor.toUpperCase();
  return theme === "dark"
    ? {
        theme,
        accentColor: appearance.accentColor.toUpperCase(),
        backgroundColor: mixHexColor(background, "#0B1120", 0.8),
        foregroundColor: mixHexColor(foreground, "#FFFFFF", 0.82),
        borderColor: mixHexColor(border, "#E2E8F0", 0.62),
      }
    : {
        theme,
        accentColor: appearance.accentColor.toUpperCase(),
        backgroundColor: background,
        foregroundColor: foreground,
        borderColor: border,
      };
}

function widgetStyle(
  metadata: ClassroomTimeWidgetMetadataV1,
  context: ClassroomTimeRenderContext = {},
): WidgetStyle {
  const appearance = metadata.appearance;
  const resolved = resolveClassroomTimeAppearance(appearance, context.boardTheme);
  const { theme } = resolved;
  const background = appearance.backgroundColor.toUpperCase();
  const muted = appearance.borderColor.toUpperCase();
  if (theme === "dark") {
    return {
      theme,
      accent: resolved.accentColor,
      background: resolved.backgroundColor,
      foreground: resolved.foregroundColor,
      muted: resolved.borderColor,
      purple: mixHexColor(DASHBOARD_PURPLE, "#FFFFFF", 0.42),
      panel: mixHexColor(background, "#111827", 0.76),
      panelAlternate: mixHexColor(background, "#211A32", 0.76),
      track: mixHexColor(muted, "#334155", 0.74),
      grid: mixHexColor(muted, "#475569", 0.66),
      opacity: clamp(appearance.opacity, 0, 1),
    };
  }
  return {
    theme,
    accent: resolved.accentColor,
    background: resolved.backgroundColor,
    foreground: resolved.foregroundColor,
    muted: resolved.borderColor,
    purple: DASHBOARD_PURPLE,
    panel: mixHexColor(background, "#F8FAFF", 0.82),
    panelAlternate: mixHexColor(background, "#FBF8FF", 0.82),
    track: mixHexColor(muted, "#E8ECF5", 0.7),
    grid: mixHexColor(muted, "#DCE3F2", 0.72),
    opacity: clamp(appearance.opacity, 0, 1),
  };
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return compact ? compact.slice(0, 80) : fallback;
}

function safeEventDisplay(value: ClassroomTimeCalendarEventDisplay): ClassroomTimeCalendarEventDisplay | null {
  const label = safeLabel(value.label, "");
  if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !/^#[0-9A-Fa-f]{6}$/.test(value.color)) {
    return null;
  }
  const note = safeLabel(value.note, "");
  return {
    date: value.date,
    label,
    ...(note ? { note } : {}),
    color: value.color.toUpperCase(),
  };
}

function calendarEventText(event: ClassroomTimeCalendarEventDisplay, includeDate = true): string {
  const datePrefix = includeDate && /^\d{4}-\d{2}-\d{2}$/.test(event.date)
    ? `${event.date.slice(5)} · `
    : "";
  return `${datePrefix}${event.label}${event.note ? ` — ${event.note}` : ""}`;
}

function widgetTitle(metadata: ClassroomTimeWidgetMetadataV1, kind: ClassroomTimeWidgetKind): string {
  const defaults: Record<string, string> = {
    calendar: "Class Calendar",
    clock: "Class Clock",
    dashboard: "Classroom Dashboard",
    pomodoro: "Focus Session",
    timer: "Class Timer",
  };
  return safeLabel(metadata.label, defaults[String(kind)] ?? "Classroom Tool");
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const CALENDAR_WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

interface CalendarDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function calendarDateParts(date: Date, timeZone?: string): CalendarDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const numberPart = (type: "day" | "month" | "year") => Number(parts.find((part) => part.type === type)?.value);
  const year = numberPart("year");
  const month = numberPart("month");
  const day = numberPart("day");
  if (![year, month, day].every(Number.isFinite)) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  return { year, month, day };
}

function calendarKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function calendarDayDisplay(date: Date, todayKey: string): CalendarDayDisplay {
  const weekday = date.getUTCDay();
  return {
    key: calendarKey(date),
    day: String(date.getUTCDate()),
    shortDate: new Intl.DateTimeFormat("en-CA", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date),
    longDate: new Intl.DateTimeFormat("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date),
    weekday,
    weekdayLabel: CALENDAR_WEEKDAYS[weekday],
    weekNumber: isoWeekNumber(date),
    isToday: calendarKey(date) === todayKey,
  };
}

function calendarDateDisplays(now: number, timeZone?: string): {
  readonly month: string;
  readonly monthDays: readonly CalendarDayDisplay[];
  readonly weekDays: readonly CalendarDayDisplay[];
  readonly agendaDays: readonly CalendarDayDisplay[];
} {
  const todayParts = calendarDateParts(new Date(now), timeZone);
  const today = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
  const todayKey = calendarKey(today);
  const monthStart = new Date(Date.UTC(todayParts.year, todayParts.month - 1, 1));
  const monthStartOffset = (monthStart.getUTCDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setUTCDate(gridStart.getUTCDate() - monthStartOffset);
  const weekStart = new Date(today);
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const daysFrom = (start: Date, count: number) => Array.from({ length: count }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return calendarDayDisplay(day, todayKey);
  });
  return {
    month: new Intl.DateTimeFormat("en-CA", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(monthStart),
    monthDays: daysFrom(gridStart, 42),
    weekDays: daysFrom(weekStart, 7),
    agendaDays: daysFrom(today, 21),
  };
}

function timeZoneLabel(configuredTimeZone: string | null | undefined): string {
  const timeZone = configuredTimeZone || new Intl.DateTimeFormat("en-CA").resolvedOptions().timeZone || "UTC";
  return timeZone.replace(/_/g, " ");
}

function dynamicDisplay(
  metadata: ClassroomTimeWidgetMetadataV1,
  now: number,
  context: ClassroomTimeRenderContext = {},
): DynamicDisplay {
  const kind = widgetKind(metadata);
  const snapshot = materializeClassroomTimeWidgetSnapshot(metadata, now);
  const date = new Date(now);
  const clockSettings = metadata.kind === "clock" || metadata.kind === "dashboard" ? metadata.clock : null;
  const clockZone = clockSettings?.timeZone ?? undefined;
  const calendar = metadata.kind === "calendar" || metadata.kind === "dashboard"
    ? calendarDateDisplays(now, clockZone)
    : { month: "", monthDays: [], weekDays: [], agendaDays: [] };
  const clockParts = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(clockZone ? { timeZone: clockZone } : {}),
  }).formatToParts(date);
  const clockPart = (type: Intl.DateTimeFormatPartTypes, fallback: number) => {
    const value = Number(clockParts.find((part) => part.type === type)?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  const clockHour = clockPart("hour", date.getHours());
  const clockMinute = clockPart("minute", date.getMinutes());
  const clockSecond = clockPart("second", date.getSeconds());
  const defaultTime = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    ...(clockSettings?.showSeconds ? { second: "2-digit" as const } : {}),
    hour12: clockSettings?.hourCycle !== 24,
    ...(clockZone ? { timeZone: clockZone } : {}),
  }).format(date);
  const defaultDate = new Intl.DateTimeFormat("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(clockZone ? { timeZone: clockZone } : {}),
  }).format(date);
  const timerSnapshot = snapshot.timer;
  const pomodoroSnapshot = snapshot.pomodoro;
  const remainingMs = timerSnapshot?.remainingMs ?? pomodoroSnapshot?.remainingMs ?? 25 * 60_000;
  const durationMs = Math.max(1,
    metadata.kind === "timer" ? metadata.timer.durationMs
      : metadata.kind === "pomodoro"
        ? (metadata.runtime.phase === "focus" ? metadata.pomodoro.focusDurationMs
          : metadata.runtime.phase === "short-break" ? metadata.pomodoro.shortBreakDurationMs
            : metadata.pomodoro.longBreakDurationMs)
        : metadata.kind === "dashboard" ? metadata.timer.durationMs : remainingMs);
  const pomodoroCycles = metadata.kind === "pomodoro" || metadata.kind === "dashboard"
    ? metadata.pomodoro.cyclesBeforeLongBreak
    : 4;
  return {
    title: widgetTitle(metadata, kind),
    primary: kind === "clock" || kind === "dashboard" ? defaultTime : formatDuration(remainingMs),
    secondary: kind === "clock" ? defaultDate : (timerSnapshot?.status ?? pomodoroSnapshot?.status ?? "Ready"),
    date: defaultDate,
    weekday: new Intl.DateTimeFormat("en-CA", { weekday: "long", ...(clockZone ? { timeZone: clockZone } : {}) }).format(date),
    phase: pomodoroSnapshot ? pomodoroSnapshot.phase.replace("-", " ") : "Focus",
    cycle: pomodoroSnapshot
      ? `Session ${pomodoroSnapshot.completedFocusSessions % pomodoroCycles + 1} of ${pomodoroCycles}`
      : `Session 1 of ${pomodoroCycles}`,
    progress: clamp(timerSnapshot?.progress ?? pomodoroSnapshot?.progress ?? 1 - remainingMs / durationMs, 0, 1),
    hour: clockHour % 12 + clockMinute / 60,
    minute: clockMinute + clockSecond / 60,
    second: clockSecond,
    month: calendar.month,
    timezone: timeZoneLabel(clockSettings?.timeZone),
    calendarDays: calendar.monthDays,
    calendarWeekDays: calendar.weekDays,
    calendarAgendaDays: calendar.agendaDays,
    calendarEvents: context.calendarEventsByOwner?.[metadata.ownerId]
      ? context.calendarEventsByOwner[metadata.ownerId]
        .slice(0, 6)
        .map(safeEventDisplay)
        .filter((event): event is ClassroomTimeCalendarEventDisplay => event !== null)
      : (context.calendarEventLabelsByOwner?.[metadata.ownerId] ?? [])
        .slice(0, 6)
        .map((label) => safeLabel(label, ""))
        .filter(Boolean)
        .map((label) => ({ date: "", label, color: metadata.appearance.accentColor.toUpperCase() })),
    timerPrimary: formatDuration(timerSnapshot?.remainingMs ?? (metadata.kind === "dashboard" ? metadata.timerRuntime.remainingMs : remainingMs)),
    timerSecondary: timerSnapshot?.status ?? "Ready",
    pomodoroPrimary: formatDuration(pomodoroSnapshot?.remainingMs ?? (metadata.kind === "dashboard" ? metadata.pomodoroRuntime.remainingMs : remainingMs)),
    pomodoroSecondary: pomodoroSnapshot ? pomodoroSnapshot.phase.replace("-", " ") : "Focus",
    pomodoroProgress: pomodoroSnapshot?.progress ?? 0,
  };
}

function text(
  role: string,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  color: string,
  align: TextPartSpec["align"] = "center",
  fontWeight: TextPartSpec["fontWeight"] = "normal",
): TextPartSpec {
  return {
    kind: "text",
    role: asRole(role),
    text: value,
    x,
    y,
    width,
    height,
    fontSize,
    color,
    align,
    fontWeight,
  };
}

function clockParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  width: number,
  height: number,
  showDate: boolean,
  showWeekday: boolean,
  showTimezone: boolean,
): readonly PartSpec[] {
  const shared: PartSpec[] = [
    text("title", display.title, 32, 26, width - 174, 28, 20, style.muted, "left", "bold"),
    ...(showDate ? [text("date", display.date, 32, 148, width - 184, 25, 17, style.foreground, "left")] : []),
    ...(showWeekday ? [text("weekday", display.weekday, 32, 178, width - 184, 23, 15, style.muted, "left")] : []),
    ...(showTimezone ? [text("secondary-value", display.timezone, 32, 204, width - 64, 18, 12, style.accent, "left", "bold")] : []),
  ];
  return [
    ...shared,
    text("primary-value", display.primary, 32, 78, width - 64, 58, 42, style.foreground, "left", "bold"),
  ];
}

function timerParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  width: number,
  height: number,
): readonly PartSpec[] {
  return [
    text("title", display.title, 32, 28, width - 64, 28, 20, style.muted, "left", "bold"),
    text("primary-value", display.primary, 34, 75, width - 68, 64, 52, style.foreground, "center", "bold"),
    text("secondary-value", display.secondary, 34, 151, width - 68, 24, 16, style.muted, "center"),
  ];
}

function pomodoroParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  width: number,
  height: number,
): readonly PartSpec[] {
  return [
    text("title", display.title, 34, 26, width - 68, 28, 20, style.muted, "left", "bold"),
    text("phase-label", display.phase, 34, 61, width - 68, 26, 18, style.purple, "center", "bold"),
    text("primary-value", display.primary, 34, 91, width - 68, 63, 50, style.foreground, "center", "bold"),
    text("cycle-label", display.cycle, 34, 166, width - 68, 24, 15, style.muted, "center"),
  ];
}

function visibleCalendarDays(
  days: readonly CalendarDayDisplay[],
  showWeekends: boolean,
): readonly CalendarDayDisplay[] {
  return showWeekends ? days : days.filter((day) => day.weekday !== 0 && day.weekday !== 6);
}

function calendarHeading(display: DynamicDisplay, settings: ClassroomCalendarSettingsV1): string {
  if (settings.view === "week") {
    const first = display.calendarWeekDays[0];
    const week = first?.weekNumber;
    return `Week of ${first?.shortDate ?? display.month}${settings.showWeekNumbers && week ? ` · W${week}` : ""}`;
  }
  if (settings.view === "agenda") {
    const visible = visibleCalendarDays(display.calendarAgendaDays, settings.showWeekends);
    const count = settings.density === "compact" ? 14 : 8;
    const first = visible[0];
    const last = visible[Math.min(count, visible.length) - 1];
    return `Agenda · ${first?.shortDate ?? display.month}${last ? ` – ${last.shortDate}` : ""}${settings.showWeekNumbers && first ? ` · W${first.weekNumber}` : ""}`;
  }
  return display.month;
}

function calendarEventParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  width: number,
  height: number,
  settings: ClassroomCalendarSettingsV1,
): readonly PartSpec[] {
  const compact = settings.density === "compact";
  const limit = compact ? 6 : 4;
  const step = compact ? 17 : 23;
  const fontSize = compact ? 11 : 13;
  const eventWidth = settings.view === "agenda" ? width * 0.43 : width - 68;
  const x = settings.view === "agenda" ? width * 0.52 : 34;
  const firstY = settings.view === "agenda" ? 116 : height - 26;
  return display.calendarEvents.slice(0, limit).map((event, index) => text(
    `calendar-event-${index}`,
    calendarEventText(event),
    x,
    settings.view === "agenda" ? firstY + index * step : firstY - index * step,
    eventWidth,
    step - 2,
    fontSize,
    event.color,
    "left",
  ));
}

function calendarParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  width: number,
  height: number,
  settings: ClassroomCalendarSettingsV1,
): readonly PartSpec[] {
  const parts: PartSpec[] = [
    text("title", display.title, 30, 24, width - 60, 28, 19, style.muted, "left", "bold"),
    text("calendar-month", calendarHeading(display, settings), 30, 62, width - 60, 40, settings.density === "compact" ? 26 : 30, style.foreground, "left", "bold"),
  ];
  const gridX = 28;
  const gridY = 116;
  const compact = settings.density === "compact";
  if (settings.view === "agenda") {
    const days = visibleCalendarDays(display.calendarAgendaDays, settings.showWeekends)
      .slice(0, compact ? 14 : 8);
    const rowHeight = compact ? 19 : 31;
    days.forEach((day, index) => {
      const prefix = settings.showWeekNumbers && (index === 0 || day.weekday === 1) ? `W${day.weekNumber} · ` : "";
      parts.push(text(
        `calendar-day-${index}`,
        `${prefix}${settings.highlightToday && day.isToday ? "TODAY · " : ""}${day.longDate}`,
        gridX,
        gridY + index * rowHeight,
        width * 0.46,
        rowHeight - 2,
        compact ? 12 : 15,
        settings.highlightToday && day.isToday ? style.accent : style.foreground,
        "left",
        settings.highlightToday && day.isToday ? "bold" : "normal",
      ));
    });
    parts.push(...calendarEventParts(display, style, width, height, settings));
    return parts;
  }

  const sourceDays = settings.view === "week" ? display.calendarWeekDays : display.calendarDays;
  const days = visibleCalendarDays(sourceDays, settings.showWeekends);
  const columns = settings.showWeekends ? 7 : 5;
  const cellWidth = (width - 56) / columns;
  const cellHeight = settings.view === "week"
    ? (compact ? 82 : 104)
    : (height - gridY - 22) / 7;
  days.slice(0, columns).forEach((day, column) => {
    parts.push(text(
      `calendar-weekday-${column}`,
      day.weekdayLabel,
      gridX + column * cellWidth,
      gridY,
      cellWidth,
      settings.view === "week" ? 32 : cellHeight,
      compact ? 11 : 12,
      style.muted,
      "center",
      "bold",
    ));
  });
  days.forEach((day, index) => {
    const row = Math.floor(index / columns) + 1;
    const column = index % columns;
    const showRowWeek = settings.showWeekNumbers && column === 0;
    const value = settings.view === "week"
      ? `${showRowWeek ? `W${day.weekNumber} · ` : ""}${day.shortDate}`
      : `${showRowWeek ? `W${day.weekNumber} · ` : ""}${day.day}`;
    parts.push(text(
      `calendar-day-${index}`,
      value,
      gridX + column * cellWidth,
      gridY + row * cellHeight,
      cellWidth,
      cellHeight,
      compact ? 14 : settings.view === "week" ? 22 : 17,
      settings.highlightToday && day.isToday ? style.accent : style.foreground,
      "center",
      settings.highlightToday && day.isToday ? "bold" : "normal",
    ));
  });
  parts.push(...calendarEventParts(display, style, width, height, settings));
  return parts;
}

function dashboardClockSecondary(display: DynamicDisplay, settings: ClassroomClockSettingsV1): string {
  return [
    settings.showWeekday ? display.weekday : "",
    settings.showDate ? display.date : "",
    settings.showTimezone ? display.timezone : "",
  ].filter(Boolean).join(" · ");
}

function dashboardCalendarParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  settings: ClassroomCalendarSettingsV1,
): readonly PartSpec[] {
  const parts: PartSpec[] = [text(
    "dashboard-calendar-month",
    calendarHeading(display, settings),
    504,
    283,
    390,
    32,
    settings.density === "compact" ? 20 : 24,
    style.foreground,
    "left",
    "bold",
  )];
  const compact = settings.density === "compact";
  const todayIndex = display.calendarDays.findIndex((day) => day.isToday);
  const currentMonthRowStart = todayIndex < 0 ? 0 : Math.floor(todayIndex / 7) * 7;
  const monthWindow = display.calendarDays.slice(currentMonthRowStart, currentMonthRowStart + 14);
  const source = settings.view === "week"
    ? display.calendarWeekDays
    : settings.view === "agenda"
      ? display.calendarAgendaDays
      : monthWindow;
  const visible = visibleCalendarDays(source, settings.showWeekends);
  const eventForDay = (day: CalendarDayDisplay, index: number) => (
    display.calendarEvents.find((candidate) => candidate.date === day.key)
    ?? display.calendarEvents.filter((candidate) => !candidate.date)[index]
  );
  if (settings.view === "agenda") {
    visible.slice(0, compact ? 8 : 5).forEach((day, index) => {
      const prefix = settings.showWeekNumbers && (index === 0 || day.weekday === 1) ? `W${day.weekNumber} · ` : "";
      const event = eventForDay(day, index);
      parts.push(text(
        `dashboard-calendar-day-${index}`,
        `${prefix}${settings.highlightToday && day.isToday ? "TODAY · " : ""}${day.longDate}${event ? ` · ${calendarEventText(event, false)}` : ""}`,
        504,
        330 + index * (compact ? 20 : 31),
        390,
        compact ? 18 : 28,
        compact ? 11 : 14,
        event?.color ?? (settings.highlightToday && day.isToday ? style.accent : style.foreground),
        "left",
        settings.highlightToday && day.isToday ? "bold" : "normal",
      ));
    });
    return parts;
  }
  const columns = settings.showWeekends ? 7 : 5;
  const limit = settings.view === "week" ? columns : compact ? columns * 2 : columns;
  const cellWidth = 390 / columns;
  visible.slice(0, limit).forEach((day, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const showRowWeek = settings.showWeekNumbers && column === 0;
    const event = eventForDay(day, index);
    const value = settings.view === "week"
      ? `${day.weekdayLabel} ${day.day}`
      : `${showRowWeek ? `W${day.weekNumber} · ` : ""}${day.day}`;
    parts.push(text(
      `dashboard-calendar-day-${index}`,
      `${value}${event ? ` · ${calendarEventText(event, false)}` : ""}`,
      504 + column * cellWidth,
      330 + row * (compact ? 52 : 68),
      cellWidth,
      compact ? 44 : 58,
      compact ? 13 : 16,
      event?.color ?? (settings.highlightToday && day.isToday ? style.accent : style.foreground),
      "center",
      settings.highlightToday && day.isToday ? "bold" : "normal",
    ));
  });
  return parts;
}

function dashboardParts(
  display: DynamicDisplay,
  style: WidgetStyle,
  width: number,
  height: number,
  panels: { clock: boolean; timer: boolean; pomodoro: boolean; calendar: boolean },
  clock: ClassroomClockSettingsV1,
  calendar: ClassroomCalendarSettingsV1,
): readonly PartSpec[] {
  const parts: PartSpec[] = [text("title", display.title, 34, 25, width - 68, 31, 22, style.foreground, "left", "bold")];
  if (panels.clock) {
    parts.push(text("dashboard-clock-primary", display.primary, 42, 99, 385, 62, 46, style.foreground, "center", "bold"));
    const secondary = dashboardClockSecondary(display, clock);
    if (secondary) parts.push(text("dashboard-clock-secondary", secondary, 42, 203, 385, 22, 13, style.muted, "center"));
  }
  if (panels.timer) parts.push(
    text("dashboard-timer-primary", display.timerPrimary, 504, 95, 390, 58, 44, style.foreground, "center", "bold"),
    text("dashboard-timer-secondary", display.timerSecondary, 504, 157, 390, 22, 15, style.accent, "center", "bold"),
  );
  if (panels.pomodoro) parts.push(
    text("dashboard-pomodoro-primary", display.pomodoroPrimary, 42, 312, 385, 58, 44, style.foreground, "center", "bold"),
    text("dashboard-pomodoro-secondary", display.pomodoroSecondary, 42, 374, 385, 22, 15, style.purple, "center", "bold"),
  );
  if (panels.calendar) parts.push(...dashboardCalendarParts(display, style, calendar));
  return parts;
}

function layoutFor(
  metadata: ClassroomTimeWidgetMetadataV1,
  now: number,
  context: ClassroomTimeRenderContext = {},
): LayoutSpec {
  const kind = widgetKind(metadata);
  const style = widgetStyle(metadata, context);
  const display = dynamicDisplay(metadata, now, context);
  switch (String(kind)) {
    case "clock": {
      const width = 420;
      const height = 240;
      const settings = metadata.kind === "clock" ? metadata.clock : null;
      return {
        width,
        height,
        opacity: style.opacity,
        parts: clockParts(display, style, width, height, settings?.showDate ?? true, settings?.showWeekday ?? true, settings?.showTimezone ?? false),
      };
    }
    case "timer": {
      const width = 420;
      const height = 240;
      return { width, height, opacity: style.opacity, parts: timerParts(display, style, width, height) };
    }
    case "pomodoro": {
      const width = 460;
      const height = 260;
      return { width, height, opacity: style.opacity, parts: pomodoroParts(display, style, width, height) };
    }
    case "calendar": {
      const width = 560;
      const height = 420;
      const settings = metadata.kind === "calendar" ? metadata.calendar : null;
      if (!settings) throw new Error("Calendar widget settings are unavailable.");
      return { width, height, opacity: style.opacity, parts: calendarParts(display, style, width, height, settings) };
    }
    case "dashboard": {
      const width = 960;
      const height = 540;
      if (metadata.kind !== "dashboard") throw new Error("Dashboard widget settings are unavailable.");
      return { width, height, opacity: style.opacity, parts: dashboardParts(display, style, width, height, metadata.panels, metadata.clock, metadata.calendar) };
    }
    default:
      throw new Error("Unsupported classroom time widget kind.");
  }
}

function xmlColor(color: string): string {
  return color;
}

function shellSvg(
  metadata: ClassroomTimeWidgetMetadataV1,
  layout: Pick<LayoutSpec, "width" | "height">,
  context: ClassroomTimeRenderContext = {},
): string {
  const kind = String(widgetKind(metadata));
  const style = widgetStyle(metadata, context);
  const width = layout.width;
  const height = layout.height;
  const common = `<rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="24" fill="${xmlColor(style.background)}" stroke="${xmlColor(style.accent)}" stroke-opacity=".24" stroke-width="3"/>`;
  let decoration = "";
  if (kind === "calendar" && metadata.kind === "calendar") {
    const gridY = 116;
    const gridHeight = height - gridY - 22;
    const columns = metadata.calendar.showWeekends ? 7 : 5;
    const rows = metadata.calendar.view === "month"
      ? 7
      : metadata.calendar.density === "compact" ? 14 : 8;
    const vertical = metadata.calendar.view === "agenda" ? "" : Array.from(
      { length: columns - 1 },
      (_, index) => `M ${28 + (width - 56) * (index + 1) / columns} ${gridY} V ${gridY + gridHeight}`,
    ).join(" ");
    const horizontal = metadata.calendar.view === "week"
      ? `M 28 ${gridY + 32} H ${width - 28}`
      : Array.from(
        { length: rows - 1 },
        (_, index) => `M 28 ${gridY + gridHeight * (index + 1) / rows} H ${width - 28}`,
      ).join(" ");
    decoration = `<rect x="28" y="${gridY}" width="${width - 56}" height="${gridHeight}" rx="12" fill="${xmlColor(style.panel)}" stroke="${xmlColor(style.grid)}"/><path d="${horizontal} ${vertical}" fill="none" stroke="${xmlColor(style.grid)}"/>`;
  } else if (kind === "dashboard" && metadata.kind === "dashboard") {
    decoration = [
      `<rect x="30" y="61" width="126" height="4" rx="2" fill="${xmlColor(style.purple)}"/>`,
      metadata.panels.clock ? `<rect x="30" y="74" width="418" height="166" rx="18" fill="${xmlColor(style.panel)}" stroke="${xmlColor(style.grid)}"/>` : "",
      metadata.panels.timer ? `<rect x="482" y="74" width="448" height="166" rx="18" fill="${xmlColor(style.panel)}" stroke="${xmlColor(style.grid)}"/>` : "",
      metadata.panels.pomodoro ? `<rect x="30" y="264" width="418" height="244" rx="18" fill="${xmlColor(style.panelAlternate)}" stroke="${xmlColor(style.grid)}"/>` : "",
      metadata.panels.calendar ? `<rect x="482" y="264" width="448" height="244" rx="18" fill="${xmlColor(style.panel)}" stroke="${xmlColor(style.grid)}"/>` : "",
    ].join("");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Classroom ${kind} widget"><g opacity="${style.opacity}">${common}${decoration}</g></svg>`;
}

function svgDataUrl(svg: string): DataURL {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}` as DataURL;
}

function seedFromId(id: string): number {
  let hash = 5381;
  for (const character of id) hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  return Math.abs(hash | 0) || 1;
}

function commonElement(
  id: string,
  type: ExcalidrawElement["type"],
  x: number,
  y: number,
  width: number,
  height: number,
  now: number,
  ownerId: string,
  groupIds: readonly string[],
  frameId: string | null,
  angle: number,
  customData: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    roundness: null,
    seed: seedFromId(id),
    version: 1,
    versionNonce: seedFromId(`${id}:nonce`),
    index: null,
    isDeleted: false,
    groupIds: [ownerId, ...groupIds.filter((groupId) => groupId !== ownerId)],
    frameId,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    customData,
  };
}

function childData(ownerId: string, role: SceneRole): ClassroomTimeChildDataV1 {
  return {
    version: CLASSROOM_TIME_SCENE_VERSION,
    ownerId,
    role,
  };
}

function customDataFor(data: ClassroomTimeWidgetMetadataV1 | ClassroomTimeChildDataV1): Record<string, unknown> {
  return { classroomTimeWidget: data };
}

function markerFor(element: ExcalidrawElement): ClassroomTimeElementMarker | null {
  const wrapper = element.customData?.classroomTimeWidget;
  const metadata = parseClassroomTimeWidgetMetadata(wrapper);
  if (metadata && element.type === "image") {
    return { type: "anchor", ownerId: metadata.ownerId, metadata };
  }
  const child = parseClassroomTimeChildData(wrapper);
  return child ? { type: "child", ownerId: child.ownerId, role: child.role, child } : null;
}

function anchorMarkerFor(element: ExcalidrawElement): ClassroomTimeAnchorMarker | null {
  const marker = markerFor(element);
  return marker?.type === "anchor" ? marker : null;
}

export function classroomTimeWidgetOwnerId(element: ExcalidrawElement): string | null {
  return markerFor(element)?.ownerId ?? null;
}

export function classroomTimeWidgetRole(element: ExcalidrawElement): ClassroomTimeWidgetRole | "anchor" | null {
  const marker = markerFor(element);
  return marker?.type === "anchor" ? "anchor" : marker?.role ?? null;
}

export function classroomTimeWidgetMetadata(
  element: ExcalidrawElement,
): ClassroomTimeWidgetMetadataV1 | null {
  return anchorMarkerFor(element)?.metadata ?? null;
}

/** Stable key for logical annotation counting; all parts of a widget share it. */
export function classroomTimeLogicalElementKey(element: ExcalidrawElement): string {
  const ownerId = classroomTimeWidgetOwnerId(element);
  return ownerId ? `classroom-time:${ownerId}` : `element:${element.id}`;
}

export function isClassroomTimeWidgetAnchor(element: ExcalidrawElement): boolean {
  return !!anchorMarkerFor(element);
}

export function classroomTimeLogicalOwnerIds(elements: readonly ExcalidrawElement[]): readonly string[] {
  const owners = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const ownerId = classroomTimeWidgetOwnerId(element);
    if (ownerId) owners.add(ownerId);
  }
  return [...owners];
}

export function expandClassroomTimeWidgetElementIds(
  elements: readonly ExcalidrawElement[],
  selectedElementIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const selectedOwners = new Set<string>();
  for (const element of elements) {
    if (!selectedElementIds.has(element.id)) continue;
    const ownerId = classroomTimeWidgetOwnerId(element);
    if (ownerId) selectedOwners.add(ownerId);
  }
  if (!selectedOwners.size) return selectedElementIds;
  const expanded = new Set(selectedElementIds);
  for (const element of elements) {
    const ownerId = classroomTimeWidgetOwnerId(element);
    if (ownerId && selectedOwners.has(ownerId)) expanded.add(element.id);
  }
  return expanded;
}

function validMetadata(value: unknown): ClassroomTimeWidgetMetadataV1 | null {
  try {
    return sanitizeClassroomTimeWidgetMetadata(value);
  } catch {
    return null;
  }
}

function rotatePoint(point: Point, center: Point, angle: number): Point {
  if (!angle) return point;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine,
  };
}

function anchorScale(anchor: ExcalidrawElement): readonly [number, number] {
  if (anchor.type !== "image") return [1, 1];
  return [anchor.scale[0] < 0 ? -1 : 1, anchor.scale[1] < 0 ? -1 : 1];
}

function localToAnchor(
  point: Point,
  anchor: ExcalidrawElement,
  naturalWidth: number,
  naturalHeight: number,
): Point {
  const [scaleX, scaleY] = anchorScale(anchor);
  let localX = point.x / naturalWidth * anchor.width;
  let localY = point.y / naturalHeight * anchor.height;
  if (scaleX < 0) localX = anchor.width - localX;
  if (scaleY < 0) localY = anchor.height - localY;
  const absolute = { x: anchor.x + localX, y: anchor.y + localY };
  return rotatePoint(absolute, { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }, anchor.angle);
}

function partElement(
  spec: PartSpec,
  anchor: ExcalidrawElement,
  ownerId: string,
  layout: Pick<LayoutSpec, "width" | "height" | "opacity">,
  id: string,
  now: number,
): ExcalidrawElement {
  const marker = customDataFor(childData(ownerId, spec.role));
  const commonGroups = anchor.groupIds.filter((groupId) => groupId !== ownerId);
  if (spec.kind === "text") {
    const topLeft = localToAnchor({ x: spec.x, y: spec.y }, anchor, layout.width, layout.height);
    const bottomRight = localToAnchor({ x: spec.x + spec.width, y: spec.y + spec.height }, anchor, layout.width, layout.height);
    const width = Math.max(1, Math.hypot(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y));
    const height = Math.max(1, spec.height / layout.height * anchor.height);
    const center = localToAnchor({ x: spec.x + spec.width / 2, y: spec.y + spec.height / 2 }, anchor, layout.width, layout.height);
    return {
      ...commonElement(id, "text", center.x - width / 2, center.y - height / 2, width, height, now, ownerId, commonGroups, anchor.frameId, anchor.angle, marker),
      type: "text",
      opacity: Math.round(layout.opacity * 100),
      strokeColor: spec.color,
      fontSize: Math.max(8, spec.fontSize * Math.min(anchor.width / layout.width, anchor.height / layout.height)),
      fontFamily: 2,
      text: spec.text,
      originalText: spec.text,
      textAlign: spec.align ?? "center",
      verticalAlign: "middle",
      containerId: null,
      autoResize: false,
      lineHeight: 1.25,
    } as unknown as ExcalidrawElement;
  }
  const [mirrorX, mirrorY] = anchorScale(anchor);
  const points = spec.points.map((point) => {
    let x = point.x / layout.width * anchor.width;
    let y = point.y / layout.height * anchor.height;
    if (mirrorX < 0) x = anchor.width - x;
    if (mirrorY < 0) y = anchor.height - y;
    return [x, y];
  });
  const common = commonElement(id, spec.kind, anchor.x, anchor.y, anchor.width, anchor.height, now, ownerId, commonGroups, anchor.frameId, anchor.angle, marker);
  if (spec.kind === "line") {
    return {
      ...common,
      type: "line",
      opacity: Math.round(layout.opacity * 100),
      strokeColor: spec.color,
      strokeWidth: spec.strokeWidth * Math.min(anchor.width / layout.width, anchor.height / layout.height),
      points,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
    } as unknown as ExcalidrawElement;
  }
  return {
    ...common,
    type: "freedraw",
    opacity: Math.round(layout.opacity * 100),
    strokeColor: spec.color,
    strokeWidth: spec.strokeWidth * Math.min(anchor.width / layout.width, anchor.height / layout.height),
    points,
    pressures: points.map(() => 0.5),
    simulatePressure: false,
    lastCommittedPoint: null,
  } as unknown as ExcalidrawElement;
}

function createShellFile(
  id: FileId,
  metadata: ClassroomTimeWidgetMetadataV1,
  layout: LayoutSpec,
  now: number,
  renderContext: ClassroomTimeRenderContext = {},
): BinaryFileData {
  return {
    id,
    mimeType: "image/svg+xml",
    dataURL: svgDataUrl(shellSvg(metadata, layout, renderContext)),
    created: now,
    version: CLASSROOM_TIME_SCENE_VERSION,
  };
}

function createAnchor(
  id: string,
  fileId: FileId,
  ownerId: string,
  metadata: ClassroomTimeWidgetMetadataV1,
  layout: LayoutSpec,
  options: ClassroomTimeWidgetCreateOptions,
  now: number,
): ExcalidrawElement {
  const scale = options.scale ?? [1, 1];
  return {
    ...commonElement(
      id,
      "image",
      options.x,
      options.y,
      layout.width,
      layout.height,
      now,
      ownerId,
      options.groupIds ?? [],
      options.frameId ?? null,
      Number.isFinite(options.angle) ? options.angle! : 0,
      customDataFor(metadata),
    ),
    type: "image",
    fileId,
    status: "saved",
    scale: [scale[0] < 0 ? -1 : 1, scale[1] < 0 ? -1 : 1],
    crop: null,
  } as unknown as ExcalidrawElement;
}

export function createClassroomTimeWidgetScene(options: ClassroomTimeWidgetCreateOptions): CreatedClassroomTimeWidget {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) throw new Error("Classroom widget position must be finite.");
  const metadata = validMetadata(options.metadata);
  if (!metadata) throw new Error("Classroom widget metadata is invalid.");
  const createId = options.createId ?? createLocalId;
  const ownerId = metadata.ownerId;
  if (!isClassroomTimeId(ownerId)) throw new Error("Classroom widget owner ID is invalid.");
  const layout = layoutFor(metadata, now, options.renderContext);
  if (layout.parts.length + 1 > MAX_CLASSROOM_TIME_PARTS) throw new Error("Classroom widget has too many parts.");
  const anchorId = createId();
  const fileId = createId() as FileId;
  const anchor = createAnchor(anchorId, fileId, ownerId, metadata, layout, options, now);
  const elements: ExcalidrawElement[] = [anchor];
  for (const spec of layout.parts) elements.push(partElement(spec, anchor, ownerId, layout, createId(), now));
  return {
    anchorId,
    ownerId,
    elements,
    files: [createShellFile(fileId, metadata, layout, now, options.renderContext)],
  };
}

function bumpElement(element: ExcalidrawElement, updates: Record<string, unknown>, now: number): ExcalidrawElement {
  return {
    ...element,
    ...updates,
    version: element.version + 1,
    versionNonce: ((element.versionNonce + 1) | 0) || 1,
    updated: now,
  } as ExcalidrawElement;
}

function samePoints(left: unknown, right: readonly (readonly number[])[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((point, index) => Array.isArray(point)
      && point.length === 2
      && point[0] === right[index][0]
      && point[1] === right[index][1]);
}

function updateDynamicPart(
  element: ExcalidrawElement,
  spec: PartSpec,
  anchor: ExcalidrawElement,
  layout: LayoutSpec,
  now: number,
): ExcalidrawElement {
  if (spec.kind === "text" && element.type === "text") {
    const topLeft = localToAnchor({ x: spec.x, y: spec.y }, anchor, layout.width, layout.height);
    const bottomRight = localToAnchor({ x: spec.x + spec.width, y: spec.y + spec.height }, anchor, layout.width, layout.height);
    const width = Math.max(1, Math.hypot(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y));
    const height = Math.max(1, spec.height / layout.height * anchor.height);
    const center = localToAnchor({ x: spec.x + spec.width / 2, y: spec.y + spec.height / 2 }, anchor, layout.width, layout.height);
    const x = center.x - width / 2;
    const y = center.y - height / 2;
    const fontSize = Math.max(8, spec.fontSize * Math.min(anchor.width / layout.width, anchor.height / layout.height));
    const opacity = Math.round(layout.opacity * 100);
    if (element.text === spec.text
      && element.originalText === spec.text
      && element.x === x
      && element.y === y
      && element.width === width
      && element.height === height
      && element.angle === anchor.angle
      && element.fontSize === fontSize
      && element.strokeColor === spec.color
      && element.opacity === opacity
      && element.textAlign === (spec.align ?? "center")) return element;
    return bumpElement(element, {
      text: spec.text,
      originalText: spec.text,
      x,
      y,
      width,
      height,
      angle: anchor.angle,
      fontSize,
      strokeColor: spec.color,
      opacity,
      textAlign: spec.align ?? "center",
    }, now);
  }
  if ((spec.kind === "line" && element.type === "line") || (spec.kind === "freedraw" && element.type === "freedraw")) {
    const [mirrorX, mirrorY] = anchorScale(anchor);
    const points = spec.points.map((point) => {
      let x = point.x / layout.width * anchor.width;
      let y = point.y / layout.height * anchor.height;
      if (mirrorX < 0) x = anchor.width - x;
      if (mirrorY < 0) y = anchor.height - y;
      return [x, y] as const;
    });
    const strokeWidth = spec.strokeWidth * Math.min(anchor.width / layout.width, anchor.height / layout.height);
    const opacity = Math.round(layout.opacity * 100);
    const geometryMatches = element.x === anchor.x
      && element.y === anchor.y
      && element.width === anchor.width
      && element.height === anchor.height
      && element.angle === anchor.angle
      && element.strokeColor === spec.color
      && element.strokeWidth === strokeWidth
      && element.opacity === opacity
      && samePoints(element.points, points);
    if (geometryMatches) return element;
    const updates = {
      x: anchor.x,
      y: anchor.y,
      width: anchor.width,
      height: anchor.height,
      angle: anchor.angle,
      strokeColor: spec.color,
      strokeWidth,
      opacity,
      points,
    };
    return bumpElement(element, spec.kind === "freedraw"
      ? { ...updates, pressures: points.map(() => 0.5) }
      : updates, now);
  }
  return element;
}

export function tickClassroomTimeWidgets(
  elements: readonly ExcalidrawElement[],
  now = Date.now(),
  renderContext: ClassroomTimeRenderContext = {},
): readonly ExcalidrawElement[] {
  const anchors = new Map<string, { anchor: ExcalidrawElement; metadata: ClassroomTimeWidgetMetadataV1; layout: LayoutSpec }>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const marker = anchorMarkerFor(element);
    if (!marker) continue;
    const metadata = validMetadata(marker.metadata);
    if (!metadata || anchors.size >= MAX_CLASSROOM_TIME_WIDGETS) continue;
    anchors.set(marker.ownerId, { anchor: element, metadata, layout: layoutFor(metadata, now, renderContext) });
  }
  if (!anchors.size) return elements;
  let changed = false;
  const updated = elements.map((element) => {
    if (element.isDeleted) return element;
    const marker = markerFor(element);
    if (!marker || marker.type === "anchor") return element;
    const owner = anchors.get(marker.ownerId);
    if (!owner) return element;
    const spec = owner.layout.parts.find((part) => part.role === marker.role);
    if (!spec) return element;
    const next = updateDynamicPart(element, spec, owner.anchor, owner.layout, now);
    if (next !== element) changed = true;
    return next;
  });
  return changed ? updated : elements;
}

function stripClassroomMarker(element: ExcalidrawElement, ownerId: string, now: number): ExcalidrawElement {
  const customData = { ...(element.customData ?? {}) };
  delete customData.classroomTimeWidget;
  return bumpElement(element, {
    customData: Object.keys(customData).length ? customData : undefined,
    groupIds: element.groupIds.filter((groupId) => groupId !== ownerId),
  }, now);
}

function normalizeOwnedPart(
  element: ExcalidrawElement,
  anchor: ExcalidrawElement,
  ownerId: string,
  role: SceneRole,
  now: number,
): ExcalidrawElement {
  const groupIds = [ownerId, ...anchor.groupIds.filter((groupId) => groupId !== ownerId)];
  const expectedCustomData = customDataFor(childData(ownerId, role));
  const current = markerFor(element);
  const alreadyNormalized = element.frameId === anchor.frameId
    && element.groupIds.length === groupIds.length
    && element.groupIds.every((groupId, index) => groupId === groupIds[index])
    && current?.ownerId === ownerId
    && current.type === "child"
    && current.role === role
    && Object.keys(element.customData ?? {}).length === 1;
  return alreadyNormalized ? element : bumpElement(element, {
    frameId: anchor.frameId,
    groupIds,
    customData: expectedCustomData,
  }, now);
}

function elementKindMatches(element: ExcalidrawElement, spec: PartSpec): boolean {
  return element.type === spec.kind;
}

function fileIsReferenced(elements: readonly ExcalidrawElement[], fileId: FileId): boolean {
  return elements.some((element) => element.type === "image" && element.fileId === fileId);
}

export function reconcileClassroomTimeWidgets(
  elements: readonly ExcalidrawElement[],
  options: ClassroomTimeSceneReconcileOptions = {},
): ReconciledClassroomTimeScene {
  const now = options.now ?? Date.now();
  const createId = options.createId ?? createLocalId;
  const source = [...elements];
  const addedFiles: BinaryFileData[] = [];
  const orphanCandidates: FileId[] = [];
  const repairedOwners = new Set<string>();
  const anchors: Array<{ element: ExcalidrawElement; marker: ClassroomTimeAnchorMarker; metadata: ClassroomTimeWidgetMetadataV1 }> = [];
  const activeOwners = new Set<string>();
  const acceptedAnchorIds = new Set<string>();
  const deletedOwners = new Set<string>();

  for (const element of source) {
    if (!element.isDeleted) continue;
    const marker = anchorMarkerFor(element);
    if (marker) deletedOwners.add(marker.ownerId);
  }

  for (const element of source) {
    const marker = anchorMarkerFor(element);
    if (!marker || element.isDeleted) continue;
    const metadata = validMetadata(marker.metadata);
    if (!metadata || activeOwners.has(marker.ownerId) || anchors.length >= MAX_CLASSROOM_TIME_WIDGETS) continue;
    activeOwners.add(marker.ownerId);
    acceptedAnchorIds.add(element.id);
    anchors.push({ element, marker, metadata });
  }

  let output = source.map((element) => {
    const marker = markerFor(element);
    if (!marker) return element;
    if (deletedOwners.has(marker.ownerId)) {
      if (element.isDeleted) return element;
      repairedOwners.add(marker.ownerId);
      return bumpElement(element, { isDeleted: true }, now);
    }
    if (marker.type === "anchor" && !acceptedAnchorIds.has(element.id)) {
      repairedOwners.add(marker.ownerId);
      return stripClassroomMarker(element, marker.ownerId, now);
    }
    if (activeOwners.has(marker.ownerId) || element.isDeleted) return element;
    repairedOwners.add(marker.ownerId);
    return stripClassroomMarker(element, marker.ownerId, now);
  });

  for (const entry of anchors) {
    const ownerId = entry.marker.ownerId;
    let anchor = output.find((element) => element.id === entry.element.id) ?? entry.element;
    const layout = layoutFor(entry.metadata, now, options.renderContext);
    if (layout.parts.length + 1 > MAX_CLASSROOM_TIME_PARTS) {
      output = output.map((element) => classroomTimeWidgetOwnerId(element) === ownerId
        ? stripClassroomMarker(element, ownerId, now)
        : element);
      repairedOwners.add(ownerId);
      continue;
    }

    const normalizedAnchorGroups = [ownerId, ...anchor.groupIds.filter((groupId) => groupId !== ownerId)];
    if (anchor.groupIds.length !== normalizedAnchorGroups.length
      || anchor.groupIds.some((groupId, index) => groupId !== normalizedAnchorGroups[index])
      || Object.keys(anchor.customData ?? {}).length !== 1) {
      anchor = bumpElement(anchor, {
        groupIds: normalizedAnchorGroups,
        customData: customDataFor(entry.metadata),
      }, now);
      output[output.findIndex((element) => element.id === anchor.id)] = anchor;
      repairedOwners.add(ownerId);
    }

    const desiredShell = svgDataUrl(shellSvg(entry.metadata, layout, options.renderContext));
    if (anchor.type === "image") {
      const currentFile = anchor.fileId ? options.files?.[anchor.fileId] : undefined;
      if (options.files && (!currentFile || currentFile.dataURL !== desiredShell)) {
        const oldFileId = anchor.fileId;
        const fileId = createId() as FileId;
        const file = createShellFile(fileId, entry.metadata, layout, now, options.renderContext);
        addedFiles.push(file);
        anchor = bumpElement(anchor, { fileId, status: "saved" }, now);
        output[output.findIndex((element) => element.id === anchor.id)] = anchor;
        if (oldFileId) orphanCandidates.push(oldFileId);
        repairedOwners.add(ownerId);
      }
    }

    const owned = output.filter((element) => {
      const marker = markerFor(element);
      return marker?.ownerId === ownerId && marker.type === "child" && !element.isDeleted;
    });
    const byRole = new Map<string, ExcalidrawElement[]>();
    for (const element of owned) {
      const marker = markerFor(element);
      if (!marker || marker.type !== "child") continue;
      const role = marker.role;
      const bucket = byRole.get(String(role)) ?? [];
      bucket.push(element);
      byRole.set(String(role), bucket);
    }
    const retained = new Set<string>();
    const desiredRoles = new Set(layout.parts.map((part) => String(part.role)));
    const created: ExcalidrawElement[] = [];
    for (const spec of layout.parts) {
      const matches = byRole.get(String(spec.role)) ?? [];
      const existing = matches.find((element) => !retained.has(element.id) && elementKindMatches(element, spec));
      if (!existing) {
        created.push(partElement(spec, anchor, ownerId, layout, createId(), now));
        repairedOwners.add(ownerId);
        continue;
      }
      retained.add(existing.id);
      const normalized = normalizeOwnedPart(existing, anchor, ownerId, spec.role, now);
      const dynamic = updateDynamicPart(normalized, spec, anchor, layout, now);
      if (dynamic !== existing) {
        output[output.findIndex((element) => element.id === existing.id)] = dynamic;
        repairedOwners.add(ownerId);
      }
    }
    output = output.map((element) => {
      const marker = markerFor(element);
      if (!marker || marker.ownerId !== ownerId || marker.type === "anchor" || element.isDeleted || retained.has(element.id)) return element;
      repairedOwners.add(ownerId);
      if (!desiredRoles.has(String(marker.role))) {
        return bumpElement(element, { isDeleted: true }, now);
      }
      return stripClassroomMarker(element, ownerId, now);
    });
    if (created.length) output.push(...created);
  }

  for (const element of output) {
    if (!element.isDeleted) continue;
    const marker = anchorMarkerFor(element);
    if (!marker) continue;
    output = output.map((candidate) => {
      if (candidate.isDeleted || classroomTimeWidgetOwnerId(candidate) !== marker.ownerId) return candidate;
      repairedOwners.add(marker.ownerId);
      return bumpElement(candidate, { isDeleted: true }, now);
    });
  }

  const orphanedFileIds = orphanCandidates.filter((fileId, index) => (
    orphanCandidates.indexOf(fileId) === index && !fileIsReferenced(output, fileId)
  ));
  return {
    elements: output,
    addedFiles,
    orphanedFileIds,
    repairedOwnerIds: [...repairedOwners],
  };
}

function persistenceEventSortKey(
  event: ClassroomCalendarEventV1,
  today: string,
): readonly [string, string, string, string] {
  return [
    event.date >= today ? "0" : "1",
    event.date >= today ? event.date : `~${event.date}`,
    event.startTime ?? "",
    event.id,
  ];
}

function comparePersistenceEvents(
  left: ClassroomCalendarEventV1,
  right: ClassroomCalendarEventV1,
  today: string,
): number {
  const leftKey = persistenceEventSortKey(left, today);
  const rightKey = persistenceEventSortKey(right, today);
  for (let index = 0; index < leftKey.length; index += 1) {
    const order = leftKey[index].localeCompare(rightKey[index]);
    if (order) return order;
  }
  return 0;
}

function persistenceLocalDateKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function projectOnlyPersistenceRenderContext(
  elements: readonly ExcalidrawElement[],
  projectCalendar: ClassroomProjectCalendarStoreV1 | null | undefined,
  now: number,
): ClassroomTimeRenderContext {
  const labelsByOwner: Record<string, readonly string[]> = {};
  const eventsByOwner: Record<string, readonly ClassroomTimeCalendarEventDisplay[]> = {};
  const project = parseClassroomCalendarStoreV1(projectCalendar, "project");
  const today = persistenceLocalDateKey(now);
  for (const element of elements) {
    if (element.isDeleted) continue;
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")) continue;
    const settings = metadata.calendar;
    const referencedProjectIds = new Set(settings.projectEventIds);
    const events = settings.showProjectEvents && project
      ? project.events.filter((event) => (
        referencedProjectIds.size === 0 || referencedProjectIds.has(event.id)
      ))
      : [];
    const visibleEvents = events
      .slice()
      .sort((left, right) => comparePersistenceEvents(left, right, today))
      .slice(0, 6);
    labelsByOwner[metadata.ownerId] = visibleEvents.map((event) => `${event.date.slice(5)} · ${event.title}`);
    eventsByOwner[metadata.ownerId] = visibleEvents.map((event) => ({
      date: event.date,
      label: event.title,
      ...(event.note ? { note: event.note } : {}),
      color: event.color.toUpperCase(),
    }));
  }
  return {
    boardTheme: "light",
    calendarEventsByOwner: eventsByOwner,
    calendarEventLabelsByOwner: labelsByOwner,
  };
}

function isGeneratedCalendarLabelRole(role: ClassroomTimeWidgetRole): boolean {
  return /^calendar-event-[0-5]$/.test(role)
    || /^dashboard-calendar-day-(?:[0-9]|1[0-3])$/.test(role);
}

function tombstoneTransientCalendarLabels(
  elements: readonly ExcalidrawElement[],
  renderContext: ClassroomTimeRenderContext,
  now: number,
): readonly ExcalidrawElement[] {
  const desiredByOwner = new Map<string, ReadonlyMap<string, PartSpec>>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const marker = anchorMarkerFor(element);
    const metadata = marker ? validMetadata(marker.metadata) : null;
    if (!marker || !metadata || desiredByOwner.has(marker.ownerId)) continue;
    const desired = new Map<string, PartSpec>();
    for (const spec of layoutFor(metadata, now, renderContext).parts) {
      if (isGeneratedCalendarLabelRole(spec.role)) desired.set(String(spec.role), spec);
    }
    desiredByOwner.set(marker.ownerId, desired);
  }

  const retained = new Set<string>();
  let changed = false;
  const prepared = elements.map((element) => {
    const marker = markerFor(element);
    if (!marker || marker.type !== "child" || !isGeneratedCalendarLabelRole(marker.role)) return element;
    const desired = desiredByOwner.get(marker.ownerId)?.get(String(marker.role));
    const key = `${marker.ownerId}\u0000${String(marker.role)}`;
    const canRetain = !element.isDeleted
      && !!desired
      && elementKindMatches(element, desired)
      && !retained.has(key);
    if (canRetain) {
      retained.add(key);
      return element;
    }
    const needsBlanking = element.type === "text"
      && (element.text !== "" || element.originalText !== "");
    if (element.isDeleted && !needsBlanking) return element;
    changed = true;
    return bumpElement(element, {
      isDeleted: true,
      ...(element.type === "text" ? { text: "", originalText: "", strokeColor: "transparent" } : {}),
    }, now);
  });
  return changed ? prepared : elements;
}

function scrubDeletedCalendarLabelText(
  elements: readonly ExcalidrawElement[],
  now: number,
): readonly ExcalidrawElement[] {
  let changed = false;
  const scrubbed = elements.map((element) => {
    if (!element.isDeleted || element.type !== "text") return element;
    const marker = markerFor(element);
    if (!marker
      || marker.type !== "child"
      || !isGeneratedCalendarLabelRole(marker.role)
      || (element.text === "" && element.originalText === "")) return element;
    changed = true;
    return bumpElement(element, { text: "", originalText: "", strokeColor: "transparent" }, now);
  });
  return changed ? scrubbed : elements;
}

/**
 * Produces a canonical project scene containing project-calendar labels only.
 * Device-calendar titles remain a transient live-editor concern and are never
 * serialized by this boundary.
 */
export function canonicalizeClassroomTimeWidgetsForPersistence(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  projectCalendar: ClassroomProjectCalendarStoreV1 | null | undefined,
  now = Date.now(),
  createId: () => string = createLocalId,
): CanonicalizedClassroomTimeWidgetsForPersistence {
  const renderContext = projectOnlyPersistenceRenderContext(elements, projectCalendar, now);
  const prepared = tombstoneTransientCalendarLabels(elements, renderContext, now);
  const reconciled = reconcileClassroomTimeWidgets(prepared, {
    now,
    files,
    createId,
    renderContext,
  });
  const canonicalFiles = { ...files } as BinaryFiles;
  for (const file of reconciled.addedFiles) canonicalFiles[file.id] = file;
  for (const fileId of reconciled.orphanedFileIds) delete canonicalFiles[fileId];
  return {
    elements: scrubDeletedCalendarLabelText(reconciled.elements, now),
    files: canonicalFiles,
  };
}

function remapBindings(element: ExcalidrawElement, idMap: ReadonlyMap<string, string>): ExcalidrawElement {
  if (!idMap.size) return element;
  const mapped = { ...element } as Record<string, unknown>;
  if (element.boundElements) {
    mapped.boundElements = element.boundElements.map((binding) => ({
      ...binding,
      id: idMap.get(binding.id) ?? binding.id,
    }));
  }
  if (element.type === "line" || element.type === "arrow") {
    const linear = element;
    mapped.startBinding = linear.startBinding ? {
      ...linear.startBinding,
      elementId: idMap.get(linear.startBinding.elementId) ?? linear.startBinding.elementId,
    } : null;
    mapped.endBinding = linear.endBinding ? {
      ...linear.endBinding,
      elementId: idMap.get(linear.endBinding.elementId) ?? linear.endBinding.elementId,
    } : null;
  }
  if (element.type === "text" && element.containerId) mapped.containerId = idMap.get(element.containerId) ?? element.containerId;
  return mapped as ExcalidrawElement;
}

interface ForkClassroomTimeWidgetsInternalOptions {
  readonly now: number;
  readonly createId: () => string;
  readonly ownerGroupIdByOwner?: ReadonlyMap<string, string>;
  readonly preserveElementIds?: boolean;
}

function forkClassroomTimeWidgetElements(
  elements: readonly ExcalidrawElement[],
  options: ForkClassroomTimeWidgetsInternalOptions,
): ForkedClassroomTimeWidgets {
  const { createId, now } = options;
  const anchors = new Map<string, ClassroomTimeAnchorMarker>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const marker = anchorMarkerFor(element);
    if (marker && validMetadata(marker.metadata)) anchors.set(marker.ownerId, marker);
  }
  if (!anchors.size) return { elements, ownerIdMap: {}, elementIdMap: {} };
  const ownerMap = new Map<string, string>();
  const elementMap = new Map<string, string>();
  const reservedIds = new Set<string>();
  for (const element of elements) {
    reservedIds.add(element.id);
    element.groupIds.forEach((groupId) => reservedIds.add(groupId));
    const ownerId = classroomTimeWidgetOwnerId(element);
    if (ownerId) reservedIds.add(ownerId);
  }
  for (const ownerId of anchors.keys()) {
    const next = createId();
    if (!isClassroomTimeId(next)) throw new Error("Duplicated classroom widget owner ID is invalid.");
    if (reservedIds.has(next)) throw new Error("Duplicated classroom widget owner ID collides with the scene.");
    reservedIds.add(next);
    ownerMap.set(ownerId, next);
  }
  for (const element of elements) {
    const ownerId = classroomTimeWidgetOwnerId(element);
    if (ownerId && ownerMap.has(ownerId) && !options.preserveElementIds) {
      const next = createId();
      if (!isClassroomTimeId(next)) throw new Error("Duplicated classroom widget element ID is invalid.");
      if (reservedIds.has(next)) throw new Error("Duplicated classroom widget element ID collides with the scene.");
      reservedIds.add(next);
      elementMap.set(element.id, next);
    }
  }
  const forked = elements.map((original) => {
    const marker = markerFor(original);
    if (!marker) return remapBindings(original, elementMap);
    const nextOwnerId = ownerMap.get(marker.ownerId);
    const nextElementId = options.preserveElementIds
      ? original.id
      : elementMap.get(original.id);
    if (!nextOwnerId || !nextElementId) return original;
    const nextMarker = marker.type === "anchor"
      ? sanitizeClassroomTimeWidgetMetadata({
        ...pauseClassroomTimeWidget(marker.metadata, now),
        ownerId: nextOwnerId,
      })
      : childData(nextOwnerId, marker.role);
    const remapped = remapBindings(original, elementMap);
    const ownerGroupId = options.ownerGroupIdByOwner?.get(marker.ownerId) ?? marker.ownerId;
    const updates = {
      groupIds: [
        nextOwnerId,
        ...original.groupIds.filter((groupId) => (
          groupId !== ownerGroupId
          && groupId !== marker.ownerId
          && groupId !== nextOwnerId
        )),
      ],
      customData: customDataFor(nextMarker),
      updated: now,
    };
    if (options.preserveElementIds) return bumpElement(remapped, updates, now);
    return {
      ...remapped,
      ...updates,
      id: nextElementId,
      seed: seedFromId(nextElementId),
      version: 1,
      versionNonce: seedFromId(`${nextElementId}:nonce`),
    } as ExcalidrawElement;
  });
  return {
    elements: forked,
    ownerIdMap: Object.fromEntries(ownerMap),
    elementIdMap: Object.fromEntries(elementMap),
  };
}

export function forkClassroomTimeWidgets(
  elements: readonly ExcalidrawElement[],
  now = Date.now(),
  createId: () => string = createLocalId,
): ForkedClassroomTimeWidgets {
  return forkClassroomTimeWidgetElements(elements, { now, createId });
}

/**
 * Fork widget ownership after Excalidraw has already duplicated a complete
 * element set. Element IDs, binding targets, frame IDs, and all non-widget
 * group IDs are preserved, so the caller's source-to-duplicate element map
 * remains authoritative. Only widget owner metadata and the corresponding
 * duplicated owner group are replaced; running copies are paused at `now`.
 */
export function forkDuplicatedClassroomTimeWidgets(
  duplicatedElements: readonly ExcalidrawElement[],
  options: ForkDuplicatedClassroomTimeWidgetsOptions,
): ForkedClassroomTimeWidgets {
  const now = options.now ?? Date.now();
  const owners = new Set<string>();
  for (const element of duplicatedElements) {
    const marker = anchorMarkerFor(element);
    if (marker && !element.isDeleted) owners.add(marker.ownerId);
  }
  for (const ownerId of owners) {
    const duplicateGroupId = options.sourceToDuplicateGroupIds.get(ownerId);
    if (!duplicateGroupId) {
      throw new Error(`Duplicated classroom widget ${ownerId} has no duplicated owner-group mapping.`);
    }
    for (const element of duplicatedElements) {
      if (classroomTimeWidgetOwnerId(element) !== ownerId || element.isDeleted) continue;
      if (!element.groupIds.includes(duplicateGroupId)) {
        throw new Error(`Duplicated classroom widget ${ownerId} has an invalid owner group.`);
      }
    }
  }
  return forkClassroomTimeWidgetElements(duplicatedElements, {
    now,
    createId: options.createId ?? createLocalId,
    ownerGroupIdByOwner: options.sourceToDuplicateGroupIds,
    preserveElementIds: true,
  });
}

function duplicatedOwnerGroupsForNewElements(
  newElements: readonly ExcalidrawElement[],
  previousElements: readonly ExcalidrawElement[],
): ReadonlyMap<string, string> {
  const sourceAnchors = new Map<string, ExcalidrawElement>();
  for (const element of previousElements) {
    const marker = anchorMarkerFor(element);
    if (marker && !element.isDeleted) sourceAnchors.set(marker.ownerId, element);
  }
  const ownerGroups = new Map<string, string>();
  for (const element of newElements) {
    const marker = anchorMarkerFor(element);
    if (!marker || element.isDeleted) continue;
    const source = sourceAnchors.get(marker.ownerId);
    const sourceOwnerIndex = source?.groupIds.indexOf(marker.ownerId) ?? -1;
    const duplicatedOwnerGroup = sourceOwnerIndex >= 0
      ? element.groupIds[sourceOwnerIndex]
      : element.groupIds[0];
    if (!source && duplicatedOwnerGroup) {
      const completeOwnerGroup = newElements.every((candidate) => {
        const candidateMarker = markerFor(candidate);
        return candidateMarker?.ownerId !== marker.ownerId
          || candidate.isDeleted
          || candidate.groupIds[0] === duplicatedOwnerGroup;
      });
      if (!completeOwnerGroup) continue;
    }
    if (duplicatedOwnerGroup) ownerGroups.set(marker.ownerId, duplicatedOwnerGroup);
  }
  return ownerGroups;
}

/**
 * Excalidraw's `onDuplicate` supplies the complete post-operation scene in
 * `nextElements` and the scene before duplication in `previousElements`.
 * Forking the whole next scene would incorrectly rekey the originals, so this
 * adapter isolates new element IDs, forks only those complete widget groups,
 * and merges them back at their original z-order positions.
 */
export function forkNewClassroomTimeWidgetDuplicates(
  nextElements: readonly ExcalidrawElement[],
  previousElements: readonly ExcalidrawElement[],
  now = Date.now(),
  createId: () => string = createLocalId,
): ForkedClassroomTimeWidgets {
  const previousIds = new Set(previousElements.map((element) => element.id));
  const newElements = nextElements.filter((element) => !previousIds.has(element.id));
  if (!newElements.length) return { elements: nextElements, ownerIdMap: {}, elementIdMap: {} };
  const forked = forkClassroomTimeWidgetElements(newElements, {
    now,
    createId,
    ownerGroupIdByOwner: duplicatedOwnerGroupsForNewElements(newElements, previousElements),
  });
  if (!Object.keys(forked.elementIdMap).length) {
    return { elements: nextElements, ownerIdMap: {}, elementIdMap: {} };
  }
  const forkedByOriginalId = new Map<string, ExcalidrawElement>();
  newElements.forEach((element, index) => {
    const transformed = forked.elements[index];
    if (transformed && transformed !== element) forkedByOriginalId.set(element.id, transformed);
  });
  for (const [originalId, nextId] of Object.entries(forked.elementIdMap)) {
    const transformed = forked.elements.find((candidate) => candidate.id === nextId);
    if (transformed) forkedByOriginalId.set(originalId, transformed);
  }
  return {
    elements: nextElements.map((element) => forkedByOriginalId.get(element.id) ?? element),
    ownerIdMap: forked.ownerIdMap,
    elementIdMap: forked.elementIdMap,
  };
}

export function ungroupClassroomTimeWidget(
  elements: readonly ExcalidrawElement[],
  ownerId: string,
  now = Date.now(),
  renderContext: ClassroomTimeRenderContext = {},
): readonly ExcalidrawElement[] {
  if (!isClassroomTimeId(ownerId)) return elements;
  const materialized = tickClassroomTimeWidgets(elements, now, renderContext);
  let changed = false;
  const ungrouped = materialized.map((element) => {
    if (classroomTimeWidgetOwnerId(element) !== ownerId) return element;
    changed = true;
    return stripClassroomMarker(element, ownerId, now);
  });
  return changed ? ungrouped : elements;
}

export function materializeClassroomTimeWidgetsForExport(
  elements: readonly ExcalidrawElement[],
  capturedAt: number,
  renderContext: ClassroomTimeRenderContext = {},
): readonly ExcalidrawElement[] {
  if (!Number.isFinite(capturedAt)) throw new Error("Classroom widget export timestamp must be finite.");
  return tickClassroomTimeWidgets(elements, capturedAt, renderContext);
}

export function assertClassroomTimeWidgetSceneLimits(elements: readonly ExcalidrawElement[]): void {
  const partsByOwner = new Map<string, number>();
  const anchors = new Set<string>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const marker = markerFor(element);
    if (!marker) continue;
    partsByOwner.set(marker.ownerId, (partsByOwner.get(marker.ownerId) ?? 0) + 1);
    if (marker.type === "anchor") anchors.add(marker.ownerId);
  }
  if (anchors.size > MAX_CLASSROOM_TIME_WIDGETS) throw new Error(`A project can contain at most ${MAX_CLASSROOM_TIME_WIDGETS} classroom time widgets.`);
  for (const [ownerId, count] of partsByOwner) {
    if (count > MAX_CLASSROOM_TIME_PARTS) throw new Error(`Classroom time widget ${ownerId} has too many parts.`);
  }
}
