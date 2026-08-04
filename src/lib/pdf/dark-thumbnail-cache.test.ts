import { describe, expect, it } from "vitest";
import {
  darkPdfThumbnailRenderSceneIds,
  pruneDarkPdfThumbnails,
  retainedDarkPdfThumbnailSceneIds,
  storeDarkPdfThumbnail,
  type DarkPdfThumbnailCacheEntry,
} from "./dark-thumbnail-cache";

describe("dark PDF thumbnail cache", () => {
  it("evicts the oldest entry at its cap and refreshes revisited entries", () => {
    const cache = new Map<string, DarkPdfThumbnailCacheEntry>();
    storeDarkPdfThumbnail(cache, "a", { dataURL: "a", sceneId: "scene-a" }, 2);
    storeDarkPdfThumbnail(cache, "b", { dataURL: "b", sceneId: "scene-b" }, 2);
    storeDarkPdfThumbnail(cache, "a", { dataURL: "a2", sceneId: "scene-a" }, 2);
    storeDarkPdfThumbnail(cache, "c", { dataURL: "c", sceneId: "scene-c" }, 2);

    expect([...cache.keys()]).toEqual(["a", "c"]);
    expect(cache.get("a")?.dataURL).toBe("a2");
  });

  it("prunes deleted or replaced pages and exposes only retained scene IDs", () => {
    const cache = new Map<string, DarkPdfThumbnailCacheEntry>([
      ["keep", { dataURL: "keep", sceneId: "scene-keep" }],
      ["deleted", { dataURL: "deleted", sceneId: "scene-deleted" }],
    ]);
    pruneDarkPdfThumbnails(cache, new Set(["keep"]));

    expect([...cache.keys()]).toEqual(["keep"]);
    expect([...retainedDarkPdfThumbnailSceneIds(cache)]).toEqual(["scene-keep"]);
  });

  it("prioritizes the active page inside a bounded nearby rail window", () => {
    expect(darkPdfThumbnailRenderSceneIds(
      ["scene-a", "scene-b", "scene-c", "scene-d", "scene-e"],
      "scene-d",
      3,
    )).toEqual(["scene-d", "scene-c", "scene-e"]);
  });
});
