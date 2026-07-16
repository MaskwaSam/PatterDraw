export const EXPERIMENTAL_FEATURES_STORAGE_KEY =
  "excalidraw-classroom:experimental-math-tools:v1";

const EXPERIMENTAL_FEATURES_EVENT = "excalidraw-classroom:experimental-features-change";

export function readExperimentalFeaturesPreference(): boolean {
  try {
    return window.localStorage.getItem(EXPERIMENTAL_FEATURES_STORAGE_KEY) === "enabled";
  } catch {
    return false;
  }
}

export function persistExperimentalFeaturesPreference(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(EXPERIMENTAL_FEATURES_STORAGE_KEY, "enabled");
    else window.localStorage.removeItem(EXPERIMENTAL_FEATURES_STORAGE_KEY);
  } catch {
    // The in-memory feature gate still works if browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<boolean>(EXPERIMENTAL_FEATURES_EVENT, { detail: enabled }));
}

export function subscribeToExperimentalFeaturesPreference(
  listener: (enabled: boolean) => void,
): () => void {
  const handlePreferenceChange = (event: Event) => {
    listener(event instanceof CustomEvent && typeof event.detail === "boolean"
      ? event.detail
      : readExperimentalFeaturesPreference());
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === EXPERIMENTAL_FEATURES_STORAGE_KEY) {
      listener(readExperimentalFeaturesPreference());
    }
  };
  window.addEventListener(EXPERIMENTAL_FEATURES_EVENT, handlePreferenceChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(EXPERIMENTAL_FEATURES_EVENT, handlePreferenceChange);
    window.removeEventListener("storage", handleStorage);
  };
}
