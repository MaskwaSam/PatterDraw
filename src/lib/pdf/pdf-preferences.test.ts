import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PDF_PREFERENCES,
  normalizePdfPreferences,
  PDF_PREFERENCES_STORAGE_KEY,
  persistPdfPreference,
  persistPdfPreferences,
  readPdfPreferences,
  restoreDefaultPdfPreferences,
  subscribeToPdfPreferences,
} from "./pdf-preferences";

function mapStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(PDF_PREFERENCES_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe("PDF preferences", () => {
  it("defaults every optional PDF behavior to enabled", () => {
    expect(DEFAULT_PDF_PREFERENCES).toEqual({
      darkPdfPreview: true,
      sharperActivePdfPage: true,
      offerVisualPdfFallback: true,
    });
  });

  it("normalizes only supported booleans and recovers malformed fields", () => {
    expect(normalizePdfPreferences(null)).toEqual(DEFAULT_PDF_PREFERENCES);
    expect(normalizePdfPreferences([])).toEqual(DEFAULT_PDF_PREFERENCES);
    expect(normalizePdfPreferences({
      darkPdfPreview: false,
      sharperActivePdfPage: "yes",
      offerVisualPdfFallback: 0,
      futureSetting: false,
    })).toEqual({
      ...DEFAULT_PDF_PREFERENCES,
      darkPdfPreview: false,
    });
  });

  it("reads the versioned device-local value without retaining unknown fields", () => {
    const storage = mapStorage(JSON.stringify({
      darkPdfPreview: false,
      sharperActivePdfPage: false,
      offerVisualPdfFallback: true,
      projectId: "must not be retained",
    }));

    expect(readPdfPreferences(storage)).toEqual({
      darkPdfPreview: false,
      sharperActivePdfPage: false,
      offerVisualPdfFallback: true,
    });
  });

  it("recovers defaults from absent, malformed, or unavailable storage", () => {
    expect(readPdfPreferences(mapStorage())).toEqual(DEFAULT_PDF_PREFERENCES);
    expect(readPdfPreferences(mapStorage("{broken"))).toEqual(DEFAULT_PDF_PREFERENCES);
    expect(readPdfPreferences({
      getItem: () => { throw new Error("blocked"); },
      setItem: vi.fn(),
    })).toEqual(DEFAULT_PDF_PREFERENCES);
  });

  it("persists the complete normalized schema under the v1 key", () => {
    const storage = mapStorage();
    const requested = {
      darkPdfPreview: false,
      sharperActivePdfPage: true,
      offerVisualPdfFallback: false,
    };

    const result = persistPdfPreferences(
      { ...DEFAULT_PDF_PREFERENCES },
      requested,
      storage,
    );

    expect(result).toEqual({ preferences: requested, status: "persisted" });
    expect(storage.values.size).toBe(1);
    expect(JSON.parse(storage.values.get(PDF_PREFERENCES_STORAGE_KEY)!)).toEqual(requested);
  });

  it("updates one preference without changing the other values", () => {
    const storage = mapStorage();
    const current = {
      darkPdfPreview: false,
      sharperActivePdfPage: true,
      offerVisualPdfFallback: false,
    };

    const result = persistPdfPreference(current, "sharperActivePdfPage", false, storage);

    expect(result).toEqual({
      preferences: { ...current, sharperActivePdfPage: false },
      status: "persisted",
    });
  });

  it("merges stale-tab single-key changes onto the freshest stored record", () => {
    const storage = mapStorage(JSON.stringify(DEFAULT_PDF_PREFERENCES));
    const staleTabA = { ...DEFAULT_PDF_PREFERENCES };
    const staleTabB = { ...DEFAULT_PDF_PREFERENCES };

    const tabAResult = persistPdfPreference(
      staleTabA,
      "darkPdfPreview",
      false,
      storage,
    );
    expect(tabAResult.preferences.darkPdfPreview).toBe(false);

    const tabBResult = persistPdfPreference(
      staleTabB,
      "sharperActivePdfPage",
      false,
      storage,
    );

    expect(tabBResult).toEqual({
      preferences: {
        ...DEFAULT_PDF_PREFERENCES,
        darkPdfPreview: false,
        sharperActivePdfPage: false,
      },
      status: "persisted",
    });
    expect(readPdfPreferences(storage)).toEqual(tabBResult.preferences);
  });

  it("rolls back storage and in-memory state when a write mutates then fails", () => {
    const previous = {
      darkPdfPreview: false,
      sharperActivePdfPage: false,
      offerVisualPdfFallback: true,
    };
    const storage = mapStorage(JSON.stringify(previous));
    const originalSetItem = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };

    const result = persistPdfPreference(previous, "darkPdfPreview", true, storage);

    expect(result.status).toBe("rolled-back");
    expect(result.preferences).toEqual(previous);
    expect(result.error).toBeInstanceOf(Error);
    expect(readPdfPreferences(storage)).toEqual(previous);
  });

  it("returns and notifies the restored storage record instead of stale caller state", () => {
    const restored = {
      darkPdfPreview: false,
      sharperActivePdfPage: false,
      offerVisualPdfFallback: true,
    };
    const staleCaller = { ...DEFAULT_PDF_PREFERENCES };
    const storage = mapStorage(JSON.stringify(restored));
    const originalSetItem = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };
    const listener = vi.fn();
    const unsubscribe = subscribeToPdfPreferences(listener, storage);

    const result = persistPdfPreferences(staleCaller, {
      ...staleCaller,
      offerVisualPdfFallback: false,
    }, storage);

    expect(result.status).toBe("rolled-back");
    expect(result.preferences).toEqual(restored);
    expect(listener).toHaveBeenLastCalledWith(restored);
    expect(readPdfPreferences(storage)).toEqual(restored);
    unsubscribe();
  });

  it("restores an absent storage key when the first write fails", () => {
    const storage = mapStorage();
    const originalSetItem = storage.setItem;
    let rejectOnce = true;
    storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("quota");
      }
    };

    const result = persistPdfPreference(
      { ...DEFAULT_PDF_PREFERENCES },
      "darkPdfPreview",
      false,
      storage,
    );

    expect(result.status).toBe("rolled-back");
    expect(result.preferences).toEqual(DEFAULT_PDF_PREFERENCES);
    expect(storage.values.has(PDF_PREFERENCES_STORAGE_KEY)).toBe(false);
  });

  it("accepts memory-only changes when browser storage is not available", () => {
    const result = persistPdfPreference(
      { ...DEFAULT_PDF_PREFERENCES },
      "offerVisualPdfFallback",
      false,
      null,
    );

    expect(result).toEqual({
      preferences: { ...DEFAULT_PDF_PREFERENCES, offerVisualPdfFallback: false },
      status: "memory-only",
    });
  });

  it("restores all PDF defaults as one write", () => {
    const storage = mapStorage();
    const disabled = {
      darkPdfPreview: false,
      sharperActivePdfPage: false,
      offerVisualPdfFallback: false,
    };

    const result = restoreDefaultPdfPreferences(disabled, storage);

    expect(result).toEqual({
      preferences: { ...DEFAULT_PDF_PREFERENCES },
      status: "persisted",
    });
    expect(readPdfPreferences(storage)).toEqual(DEFAULT_PDF_PREFERENCES);
  });

  it("notifies same-tab subscribers of successful writes and failed-write rollbacks", () => {
    const storage = mapStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToPdfPreferences(listener, storage);
    const current = { ...DEFAULT_PDF_PREFERENCES };

    const persisted = persistPdfPreference(current, "darkPdfPreview", false, storage);
    expect(listener).toHaveBeenLastCalledWith(persisted.preferences);

    storage.setItem = () => { throw new Error("quota"); };
    const rolledBack = persistPdfPreference(
      persisted.preferences,
      "sharperActivePdfPage",
      false,
      storage,
    );
    expect(rolledBack.status).toBe("rolled-back");
    expect(listener).toHaveBeenLastCalledWith(persisted.preferences);
    unsubscribe();
  });

  it("synchronizes relevant cross-tab storage events and ignores unrelated keys", () => {
    const storage = mapStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToPdfPreferences(listener, storage);
    storage.values.set(PDF_PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_PDF_PREFERENCES,
      sharperActivePdfPage: false,
    }));

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent("storage", {
      key: PDF_PREFERENCES_STORAGE_KEY,
    }));
    expect(listener).toHaveBeenLastCalledWith({
      ...DEFAULT_PDF_PREFERENCES,
      sharperActivePdfPage: false,
    });

    storage.values.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenLastCalledWith(DEFAULT_PDF_PREFERENCES);
    unsubscribe();
  });
});
