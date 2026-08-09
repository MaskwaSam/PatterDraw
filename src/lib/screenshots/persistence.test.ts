import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const originalCreateImageBitmap = globalThis.createImageBitmap;

function pngBytes(): ArrayBuffer {
  const binary = atob(PNG_1X1_BASE64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pngBlob(type = "image/png"): Blob {
  return new Blob([pngBytes()], { type });
}

function screenshot(id: string, createdAt: number): StoredScreenshot {
  return {
    id,
    createdAt,
    blob: pngBlob(),
    width: 1,
    height: 1,
    sceneWidth: 100,
    sceneHeight: 50,
  };
}

describe("Screenshot Library persistence", () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
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

  it("falls back to the legacy Canvas Classroom storage key", async () => {
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      version: 1,
      items: [screenshot("legacy-brand", 10)],
    });
    await expect(loadScreenshotLibrary()).resolves.toMatchObject([{ id: "legacy-brand" }]);
    expect(getMock).toHaveBeenNthCalledWith(1, "patterdraw:screenshot-library:v1");
    expect(getMock).toHaveBeenNthCalledWith(2, "excalidraw-classroom:screenshot-library:v1");
  });

  it("rejects malformed PNG metadata and duplicate IDs", async () => {
    getMock.mockResolvedValue({
      version: 1,
      items: [{ ...screenshot("bad", 10), blob: new Blob(["bad"], { type: "image/png" }) }],
    });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/invalid image/);
    getMock.mockResolvedValue({ version: 1, items: [screenshot("same", 10), screenshot("same", 20)] });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/duplicate/);
  });

  it("rejects a valid PNG whose MIME type is forged", async () => {
    getMock.mockResolvedValue({
      version: 1,
      items: [{ ...screenshot("forged-mime", 10), blob: pngBlob("image/jpeg") }],
    });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/invalid image/);
  });

  it("rejects PNG metadata whose dimensions do not match its IHDR", async () => {
    const mismatched = { ...screenshot("mismatched", 10), width: 2 };
    getMock.mockResolvedValue({ version: 1, items: [mismatched] });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/dimensions/i);

    getMock.mockResolvedValue(undefined);
    await expect(saveScreenshotLibrary([mismatched])).rejects.toThrow(/dimensions/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects corrupted scene-space dimensions before insertion", async () => {
    const enormous = { ...screenshot("enormous-scene", 10), sceneWidth: 1e307 };
    getMock.mockResolvedValue({ version: 1, items: [enormous] });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/invalid image/i);

    getMock.mockResolvedValue(undefined);
    await expect(saveScreenshotLibrary([enormous])).rejects.toThrow(/invalid image/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects timestamps outside JavaScript's valid Date range", async () => {
    const invalidDate = { ...screenshot("invalid-date", 10), createdAt: Number.MAX_SAFE_INTEGER };
    getMock.mockResolvedValue({ version: 1, items: [invalidDate] });
    await expect(loadScreenshotLibrary()).rejects.toThrow(/invalid image/i);

    getMock.mockResolvedValue(undefined);
    await expect(saveScreenshotLibrary([invalidDate])).rejects.toThrow(/invalid image/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("falls back to a valid legacy record when canonical PNG bytes are malformed", async () => {
    const canonical = {
      version: 1,
      items: [{ ...screenshot("bad-canonical", 20), blob: new Blob(["not png"], { type: "image/png" }) }],
    };
    const legacy = { version: 1, items: [screenshot("valid-legacy", 10)] };
    getMock.mockResolvedValueOnce(canonical).mockResolvedValueOnce(legacy);

    await expect(loadScreenshotLibrary()).resolves.toMatchObject([{ id: "valid-legacy" }]);
  });

  it("recovers a valid legacy record when the canonical record is malformed", async () => {
    const legacy = { version: 1, items: [screenshot("recoverable-legacy", 10)] };
    getMock.mockResolvedValueOnce({ version: 1, items: [{ bad: true }] }).mockResolvedValueOnce(legacy);

    await expect(loadScreenshotLibrary()).resolves.toMatchObject([{ id: "recoverable-legacy" }]);
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
    getMock.mockResolvedValue(undefined);
    await loadScreenshotLibrary();
    setMock.mockResolvedValue(undefined);
    await saveScreenshotLibrary([item]);
    expect(setMock).toHaveBeenCalledWith(SCREENSHOT_LIBRARY_KEY, {
      version: 1,
      items: [item],
    });
  });

  it("rejects decoder failures before writing to IndexedDB", async () => {
    const decoder = vi.fn().mockRejectedValue(new Error("decoder failed"));
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: decoder,
    });
    getMock.mockResolvedValue(undefined);
    await expect(saveScreenshotLibrary([screenshot("decode-failure", 30)])).rejects.toThrow(/decoded safely/i);
    expect(decoder).toHaveBeenCalledOnce();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("closes decoded bitmaps after validating persisted PNGs", async () => {
    const close = vi.fn();
    const decoder = vi.fn().mockResolvedValue({ width: 1, height: 1, close });
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: decoder,
    });
    getMock.mockResolvedValue({ version: 1, items: [screenshot("decoded", 30)] });

    await expect(loadScreenshotLibrary()).resolves.toMatchObject([{ id: "decoded" }]);
    expect(decoder).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
