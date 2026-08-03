import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME_PREFERENCE,
  normalizeThemePreference,
  persistThemePreference,
  readThemePreference,
  resolvedTheme,
  subscribeToThemePreference,
  THEME_PREFERENCE_STORAGE_KEY,
} from "./theme-preference";

describe("theme preference", () => {
  it("normalizes unsupported values to the backwards-compatible light default", () => {
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("sepia")).toBe(DEFAULT_THEME_PREFERENCE);
    expect(normalizeThemePreference(null)).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it("reads, persists, and clears the versioned device-local value", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    persistThemePreference("system", storage);
    expect(readThemePreference(storage)).toBe("system");
    expect(values.get(THEME_PREFERENCE_STORAGE_KEY)).toBe("system");
    persistThemePreference("light", storage);
    expect(values.has(THEME_PREFERENCE_STORAGE_KEY)).toBe(false);
  });

  it("tolerates unavailable storage", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readThemePreference(storage)).toBe("light");
    expect(() => persistThemePreference("dark", storage)).not.toThrow();
  });

  it("resolves system without changing explicit themes", () => {
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
    expect(resolvedTheme("system", true)).toBe("dark");
    expect(resolvedTheme("system", false)).toBe("light");
  });

  it("subscribes to same-page and cross-tab changes", () => {
    let stored: string | null = null;
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => { stored = value; }),
      removeItem: vi.fn(() => { stored = null; }),
    };
    const listener = vi.fn();
    const unsubscribe = subscribeToThemePreference(listener, storage);
    persistThemePreference("dark", storage);
    expect(listener).toHaveBeenLastCalledWith("dark");
    stored = "system";
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_PREFERENCE_STORAGE_KEY }));
    expect(listener).toHaveBeenLastCalledWith("system");
    unsubscribe();
  });
});
