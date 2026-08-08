import type { ExcalidrawElement } from "@excalidraw/element/types";

/** Matches Excalidraw's default bucket-fill fallback when shape fill is transparent. */
export const DEFAULT_BUCKET_FILL_COLOR = "#b2f2bb";
export const DEFAULT_BUCKET_FILL_STYLE: ExcalidrawElement["fillStyle"] = "solid";
export const DEFAULT_BUCKET_FILL_OPACITY = 100;

export function effectiveBucketFillColor(backgroundColor: unknown): string {
  if (typeof backgroundColor !== "string") return DEFAULT_BUCKET_FILL_COLOR;
  const normalized = backgroundColor.trim().toLowerCase();
  return !normalized
    || normalized === "transparent"
    || normalized === "#0000"
    || normalized === "#00000000"
    || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(normalized)
    ? DEFAULT_BUCKET_FILL_COLOR
    : backgroundColor;
}

export function effectiveBucketFillStyle(value: unknown): ExcalidrawElement["fillStyle"] {
  return value === "hachure"
    || value === "cross-hatch"
    || value === "solid"
    || value === "zigzag"
    ? value
    : DEFAULT_BUCKET_FILL_STYLE;
}

export function effectiveBucketFillOpacity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : DEFAULT_BUCKET_FILL_OPACITY;
}
