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
  loadLibraryItems,
  sanitizeLibraryItems,
  saveLibraryItems,
} from "./library-persistence";

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
