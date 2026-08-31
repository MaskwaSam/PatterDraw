import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject } from "../types";

const MINIMAL_PDF_BASE64 = "JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwMDY5MDA2RTAwMDY3MDAyRjAwNzAwMDY0MDA2NjAwMkQwMDZDMDA2OTAwNjIwMDI5PgovTW9kRGF0ZSAoRDoyMDI2MDgwNTAxNDYzMVopCi9DcmVhdGlvbkRhdGUgKEQ6MjAyNjA4MDUwMTQ2MzFaKQo+PgplbmRvYmoKCjQgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAxIDAgUgovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAgMCA2MTIgNzkyIF0KPj4KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNiAwMDAwMCBuIAowMDAwMDAwMDc2IDAwMDAwIG4gCjAwMDAwMDAxMjYgMDAwMDAgbiAKMDAwMDAwMDQ4MCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDUKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4Kc3RhcnR4cmVmCjU3MQolJUVPRg==";

function minimalPdfBytes(): Uint8Array {
  return Uint8Array.from(atob(MINIMAL_PDF_BASE64), (character) => character.charCodeAt(0));
}

const { abortBeforeNextReadwriteOperation, createStoreMock, database, failNextPut } = vi.hoisted(() => ({
  abortBeforeNextReadwriteOperation: { value: null as (() => void) | null },
  createStoreMock: vi.fn(),
  database: new Map<string, unknown>(),
  failNextPut: { value: false },
}));

interface FakeRequest<T> {
  error: Error | null;
  result: T | undefined;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function fakeStoreFunction() {
  return <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => T,
  ): T => {
    const staged = new Map(database);
    let pending = 0;
    let completionQueued = false;
    let aborted = false;
    const transaction = {
      error: null as Error | null,
      onabort: null as (() => void) | null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      abort: vi.fn(() => {
        if (aborted) return;
        aborted = true;
        transaction.error ??= new Error("Transaction aborted");
        queueMicrotask(() => transaction.onabort?.());
      }),
    };
    const queueCompletion = () => {
      if (pending !== 0 || completionQueued || aborted) return;
      completionQueued = true;
      queueMicrotask(() => queueMicrotask(() => {
        if (aborted) return;
        database.clear();
        for (const [key, value] of staged) database.set(key, value);
        transaction.oncomplete?.();
      }));
    };
    const request = <R>(value: R): FakeRequest<R> => {
      pending += 1;
      const result: FakeRequest<R> = {
        error: null,
        result: undefined,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        if (aborted) return;
        result.result = value;
        result.onsuccess?.();
        pending -= 1;
        queueCompletion();
      });
      return result;
    };
    const store = {
      transaction,
      get: (key: string) => request(staged.get(key)),
      put: (value: unknown, key: string) => {
        if (failNextPut.value) {
          failNextPut.value = false;
          throw new DOMException("quota", "QuotaExceededError");
        }
        staged.set(key, structuredClone(value));
        return {};
      },
      delete: (key: string) => {
        staged.delete(key);
        return {};
      },
      clear: () => {
        staged.clear();
        return {};
      },
    } as unknown as IDBObjectStore;
    if (mode === "readwrite" && abortBeforeNextReadwriteOperation.value) {
      const abort = abortBeforeNextReadwriteOperation.value;
      abortBeforeNextReadwriteOperation.value = null;
      abort();
    }
    const result = operation(store);
    queueCompletion();
    return result;
  };
}

vi.mock("idb-keyval", () => ({
  createStore: createStoreMock,
}));

let history: typeof import("./autosave-history");

describe("autosave recovery history storage", () => {
  beforeEach(async () => {
    database.clear();
    abortBeforeNextReadwriteOperation.value = null;
    failNextPut.value = false;
    vi.resetModules();
    createStoreMock.mockImplementation(() => fakeStoreFunction());
    history = await import("./autosave-history");
  });

  it("atomically saves, lists, and restores an immutable project snapshot", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    project.title = "Before switching";
    project.titleMode = "custom";
    const saving = history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} }, {
      now: () => new Date("2026-08-30T13:00:00.000Z"),
    });
    project.title = "Mutated after capture began";
    const saved = await saving;

    expect(saved.retained).toBe(true);
    expect(await history.listAutosaveHistorySnapshots()).toEqual([
      expect.objectContaining({
        snapshotId: saved.summary.snapshotId,
        title: "Before switching",
      }),
    ]);
    const loaded = await history.loadAutosaveHistorySnapshot(saved.summary.snapshotId);
    expect(loaded.project.title).toBe("Before switching");
    expect(loaded.pdfBytes).toEqual({});
  });

  it("protects and restores a project whose teacher intentionally left its title blank", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    project.title = "";
    project.titleMode = "custom";
    const saved = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} });

    expect((await history.listAutosaveHistorySnapshots())[0].title).toBe("");
    await expect(history.loadAutosaveHistorySnapshot(saved.summary.snapshotId))
      .resolves.toMatchObject({ project: { title: "" } });
  });

  it("rolls back the index and record together when a put fails", async () => {
    const first = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    first.title = "Protected";
    first.titleMode = "custom";
    const saved = await history.saveAutosaveHistorySnapshot({ project: first, pdfBytes: {} });
    const before = structuredClone([...database.entries()]);

    const second = createBlankProject(new Date("2026-08-30T13:00:00.000Z"));
    second.title = "Should not partially save";
    second.titleMode = "custom";
    failNextPut.value = true;
    await expect(history.saveAutosaveHistorySnapshot({ project: second, pdfBytes: {} }))
      .rejects.toMatchObject({ name: "QuotaExceededError" });

    expect([...database.entries()]).toEqual(before);
    await expect(history.loadAutosaveHistorySnapshot(saved.summary.snapshotId))
      .resolves.toMatchObject({ project: { title: "Protected" } });
  });

  it("reports when a late older capture is not retained beside two newer same-project copies", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    const first = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} }, {
      now: () => new Date("2026-08-30T13:00:00.000Z"),
    });
    project.updatedAt = "2026-08-30T13:30:00.000Z";
    const second = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} }, {
      now: () => new Date("2026-08-30T14:00:00.000Z"),
    });
    project.updatedAt = "2026-08-30T11:30:00.000Z";
    const lateOlder = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} }, {
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(lateOlder.retained).toBe(false);
    expect(await history.listAutosaveHistorySnapshots()).toEqual([
      expect.objectContaining({ snapshotId: second.summary.snapshotId }),
      expect.objectContaining({ snapshotId: first.summary.snapshotId }),
    ]);
    expect(database.has(`snapshot:v1:${lateOlder.summary.snapshotId}`)).toBe(false);
  });

  it("honours cancellation at the readwrite transaction boundary", async () => {
    const controller = new AbortController();
    abortBeforeNextReadwriteOperation.value = () => controller.abort();
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));

    await expect(history.saveAutosaveHistorySnapshot(
      { project, pdfBytes: {} },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(await history.listAutosaveHistorySnapshots()).toEqual([]);
  });

  it("hashes and stores an owned PDF snapshot if the caller mutates its live view", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    const bytes = minimalPdfBytes();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "worksheet.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const originalFirstByte = bytes[0];
    const saving = history.saveAutosaveHistorySnapshot({
      project,
      pdfBytes: { pdf: bytes },
    });
    bytes[0] = 0;

    const saved = await saving;
    const loaded = await history.loadAutosaveHistorySnapshot(saved.summary.snapshotId);
    expect(loaded.pdfBytes.pdf[0]).toBe(originalFirstByte);
    expect(bytes[0]).toBe(0);
  });

  it("fails closed when stored manifest bytes no longer match the indexed hash", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    const saved = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} });
    const key = `snapshot:v1:${saved.summary.snapshotId}`;
    const record = structuredClone(database.get(key)) as { manifest: Uint8Array };
    record.manifest[0] ^= 0xff;
    database.set(key, record);

    await expect(history.loadAutosaveHistorySnapshot(saved.summary.snapshotId))
      .rejects.toThrow(/manifest integrity/i);
  });

  it("falls back to an older valid copy of the same project without deleting the damaged copy", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    project.title = "Older usable lesson";
    project.titleMode = "custom";
    const older = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} }, {
      now: () => new Date("2026-08-30T12:30:00.000Z"),
    });

    project.title = "Newest damaged lesson";
    project.updatedAt = "2026-08-30T13:00:00.000Z";
    const newest = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} }, {
      now: () => new Date("2026-08-30T13:30:00.000Z"),
    });
    const newestKey = `snapshot:v1:${newest.summary.snapshotId}`;
    const damagedRecord = structuredClone(database.get(newestKey)) as { manifest: Uint8Array };
    damagedRecord.manifest[0] ^= 0xff;
    database.set(newestKey, damagedRecord);

    const recovered = await history.loadAutosaveHistorySnapshotWithFallback(
      newest.summary.snapshotId,
    );
    expect(recovered.requested.snapshotId).toBe(newest.summary.snapshotId);
    expect(recovered.summary.snapshotId).toBe(older.summary.snapshotId);
    expect(recovered.loaded.project.title).toBe("Older usable lesson");
    expect(recovered.failed).toEqual([
      expect.objectContaining({ snapshotId: newest.summary.snapshotId }),
    ]);
    expect(await history.listAutosaveHistorySnapshots()).toHaveLength(2);
    expect(database.has(newestKey)).toBe(true);
  });

  it("deletes snapshots and prunes only PDF blobs that become orphaned", async () => {
    const bytes = minimalPdfBytes();
    const first = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    first.title = "First PDF lesson";
    first.titleMode = "custom";
    first.pdfDocuments.first = {
      id: "first",
      name: "shared.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/first.pdf",
    };
    const firstSaved = await history.saveAutosaveHistorySnapshot({
      project: first,
      pdfBytes: { first: bytes },
    });

    const second = createBlankProject(new Date("2026-08-30T13:00:00.000Z"));
    second.title = "Second PDF lesson";
    second.titleMode = "custom";
    second.pdfDocuments.second = {
      id: "second",
      name: "shared-again.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/second.pdf",
    };
    const secondSaved = await history.saveAutosaveHistorySnapshot({
      project: second,
      pdfBytes: { second: bytes },
    });
    const sha256 = firstSaved.summary.pdfReferences[0].sha256;
    expect(secondSaved.summary.pdfReferences[0].sha256).toBe(sha256);
    expect(database.has(`pdf:v1:${sha256}`)).toBe(true);

    const firstDelete = await history.deleteAutosaveHistorySnapshots([
      firstSaved.summary.snapshotId,
    ]);
    expect(firstDelete.orphanedPdfSha256s).toEqual([]);
    expect(database.has(`snapshot:v1:${firstSaved.summary.snapshotId}`)).toBe(false);
    expect(database.has(`pdf:v1:${sha256}`)).toBe(true);

    const secondDelete = await history.deleteAutosaveHistorySnapshots([
      secondSaved.summary.snapshotId,
    ]);
    expect(secondDelete.orphanedPdfSha256s).toEqual([sha256]);
    expect(database.has(`pdf:v1:${sha256}`)).toBe(false);
    expect(await history.listAutosaveHistorySnapshots()).toEqual([]);
  });

  it("rolls back explicit deletion if its atomic index update fails", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    const saved = await history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} });
    const before = structuredClone([...database.entries()]);

    failNextPut.value = true;
    await expect(history.deleteAutosaveHistorySnapshots([saved.summary.snapshotId]))
      .rejects.toMatchObject({ name: "QuotaExceededError" });
    expect([...database.entries()]).toEqual(before);
    await expect(history.loadAutosaveHistorySnapshot(saved.summary.snapshotId)).resolves.toBeTruthy();
  });

  it("clears every indexed copy only when the explicit clear operation is called", async () => {
    const first = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    const second = createBlankProject(new Date("2026-08-30T13:00:00.000Z"));
    await history.saveAutosaveHistorySnapshot({ project: first, pdfBytes: {} });
    await history.saveAutosaveHistorySnapshot({ project: second, pdfBytes: {} });

    expect(await history.listAutosaveHistorySnapshots()).toHaveLength(2);
    const cleared = await history.clearAutosaveHistorySnapshots();
    expect(cleared.deletedSnapshotIds).toHaveLength(2);
    expect(cleared.entries).toEqual([]);
    expect([...database.keys()].filter((key) => key.startsWith("snapshot:v1:"))).toEqual([]);
  });

  it("repairs a damaged index and removes unindexed recovery and PDF remnants", async () => {
    database.set("index:v1", { schemaVersion: 1, entries: "damaged" });
    database.set("snapshot:v1:unindexed", { private: "classroom data" });
    database.set(`pdf:v1:${"a".repeat(64)}`, new Uint8Array([1, 2, 3]));

    await expect(history.listAutosaveHistorySnapshots()).rejects.toThrow(/index is damaged/i);
    await expect(history.clearAutosaveHistorySnapshots()).resolves.toMatchObject({ entries: [] });
    expect(await history.listAutosaveHistorySnapshots()).toEqual([]);
    expect([...database.keys()].sort()).toEqual(["epoch:v1", "index:v1"]);
  });

  it("prevents a pre-clear in-flight snapshot from committing after clear-all", async () => {
    const project = createBlankProject(new Date("2026-08-30T12:00:00.000Z"));
    const saving = history.saveAutosaveHistorySnapshot({ project, pdfBytes: {} });
    // Allow the save to read the old privacy generation, then clear while its
    // manifest hashing/preflight is still yielding to the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    await history.clearAutosaveHistorySnapshots();

    await expect(saving).rejects.toThrow(/cleared while this copy was being prepared/i);
    expect(await history.listAutosaveHistorySnapshots()).toEqual([]);
  });
});
