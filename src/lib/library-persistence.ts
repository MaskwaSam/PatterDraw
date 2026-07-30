import { get, set } from "idb-keyval";
import { restoreLibraryItems } from "@excalidraw/excalidraw";
import type { LibraryItems, LibraryItems_anyVersion } from "@excalidraw/excalidraw/types";
import {
  assertAuxiliaryStorageBudget,
  LEGACY_PERSONAL_LIBRARY_KEY,
  PERSONAL_LIBRARY_KEY,
} from "./storage-budget";

export async function loadLibraryItems(): Promise<LibraryItems> {
  const current = await get<unknown>(PERSONAL_LIBRARY_KEY);
  const stored = current ?? await get<unknown>(LEGACY_PERSONAL_LIBRARY_KEY);
  if (stored === undefined || stored === null) return [];
  if (!Array.isArray(stored)) throw new Error("The saved personal library is invalid.");
  return restoreLibraryItems(stored as LibraryItems_anyVersion, "unpublished");
}

export async function saveLibraryItems(libraryItems: LibraryItems): Promise<void> {
  await assertAuxiliaryStorageBudget({ library: libraryItems });
  await set(PERSONAL_LIBRARY_KEY, libraryItems);
}
