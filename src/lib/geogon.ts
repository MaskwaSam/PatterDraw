export const GEOGON_SVG_EXPORT_MARKER = "Created with 3DGeoGon true vector SVG export";

const GEOGON_SVG_EXPORT_PATTERN =
  /<!--\s*Created with 3DGeoGon true vector SVG export\s*-->/i;

/**
 * Recognize only the true-vector clipboard format produced by 3DGeoGon's
 * `COPY SVG HTML` action. The returned markup is still untrusted: callers must
 * pass its Blob through the normal local-image preflight before insertion.
 */
export function geoGonSvgFromClipboardText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!source || !GEOGON_SVG_EXPORT_PATTERN.test(source)) return null;
  if (!/^(?:<\?xml\b[^>]*>\s*)?<svg\b[\s\S]*<\/svg>\s*$/i.test(source)) return null;
  return source;
}
