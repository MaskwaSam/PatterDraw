const MEBIBYTE = 1024 * 1024;

export const AUTOSAVE_BASE_INTERVAL_MS = 700;
export const AUTOSAVE_MEDIUM_PROJECT_BYTES = 10 * MEBIBYTE;
export const AUTOSAVE_LARGE_PROJECT_BYTES = 30 * MEBIBYTE;
export const AUTOSAVE_MAX_RECOVERY_MS = 15_000;
const AUTOSAVE_WORK_TO_REST_RATIO = 4;

/** Timer-driven scene serialization can wait until native freehand ink ends.
 * Explicit save, navigation and page-exit callers still capture immediately.
 */
export function shouldDeferFreehandPersistence(appState: {
  newElement?: { id?: string; type: string } | null;
}, interruptedElementId: string | null = null): boolean {
  return appState.newElement?.type === "freedraw"
    && (!interruptedElementId || appState.newElement.id !== interruptedElementId);
}

/**
 * Small projects keep the immediate interaction flush teachers expect. Larger
 * projects get a short cooldown so one expensive full-project write cannot run
 * after every pen stroke on a low-powered computer. The duration term is a
 * start-to-start interval: it includes the completed save plus up to 15 seconds
 * of recovery, so even a very slow save cannot trigger another one immediately.
 */
export function getAutosaveCooldownMs(
  projectBytes: number,
  previousSaveDurationMs = 0,
): number {
  const sizeCooldown = !Number.isFinite(projectBytes)
    || projectBytes < AUTOSAVE_MEDIUM_PROJECT_BYTES
    ? 0
    : projectBytes < AUTOSAVE_LARGE_PROJECT_BYTES
      ? 1_500
      : 4_000;
  const durationCooldown = Number.isFinite(previousSaveDurationMs)
    && previousSaveDurationMs > 0
    ? previousSaveDurationMs + Math.min(
      AUTOSAVE_MAX_RECOVERY_MS,
      Math.ceil(previousSaveDurationMs * (AUTOSAVE_WORK_TO_REST_RATIO - 1)),
    )
    : 0;
  return Math.max(sizeCooldown, durationCooldown);
}

export function getAutosaveFollowupDelayMs(
  projectBytes: number,
  elapsedMs: number,
  previousSaveDurationMs = 0,
): number {
  const interval = Math.max(
    AUTOSAVE_BASE_INTERVAL_MS,
    getAutosaveCooldownMs(projectBytes, previousSaveDurationMs),
  );
  return Math.max(0, interval - Math.max(0, elapsedMs));
}
