import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDocumentMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
}));

const { assertPdfEmbeddedImageLimitMock } = vi.hoisted(() => ({
  assertPdfEmbeddedImageLimitMock: vi.fn(async (
    _bytes: Uint8Array,
    _maxPixels: number,
    _options?: { maxEdge?: number },
  ) => undefined),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (elements: unknown[]) => elements,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: getDocumentMock,
}));

vi.mock("./embedded-image-limits", () => ({
  assertPdfEmbeddedImageLimit: assertPdfEmbeddedImageLimitMock,
}));

import { importPdf } from "./import-pdf";

const originalCreateElement = window.document.createElement.bind(window.document);

describe("PDF import PDF.js safety options", () => {
  const page = {
    cleanup: vi.fn(),
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
      rotation: 0,
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
  const documentProxy = {
    numPages: 1,
    getPage: vi.fn(async () => page),
  };
  const loadingTask = {
    promise: Promise.resolve(documentProxy),
    destroy: vi.fn(async () => undefined),
  };
  const canvas = {
    width: 1,
    height: 1,
    getContext: vi.fn(() => ({})),
    toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
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
    page.cleanup.mockClear();
    page.render.mockClear();
    documentProxy.getPage.mockClear();
    documentProxy.numPages = 1;
    loadingTask.destroy.mockClear();
  });

  it("passes bounded embedded-image and worker-canvas options to PDF.js", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "safe.pdf", {
      type: "application/pdf",
    });

    await importPdf(file);

    const options = getDocumentMock.mock.calls[0]?.[0] as {
      enableScripting?: boolean;
      isEvalSupported?: boolean;
      maxImageSize?: number;
      canvasMaxAreaInBytes?: number;
    } | undefined;
    expect(options).toEqual(expect.objectContaining({
      enableScripting: false,
      isEvalSupported: false,
      maxImageSize: 64_000_000,
      canvasMaxAreaInBytes: 64_000_000,
    }));
    expect(assertPdfEmbeddedImageLimitMock).toHaveBeenCalledOnce();
    expect(assertPdfEmbeddedImageLimitMock.mock.calls[0]?.[1]).toBe(64_000_000);
    expect(assertPdfEmbeddedImageLimitMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      maxEdge: 8_192,
    }));
  });

  it("rejects a same-size source replacement during import", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "changed.pdf", {
      type: "application/pdf",
    });
    vi.spyOn(file, "arrayBuffer")
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]).buffer)
      .mockResolvedValueOnce(new Uint8Array([4, 3, 2, 1]).buffer);

    await expect(importPdf(file)).rejects.toThrow(
      "The local PDF changed while it was being imported.",
    );
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("rejects before parsing when the import generation is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "aborted.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("caps generated page PNG bytes before retaining a scene", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "budget.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file, { maxEncodedBytesPerDocument: 0 }))
      .rejects.toThrow(/rendered pages are too large/i);
    expect(getDocumentMock).toHaveBeenCalledOnce();
  });

  it("rejects a PDF that exceeds the destination project's remaining page capacity", async () => {
    documentProxy.numPages = 3;
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "three-pages.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file, { maxPages: 2 }))
      .rejects.toThrow("The PDF has more than the 2-page capacity remaining in this project.");
    expect(documentProxy.getPage).not.toHaveBeenCalled();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("rejects an invalid destination page capacity before parsing", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "safe.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file, { maxPages: 0 }))
      .rejects.toThrow("The PDF page limit is invalid.");
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("destroys a pending PDF.js load when the import generation aborts", async () => {
    let resolveDocument!: (value: typeof documentProxy) => void;
    const pendingLoadingTask = {
      promise: new Promise<typeof documentProxy>((resolve) => { resolveDocument = resolve; }),
      destroy: vi.fn(async () => undefined),
    };
    getDocumentMock.mockReturnValueOnce(pendingLoadingTask);
    const controller = new AbortController();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "pending.pdf", {
      type: "application/pdf",
    });
    const pending = importPdf(file, { signal: controller.signal });
    await vi.waitFor(() => expect(getDocumentMock).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingLoadingTask.destroy).toHaveBeenCalledOnce();
    resolveDocument(documentProxy);
  });
});
