export const THEME_PREFERENCE_STORAGE_KEY = "patterdraw:theme-preference:v1";
const THEME_PREFERENCE_EVENT = "patterdraw:theme-preference-change";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = typeof THEME_PREFERENCES[number];
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "light";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.includes(value as ThemePreference)
    ? value as ThemePreference
    : DEFAULT_THEME_PREFERENCE;
}

export function readThemePreference(
  storage: PreferenceStorage | null = browserStorage(),
): ThemePreference {
  if (!storage) return DEFAULT_THEME_PREFERENCE;
  try {
    return normalizeThemePreference(storage.getItem(THEME_PREFERENCE_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function persistThemePreference(
  preference: ThemePreference,
  storage: PreferenceStorage | null = browserStorage(),
): ThemePreference {
  const normalized = normalizeThemePreference(preference);
  try {
    if (normalized === DEFAULT_THEME_PREFERENCE) {
      storage?.removeItem(THEME_PREFERENCE_STORAGE_KEY);
    } else {
      storage?.setItem(THEME_PREFERENCE_STORAGE_KEY, normalized);
    }
  } catch {
    // The in-memory preference remains usable when browser storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_PREFERENCE_EVENT, {
      detail: normalized,
    }));
  }
  return normalized;
}

export function subscribeToThemePreference(
  listener: (preference: ThemePreference) => void,
  storage: PreferenceStorage | null = browserStorage(),
): () => void {
  const handlePreferenceChange = (event: Event) => {
    listener(storage
      ? readThemePreference(storage)
      : event instanceof CustomEvent
        ? normalizeThemePreference(event.detail)
        : DEFAULT_THEME_PREFERENCE);
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_PREFERENCE_STORAGE_KEY || event.key === null) {
      listener(readThemePreference(storage));
    }
  };
  window.addEventListener(THEME_PREFERENCE_EVENT, handlePreferenceChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(THEME_PREFERENCE_EVENT, handlePreferenceChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function resolvedTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

export function systemPrefersDark(): boolean {
  try {
    return typeof window !== "undefined"
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function subscribeToSystemTheme(listener: (prefersDark: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = (event: MediaQueryListEvent) => listener(event.matches);
  query.addEventListener("change", handleChange);
  return () => query.removeEventListener("change", handleChange);
}
