import { get, set } from "idb-keyval";
import { restoreLibraryItems } from "@excalidraw/excalidraw";
import type { LibraryItems, LibraryItems_anyVersion } from "@excalidraw/excalidraw/types";

const LIBRARY_KEY = "excalidraw-classroom:library:v1";

export async function loadLibraryItems(): Promise<LibraryItems> {
  const stored = await get<unknown>(LIBRARY_KEY);
  if (stored === undefined || stored === null) return [];
  if (!Array.isArray(stored)) throw new Error("The saved personal library is invalid.");
  return restoreLibraryItems(stored as LibraryItems_anyVersion, "unpublished");
}

export async function saveLibraryItems(libraryItems: LibraryItems): Promise<void> {
  await set(LIBRARY_KEY, libraryItems);
}
