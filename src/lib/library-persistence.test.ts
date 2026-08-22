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
import { createDefaultClassroomTimeWidgetMetadata } from "./classroom-time/types";
import { createClassroomTimeWidgetScene } from "./classroom-time/scene";

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

function sequence(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${index++}`;
}

function classroomTimeLibraryItem(): LibraryItems[number] {
  const metadata = createDefaultClassroomTimeWidgetMetadata("dashboard", "library-dashboard");
  const created = createClassroomTimeWidgetScene({
    metadata,
    x: 10,
    y: 20,
    now: 1_725_000_000_000,
    createId: sequence("library-dashboard-part"),
  });
  return {
    id: "classroom-time-library-item",
    status: "unpublished",
    created: 1_725_000_000_000,
    name: "Classroom Dashboard",
    elements: created.elements.map((element) => ({ ...element, frameId: null })),
  } as LibraryItems[number];
}

function arbitraryImageLibraryItem(): LibraryItems[number] {
  return {
    id: "arbitrary-image",
    status: "unpublished",
    created: 1,
    elements: [{
      id: "image",
      type: "image",
      fileId: "unavailable-image-file",
      status: "saved",
      groupIds: [],
      frameId: null,
    }],
  } as unknown as LibraryItems[number];
}

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

  it("filters arbitrary images at the native library import boundary", async () => {
    const complete = classroomTimeLibraryItem();
    restoreLibraryItemsMock.mockReturnValue([arbitraryImageLibraryItem(), complete]);
    const file = new Blob([JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [[{ id: "restored-by-mock", type: "rectangle" }]],
    })]);

    await expect(loadSafeLibraryFromBlob(file)).resolves.toEqual([complete]);
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

  it("self-heals arbitrary images out of restored local storage", async () => {
    const stored = [[{ id: "stored-item", type: "rectangle" }]];
    const complete = classroomTimeLibraryItem();
    getMock
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(stored)
      .mockResolvedValue(undefined);
    restoreLibraryItemsMock.mockReturnValue([arbitraryImageLibraryItem(), complete]);
    setMock.mockResolvedValue(undefined);

    await expect(loadLibraryItems()).resolves.toEqual([complete]);
    expect(setMock).toHaveBeenCalledWith("patterdraw:library:v1", [complete]);
  });

  it("removes blocked embeds and external link metadata from library items", () => {
    expect(sanitizeLibraryItems(unsafeRestoredItems)).toEqual([{
      id: "unsafe-library-item",
      status: "unpublished",
      created: 1,
      elements: [{ id: "shape", type: "rectangle", link: null, customData: {} }],
    }]);
  });

  it("retains ordinary shape-only library items", () => {
    const shapeOnly = [{
      id: "ordinary-shapes",
      status: "unpublished",
      created: 1,
      elements: [
        { id: "rectangle", type: "rectangle", link: null },
        { id: "label", type: "text", link: null },
      ],
    }] as unknown as LibraryItems;

    expect(sanitizeLibraryItems(shapeOnly)).toBe(shapeOnly);
  });

  it("rejects arbitrary image library items without BinaryFiles", () => {
    const imageOnly = [arbitraryImageLibraryItem()] as LibraryItems;

    expect(sanitizeLibraryItems(imageOnly)).toEqual([]);
  });

  it("rejects malformed, partial, and mixed Classroom Time image items", () => {
    const complete = classroomTimeLibraryItem();
    const anchorIndex = complete.elements.findIndex((element) => element.type === "image");
    const anchor = complete.elements[anchorIndex];
    if (!anchor || anchor.type !== "image") throw new Error("Dashboard fixture has no image anchor.");
    const malformedElements = complete.elements.map((element, index) => index === anchorIndex ? {
      ...element,
      customData: {
        classroomTimeWidget: {
          ...(element.customData?.classroomTimeWidget as Record<string, unknown>),
          version: 2,
        },
      },
    } : element);
    const partialElements = complete.elements.slice(0, -1);
    const mixedElements = [...complete.elements, {
      ...complete.elements[1],
      id: "unrelated-shape",
      type: "rectangle",
      customData: undefined,
      groupIds: [],
    }];
    const variants = [malformedElements, partialElements, mixedElements].map((elements, index) => ({
      ...complete,
      id: `invalid-classroom-time-${index}`,
      elements,
    })) as LibraryItems;

    expect(sanitizeLibraryItems(variants)).toEqual([]);
  });

  it("retains one complete validated Classroom Time widget with a reproducible shell", () => {
    const item = classroomTimeLibraryItem();
    const library = [item] as LibraryItems;

    expect(sanitizeLibraryItems(library)).toBe(library);
  });

  it("reconstructs a complete Classroom Time item without incidental native image fields", () => {
    const item = classroomTimeLibraryItem();
    const portable = {
      ...item,
      elements: item.elements.map((element) => element.type === "image" ? {
        ...element,
        fileId: null,
        status: undefined,
      } : element),
    } as LibraryItems[number];
    const library = [portable] as LibraryItems;

    expect(sanitizeLibraryItems(library)).toBe(library);
  });

  it("fails closed instead of throwing when a Classroom Time group array is malformed", () => {
    const item = classroomTimeLibraryItem();
    const malformed = {
      ...item,
      elements: item.elements.map((element, index) => index === 1 ? {
        ...element,
        groupIds: undefined,
      } : element),
    } as unknown as LibraryItems[number];

    expect(() => sanitizeLibraryItems([malformed])).not.toThrow();
    expect(sanitizeLibraryItems([malformed])).toEqual([]);
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

  it("does not persist arbitrary images while retaining complete Classroom Time widgets", async () => {
    getMock.mockResolvedValue(undefined);
    await loadLibraryItems();
    setMock.mockResolvedValue(undefined);
    const complete = classroomTimeLibraryItem();

    await saveLibraryItems([arbitraryImageLibraryItem(), complete]);

    expect(setMock).toHaveBeenCalledWith("patterdraw:library:v1", [complete]);
  });
});
