import {
  CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY,
  createClassroomCalendarStoreV1,
  filterClassroomCalendarStoreV1,
  isClassroomCalendarEventV1,
  isClassroomCalendarStoreV1,
  MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER,
  type ClassroomCalendarEventV1,
  type ClassroomCalendarStoreV1,
  type ClassroomDeviceCalendarStoreV1,
} from "./calendar";

const CLASSROOM_CALENDAR_DEVICE_EVENT = "patterdraw:classroom-calendar-change";
const CLASSROOM_CALENDAR_DEVICE_WRITE_LOCK = `${CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY}:write`;
const MAX_CONFLICT_RETRIES = 3;

export type ClassroomCalendarStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ClassroomCalendarPersistenceStatus =
  | "persisted"
  | "memory-only"
  | "rolled-back"
  | "indeterminate"
  | "conflicted";

export interface ClassroomCalendarWriteResult {
  store: ClassroomDeviceCalendarStoreV1;
  revision: number;
  status: ClassroomCalendarPersistenceStatus;
  error?: unknown;
}

export interface ClassroomDeviceCalendarSnapshotV1 {
  revision: number;
  store: ClassroomDeviceCalendarStoreV1;
}

interface ClassroomDeviceCalendarStorageRecordV1 {
  version: 1;
  revision: number;
  store: ClassroomDeviceCalendarStoreV1;
}

interface RawClassroomDeviceCalendarSnapshotV1 extends ClassroomDeviceCalendarSnapshotV1 {
  raw: string | null;
  error?: unknown;
}

type CalendarStorageLockKey = ClassroomCalendarStorage;
const inProcessStorageLocks = new WeakMap<CalendarStorageLockKey, Promise<void>>();

function browserStorage(): ClassroomCalendarStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isBrowserLocalStorage(storage: ClassroomCalendarStorage): boolean {
  if (typeof window === "undefined") return false;
  try {
    return storage === window.localStorage;
  } catch {
    return false;
  }
}

function browserStorageLacksTransactionalLock(storage: ClassroomCalendarStorage): boolean {
  return isBrowserLocalStorage(storage)
    && (typeof navigator === "undefined"
      || !navigator.locks
      || typeof navigator.locks.request !== "function");
}

/**
 * Actual localStorage writes are serialized across tabs with Web Locks. The
 * queue fallback is intentionally limited to injected storage objects, where
 * every writer lives in this JavaScript realm. A browser localStorage object
 * without Web Locks is rejected by the public write functions as memory-only:
 * an in-realm queue cannot make its read/compare/write sequence cross-tab safe.
 */
async function withCalendarWriteLock<T>(
  storage: ClassroomCalendarStorage,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (isBrowserLocalStorage(storage)) {
    return navigator.locks.request(
      CLASSROOM_CALENDAR_DEVICE_WRITE_LOCK,
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

function emptyStore(): ClassroomDeviceCalendarStoreV1 {
  return createClassroomCalendarStoreV1("device");
}

function parseStorageRecord(value: unknown): ClassroomDeviceCalendarStorageRecordV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3
    || !Object.keys(record).every((key) => ["version", "revision", "store"].includes(key))
    || record.version !== 1
    || typeof record.revision !== "number"
    || !Number.isSafeInteger(record.revision)
    || record.revision < 0
    || !isClassroomCalendarStoreV1(record.store, "device")) return null;
  return {
    version: 1,
    revision: record.revision,
    store: createClassroomCalendarStoreV1("device", record.store.events),
  };
}

function parseStoredValue(raw: string | null): ClassroomDeviceCalendarSnapshotV1 {
  if (raw === null) return { revision: 0, store: emptyStore() };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = parseStorageRecord(parsed);
    if (record) return { revision: record.revision, store: record.store };
    // A correctly shaped envelope may contain a mixture of valid and invalid
    // events. Preserve its monotonic revision while filtering only the bad
    // entries, just as legacy plain-v1 recovery does below.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = parsed as Record<string, unknown>;
      if (Object.keys(candidate).length === 3
        && Object.keys(candidate).every((key) => ["version", "revision", "store"].includes(key))
        && candidate.version === 1
        && typeof candidate.revision === "number"
        && Number.isSafeInteger(candidate.revision)
        && candidate.revision >= 0) {
        const recoveredEnvelopeStore = filterClassroomCalendarStoreV1(candidate.store, "device");
        if (recoveredEnvelopeStore) {
          return { revision: candidate.revision, store: recoveredEnvelopeStore };
        }
      }
    }
    // Releases before the revision envelope stored the plain-v1 device store.
    const recovered = filterClassroomCalendarStoreV1(parsed, "device");
    return { revision: 0, store: recovered ?? emptyStore() };
  } catch {
    return { revision: 0, store: emptyStore() };
  }
}

function readRawSnapshot(storage: ClassroomCalendarStorage): RawClassroomDeviceCalendarSnapshotV1 {
  try {
    const raw = storage.getItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY);
    return { ...parseStoredValue(raw), raw };
  } catch (error) {
    return { revision: 0, store: emptyStore(), raw: null, error };
  }
}

export function readDeviceClassroomCalendarSnapshot(
  storage: ClassroomCalendarStorage | null = browserStorage(),
): ClassroomDeviceCalendarSnapshotV1 {
  if (!storage) return { revision: 0, store: emptyStore() };
  const { revision, store } = readRawSnapshot(storage);
  return { revision, store };
}

export function readDeviceClassroomCalendar(
  storage: ClassroomCalendarStorage | null = browserStorage(),
): ClassroomDeviceCalendarStoreV1 {
  return readDeviceClassroomCalendarSnapshot(storage).store;
}

function notify(store: ClassroomDeviceCalendarStoreV1): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ClassroomDeviceCalendarStoreV1>(CLASSROOM_CALENDAR_DEVICE_EVENT, {
    detail: store,
  }));
}

function serializeStorageRecord(
  store: ClassroomDeviceCalendarStoreV1,
  revision: number,
): string {
  const record: ClassroomDeviceCalendarStorageRecordV1 = { version: 1, revision, store };
  return JSON.stringify(record);
}

function restoreStorageValue(
  storage: ClassroomCalendarStorage,
  previous: string | null,
): void {
  if (previous === null) {
    storage.removeItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY);
  } else {
    storage.setItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY, previous);
  }
}

function rolledBackResult(
  storage: ClassroomCalendarStorage,
  expected: RawClassroomDeviceCalendarSnapshotV1,
  error: unknown,
): ClassroomCalendarWriteResult {
  try {
    restoreStorageValue(storage, expected.raw);
  } catch {
    // Best effort only. The read-back remains authoritative even when an
    // injected storage cannot compensate a write which mutated then threw.
  }
  const restored = readRawSnapshot(storage);
  const didRestore = restored.error === undefined && restored.raw === expected.raw;
  return {
    store: restored.store,
    revision: restored.revision,
    status: didRestore ? "rolled-back" : "indeterminate",
    error,
  };
}

function casWrite(
  storage: ClassroomCalendarStorage,
  expected: RawClassroomDeviceCalendarSnapshotV1,
  requested: ClassroomDeviceCalendarStoreV1,
): ClassroomCalendarWriteResult {
  if (expected.error !== undefined) {
    return {
      store: expected.store,
      revision: expected.revision,
      status: "rolled-back",
      error: expected.error,
    };
  }
  if (expected.revision >= Number.MAX_SAFE_INTEGER) {
    return {
      store: expected.store,
      revision: expected.revision,
      status: "rolled-back",
      error: new RangeError("Device classroom calendar revision is exhausted."),
    };
  }

  let actualRaw: string | null;
  try {
    actualRaw = storage.getItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY);
  } catch (error) {
    return {
      store: expected.store,
      revision: expected.revision,
      status: "rolled-back",
      error,
    };
  }
  if (actualRaw !== expected.raw) {
    const actual = parseStoredValue(actualRaw);
    return { ...actual, status: "conflicted" };
  }

  const revision = expected.revision + 1;
  const store = createClassroomCalendarStoreV1("device", requested.events);
  const serialized = serializeStorageRecord(store, revision);
  try {
    storage.setItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY, serialized);
  } catch (error) {
    return rolledBackResult(storage, expected, error);
  }

  const verified = readRawSnapshot(storage);
  if (verified.error !== undefined) {
    return rolledBackResult(storage, expected, verified.error);
  }
  if (verified.raw !== serialized) {
    return { store: verified.store, revision: verified.revision, status: "conflicted" };
  }
  return { store, revision, status: "persisted" };
}

async function runCalendarWriteTransaction(
  storage: ClassroomCalendarStorage,
  operation: () => ClassroomCalendarWriteResult | Promise<ClassroomCalendarWriteResult>,
): Promise<ClassroomCalendarWriteResult> {
  try {
    return await withCalendarWriteLock(storage, operation);
  } catch (error) {
    const current = readDeviceClassroomCalendarSnapshot(storage);
    return { ...current, status: "rolled-back", error };
  }
}

export async function persistDeviceClassroomCalendar(
  requested: ClassroomDeviceCalendarStoreV1,
  storage: ClassroomCalendarStorage | null,
  expectedRevision: number,
): Promise<ClassroomCalendarWriteResult> {
  if (!isClassroomCalendarStoreV1(requested, "device")) {
    throw new TypeError("Device classroom calendar is invalid.");
  }
  const store = createClassroomCalendarStoreV1("device", requested.events);
  if (!storage || browserStorageLacksTransactionalLock(storage)) {
    // No durable compare/write occurred, so do not fabricate a new storage
    // revision or notify subscribers. Callers must treat memory-only as
    // unsaved diagnostic state, while the authoritative UI remains unchanged.
    return { store, revision: expectedRevision, status: "memory-only" };
  }

  const result = await runCalendarWriteTransaction(storage, () => {
    const current = readRawSnapshot(storage);
    if (current.error !== undefined) {
      return {
        store: current.store,
        revision: current.revision,
        status: "rolled-back" as const,
        error: current.error,
      };
    }
    if (current.revision !== expectedRevision) {
      return { store: current.store, revision: current.revision, status: "conflicted" as const };
    }
    return casWrite(storage, current, store);
  });
  notify(result.store);
  return result;
}

export async function mutateDeviceClassroomCalendar(
  mutate: (store: ClassroomDeviceCalendarStoreV1) => ClassroomDeviceCalendarStoreV1,
  storage: ClassroomCalendarStorage | null = browserStorage(),
  attempts = MAX_CONFLICT_RETRIES,
): Promise<ClassroomCalendarWriteResult> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("Device classroom calendar writes require at least one attempt.");
  }

  if (!storage || browserStorageLacksTransactionalLock(storage)) {
    const current = readDeviceClassroomCalendarSnapshot(storage);
    const requested = mutate(createClassroomCalendarStoreV1("device", current.store.events));
    if (!isClassroomCalendarStoreV1(requested, "device")) {
      throw new TypeError("Device classroom calendar mutation returned an invalid store.");
    }
    const store = createClassroomCalendarStoreV1("device", requested.events);
    return { store, revision: current.revision, status: "memory-only" };
  }

  const result = await runCalendarWriteTransaction(storage, () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = readRawSnapshot(storage);
      if (current.error !== undefined) {
        return {
          store: current.store,
          revision: current.revision,
          status: "rolled-back" as const,
          error: current.error,
        };
      }
      const requested = mutate(createClassroomCalendarStoreV1("device", current.store.events));
      if (!isClassroomCalendarStoreV1(requested, "device")) {
        throw new TypeError("Device classroom calendar mutation returned an invalid store.");
      }
      const write = casWrite(storage, current, requested);
      if (write.status !== "conflicted") return write;
    }
    const latest = readDeviceClassroomCalendarSnapshot(storage);
    return { ...latest, status: "conflicted" as const };
  });
  notify(result.store);
  return result;
}

export function upsertClassroomCalendarEvent<Layer extends "device" | "project">(
  store: ClassroomCalendarStoreV1<Layer>,
  event: ClassroomCalendarEventV1,
): ClassroomCalendarStoreV1<Layer> {
  if (!isClassroomCalendarStoreV1(store, store.layer) || !isClassroomCalendarEventV1(event)) {
    throw new TypeError("Classroom calendar store or event is invalid.");
  }
  const index = store.events.findIndex((candidate) => candidate.id === event.id);
  if (index < 0 && store.events.length >= MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER) {
    throw new RangeError("Classroom calendar has reached the 500-event limit.");
  }
  const events = store.events.map((candidate) => ({ ...candidate }));
  if (index < 0) events.push({ ...event });
  else events[index] = { ...event };
  return createClassroomCalendarStoreV1(store.layer, events);
}

export function removeClassroomCalendarEvent<Layer extends "device" | "project">(
  store: ClassroomCalendarStoreV1<Layer>,
  eventId: string,
): ClassroomCalendarStoreV1<Layer> {
  if (!isClassroomCalendarStoreV1(store, store.layer)) throw new TypeError("Classroom calendar store is invalid.");
  return createClassroomCalendarStoreV1(
    store.layer,
    store.events.filter((event) => event.id !== eventId),
  );
}

export function subscribeToDeviceClassroomCalendar(
  listener: (store: ClassroomDeviceCalendarStoreV1) => void,
  storage: ClassroomCalendarStorage | null = browserStorage(),
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onSameTab = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const store = filterClassroomCalendarStoreV1(event.detail, "device");
    listener(store ?? emptyStore());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY || event.key === null) {
      if (event.storageArea && storage && event.storageArea !== storage) return;
      listener(readDeviceClassroomCalendar(storage));
    }
  };
  window.addEventListener(CLASSROOM_CALENDAR_DEVICE_EVENT, onSameTab);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CLASSROOM_CALENDAR_DEVICE_EVENT, onSameTab);
    window.removeEventListener("storage", onStorage);
  };
}
