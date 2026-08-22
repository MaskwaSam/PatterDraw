import { describe, expect, it, vi } from "vitest";
import {
  CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY,
  CLASSROOM_CALENDAR_SCHEMA_VERSION,
  createClassroomCalendarStoreV1,
  type ClassroomCalendarEventV1,
} from "./calendar";
import {
  persistDeviceClassroomCalendar,
  readDeviceClassroomCalendar,
  readDeviceClassroomCalendarSnapshot,
  removeClassroomCalendarEvent,
  subscribeToDeviceClassroomCalendar,
  mutateDeviceClassroomCalendar,
  upsertClassroomCalendarEvent,
} from "./calendar-storage";

const event: ClassroomCalendarEventV1 = {
  schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
  id: "lesson-one",
  date: "2026-09-01",
  title: "Lesson one",
  color: "#3366CC",
  allDay: true,
  createdAt: "2026-08-21T15:00:00.000Z",
  updatedAt: "2026-08-21T15:00:00.000Z",
};

function mapStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

async function withNavigatorLocks<T>(locks: unknown, operation: () => Promise<T>): Promise<T> {
  const target = navigator as Navigator & { locks?: unknown };
  const previous = Object.getOwnPropertyDescriptor(target, "locks");
  Object.defineProperty(target, "locks", { configurable: true, value: locks });
  try {
    return await operation();
  } finally {
    if (previous) Object.defineProperty(target, "locks", previous);
    else Reflect.deleteProperty(target, "locks");
  }
}

async function withWindowLocalStorage<T>(
  storage: ReturnType<typeof mapStorage>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  try {
    return await operation();
  } finally {
    if (previous) Object.defineProperty(window, "localStorage", previous);
    else Reflect.deleteProperty(window, "localStorage");
  }
}

describe("device classroom calendar persistence", () => {
  it("recovers valid events while filtering malformed entries", () => {
    const storage = mapStorage(JSON.stringify({
      schemaVersion: 1,
      layer: "device",
      events: [event, { ...event, id: "bad", color: "url(evil)" }],
    }));
    expect(readDeviceClassroomCalendar(storage).events).toEqual([event]);

    const enveloped = mapStorage(JSON.stringify({
      version: 1,
      revision: 7,
      store: {
        schemaVersion: 1,
        layer: "device",
        events: [event, { ...event, id: "bad", color: "url(evil)" }],
      },
    }));
    expect(readDeviceClassroomCalendarSnapshot(enveloped)).toEqual({
      revision: 7,
      store: createClassroomCalendarStoreV1("device", [event]),
    });
  });

  it("persists transactionally and restores the previous store after failure", async () => {
    const previous = createClassroomCalendarStoreV1("device", [event]);
    const storage = mapStorage(JSON.stringify(previous));
    const ordinarySet = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      ordinarySet(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };
    const requested = createClassroomCalendarStoreV1("device", []);
    const result = await persistDeviceClassroomCalendar(requested, storage, 0);
    expect(result.status).toBe("rolled-back");
    expect(result.store).toEqual(previous);
    expect(result.revision).toBe(0);
  });

  it("reports an indeterminate write when an absent key cannot be restored", async () => {
    const storage = mapStorage();
    const ordinarySet = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      ordinarySet(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota after allocation");
      }
    };
    storage.removeItem = () => { throw new Error("removal unavailable"); };

    const requested = createClassroomCalendarStoreV1("device", [event]);
    const result = await persistDeviceClassroomCalendar(requested, storage, 0);

    expect(result).toMatchObject({ status: "indeterminate", revision: 1, store: requested });
    expect(readDeviceClassroomCalendarSnapshot(storage)).toEqual({ revision: 1, store: requested });
  });

  it("immutably upserts and removes events", () => {
    const empty = createClassroomCalendarStoreV1("device");
    const added = upsertClassroomCalendarEvent(empty, event);
    const changed = upsertClassroomCalendarEvent(added, { ...event, title: "Updated" });
    expect(empty.events).toHaveLength(0);
    expect(changed.events[0].title).toBe("Updated");
    expect(removeClassroomCalendarEvent(changed, event.id).events).toHaveLength(0);
  });

  it("supports memory-only persistence and cross-tab synchronization", async () => {
    const store = createClassroomCalendarStoreV1("device", [event]);
    await expect(persistDeviceClassroomCalendar(store, null, 0)).resolves.toEqual({
      store,
      revision: 0,
      status: "memory-only",
    });

    const storage = mapStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToDeviceClassroomCalendar(listener, storage);
    await persistDeviceClassroomCalendar(store, storage, 0);
    expect(listener).toHaveBeenLastCalledWith(store);
    storage.values.set(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY, JSON.stringify(createClassroomCalendarStoreV1("device")));
    window.dispatchEvent(new StorageEvent("storage", { key: CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY }));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ events: [] }));
    unsubscribe();
  });

  it("rejects a stale full-store write and rebases mutation retries", async () => {
    const storage = mapStorage();
    const tabA = readDeviceClassroomCalendarSnapshot(storage);
    const tabB = readDeviceClassroomCalendarSnapshot(storage);
    const eventTwo = { ...event, id: "lesson-two", title: "Lesson two" };

    const savedA = await persistDeviceClassroomCalendar(
      upsertClassroomCalendarEvent(tabA.store, event),
      storage,
      tabA.revision,
    );
    expect(savedA.status).toBe("persisted");

    const staleB = await persistDeviceClassroomCalendar(
      upsertClassroomCalendarEvent(tabB.store, eventTwo),
      storage,
      tabB.revision,
    );
    expect(staleB.status).toBe("conflicted");
    expect(staleB.store.events.map(({ id }) => id)).toEqual(["lesson-one"]);

    const rebased = await mutateDeviceClassroomCalendar(
      (current) => upsertClassroomCalendarEvent(current, eventTwo),
      storage,
    );
    expect(rebased.status).toBe("persisted");
    expect(rebased.store.events.map(({ id }) => id)).toEqual(["lesson-one", "lesson-two"]);
  });

  it("serializes two concurrent custom-storage mutations without losing either event", async () => {
    const storage = mapStorage();
    const eventTwo = { ...event, id: "lesson-two", title: "Lesson two" };
    const observations: string[][] = [];

    const writerA = mutateDeviceClassroomCalendar((current) => {
      observations.push(current.events.map(({ id }) => id));
      return upsertClassroomCalendarEvent(current, event);
    }, storage);
    const writerB = mutateDeviceClassroomCalendar((current) => {
      observations.push(current.events.map(({ id }) => id));
      return upsertClassroomCalendarEvent(current, eventTwo);
    }, storage);

    const [savedA, savedB] = await Promise.all([writerA, writerB]);
    expect(savedA).toMatchObject({ status: "persisted", revision: 1 });
    expect(savedB).toMatchObject({ status: "persisted", revision: 2 });
    expect(observations).toEqual([[], ["lesson-one"]]);
    expect(readDeviceClassroomCalendarSnapshot(storage)).toMatchObject({
      revision: 2,
      store: { events: [event, eventTwo] },
    });
  });

  it("rebases after a deterministic raw-value CAS interleave", async () => {
    const values = new Map<string, string>();
    const eventTwo = { ...event, id: "lesson-two", title: "Lesson two" };
    const winner = createClassroomCalendarStoreV1("device", [event]);
    let reads = 0;
    const storage = {
      values,
      getItem: (key: string) => {
        reads += 1;
        // First read captures the empty base. The CAS read then observes the
        // other writer's revision-one envelope and forces a safe rebase.
        if (reads === 2) {
          values.set(key, JSON.stringify({ version: 1, revision: 1, store: winner }));
        }
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    const result = await mutateDeviceClassroomCalendar(
      (current) => upsertClassroomCalendarEvent(current, eventTwo),
      storage,
    );

    expect(result).toMatchObject({ status: "persisted", revision: 2 });
    expect(result.store.events.map(({ id }) => id)).toEqual(["lesson-one", "lesson-two"]);
  });

  it("serializes two browser writers under the dedicated Web Lock", async () => {
    let lockTail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((
      _name: string,
      _options: LockOptions,
      operation: () => unknown | Promise<unknown>,
    ) => {
      const result = lockTail.then(operation);
      lockTail = result.then(() => undefined, () => undefined);
      return result;
    });
    const browserLocalStorage = mapStorage();
    await withWindowLocalStorage(browserLocalStorage, async () => {
      await withNavigatorLocks({ request }, async () => {
        const eventTwo = { ...event, id: "lesson-two", title: "Lesson two" };
        const observations: string[][] = [];
        const writerA = mutateDeviceClassroomCalendar((current) => {
          observations.push(current.events.map(({ id }) => id));
          return upsertClassroomCalendarEvent(current, event);
        }, window.localStorage);
        const writerB = mutateDeviceClassroomCalendar((current) => {
          observations.push(current.events.map(({ id }) => id));
          return upsertClassroomCalendarEvent(current, eventTwo);
        }, window.localStorage);

        const [savedA, savedB] = await Promise.all([writerA, writerB]);

        expect(savedA).toMatchObject({ status: "persisted", revision: 1 });
        expect(savedB).toMatchObject({ status: "persisted", revision: 2 });
        expect(observations).toEqual([[], ["lesson-one"]]);
        expect(readDeviceClassroomCalendar(window.localStorage).events).toEqual([event, eventTwo]);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(
          1,
          `${CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY}:write`,
          { mode: "exclusive" },
          expect.any(Function),
        );
      });
    });
  });

  it("fails closed as memory-only for browser localStorage without Web Locks", async () => {
    const persisted = createClassroomCalendarStoreV1("device", [event]);
    const persistedRaw = JSON.stringify({ version: 1, revision: 4, store: persisted });
    const replacement = createClassroomCalendarStoreV1("device");
    const browserLocalStorage = mapStorage(persistedRaw);
    await withWindowLocalStorage(browserLocalStorage, async () => {
      await withNavigatorLocks(undefined, async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeToDeviceClassroomCalendar(listener, window.localStorage);
        const result = await persistDeviceClassroomCalendar(replacement, window.localStorage, 4);

        expect(result).toEqual({
          store: replacement,
          revision: 4,
          status: "memory-only",
        });
        expect(window.localStorage.getItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY)).toBe(persistedRaw);
        expect(listener).not.toHaveBeenCalled();

        const eventTwo = { ...event, id: "lesson-two", title: "Lesson two" };
        const mutation = await mutateDeviceClassroomCalendar(
          (current) => upsertClassroomCalendarEvent(current, eventTwo),
          window.localStorage,
        );
        expect(mutation).toMatchObject({
          status: "memory-only",
          revision: 4,
          store: { events: [event, eventTwo] },
        });
        expect(window.localStorage.getItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY)).toBe(persistedRaw);
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
      });
    });
  });

  it("does not imply that sequential no-lock mutations were durably combined", async () => {
    const browserLocalStorage = mapStorage();
    const eventTwo = { ...event, id: "lesson-two", title: "Lesson two" };
    await withWindowLocalStorage(browserLocalStorage, async () => {
      await withNavigatorLocks(undefined, async () => {
        const first = await mutateDeviceClassroomCalendar(
          (current) => upsertClassroomCalendarEvent(current, event),
          window.localStorage,
        );
        const second = await mutateDeviceClassroomCalendar(
          (current) => upsertClassroomCalendarEvent(current, eventTwo),
          window.localStorage,
        );

        expect(first).toMatchObject({ status: "memory-only", revision: 0, store: { events: [event] } });
        expect(second).toMatchObject({ status: "memory-only", revision: 0, store: { events: [eventTwo] } });
        expect(window.localStorage.getItem(CLASSROOM_CALENDAR_DEVICE_STORAGE_KEY)).toBeNull();
      });
    });
  });
});
