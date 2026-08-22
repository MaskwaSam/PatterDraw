import {
  CLASSROOM_TIME_SCHEMA_VERSION,
  MAX_CALENDAR_EVENTS_PER_LAYER,
  MAX_CALENDAR_EVENT_NOTE_LENGTH,
  MAX_CALENDAR_EVENT_TITLE_LENGTH,
  MAX_CALENDAR_TRANSFER_CACHE_BYTES,
  SAFE_HEX_COLOR_PATTERN,
} from "./constants";

export const CLASSROOM_CALENDAR_SCHEMA_VERSION = CLASSROOM_TIME_SCHEMA_VERSION;
export const CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY = "patterdraw:classroom-calendar:v1";
export const MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER = MAX_CALENDAR_EVENTS_PER_LAYER;
export const MAX_CLASSROOM_CALENDAR_TITLE_LENGTH = MAX_CALENDAR_EVENT_TITLE_LENGTH;
export const MAX_CLASSROOM_CALENDAR_NOTE_LENGTH = MAX_CALENDAR_EVENT_NOTE_LENGTH;
export const MAX_PROJECT_CALENDAR_TRANSFER_BYTES = MAX_CALENDAR_TRANSFER_CACHE_BYTES;

export const PROJECT_CALENDAR_TRANSFER_KIND = "patterdraw-project-calendar-transfer" as const;

const MAX_EVENT_ID_LENGTH = 128;
const MAX_PROJECT_ID_LENGTH = 128;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID_PATTERN = EVENT_ID_PATTERN;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CHECKSUM_PATTERN = /^crc32:[0-9a-f]{8}$/;

const EVENT_REQUIRED_KEYS = [
  "schemaVersion",
  "id",
  "date",
  "title",
  "color",
  "allDay",
  "createdAt",
  "updatedAt",
] as const;
const EVENT_OPTIONAL_KEYS = ["note", "startTime", "endTime"] as const;
const STORE_KEYS = ["schemaVersion", "layer", "events"] as const;
const TRANSFER_CACHE_KEYS = [
  "schemaVersion",
  "kind",
  "sourceProjectId",
  "events",
  "checksum",
] as const;

export type ClassroomCalendarLayer = "device" | "project";

export interface ClassroomCalendarEventV1 {
  schemaVersion: typeof CLASSROOM_CALENDAR_SCHEMA_VERSION;
  id: string;
  /** Local calendar date in YYYY-MM-DD form. */
  date: string;
  title: string;
  note?: string;
  color: string;
  allDay: boolean;
  /** Local wall-clock time in HH:MM form. Required only for timed events. */
  startTime?: string;
  /** Local wall-clock time in HH:MM form. Required only for timed events. */
  endTime?: string;
  /** Canonical UTC ISO timestamp, including milliseconds. */
  createdAt: string;
  /** Canonical UTC ISO timestamp, including milliseconds. */
  updatedAt: string;
}

export interface ClassroomCalendarStoreV1<
  Layer extends ClassroomCalendarLayer = ClassroomCalendarLayer,
> {
  schemaVersion: typeof CLASSROOM_CALENDAR_SCHEMA_VERSION;
  layer: Layer;
  events: ClassroomCalendarEventV1[];
}

export type ClassroomDeviceCalendarStoreV1 = ClassroomCalendarStoreV1<"device">;
export type ClassroomProjectCalendarStoreV1 = ClassroomCalendarStoreV1<"project">;

/**
 * Non-canonical clipboard/library transport data. Project events remain
 * authoritative in the project store; this cache is never used for display.
 */
export interface ProjectCalendarTransferCacheV1 {
  schemaVersion: typeof CLASSROOM_CALENDAR_SCHEMA_VERSION;
  kind: typeof PROJECT_CALENDAR_TRANSFER_KIND;
  sourceProjectId: string;
  events: ClassroomCalendarEventV1[];
  checksum: string;
}

export interface ProjectCalendarEventIdCollision {
  sourceEventId: string;
  destinationEventId: string;
}

export interface ProjectCalendarTransferImportResult {
  store: ClassroomProjectCalendarStoreV1;
  /** Maps every source event ID to its retained or newly allocated destination ID. */
  idMap: Record<string, string>;
  importedEventIds: string[];
  reusedEventIds: string[];
  collisions: ProjectCalendarEventIdCollision[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isSafeIdentifier(value: unknown, pattern: RegExp, maxLength: number): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && pattern.test(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function cloneEvent(event: ClassroomCalendarEventV1): ClassroomCalendarEventV1 {
  return {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    id: event.id,
    date: event.date,
    title: event.title,
    ...(event.note === undefined ? {} : { note: event.note }),
    color: event.color,
    allDay: event.allDay,
    ...(event.startTime === undefined ? {} : { startTime: event.startTime }),
    ...(event.endTime === undefined ? {} : { endTime: event.endTime }),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export function isClassroomCalendarEventV1(
  value: unknown,
): value is ClassroomCalendarEventV1 {
  if (!isRecord(value) || !hasExactKeys(value, EVENT_REQUIRED_KEYS, EVENT_OPTIONAL_KEYS)) {
    return false;
  }
  if (value.schemaVersion !== CLASSROOM_CALENDAR_SCHEMA_VERSION) return false;
  if (!isSafeIdentifier(value.id, EVENT_ID_PATTERN, MAX_EVENT_ID_LENGTH)) return false;
  if (!isCalendarDate(value.date)) return false;
  if (
    typeof value.title !== "string"
    || value.title.trim().length === 0
    || value.title !== value.title.trim()
    || codePointLength(value.title) > MAX_CLASSROOM_CALENDAR_TITLE_LENGTH
  ) return false;
  if (
    Object.hasOwn(value, "note")
    && (typeof value.note !== "string"
      || codePointLength(value.note) > MAX_CLASSROOM_CALENDAR_NOTE_LENGTH)
  ) return false;
  if (typeof value.color !== "string" || !SAFE_HEX_COLOR_PATTERN.test(value.color)) return false;
  if (typeof value.allDay !== "boolean") return false;

  const hasStart = Object.hasOwn(value, "startTime");
  const hasEnd = Object.hasOwn(value, "endTime");
  if (value.allDay) {
    if (hasStart || hasEnd) return false;
  } else {
    if (!hasStart || !hasEnd) return false;
    if (
      typeof value.startTime !== "string"
      || typeof value.endTime !== "string"
      || !TIME_PATTERN.test(value.startTime)
      || !TIME_PATTERN.test(value.endTime)
      || value.startTime >= value.endTime
    ) return false;
  }

  if (!isCanonicalIsoTimestamp(value.createdAt) || !isCanonicalIsoTimestamp(value.updatedAt)) {
    return false;
  }
  return Date.parse(value.createdAt) <= Date.parse(value.updatedAt);
}

export function parseClassroomCalendarEventV1(
  value: unknown,
): ClassroomCalendarEventV1 | null {
  return isClassroomCalendarEventV1(value) ? cloneEvent(value) : null;
}

/**
 * Filters untrusted event collections, preserving the first valid occurrence
 * of each ID and enforcing the per-layer limit. Unknown event keys invalidate
 * that event rather than being silently retained.
 */
export function filterClassroomCalendarEvents(
  value: unknown,
): ClassroomCalendarEventV1[] {
  if (!Array.isArray(value)) return [];
  const events: ClassroomCalendarEventV1[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const event = parseClassroomCalendarEventV1(candidate);
    if (!event || ids.has(event.id)) continue;
    events.push(event);
    ids.add(event.id);
    if (events.length === MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER) break;
  }
  return events;
}

function hasValidStrictEvents(value: unknown): value is ClassroomCalendarEventV1[] {
  if (!Array.isArray(value) || value.length > MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isClassroomCalendarEventV1(candidate) || ids.has(candidate.id)) return false;
    ids.add(candidate.id);
  }
  return true;
}

export function isClassroomCalendarStoreV1<Layer extends ClassroomCalendarLayer>(
  value: unknown,
  expectedLayer: Layer,
): value is ClassroomCalendarStoreV1<Layer>;
export function isClassroomCalendarStoreV1(
  value: unknown,
  expectedLayer?: ClassroomCalendarLayer,
): value is ClassroomCalendarStoreV1;
export function isClassroomCalendarStoreV1(
  value: unknown,
  expectedLayer?: ClassroomCalendarLayer,
): value is ClassroomCalendarStoreV1 {
  return isRecord(value)
    && hasExactKeys(value, STORE_KEYS)
    && value.schemaVersion === CLASSROOM_CALENDAR_SCHEMA_VERSION
    && (value.layer === "device" || value.layer === "project")
    && (expectedLayer === undefined || value.layer === expectedLayer)
    && hasValidStrictEvents(value.events);
}

export function parseClassroomCalendarStoreV1<Layer extends ClassroomCalendarLayer>(
  value: unknown,
  expectedLayer: Layer,
): ClassroomCalendarStoreV1<Layer> | null;
export function parseClassroomCalendarStoreV1(
  value: unknown,
): ClassroomCalendarStoreV1 | null;
export function parseClassroomCalendarStoreV1(
  value: unknown,
  expectedLayer?: ClassroomCalendarLayer,
): ClassroomCalendarStoreV1 | null {
  if (!isClassroomCalendarStoreV1(value, expectedLayer)) return null;
  return {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    layer: value.layer,
    events: value.events.map(cloneEvent),
  };
}

/**
 * Recovers valid events from a correctly versioned container. A malformed
 * container or an unexpected/unknown store key remains a hard rejection.
 */
export function filterClassroomCalendarStoreV1<Layer extends ClassroomCalendarLayer>(
  value: unknown,
  expectedLayer: Layer,
): ClassroomCalendarStoreV1<Layer> | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, STORE_KEYS)
    || value.schemaVersion !== CLASSROOM_CALENDAR_SCHEMA_VERSION
    || value.layer !== expectedLayer
    || !Array.isArray(value.events)
  ) return null;
  return {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    layer: expectedLayer,
    events: filterClassroomCalendarEvents(value.events),
  };
}

export function createClassroomCalendarStoreV1<Layer extends ClassroomCalendarLayer>(
  layer: Layer,
  events: readonly ClassroomCalendarEventV1[] = [],
): ClassroomCalendarStoreV1<Layer> {
  const candidate = {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    layer,
    events,
  };
  if (!isClassroomCalendarStoreV1(candidate, layer)) {
    throw new TypeError(`Invalid ${layer} classroom calendar store.`);
  }
  return {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    layer,
    events: events.map(cloneEvent),
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalEventRecord(event: ClassroomCalendarEventV1): Record<string, unknown> {
  return cloneEvent(event) as unknown as Record<string, unknown>;
}

function canonicalEventJson(event: ClassroomCalendarEventV1): string {
  return JSON.stringify(canonicalEventRecord(event));
}

function canonicalTransferEvents(
  events: readonly ClassroomCalendarEventV1[],
): ClassroomCalendarEventV1[] {
  return events.map(cloneEvent).sort((left, right) => compareCodeUnits(left.id, right.id));
}

function assertTransferEvents(events: readonly ClassroomCalendarEventV1[]): void {
  if (events.length > MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER) {
    throw new RangeError("Project calendar transfer exceeds the event limit.");
  }
  const ids = new Set<string>();
  for (const event of events) {
    if (!isClassroomCalendarEventV1(event) || ids.has(event.id)) {
      throw new TypeError("Project calendar transfer contains invalid or duplicate events.");
    }
    ids.add(event.id);
  }
}

/** Canonical JSON used as the checksum input, independent of source event order. */
export function serializeProjectCalendarTransferPayload(
  sourceProjectId: string,
  events: readonly ClassroomCalendarEventV1[],
): string {
  if (!isSafeIdentifier(sourceProjectId, PROJECT_ID_PATTERN, MAX_PROJECT_ID_LENGTH)) {
    throw new TypeError("Project calendar transfer has an invalid source project ID.");
  }
  assertTransferEvents(events);
  return JSON.stringify({
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    kind: PROJECT_CALENDAR_TRANSFER_KIND,
    sourceProjectId,
    events: canonicalTransferEvents(events).map(canonicalEventRecord),
  });
}

let crc32Table: Uint32Array | undefined;

function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table;
  crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  return crc32Table;
}

function checksumUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const table = getCrc32Table();
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return `crc32:${((checksum ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0")}`;
}

export function checksumProjectCalendarTransferPayload(
  sourceProjectId: string,
  events: readonly ClassroomCalendarEventV1[],
): string {
  return checksumUtf8(serializeProjectCalendarTransferPayload(sourceProjectId, events));
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createProjectCalendarTransferCache(
  sourceProjectId: string,
  store: ClassroomProjectCalendarStoreV1,
): ProjectCalendarTransferCacheV1 {
  if (!isClassroomCalendarStoreV1(store, "project")) {
    throw new TypeError("Only a valid project calendar can create a transfer cache.");
  }
  const events = canonicalTransferEvents(store.events);
  const cache: ProjectCalendarTransferCacheV1 = {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    kind: PROJECT_CALENDAR_TRANSFER_KIND,
    sourceProjectId,
    events,
    checksum: checksumProjectCalendarTransferPayload(sourceProjectId, events),
  };
  if (serializedByteLength(cache) > MAX_PROJECT_CALENDAR_TRANSFER_BYTES) {
    throw new RangeError("Project calendar transfer cache exceeds 512 KiB.");
  }
  return cache;
}

export function parseProjectCalendarTransferCache(
  value: unknown,
): ProjectCalendarTransferCacheV1 | null {
  try {
    if (
      !isRecord(value)
      || !hasExactKeys(value, TRANSFER_CACHE_KEYS)
      || value.schemaVersion !== CLASSROOM_CALENDAR_SCHEMA_VERSION
      || value.kind !== PROJECT_CALENDAR_TRANSFER_KIND
      || !isSafeIdentifier(value.sourceProjectId, PROJECT_ID_PATTERN, MAX_PROJECT_ID_LENGTH)
      || !hasValidStrictEvents(value.events)
      || typeof value.checksum !== "string"
      || !CHECKSUM_PATTERN.test(value.checksum)
      || serializedByteLength(value) > MAX_PROJECT_CALENDAR_TRANSFER_BYTES
    ) return null;

    const events = canonicalTransferEvents(value.events);
    const expected = checksumProjectCalendarTransferPayload(value.sourceProjectId, events);
    if (value.checksum !== expected) return null;
    return {
      schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
      kind: PROJECT_CALENDAR_TRANSFER_KIND,
      sourceProjectId: value.sourceProjectId,
      events,
      checksum: expected,
    };
  } catch {
    return null;
  }
}

function eventsEqual(left: ClassroomCalendarEventV1, right: ClassroomCalendarEventV1): boolean {
  return canonicalEventJson(left) === canonicalEventJson(right);
}

function checksumSuffixForEvent(event: ClassroomCalendarEventV1): string {
  return checksumUtf8(canonicalEventJson(event)).slice("crc32:".length);
}

function collisionEventId(
  sourceId: string,
  digest: string,
  attempt: number,
): string {
  const suffix = attempt === 1 ? `--${digest}` : `--${digest}-${attempt}`;
  const baseLength = Math.max(1, MAX_EVENT_ID_LENGTH - suffix.length);
  return `${sourceId.slice(0, baseLength)}${suffix}`;
}

/**
 * Imports a verified project-only cache without mutating either input. Existing
 * destination events always win. Equal events reuse their ID; conflicting IDs
 * receive a content-derived deterministic suffix and are reported in idMap.
 */
export function importProjectCalendarTransferCache(
  destinationStore: ClassroomProjectCalendarStoreV1,
  cacheValue: unknown,
): ProjectCalendarTransferImportResult {
  const destination = parseClassroomCalendarStoreV1(destinationStore, "project");
  if (!destination) throw new TypeError("Destination project calendar is invalid.");
  const cache = parseProjectCalendarTransferCache(cacheValue);
  if (!cache) throw new TypeError("Project calendar transfer cache is invalid.");

  const events = destination.events.map(cloneEvent);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const idMap: Record<string, string> = {};
  const importedEventIds: string[] = [];
  const reusedEventIds: string[] = [];
  const collisions: ProjectCalendarEventIdCollision[] = [];

  for (const sourceEvent of cache.events) {
    let destinationId = sourceEvent.id;
    let destinationEvent = eventsById.get(destinationId);

    if (destinationEvent && !eventsEqual(destinationEvent, sourceEvent)) {
      const digest = checksumSuffixForEvent(sourceEvent);
      for (let attempt = 1; attempt <= MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER + 1; attempt += 1) {
        const candidateId = collisionEventId(sourceEvent.id, digest, attempt);
        const candidateEvent = { ...sourceEvent, id: candidateId };
        const existing = eventsById.get(candidateId);
        if (!existing || eventsEqual(existing, candidateEvent)) {
          destinationId = candidateId;
          destinationEvent = existing;
          break;
        }
      }
      if (destinationId === sourceEvent.id) {
        throw new RangeError("Project calendar could not allocate a collision-safe event ID.");
      }
      collisions.push({ sourceEventId: sourceEvent.id, destinationEventId: destinationId });
    }

    if (destinationEvent) {
      idMap[sourceEvent.id] = destinationId;
      reusedEventIds.push(destinationId);
      continue;
    }
    if (events.length >= MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER) {
      throw new RangeError("Imported project calendar would exceed the 500-event limit.");
    }

    const imported = cloneEvent({ ...sourceEvent, id: destinationId });
    events.push(imported);
    eventsById.set(imported.id, imported);
    idMap[sourceEvent.id] = imported.id;
    importedEventIds.push(imported.id);
  }

  return {
    store: {
      schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
      layer: "project",
      events,
    },
    idMap,
    importedEventIds,
    reusedEventIds,
    collisions,
  };
}
