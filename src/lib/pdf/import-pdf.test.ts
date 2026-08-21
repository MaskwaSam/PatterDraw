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

import { hasPdfByteSignature, importPdf } from "./import-pdf";

const originalCreateElement = window.document.createElement.bind(window.document);
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
]);

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
    documentProxy.numPages = 1;
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
    loadingTask.destroy.mockClear();
  });

  it("passes bounded embedded-image and worker-canvas options to PDF.js", async () => {
    const file = new File([PDF_BYTES], "safe.pdf", {
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
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 64_000_000,
    }));
    expect(assertPdfEmbeddedImageLimitMock).toHaveBeenCalledOnce();
    expect(assertPdfEmbeddedImageLimitMock.mock.calls[0]?.[1]).toBe(16_000_000);
    expect(assertPdfEmbeddedImageLimitMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      maxEdge: 8_192,
    }));
  });

  it("rejects a same-size source replacement during import", async () => {
    const changedBytes = Uint8Array.from(PDF_BYTES);
    changedBytes[changedBytes.length - 1] = 0x20;
    const file = new File([PDF_BYTES], "changed.pdf", {
      type: "application/pdf",
    });
    vi.spyOn(file, "arrayBuffer")
      .mockResolvedValueOnce(Uint8Array.from(PDF_BYTES).buffer)
      .mockResolvedValueOnce(changedBytes.buffer);

    await expect(importPdf(file)).rejects.toThrow(
      "The local PDF changed while it was being imported.",
    );
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  it("rejects before parsing when the import generation is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File([PDF_BYTES], "aborted.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(getDocumentMock).not.toHaveBeenCalled();
  });

  it("caps generated page PNG bytes before retaining a scene", async () => {
    const file = new File([PDF_BYTES], "budget.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file, { maxEncodedBytesPerDocument: 0 }))
      .rejects.toThrow(/rendered pages are too large/i);
    expect(getDocumentMock).toHaveBeenCalledOnce();
  });

  it("destroys a pending PDF.js load when the import generation aborts", async () => {
    let resolveDocument!: (value: typeof documentProxy) => void;
    const pendingLoadingTask = {
      promise: new Promise<typeof documentProxy>((resolve) => { resolveDocument = resolve; }),
      destroy: vi.fn(async () => undefined),
    };
    getDocumentMock.mockReturnValueOnce(pendingLoadingTask);
    const controller = new AbortController();
    const file = new File([PDF_BYTES], "pending.pdf", {
      type: "application/pdf",
    });
    const pending = importPdf(file, { signal: controller.signal });
    await vi.waitFor(() => expect(getDocumentMock).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingLoadingTask.destroy).toHaveBeenCalledOnce();
    resolveDocument(documentProxy);
  });

  it.each(["", "application/octet-stream", "application/x-pdf"])(
    "accepts a byte-valid PDF reported as %j",
    async (type) => {
      const file = new File([PDF_BYTES], "untrusted-label.bin", { type });
      await expect(importPdf(file)).resolves.toMatchObject({
        source: { mimeType: "application/pdf" },
      });
      expect(getDocumentMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects a spoofed .pdf extension before PDF.js or image preflight", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "spoofed.pdf", {
      type: "application/pdf",
    });
    await expect(importPdf(file)).rejects.toThrow(/valid PDF header/i);
    expect(getDocumentMock).not.toHaveBeenCalled();
    expect(assertPdfEmbeddedImageLimitMock).not.toHaveBeenCalled();
  });

  it("recognizes a PDF header after a permitted binary preamble", () => {
    const bytes = new Uint8Array(64);
    bytes.set(PDF_BYTES, 32);
    expect(hasPdfByteSignature(bytes)).toBe(true);
    expect(hasPdfByteSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });

  it("rejects a PDF that exceeds remaining scene capacity before page inspection", async () => {
    documentProxy.numPages = 2;
    const file = new File([PDF_BYTES], "two-pages.pdf", { type: "application/pdf" });
    await expect(importPdf(file, { maxPages: 1 })).rejects.toThrow(
      /has 2 pages, but only 1 more page can fit/i,
    );
    expect(documentProxy.getPage).not.toHaveBeenCalled();
    expect(page.render).not.toHaveBeenCalled();
  });

  it("reports structured document and page progress", async () => {
    const progress: Array<{
      operation: string;
      phase: string;
      documentPosition: number;
      documentTotal: number;
      pagePosition: number;
      pageTotal: number;
    }> = [];
    const file = new File([PDF_BYTES], "progress.pdf", { type: "application/pdf" });
    await importPdf(file, { onProgress: (update) => progress.push(update) });
    expect(progress).toContainEqual(expect.objectContaining({
      operation: "import",
      phase: "measuring",
      documentPosition: 1,
      documentTotal: 1,
      pagePosition: 1,
      pageTotal: 1,
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      operation: "import",
      phase: "rendering",
      pagePosition: 1,
      pageTotal: 1,
    }));
  });
});
