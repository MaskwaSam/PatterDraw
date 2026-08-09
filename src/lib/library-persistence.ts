import { get } from "idb-keyval";
import { restoreLibraryItems } from "@excalidraw/excalidraw";
import type { LibraryItems, LibraryItems_anyVersion } from "@excalidraw/excalidraw/types";
import {
  commitAuxiliaryStorage,
  enqueueAuxiliaryMutation,
  observationForValue,
  type AuxiliaryObservation,
} from "./auxiliary-persistence";
import {
  LEGACY_PERSONAL_LIBRARY_KEY,
  PERSONAL_LIBRARY_KEY,
} from "./storage-budget";
import { isBlockedEmbeddedElementType } from "./embedded-content-policy";

let observedLibrary: AuxiliaryObservation | undefined;

type LibraryElement = LibraryItems[number]["elements"][number];

export function sanitizeLibraryItems(libraryItems: LibraryItems): LibraryItems {
  let changed = false;
  const safeItems: LibraryItems[number][] = [];
  for (const item of libraryItems) {
    let itemChanged = false;
    const safeElements: LibraryElement[] = [];
    for (const element of item.elements) {
      if (isBlockedEmbeddedElementType(element.type)) {
        changed = true;
        itemChanged = true;
        continue;
      }
      const customData = element.customData && typeof element.customData === "object"
        ? { ...element.customData }
        : undefined;
      const hadUnsafeCustomData = Boolean(customData && ("url" in customData || "href" in customData));
      if (customData) {
        delete customData.url;
        delete customData.href;
      }
      if (element.link || hadUnsafeCustomData) {
        changed = true;
        itemChanged = true;
        safeElements.push({
          ...element,
          link: null,
          ...(customData ? { customData } : {}),
        } as LibraryElement);
      } else {
        safeElements.push(element);
      }
    }
    if (item.elements.length > 0 && safeElements.length === 0) {
      changed = true;
      continue;
    }
    safeItems.push(itemChanged ? { ...item, elements: safeElements } : item);
  }
  return changed ? safeItems : libraryItems;
}

async function restoreSafeLibraryItems(
  stored: LibraryItems_anyVersion,
  source: AuxiliaryObservation["source"],
): Promise<LibraryItems> {
  observedLibrary = observationForValue(stored, source);
  const restored = restoreLibraryItems(stored, "unpublished");
  const safe = sanitizeLibraryItems(restored);
  if (safe !== restored) await saveLibraryItems(safe);
  return safe;
}

export async function loadLibraryItems(): Promise<LibraryItems> {
  const current = await get<unknown>(PERSONAL_LIBRARY_KEY);
  let currentError: unknown;
  if (current !== undefined && current !== null) {
    try {
      if (!Array.isArray(current)) throw new Error("The saved personal library is invalid.");
      return await restoreSafeLibraryItems(current as LibraryItems_anyVersion, "canonical");
    } catch (error) {
      // A partially written/corrupt canonical value must not hide a valid
      // legacy library left by an older PatterDraw build.
      currentError = error;
    }
  }

  const legacy = await get<unknown>(LEGACY_PERSONAL_LIBRARY_KEY);
  if (legacy !== undefined && legacy !== null) {
    try {
      if (!Array.isArray(legacy)) throw new Error("The saved personal library is invalid.");
      return await restoreSafeLibraryItems(legacy as LibraryItems_anyVersion, "legacy");
    } catch (error) {
      observedLibrary = undefined;
      if (currentError) throw currentError;
      throw error;
    }
  }
  if (currentError) {
    observedLibrary = undefined;
    throw currentError;
  }
  observedLibrary = observationForValue(undefined, "empty");
  return [];
}

export async function saveLibraryItems(libraryItems: LibraryItems): Promise<void> {
  const safeLibraryItems = sanitizeLibraryItems(libraryItems);
  await enqueueAuxiliaryMutation(async () => {
    const observation = await commitAuxiliaryStorage({
      collection: "library",
      value: safeLibraryItems,
      expected: observedLibrary,
    });
    observedLibrary = observation;
  });
}
