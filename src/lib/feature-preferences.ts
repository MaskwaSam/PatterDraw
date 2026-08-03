export const FEATURE_PREFERENCES_STORAGE_KEY = "patterdraw:feature-preferences:v1";
export const FEATURE_PREFERENCE_STORAGE_KEY_PREFIX = "patterdraw:feature-preference:v1:";
const FEATURE_PREFERENCES_EVENT = "patterdraw:feature-preferences-change";

export const FEATURE_PREFERENCE_KEYS = [
  "slides",
  "pdf",
  "insert",
  "mathTools",
  "library",
  "footer",
  "penOnly",
  "showGrid",
  "snapToObjects",
  "sizePosition",
  "projectFind",
  "iconOnlyControls",
] as const;

export type FeaturePreferenceKey = typeof FEATURE_PREFERENCE_KEYS[number];

export type FeaturePreferences = Record<FeaturePreferenceKey, boolean>;

export const DEFAULT_FEATURE_PREFERENCES: Readonly<FeaturePreferences> = Object.freeze({
  slides: true,
  pdf: true,
  insert: true,
  mathTools: true,
  library: true,
  footer: true,
  penOnly: false,
  showGrid: false,
  snapToObjects: false,
  sizePosition: true,
  projectFind: true,
  iconOnlyControls: false,
});

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function featurePreferenceStorageKey(key: FeaturePreferenceKey): string {
  return `${FEATURE_PREFERENCE_STORAGE_KEY_PREFIX}${key}`;
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeFeaturePreferences(value: unknown): FeaturePreferences {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  return Object.fromEntries(FEATURE_PREFERENCE_KEYS.map((key) => [
    key,
    typeof source[key] === "boolean" ? source[key] : DEFAULT_FEATURE_PREFERENCES[key],
  ])) as FeaturePreferences;
}

export function readFeaturePreferences(
  storage: PreferenceStorage | null = browserStorage(),
): FeaturePreferences {
  if (!storage) return { ...DEFAULT_FEATURE_PREFERENCES };
  let preferences = { ...DEFAULT_FEATURE_PREFERENCES };
  try {
    const stored = storage.getItem(FEATURE_PREFERENCES_STORAGE_KEY);
    if (stored) preferences = normalizeFeaturePreferences(JSON.parse(stored));
  } catch {
    // Individual keys below can still recover the latest per-setting values.
  }
  for (const key of FEATURE_PREFERENCE_KEYS) {
    try {
      const stored = storage.getItem(featurePreferenceStorageKey(key));
      if (stored === null) continue;
      const value = JSON.parse(stored) as unknown;
      if (typeof value === "boolean") preferences[key] = value;
    } catch {
      // Keep the aggregate/default value for this setting.
    }
  }
  return preferences;
}

export function persistFeaturePreferences(
  preferences: FeaturePreferences,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  const normalized = normalizeFeaturePreferences(preferences);
  try {
    for (const key of FEATURE_PREFERENCE_KEYS) {
      storage?.setItem(featurePreferenceStorageKey(key), JSON.stringify(normalized[key]));
    }
    storage?.setItem(FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // The in-memory preferences still work when browser storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<FeaturePreferences>(FEATURE_PREFERENCES_EVENT, {
      detail: normalized,
    }));
  }
}

export function persistFeaturePreference(
  current: FeaturePreferences,
  key: FeaturePreferenceKey,
  enabled: boolean,
  storage: PreferenceStorage | null = browserStorage(),
): FeaturePreferences {
  const latest = storage ? readFeaturePreferences(storage) : current;
  const next = { ...latest, [key]: enabled };
  try {
    // Per-setting keys make different simultaneous tab updates independent.
    // The aggregate object remains as a backwards-compatible snapshot.
    storage?.setItem(featurePreferenceStorageKey(key), JSON.stringify(enabled));
    storage?.setItem(FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-memory preference still works when browser storage is unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<FeaturePreferences>(FEATURE_PREFERENCES_EVENT, {
      detail: next,
    }));
  }
  return next;
}

export function subscribeToFeaturePreferences(
  listener: (preferences: FeaturePreferences) => void,
  storage: PreferenceStorage | null = browserStorage(),
): () => void {
  const notifyFromStorage = () => {
    const preferences = readFeaturePreferences(storage);
    try {
      // Per-setting values are authoritative, but keep the aggregate snapshot
      // converged for older PatterDraw builds and straightforward inspection.
      const serialized = JSON.stringify(preferences);
      if (storage?.getItem(FEATURE_PREFERENCES_STORAGE_KEY) !== serialized) {
        storage?.setItem(FEATURE_PREFERENCES_STORAGE_KEY, serialized);
      }
    } catch {
      // The in-memory subscription still works when storage is unavailable.
    }
    listener(preferences);
  };
  const handlePreferenceChange = (event: Event) => {
    if (storage) notifyFromStorage();
    else listener(event instanceof CustomEvent
      ? normalizeFeaturePreferences(event.detail)
      : { ...DEFAULT_FEATURE_PREFERENCES });
  };
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === FEATURE_PREFERENCES_STORAGE_KEY
      || event.key?.startsWith(FEATURE_PREFERENCE_STORAGE_KEY_PREFIX)
      || event.key === null
    ) {
      notifyFromStorage();
    }
  };
  window.addEventListener(FEATURE_PREFERENCES_EVENT, handlePreferenceChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(FEATURE_PREFERENCES_EVENT, handlePreferenceChange);
    window.removeEventListener("storage", handleStorage);
  };
}
