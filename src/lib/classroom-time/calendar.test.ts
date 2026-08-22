import { describe, expect, it } from "vitest";
import {
  checksumProjectCalendarTransferPayload,
  CLASSROOM_CALENDAR_SCHEMA_VERSION,
  createClassroomCalendarStoreV1,
  createProjectCalendarTransferCache,
  filterClassroomCalendarEvents,
  filterClassroomCalendarStoreV1,
  importProjectCalendarTransferCache,
  isClassroomCalendarEventV1,
  isClassroomCalendarStoreV1,
  MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER,
  MAX_PROJECT_CALENDAR_TRANSFER_BYTES,
  parseClassroomCalendarStoreV1,
  parseProjectCalendarTransferCache,
  serializeProjectCalendarTransferPayload,
  type ClassroomCalendarEventV1,
  type ClassroomProjectCalendarStoreV1,
} from "./calendar";

const CREATED_AT = "2026-08-21T15:00:00.000Z";
const UPDATED_AT = "2026-08-21T15:30:00.000Z";

function event(
  id: string,
  overrides: Partial<ClassroomCalendarEventV1> = {},
): ClassroomCalendarEventV1 {
  return {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    id,
    date: "2026-09-01",
    title: `Event ${id}`,
    color: "#3366CC",
    allDay: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("classroom calendar event validation", () => {
  it("accepts strict all-day and timed events", () => {
    expect(isClassroomCalendarEventV1(event("all-day", { note: "Bring a calculator." }))).toBe(true);
    expect(isClassroomCalendarEventV1(event("timed", {
      allDay: false,
      startTime: "09:15",
      endTime: "10:30",
    }))).toBe(true);
  });

  it.each([
    ["unknown fields", { recurrence: "weekly" }],
    ["unsafe colors", { color: "url(https://example.invalid)" }],
    ["invalid dates", { date: "2026-02-29" }],
    ["noncanonical timestamps", { updatedAt: "2026-08-21T15:30:00Z" }],
    ["timestamps in reverse order", { createdAt: UPDATED_AT, updatedAt: CREATED_AT }],
    ["whitespace-only titles", { title: "   " }],
    ["partial timed ranges", { allDay: false, startTime: "09:00" }],
    ["reversed timed ranges", { allDay: false, startTime: "10:00", endTime: "09:00" }],
    ["times on all-day events", { startTime: "09:00", endTime: "10:00" }],
  ])("rejects %s", (_name, additions) => {
    expect(isClassroomCalendarEventV1({ ...event("invalid"), ...additions })).toBe(false);
  });

  it("enforces Unicode-aware title and note limits", () => {
    expect(isClassroomCalendarEventV1(event("title-limit", { title: "😀".repeat(120) }))).toBe(true);
    expect(isClassroomCalendarEventV1(event("title-over", { title: "😀".repeat(121) }))).toBe(false);
    expect(isClassroomCalendarEventV1(event("note-over", { note: "n".repeat(1_001) }))).toBe(false);
  });

  it("filters malformed and duplicate events without retaining unknown keys", () => {
    const first = event("one");
    const filtered = filterClassroomCalendarEvents([
      first,
      { ...first, title: "Duplicate" },
      { ...event("unknown"), recurrence: "monthly" },
      event("two"),
    ]);

    expect(filtered.map(({ id }) => id)).toEqual(["one", "two"]);
    expect(filtered[0]).not.toBe(first);
  });

  it("caps filtered layers at 500 events", () => {
    const values = Array.from(
      { length: MAX_CLASSROOM_CALENDAR_EVENTS_PER_LAYER + 20 },
      (_, index) => event(`event-${index}`),
    );
    expect(filterClassroomCalendarEvents(values)).toHaveLength(500);
  });
});

describe("classroom calendar stores", () => {
  it("keeps device and project layers explicitly separated and versioned", () => {
    const device = createClassroomCalendarStoreV1("device", [event("device-event")]);
    const project = createClassroomCalendarStoreV1("project", [event("project-event")]);

    expect(isClassroomCalendarStoreV1(device, "device")).toBe(true);
    expect(isClassroomCalendarStoreV1(device, "project")).toBe(false);
    expect(parseClassroomCalendarStoreV1(project, "project")).toEqual(project);
  });

  it("strictly rejects unknown store keys and invalid child events", () => {
    const project = createClassroomCalendarStoreV1("project", [event("valid")]);
    expect(isClassroomCalendarStoreV1({ ...project, future: true }, "project")).toBe(false);
    expect(isClassroomCalendarStoreV1({
      ...project,
      events: [...project.events, { ...event("bad"), color: "red" }],
    }, "project")).toBe(false);
  });

  it("offers explicit child filtering only for a valid strict container", () => {
    const value = {
      schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
      layer: "project",
      events: [event("valid"), { ...event("bad"), recurrence: "weekly" }],
    };
    expect(filterClassroomCalendarStoreV1(value, "project")?.events).toEqual([event("valid")]);
    expect(filterClassroomCalendarStoreV1({ ...value, unknown: true }, "project")).toBeNull();
  });
});

describe("project calendar transfer cache", () => {
  it("uses deterministic canonical serialization and checksums", () => {
    const one = event("one", { date: "2026-09-02" });
    const two = event("two", { date: "2026-09-01" });
    const forward = serializeProjectCalendarTransferPayload("project-a", [one, two]);
    const reverse = serializeProjectCalendarTransferPayload("project-a", [two, one]);

    expect(reverse).toBe(forward);
    expect(checksumProjectCalendarTransferPayload("project-a", [two, one]))
      .toBe(checksumProjectCalendarTransferPayload("project-a", [one, two]));
    expect(checksumProjectCalendarTransferPayload("project-a", [one, two]))
      .toMatch(/^crc32:[0-9a-f]{8}$/);
  });

  it("creates a project-only cache and rejects device stores", () => {
    const project = createClassroomCalendarStoreV1("project", [event("project-event")]);
    const cache = createProjectCalendarTransferCache("project-a", project);

    expect(parseProjectCalendarTransferCache(cache)).toEqual(cache);
    expect(() => createProjectCalendarTransferCache(
      "project-a",
      createClassroomCalendarStoreV1("device", [event("device-event")]) as unknown as ClassroomProjectCalendarStoreV1,
    )).toThrow(/Only a valid project calendar/);
    expect(JSON.stringify(cache)).not.toContain("device");
  });

  it("rejects unknown fields, payload tampering, and malformed checksums", () => {
    const cache = createProjectCalendarTransferCache(
      "project-a",
      createClassroomCalendarStoreV1("project", [event("one")]),
    );

    expect(parseProjectCalendarTransferCache({ ...cache, future: true })).toBeNull();
    expect(parseProjectCalendarTransferCache({
      ...cache,
      events: [{ ...cache.events[0], title: "Tampered" }],
    })).toBeNull();
    expect(parseProjectCalendarTransferCache({ ...cache, checksum: "crc32:NOTVALID" })).toBeNull();
  });

  it("enforces the complete serialized cache size limit", () => {
    const largeEvents = Array.from({ length: 500 }, (_, index) => event(`large-${index}`, {
      title: `Large event ${index}`,
      note: "n".repeat(1_000),
    }));
    const store = createClassroomCalendarStoreV1("project", largeEvents);

    expect(() => createProjectCalendarTransferCache("project-a", store)).toThrow(/512 KiB/);

    const small = createProjectCalendarTransferCache(
      "project-a",
      createClassroomCalendarStoreV1("project", [event("small")]),
    );
    expect(new TextEncoder().encode(JSON.stringify(small)).byteLength)
      .toBeLessThanOrEqual(MAX_PROJECT_CALENDAR_TRANSFER_BYTES);
  });
});

describe("project calendar transfer import", () => {
  it("reuses equal events, preserves destination conflicts, and returns a deterministic map", () => {
    const same = event("same");
    const sourceConflict = event("conflict", { title: "Source title", color: "#AA00CC" });
    const cache = createProjectCalendarTransferCache(
      "source-project",
      createClassroomCalendarStoreV1("project", [sourceConflict, same, event("new")]),
    );
    const destination = createClassroomCalendarStoreV1("project", [
      same,
      event("conflict", { title: "Destination title", color: "#000000" }),
    ]);

    const first = importProjectCalendarTransferCache(destination, cache);
    const second = importProjectCalendarTransferCache(destination, cache);
    const remappedConflict = first.idMap.conflict;

    expect(first).toEqual(second);
    expect(first.idMap.same).toBe("same");
    expect(first.idMap.new).toBe("new");
    expect(remappedConflict).toMatch(/^conflict--[0-9a-f]{8}$/);
    expect(first.collisions).toEqual([{
      sourceEventId: "conflict",
      destinationEventId: remappedConflict,
    }]);
    expect(first.reusedEventIds).toEqual(["same"]);
    expect(first.importedEventIds).toEqual([remappedConflict, "new"]);
    expect(first.store.events.find(({ id }) => id === "conflict")?.title).toBe("Destination title");
    expect(first.store.events.find(({ id }) => id === remappedConflict)?.title).toBe("Source title");
    expect(destination.events).toHaveLength(2);
  });

  it("reuses an identical previously remapped collision", () => {
    const source = event("collision", { title: "Source" });
    const cache = createProjectCalendarTransferCache(
      "source-project",
      createClassroomCalendarStoreV1("project", [source]),
    );
    const initialDestination = createClassroomCalendarStoreV1("project", [
      event("collision", { title: "Destination" }),
    ]);
    const first = importProjectCalendarTransferCache(initialDestination, cache);
    const second = importProjectCalendarTransferCache(first.store, cache);

    expect(second.importedEventIds).toEqual([]);
    expect(second.reusedEventIds).toEqual([first.idMap.collision]);
    expect(second.store.events).toHaveLength(2);
  });

  it("fails atomically when imported events would exceed project capacity", () => {
    const full = createClassroomCalendarStoreV1(
      "project",
      Array.from({ length: 500 }, (_, index) => event(`existing-${index}`)),
    );
    const cache = createProjectCalendarTransferCache(
      "source-project",
      createClassroomCalendarStoreV1("project", [event("new-event")]),
    );

    expect(() => importProjectCalendarTransferCache(full, cache)).toThrow(/500-event limit/);
    expect(full.events).toHaveLength(500);
    expect(full.events.some(({ id }) => id === "new-event")).toBe(false);
  });
});
