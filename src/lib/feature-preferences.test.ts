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
