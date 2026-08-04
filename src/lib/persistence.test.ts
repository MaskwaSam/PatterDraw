import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";

const { createStoreMock, delManyMock, getMock, keysMock, setManyMock } = vi.hoisted(() => ({
  createStoreMock: vi.fn(),
  delManyMock: vi.fn(),
  getMock: vi.fn(),
  keysMock: vi.fn(),
  setManyMock: vi.fn(),
}));

vi.mock("idb-keyval", () => ({
  createStore: createStoreMock,
  delMany: delManyMock,
  get: getMock,
  keys: keysMock,
  setMany: setManyMock,
}));

import {
  autosaveManifestsMatch,
  clearAutosave,
  commitAutosaveClearTransaction,
  commitAutosaveMigrationTransaction,
  commitAutosaveTransaction,
  getAutosaveWriteEntries,
  getStaleAutosaveKeys,
  loadAutosave,
  saveAutosave,
  validateAutosaveSnapshotTransaction,
} from "./persistence";

const PDF_SHA256 = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const REVERSED_PDF_SHA256 = "ee10da4aefe61a37df1dee937ca3221afa3b2351f9ea34edbbb769573c6785f7";

function fakeTransactionStore(
  initialEntries: readonly [string, unknown][],
  putFailure?: Error,
) {
  const committed = new Map<string, unknown>(initialEntries);
  const staged = new Map(committed);
  const puts: string[] = [];
  const deletes: string[] = [];
  let pendingReads = 0;
  let completeScheduled = false;
  let aborted = false;
  const transaction = {
    error: null as Error | null,
    onabort: null as (() => void) | null,
    oncomplete: null as (() => void) | null,
    onerror: null as (() => void) | null,
    abort: vi.fn(() => {
      aborted = true;
      transaction.error = putFailure || new Error("Transaction aborted");
      transaction.onabort?.();
    }),
  };
  const request = <T>(result: T) => {
    pendingReads += 1;
    const value = {
      error: null as Error | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      result: undefined as T | undefined,
    };
    queueMicrotask(() => {
      if (aborted) return;
      value.result = result;
      value.onsuccess?.();
      pendingReads -= 1;
      if (pendingReads === 0 && !completeScheduled) {
        completeScheduled = true;
        queueMicrotask(() => {
          if (aborted) return;
          committed.clear();
          for (const [key, entry] of staged) committed.set(key, entry);
          transaction.oncomplete?.();
        });
      }
    });
    return value;
  };
  const store = {
    transaction,
    get: (key: string) => request(committed.get(key)),
    getAllKeys: () => request([...committed.keys()]),
    put: (value: unknown, key: string) => {
      puts.push(key);
      if (putFailure) throw putFailure;
      staged.set(key, value);
      return {};
    },
    delete: (key: string) => {
      deletes.push(key);
      staged.delete(key);
      return {};
    },
  };
  return {
    committed,
    deletes,
    puts,
    store: store as unknown as IDBObjectStore,
    transaction,
  };
}

describe("PatterDraw autosave persistence", () => {
  beforeEach(() => {
    delManyMock.mockReset();
    getMock.mockReset();
    keysMock.mockReset();
    keysMock.mockResolvedValue([]);
    setManyMock.mockReset();
  });

  it("identifies stale current and legacy PDF keys without touching unrelated storage", () => {
    expect(getStaleAutosaveKeys([
      "patterdraw:autosave:pdf:v1:keep",
      "patterdraw:autosave:pdf:v1:delete",
      "excalidraw-classroom:autosave:project:v1",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
      "patterdraw:screenshot-library:v1",
    ], new Set(["patterdraw:autosave:pdf:v1:keep"]))).toEqual([
      "patterdraw:autosave:pdf:v1:delete",
      "excalidraw-classroom:autosave:project:v1",
      "excalidraw-classroom:autosave:pdf:v1:legacy",
    ]);
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

  it("omits unchanged PDF bytes from an atomic autosave transaction", () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
      sha256: PDF_SHA256,
    };
    const storedProject = structuredClone(project);

    expect(getAutosaveWriteEntries(
      project,
      { pdf: pdfBytes },
      storedProject,
      ["patterdraw:autosave:pdf:v1:pdf"],
    )).toEqual([
      ["patterdraw:autosave:project:v1", expect.objectContaining({ id: project.id })],
    ]);
  });

  it("rewrites matching PDF bytes when a replacement save is requested", () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
      sha256: PDF_SHA256,
    };
    const storedProject = structuredClone(project);

    expect(getAutosaveWriteEntries(
      project,
      { pdf: pdfBytes },
      storedProject,
      ["patterdraw:autosave:pdf:v1:pdf"],
      true,
    )).toEqual([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
  });

  it("includes changed or missing PDF bytes in an atomic autosave transaction", () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
      sha256: PDF_SHA256,
    };
    const storedProject = structuredClone(project);
    storedProject.pdfDocuments.pdf.sha256 = REVERSED_PDF_SHA256;

    expect(getAutosaveWriteEntries(
      project,
      { pdf: pdfBytes },
      storedProject,
      ["patterdraw:autosave:pdf:v1:pdf"],
    )).toEqual([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
    expect(getAutosaveWriteEntries(
      project,
      { pdf: pdfBytes },
      project,
      [],
    )).toEqual([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
  });

  it("commits the production no-lock transaction without rewriting an unchanged PDF", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
      sha256: PDF_SHA256,
    };
    const pdfKey = "patterdraw:autosave:pdf:v1:pdf";
    const staleKey = "patterdraw:autosave:pdf:v1:stale";
    const legacyKey = "excalidraw-classroom:autosave:project:v1";
    const unrelatedKey = "patterdraw:library:v1";
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", structuredClone(project)],
      [pdfKey, pdfBytes],
      [staleKey, new Uint8Array([9])],
      [legacyKey, structuredClone(project)],
      [unrelatedKey, "keep"],
    ]);

    await commitAutosaveTransaction(
      transaction.store,
      project,
      { pdf: pdfBytes },
      new Set([pdfKey]),
    );

    expect(transaction.puts).toEqual(["patterdraw:autosave:project:v1"]);
    expect(transaction.deletes).toEqual([staleKey, legacyKey]);
    expect(transaction.committed.get(pdfKey)).toBe(pdfBytes);
    expect(transaction.committed.get(staleKey)).toBeUndefined();
    expect(transaction.committed.get(unrelatedKey)).toBe("keep");
    expect(transaction.transaction.abort).not.toHaveBeenCalled();
  });

  it("atomically rewrites a matching PDF during a no-lock replacement save", async () => {
    const project = createBlankProject();
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
      sha256: PDF_SHA256,
    };
    const pdfKey = "patterdraw:autosave:pdf:v1:pdf";
    const corruptBytes = new Uint8Array([4, 3, 2, 1]);
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", structuredClone(project)],
      [pdfKey, corruptBytes],
    ]);

    await commitAutosaveTransaction(
      transaction.store,
      project,
      { pdf: pdfBytes },
      new Set([pdfKey]),
      true,
    );

    expect(transaction.puts).toEqual([
      "patterdraw:autosave:project:v1",
      pdfKey,
    ]);
    expect(transaction.committed.get(pdfKey)).toBe(pdfBytes);
    expect(transaction.transaction.abort).not.toHaveBeenCalled();
  });

  it("aborts the production no-lock transaction when a write throws", async () => {
    const project = createBlankProject();
    const original = structuredClone(project);
    const failure = new Error("IndexedDB put failed");
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", original],
    ], failure);

    await expect(commitAutosaveTransaction(
      transaction.store,
      { ...project, title: "Replacement" },
      {},
      new Set(),
    )).rejects.toBe(failure);

    expect(transaction.transaction.abort).toHaveBeenCalledOnce();
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toBe(original);
  });

  it("does not migrate over a newer manifest when Web Locks are unavailable", async () => {
    const verified = createBlankProject();
    verified.title = "Verified older project";
    const newer = structuredClone(verified);
    newer.title = "Newer tab edit";
    newer.updatedAt = "2099-01-01T00:00:00.000Z";
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", newer],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      verified,
      false,
      { ...verified, titleMode: "custom" },
      [],
    )).resolves.toBe(false);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toBe(newer);
    expect(autosaveManifestsMatch(verified, newer)).toBe(false);
  });

  it("validates an unchanged normalized manifest without rewriting it", async () => {
    const project = createBlankProject();
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", structuredClone(project)],
    ]);

    await expect(validateAutosaveSnapshotTransaction(
      transaction.store,
      project,
      false,
    )).resolves.toBe(true);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
  });

  it("rejects a normalized snapshot superseded by another tab", async () => {
    const expected = createBlankProject();
    const newer = {
      ...structuredClone(expected),
      title: "Newer tab edit",
      titleMode: "custom" as const,
      updatedAt: "2099-01-01T00:00:00.000Z",
    };
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", newer],
    ]);

    await expect(validateAutosaveSnapshotTransaction(
      transaction.store,
      expected,
      false,
    )).resolves.toBe(false);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toBe(newer);
  });

  it("clears current and legacy autosaves in one transaction", async () => {
    const project = createBlankProject();
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:pdf:v1:current", new Uint8Array([1])],
      ["excalidraw-classroom:autosave:project:v1", project],
      ["excalidraw-classroom:autosave:pdf:v1:legacy", new Uint8Array([2])],
      ["patterdraw:library:v1", "keep"],
    ]);

    await commitAutosaveClearTransaction(transaction.store);

    expect([...transaction.committed.keys()]).toEqual(["patterdraw:library:v1"]);
    expect(transaction.puts).toEqual([]);
  });

  it("atomically migrates the exact verified legacy manifest", async () => {
    const legacy = createBlankProject();
    legacy.title = "Untitled classroom canvas";
    delete legacy.titleMode;
    const verified = { ...legacy, title: "PatterDraw canvas", titleMode: "default" as const };
    const pdfBytes = new Uint8Array([1, 2, 3, 4]);
    const transaction = fakeTransactionStore([
      ["excalidraw-classroom:autosave:project:v1", legacy],
      ["excalidraw-classroom:autosave:pdf:v1:pdf", pdfBytes],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      legacy,
      true,
      verified,
      [["pdf", pdfBytes]],
    )).resolves.toBe(true);

    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(verified);
    expect(transaction.committed.get("patterdraw:autosave:pdf:v1:pdf")).toBe(pdfBytes);
    expect(transaction.committed.has("excalidraw-classroom:autosave:project:v1")).toBe(false);
    expect(transaction.committed.has("excalidraw-classroom:autosave:pdf:v1:pdf")).toBe(false);
  });

  it.each([
    {
      name: "external links",
      element: { id: "unsafe", type: "rectangle", link: "https://example.invalid" },
      files: {},
      message: /External links/,
    },
    {
      name: "custom-data URLs",
      element: { id: "unsafe", type: "rectangle", customData: { url: "https://example.invalid" } },
      files: {},
      message: /External links/,
    },
    {
      name: "web embeds",
      element: { id: "unsafe", type: "embeddable" },
      files: {},
      message: /Web embeds/,
    },
    {
      name: "missing image data",
      element: { id: "unsafe", type: "image", fileId: "missing" },
      files: {},
      message: /missing its local data/,
    },
    {
      name: "unsafe image sources",
      element: { id: "unsafe", type: "image", fileId: "file" },
      files: {
        file: {
          id: "file",
          mimeType: "image/png",
          dataURL: "https://example.invalid/image.png",
        },
      },
      message: /unsafe local data/,
    },
  ])("rejects $name on the prepared low-memory save path", async ({ element, files, message }) => {
    const project = createBlankProject();
    project.scenes[project.activeSceneId].elements = [element];
    project.scenes[project.activeSceneId].files = files as Record<string, Record<string, unknown>>;

    await expect(saveAutosave(project, {}, { prepared: true })).rejects.toThrow(message);
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

  it("repairs a corrupt same-length PDF during a browser-wide replacement save", async () => {
    const project = createBlankProject();
    const replacementPdfBytes = new Uint8Array([1, 2, 3, 4]);
    const corruptPdfBytes = new Uint8Array([4, 3, 2, 1]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: replacementPdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const storedProject = structuredClone(project);
    storedProject.pdfDocuments.pdf.sha256 = PDF_SHA256;
    const store = new Map<string, ClassroomProject | Uint8Array>([
      ["patterdraw:autosave:project:v1", storedProject],
      ["patterdraw:autosave:pdf:v1:pdf", corruptPdfBytes],
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
      await saveAutosave(
        project,
        { pdf: replacementPdfBytes },
        { replacePdfBlobs: true },
      );
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
    expect(setManyMock).toHaveBeenNthCalledWith(1, [
      ["patterdraw:autosave:project:v1", expect.objectContaining({
        pdfDocuments: { pdf: expect.objectContaining({ sha256: PDF_SHA256 }) },
      })],
      ["patterdraw:autosave:pdf:v1:pdf", replacementPdfBytes],
    ]);
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

  it("keeps a completed autosave successful when stale-key cleanup fails", async () => {
    const project = createBlankProject();
    keysMock.mockResolvedValue([
      "patterdraw:autosave:project:v1",
      "patterdraw:autosave:pdf:v1:stale",
    ]);
    delManyMock.mockRejectedValueOnce(new Error("Cleanup failed"));
    const request = vi.fn(async (_name: string, operation: () => Promise<void>) => operation());
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    try {
      await expect(saveAutosave(project, {})).resolves.toMatchObject({
        totalBytes: expect.any(Number),
      });
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }

    expect(setManyMock).toHaveBeenCalledOnce();
    expect(delManyMock).toHaveBeenCalledWith(["patterdraw:autosave:pdf:v1:stale"]);
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

  it("persists legacy default-title ownership when loading the current autosave key", async () => {
    const project = createBlankProject();
    project.title = "Untitled classroom canvas";
    delete project.titleMode;
    getMock.mockResolvedValueOnce(project);

    await expect(loadAutosave()).resolves.toMatchObject({
      project: {
        title: "Untitled PatterDraw canvas",
        titleMode: "default",
      },
    });
    expect(setManyMock).toHaveBeenCalledWith([
      ["patterdraw:autosave:project:v1", expect.objectContaining({
        title: "Untitled PatterDraw canvas",
        titleMode: "default",
      })],
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
