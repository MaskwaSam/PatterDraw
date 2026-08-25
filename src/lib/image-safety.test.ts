import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLocalProjectRasterUsage,
  assertLocalProjectRasterBudget,
  clearLocalImageSafetyCache,
  generateSafeLocalImageFileId,
  inspectLocalImageDataUrl,
  inspectLocalImageBlob,
  inspectLocalProjectRasterUsage,
  getLocalImageRasterBudget,
  MAX_LOCAL_IMAGE_PIXELS,
  MAX_LOCAL_SVG_COMPLEXITY,
  hasExcalidrawPngSceneMetadata,
  isWrapperOwnedImageDrop,
  remainingLocalProjectRasterCapacity,
  stripExcalidrawSvgSceneMetadata,
} from "./image-safety";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64(bytes)}`;
}

function dataUrlBytes(value: string): Uint8Array {
  const payload = value.slice(value.indexOf(",") + 1);
  return Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function pngTextChunk(keyword: string, text: string): Uint8Array {
  const base = dataUrlBytes(png(1, 1));
  const data = new TextEncoder().encode(`${keyword}\0${text}`);
  const chunk = new Uint8Array(12 + data.length);
  chunk[0] = (data.length >>> 24) & 0xff;
  chunk[1] = (data.length >>> 16) & 0xff;
  chunk[2] = (data.length >>> 8) & 0xff;
  chunk[3] = data.length & 0xff;
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(data, 8);
  return Uint8Array.from([...base, ...chunk]);
}

function png(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return dataUrl("image/png", bytes);
}

function jpeg(): string {
  return dataUrl("image/jpeg", new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]));
}

function gif(): string {
  return dataUrl("image/gif", new Uint8Array([
    ...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0, 0, 0x3b,
  ]));
}

function webp(): string {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  bytes[20] = 10;
  bytes[24] = 0;
  bytes[27] = 0;
  return dataUrl("image/webp", bytes);
}

describe("offline persisted image safety", () => {
  afterEach(() => {
    clearLocalImageSafetyCache();
    vi.restoreAllMocks();
  });

  it.each([
    ["png", `data:image/png;base64,${PNG_1X1}`],
    ["jpeg", jpeg()],
    ["gif", gif()],
    ["webp", webp()],
    ["svg", dataUrl("image/svg+xml", new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><path d="M0 0h1"/></svg>',
    ))],
  ])("accepts a bounded local %s image", async (_kind, value) => {
    await expect(inspectLocalImageDataUrl(value)).resolves.toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
      pixels: expect.any(Number),
    });
  });

  it("preflights native PNG and JPEG files before browser decode", async () => {
    await expect(inspectLocalImageBlob(new File(
      [blobPart(dataUrlBytes(`data:image/png;base64,${PNG_1X1}`))],
      "classroom.png",
      { type: "image/png" },
    ))).resolves.toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    await expect(inspectLocalImageBlob(new File(
      [blobPart(dataUrlBytes(`data:image/png;base64,${PNG_1X1}`))],
      "classroom-with-parameters.png",
      { type: "IMAGE/PNG; charset=binary" },
    ))).resolves.toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    await expect(inspectLocalImageBlob(new File(
      [blobPart(dataUrlBytes(jpeg()))],
      "classroom.jpg",
      { type: "image/jpeg" },
    ))).resolves.toMatchObject({ mimeType: "image/jpeg", width: 1, height: 1 });
  });

  it("claims wrapper-owned PNG/SVG drops from safe metadata alone", () => {
    expect(isWrapperOwnedImageDrop({ name: "lesson.PNG", type: "" })).toBe(true);
    expect(isWrapperOwnedImageDrop({ name: "lesson.svg", type: "application/octet-stream" })).toBe(true);
    expect(isWrapperOwnedImageDrop({ name: "lesson.bin", type: "IMAGE/PNG; charset=binary" })).toBe(true);
    expect(isWrapperOwnedImageDrop({ name: "lesson.jpg", type: "image/jpeg" })).toBe(false);
    expect(isWrapperOwnedImageDrop({ name: "lesson.png.exe", type: "application/octet-stream" })).toBe(false);
    // The predicate only routes metadata claims. The byte preflight remains
    // authoritative and rejects extension/MIME false positives later.
  });

  it("detects Excalidraw scene metadata in PNG text chunks", async () => {
    const scenePng = pngTextChunk(
      "application/vnd.excalidraw+json",
      JSON.stringify({ type: "excalidraw", elements: [] }),
    );
    const ordinaryPng = pngTextChunk("Description", "Classroom image");
    expect(hasExcalidrawPngSceneMetadata(scenePng)).toBe(true);
    expect(hasExcalidrawPngSceneMetadata(ordinaryPng)).toBe(false);
    expect(hasExcalidrawPngSceneMetadata(dataUrlBytes(`data:image/png;base64,${PNG_1X1}`))).toBe(false);
    await expect(inspectLocalImageDataUrl(dataUrl("image/png", scenePng)))
      .rejects.toThrow(/embedded scene data/i);
    await expect(generateSafeLocalImageFileId(new File(
      [blobPart(scenePng)],
      "scene-bearing.png",
      { type: "image/png" },
    ))).rejects.toThrow(/embedded scene data/i);
    await expect(generateSafeLocalImageFileId(new File(
      [blobPart(ordinaryPng)],
      "ordinary-metadata.png",
      { type: "image/png" },
    ))).resolves.toEqual(expect.any(String));
  });

  it("rejects embedded Excalidraw metadata in persisted SVG data URLs", async () => {
    const sceneSvg = dataUrl("image/svg+xml", new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><metadata>payload-type:application/vnd.excalidraw+json</metadata><path d="M0 0h1"/></svg>',
    ));
    await expect(inspectLocalImageDataUrl(sceneSvg)).rejects.toThrow(/embedded scene data/i);
  });

  it("rejects native formats that cannot survive PatterDraw persistence", async () => {
    await expect(inspectLocalImageBlob(new File(
      [blobPart(new Uint8Array([0x42, 0x4d, 0, 0]))],
      "classroom.bmp",
      { type: "image/bmp" },
    ))).rejects.toThrow(/supports PNG, JPEG, GIF, WebP/i);
  });

  it("rejects native files whose declared MIME does not match their bytes", async () => {
    await expect(inspectLocalImageBlob(new File(
      [blobPart(dataUrlBytes(`data:image/png;base64,${PNG_1X1}`))],
      "forged.jpg",
      { type: "image/jpeg" },
    ))).rejects.toThrow(/invalid local data/i);
    await expect(inspectLocalImageBlob(new File(
      [blobPart(dataUrlBytes(jpeg()))],
      "forged.png",
      { type: "image/png" },
    ))).rejects.toThrow(/invalid local data/i);
  });

  it("rejects oversized native image dimensions from the header", async () => {
    await expect(inspectLocalImageBlob(new File(
      [blobPart(dataUrlBytes(png(9_000, 1)))],
      "oversized.png",
      { type: "image/png" },
    ))).rejects.toThrow(/dimensions|decode safely/i);
  });

  it("generates stable IDs after preflight using the canonical MIME", async () => {
    const bytes = dataUrlBytes(jpeg());
    const jpegFile = new File([blobPart(bytes)], "classroom.jpeg", { type: "image/jpeg" });
    const jpgFile = new File([blobPart(bytes)], "classroom.jpg", { type: "image/jpg" });
    await expect(generateSafeLocalImageFileId(jpegFile))
      .resolves.toBe(await generateSafeLocalImageFileId(jpgFile));
  });

  it("rejects an oversized intrinsic image before any browser decode", async () => {
    await expect(inspectLocalImageDataUrl(png(9_000, 1))).rejects.toThrow(/dimensions|decode safely/i);
    await expect(inspectLocalImageDataUrl(png(4_001, 4_001))).rejects.toThrow(/decode safely/i);
  });

  it("rejects malformed local image bytes before browser decode", async () => {
    await expect(inspectLocalImageDataUrl(dataUrl("image/png", new TextEncoder().encode("not-a-png"))))
      .rejects.toThrow(/invalid local data/i);
  });

  it("allows the standard SVG namespace but rejects active or remote resources", async () => {
    const namespaced = dataUrl("image/svg+xml", new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"/>',
    ));
    await expect(inspectLocalImageDataUrl(namespaced)).resolves.toBeTruthy();
    const external = dataUrl("image/svg+xml", new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/a.png"/></svg>',
    ));
    await expect(inspectLocalImageDataUrl(external)).rejects.toThrow(/external|active/i);
  });

  it("removes Excalidraw scene metadata while preserving safe SVG artwork", async () => {
    const source = new Blob([
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8">'
      + '<metadata><!-- payload-type:application/vnd.excalidraw+json -->'
      + '<!-- payload-version:2 --><!-- payload-start -->AA==<!-- payload-end --></metadata>'
      + '<rect width="12" height="8" fill="#2f6fed"/></svg>',
    ], { type: "image/svg+xml" });
    await expect(generateSafeLocalImageFileId(new File(
      [source],
      "embedded-scene.svg",
      { type: "image/svg+xml" },
    ))).rejects.toThrow(/embedded scene data/i);
    const result = await stripExcalidrawSvgSceneMetadata(source);
    const text = await result.text();
    expect(text).not.toContain("payload-type:application/vnd.excalidraw+json");
    expect(text).toContain("rect");
    await expect(inspectLocalImageBlob(result)).resolves.toMatchObject({
      mimeType: "image/svg+xml",
      width: 12,
      height: 8,
    });
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>.x{fill:url("https://example.invalid/a")}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>.x{fill:url(\'data:image/png;base64,AA==\')}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="data:image/png;base64,AA=="/></svg>',
  ])("rejects quoted CSS or nested raster/data resources in SVG", async (svg) => {
    await expect(inspectLocalImageDataUrl(dataUrl("image/svg+xml", new TextEncoder().encode(svg))))
      .rejects.toThrow(/external|active/i);
  });

  it("rejects an oversized SVG from its payload length before XML decoding", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const payloadLength = Math.ceil((MAX_LOCAL_SVG_COMPLEXITY + 1) / 3) * 4;
    await expect(inspectLocalImageDataUrl(
      `data:image/svg+xml;base64,${"A".repeat(payloadLength)}`,
    )).rejects.toThrow(/too complex/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it("derives tighter per-image and cumulative limits for low-memory devices", async () => {
    const lowMemory = { maxEdge: 4_096, maxPixelsPerPage: 4_000_000, maxPixelsPerDocument: 16_000_000 } as const;
    const budget = getLocalImageRasterBudget(lowMemory);
    expect(budget.maxPixelsPerImage).toBe(4_000_000);
    expect(budget.maxPixelsPerProject).toBe(16_000_000);
    await expect(inspectLocalImageDataUrl(png(2_001, 2_000), undefined, lowMemory))
      .rejects.toThrow(/decode safely/i);
    const info = await inspectLocalImageDataUrl(png(2_000, 2_000), undefined, lowMemory);
    expect(() => assertLocalProjectRasterBudget(info, { encodedBytes: 0, pixels: 16_000_000 }, lowMemory))
      .toThrow(/too large/i);
  });

  it("charges cumulative decoded pixels and encoded bytes", async () => {
    const first = await inspectLocalImageDataUrl(`data:image/png;base64,${PNG_1X1}`);
    expect(assertLocalProjectRasterBudget(first, { encodedBytes: 0, pixels: 0 })).toEqual({
      encodedBytes: first.encodedBytes,
      pixels: first.pixels,
    });
    expect(() => assertLocalProjectRasterBudget(
      { ...first, pixels: MAX_LOCAL_IMAGE_PIXELS, decodedBytes: MAX_LOCAL_IMAGE_PIXELS * 4 },
      { encodedBytes: 0, pixels: 64 * 1024 * 1024 },
    )).toThrow(/too large/i);
  });

  it("measures every retained scene file and exposes only the remaining project budget", async () => {
    const value = `data:image/png;base64,${PNG_1X1}`;
    const info = await inspectLocalImageDataUrl(value);
    const project = {
      scenes: {
        first: { id: "first", name: "First", elements: [], appState: {}, files: {
          a: { id: "a", dataURL: value },
        } },
        second: { id: "second", name: "Second", elements: [], appState: {}, files: {
          b: { id: "b", dataURL: value },
        } },
      },
    };
    const usage = await inspectLocalProjectRasterUsage(project);
    expect(usage).toEqual({
      encodedBytes: info.encodedBytes * 2,
      pixels: info.pixels * 2,
    });
    const remaining = remainingLocalProjectRasterCapacity(usage);
    expect(addLocalProjectRasterUsage(usage, remaining)).toEqual({
      encodedBytes: getLocalImageRasterBudget().maxEncodedBytesPerProject,
      pixels: getLocalImageRasterBudget().maxPixelsPerProject,
    });
    expect(() => addLocalProjectRasterUsage(
      usage,
      { ...remaining, pixels: remaining.pixels + 1 },
    )).toThrow(/too large/i);
  });

  it("honors abort before decoding", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(inspectLocalImageDataUrl(`data:image/png;base64,${PNG_1X1}`, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("closes a bitmap that resolves after abort", async () => {
    let resolveBitmap!: (bitmap: ImageBitmap) => void;
    const bitmapPromise = new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; });
    const close = vi.fn();
    const original = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(() => bitmapPromise),
    });
    const controller = new AbortController();
    const pending = inspectLocalImageDataUrl(`data:image/png;base64,${PNG_1X1}`, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolveBitmap({ width: 1, height: 1, close } as unknown as ImageBitmap);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(close).toHaveBeenCalledOnce();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: original });
  });
});
