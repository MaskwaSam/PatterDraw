export const DEFAULT_SLIDE_MORPH_DURATION_MS = 650;
export const MIN_SLIDE_MORPH_DURATION_MS = 250;
export const MAX_SLIDE_MORPH_DURATION_MS = 2_000;
export const SLIDE_MORPH_DURATION_STEP_MS = 50;

export function normalizeSlideMorphDurationMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SLIDE_MORPH_DURATION_MS;
  }
  const clamped = Math.min(MAX_SLIDE_MORPH_DURATION_MS, Math.max(MIN_SLIDE_MORPH_DURATION_MS, value));
  return Math.round(clamped / SLIDE_MORPH_DURATION_STEP_MS) * SLIDE_MORPH_DURATION_STEP_MS;
}
