import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";

// Excalidraw does not expose file removal or decoded-image cache eviction.
// Re-adding an existing, currently referenced file ID is the supported path
// that clears its matching decoded image. Replace the full-page raster with a
// one-pixel SVG so returning to light mode retains only a negligible cache
// entry instead of the previous multi-megapixel bitmap.
export const DARK_PDF_RELEASE_PLACEHOLDER_DATA_URL = (
  "data:image/svg+xml;base64,"
  + "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiIHZpZXdCb3g9IjAgMCAxIDEiLz4="
) as DataURL;

type DarkPdfFileApi = Pick<
  ExcalidrawImperativeAPI,
  "addFiles" | "getFiles" | "getSceneElements"
>;

/**
 * Releases the large display-only dark PDF raster without touching project
 * files. Call this before replacing the element that references `fileId` so
 * Excalidraw invalidates the corresponding decoded-image cache entry.
 */
export function retireDarkPdfDisplayFile(
  api: DarkPdfFileApi,
  fileId: FileId,
  created = Date.now(),
): boolean {
  const files = api.getFiles();
  if (!files[fileId]) return false;

  const isReferenced = api.getSceneElements().some((element) => (
    !element.isDeleted && element.type === "image" && element.fileId === fileId
  ));
  delete files[fileId];
  if (!isReferenced) return true;

  const placeholder: BinaryFileData = {
    id: fileId,
    mimeType: "image/svg+xml",
    dataURL: DARK_PDF_RELEASE_PLACEHOLDER_DATA_URL,
    created,
  };
  api.addFiles([placeholder]);
  return true;
}
