import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock("idb-keyval", () => ({ get: getMock, set: setMock }));

import {
  SCREENSHOT_LIBRARY_KEY,
  SCREENSHOT_LIBRARY_LIMIT,
  addScreenshotToLibrary,
  loadScreenshotLibrary,
  newestFirstScreenshots,
  saveScreenshotLibrary,
  type StoredScreenshot,
} from "./persistence";

function screenshot(id: string, createdAt: number): StoredScreenshot {
  return {
    id,
    createdAt,
    blob: new Blob([id], { type: "image/png" }),
    width: 200,
    height: 100,
    sceneWidth: 100,
    sceneHeight: 50,
  };
}

describe("Screenshot Library persistence", () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
  });

  it("starts empty when the versioned device library has not been created", async () => {
    getMock.mockResolvedValue(undefined);
    await expect(loadScreenshotLibrary()).resolves.toEqual([]);
  });

  it("validates the record and returns captures newest-first", async () => {
    getMock.mockResolvedValue({
      version: 1,
      items: [screenshot("old", 10), screenshot("new", 20)],
    });
    await expect(loadScreenshotLibrary()).resolves.toMatchObject([
      { id: "new" },
      { id: "old" },
    ]);
  });

  it("rejects malformed PNG metadata and duplicate IDs", async () => {
    getMock.mockResolvedValue({
      version: 1,
      items: [{ ...screenshot("bad", 10), blob: new Blob(["bad"], { type: "text/plain" }) }],
    });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/invalid image/);
    getMock.mockResolvedValue({ version: 1, items: [screenshot("same", 10), screenshot("same", 20)] });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/duplicate/);
  });

  it("keeps only the newest 50 captures when item 51 is added", () => {
    const existing = Array.from({ length: SCREENSHOT_LIBRARY_LIMIT }, (_, index) => (
      screenshot(`capture-${index}`, index + 1)
    ));
    const result = addScreenshotToLibrary(existing, screenshot("newest", 100));
    expect(result).toHaveLength(50);
    expect(result[0].id).toBe("newest");
    expect(result.some((item) => item.id === "capture-0")).toBe(false);
  });

  it("sorts without mutating the supplied list", () => {
    const items = [screenshot("old", 1), screenshot("new", 2)];
    expect(newestFirstScreenshots(items).map((item) => item.id)).toEqual(["new", "old"]);
    expect(items.map((item) => item.id)).toEqual(["old", "new"]);
  });

  it("writes a separate versioned record containing the PNG blobs and dimensions", async () => {
    const item = screenshot("saved", 30);
    setMock.mockResolvedValue(undefined);
    await saveScreenshotLibrary([item]);
    expect(setMock).toHaveBeenCalledWith(SCREENSHOT_LIBRARY_KEY, {
      version: 1,
      items: [item],
    });
  });
});
