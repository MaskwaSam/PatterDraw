import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../types";

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
      ["patterdraw:autosave:project:v1", expect.objectContaining({ id: project.id })],
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
    getMock.mockResolvedValueOnce(pdfBytes);
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
      ["patterdraw:autosave:project:v1", expect.objectContaining({ id: project.id })],
    ]);
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
