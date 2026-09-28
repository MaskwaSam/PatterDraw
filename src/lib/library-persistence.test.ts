import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryItems } from "@excalidraw/excalidraw/types";

const { getMock, restoreLibraryItemsMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  restoreLibraryItemsMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock("idb-keyval", () => ({
  get: getMock,
  set: setMock,
}));

vi.mock("@excalidraw/excalidraw", () => ({
  restoreLibraryItems: restoreLibraryItemsMock,
}));

import {
  loadSafeLibraryFromBlob,
  loadLibraryItems,
  sanitizeLibraryItems,
  saveLibraryItems,
} from "./library-persistence";
import {
  MAX_LIBRARY_ITEMS,
  MAX_NATIVE_LIBRARY_BLOB_BYTES,
  MAX_STRUCTURAL_DEPTH,
} from "./structural-limits";

const restoredItems = [{
  id: "shape-library-item",
  status: "published",
  created: 1,
  name: "Classroom shape",
  elements: [],
}] as const satisfies LibraryItems;

const unsafeRestoredItems = [{
  id: "unsafe-library-item",
  status: "unpublished",
  created: 1,
  elements: [
    { id: "shape", type: "rectangle", link: "https://example.invalid", customData: { href: "https://example.invalid" } },
    { id: "frame", type: "iframe", link: "https://example.invalid" },
  ],
}] as unknown as LibraryItems;

describe("personal library persistence", () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    restoreLibraryItemsMock.mockReset();
  });

  it("starts with an empty personal library when no saved value exists", async () => {
    getMock.mockResolvedValue(undefined);

    await expect(loadLibraryItems()).resolves.toEqual([]);
    expect(restoreLibraryItemsMock).not.toHaveBeenCalled();
  });

  it("restores current or legacy items through Excalidraw's migration path", async () => {
    const storedItems = [[{ id: "legacy-element" }]];
    getMock.mockResolvedValue(storedItems);
    restoreLibraryItemsMock.mockReturnValue(restoredItems);

    await expect(loadLibraryItems()).resolves.toBe(restoredItems);
    expect(restoreLibraryItemsMock).toHaveBeenCalledWith(storedItems, "unpublished");
  });

  it("falls back to the legacy Canvas Classroom storage key", async () => {
    const storedItems = [[{ id: "legacy-brand-element" }]];
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(storedItems);
    restoreLibraryItemsMock.mockReturnValue(restoredItems);

    await expect(loadLibraryItems()).resolves.toBe(restoredItems);
    expect(getMock).toHaveBeenNthCalledWith(1, "patterdraw:library:v1");
    expect(getMock).toHaveBeenNthCalledWith(2, "excalidraw-classroom:library:v1");
  });

  it("rejects malformed saved data instead of passing it to Excalidraw", async () => {
    getMock.mockResolvedValue({ libraryItems: [] });

    await expect(loadLibraryItems()).rejects.toThrow("saved personal library is invalid");
    expect(restoreLibraryItemsMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized stored collection before Excalidraw restore", async () => {
    const oversized = Array.from({ length: MAX_LIBRARY_ITEMS + 1 }, () => []);
    getMock.mockResolvedValue(oversized);

    await expect(loadLibraryItems()).rejects.toThrow(/items/);
    expect(restoreLibraryItemsMock).not.toHaveBeenCalled();
  });

  it("bounds and validates a native library before Excalidraw restore", async () => {
    restoreLibraryItemsMock.mockReturnValue(restoredItems);
    const file = new Blob([JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [[{ id: "safe-native-item", type: "rectangle" }]],
    })], { type: "application/vnd.excalidrawlib+json" });

    await expect(loadSafeLibraryFromBlob(file)).resolves.toBe(restoredItems);
    expect(restoreLibraryItemsMock).toHaveBeenCalledOnce();

    const oversized = {
      size: MAX_NATIVE_LIBRARY_BLOB_BYTES + 1,
      text: vi.fn(),
    } as unknown as Blob;
    await expect(loadSafeLibraryFromBlob(oversized)).rejects.toThrow(/import limit/);
    expect(oversized.text).not.toHaveBeenCalled();
  });

  it("rejects deeply nested native library data before Excalidraw restore", async () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index <= MAX_STRUCTURAL_DEPTH; index += 1) nested = { next: nested };
    const file = new Blob([JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [{ elements: [], customData: nested }],
    })]);

    await expect(loadSafeLibraryFromBlob(file)).rejects.toThrow(/structural depth/);
    expect(restoreLibraryItemsMock).not.toHaveBeenCalled();
  });

  it("recovers a valid legacy library when the canonical record is malformed", async () => {
    const legacyItems = [[{ id: "recoverable-legacy-element" }]];
    getMock.mockResolvedValueOnce({ libraryItems: [] }).mockResolvedValueOnce(legacyItems);
    restoreLibraryItemsMock.mockReturnValue(restoredItems);

    await expect(loadLibraryItems()).resolves.toBe(restoredItems);
    expect(restoreLibraryItemsMock).toHaveBeenCalledWith(legacyItems, "unpublished");
  });

  it("stores the canonical Excalidraw library items under a versioned key", async () => {
    getMock.mockResolvedValue(undefined);
    await loadLibraryItems();
    setMock.mockResolvedValue(undefined);

    await saveLibraryItems(restoredItems);
    expect(setMock).toHaveBeenCalledWith("patterdraw:library:v1", restoredItems);
  });

  it("removes blocked embeds and external link metadata from library items", () => {
    expect(sanitizeLibraryItems(unsafeRestoredItems)).toEqual([{
      id: "unsafe-library-item",
      status: "unpublished",
      created: 1,
      elements: [{ id: "shape", type: "rectangle", link: null, customData: {} }],
    }]);
  });

  it("drops a library item whose only content is a blocked embed", () => {
    const iframeOnly = [{
      id: "iframe-only",
      status: "unpublished",
      created: 1,
      elements: [{ id: "frame", type: "iframe" }],
    }] as unknown as LibraryItems;
    expect(sanitizeLibraryItems(iframeOnly)).toEqual([]);
  });

  it("sanitizes library updates before committing them", async () => {
    getMock.mockResolvedValue(undefined);
    await loadLibraryItems();
    setMock.mockResolvedValue(undefined);

    await saveLibraryItems(unsafeRestoredItems);

    expect(setMock).toHaveBeenCalledWith("patterdraw:library:v1", [{
      id: "unsafe-library-item",
      status: "unpublished",
      created: 1,
      elements: [{ id: "shape", type: "rectangle", link: null, customData: {} }],
    }]);
  });
});
