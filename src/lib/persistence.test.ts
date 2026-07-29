import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";

const { delManyMock, getMock, keysMock, setManyMock } = vi.hoisted(() => ({
  delManyMock: vi.fn(),
  getMock: vi.fn(),
  keysMock: vi.fn(),
  setManyMock: vi.fn(),
}));

vi.mock("idb-keyval", () => ({
  delMany: delManyMock,
  get: getMock,
  keys: keysMock,
  setMany: setManyMock,
}));

import { clearAutosave, loadAutosave, saveAutosave } from "./persistence";

const PDF_SHA256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const REVERSED_PDF_SHA256 = "ee10da4aefe61a37df1dee937ca3221afa3b2351f9ea34edbbb769573c6785f7";

describe("PatterDraw autosave persistence", () => {
  beforeEach(() => {
    delManyMock.mockReset();
    getMock.mockReset();
    keysMock.mockReset();
    keysMock.mockResolvedValue([]);
    setManyMock.mockReset();
  });

  it("writes the manifest and every referenced PDF in one atomic transaction", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };

    await saveAutosave(project, { pdf: pdfBytes });

    expect(setManyMock).toHaveBeenCalledTimes(1);
    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({
        id: project.id,
        pdfDocuments: {
          pdf: expect.objectContaining({ sha256: PDF_SHA256 }),
        },
      })],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
  });

  it("does not write a new manifest when referenced PDF data is incomplete", async () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };

    await expect(saveAutosave(project, {})).rejects.toThrow(
      "PDF data does not match project metadata for worksheet.pdf.",
    );
    expect(setManyMock).not.toHaveBeenCalled();
  });

  it("does not rewrite immutable PDF bytes while holding the browser-wide lock", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const storedProject = structuredClone(project);
    storedProject.pdfDocuments.pdf.sha256 = PDF_SHA256;
    getMock.mockResolvedValueOnce(storedProject);
    keysMock.mockResolvedValueOnce(["patterdraw:autosave:pdf:v1:pdf"]);
    const request = vi.fn(async (_name: string, operation: () => Promise<void>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await saveAutosave(project, { pdf: pdfBytes });
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({
        id: project.id,
        pdfDocuments: {
          pdf: expect.objectContaining({ sha256: PDF_SHA256 }),
        },
      })],
    ]);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("patterdraw:autosave:project:v1");
    expect(getMock).not.toHaveBeenCalledWith("patterdraw:autosave:pdf:v1:pdf");
  });

  it("rewrites same-length PDF bytes when their content differs", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const storedProject = structuredClone(project);
    storedProject.pdfDocuments.pdf.sha256 = REVERSED_PDF_SHA256;
    getMock.mockResolvedValueOnce(storedProject);
    keysMock.mockResolvedValueOnce(["patterdraw:autosave:pdf:v1:pdf"]);
    const request = vi.fn(async (_name: string, operation: () => Promise<void>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await saveAutosave(project, { pdf: pdfBytes });
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({
        id: project.id,
        pdfDocuments: {
          pdf: expect.objectContaining({ sha256: PDF_SHA256 }),
        },
      })],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
  });

  it("rewrites a PDF when its matching manifest identity exists but its blob key is missing", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      sha256: PDF_SHA256,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock.mockResolvedValueOnce(structuredClone(project));
    keysMock.mockResolvedValueOnce(["patterdraw:autosave:project:v1"]);
    const request = vi.fn(async (_name: string, operation: () => Promise<void>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await saveAutosave(project, { pdf: pdfBytes });
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.any(Object)],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
  });

  it("loads replacement bytes after a same-ID same-length PDF save", async () => {
    const project = createBlankProject();
    const stalePdfBytes = new Uint8Array([4, 3, 2, 1]);
    const replacementPdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: replacementPdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const storedProject = structuredClone(project);
    storedProject.pdfDocuments.pdf.sha256 = REVERSED_PDF_SHA256;
    const store = new Map<string, ClassroomProject | Uint8Array>([
      ["patterdraw:autosave:project:v1", storedProject],
      ["patterdraw:autosave:pdf:v1:pdf", stalePdfBytes],
    ]);
    getMock.mockImplementation(async (key: string) => store.get(key));
    keysMock.mockImplementation(async () => [...store.keys()]);
    setManyMock.mockImplementation(async (
      entries: [string, ClassroomProject | Uint8Array][],
    ) => {
      for (const [key, value] of entries) store.set(key, value);
    });
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await saveAutosave(project, { pdf: replacementPdfBytes });
      await expect(loadAutosave()).resolves.toMatchObject({
        project: { id: project.id },
        pdfBytes: { pdf: replacementPdfBytes },
      });
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(store.get("patterdraw:autosave:pdf:v1:pdf")).toBe(replacementPdfBytes);
    expect(store.get("patterdraw:autosave:project:v1")).toMatchObject({
      pdfDocuments: { pdf: { sha256: PDF_SHA256 } },
    });
  });

  it("propagates an atomic transaction failure without attempting partial writes", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const failure = new Error("IndexedDB transaction aborted");
    setManyMock.mockRejectedValueOnce(failure);

    await expect(saveAutosave(project, { pdf: pdfBytes })).rejects.toBe(failure);
    expect(setManyMock).toHaveBeenCalledTimes(1);
    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({ id: project.id })],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
    expect(keysMock).not.toHaveBeenCalled();
  });

  it("does not delete PDF blobs during ordinary saves", async () => {
    const project = createBlankProject();
    keysMock.mockResolvedValue([
      "patterdraw:autosave:project:v1",
      "patterdraw:autosave:pdf:v1:deleted",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
      "patterdraw:library:v1",
    ]);

    await saveAutosave(project, {});

    expect(keysMock).not.toHaveBeenCalled();
    expect(delManyMock).not.toHaveBeenCalled();
  });

  it("runs mutations and stale-PDF cleanup under a browser-wide lock when available", async () => {
    const project = createBlankProject();
    const request = vi.fn(async (_name: string, operation: () => Promise<void>) => operation());
    const originalLocks = navigator.locks;
    keysMock.mockResolvedValue([
      "patterdraw:autosave:project:v1",
      "patterdraw:autosave:pdf:v1:deleted",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
      "patterdraw:library:v1",
    ]);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await saveAutosave(project, {});
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(request).toHaveBeenCalledWith(
      "patterdraw:autosave:mutation:v1",
      expect.any(Function),
    );
    expect(setManyMock).toHaveBeenCalledTimes(1);
    expect(delManyMock).toHaveBeenCalledWith([
      "patterdraw:autosave:pdf:v1:deleted",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
    ]);
  });

  it("loads a legacy Canvas Classroom autosave", async () => {
    const project = createBlankProject();
    getMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(project);
    await expect(loadAutosave()).resolves.toMatchObject({ project: { id: project.id }, pdfBytes: {} });
    expect(getMock).toHaveBeenNthCalledWith(1, "patterdraw:autosave:project:v1");
    expect(getMock).toHaveBeenNthCalledWith(2, "excalidraw-classroom:autosave:project:v1");
    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({ id: project.id })],
    ]);
  });

  it("loads legacy PDF bytes from the same namespace as the legacy manifest", async () => {
    const project = createBlankProject();
    const legacyPdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: legacyPdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(legacyPdfBytes);

    await expect(loadAutosave()).resolves.toMatchObject({
      project: {
        id: project.id,
        pdfDocuments: { pdf: expect.objectContaining({ sha256: PDF_SHA256 }) },
      },
      pdfBytes: { pdf: legacyPdfBytes },
    });
    expect(getMock).toHaveBeenNthCalledWith(
      3,
      "excalidraw-classroom:autosave:pdf:v1:pdf",
    );
    expect(getMock).not.toHaveBeenCalledWith("patterdraw:autosave:pdf:v1:pdf");
    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({
        pdfDocuments: { pdf: expect.objectContaining({ sha256: PDF_SHA256 }) },
      })],
      ["patterdraw:autosave:pdf:v1:pdf", legacyPdfBytes],
    ]);
    expect(delManyMock).toHaveBeenCalledWith([
      "excalidraw-classroom:autosave:project:v1",
      "excalidraw-classroom:autosave:pdf:v1:pdf",
    ]);
  });

  it("opens verified legacy data even when its best-effort migration cannot be written", async () => {
    const project = createBlankProject();
    const legacyPdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: legacyPdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(legacyPdfBytes);
    setManyMock.mockRejectedValueOnce(new Error("Quota exceeded"));

    await expect(loadAutosave()).resolves.toMatchObject({
      project: {
        pdfDocuments: { pdf: expect.objectContaining({ sha256: PDF_SHA256 }) },
      },
      pdfBytes: { pdf: legacyPdfBytes },
    });
    expect(delManyMock).not.toHaveBeenCalled();
  });

  it("retries a failed legacy-manifest cleanup during the next save", async () => {
    const project = createBlankProject();
    getMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project);
    keysMock.mockResolvedValueOnce([
      "patterdraw:autosave:project:v1",
      "excalidraw-classroom:autosave:project:v1",
    ]);
    delManyMock.mockRejectedValueOnce(new Error("Cleanup failed"));
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      const loaded = await loadAutosave();
      expect(loaded).not.toBeNull();
      await saveAutosave(loaded!.project, loaded!.pdfBytes);
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(delManyMock).toHaveBeenNthCalledWith(1, [
      "excalidraw-classroom:autosave:project:v1",
    ]);
    expect(delManyMock).toHaveBeenNthCalledWith(2, [
      "excalidraw-classroom:autosave:project:v1",
    ]);
  });

  it("does not substitute legacy PDF bytes for a missing current PDF", async () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(undefined);

    await expect(loadAutosave()).rejects.toThrow("Autosave is missing PDF data for pdf.");
    expect(getMock).not.toHaveBeenCalledWith("excalidraw-classroom:autosave:pdf:v1:pdf");
  });

  it("reads the manifest and its PDF bytes under the browser-wide lock", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(pdfBytes);
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await expect(loadAutosave()).resolves.toMatchObject({
        project: { id: project.id },
        pdfBytes: { pdf: pdfBytes },
      });
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(request).toHaveBeenCalledWith(
      "patterdraw:autosave:mutation:v1",
      expect.any(Function),
    );
  });

  it("rejects stale or partial autosaved PDF bytes", async () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(new Uint8Array([1, 2]));

    await expect(loadAutosave()).rejects.toThrow(/does not match project metadata/);
  });

  it("rejects same-length autosaved PDF bytes whose content identity differs", async () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      sha256: PDF_SHA256,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(new Uint8Array([4, 3, 2, 1]));

    await expect(loadAutosave()).rejects.toThrow(/content identity/);
    expect(setManyMock).not.toHaveBeenCalled();
  });

  it("clears both current and legacy autosave keys", async () => {
    keysMock.mockResolvedValueOnce([
      "patterdraw:autosave:pdf:v1:orphan",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
    ]);
    await clearAutosave();
    expect(delManyMock).toHaveBeenCalledWith([
      "patterdraw:autosave:project:v1",
      "excalidraw-classroom:autosave:project:v1",
      "patterdraw:autosave:pdf:v1:orphan",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
    ]);
  });
});
