export const LOCAL_GEOGON_VERSION = "0.2.10";
export const LOCAL_GEOGON_RELATIVE_PATH = "./geogon/index.html?host=patterdraw";

/**
 * Resolve only the reviewed, bundled GeoGon entry point beside PatterDraw.
 * The returned URL follows PatterDraw's relative deployment base, including
 * nested Moodle-style routes, but can never name a different origin.
 */
export function localGeoGonUrl(base: string | URL = window.location.href): string {
  const baseUrl = base instanceof URL ? base : new URL(base);
  const url = new URL(LOCAL_GEOGON_RELATIVE_PATH, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.endsWith("/geogon/index.html")) {
    throw new Error("The bundled GeoGon tool path is invalid.");
  }
  url.hash = "";
  return url.toString();
}
