import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import {
  ALARM_TONES,
  DEFAULT_CLASSROOM_TIME_APPEARANCE,
  createIdlePomodoroRuntime,
  createIdleTimerRuntime,
  sanitizeClassroomTimeWidgetMetadata,
  type ClassroomAlarmSettingsV1,
  type ClassroomAlarmTone,
  type ClassroomCalendarSettingsV1,
  type ClassroomClockSettingsV1,
  type ClassroomPomodoroSettingsV1,
  type ClassroomTimeAppearanceV1,
  type ClassroomTimeWidgetKind,
  type ClassroomTimeWidgetMetadataV1,
  type ClassroomTimerSettingsV1,
} from "../lib/classroom-time/types";
import {
  MAX_CLASSROOM_CALENDAR_NOTE_LENGTH,
  MAX_CLASSROOM_CALENDAR_TITLE_LENGTH,
  type ClassroomCalendarLayer,
} from "../lib/classroom-time/calendar";
import { MAX_CLASSROOM_TIME_LABEL_LENGTH, MAX_TIMER_DURATION_MS } from "../lib/classroom-time/constants";
import {
  resolveClassroomTimeAppearance,
  type ClassroomTimeBoardTheme,
} from "../lib/classroom-time/scene";
import { useModalDialog } from "./useModalDialog";

export interface ClassroomCalendarEventDraft {
  date: string;
  title: string;
  note?: string;
  color: string;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
}

export type ClassroomCalendarEventCreateResult =
  | { status: "created"; projectEventId?: string }
  | { status: "failed"; message?: string };

export interface ClassroomTimeDialogProps {
  metadata: ClassroomTimeWidgetMetadataV1;
  mode?: "insert" | "update";
  alarmMuted: boolean;
  alarmVolume: number;
  projectEventCount?: number;
  deviceEventCount?: number;
  boardTheme?: ClassroomTimeBoardTheme;
  onAlarmPreferencesChange: (preferences: { muted: boolean; volume: number }) => void;
  onCancel: () => void;
  onCreateCalendarEvent: (
    layer: ClassroomCalendarLayer,
    event: ClassroomCalendarEventDraft,
  ) => Promise<ClassroomCalendarEventCreateResult>;
  onRestoreDefaults: (kind: ClassroomTimeWidgetKind) => ClassroomTimeWidgetMetadataV1;
  onSubmit: (metadata: ClassroomTimeWidgetMetadataV1) => void;
  onTestAlarm: (tone: ClassroomAlarmTone) => void;
  onUseAsDefault: (metadata: ClassroomTimeWidgetMetadataV1) => void;
  returnFocusRef?: RefObject<HTMLElement>;
}

type InspectorSection = "appearance" | "clock" | "timer" | "pomodoro" | "calendar" | "alarm" | "dashboard";

const KIND_LABELS: Readonly<Record<ClassroomTimeWidgetKind, string>> = {
  calendar: "Class Calendar",
  clock: "Clock",
  dashboard: "Classroom Dashboard",
  pomodoro: "Pomodoro",
  timer: "Timer",
};

const TONE_LABELS: Readonly<Record<ClassroomAlarmTone, string>> = {
  "bright-marimba": "Bright marimba",
  "gentle-bell": "Gentle bell",
  "warm-chime": "Warm chime",
};

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return 0;
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function classroomTimeContrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function classroomTimeReadabilityWarning(
  appearance: ReturnType<typeof resolveClassroomTimeAppearance>,
  opacity: number,
): string | null {
  const warnings: string[] = [];
  const textContrast = classroomTimeContrastRatio(
    appearance.foregroundColor,
    appearance.backgroundColor,
  );
  const accentContrast = classroomTimeContrastRatio(
    appearance.accentColor,
    appearance.backgroundColor,
  );
  if (textContrast < 4.5) {
    warnings.push(`Text contrast is ${textContrast.toFixed(1)}:1; aim for at least 4.5:1.`);
  }
  if (accentContrast < 4.5) {
    warnings.push(`Accent contrast is ${accentContrast.toFixed(1)}:1; aim for at least 4.5:1.`);
  }
  if (opacity < 0.7) {
    warnings.push("Low opacity can make the widget hard to read over board content.");
  }
  return warnings.length ? warnings.join(" ") : null;
}

export function readableClassroomTimeAppearance(
  current: ClassroomTimeAppearanceV1,
  resolvedTheme: ClassroomTimeBoardTheme,
): ClassroomTimeAppearanceV1 {
  return {
    ...DEFAULT_CLASSROOM_TIME_APPEARANCE,
    foregroundColor: resolvedTheme === "dark" ? "#ffffff" : "#111827",
    backgroundColor: resolvedTheme === "dark" ? "#000000" : "#ffffff",
    accentColor: resolvedTheme === "dark" ? "#bfdbfe" : "#1d4ed8",
    borderColor: resolvedTheme === "dark" ? "#cbd5e1" : "#64748b",
    opacity: 1,
    theme: current.theme,
  };
}

function cloneMetadata(metadata: ClassroomTimeWidgetMetadataV1): ClassroomTimeWidgetMetadataV1 {
  return sanitizeClassroomTimeWidgetMetadata(JSON.parse(JSON.stringify(metadata)));
}

function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function durationFromMinutes(value: number, fallbackMs: number): number {
  if (!Number.isFinite(value)) return fallbackMs;
  return Math.min(MAX_TIMER_DURATION_MS, Math.max(60_000, Math.round(value) * 60_000));
}

export function durationParts(durationMs: number): { hours: number; minutes: number; seconds: number } {
  const totalSeconds = Math.max(1, Math.min(Math.floor(MAX_TIMER_DURATION_MS / 1_000), Math.round(durationMs / 1_000)));
  return {
    hours: Math.floor(totalSeconds / 3_600),
    minutes: Math.floor(totalSeconds % 3_600 / 60),
    seconds: totalSeconds % 60,
  };
}

export function durationFromParts(hours: number, minutes: number, seconds: number): number {
  const boundedHours = clampInteger(hours, 0, 99);
  const boundedMinutes = clampInteger(minutes, 0, 59);
  const boundedSeconds = clampInteger(seconds, 0, 59);
  return Math.max(1_000, Math.min(MAX_TIMER_DURATION_MS, (boundedHours * 3_600 + boundedMinutes * 60 + boundedSeconds) * 1_000));
}

function validTimeZone(value: string | null): boolean {
  if (value === null || value === "") return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function eventSaveFailureMessage(message?: string): string {
  const detail = message?.trim();
  return detail
    ? `${detail} Your draft is still here.`
    : "The event could not be saved. Your draft is still here.";
}

function availableSections(kind: ClassroomTimeWidgetKind): InspectorSection[] {
  const sections: InspectorSection[] = ["appearance"];
  if (kind === "clock" || kind === "dashboard") sections.push("clock");
  if (kind === "timer" || kind === "dashboard") sections.push("timer");
  if (kind === "pomodoro" || kind === "dashboard") sections.push("pomodoro");
  if (kind === "calendar" || kind === "dashboard") sections.push("calendar");
  if (kind === "timer" || kind === "pomodoro" || kind === "dashboard") sections.push("alarm");
  if (kind === "dashboard") sections.push("dashboard");
  return sections;
}

function updateAppearance(
  metadata: ClassroomTimeWidgetMetadataV1,
  appearance: ClassroomTimeAppearanceV1,
): ClassroomTimeWidgetMetadataV1 {
  return { ...metadata, appearance };
}

function updateClock(
  metadata: ClassroomTimeWidgetMetadataV1,
  clock: ClassroomClockSettingsV1,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind !== "clock" && metadata.kind !== "dashboard") return metadata;
  return { ...metadata, clock };
}

function updateTimer(
  metadata: ClassroomTimeWidgetMetadataV1,
  timer: ClassroomTimerSettingsV1,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind === "timer") {
    return { ...metadata, timer, runtime: createIdleTimerRuntime(timer.durationMs) };
  }
  if (metadata.kind === "dashboard") {
    return { ...metadata, timer, timerRuntime: createIdleTimerRuntime(timer.durationMs) };
  }
  return metadata;
}

function updatePomodoro(
  metadata: ClassroomTimeWidgetMetadataV1,
  pomodoro: ClassroomPomodoroSettingsV1,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind === "pomodoro") {
    return { ...metadata, pomodoro, runtime: createIdlePomodoroRuntime(pomodoro) };
  }
  if (metadata.kind === "dashboard") {
    return { ...metadata, pomodoro, pomodoroRuntime: createIdlePomodoroRuntime(pomodoro) };
  }
  return metadata;
}

function updateCalendar(
  metadata: ClassroomTimeWidgetMetadataV1,
  calendar: ClassroomCalendarSettingsV1,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind !== "calendar" && metadata.kind !== "dashboard") return metadata;
  return { ...metadata, calendar };
}

function updateAlarm(
  metadata: ClassroomTimeWidgetMetadataV1,
  alarm: ClassroomAlarmSettingsV1,
): ClassroomTimeWidgetMetadataV1 {
  if (metadata.kind !== "timer" && metadata.kind !== "pomodoro" && metadata.kind !== "dashboard") return metadata;
  return { ...metadata, alarm };
}

function SwitchField({
  checked,
  children,
  onChange,
}: {
  checked: boolean;
  children: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="classroom-time-switch-field">
      <span>{children}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="classroom-time-color-field">
      <span>{label}</span>
      <span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /><code>{value.toUpperCase()}</code></span>
    </label>
  );
}

function DurationFields({ value, onChange }: { value: number; onChange: (durationMs: number) => void }) {
  const parts = durationParts(value);
  const change = (field: "hours" | "minutes" | "seconds", next: number) => {
    onChange(durationFromParts(
      field === "hours" ? next : parts.hours,
      field === "minutes" ? next : parts.minutes,
      field === "seconds" ? next : parts.seconds,
    ));
  };
  return (
    <fieldset className="classroom-time-duration-fields">
      <legend>Duration</legend>
      <label>Hours<input aria-label="Timer hours" type="number" min="0" max="99" value={parts.hours} onChange={(event) => change("hours", event.target.valueAsNumber)} /></label>
      <label>Minutes<input aria-label="Timer minutes" type="number" min="0" max="59" value={parts.minutes} onChange={(event) => change("minutes", event.target.valueAsNumber)} /></label>
      <label>Seconds<input aria-label="Timer seconds" type="number" min="0" max="59" value={parts.seconds} onChange={(event) => change("seconds", event.target.valueAsNumber)} /></label>
    </fieldset>
  );
}

export function ClassroomTimeDialog({
  metadata: initialMetadata,
  mode = "insert",
  alarmMuted,
  alarmVolume,
  projectEventCount = 0,
  deviceEventCount = 0,
  boardTheme = "light",
  onAlarmPreferencesChange,
  onCancel,
  onCreateCalendarEvent,
  onRestoreDefaults,
  onSubmit,
  onTestAlarm,
  onUseAsDefault,
  returnFocusRef,
}: ClassroomTimeDialogProps) {
  const firstControlRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog<HTMLElement>({
    initialFocusRef: firstControlRef,
    onClose: onCancel,
    restoreFocus: true,
    returnFocusRef,
  });
  const [metadata, setMetadata] = useState(() => cloneMetadata(initialMetadata));
  const sections = useMemo(() => availableSections(metadata.kind), [metadata.kind]);
  const [section, setSection] = useState<InspectorSection>(sections[0]);
  const [savedDefault, setSavedDefault] = useState(false);
  const [eventLayer, setEventLayer] = useState<ClassroomCalendarLayer>("project");
  const [eventDate, setEventDate] = useState(localDateInputValue);
  const [eventTitle, setEventTitle] = useState("");
  const [eventNote, setEventNote] = useState("");
  const [eventColor, setEventColor] = useState("#4169e1");
  const [eventAllDay, setEventAllDay] = useState(true);
  const [eventStart, setEventStart] = useState("09:00");
  const [eventEnd, setEventEnd] = useState("10:00");
  const [eventSubmission, setEventSubmission] = useState<{
    status: "error" | "idle" | "pending" | "success";
    message: string;
  }>({ status: "idle", message: "" });
  const eventPendingRef = useRef(false);
  const initialOwnerId = initialMetadata.ownerId;

  useEffect(() => {
    setMetadata(cloneMetadata(initialMetadata));
    setSection(availableSections(initialMetadata.kind)[0]);
  }, [initialOwnerId]);

  const clock = metadata.kind === "clock" || metadata.kind === "dashboard" ? metadata.clock : null;
  const timer = metadata.kind === "timer" || metadata.kind === "dashboard" ? metadata.timer : null;
  const pomodoro = metadata.kind === "pomodoro" || metadata.kind === "dashboard" ? metadata.pomodoro : null;
  const calendar = metadata.kind === "calendar" || metadata.kind === "dashboard" ? metadata.calendar : null;
  const alarm = metadata.kind === "timer" || metadata.kind === "pomodoro" || metadata.kind === "dashboard" ? metadata.alarm : null;
  const previewAppearance = resolveClassroomTimeAppearance(metadata.appearance, boardTheme);
  const readabilityWarning = classroomTimeReadabilityWarning(
    previewAppearance,
    metadata.appearance.opacity,
  );
  const alarmTestUnavailableReason = !alarm?.enabled
    ? "Turn on the alarm before testing it."
    : alarmMuted
      ? "Test alarm is unavailable while classroom alarms are muted on this device."
      : alarmVolume <= 0
        ? "Raise alarm volume above 0% to hear a test."
        : null;
  const timeZoneError = clock && !validTimeZone(clock.timeZone) ? "Enter a valid IANA timezone, such as America/Edmonton." : null;
  const eventError = !eventTitle.trim()
    ? "Add an event title."
    : !eventDate
      ? "Choose an event date."
      : !eventAllDay && (!eventStart || !eventEnd || eventStart >= eventEnd)
        ? "The event end time must be later than its start time."
        : null;

  const createEvent = async () => {
    if (eventError || eventPendingRef.current) return;
    const layer = eventLayer;
    const preservesAllProjectEvents = layer === "project"
      && calendar?.projectEventIds.length === 0;
    const draft: ClassroomCalendarEventDraft = {
      date: eventDate,
      title: eventTitle.trim(),
      ...(eventNote ? { note: eventNote } : {}),
      color: eventColor,
      allDay: eventAllDay,
      ...(eventAllDay ? {} : { startTime: eventStart, endTime: eventEnd }),
    };
    eventPendingRef.current = true;
    setEventSubmission({ status: "pending", message: "Saving event…" });
    try {
      const result = await onCreateCalendarEvent(layer, draft);
      if (result.status === "failed") {
        setEventSubmission({
          status: "error",
          message: eventSaveFailureMessage(result.message),
        });
        return;
      }
      if (layer === "project" && !preservesAllProjectEvents && !result.projectEventId) {
        setEventSubmission({
          status: "error",
          message: "The project event could not be linked to this widget. Your draft is still here.",
        });
        return;
      }
      if (layer === "project" && !preservesAllProjectEvents && result.projectEventId) {
        setMetadata((current) => {
          if (current.kind !== "calendar" && current.kind !== "dashboard") return current;
          const currentCalendar = current.calendar;
          if (currentCalendar.projectEventIds.length === 0
            || currentCalendar.projectEventIds.includes(result.projectEventId!)) return current;
          return updateCalendar(current, {
            ...currentCalendar,
            projectEventIds: [...currentCalendar.projectEventIds, result.projectEventId!],
          });
        });
      }
      setEventTitle("");
      setEventNote("");
      setEventSubmission({
        status: "success",
        message: layer === "project" ? "Event added to this project." : "Event saved on this device.",
      });
    } catch {
      setEventSubmission({
        status: "error",
        message: "The event could not be saved. Your draft is still here.",
      });
    } finally {
      eventPendingRef.current = false;
    }
  };

  return (
    <div className="classroom-time-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        ref={dialogRef}
        className="classroom-time-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="classroom-time-dialog-title"
        aria-describedby="classroom-time-dialog-help"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="classroom-time-dialog-heading">
          <div>
            <span>Experimental Math Tools · Classroom</span>
            <h2 id="classroom-time-dialog-title">{mode === "update" ? "Customize" : "Add"} {KIND_LABELS[metadata.kind]}</h2>
            <p id="classroom-time-dialog-help">Widgets and project events are saved in this PatterDraw project. Alarm sound and new-widget defaults stay on this device; device events are not added to project files.</p>
          </div>
          <button type="button" aria-label="Close classroom time settings" onClick={onCancel}>×</button>
        </header>

        <div
          className="classroom-time-dialog-preview"
          data-theme={previewAppearance.theme}
          style={{
            background: previewAppearance.backgroundColor,
            borderColor: previewAppearance.borderColor,
            color: previewAppearance.foregroundColor,
            opacity: metadata.appearance.opacity,
          }}
        >
          <span style={{ color: previewAppearance.accentColor }}>{KIND_LABELS[metadata.kind]}</span>
          <strong>{metadata.label || "Ready for class"}</strong>
          <small>Live on the board · controls stay in the editor</small>
        </div>
        {readabilityWarning ? (
          <div className="classroom-time-field-error" role="alert">
            <span>{readabilityWarning}</span>{" "}
            <button
              type="button"
              className="classroom-time-secondary-button"
              onClick={() => setMetadata(updateAppearance(
                metadata,
                readableClassroomTimeAppearance(metadata.appearance, previewAppearance.theme),
              ))}
            >Use readable colours</button>
          </div>
        ) : null}

        <nav className="classroom-time-dialog-tabs" aria-label="Widget settings">
          {sections.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-current={section === candidate ? "page" : undefined}
              onClick={() => setSection(candidate)}
            >{candidate[0].toUpperCase() + candidate.slice(1)}</button>
          ))}
        </nav>

        <div className="classroom-time-dialog-body">
          {section === "appearance" ? (
            <div className="classroom-time-settings-section" data-testid="classroom-time-appearance-settings">
              <h3>Appearance</h3>
              <label>Widget label<input ref={firstControlRef} type="text" maxLength={MAX_CLASSROOM_TIME_LABEL_LENGTH} value={metadata.label} onChange={(event) => setMetadata({ ...metadata, label: event.target.value })} /></label>
              <div className="classroom-time-colour-grid">
                <ColorField label="Foreground" value={metadata.appearance.foregroundColor} onChange={(foregroundColor) => setMetadata(updateAppearance(metadata, { ...metadata.appearance, foregroundColor }))} />
                <ColorField label="Background" value={metadata.appearance.backgroundColor} onChange={(backgroundColor) => setMetadata(updateAppearance(metadata, { ...metadata.appearance, backgroundColor }))} />
                <ColorField label="Accent" value={metadata.appearance.accentColor} onChange={(accentColor) => setMetadata(updateAppearance(metadata, { ...metadata.appearance, accentColor }))} />
                <ColorField label="Border" value={metadata.appearance.borderColor} onChange={(borderColor) => setMetadata(updateAppearance(metadata, { ...metadata.appearance, borderColor }))} />
              </div>
              <label>Theme<select value={metadata.appearance.theme} onChange={(event) => setMetadata(updateAppearance(metadata, { ...metadata.appearance, theme: event.target.value as ClassroomTimeAppearanceV1["theme"] }))}><option value="auto">Follow board</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
              <label>Opacity <output>{Math.round(metadata.appearance.opacity * 100)}%</output><input type="range" min="0.1" max="1" step="0.05" value={metadata.appearance.opacity} onChange={(event) => setMetadata(updateAppearance(metadata, { ...metadata.appearance, opacity: event.target.valueAsNumber }))} /></label>
            </div>
          ) : null}

          {section === "clock" && clock ? (
            <div className="classroom-time-settings-section">
              <h3>Clock</h3>
              <p className="classroom-time-quiet-help">Digital display</p>
              <label>Time format<select value={clock.hourCycle} onChange={(event) => setMetadata(updateClock(metadata, { ...clock, hourCycle: Number(event.target.value) as 12 | 24 }))}><option value="12">12-hour</option><option value="24">24-hour</option></select></label>
              <SwitchField checked={clock.showSeconds} onChange={(showSeconds) => setMetadata(updateClock(metadata, { ...clock, showSeconds }))}>Show seconds</SwitchField>
              <SwitchField checked={clock.showDate} onChange={(showDate) => setMetadata(updateClock(metadata, { ...clock, showDate }))}>Show date</SwitchField>
              <SwitchField checked={clock.showWeekday} onChange={(showWeekday) => setMetadata(updateClock(metadata, { ...clock, showWeekday }))}>Show weekday</SwitchField>
              <SwitchField checked={clock.showTimezone} onChange={(showTimezone) => setMetadata(updateClock(metadata, { ...clock, showTimezone }))}>Show timezone label</SwitchField>
              <label>Timezone<input type="text" placeholder="Local time" value={clock.timeZone ?? ""} aria-invalid={!!timeZoneError} onChange={(event) => setMetadata(updateClock(metadata, { ...clock, timeZone: event.target.value || null }))} /></label>
              {timeZoneError ? <p className="classroom-time-field-error" role="alert">{timeZoneError}</p> : null}
            </div>
          ) : null}

          {section === "timer" && timer ? (
            <div className="classroom-time-settings-section">
              <h3>Timer</h3>
              <DurationFields value={timer.durationMs} onChange={(durationMs) => setMetadata(updateTimer(metadata, { ...timer, durationMs }))} />
              <p className="classroom-time-quiet-help">Countdown shown as time remaining.</p>
            </div>
          ) : null}

          {section === "pomodoro" && pomodoro ? (
            <div className="classroom-time-settings-section">
              <h3>Pomodoro</h3>
              <div className="classroom-time-number-grid">
                <label>Focus minutes<input type="number" min="1" max="5999" value={Math.round(pomodoro.focusDurationMs / 60_000)} onChange={(event) => setMetadata(updatePomodoro(metadata, { ...pomodoro, focusDurationMs: durationFromMinutes(event.target.valueAsNumber, pomodoro.focusDurationMs) }))} /></label>
                <label>Short break<input type="number" min="1" max="5999" value={Math.round(pomodoro.shortBreakDurationMs / 60_000)} onChange={(event) => setMetadata(updatePomodoro(metadata, { ...pomodoro, shortBreakDurationMs: durationFromMinutes(event.target.valueAsNumber, pomodoro.shortBreakDurationMs) }))} /></label>
                <label>Long break<input type="number" min="1" max="5999" value={Math.round(pomodoro.longBreakDurationMs / 60_000)} onChange={(event) => setMetadata(updatePomodoro(metadata, { ...pomodoro, longBreakDurationMs: durationFromMinutes(event.target.valueAsNumber, pomodoro.longBreakDurationMs) }))} /></label>
                <label>Sessions per cycle<input type="number" min="1" max="12" value={pomodoro.cyclesBeforeLongBreak} onChange={(event) => setMetadata(updatePomodoro(metadata, { ...pomodoro, cyclesBeforeLongBreak: clampInteger(event.target.valueAsNumber, 1, 12) }))} /></label>
              </div>
              <p className="classroom-time-quiet-help">Countdown shown as time remaining.</p>
              <SwitchField checked={pomodoro.autoStartFocus} onChange={(autoStartFocus) => setMetadata(updatePomodoro(metadata, { ...pomodoro, autoStartFocus }))}>Auto-start focus sessions</SwitchField>
              <SwitchField checked={pomodoro.autoStartBreaks} onChange={(autoStartBreaks) => setMetadata(updatePomodoro(metadata, { ...pomodoro, autoStartBreaks }))}>Auto-start breaks</SwitchField>
            </div>
          ) : null}

          {section === "calendar" && calendar ? (
            <div className="classroom-time-settings-section">
              <h3>Class Calendar</h3>
              <label>View<select value={calendar.view} onChange={(event) => setMetadata(updateCalendar(metadata, { ...calendar, view: event.target.value as ClassroomCalendarSettingsV1["view"] }))}><option value="month">Month</option><option value="week">Week</option><option value="agenda">Agenda</option></select></label>
              <SwitchField checked={calendar.showProjectEvents} onChange={(showProjectEvents) => setMetadata(updateCalendar(metadata, { ...calendar, showProjectEvents }))}>Project events ({projectEventCount})</SwitchField>
              <SwitchField checked={calendar.showDeviceEvents} onChange={(showDeviceEvents) => setMetadata(updateCalendar(metadata, { ...calendar, showDeviceEvents }))}>Device events ({deviceEventCount})</SwitchField>
              <SwitchField checked={calendar.showWeekends} onChange={(showWeekends) => setMetadata(updateCalendar(metadata, { ...calendar, showWeekends }))}>Show weekends</SwitchField>
              <SwitchField checked={calendar.showWeekNumbers} onChange={(showWeekNumbers) => setMetadata(updateCalendar(metadata, { ...calendar, showWeekNumbers }))}>Show week numbers</SwitchField>
              <SwitchField checked={calendar.highlightToday} onChange={(highlightToday) => setMetadata(updateCalendar(metadata, { ...calendar, highlightToday }))}>Highlight today</SwitchField>
              <SwitchField checked={calendar.density === "compact"} onChange={(compact) => setMetadata(updateCalendar(metadata, { ...calendar, density: compact ? "compact" : "comfortable" }))}>Compact event layout</SwitchField>

              <fieldset
                className="classroom-time-event-form"
                disabled={eventSubmission.status === "pending"}
                aria-busy={eventSubmission.status === "pending"}
              >
                <legend>Add an event</legend>
                <label>Save to<select value={eventLayer} onChange={(event) => setEventLayer(event.target.value as ClassroomCalendarLayer)}><option value="project">This project</option><option value="device">This device</option></select></label>
                <label>Date<input type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} /></label>
                <label>Title<input type="text" maxLength={MAX_CLASSROOM_CALENDAR_TITLE_LENGTH} value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} /></label>
                <label>Optional note<textarea maxLength={MAX_CLASSROOM_CALENDAR_NOTE_LENGTH} rows={3} value={eventNote} onChange={(event) => setEventNote(event.target.value)} /></label>
                <ColorField label="Event colour" value={eventColor} onChange={setEventColor} />
                <SwitchField checked={eventAllDay} onChange={setEventAllDay}>All-day event</SwitchField>
                {!eventAllDay ? <div className="classroom-time-number-grid"><label>Starts<input type="time" value={eventStart} onChange={(event) => setEventStart(event.target.value)} /></label><label>Ends<input type="time" value={eventEnd} onChange={(event) => setEventEnd(event.target.value)} /></label></div> : null}
                {eventTitle && eventError ? <p className="classroom-time-field-error" role="alert">{eventError}</p> : null}
                {eventSubmission.status !== "idle" ? (
                  <p
                    className={eventSubmission.status === "error" ? "classroom-time-field-error" : "classroom-time-event-status"}
                    role={eventSubmission.status === "error" ? "alert" : "status"}
                  >{eventSubmission.message}</p>
                ) : null}
                <button
                  type="button"
                  className="classroom-time-secondary-button"
                  disabled={!!eventError || eventSubmission.status === "pending"}
                  onClick={() => void createEvent()}
                >{eventSubmission.status === "pending" ? "Saving event…" : "Add event"}</button>
              </fieldset>
            </div>
          ) : null}

          {section === "alarm" && alarm ? (
            <div className="classroom-time-settings-section">
              <h3>Alarm</h3>
              <SwitchField checked={alarm.enabled} onChange={(enabled) => setMetadata(updateAlarm(metadata, { ...alarm, enabled }))}>Play an alarm when time is up</SwitchField>
              <label>Tone<select value={alarm.tone} onChange={(event) => setMetadata(updateAlarm(metadata, { ...alarm, tone: event.target.value as ClassroomAlarmTone }))}>{ALARM_TONES.map((tone) => <option key={tone} value={tone}>{TONE_LABELS[tone]}</option>)}</select></label>
              <SwitchField checked={alarm.repeat} onChange={(repeat) => setMetadata(updateAlarm(metadata, { ...alarm, repeat }))}>Repeat every 10 seconds for one minute</SwitchField>
              <SwitchField checked={alarmMuted} onChange={(muted) => onAlarmPreferencesChange({ muted, volume: alarmVolume })}>Mute all classroom alarms on this device</SwitchField>
              <label>Alarm volume <output>{Math.round(alarmVolume * 100)}%</output><input type="range" min="0" max="1" step="0.05" value={alarmVolume} onChange={(event) => onAlarmPreferencesChange({ muted: alarmMuted, volume: event.target.valueAsNumber })} /></label>
              <button
                type="button"
                className="classroom-time-secondary-button"
                disabled={!!alarmTestUnavailableReason}
                aria-describedby={alarmTestUnavailableReason ? "classroom-time-alarm-test-help" : undefined}
                title={alarmTestUnavailableReason ?? "Play the selected alarm tone"}
                onClick={() => onTestAlarm(alarm.tone)}
              >Test alarm</button>
              {alarmTestUnavailableReason ? (
                <p id="classroom-time-alarm-test-help" className="classroom-time-quiet-help" role="status" aria-live="polite">
                  {alarmTestUnavailableReason}
                </p>
              ) : null}
              <p className="classroom-time-quiet-help">Sounds are bundled locally. PatterDraw does not request browser notifications.</p>
            </div>
          ) : null}

          {section === "dashboard" && metadata.kind === "dashboard" ? (
            <div className="classroom-time-settings-section">
              <h3>Dashboard panels</h3>
              <SwitchField checked={metadata.panels.clock} onChange={(clockPanel) => setMetadata({ ...metadata, panels: { ...metadata.panels, clock: clockPanel } })}>Clock</SwitchField>
              <SwitchField checked={metadata.panels.timer} onChange={(timerPanel) => setMetadata({ ...metadata, panels: { ...metadata.panels, timer: timerPanel } })}>Timer</SwitchField>
              <SwitchField checked={metadata.panels.pomodoro} onChange={(pomodoroPanel) => setMetadata({ ...metadata, panels: { ...metadata.panels, pomodoro: pomodoroPanel } })}>Pomodoro</SwitchField>
              <SwitchField checked={metadata.panels.calendar} onChange={(calendarPanel) => setMetadata({ ...metadata, panels: { ...metadata.panels, calendar: calendarPanel } })}>Calendar</SwitchField>
              {!Object.values(metadata.panels).some(Boolean) ? <p className="classroom-time-field-error" role="alert">Keep at least one dashboard panel on.</p> : null}
            </div>
          ) : null}
        </div>

        <footer className="classroom-time-dialog-actions">
          <span role="status" aria-live="polite">{savedDefault ? "Saved as the default for new widgets." : ""}</span>
          <button type="button" onClick={() => {
            const restored = onRestoreDefaults(metadata.kind);
            setMetadata(cloneMetadata(restored));
            setSavedDefault(false);
          }}>Restore defaults</button>
          <button type="button" onClick={() => {
            onUseAsDefault(metadata);
            setSavedDefault(true);
          }}>Use as default</button>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="is-primary"
            disabled={!!timeZoneError || (metadata.kind === "dashboard" && !Object.values(metadata.panels).some(Boolean))}
            onClick={() => onSubmit(metadata)}
          >{mode === "update" ? "Save changes" : `Add ${KIND_LABELS[metadata.kind]}`}</button>
        </footer>
      </section>
    </div>
  );
}
