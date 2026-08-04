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

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">
  & Partial<Pick<Storage, "removeItem">>;
type SnappingPreferenceKey = "showGrid" | "snapToObjects";

type PreferenceStorageWrite = readonly [key: string, value: string];
const pendingPreferencesByStorage = new WeakMap<
  PreferenceStorage,
  Partial<FeaturePreferences>
>();

function writePreferenceStorageTransaction(
  storage: PreferenceStorage | null,
  writes: readonly PreferenceStorageWrite[],
): boolean {
  if (!storage) return true;
  let previousValues: Map<string, string | null>;
  try {
    previousValues = new Map(writes.map(([key]) => [key, storage.getItem(key)]));
  } catch {
    return false;
  }
  try {
    for (const [key, value] of writes) storage.setItem(key, value);
    return true;
  } catch {
    // localStorage has no multi-key transaction. Restore every touched key so
    // a late quota/security failure cannot leave per-setting values that
    // disagree with the in-memory state dispatched below. `"null"` is a
    // functional fallback for small test/custom stores without removeItem:
    // readers ignore it just as they would a missing per-setting value.
    for (const [key, previousValue] of [...previousValues].reverse()) {
      try {
        if (previousValue === null) {
          if (storage.removeItem) storage.removeItem(key);
          else storage.setItem(key, "null");
        } else {
          storage.setItem(key, previousValue);
        }
      } catch {
        // Best effort only: the in-memory preference remains usable even when
        // the browser rejects both the write and its rollback.
      }
    }
    return false;
  }
}

function exclusiveSnappingPreferences(
  preferences: FeaturePreferences,
  preferred: SnappingPreferenceKey = "snapToObjects",
): FeaturePreferences {
  if (!preferences.showGrid || !preferences.snapToObjects) return preferences;
  return {
    ...preferences,
    [preferred === "showGrid" ? "snapToObjects" : "showGrid"]: false,
  };
}

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

  const normalized = Object.fromEntries(FEATURE_PREFERENCE_KEYS.map((key) => [
    key,
    typeof source[key] === "boolean" ? source[key] : DEFAULT_FEATURE_PREFERENCES[key],
  ])) as FeaturePreferences;
  // Excalidraw treats these modes as alternatives. Prefer object snapping for
  // malformed legacy state; normal writes preserve the user's latest choice.
  return exclusiveSnappingPreferences(normalized);
}

export function readFeaturePreferences(
  storage: PreferenceStorage | null = browserStorage(),
): FeaturePreferences {
  if (!storage) return { ...DEFAULT_FEATURE_PREFERENCES };
  let preferences = { ...DEFAULT_FEATURE_PREFERENCES };
  let aggregatePreferences = preferences;
  let hasAggregatePreferences = false;
  try {
    const stored = storage.getItem(FEATURE_PREFERENCES_STORAGE_KEY);
    if (stored) {
      aggregatePreferences = normalizeFeaturePreferences(JSON.parse(stored));
      preferences = { ...aggregatePreferences };
      hasAggregatePreferences = true;
    }
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
  if (hasAggregatePreferences) {
    // Grid and object snapping form one exclusive choice. Their aggregate pair
    // is written atomically, whereas separate keys can briefly reflect two
    // interleaved tab updates (including both false). Use the final aggregate
    // pair as the last-writer-wins record and let subscribers heal the keys.
    preferences.showGrid = aggregatePreferences.showGrid;
    preferences.snapToObjects = aggregatePreferences.snapToObjects;
  } else if (preferences.showGrid && preferences.snapToObjects) {
    preferences = exclusiveSnappingPreferences(preferences);
  }
  return preferences;
}

export function persistFeaturePreferences(
  preferences: FeaturePreferences,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  const normalized = normalizeFeaturePreferences(preferences);
  const persisted = writePreferenceStorageTransaction(storage, [
    ...FEATURE_PREFERENCE_KEYS.map((key) => [
      featurePreferenceStorageKey(key),
      JSON.stringify(normalized[key]),
    ] as const),
    [FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized)],
  ]);
  if (storage) {
    if (persisted) pendingPreferencesByStorage.delete(storage);
    else pendingPreferencesByStorage.set(storage, { ...normalized });
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
  const preferred = enabled && (key === "showGrid" || key === "snapToObjects")
    ? key
    : undefined;
  const applyPreference = (base: FeaturePreferences) => exclusiveSnappingPreferences(
    { ...base, [key]: enabled },
    preferred,
  );
  const pending = storage ? pendingPreferencesByStorage.get(storage) : undefined;
  const stored = storage ? readFeaturePreferences(storage) : current;
  const next = applyPreference(pending ? { ...stored, ...pending } : stored);
  const perSettingWrites = new Map<string, string>();
  if (pending) {
    for (const pendingKey of FEATURE_PREFERENCE_KEYS) {
      if (typeof pending[pendingKey] === "boolean") {
        perSettingWrites.set(
          featurePreferenceStorageKey(pendingKey),
          JSON.stringify(next[pendingKey]),
        );
      }
    }
  }
  perSettingWrites.set(featurePreferenceStorageKey(key), JSON.stringify(next[key]));
  let otherKey: SnappingPreferenceKey | undefined;
  if (preferred) {
    otherKey = preferred === "showGrid"
      ? "snapToObjects"
      : "showGrid";
    perSettingWrites.set(
      featurePreferenceStorageKey(otherKey),
      JSON.stringify(next[otherKey]),
    );
  }
  // Per-setting keys make different simultaneous tab updates independent.
  // The aggregate object remains as a backwards-compatible snapshot.
  const writes: PreferenceStorageWrite[] = [
    ...perSettingWrites.entries(),
    [FEATURE_PREFERENCES_STORAGE_KEY, JSON.stringify(next)],
  ];
  const persisted = writePreferenceStorageTransaction(storage, writes);
  if (storage) {
    if (persisted) {
      pendingPreferencesByStorage.delete(storage);
    } else {
      pendingPreferencesByStorage.set(storage, {
        ...pending,
        [key]: next[key],
        ...(otherKey ? { [otherKey]: next[otherKey] } : {}),
      });
    }
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
    // A real storage event is the browser's accepted cross-tab state. Drop a
    // failed same-tab write overlay before publishing that state, otherwise a
    // later local toggle could replay the stale failed value over the external
    // update the user can already see.
    if (storage) pendingPreferencesByStorage.delete(storage);
    try {
      // Per-setting values are authoritative, but keep the aggregate snapshot
      // converged for older PatterDraw builds and straightforward inspection.
      const serialized = JSON.stringify(preferences);
      if (storage?.getItem(FEATURE_PREFERENCES_STORAGE_KEY) !== serialized) {
        storage?.setItem(FEATURE_PREFERENCES_STORAGE_KEY, serialized);
      }
      // Heal a simultaneous-tab conflict as well as the aggregate snapshot so
      // every current and older tab observes one exclusive snapping mode.
      for (const key of FEATURE_PREFERENCE_KEYS) {
        const value = JSON.stringify(preferences[key]);
        if (storage?.getItem(featurePreferenceStorageKey(key)) !== value) {
          storage?.setItem(featurePreferenceStorageKey(key), value);
        }
      }
    } catch {
      // The in-memory subscription still works when storage is unavailable.
    }
    listener(preferences);
  };
  const handlePreferenceChange = (event: Event) => {
    listener(event instanceof CustomEvent
      ? normalizeFeaturePreferences(event.detail)
      : storage
        ? readFeaturePreferences(storage)
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
