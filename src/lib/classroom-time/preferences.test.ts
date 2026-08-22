import { describe, expect, it, vi } from "vitest";
import {
  CLASSROOM_TIME_PREFERENCES_STORAGE_KEY,
  DEFAULT_CLASSROOM_TIME_PREFERENCES,
  normalizeClassroomTimePreferences,
  persistClassroomTimePreferencePatch,
  persistClassroomTimePreferences,
  readClassroomTimePreferences,
  readClassroomTimePreferencesSnapshot,
  restoreDefaultClassroomTimePreferences,
  subscribeToClassroomTimePreferences,
} from "./preferences";

function mapStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

function envelope(
  revision: number,
  preferences = DEFAULT_CLASSROOM_TIME_PREFERENCES,
): string {
  return JSON.stringify({ version: 1, revision, preferences });
}

describe("classroom time preferences", () => {
  it("provides versioned classic classroom defaults", () => {
    expect(DEFAULT_CLASSROOM_TIME_PREFERENCES).toMatchObject({
      version: 1,
      masterVolume: 0.7,
      muted: false,
      timer: { durationMs: 300_000, progressStyle: "ring" },
      pomodoro: {
        focusDurationMs: 1_500_000,
        shortBreakDurationMs: 300_000,
        longBreakDurationMs: 900_000,
        cyclesBeforeLongBreak: 4,
        autoStartFocus: false,
        autoStartBreaks: false,
      },
      alarm: { enabled: true, tone: "warm-chime", repeat: false },
    });
  });

  it("recovers malformed fields independently and drops unknown fields", () => {
    const normalized = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      muted: true,
      masterVolume: 9,
      timer: { durationMs: 0, progressStyle: "unsafe", networkUrl: "https://bad.invalid" },
      appearance: { ...DEFAULT_CLASSROOM_TIME_PREFERENCES.appearance, accentColor: "url(evil)" },
      futurePreference: true,
    });

    expect(normalized.muted).toBe(true);
    expect(normalized.masterVolume).toBe(0.7);
    expect(normalized.timer).toEqual(DEFAULT_CLASSROOM_TIME_PREFERENCES.timer);
    expect(normalized.appearance).toEqual(DEFAULT_CLASSROOM_TIME_PREFERENCES.appearance);
    expect(normalized).not.toHaveProperty("futurePreference");
  });

  it("clones dashboard panel defaults instead of retaining caller objects", () => {
    const dashboardPanels = {
      clock: true,
      timer: false,
      pomodoro: true,
      calendar: true,
    };
    const normalized = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      dashboardPanels,
    });

    dashboardPanels.clock = false;
    expect(normalized.dashboardPanels).toEqual({
      clock: true,
      timer: false,
      pomodoro: true,
      calendar: true,
    });
  });

  it("resets unknown schema versions and malformed JSON to defaults", () => {
    expect(normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      version: 2,
      muted: true,
    })).toEqual(DEFAULT_CLASSROOM_TIME_PREFERENCES);
    expect(readClassroomTimePreferences(mapStorage("{broken"))).toEqual(DEFAULT_CLASSROOM_TIME_PREFERENCES);
    expect(readClassroomTimePreferencesSnapshot(mapStorage("{broken"))).toEqual({
      preferences: DEFAULT_CLASSROOM_TIME_PREFERENCES,
      revision: 0,
    });
  });

  it("recovers a legacy plain-v1 record as revision zero", () => {
    const legacy = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      muted: true,
      masterVolume: 0.3,
    });

    expect(readClassroomTimePreferencesSnapshot(mapStorage(JSON.stringify(legacy)))).toEqual({
      preferences: legacy,
      revision: 0,
    });
  });

  it("persists a complete normalized device record in a revision envelope", async () => {
    const storage = mapStorage();
    const requested = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      muted: true,
      masterVolume: 0.35,
    });
    const result = await persistClassroomTimePreferences(requested, 0, storage);

    expect(result).toEqual({ preferences: requested, revision: 1, status: "persisted" });
    expect(readClassroomTimePreferencesSnapshot(storage)).toEqual({
      preferences: requested,
      revision: 1,
    });
    expect(JSON.parse(storage.values.get(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1,
      revision: 1,
      preferences: requested,
    });
  });

  it("requires the current revision for a complete replacement", async () => {
    const storage = mapStorage(JSON.stringify(DEFAULT_CLASSROOM_TIME_PREFERENCES));
    const first = await persistClassroomTimePreferences(normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      muted: true,
    }), 0, storage);
    const staleReplacement = await persistClassroomTimePreferences(normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      masterVolume: 0.2,
    }), 0, storage);

    expect(first.status).toBe("persisted");
    expect(staleReplacement).toEqual({
      preferences: first.preferences,
      revision: 1,
      status: "conflict",
    });
    expect(readClassroomTimePreferences(storage)).toEqual(first.preferences);
  });

  it("merges a patch onto the freshest stored record", async () => {
    const storage = mapStorage(JSON.stringify({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      masterVolume: 0.25,
    }));
    const stale = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      masterVolume: 0.9,
    });
    const result = await persistClassroomTimePreferencePatch(stale, { muted: true }, storage);

    expect(result.preferences.masterVolume).toBe(0.25);
    expect(result.preferences.muted).toBe(true);
    expect(result.revision).toBe(1);
  });

  it("rebases only changed fields from stale complete nested objects", async () => {
    const storage = mapStorage(JSON.stringify(DEFAULT_CLASSROOM_TIME_PREFERENCES));
    const staleTabA = readClassroomTimePreferences(storage);
    const staleTabB = readClassroomTimePreferences(storage);

    const tabA = await persistClassroomTimePreferencePatch(staleTabA, {
      appearance: {
        ...staleTabA.appearance,
        accentColor: "#dc2626",
      },
    }, storage);
    const tabB = await persistClassroomTimePreferencePatch(staleTabB, {
      appearance: {
        ...staleTabB.appearance,
        backgroundColor: "#fef3c7",
      },
    }, storage);

    expect(tabA.status).toBe("persisted");
    expect(tabB).toMatchObject({ status: "persisted", revision: 2 });
    expect(tabB.preferences.appearance).toEqual({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES.appearance,
      accentColor: "#dc2626",
      backgroundColor: "#fef3c7",
    });
  });

  it("accepts field-granular nested patches", async () => {
    const storage = mapStorage();
    const result = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      {
        appearance: { borderColor: "#111827" },
        pomodoro: { autoStartBreaks: true },
        alarm: { tone: "bright-marimba" },
      },
      storage,
    );

    expect(result.preferences.appearance).toEqual({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES.appearance,
      borderColor: "#111827",
    });
    expect(result.preferences.pomodoro).toEqual({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES.pomodoro,
      autoStartBreaks: true,
    });
    expect(result.preferences.alarm).toEqual({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES.alarm,
      tone: "bright-marimba",
    });
  });

  it("retries a compare-and-swap conflict and rebases onto the winner", async () => {
    const values = new Map<string, string>([[
      CLASSROOM_TIME_PREFERENCES_STORAGE_KEY,
      JSON.stringify(DEFAULT_CLASSROOM_TIME_PREFERENCES),
    ]]);
    const concurrent = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      appearance: {
        ...DEFAULT_CLASSROOM_TIME_PREFERENCES.appearance,
        accentColor: "#16a34a",
      },
    });
    let reads = 0;
    const storage = {
      values,
      getItem: (key: string) => {
        reads += 1;
        if (reads === 2) values.set(key, envelope(1, concurrent));
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    const result = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { appearance: { backgroundColor: "#fef3c7" } },
      storage,
    );

    expect(result).toMatchObject({ status: "persisted", revision: 2 });
    expect(result.preferences.appearance.accentColor).toBe("#16a34a");
    expect(result.preferences.appearance.backgroundColor).toBe("#fef3c7");
  });

  it("serializes concurrent writes sharing a storage backend", async () => {
    const storage = mapStorage(JSON.stringify(DEFAULT_CLASSROOM_TIME_PREFERENCES));
    const staleTabA = readClassroomTimePreferences(storage);
    const staleTabB = readClassroomTimePreferences(storage);

    await Promise.all([
      persistClassroomTimePreferencePatch(staleTabA, {
        appearance: { accentColor: "#7c3aed" },
      }, storage),
      persistClassroomTimePreferencePatch(staleTabB, {
        appearance: { backgroundColor: "#ecfeff" },
      }, storage),
    ]);

    const final = readClassroomTimePreferencesSnapshot(storage);
    expect(final.revision).toBe(2);
    expect(final.preferences.appearance.accentColor).toBe("#7c3aed");
    expect(final.preferences.appearance.backgroundColor).toBe("#ecfeff");
  });

  it("ignores malformed nested patch fields instead of erasing concurrent values", async () => {
    const concurrent = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      appearance: {
        ...DEFAULT_CLASSROOM_TIME_PREFERENCES.appearance,
        backgroundColor: "#ecfeff",
      },
    });
    const storage = mapStorage(envelope(3, concurrent));

    const result = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { appearance: { accentColor: "url(unsafe)" } } as never,
      storage,
    );

    expect(result.status).toBe("persisted");
    expect(result.revision).toBe(3);
    expect(result.preferences.appearance).toEqual(concurrent.appearance);
    expect(storage.values.get(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY)).toBe(envelope(3, concurrent));
  });

  it("never retains project event references in device preferences", () => {
    const normalized = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      calendar: {
        ...DEFAULT_CLASSROOM_TIME_PREFERENCES.calendar,
        projectEventIds: ["project-event-1"],
      },
    });

    expect(normalized.calendar.projectEventIds).toEqual([]);
    expect(normalized.calendar.transferCache).toBeNull();
  });

  it("rolls back the exact previous envelope when storage mutates then throws", async () => {
    const previous = normalizeClassroomTimePreferences({
      ...DEFAULT_CLASSROOM_TIME_PREFERENCES,
      masterVolume: 0.2,
    });
    const previousRaw = envelope(7, previous);
    const storage = mapStorage(previousRaw);
    const ordinarySet = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      ordinarySet(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };

    const result = await persistClassroomTimePreferencePatch(previous, { muted: true }, storage);

    expect(result.status).toBe("rolled-back");
    expect(result.preferences).toEqual(previous);
    expect(result.revision).toBe(7);
    expect(storage.values.get(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY)).toBe(previousRaw);
  });

  it("restores an absent key exactly when its first write mutates then throws", async () => {
    const storage = mapStorage();
    const ordinarySet = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      ordinarySet(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };

    const result = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { muted: true },
      storage,
    );

    expect(result.status).toBe("rolled-back");
    expect(storage.values.has(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY)).toBe(false);
  });

  it("reports an indeterminate state when an absent key cannot be compensated", async () => {
    const values = new Map<string, string>();
    let rejectOnce = true;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
        if (rejectOnce) {
          rejectOnce = false;
          throw new Error("quota after allocation");
        }
      },
    };

    const result = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { muted: true },
      storage,
    );

    expect(result.status).toBe("indeterminate");
    expect(result.preferences.muted).toBe(true);
    expect(result.revision).toBe(1);
  });

  it("supports memory-only changes and Restore Defaults", async () => {
    expect(await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { muted: true },
      null,
    )).toMatchObject({ status: "memory-only", preferences: { muted: true }, revision: 0 });

    const storage = mapStorage();
    const changed = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { muted: true },
      storage,
    );
    const restored = await restoreDefaultClassroomTimePreferences(storage);
    expect(changed.revision).toBe(1);
    expect(restored).toMatchObject({
      preferences: DEFAULT_CLASSROOM_TIME_PREFERENCES,
      revision: 2,
      status: "persisted",
    });
  });

  it("notifies same-tab and cross-tab subscribers", async () => {
    const storage = mapStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToClassroomTimePreferences(listener, storage);

    const persisted = await persistClassroomTimePreferencePatch(
      { ...DEFAULT_CLASSROOM_TIME_PREFERENCES },
      { masterVolume: 0.4 },
      storage,
    );
    expect(listener).toHaveBeenLastCalledWith(persisted.preferences);

    storage.values.set(CLASSROOM_TIME_PREFERENCES_STORAGE_KEY, envelope(2, {
      ...persisted.preferences,
      muted: true,
    }));
    window.dispatchEvent(new StorageEvent("storage", { key: CLASSROOM_TIME_PREFERENCES_STORAGE_KEY }));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ muted: true }));

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
