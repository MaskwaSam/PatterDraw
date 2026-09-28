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
import {
  MAX_NATIVE_LIBRARY_BLOB_BYTES,
  MAX_NATIVE_LIBRARY_TEXT_BYTES,
  assertImportBlobBytes,
  assertImportTextBytes,
  assertLibraryStructure,
} from "./structural-limits";

let observedLibrary: AuxiliaryObservation | undefined;

type LibraryElement = LibraryItems[number]["elements"][number];

export function sanitizeLibraryItems(libraryItems: LibraryItems): LibraryItems {
  // Do not let a malformed or pathological library reach even this shallow
  // sanitizer. Native file paths use the same helper before Excalidraw's
  // dependency parser; stored paths use it before restoreLibraryItems below.
  assertLibraryStructure(libraryItems, { label: "Library" });
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

/**
 * Parse a user-selected Excalidraw library behind wrapper-owned byte and
 * structure gates. This deliberately replaces Excalidraw's native library
 * chooser path, whose parser otherwise restores the entire untrusted graph
 * before PatterDraw receives onLibraryChange.
 */
export async function loadSafeLibraryFromBlob(blob: Blob): Promise<LibraryItems> {
  assertImportBlobBytes(blob, MAX_NATIVE_LIBRARY_BLOB_BYTES, "Personal library file");
  const text = await blob.text();
  assertImportTextBytes(text, MAX_NATIVE_LIBRARY_TEXT_BYTES, "Personal library file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The personal library file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The personal library file is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.type !== "excalidrawlib"
    || (record.version !== 1 && record.version !== 2)
  ) {
    throw new Error("The personal library file is invalid.");
  }
  const imported = record.libraryItems ?? record.library;
  if (!Array.isArray(imported)) {
    throw new Error("The personal library file has no library items.");
  }
  assertLibraryStructure(imported, { label: "Personal library file" });
  const restored = restoreLibraryItems(imported as LibraryItems_anyVersion, "unpublished");
  return sanitizeLibraryItems(restored);
}

async function restoreSafeLibraryItems(
  stored: LibraryItems_anyVersion,
  source: AuxiliaryObservation["source"],
): Promise<LibraryItems> {
  // This must remain before observation/fingerprinting and, most importantly,
  // before Excalidraw's migration/restore walk.
  assertLibraryStructure(stored, { label: "Saved personal library" });
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
      assertLibraryStructure(current, { label: "Saved personal library" });
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
      assertLibraryStructure(legacy, { label: "Saved personal library" });
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
  assertLibraryStructure(libraryItems, { label: "Library" });
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
