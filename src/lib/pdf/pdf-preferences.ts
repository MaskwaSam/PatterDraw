export const PDF_PREFERENCES_STORAGE_KEY = "patterdraw:pdf-preferences:v1";
const PDF_PREFERENCES_EVENT = "patterdraw:pdf-preferences-change";

export const PDF_PREFERENCE_KEYS = [
  "darkPdfPreview",
  "sharperActivePdfPage",
  "offerVisualPdfFallback",
] as const;

export type PdfPreferenceKey = typeof PDF_PREFERENCE_KEYS[number];

export interface PdfPreferences {
  darkPdfPreview: boolean;
  sharperActivePdfPage: boolean;
  offerVisualPdfFallback: boolean;
}

export const DEFAULT_PDF_PREFERENCES: Readonly<PdfPreferences> = Object.freeze({
  darkPdfPreview: true,
  sharperActivePdfPage: true,
  offerVisualPdfFallback: true,
});

export type PdfPreferencesPersistenceStatus =
  | "persisted"
  | "memory-only"
  | "rolled-back";

/**
 * Preference writes never throw. After a rejected storage transaction and its
 * compensating restore, `status: "rolled-back"` returns the normalized state
 * re-read from storage. This keeps the caller aligned with the device's actual
 * state even when its `current` argument was stale. `memory-only` means no
 * browser storage was available, rather than a write being attempted and
 * rejected.
 */
export interface PdfPreferencesWriteResult {
  preferences: PdfPreferences;
  status: PdfPreferencesPersistenceStatus;
  error?: unknown;
}

export type PdfPreferenceStorage = Pick<Storage, "getItem" | "setItem">
  & Partial<Pick<Storage, "removeItem">>;

interface StorageWriteResult {
  error?: unknown;
  status: "persisted" | "rolled-back";
}

function browserStorage(): PdfPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function notifyPdfPreferences(preferences: PdfPreferences): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PdfPreferences>(PDF_PREFERENCES_EVENT, {
    detail: { ...preferences },
  }));
}

function writePdfPreferencesTransaction(
  storage: PdfPreferenceStorage,
  serialized: string,
): StorageWriteResult {
  let previousValue: string | null;
  try {
    previousValue = storage.getItem(PDF_PREFERENCES_STORAGE_KEY);
  } catch (error) {
    return { error, status: "rolled-back" };
  }

  try {
    storage.setItem(PDF_PREFERENCES_STORAGE_KEY, serialized);
    return { status: "persisted" };
  } catch (error) {
    // localStorage has no explicit transaction. Restore the exact value read
    // before the attempted write because a custom store can mutate and then
    // throw (for example, a quota failure reported after allocation).
    try {
      if (previousValue === null) {
        if (storage.removeItem) storage.removeItem(PDF_PREFERENCES_STORAGE_KEY);
        else storage.setItem(PDF_PREFERENCES_STORAGE_KEY, "null");
      } else {
        storage.setItem(PDF_PREFERENCES_STORAGE_KEY, previousValue);
      }
    } catch {
      // Best effort only. The caller still receives the previous in-memory
      // state, even if the browser also rejects the compensating storage write.
    }
    return { error, status: "rolled-back" };
  }
}

export function normalizePdfPreferences(value: unknown): PdfPreferences {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    darkPdfPreview: typeof source.darkPdfPreview === "boolean"
      ? source.darkPdfPreview
      : DEFAULT_PDF_PREFERENCES.darkPdfPreview,
    sharperActivePdfPage: typeof source.sharperActivePdfPage === "boolean"
      ? source.sharperActivePdfPage
      : DEFAULT_PDF_PREFERENCES.sharperActivePdfPage,
    offerVisualPdfFallback: typeof source.offerVisualPdfFallback === "boolean"
      ? source.offerVisualPdfFallback
      : DEFAULT_PDF_PREFERENCES.offerVisualPdfFallback,
  };
}

export function readPdfPreferences(
  storage: PdfPreferenceStorage | null = browserStorage(),
): PdfPreferences {
  if (!storage) return { ...DEFAULT_PDF_PREFERENCES };
  try {
    const stored = storage.getItem(PDF_PREFERENCES_STORAGE_KEY);
    if (stored === null) return { ...DEFAULT_PDF_PREFERENCES };
    return normalizePdfPreferences(JSON.parse(stored) as unknown);
  } catch {
    return { ...DEFAULT_PDF_PREFERENCES };
  }
}

function readStoredPdfPreferencesRecord(
  storage: PdfPreferenceStorage,
): PdfPreferences | null {
  try {
    const stored = storage.getItem(PDF_PREFERENCES_STORAGE_KEY);
    if (stored === null) return null;
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizePdfPreferences(parsed);
  } catch {
    return null;
  }
}

export function persistPdfPreferences(
  _current: PdfPreferences,
  requested: PdfPreferences,
  storage: PdfPreferenceStorage | null = browserStorage(),
): PdfPreferencesWriteResult {
  const next = normalizePdfPreferences(requested);

  if (!storage) {
    notifyPdfPreferences(next);
    return { preferences: next, status: "memory-only" };
  }

  const write = writePdfPreferencesTransaction(storage, JSON.stringify(next));
  // Re-read after the compensating restore instead of assuming the caller's
  // `current` value matches storage. Another tab may have committed a newer
  // record before this operation began, and a custom store may also reject the
  // compensating write itself.
  const preferences = write.status === "persisted"
    ? next
    : readPdfPreferences(storage);
  notifyPdfPreferences(preferences);
  return {
    preferences,
    status: write.status,
    ...(write.error === undefined ? {} : { error: write.error }),
  };
}

export function persistPdfPreference(
  current: PdfPreferences,
  key: PdfPreferenceKey,
  enabled: boolean,
  storage: PdfPreferenceStorage | null = browserStorage(),
): PdfPreferencesWriteResult {
  const callerState = normalizePdfPreferences(current);
  // A single setting change is a patch, not a replacement. Merge it onto the
  // freshest parseable device record so a stale tab cannot overwrite unrelated
  // settings that another tab has already committed.
  const base = storage
    ? readStoredPdfPreferencesRecord(storage) ?? callerState
    : callerState;
  return persistPdfPreferences(base, { ...base, [key]: enabled }, storage);
}

export function restoreDefaultPdfPreferences(
  current: PdfPreferences,
  storage: PdfPreferenceStorage | null = browserStorage(),
): PdfPreferencesWriteResult {
  return persistPdfPreferences(
    current,
    { ...DEFAULT_PDF_PREFERENCES },
    storage,
  );
}

export function subscribeToPdfPreferences(
  listener: (preferences: PdfPreferences) => void,
  storage: PdfPreferenceStorage | null = browserStorage(),
): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handlePreferenceChange = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    listener(normalizePdfPreferences(event.detail));
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== PDF_PREFERENCES_STORAGE_KEY && event.key !== null) return;
    listener(readPdfPreferences(storage));
  };

  window.addEventListener(PDF_PREFERENCES_EVENT, handlePreferenceChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(PDF_PREFERENCES_EVENT, handlePreferenceChange);
    window.removeEventListener("storage", handleStorage);
  };
}
