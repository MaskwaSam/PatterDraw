import {
  DEFAULT_CLASSROOM_ALARM_SETTINGS,
  DEFAULT_CLASSROOM_CALENDAR_SETTINGS,
  DEFAULT_CLASSROOM_CLOCK_SETTINGS,
  DEFAULT_CLASSROOM_POMODORO_SETTINGS,
  DEFAULT_CLASSROOM_TIMER_SETTINGS,
  DEFAULT_CLASSROOM_TIME_APPEARANCE,
  parseClassroomAlarmSettings,
  parseClassroomCalendarSettings,
  parseClassroomClockSettings,
  parseClassroomPomodoroSettings,
  parseClassroomTimeAppearance,
  parseClassroomTimerSettings,
  type ClassroomAlarmSettingsV1,
  type ClassroomCalendarSettingsV1,
  type ClassroomClockSettingsV1,
  type ClassroomDashboardPanelsV1,
  type ClassroomPomodoroSettingsV1,
  type ClassroomTimeAppearanceV1,
  type ClassroomTimerSettingsV1,
} from "./types";

export const CLASSROOM_TIME_PREFERENCES_STORAGE_KEY = "patterdraw:classroom-time-preferences:v1";
const CLASSROOM_TIME_PREFERENCES_EVENT = "patterdraw:classroom-time-preferences-change";
const MAX_CONFLICT_RETRIES = 4;

export interface ClassroomTimePreferencesV1 {
  version: 1;
  appearance: ClassroomTimeAppearanceV1;
  clock: ClassroomClockSettingsV1;
  timer: ClassroomTimerSettingsV1;
  pomodoro: ClassroomPomodoroSettingsV1;
  calendar: ClassroomCalendarSettingsV1;
  dashboardPanels: ClassroomDashboardPanelsV1;
  alarm: ClassroomAlarmSettingsV1;
  masterVolume: number;
  muted: boolean;
}

/**
 * Preference patches are nested patches rather than shallow replacements.
 * Callers may also pass a complete nested object. Only fields which differ
 * from `current` are rebased onto the freshest stored snapshot.
 */
export interface ClassroomTimePreferencesPatch {
  appearance?: Partial<ClassroomTimeAppearanceV1>;
  clock?: Partial<ClassroomClockSettingsV1>;
  timer?: Partial<ClassroomTimerSettingsV1>;
  pomodoro?: Partial<ClassroomPomodoroSettingsV1>;
  calendar?: Partial<Omit<ClassroomCalendarSettingsV1, "projectEventIds" | "transferCache">>;
  dashboardPanels?: Partial<ClassroomDashboardPanelsV1>;
  alarm?: Partial<ClassroomAlarmSettingsV1>;
  masterVolume?: number;
  muted?: boolean;
}

export interface ClassroomTimePreferencesSnapshot {
  preferences: ClassroomTimePreferencesV1;
  /** Monotonically increasing storage revision. Legacy plain-v1 records are revision zero. */
  revision: number;
}

interface ClassroomTimePreferencesStorageEnvelopeV1 {
  version: 1;
  revision: number;
  preferences: ClassroomTimePreferencesV1;
}

export type ClassroomTimePreferencesPersistenceStatus =
  | "persisted"
  | "memory-only"
  | "rolled-back"
  | "indeterminate"
  | "conflict";

export interface ClassroomTimePreferencesWriteResult extends ClassroomTimePreferencesSnapshot {
  status: ClassroomTimePreferencesPersistenceStatus;
  error?: unknown;
}

export type ClassroomTimePreferenceStorage = Pick<Storage, "getItem" | "setItem">
  & Partial<Pick<Storage, "removeItem">>;

const DEFAULT_DASHBOARD_PANELS: Readonly<ClassroomDashboardPanelsV1> = Object.freeze({
  clock: true,
  timer: true,
  pomodoro: true,
  calendar: true,
});

function cloneCalendar(settings: ClassroomCalendarSettingsV1): ClassroomCalendarSettingsV1 {
  return {
    ...settings,
    projectEventIds: [...settings.projectEventIds],
    transferCache: settings.transferCache === null
      ? null
      : {
        ...settings.transferCache,
        events: settings.transferCache.events.map((event) => ({ ...event })),
      },
  };
}

function defaults(): ClassroomTimePreferencesV1 {
  return {
    version: 1,
    appearance: { ...DEFAULT_CLASSROOM_TIME_APPEARANCE },
    clock: { ...DEFAULT_CLASSROOM_CLOCK_SETTINGS },
    timer: { ...DEFAULT_CLASSROOM_TIMER_SETTINGS },
    pomodoro: { ...DEFAULT_CLASSROOM_POMODORO_SETTINGS },
    calendar: cloneCalendar(DEFAULT_CLASSROOM_CALENDAR_SETTINGS),
    dashboardPanels: { ...DEFAULT_DASHBOARD_PANELS },
    alarm: { ...DEFAULT_CLASSROOM_ALARM_SETTINGS },
    masterVolume: 0.7,
    muted: false,
  };
}

export const DEFAULT_CLASSROOM_TIME_PREFERENCES: Readonly<ClassroomTimePreferencesV1> = Object.freeze(defaults());

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseDashboardPanels(value: unknown): ClassroomDashboardPanelsV1 | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.every((key) => ["clock", "timer", "pomodoro", "calendar"].includes(key))) return null;
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

export function normalizeClassroomTimePreferences(value: unknown): ClassroomTimePreferencesV1 {
  const fallback = defaults();
  if (!isRecord(value) || value.version !== 1) return fallback;
  const appearance = parseClassroomTimeAppearance(value.appearance);
  const clock = parseClassroomClockSettings(value.clock);
  const timer = parseClassroomTimerSettings(value.timer);
  const pomodoro = parseClassroomPomodoroSettings(value.pomodoro);
  const calendar = parseClassroomCalendarSettings(value.calendar);
  const dashboardPanels = parseDashboardPanels(value.dashboardPanels);
  const alarm = parseClassroomAlarmSettings(value.alarm);
  return {
    version: 1,
    appearance: appearance ?? fallback.appearance,
    clock: clock ?? fallback.clock,
    timer: timer ?? fallback.timer,
    pomodoro: pomodoro ?? fallback.pomodoro,
    // Project event references and their clipboard transfer cache are project
    // state, never device creation defaults.
    calendar: calendar
      ? cloneCalendar({ ...calendar, projectEventIds: [], transferCache: null })
      : fallback.calendar,
    dashboardPanels: dashboardPanels ?? fallback.dashboardPanels,
    alarm: alarm ?? fallback.alarm,
    masterVolume: typeof value.masterVolume === "number"
      && Number.isFinite(value.masterVolume)
      && value.masterVolume >= 0
      && value.masterVolume <= 1
      ? value.masterVolume
      : fallback.masterVolume,
    muted: typeof value.muted === "boolean" ? value.muted : fallback.muted,
  };
}

function browserStorage(): ClassroomTimePreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

type PreferenceLockKey = ClassroomTimePreferenceStorage;
const inProcessStorageLocks = new WeakMap<PreferenceLockKey, Promise<void>>();

/**
 * Web Locks serialize preference transactions across tabs. The queue fallback
 * provides the same guarantee to custom stores shared in one JS realm. Actual
 * browser localStorage is treated as memory-only when Web Locks are missing,
 * because read/compare/write cannot safely emulate cross-tab CAS.
 */
async function withPreferenceWriteLock<T>(
  storage: ClassroomTimePreferenceStorage,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined"
    && navigator.locks
    && typeof navigator.locks.request === "function") {
    return navigator.locks.request(
      `${CLASSROOM_TIME_PREFERENCES_STORAGE_KEY}:write`,
      { mode: "exclusive" },
      operation,
    );
  }

  const previous = inProcessStorageLocks.get(storage) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  inProcessStorageLocks.set(storage, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (inProcessStorageLocks.get(storage) === tail) inProcessStorageLocks.delete(storage);
  }
}

function browserStorageLacksTransactionalLock(
  storage: ClassroomTimePreferenceStorage,
): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Storage === "undefined" || !(storage instanceof Storage)) return false;
  try {
    const isBrowserLocalStorage = storage === window.localStorage;
    const hasWebLocks = typeof navigator !== "undefined"
      && !!navigator.locks
      && typeof navigator.locks.request === "function";
    return isBrowserLocalStorage && !hasWebLocks;
  } catch {
    return false;
  }
}

function parseStoredValue(raw: string | null): ClassroomTimePreferencesSnapshot {
  if (raw === null) return { preferences: defaults(), revision: 0 };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)
      && parsed.version === 1
      && Number.isSafeInteger(parsed.revision)
      && (parsed.revision as number) >= 0
      && isRecord(parsed.preferences)) {
      return {
        preferences: normalizeClassroomTimePreferences(parsed.preferences),
        revision: parsed.revision as number,
      };
    }
    // Releases before the revision envelope stored ClassroomTimePreferencesV1
    // directly. Treat a valid-looking legacy record as the revision-zero base.
    if (isRecord(parsed) && parsed.version === 1 && "appearance" in parsed) {
      return { preferences: normalizeClassroomTimePreferences(parsed), revision: 0 };
    }
  } catch {
    // Malformed storage recovers to defaults and is repaired by the next write.
  }
  return { preferences: defaults(), revision: 0 };
}

interface RawSnapshot extends ClassroomTimePreferencesSnapshot {
  raw: string | null;
  error?: unknown;
}

function readRawSnapshot(storage: ClassroomTimePreferenceStorage): RawSnapshot {
  try {
    const raw = storage.getItem(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY);
    return { ...parseStoredValue(raw), raw };
  } catch (error) {
    return { preferences: defaults(), revision: 0, raw: null, error };
  }
}

export function readClassroomTimePreferencesSnapshot(
  storage: ClassroomTimePreferenceStorage | null = browserStorage(),
): ClassroomTimePreferencesSnapshot {
  if (!storage) return { preferences: defaults(), revision: 0 };
  const { preferences, revision } = readRawSnapshot(storage);
  return { preferences, revision };
}

export function readClassroomTimePreferences(
  storage: ClassroomTimePreferenceStorage | null = browserStorage(),
): ClassroomTimePreferencesV1 {
  return readClassroomTimePreferencesSnapshot(storage).preferences;
}

function serializeEnvelope(
  preferences: ClassroomTimePreferencesV1,
  revision: number,
): string {
  const envelope: ClassroomTimePreferencesStorageEnvelopeV1 = {
    version: 1,
    revision,
    preferences,
  };
  return JSON.stringify(envelope);
}

function restoreStorageValue(
  storage: ClassroomTimePreferenceStorage,
  previous: string | null,
): void {
  if (previous === null) {
    if (!storage.removeItem) {
      throw new TypeError("Preference storage cannot exactly restore an absent key.");
    }
    storage.removeItem(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY);
  } else {
    storage.setItem(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY, previous);
  }
}

function notify(snapshot: ClassroomTimePreferencesSnapshot): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ClassroomTimePreferencesSnapshot>(CLASSROOM_TIME_PREFERENCES_EVENT, {
    detail: snapshot,
  }));
}

type CasWriteResult =
  | ({ status: "persisted" } & ClassroomTimePreferencesSnapshot)
  | ({ status: "conflict" } & ClassroomTimePreferencesSnapshot)
  | ({ status: "rolled-back"; error: unknown } & ClassroomTimePreferencesSnapshot)
  | ({ status: "indeterminate"; error: unknown } & ClassroomTimePreferencesSnapshot);

function rollbackAfterWriteFailure(
  storage: ClassroomTimePreferenceStorage,
  expected: RawSnapshot,
  error: unknown,
): CasWriteResult {
  try {
    restoreStorageValue(storage, expected.raw);
  } catch {
    // The readback below distinguishes an exact rollback from an uncertain
    // state instead of claiming success for failed compensation.
  }
  const restored = readRawSnapshot(storage);
  if (restored.error === undefined && restored.raw === expected.raw) {
    return {
      preferences: restored.preferences,
      revision: restored.revision,
      status: "rolled-back",
      error,
    };
  }
  return {
    preferences: restored.preferences,
    revision: restored.revision,
    status: "indeterminate",
    error,
  };
}

function casWrite(
  storage: ClassroomTimePreferenceStorage,
  expected: RawSnapshot,
  requested: ClassroomTimePreferencesV1,
): CasWriteResult {
  if (expected.error !== undefined) {
    return {
      preferences: expected.preferences,
      revision: expected.revision,
      status: "rolled-back",
      error: expected.error,
    };
  }
  if (expected.revision >= Number.MAX_SAFE_INTEGER) {
    return {
      preferences: expected.preferences,
      revision: expected.revision,
      status: "rolled-back",
      error: new RangeError("Classroom time preference revision is exhausted."),
    };
  }

  let actualRaw: string | null;
  try {
    actualRaw = storage.getItem(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY);
  } catch (error) {
    return {
      preferences: expected.preferences,
      revision: expected.revision,
      status: "rolled-back",
      error,
    };
  }
  if (actualRaw !== expected.raw) {
    const actual = parseStoredValue(actualRaw);
    return { ...actual, status: "conflict" };
  }

  const nextRevision = expected.revision + 1;
  const nextPreferences = normalizeClassroomTimePreferences(requested);
  const serialized = serializeEnvelope(nextPreferences, nextRevision);
  try {
    storage.setItem(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY, serialized);
  } catch (error) {
    return rollbackAfterWriteFailure(storage, expected, error);
  }

  const verified = readRawSnapshot(storage);
  if (verified.error !== undefined) {
    return rollbackAfterWriteFailure(storage, expected, verified.error);
  }
  if (verified.raw !== serialized) {
    return {
      preferences: verified.preferences,
      revision: verified.revision,
      status: "conflict",
    };
  }
  return { preferences: nextPreferences, revision: nextRevision, status: "persisted" };
}

async function runPreferenceWriteTransaction(
  storage: ClassroomTimePreferenceStorage,
  operation: () => ClassroomTimePreferencesWriteResult | Promise<ClassroomTimePreferencesWriteResult>,
): Promise<ClassroomTimePreferencesWriteResult> {
  try {
    return await withPreferenceWriteLock(storage, operation);
  } catch (error) {
    const current = readClassroomTimePreferencesSnapshot(storage);
    return { ...current, status: "rolled-back", error };
  }
}

/**
 * Replaces the complete preference record only if `expectedRevision` is still
 * current. Callers obtain it from `readClassroomTimePreferencesSnapshot()`.
 */
export async function persistClassroomTimePreferences(
  requested: ClassroomTimePreferencesV1,
  expectedRevision: number,
  storage: ClassroomTimePreferenceStorage | null = browserStorage(),
): Promise<ClassroomTimePreferencesWriteResult> {
  const next = normalizeClassroomTimePreferences(requested);
  if (!storage || browserStorageLacksTransactionalLock(storage)) {
    const snapshot = { preferences: next, revision: 0 };
    notify(snapshot);
    return { ...snapshot, status: "memory-only" };
  }

  const result = await runPreferenceWriteTransaction(storage, () => {
    const current = readRawSnapshot(storage);
    if (current.error !== undefined) {
      return {
        preferences: current.preferences,
        revision: current.revision,
        status: "rolled-back" as const,
        error: current.error,
      };
    }
    if (current.revision !== expectedRevision) {
      return {
        preferences: current.preferences,
        revision: current.revision,
        status: "conflict" as const,
      };
    }
    return casWrite(storage, current, next);
  });
  notify(result);
  return result;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
        && structurallyEqual(left[key], right[key]));
  }
  return false;
}

const NESTED_PREFERENCE_KEYS = [
  "appearance",
  "clock",
  "timer",
  "pomodoro",
  "calendar",
  "dashboardPanels",
  "alarm",
] as const;

type ChangedPreferencePatch = Record<string, unknown>;

function parseNestedPreference(
  key: typeof NESTED_PREFERENCE_KEYS[number],
  value: unknown,
): Record<string, unknown> | null {
  const parsed = key === "appearance"
    ? parseClassroomTimeAppearance(value)
    : key === "clock"
      ? parseClassroomClockSettings(value)
      : key === "timer"
        ? parseClassroomTimerSettings(value)
        : key === "pomodoro"
          ? parseClassroomPomodoroSettings(value)
          : key === "calendar"
            ? parseClassroomCalendarSettings(value)
            : key === "dashboardPanels"
              ? parseDashboardPanels(value)
              : parseClassroomAlarmSettings(value);
  return parsed as unknown as Record<string, unknown> | null;
}

function changedFields(
  current: ClassroomTimePreferencesV1,
  patch: ClassroomTimePreferencesPatch,
): ChangedPreferencePatch {
  const changed: ChangedPreferencePatch = {};
  for (const key of NESTED_PREFERENCE_KEYS) {
    const nestedPatch = patch[key];
    if (!isRecord(nestedPatch)) continue;
    const currentNested = current[key] as unknown as Record<string, unknown>;
    const allowedFields = new Set(Object.keys(currentNested));
    if (key === "calendar") {
      allowedFields.delete("projectEventIds");
      allowedFields.delete("transferCache");
    }
    const supplied = Object.fromEntries(Object.entries(nestedPatch).filter(
      ([field, value]) => allowedFields.has(field) && value !== undefined,
    ));
    if (Object.keys(supplied).length === 0) continue;
    const parsed = parseNestedPreference(key, { ...currentNested, ...supplied });
    if (!parsed) continue;
    const nestedChanges: Record<string, unknown> = {};
    for (const field of Object.keys(supplied)) {
      if (!structurallyEqual(parsed[field], currentNested[field])) {
        nestedChanges[field] = parsed[field];
      }
    }
    if (Object.keys(nestedChanges).length > 0) changed[key] = nestedChanges;
  }
  if (typeof patch.masterVolume === "number"
    && Number.isFinite(patch.masterVolume)
    && patch.masterVolume >= 0
    && patch.masterVolume <= 1
    && !Object.is(patch.masterVolume, current.masterVolume)) {
    changed.masterVolume = patch.masterVolume;
  }
  if (typeof patch.muted === "boolean" && !Object.is(patch.muted, current.muted)) {
    changed.muted = patch.muted;
  }
  return changed;
}

function applyChangedFields(
  freshest: ClassroomTimePreferencesV1,
  changed: ChangedPreferencePatch,
): ClassroomTimePreferencesV1 {
  const candidate: Record<string, unknown> = { ...freshest, version: 1 };
  for (const key of NESTED_PREFERENCE_KEYS) {
    const nestedChanges = changed[key];
    if (!isRecord(nestedChanges)) continue;
    candidate[key] = {
      ...(freshest[key] as unknown as Record<string, unknown>),
      ...nestedChanges,
    };
  }
  if (Object.prototype.hasOwnProperty.call(changed, "masterVolume")) {
    candidate.masterVolume = changed.masterVolume;
  }
  if (Object.prototype.hasOwnProperty.call(changed, "muted")) {
    candidate.muted = changed.muted;
  }
  return normalizeClassroomTimePreferences(candidate);
}

export async function persistClassroomTimePreferencePatch(
  current: ClassroomTimePreferencesV1,
  patch: ClassroomTimePreferencesPatch,
  storage: ClassroomTimePreferenceStorage | null = browserStorage(),
): Promise<ClassroomTimePreferencesWriteResult> {
  const callerState = normalizeClassroomTimePreferences(current);
  const delta = changedFields(callerState, patch);
  if (!storage || browserStorageLacksTransactionalLock(storage)) {
    const snapshot = { preferences: applyChangedFields(callerState, delta), revision: 0 };
    notify(snapshot);
    return { ...snapshot, status: "memory-only" };
  }

  const result = await runPreferenceWriteTransaction(storage, () => {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const freshest = readRawSnapshot(storage);
      if (freshest.error !== undefined) {
        return {
          preferences: freshest.preferences,
          revision: freshest.revision,
          status: "rolled-back" as const,
          error: freshest.error,
        };
      }
      if (Object.keys(delta).length === 0) {
        return {
          preferences: freshest.preferences,
          revision: freshest.revision,
          status: "persisted" as const,
        };
      }
      const requested = applyChangedFields(freshest.preferences, delta);
      const write = casWrite(storage, freshest, requested);
      if (write.status !== "conflict") return write;
    }
    const latest = readClassroomTimePreferencesSnapshot(storage);
    return { ...latest, status: "conflict" as const };
  });
  notify(result);
  return result;
}

export async function restoreDefaultClassroomTimePreferences(
  storage: ClassroomTimePreferenceStorage | null = browserStorage(),
): Promise<ClassroomTimePreferencesWriteResult> {
  if (!storage || browserStorageLacksTransactionalLock(storage)) {
    const snapshot = { preferences: defaults(), revision: 0 };
    notify(snapshot);
    return { ...snapshot, status: "memory-only" };
  }
  const result = await runPreferenceWriteTransaction(storage, () => {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const current = readRawSnapshot(storage);
      if (current.error !== undefined) {
        return {
          preferences: current.preferences,
          revision: current.revision,
          status: "rolled-back" as const,
          error: current.error,
        };
      }
      const write = casWrite(storage, current, defaults());
      if (write.status !== "conflict") return write;
    }
    const latest = readClassroomTimePreferencesSnapshot(storage);
    return { ...latest, status: "conflict" as const };
  });
  notify(result);
  return result;
}

export function subscribeToClassroomTimePreferences(
  listener: (preferences: ClassroomTimePreferencesV1) => void,
  storage: ClassroomTimePreferenceStorage | null = browserStorage(),
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onSameTab = (event: Event) => {
    if (!(event instanceof CustomEvent) || !isRecord(event.detail)) return;
    const detail = event.detail;
    const value = isRecord(detail.preferences) ? detail.preferences : detail;
    listener(normalizeClassroomTimePreferences(value));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLASSROOM_TIME_PREFERENCES_STORAGE_KEY || event.key === null) {
      listener(readClassroomTimePreferences(storage));
    }
  };
  window.addEventListener(CLASSROOM_TIME_PREFERENCES_EVENT, onSameTab);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CLASSROOM_TIME_PREFERENCES_EVENT, onSameTab);
    window.removeEventListener("storage", onStorage);
  };
}
