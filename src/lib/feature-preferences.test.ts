import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FEATURE_PREFERENCES,
  FEATURE_PREFERENCE_STORAGE_KEY_PREFIX,
  FEATURE_PREFERENCES_STORAGE_KEY,
  normalizeFeaturePreferences,
  persistFeaturePreference,
  persistFeaturePreferences,
  readFeaturePreferences,
  subscribeToFeaturePreferences,
} from "./feature-preferences";

describe("feature preferences", () => {
  it("uses enabled defaults for missing or invalid fields", () => {
    expect(normalizeFeaturePreferences(null)).toEqual(DEFAULT_FEATURE_PREFERENCES);
    expect(normalizeFeaturePreferences({ slides: false, pdf: "no", unknown: false })).toEqual({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
    });
    expect(normalizeFeaturePreferences({
      ...DEFAULT_FEATURE_PREFERENCES,
      showGrid: true,
      snapToObjects: true,
    })).toEqual({
      ...DEFAULT_FEATURE_PREFERENCES,
      showGrid: false,
      snapToObjects: true,
    });
  });

  it("reads only the supported booleans from versioned storage", () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        slides: false,
        pdf: true,
        insert: false,
        mathTools: true,
        library: false,
        footer: true,
        studentName: "not retained",
      })),
      setItem: vi.fn(),
    };

    expect(readFeaturePreferences(storage)).toEqual({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
      insert: false,
      library: false,
    });
    expect(storage.getItem).toHaveBeenCalledWith(FEATURE_PREFERENCES_STORAGE_KEY);
  });

  it("falls back safely when stored JSON cannot be read", () => {
    expect(readFeaturePreferences({
      getItem: () => "{broken",
      setItem: vi.fn(),
    })).toEqual(DEFAULT_FEATURE_PREFERENCES);
    expect(readFeaturePreferences({
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: vi.fn(),
    })).toEqual(DEFAULT_FEATURE_PREFERENCES);
  });

  it("persists a minimal normalized schema and tolerates write failures", () => {
    const setItem = vi.fn();
    persistFeaturePreferences({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
      pdf: false,
      insert: true,
      mathTools: true,
      library: false,
      footer: true,
    }, { getItem: vi.fn(), setItem });

    expect(setItem).toHaveBeenCalledWith(
      FEATURE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_FEATURE_PREFERENCES,
        slides: false,
        pdf: false,
        insert: true,
        mathTools: true,
        library: false,
        footer: true,
      }),
    );
    expect(() => persistFeaturePreferences(
      { ...DEFAULT_FEATURE_PREFERENCES },
      { getItem: vi.fn(), setItem: () => { throw new Error("quota"); } },
    )).not.toThrow();
  });

  it("merges a single update with the latest stored state", () => {
    let stored = JSON.stringify({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
    });
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; }),
    };

    const next = persistFeaturePreference(
      { ...DEFAULT_FEATURE_PREFERENCES },
      "pdf",
      false,
      storage,
    );

    expect(next).toEqual({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
      pdf: false,
    });
    expect(JSON.parse(stored)).toEqual(next);
  });

  it("keeps simultaneous different-setting updates from separate tabs", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    persistFeaturePreference(
      { ...DEFAULT_FEATURE_PREFERENCES },
      "slides",
      false,
      storage,
    );

    // Model another tab that read the old aggregate before the Slides write,
    // then committed a different key. Per-setting values remain authoritative.
    values.set(FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_FEATURE_PREFERENCES,
      pdf: false,
    }));
    values.set(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}pdf`, "false");

    expect(readFeaturePreferences(storage)).toEqual({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
      pdf: false,
    });
  });

  it("persists grid and object snapping as one exclusive device choice", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    persistFeaturePreferences({
      ...DEFAULT_FEATURE_PREFERENCES,
      snapToObjects: true,
    }, storage);

    const next = persistFeaturePreference(
      readFeaturePreferences(storage),
      "showGrid",
      true,
      storage,
    );

    expect(next).toMatchObject({ showGrid: true, snapToObjects: false });
    expect(values.get(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}showGrid`)).toBe("true");
    expect(values.get(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}snapToObjects`)).toBe("false");
    expect(JSON.parse(values.get(FEATURE_PREFERENCES_STORAGE_KEY)!)).toMatchObject({
      showGrid: true,
      snapToObjects: false,
    });
  });

  it("resolves and heals a simultaneous-tab snapping conflict", () => {
    const values = new Map<string, string>([
      [FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify({
        ...DEFAULT_FEATURE_PREFERENCES,
        showGrid: false,
        snapToObjects: true,
      })],
      [`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}showGrid`, "true"],
      [`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}snapToObjects`, "true"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(readFeaturePreferences(storage)).toMatchObject({
      showGrid: false,
      snapToObjects: true,
    });

    const listener = vi.fn();
    const unsubscribe = subscribeToFeaturePreferences(listener, storage);
    window.dispatchEvent(new StorageEvent("storage", {
      key: `${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}snapToObjects`,
    }));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      showGrid: false,
      snapToObjects: true,
    }));
    expect(values.get(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}showGrid`)).toBe("false");
    unsubscribe();
  });

  it("uses the atomic snapping snapshot when interleaved keys are both false", () => {
    const values = new Map<string, string>([
      [FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify({
        ...DEFAULT_FEATURE_PREFERENCES,
        showGrid: true,
        snapToObjects: false,
      })],
      [`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}showGrid`, "false"],
      [`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}snapToObjects`, "false"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(readFeaturePreferences(storage)).toMatchObject({
      showGrid: true,
      snapToObjects: false,
    });

    const listener = vi.fn();
    const unsubscribe = subscribeToFeaturePreferences(listener, storage);
    window.dispatchEvent(new StorageEvent("storage", {
      key: `${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}showGrid`,
    }));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      showGrid: true,
      snapToObjects: false,
    }));
    expect(values.get(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}showGrid`)).toBe("true");
    unsubscribe();
  });

  it("delivers same-page updates when preference storage rejects a write", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    };
    const listener = vi.fn();
    const unsubscribe = subscribeToFeaturePreferences(listener, storage);

    persistFeaturePreference(
      { ...DEFAULT_FEATURE_PREFERENCES },
      "library",
      false,
      storage,
    );

    expect(listener).toHaveBeenLastCalledWith({
      ...DEFAULT_FEATURE_PREFERENCES,
      library: false,
    });

    const next = persistFeaturePreference(
      listener.mock.lastCall?.[0] ?? { ...DEFAULT_FEATURE_PREFERENCES },
      "pdf",
      false,
      storage,
    );
    expect(next).toMatchObject({
      library: false,
      pdf: false,
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      library: false,
      pdf: false,
    }));
    unsubscribe();
  });

  it("rolls back a single preference when a later aggregate write fails", () => {
    const values = new Map<string, string>();
    persistFeaturePreferences({ ...DEFAULT_FEATURE_PREFERENCES }, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    let rejectAggregateOnce = true;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
        if (key === FEATURE_PREFERENCES_STORAGE_KEY && rejectAggregateOnce) {
          rejectAggregateOnce = false;
          throw new Error("quota");
        }
      },
      removeItem: (key: string) => { values.delete(key); },
    };

    const next = persistFeaturePreference(
      { ...DEFAULT_FEATURE_PREFERENCES },
      "library",
      false,
      storage,
    );

    expect(next.library).toBe(false);
    expect(readFeaturePreferences(storage)).toEqual(DEFAULT_FEATURE_PREFERENCES);
    expect(values.get(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}library`)).toBe("true");

    const recovered = persistFeaturePreference(next, "pdf", false, storage);
    expect(recovered).toMatchObject({ library: false, pdf: false });
    expect(readFeaturePreferences(storage)).toEqual(recovered);
  });

  it("does not replay a failed preference after accepting a cross-tab update", () => {
    const values = new Map<string, string>();
    const stableStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    persistFeaturePreferences({ ...DEFAULT_FEATURE_PREFERENCES }, stableStorage);
    let rejectAggregateOnce = true;
    const storage = {
      ...stableStorage,
      setItem: (key: string, value: string) => {
        values.set(key, value);
        if (key === FEATURE_PREFERENCES_STORAGE_KEY && rejectAggregateOnce) {
          rejectAggregateOnce = false;
          throw new Error("quota");
        }
      },
    };
    const listener = vi.fn();
    const unsubscribe = subscribeToFeaturePreferences(listener, storage);

    const failed = persistFeaturePreference(
      { ...DEFAULT_FEATURE_PREFERENCES },
      "library",
      false,
      storage,
    );
    expect(failed.library).toBe(false);

    const external = {
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
      library: true,
    };
    values.set(FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify(external));
    values.set(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}slides`, "false");
    values.set(`${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}library`, "true");
    window.dispatchEvent(new StorageEvent("storage", {
      key: FEATURE_PREFERENCES_STORAGE_KEY,
    }));
    expect(listener).toHaveBeenLastCalledWith(external);

    const recovered = persistFeaturePreference(external, "pdf", false, storage);
    expect(recovered).toEqual({ ...external, pdf: false });
    expect(readFeaturePreferences(storage)).toEqual(recovered);
    unsubscribe();
  });

  it("rolls back Restore defaults when a later per-setting write fails", () => {
    const disabled = Object.fromEntries(
      Object.keys(DEFAULT_FEATURE_PREFERENCES).map((key) => [key, false]),
    ) as typeof DEFAULT_FEATURE_PREFERENCES;
    const values = new Map<string, string>();
    const initialStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    persistFeaturePreferences(disabled, initialStorage);
    let rejectPdfOnce = true;
    const storage = {
      ...initialStorage,
      setItem: (key: string, value: string) => {
        values.set(key, value);
        if (
          key === `${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}pdf`
          && rejectPdfOnce
        ) {
          rejectPdfOnce = false;
          throw new Error("quota");
        }
      },
    };

    persistFeaturePreferences({ ...DEFAULT_FEATURE_PREFERENCES }, storage);

    expect(readFeaturePreferences(storage)).toEqual(disabled);
    expect(JSON.parse(values.get(FEATURE_PREFERENCES_STORAGE_KEY)!)).toEqual(disabled);

    const recovered = persistFeaturePreference(
      { ...DEFAULT_FEATURE_PREFERENCES },
      "pdf",
      false,
      storage,
    );
    expect(recovered).toEqual({ ...DEFAULT_FEATURE_PREFERENCES, pdf: false });
    expect(readFeaturePreferences(storage)).toEqual(recovered);
  });

  it("subscribes to same-page and cross-tab preference changes", () => {
    let stored: string | null = null;
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; }),
    };
    const listener = vi.fn();
    const unsubscribe = subscribeToFeaturePreferences(listener, storage);
    persistFeaturePreferences({
      ...DEFAULT_FEATURE_PREFERENCES,
      library: false,
    }, storage);
    expect(listener).toHaveBeenLastCalledWith({
      ...DEFAULT_FEATURE_PREFERENCES,
      library: false,
    });

    stored = JSON.stringify({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
    });
    window.dispatchEvent(new StorageEvent("storage", {
      key: FEATURE_PREFERENCES_STORAGE_KEY,
    }));
    expect(listener).toHaveBeenLastCalledWith({
      ...DEFAULT_FEATURE_PREFERENCES,
      slides: false,
    });
    unsubscribe();
  });
});
