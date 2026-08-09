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
  AutosaveConflictError,
  autosaveManifestsMatch,
  autosaveManifestHash,
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
const VALID_PDF_BASE64 = "JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwMDY5MDA2RTAwMDY3MDAyRjAwNzAwMDY0MDA2NjAwMkQwMDZDMDA2OTAwMDYyMDAyOT4KL01vZERhdGUgKEQ6MjAyNjA4MDUwMTQ2MzFaKQovQ3JlYXRvciA8RkVGRjAwNzAwMDY0MDA2NjAwMkQwMDZDMDA2OTAwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDc0MDA3MDAwMDczMDAzQTAwMkYwMDJGMDA2NzAwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwMDY5MDA2RTAwMDY3MDAyRjAwNzAwMDY0MDA2NjAwMkQwMDZDMDA2OTAwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDgwNTAxNDYzMVopCj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQo+PgplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE2IDAwMDAwIG4gCjAwMDAwMDAwNzYgMDAwMDAgbiAKMDAwMDAwMDEyNiAwMDAwMCBuIAowMDAwMDAwNTk2IDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDUKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo2ODcKJSVFT0Y=";
const validPdfBytes = () => Uint8Array.from(atob(VALID_PDF_BASE64), (char) => char.charCodeAt(0));
const VALID_PDF_SHA256 = "08f4616dd16d922265360b998fd8ea5f792f6d5ead39e17377bcc2ac5a681572";

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

  it("rejects an already-aborted autosave load before reading storage", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(loadAutosave({ signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(getMock).not.toHaveBeenCalled();
  });

  it("writes the manifest and every referenced PDF in one atomic transaction", async () => {
    const project = createBlankProject();
    const pdfBytes = validPdfBytes();
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
        pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }),
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

  it("rolls back an active autosave transaction when cancellation arrives before commit", async () => {
    const project = createBlankProject();
    const original = structuredClone(project);
    const replacement = { ...structuredClone(project), title: "Obsolete replacement" };
    const controller = new AbortController();
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", original],
    ]);

    const commit = commitAutosaveTransaction(
      transaction.store,
      replacement,
      {},
      new Set(),
      false,
      undefined,
      controller.signal,
    );
    // All transaction reads run first and queue their writes. The fake store's
    // completion is a later microtask, matching IndexedDB's cancellable window.
    queueMicrotask(() => controller.abort());

    await expect(commit).rejects.toMatchObject({ name: "AbortError" });
    expect(transaction.transaction.abort).toHaveBeenCalledOnce();
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toBe(original);
  });

  it("reports a transaction commit when cancellation is already too late to roll it back", async () => {
    const project = createBlankProject();
    const replacement = { ...structuredClone(project), title: "Committed replacement" };
    const controller = new AbortController();
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", project],
    ]);
    transaction.transaction.abort.mockImplementationOnce(() => {
      throw new DOMException("The transaction is already committing.", "InvalidStateError");
    });

    const commit = commitAutosaveTransaction(
      transaction.store,
      replacement,
      {},
      new Set(),
      false,
      undefined,
      controller.signal,
    );
    queueMicrotask(() => controller.abort());

    await expect(commit).resolves.toMatchObject({ revision: expect.any(String) });
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(replacement);
  });

  it("commits a sidecar revision atomically with the manifest and PDF bytes", async () => {
    const project = createBlankProject();
    const next = { ...structuredClone(project), title: "Committed", titleMode: "custom" as const };
    const baseRevision = {
      schemaVersion: 1 as const,
      revision: "base-token",
      manifestHash: autosaveManifestHash(project)!,
      writerId: "tab-a",
      sequence: 1,
    };
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:revision:v1", baseRevision],
    ]);

    await expect(commitAutosaveTransaction(
      transaction.store,
      next,
      {},
      new Set(),
      false,
      {
        revision: baseRevision.revision,
        manifestHash: baseRevision.manifestHash,
        writerId: "tab-a",
        sequence: 2,
      },
    )).resolves.toMatchObject({ writerId: "tab-a", revision: expect.any(String) });

    expect(transaction.puts).toEqual([
      "patterdraw:autosave:project:v1",
      "patterdraw:autosave:revision:v1",
    ]);
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(next);
    expect(transaction.committed.get("patterdraw:autosave:revision:v1")).toMatchObject({
      manifestHash: autosaveManifestHash(next),
      writerId: "tab-a",
      sequence: 2,
    });
  });

  it("rejects a different writer's stale revision without touching newer data", async () => {
    const older = createBlankProject();
    const newer = { ...structuredClone(older), title: "Newer", titleMode: "custom" as const };
    const currentRevision = {
      schemaVersion: 1 as const,
      revision: "new-token",
      manifestHash: autosaveManifestHash(newer)!,
      writerId: "tab-b",
      sequence: 8,
    };
    const stalePdf = new Uint8Array([9]);
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", newer],
      ["patterdraw:autosave:revision:v1", currentRevision],
      ["patterdraw:autosave:pdf:v1:stale", stalePdf],
    ]);

    await expect(commitAutosaveTransaction(
      transaction.store,
      { ...structuredClone(older), title: "Stale", titleMode: "custom" },
      {},
      new Set(),
      false,
      {
        revision: "old-token",
        manifestHash: autosaveManifestHash(older),
        writerId: "tab-a",
        sequence: 2,
      },
    )).rejects.toBeInstanceOf(AutosaveConflictError);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(newer);
    expect(transaction.committed.get("patterdraw:autosave:revision:v1")).toEqual(currentRevision);
    expect(transaction.committed.get("patterdraw:autosave:pdf:v1:stale")).toBe(stalePdf);
  });

  it("allows an ordered same-writer queued save but rejects an explicit stale token", async () => {
    const base = createBlankProject();
    const first = { ...structuredClone(base), title: "First", titleMode: "custom" as const };
    const second = { ...structuredClone(base), title: "Second", titleMode: "custom" as const };
    const firstRevision = {
      schemaVersion: 1 as const,
      revision: "first-token",
      manifestHash: autosaveManifestHash(first)!,
      writerId: "tab-a",
      sequence: 2,
    };
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", first],
      ["patterdraw:autosave:revision:v1", firstRevision],
    ]);
    await expect(commitAutosaveTransaction(
      transaction.store,
      second,
      {},
      new Set(),
      false,
      {
        revision: "base-token",
        manifestHash: autosaveManifestHash(base),
        writerId: "tab-a",
        sequence: 3,
        allowOrderedWriterAdvance: true,
      },
    )).resolves.toMatchObject({ writerId: "tab-a" });

    const staleTransaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", first],
      ["patterdraw:autosave:revision:v1", firstRevision],
    ]);
    await expect(commitAutosaveTransaction(
      staleTransaction.store,
      second,
      {},
      new Set(),
      false,
      {
        revision: "base-token",
        manifestHash: autosaveManifestHash(base),
        writerId: "tab-a",
        sequence: 3,
      },
    )).rejects.toBeInstanceOf(AutosaveConflictError);
  });

  it("requires an explicit force flag to replace a conflicting revision", async () => {
    const current = createBlankProject();
    const replacement = { ...structuredClone(current), title: "Confirmed replacement", titleMode: "custom" as const };
    const currentRevision = {
      schemaVersion: 1 as const,
      revision: "current-token",
      manifestHash: autosaveManifestHash(current)!,
      writerId: "tab-b",
      sequence: 4,
    };
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", current],
      ["patterdraw:autosave:revision:v1", currentRevision],
    ]);

    await expect(commitAutosaveTransaction(
      transaction.store,
      replacement,
      {},
      new Set(),
      false,
      {
        revision: "stale-token",
        manifestHash: autosaveManifestHash(current),
        writerId: "tab-a",
        sequence: 2,
        forceOverwrite: true,
      },
    )).resolves.toMatchObject({ writerId: "tab-a" });
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(replacement);
  });

  it("keeps a clear tombstone so an old null-token writer cannot resurrect work", async () => {
    const project = createBlankProject();
    const oldRevision = {
      schemaVersion: 1 as const,
      revision: "before-clear",
      manifestHash: autosaveManifestHash(project)!,
      writerId: "tab-a",
      sequence: 1,
    };
    const cleared = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:revision:v1", oldRevision],
    ]);
    await commitAutosaveClearTransaction(cleared.store);
    const tombstone = cleared.committed.get("patterdraw:autosave:revision:v1");
    expect(tombstone).toMatchObject({ cleared: true });

    const stale = fakeTransactionStore([...cleared.committed.entries()]);
    await expect(commitAutosaveTransaction(
      stale.store,
      { ...structuredClone(project), title: "Resurrection", titleMode: "custom" },
      {},
      new Set(),
      false,
      {
        revision: null,
        manifestHash: null,
        writerId: "tab-a",
        sequence: 2,
      },
    )).rejects.toBeInstanceOf(AutosaveConflictError);
    expect(stale.puts).toEqual([]);
    expect(stale.committed.get("patterdraw:autosave:project:v1")).toBeUndefined();
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

  it("rolls back an active autosave migration when its load is cancelled", async () => {
    const source = createBlankProject();
    const normalized = {
      ...structuredClone(source),
      title: "Normalized title",
      titleMode: "custom" as const,
    };
    const controller = new AbortController();
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", source],
    ]);

    const migration = commitAutosaveMigrationTransaction(
      transaction.store,
      source,
      false,
      normalized,
      [],
      "migration-writer",
      undefined,
      controller.signal,
    );
    queueMicrotask(() => controller.abort());

    await expect(migration).rejects.toMatchObject({ name: "AbortError" });
    expect(transaction.transaction.abort).toHaveBeenCalledOnce();
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toBe(source);
    expect(transaction.committed.has("patterdraw:autosave:revision:v1")).toBe(false);
  });

  it("does not migrate when a same-manifest source PDF blob changed", async () => {
    const expected = createBlankProject();
    const expectedPdfBytes = new Uint8Array([1, 2, 3, 4]);
    expected.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: expectedPdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const changedPdfBytes = new Uint8Array([4, 3, 2, 1]);
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", structuredClone(expected)],
      ["patterdraw:autosave:pdf:v1:pdf", changedPdfBytes],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      expected,
      false,
      structuredClone(expected),
      [["pdf", expectedPdfBytes]],
    )).resolves.toBe(false);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(expected);
    expect(transaction.committed.get("patterdraw:autosave:pdf:v1:pdf")).toBe(changedPdfBytes);
  });

  it("does not resurrect a legacy snapshot over a valid clear tombstone", async () => {
    const legacy = createBlankProject();
    const tombstone = {
      schemaVersion: 1 as const,
      revision: "clear-token",
      manifestHash: "",
      writerId: "clear-writer",
      sequence: 4,
      cleared: true,
    };
    const transaction = fakeTransactionStore([
      ["excalidraw-classroom:autosave:project:v1", legacy],
      ["patterdraw:autosave:revision:v1", tombstone],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      legacy,
      true,
      { ...legacy, titleMode: "default" },
      [],
    )).resolves.toBe(false);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
    expect(transaction.committed.get("excalidraw-classroom:autosave:project:v1")).toEqual(legacy);
    expect(transaction.committed.get("patterdraw:autosave:revision:v1")).toEqual(tombstone);
  });

  it("does not migrate an orphan current manifest over a clear tombstone", async () => {
    const orphan = createBlankProject();
    const tombstone = {
      schemaVersion: 1 as const,
      revision: "clear-current-token",
      manifestHash: "",
      writerId: "clear-writer",
      sequence: 5,
      cleared: true,
    };
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", orphan],
      ["patterdraw:autosave:revision:v1", tombstone],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      orphan,
      false,
      { ...orphan, titleMode: "default" },
      [],
      "migration-writer",
      tombstone,
    )).resolves.toBe(false);

    expect(transaction.puts).toEqual([]);
    expect(transaction.deletes).toEqual([]);
    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(orphan);
    expect(transaction.committed.get("patterdraw:autosave:revision:v1")).toEqual(tombstone);
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

    expect([...transaction.committed.keys()]).toEqual([
      "patterdraw:library:v1",
      "patterdraw:autosave:revision:v1",
    ]);
    expect(transaction.puts).toEqual(["patterdraw:autosave:revision:v1"]);
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

  it("removes orphan PDF blobs while migrating autosave metadata", async () => {
    const project = createBlankProject();
    const transaction = fakeTransactionStore([
      ["patterdraw:autosave:project:v1", project],
      ["patterdraw:autosave:pdf:v1:orphan-current", new Uint8Array([1])],
      ["excalidraw-classroom:autosave:project:v1", createBlankProject()],
      ["excalidraw-classroom:autosave:pdf:v1:orphan-legacy", new Uint8Array([2])],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      project,
      false,
      project,
      [],
    )).resolves.toBe(true);

    expect(transaction.committed.has("patterdraw:autosave:pdf:v1:orphan-current")).toBe(false);
    expect(transaction.committed.has("excalidraw-classroom:autosave:project:v1")).toBe(false);
    expect(transaction.committed.has("excalidraw-classroom:autosave:pdf:v1:orphan-legacy")).toBe(false);
  });

  it("repairs a malformed revision sidecar while migrating verified legacy work", async () => {
    const legacy = createBlankProject();
    const verified = { ...legacy, title: "Recovered legacy canvas" };
    const transaction = fakeTransactionStore([
      ["excalidraw-classroom:autosave:project:v1", legacy],
      ["patterdraw:autosave:revision:v1", { malformed: true }],
    ]);

    await expect(commitAutosaveMigrationTransaction(
      transaction.store,
      legacy,
      true,
      verified,
      [],
    )).resolves.toBe(true);

    expect(transaction.committed.get("patterdraw:autosave:project:v1")).toEqual(verified);
    expect(transaction.committed.get("patterdraw:autosave:revision:v1")).toMatchObject({
      schemaVersion: 1,
      manifestHash: autosaveManifestHash(verified),
    });
    expect(transaction.committed.has("excalidraw-classroom:autosave:project:v1")).toBe(false);
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
    const pdfBytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const storedProject = structuredClone(project);
    storedProject.pdfDocuments.pdf.sha256 = VALID_PDF_SHA256;
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
          pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }),
        },
      })],
    ]);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("patterdraw:autosave:project:v1");
    expect(getMock).not.toHaveBeenCalledWith("patterdraw:autosave:pdf:v1:pdf");
  });

  it("repairs a corrupt same-length PDF during a browser-wide replacement save", async () => {
    const project = createBlankProject();
    const replacementPdfBytes = validPdfBytes();
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
    storedProject.pdfDocuments.pdf.sha256 = VALID_PDF_SHA256;
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
          pdfDocuments: { pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }) },
      })],
      ["patterdraw:autosave:pdf:v1:pdf", replacementPdfBytes],
    ]);
  });

  it("rewrites same-length PDF bytes when their content differs", async () => {
    const project = createBlankProject();
    const pdfBytes = validPdfBytes();
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
        pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }),
        },
      })],
      ["patterdraw:autosave:pdf:v1:pdf", pdfBytes],
    ]);
  });

  it("rewrites a PDF when its matching manifest identity exists but its blob key is missing", async () => {
    const project = createBlankProject();
    const pdfBytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      sha256: VALID_PDF_SHA256,
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
    const replacementPdfBytes = validPdfBytes();
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
          pdfDocuments: { pdf: { sha256: VALID_PDF_SHA256 } },
    });
  });

  it("propagates an atomic transaction failure without attempting partial writes", async () => {
    const project = createBlankProject();
    const pdfBytes = validPdfBytes();
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

  it("performs no writes when an autosave is aborted while queued behind another mutation", async () => {
    const project = createBlankProject();
    let releaseFirstMutation!: () => void;
    let signalFirstMutationReady!: () => void;
    const firstMutationReady = new Promise<void>((resolve) => {
      signalFirstMutationReady = resolve;
    });
    const firstMutationReleased = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    const request = vi.fn(async (
      _name: string,
      operation: () => Promise<void>,
    ) => {
      if (request.mock.calls.length === 1) {
        signalFirstMutationReady();
        await firstMutationReleased;
      }
      return operation();
    });
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    const firstSave = saveAutosave(project, {});
    const controller = new AbortController();
    try {
      await firstMutationReady;
      const queuedSave = saveAutosave(
        { ...structuredClone(project), title: "Obsolete queued save" },
        {},
        { signal: controller.signal },
      );
      controller.abort();
      releaseFirstMutation();
      await firstSave;
      await expect(queuedSave).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      releaseFirstMutation();
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }
    expect(setManyMock).toHaveBeenCalledTimes(1);
  });

  it("reports success when fallback cancellation arrives only after its write commits", async () => {
    const project = createBlankProject();
    const controller = new AbortController();
    getMock.mockResolvedValue(undefined);
    setManyMock.mockImplementationOnce(async () => {
      controller.abort();
    });

    await expect(saveAutosave(project, {}, {
      signal: controller.signal,
    })).resolves.toMatchObject({ revision: expect.any(String) });
    expect(setManyMock).toHaveBeenCalledTimes(1);
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
    const legacyPdfBytes = validPdfBytes();
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
        pdfDocuments: { pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }) },
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
        pdfDocuments: { pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }) },
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
    const legacyPdfBytes = validPdfBytes();
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
        pdfDocuments: { pdf: expect.objectContaining({ sha256: VALID_PDF_SHA256 }) },
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
    keysMock.mockResolvedValue([
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
    const pdfBytes = validPdfBytes();
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

  it("rejects an autosave whose PDF page count disagrees with its source bytes", async () => {
    const project = createBlankProject();
    const pdfBytes = validPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "poisoned-autosave.pdf",
      mimeType: "application/pdf",
      byteLength: pdfBytes.byteLength,
      pageCount: 2,
      archivePath: "documents/pdf.pdf",
    };
    getMock
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(pdfBytes);

    await expect(loadAutosave()).rejects.toThrow(/page count.*saved 2.*actual 1/i);
    expect(setManyMock).not.toHaveBeenCalled();
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
