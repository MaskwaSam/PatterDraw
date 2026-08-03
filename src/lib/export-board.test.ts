import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

vi.mock("@excalidraw/excalidraw", () => ({ exportToBlob: vi.fn() }));

import { exportFullBoardPng, getBoardExportDimensions } from "./export-board";

describe("full-board export dimensions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses a crisp two-times scale for an ordinary board", () => {
    expect(getBoardExportDimensions(1_200, 800)).toEqual({
      width: 2_400,
      height: 1_600,
      scale: 2,
    });
  });

  it("keeps every element while scaling a large board below the safety caps", () => {
    const result = getBoardExportDimensions(20_000, 10_000);
    expect(result.width).toBeLessThanOrEqual(8_192);
    expect(result.height).toBeLessThanOrEqual(8_192);
    expect(result.width * result.height).toBeLessThanOrEqual(16_000_000);
    expect(result.width / result.height).toBeCloseTo(2, 2);
    expect(result.scale).toBeLessThan(1);
  });

  it("still respects both bitmap caps for objects a million canvas units apart", () => {
    const result = getBoardExportDimensions(1_000_000, 1_000_000);
    expect(result.width).toBeLessThanOrEqual(8_192);
    expect(result.height).toBeLessThanOrEqual(8_192);
    expect(result.width * result.height).toBeLessThanOrEqual(16_000_000);
    expect(result.width).toBe(result.height);
    expect(result.scale).toBeLessThan(0.01);
  });

  it("rejects non-finite board bounds instead of returning invalid dimensions", () => {
    expect(() => getBoardExportDimensions(Number.POSITIVE_INFINITY, 800)).toThrow(/must be finite/);
  });

  it("never creates a zero-sized bitmap", () => {
    expect(getBoardExportDimensions(0, 0)).toEqual({
      width: 2,
      height: 2,
      scale: 2,
    });
  });

  it("exports the complete live scene with local files and frame clipping disabled", async () => {
    const elements = [
      { id: "left", type: "rectangle", x: -800, y: -200, isDeleted: false },
      { id: "equation", type: "image", x: 4_000, y: 2_000, isDeleted: false },
      { id: "deleted", type: "text", isDeleted: true },
      { id: "unsafe", type: "iframe", isDeleted: false },
    ];
    const files = { equation: { id: "equation", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" } };
    const api = {
      getSceneElements: () => elements,
      getFiles: () => files,
      getAppState: () => ({
        exportBackground: false,
        frameRendering: { enabled: true, clip: true, name: true, outline: true },
      }),
    } as unknown as ExcalidrawImperativeAPI;
    const png = new Blob(["png"], { type: "image/png" });
    vi.mocked(exportToBlob).mockResolvedValueOnce(png);

    await expect(exportFullBoardPng(api)).resolves.toMatchObject({ blob: png });
    const request = vi.mocked(exportToBlob).mock.calls.at(-1)?.[0];
    expect(request?.elements).toEqual(elements.slice(0, 2));
    expect(request?.files).toBe(files);
    expect(request?.appState).toMatchObject({
      exportBackground: true,
      exportEmbedScene: true,
      exportWithDarkMode: false,
      viewBackgroundColor: "#ffffff",
      frameRendering: { clip: false },
    });
    expect(request?.getDimensions?.(20_000, 10_000)).toMatchObject({
      width: 5_656,
      height: 2_828,
    });
  });

  it("rejects an empty or fully blocked board", async () => {
    const api = {
      getSceneElements: () => [{ id: "unsafe", type: "embeddable", isDeleted: false }],
      getFiles: () => ({}),
      getAppState: () => ({}),
    } as unknown as ExcalidrawImperativeAPI;
    await expect(exportFullBoardPng(api)).rejects.toThrow(/before exporting/);
    expect(exportToBlob).not.toHaveBeenCalled();
  });

  it("accepts a canonical source override for transient display-only files", async () => {
    const liveElements = [{ id: "dark-pdf", type: "image", isDeleted: false }];
    const lightElements = [{ id: "light-pdf", type: "image", isDeleted: false }];
    const liveFiles = { dark: { id: "dark" } };
    const lightFiles = { light: { id: "light" } };
    const api = {
      getSceneElements: () => liveElements,
      getFiles: () => liveFiles,
      getAppState: () => ({ frameRendering: {} }),
    } as unknown as ExcalidrawImperativeAPI;
    vi.mocked(exportToBlob).mockResolvedValueOnce(new Blob(["png"], { type: "image/png" }));

    await exportFullBoardPng(api, {
      elements: lightElements as never,
      files: lightFiles as never,
    });

    const request = vi.mocked(exportToBlob).mock.calls.at(-1)?.[0];
    expect(request?.elements).toEqual(lightElements);
    expect(request?.files).toBe(lightFiles);
  });
});
