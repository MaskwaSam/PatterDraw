import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDocumentMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
}));

const { assertPdfEmbeddedImageLimitMock } = vi.hoisted(() => ({
  assertPdfEmbeddedImageLimitMock: vi.fn(async () => undefined),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: getDocumentMock,
}));

vi.mock("./embedded-image-limits", () => ({
  assertPdfEmbeddedImageLimit: assertPdfEmbeddedImageLimitMock,
}));

import {
  createActivePdfPagePreviewKey,
  getActivePdfPagePreviewTarget,
  renderLightPdfPagePreview,
  shouldRenderLightPdfPageRefinement,
  type ActivePdfPagePreviewKeyInput,
} from "./active-page-preview";

const originalCreateElement = window.document.createElement.bind(window.document);

describe("active PDF page preview targets", () => {
  it("uses discrete DPR quality buckets capped by the device tier", () => {
    const common = {
      displayWidth: 612,
      displayHeight: 792,
      effectiveRotation: 0 as const,
      devicePixelRatio: 2,
    };
    expect(getActivePdfPagePreviewTarget({
      ...common,
      environment: { deviceMemory: 8, hardwareConcurrency: 8 },
    })).toMatchObject({
      width: 2_448,
      height: 3_168,
      quality: "sharp-4x",
      deviceTier: "standard",
      scale: 4,
    });
    expect(getActivePdfPagePreviewTarget({
      ...common,
      environment: { deviceMemory: 4, hardwareConcurrency: 8 },
    })).toMatchObject({
      width: 1_836,
      height: 2_376,
      quality: "sharp-3x",
      deviceTier: "low",
      scale: 3,
    });
    expect(getActivePdfPagePreviewTarget({
      ...common,
      environment: { deviceMemory: 2, hardwareConcurrency: 8 },
    })).toMatchObject({
      width: 1_224,
      height: 1_584,
      quality: "sharp-2x",
      deviceTier: "very-low",
      scale: 2,
    });
  });

  it("bounds oversized valid source geometry to every active-page raster guard", () => {
    const rasterBudget = {
      maxEdge: 8_192,
      maxPixelsPerPage: 16_000_000,
      maxPixelsPerDocument: 64_000_000,
    } as const;
    const target = getActivePdfPagePreviewTarget({
      displayWidth: 14_400,
      displayHeight: 10_000,
      effectiveRotation: 0,
      devicePixelRatio: 2,
      environment: { deviceMemory: 8 },
      rasterBudget,
    });
    expect(target.width).toBeLessThanOrEqual(rasterBudget.maxEdge);
    expect(target.height).toBeLessThanOrEqual(rasterBudget.maxEdge);
    expect(target.width * target.height).toBeLessThanOrEqual(
      rasterBudget.maxPixelsPerPage,
    );
    expect(target.scale).toBeLessThan(1);
  });

  it("treats persisted geometry as already source-rotation-applied", () => {
    const request = {
      displayWidth: 792,
      displayHeight: 612,
      devicePixelRatio: 1,
      environment: { deviceMemory: 8 },
    };
    const unrotated = getActivePdfPagePreviewTarget({
      ...request,
      effectiveRotation: 0,
    });
    const rotated = getActivePdfPagePreviewTarget({
      ...request,
      effectiveRotation: 90,
    });
    expect(rotated).toMatchObject({
      width: unrotated.width,
      height: unrotated.height,
      effectiveRotation: 90,
    });
    expect(() => getActivePdfPagePreviewTarget({
      ...request,
      effectiveRotation: 45 as 0,
    })).toThrow(/rotation is invalid/i);
  });

  it("skips light refinement only when canonical pixels meet both target edges", () => {
    expect(shouldRenderLightPdfPageRefinement(
      { width: 1_200, height: 1_600 },
      { width: 1_200, height: 1_600 },
    )).toBe(false);
    expect(shouldRenderLightPdfPageRefinement(
      { width: 1_300, height: 1_700 },
      { width: 1_200, height: 1_600 },
    )).toBe(false);
    expect(shouldRenderLightPdfPageRefinement(
      { width: 1_300, height: 1_599 },
      { width: 1_200, height: 1_600 },
    )).toBe(true);
  });
});

describe("active PDF page preview identity", () => {
  const base: ActivePdfPagePreviewKeyInput = {
    sourceSha256: "ab".repeat(32),
    pageIndex: 2,
    effectiveRotation: 90,
    theme: "light",
    quality: "sharp-4x",
    deviceTier: "standard",
    width: 2_448,
    height: 3_168,
    occurrenceId: "scene-one",
  };

  it("is deterministic and includes every source, render, and occurrence field", () => {
    const key = createActivePdfPagePreviewKey(base);
    expect(createActivePdfPagePreviewKey({
      ...base,
      sourceSha256: base.sourceSha256.toUpperCase(),
    })).toBe(key);
    const variants: ActivePdfPagePreviewKeyInput[] = [
      { ...base, sourceSha256: "cd".repeat(32) },
      { ...base, pageIndex: 3 },
      { ...base, effectiveRotation: 180 },
      { ...base, theme: "dark" },
      { ...base, quality: "sharp-3x" },
      { ...base, deviceTier: "low" },
      { ...base, width: base.width + 1 },
      { ...base, height: base.height + 1 },
      { ...base, occurrenceId: "scene-two" },
    ];
    for (const variant of variants) {
      expect(createActivePdfPagePreviewKey(variant)).not.toBe(key);
    }
  });
});

describe("light active PDF page rendering", () => {
  const canvas = {
    width: 1,
    height: 1,
    getContext: vi.fn(() => ({})),
    toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
  };
  const renderCancel = vi.fn();
  const page = {
    cleanup: vi.fn(),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
      rotation: 90,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: renderCancel })),
  };
  const documentProxy = {
    numPages: 4,
    getPage: vi.fn(async () => page),
  };
  const loadingTask = {
    promise: Promise.resolve(documentProxy),
    destroy: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    getDocumentMock.mockReset().mockReturnValue(loadingTask);
    assertPdfEmbeddedImageLimitMock.mockClear();
    vi.spyOn(window.document, "createElement").mockImplementation((tagName, options) => (
      tagName.toLowerCase() === "canvas"
        ? canvas as unknown as HTMLElement
        : originalCreateElement(tagName, options)
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext.mockClear();
    canvas.toDataURL.mockReset().mockReturnValue("data:image/png;base64,AA==");
    page.cleanup.mockClear();
    page.getViewport.mockClear();
    page.render.mockReset().mockReturnValue({
      promise: Promise.resolve(),
      cancel: renderCancel,
    });
    renderCancel.mockClear();
    documentProxy.getPage.mockClear();
    loadingTask.destroy.mockClear();
  });

  it("selects the exact page and gives PDF.js only a clone of source bytes", async () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    getDocumentMock.mockImplementationOnce((options: { data: Uint8Array }) => {
      expect(options.data).not.toBe(sourceBytes);
      options.data[0] = 99;
      return loadingTask;
    });

    await expect(renderLightPdfPagePreview({
      bytes: sourceBytes,
      immutableSha256: "ab".repeat(32),
      pageIndex: 2,
      effectiveRotation: 90,
      width: 612,
      height: 792,
    })).resolves.toEqual({
      dataURL: "data:image/png;base64,AA==",
      width: 612,
      height: 792,
    });

    expect(sourceBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(documentProxy.getPage).toHaveBeenCalledWith(3);
    expect(assertPdfEmbeddedImageLimitMock).toHaveBeenCalledWith(
      sourceBytes,
      32_000_000,
      expect.objectContaining({ immutableSha256: "ab".repeat(32) }),
    );
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });

  it("renders a view-rotated refinement in display orientation while validating source rotation", async () => {
    const sourceContext = { drawImage: vi.fn() };
    const outputContext = {
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    };
    const sourceCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => sourceContext),
      toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
    };
    const outputCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => outputContext),
      toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
    };
    const createElement = window.document.createElement as unknown as {
      mockImplementationOnce: (implementation: (...args: unknown[]) => unknown) => unknown;
    };
    createElement.mockImplementationOnce(() => sourceCanvas);
    createElement.mockImplementationOnce(() => outputCanvas);

    await expect(renderLightPdfPagePreview({
      bytes: new Uint8Array([1]),
      pageIndex: 0,
      effectiveRotation: 180,
      sourceRotation: 90,
      viewRotation: 90,
      width: 792,
      height: 612,
    })).resolves.toEqual({
      dataURL: "data:image/png;base64,AA==",
      width: 792,
      height: 612,
    });
    expect(sourceCanvas.width).toBe(0);
    expect(sourceCanvas.height).toBe(0);
    expect(outputCanvas.width).toBe(0);
    expect(outputCanvas.height).toBe(0);
    expect(outputContext.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(outputContext.drawImage).toHaveBeenCalledWith(sourceCanvas, 0, 0);
  });

  it("keeps non-square preview dimensions unswapped for a 180-degree view turn", async () => {
    const sourceContext = {};
    const outputContext = {
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
    };
    const sourceCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => sourceContext),
      toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
    };
    const outputCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => outputContext),
      toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
    };
    const createElement = window.document.createElement as unknown as {
      mockImplementationOnce: (implementation: (...args: unknown[]) => unknown) => unknown;
    };
    createElement.mockImplementationOnce(() => sourceCanvas);
    createElement.mockImplementationOnce(() => outputCanvas);

    await expect(renderLightPdfPagePreview({
      bytes: new Uint8Array([1]),
      pageIndex: 0,
      effectiveRotation: 270,
      sourceRotation: 90,
      viewRotation: 180,
      width: 612,
      height: 792,
    })).resolves.toEqual({
      dataURL: "data:image/png;base64,AA==",
      width: 612,
      height: 792,
    });
    expect(outputContext.translate).toHaveBeenCalledWith(612, 792);
    expect(outputContext.rotate).toHaveBeenCalledWith(Math.PI);
  });

  it("rejects a source rotation mismatch before allocating a canvas", async () => {
    await expect(renderLightPdfPagePreview({
      bytes: new Uint8Array([1]),
      pageIndex: 0,
      effectiveRotation: 0,
      width: 612,
      height: 792,
    })).rejects.toThrow(/rotation no longer matches/i);
    expect(window.document.createElement).not.toHaveBeenCalledWith("canvas");
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("cancels an obsolete render and promptly releases its resources", async () => {
    let settleRender!: () => void;
    page.render.mockReturnValueOnce({
      promise: new Promise<void>((resolve) => { settleRender = resolve; }),
      cancel: renderCancel,
    });
    const controller = new AbortController();
    const pending = renderLightPdfPagePreview({
      bytes: new Uint8Array([1]),
      pageIndex: 0,
      effectiveRotation: 90,
      width: 612,
      height: 792,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(renderCancel).toHaveBeenCalledOnce();
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
    settleRender();
  });

  it("does not start preflight or PDF.js for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderLightPdfPagePreview({
      bytes: new Uint8Array([1]),
      pageIndex: 0,
      effectiveRotation: 90,
      width: 612,
      height: 792,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(assertPdfEmbeddedImageLimitMock).not.toHaveBeenCalled();
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("releases the page, document, and canvas when PNG encoding fails", async () => {
    canvas.toDataURL.mockImplementationOnce(() => {
      throw new Error("encode failed");
    });
    await expect(renderLightPdfPagePreview({
      bytes: new Uint8Array([1]),
      pageIndex: 0,
      effectiveRotation: 90,
      width: 612,
      height: 792,
    })).rejects.toThrow("encode failed");
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });
});
