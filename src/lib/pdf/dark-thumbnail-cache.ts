export interface DarkPdfThumbnailCacheEntry<TDataUrl = string> {
  dataURL: TDataUrl;
  sceneId: string;
}

export function storeDarkPdfThumbnail<TDataUrl>(
  cache: Map<string, DarkPdfThumbnailCacheEntry<TDataUrl>>,
  key: string,
  entry: DarkPdfThumbnailCacheEntry<TDataUrl>,
  maximumEntries: number,
): void {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new Error("The dark PDF thumbnail cache limit is invalid.");
  }
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maximumEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function pruneDarkPdfThumbnails<TDataUrl>(
  cache: Map<string, DarkPdfThumbnailCacheEntry<TDataUrl>>,
  validKeys: ReadonlySet<string>,
): void {
  for (const key of cache.keys()) {
    if (!validKeys.has(key)) cache.delete(key);
  }
}

export function retainedDarkPdfThumbnailSceneIds<TDataUrl>(
  cache: ReadonlyMap<string, DarkPdfThumbnailCacheEntry<TDataUrl>>,
): Set<string> {
  return new Set(Array.from(cache.values(), (entry) => entry.sceneId));
}

export function darkPdfThumbnailRenderSceneIds(
  orderedSceneIds: readonly string[],
  activeSceneId: string | null | undefined,
  maximumEntries: number,
): string[] {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new Error("The dark PDF thumbnail render limit is invalid.");
  }
  if (!orderedSceneIds.length) return [];
  const activeIndex = activeSceneId ? orderedSceneIds.indexOf(activeSceneId) : -1;
  if (activeIndex < 0) return orderedSceneIds.slice(0, maximumEntries);
  const windowSize = Math.min(maximumEntries, orderedSceneIds.length);
  const windowStart = Math.max(
    0,
    Math.min(
      activeIndex - Math.floor(windowSize / 2),
      orderedSceneIds.length - windowSize,
    ),
  );
  const windowSceneIds = orderedSceneIds.slice(windowStart, windowStart + windowSize);
  // Refresh or render the active thumbnail before the rest of its rail window
  // so a full LRU cannot evict the page the user is currently viewing.
  return [
    orderedSceneIds[activeIndex],
    ...windowSceneIds.filter((sceneId) => sceneId !== activeSceneId),
  ];
}
