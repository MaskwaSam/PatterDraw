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

import { hasPdfByteSignature, importPdf, inspectPdfFile } from "./import-pdf";

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

  it("inspects page count and content identity without rasterizing pages", async () => {
    documentProxy.numPages = 3;
    const progress: Array<{
      documentPosition: number;
      documentTotal: number;
      phase: string;
    }> = [];
    const file = new File([PDF_BYTES], "inspect.pdf", { type: "application/octet-stream" });

    const inspected = await inspectPdfFile(file, {
      documentPosition: 2,
      documentTotal: 4,
      onProgress: (update) => progress.push(update),
    });

    expect(inspected).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pageCount: 3,
    });
    expect(inspected).not.toHaveProperty("bytes");
    expect(documentProxy.getPage).not.toHaveBeenCalled();
    expect(page.render).not.toHaveBeenCalled();
    expect(assertPdfEmbeddedImageLimitMock).not.toHaveBeenCalled();
    expect(progress).toContainEqual(expect.objectContaining({
      documentPosition: 2,
      documentTotal: 4,
      phase: "loading",
    }));
  });

  it("optionally retains an independent verified byte snapshot during inspection", async () => {
    const file = new File([PDF_BYTES], "retain.pdf", { type: "application/pdf" });
    const inspected = await inspectPdfFile(file, { retainBytes: true });
    expect(inspected.bytes).toEqual(PDF_BYTES);
    expect(inspected.bytes).not.toBe(PDF_BYTES);
  });

  it("imports selected source indices in order with fresh page identities", async () => {
    documentProxy.numPages = 4;
    const progress: Array<{
      phase: string;
      documentPosition: number;
      documentTotal: number;
      pagePosition: number;
      pageTotal: number;
    }> = [];
    const file = new File([PDF_BYTES], "original-name.pdf", { type: "application/pdf" });

    const imported = await importPdf(file, {
      documentId: "shared-document",
      sourceInstanceId: "source-instance-2",
      sourceName: "Periodic table.pdf",
      sourcePageIndices: [2, 0, 2],
      maxPages: 3,
      documentPosition: 2,
      documentTotal: 3,
      onProgress: (update) => progress.push(update),
    });

    expect(imported.source).toMatchObject({
      id: "shared-document",
      name: "Periodic table.pdf",
      pageCount: 4,
    });
    expect(imported.scenes.map((scene) => scene.pdfPage)).toEqual([
      expect.objectContaining({
        documentId: "shared-document",
        sourceInstanceId: "source-instance-2",
        sourceName: "Periodic table.pdf",
        pageIndex: 2,
      }),
      expect.objectContaining({ pageIndex: 0 }),
      expect.objectContaining({ pageIndex: 2 }),
    ]);
    expect(new Set(imported.scenes.map((scene) => scene.id)).size).toBe(3);
    expect(new Set(imported.scenes.map((scene) => scene.pdfPage?.backgroundElementId)).size).toBe(3);
    expect(new Set(imported.scenes.flatMap((scene) => Object.keys(scene.files))).size).toBe(3);
    expect(documentProxy.getPage.mock.calls.map((call) => (call as unknown as [number])[0])).toEqual([
      3, 1, 3,
      3, 1, 3,
    ]);
    expect(progress).toContainEqual(expect.objectContaining({
      phase: "rendering",
      documentPosition: 2,
      documentTotal: 3,
      pagePosition: 3,
      pageTotal: 3,
    }));
  });

  it("applies remaining capacity to selected output pages, not total source pages", async () => {
    documentProxy.numPages = 4;
    const file = new File([PDF_BYTES], "four-pages.pdf", { type: "application/pdf" });
    await expect(importPdf(file, { sourcePageIndices: [3], maxPages: 1 })).resolves.toMatchObject({
      source: { pageCount: 4 },
      scenes: [expect.objectContaining({ pdfPage: expect.objectContaining({ pageIndex: 3 }) })],
    });
  });

  it("rejects an out-of-range selected index after the authoritative page count", async () => {
    documentProxy.numPages = 2;
    const file = new File([PDF_BYTES], "two-pages.pdf", { type: "application/pdf" });
    await expect(importPdf(file, { sourcePageIndices: [2] }))
      .rejects.toThrow(/source page that does not exist/i);
    expect(documentProxy.getPage).not.toHaveBeenCalled();
    expect(page.render).not.toHaveBeenCalled();
  });

  it("detects a local source change against dialog inspection before full preflight", async () => {
    const changedBytes = Uint8Array.from(PDF_BYTES);
    changedBytes[changedBytes.length - 1] = 0x20;
    const file = new File([PDF_BYTES], "changed-after-dialog.pdf", { type: "application/pdf" });
    vi.spyOn(file, "arrayBuffer")
      .mockResolvedValueOnce(Uint8Array.from(PDF_BYTES).buffer)
      .mockResolvedValueOnce(changedBytes.buffer);

    const inspection = await inspectPdfFile(file);
    assertPdfEmbeddedImageLimitMock.mockClear();
    await expect(importPdf(file, { inspection })).rejects.toThrow(/changed after it was selected/i);
    expect(assertPdfEmbeddedImageLimitMock).not.toHaveBeenCalled();
  });

  it("validates batch progress and caller-supplied identities", async () => {
    const file = new File([PDF_BYTES], "safe.pdf", { type: "application/pdf" });
    await expect(importPdf(file, { documentPosition: 0, documentTotal: 2 }))
      .rejects.toThrow(/batch progress position/i);
    await expect(importPdf(file, { documentId: "documents/escape" }))
      .rejects.toThrow(/document identity/i);
    await expect(importPdf(file, { sourceInstanceId: "not valid" }))
      .rejects.toThrow(/source-instance identity/i);
    expect(getDocumentMock).not.toHaveBeenCalled();
  });
});
