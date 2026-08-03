import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const { exportToBlobMock } = vi.hoisted(() => ({ exportToBlobMock: vi.fn() }));

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: exportToBlobMock,
  viewportCoordsToSceneCoords: (
    { clientX, clientY }: { clientX: number; clientY: number },
    appState: { zoom: { value: number }; offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number },
  ) => ({
    x: (clientX - appState.offsetLeft) / appState.zoom.value - appState.scrollX,
    y: (clientY - appState.offsetTop) / appState.zoom.value - appState.scrollY,
  }),
  convertToExcalidrawElements: (elements: Array<Record<string, unknown>>) => elements.map((element) => ({
    angle: 0,
    backgroundColor: "transparent",
    boundElements: null,
    fillStyle: "solid",
    frameId: null,
    groupIds: [],
    index: "a0",
    isDeleted: false,
    link: null,
    opacity: 100,
    roughness: 0,
    seed: 1,
    strokeColor: "transparent",
    strokeStyle: "solid",
    strokeWidth: 1,
    updated: 1,
    version: 1,
    versionNonce: 1,
    ...element,
  })),
}));

import { exportToBlob } from "@excalidraw/excalidraw";
import {
  MAX_SCREENSHOT_BYTES,
  beginPngClipboardWrite,
  createScreenshotExportFrame,
  downsamplePngToByteLimit,
  exportScreenshotArea,
  getScreenshotExportDimensions,
  normalizeCaptureRect,
  viewportCaptureRectToSceneBounds,
} from "./capture";

function pngBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "image/png" });
}

describe("area screenshot geometry", () => {
  it("normalizes reverse drags and clamps them to the active editor", () => {
    expect(normalizeCaptureRect(
      { x: 460, y: 330 },
      { x: -20, y: 80 },
      { width: 400, height: 300 },
    )).toEqual({ x: 0, y: 80, width: 400, height: 220 });
  });

  it("converts the exact viewport rectangle into scene coordinates", () => {
    const appState = {
      offsetLeft: 12,
      offsetTop: 20,
      scrollX: 100,
      scrollY: -40,
      zoom: { value: 2 },
    } as AppState;
    expect(viewportCaptureRectToSceneBounds(
      { x: 20, y: 30, width: 240, height: 160 },
      { x: 12, y: 20 },
      appState,
    )).toEqual({ x: -90, y: 55, width: 120, height: 80 });
  });

  it("creates an export-only frame with the exact scene bounds", () => {
    const frame = createScreenshotExportFrame({ x: -15.5, y: 22.25, width: 310.5, height: 140.25 });
    expect(frame).toMatchObject({
      type: "frame",
      x: -15.5,
      y: 22.25,
      width: 310.5,
      height: 140.25,
      locked: true,
    });
  });
});

describe("area screenshot limits", () => {
  it("uses a crisp two-times export for ordinary selections", () => {
    expect(getScreenshotExportDimensions(600, 400)).toEqual({
      width: 1_200,
      height: 800,
      scale: 2,
    });
  });

  it("caps long edges and total pixels while preserving aspect ratio", () => {
    const wide = getScreenshotExportDimensions(4_000, 1_000);
    expect(wide.width).toBe(2_048);
    expect(wide.height).toBe(512);
    expect(wide.width * wide.height).toBeLessThanOrEqual(4_000_000);
    const square = getScreenshotExportDimensions(1_700, 1_700);
    expect(square.width).toBe(2_000);
    expect(square.height).toBe(2_000);
    expect(square.width * square.height).toBe(4_000_000);
  });

  it("downsamples PNGs that exceed the byte limit", async () => {
    const oversized = pngBlob(MAX_SCREENSHOT_BYTES + 1_000_000);
    const resized = pngBlob(MAX_SCREENSHOT_BYTES - 1);
    const resizer = vi.fn().mockResolvedValue(resized);
    const result = await downsamplePngToByteLimit(oversized, 2_000, 1_000, resizer);
    expect(result.blob).toBe(resized);
    expect(result.width).toBeLessThan(2_000);
    expect(result.height).toBeLessThan(1_000);
    expect(resizer).toHaveBeenCalledTimes(1);
  });
});

describe("area screenshot export", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports only the active scene through a non-scene frame with overflow clipping disabled", async () => {
    const elements = [
      { id: "inside", type: "rectangle", isDeleted: false },
      { id: "overflow", type: "freedraw", frameId: "slide", isDeleted: false },
      { id: "pdf-background", type: "image", locked: true, isDeleted: false },
      { id: "deleted", type: "ellipse", isDeleted: true },
      { id: "blocked", type: "iframe", isDeleted: false },
    ];
    const files = { pdf: { id: "pdf", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } };
    const api = {
      getSceneElements: () => elements,
      getFiles: () => files,
      getAppState: () => ({
        viewBackgroundColor: "#f2f4f7",
        frameRendering: { enabled: true, clip: true, name: true, outline: true },
      }),
    } as unknown as ExcalidrawImperativeAPI;
    vi.mocked(exportToBlob).mockImplementationOnce(async (request: Parameters<typeof exportToBlob>[0]) => {
      request.getDimensions?.(320, 180);
      return pngBlob(100);
    });

    await expect(exportScreenshotArea(api, { x: 40, y: 60, width: 320, height: 180 }))
      .resolves.toMatchObject({ width: 640, height: 360, sceneWidth: 320, sceneHeight: 180 });
    const request = vi.mocked(exportToBlob).mock.calls[0][0];
    expect(request.elements).toEqual(elements.slice(0, 3));
    expect(request.files).toBe(files);
    expect(request.exportPadding).toBe(0);
    expect(request.exportingFrame).toMatchObject({ x: 40, y: 60, width: 320, height: 180 });
    expect(elements).not.toContain(request.exportingFrame);
    expect(request.appState).toMatchObject({
      exportBackground: true,
      exportEmbedScene: false,
      exportWithDarkMode: false,
      viewBackgroundColor: "#f2f4f7",
      frameRendering: { clip: false, name: false, outline: false },
    });
  });

  it("uses a canonical source override instead of a transient display raster", async () => {
    const liveElements = [{ id: "dark-pdf", type: "image", isDeleted: false }];
    const lightElements = [{ id: "light-pdf", type: "image", isDeleted: false }];
    const liveFiles = { dark: { id: "dark" } };
    const lightFiles = { light: { id: "light" } };
    const api = {
      getSceneElements: () => liveElements,
      getFiles: () => liveFiles,
      getAppState: () => ({ frameRendering: {} }),
    } as unknown as ExcalidrawImperativeAPI;
    vi.mocked(exportToBlob).mockResolvedValueOnce(pngBlob(100));

    await exportScreenshotArea(
      api,
      { x: 0, y: 0, width: 100, height: 100 },
      { elements: lightElements as never, files: lightFiles as never },
    );

    const request = vi.mocked(exportToBlob).mock.calls.at(-1)?.[0];
    expect(request?.elements).toEqual(lightElements);
    expect(request?.files).toBe(lightFiles);
  });
});

describe("screenshot clipboard", () => {
  it("starts the clipboard write before the promised PNG has finished rendering", async () => {
    let resolvePng!: (blob: Blob) => void;
    const pendingPng = new Promise<Blob>((resolve) => { resolvePng = resolve; });
    const write = vi.fn().mockResolvedValue(undefined);
    class TestClipboardItem {
      constructor(public readonly data: Record<string, Blob | Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });

    const result = beginPngClipboardWrite(pendingPng);
    expect(write).toHaveBeenCalledTimes(1);
    resolvePng(pngBlob(10));
    await expect(result).resolves.toBe("success");
    vi.unstubAllGlobals();
  });
});
