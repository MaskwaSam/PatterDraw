import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";

const mocks = vi.hoisted(() => {
  const committed = new Map<string, unknown>();
  const transactionPuts: string[][] = [];
  let afterCommit: (() => void) | undefined;

  function transactionStore(): IDBObjectStore {
    const staged = new Map(committed);
    const puts: string[] = [];
    transactionPuts.push(puts);
    let pendingReads = 0;
    let completionQueued = false;
    let aborted = false;
    const transaction = {
      error: null as Error | null,
      onabort: null as (() => void) | null,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      abort: vi.fn(() => {
        aborted = true;
        transaction.error = new Error("Transaction aborted");
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
        if (pendingReads === 0 && !completionQueued) {
          completionQueued = true;
          queueMicrotask(() => {
            if (aborted) return;
            committed.clear();
            for (const [key, entry] of staged) committed.set(key, entry);
            afterCommit?.();
            transaction.oncomplete?.();
          });
        }
      });
      return value;
    };
    return {
      transaction,
      get: (key: string) => request(committed.get(key)),
      getAllKeys: () => request([...committed.keys()]),
      put: (value: unknown, key: string) => {
        puts.push(key);
        staged.set(key, value);
        return {};
      },
      delete: (key: string) => {
        staged.delete(key);
        return {};
      },
    } as unknown as IDBObjectStore;
  }

  return {
    committed,
    createStore: vi.fn(() => (
      _mode: IDBTransactionMode,
      callback: (store: IDBObjectStore) => unknown,
    ) => callback(transactionStore())),
    delMany: vi.fn(),
    get: vi.fn(),
    keys: vi.fn(),
    setMany: vi.fn(),
    transactionPuts,
    setAfterCommit: (callback: (() => void) | undefined) => {
      afterCommit = callback;
    },
  };
});

vi.mock("idb-keyval", () => ({
  createStore: mocks.createStore,
  delMany: mocks.delMany,
  get: mocks.get,
  keys: mocks.keys,
  setMany: mocks.setMany,
}));

import {
  AUTOSAVE_REVISION_KEY,
  autosaveManifestHash,
  loadAutosave,
  saveAutosave,
} from "./persistence";

const PROJECT_KEY = "patterdraw:autosave:project:v1";
let originalLocks: LockManager | undefined;

describe("no-Web-Locks autosave load race", () => {
  beforeEach(() => {
    mocks.committed.clear();
    mocks.transactionPuts.length = 0;
    mocks.setAfterCommit(undefined);
    mocks.delMany.mockReset();
    mocks.get.mockReset();
    mocks.keys.mockReset();
    mocks.setMany.mockReset();
    originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: originalLocks,
    });
  });

  it("retries a superseded migration and bases the next save on the newer tab", async () => {
    const older = createBlankProject();
    older.title = "Untitled classroom canvas";
    delete older.titleMode;

    const newer: ClassroomProject = {
      ...structuredClone(older),
      title: "Newer tab project",
      titleMode: "custom",
      updatedAt: "2099-01-01T00:00:00.000Z",
    };
    mocks.committed.set(PROJECT_KEY, newer);
    let firstManifestRead = true;
    mocks.get.mockImplementation(async (key: string) => {
      if (key === PROJECT_KEY && firstManifestRead) {
        firstManifestRead = false;
        return older;
      }
      return mocks.committed.get(key);
    });

    const loaded = await loadAutosave();
    expect(loaded?.project).toMatchObject({
      title: "Newer tab project",
      titleMode: "custom",
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(mocks.transactionPuts[0]).toEqual([]);

    const edited: ClassroomProject = {
      ...loaded!.project,
      title: "Edit based on the newer tab",
      updatedAt: "2099-01-01T00:00:01.000Z",
    };
    await saveAutosave(edited, {}, { prepared: true });

    expect(mocks.committed.get(PROJECT_KEY)).toMatchObject({
      title: "Edit based on the newer tab",
      updatedAt: "2099-01-01T00:00:01.000Z",
    });
    expect(mocks.setMany).not.toHaveBeenCalled();
  });

  it("retries an already-normalized snapshot superseded before validation", async () => {
    const older = createBlankProject();
    older.title = "Older normalized project";
    older.titleMode = "custom";

    const newer: ClassroomProject = {
      ...structuredClone(older),
      title: "Newer normalized project",
      updatedAt: "2099-02-01T00:00:00.000Z",
    };
    mocks.committed.set(PROJECT_KEY, newer);
    let firstManifestRead = true;
    mocks.get.mockImplementation(async (key: string) => {
      if (key === PROJECT_KEY && firstManifestRead) {
        firstManifestRead = false;
        return older;
      }
      return mocks.committed.get(key);
    });

    const loaded = await loadAutosave();

    expect(loaded?.project).toMatchObject({
      title: "Newer normalized project",
      titleMode: "custom",
      updatedAt: "2099-02-01T00:00:00.000Z",
    });
    expect(mocks.transactionPuts[0]).toEqual([]);
    expect(mocks.transactionPuts[1]).toEqual([
      "patterdraw:autosave:project:v1",
      "patterdraw:autosave:revision:v1",
    ]);
    expect(mocks.setMany).not.toHaveBeenCalled();
  });

  it("never pairs a migrated project with a newer writer revision", async () => {
    const older = createBlankProject();
    older.title = "Older title needing migration";
    delete older.titleMode;
    const olderRevision = {
      schemaVersion: 1 as const,
      revision: "revision-older",
      manifestHash: autosaveManifestHash(older)!,
      writerId: "writer-older",
      sequence: 1,
    };
    const newer: ClassroomProject = {
      ...structuredClone(older),
      title: "Newer writer project",
      titleMode: "custom",
      updatedAt: "2099-02-15T00:00:00.000Z",
    };
    const newerRevision = {
      schemaVersion: 1 as const,
      revision: "revision-newer",
      manifestHash: autosaveManifestHash(newer)!,
      writerId: "writer-newer",
      sequence: 2,
    };
    mocks.committed.set(PROJECT_KEY, older);
    mocks.committed.set(AUTOSAVE_REVISION_KEY, olderRevision);
    mocks.get.mockImplementation(async (key: string) => mocks.committed.get(key));
    let supersedeAfterMigration = true;
    mocks.setAfterCommit(() => {
      if (!supersedeAfterMigration) return;
      supersedeAfterMigration = false;
      mocks.committed.set(PROJECT_KEY, newer);
      mocks.committed.set(AUTOSAVE_REVISION_KEY, newerRevision);
    });

    const loaded = await loadAutosave();

    expect(loaded).toMatchObject({
      project: {
        title: "Newer writer project",
        updatedAt: "2099-02-15T00:00:00.000Z",
      },
      autosaveRevision: "revision-newer",
    });
    expect(mocks.transactionPuts[0]).toEqual([
      PROJECT_KEY,
      AUTOSAVE_REVISION_KEY,
    ]);
    // The first migration's paired validation sees the newer writer and
    // retries; no post-migration sidecar read is allowed to relabel old bytes.
    expect(mocks.transactionPuts[1]).toEqual([]);
  });

  it("revalidates and retries outside a held Web Lock when a no-lock tab supersedes the reads", async () => {
    const older = createBlankProject();
    older.title = "Older locked read";
    older.titleMode = "custom";
    const newer: ClassroomProject = {
      ...structuredClone(older),
      title: "Newer no-lock tab",
      updatedAt: "2099-03-01T00:00:00.000Z",
    };
    const olderRevision = {
      schemaVersion: 1 as const,
      revision: "revision-older",
      manifestHash: autosaveManifestHash(older)!,
      writerId: "writer-older",
      sequence: 1,
    };
    const newerRevision = {
      schemaVersion: 1 as const,
      revision: "revision-newer",
      manifestHash: autosaveManifestHash(newer)!,
      writerId: "writer-newer",
      sequence: 1,
    };
    mocks.committed.set(PROJECT_KEY, newer);
    mocks.committed.set(AUTOSAVE_REVISION_KEY, newerRevision);
    let returnOlderManifest = true;
    let returnOlderRevision = true;
    mocks.get.mockImplementation(async (key: string) => {
      if (key === PROJECT_KEY && returnOlderManifest) {
        returnOlderManifest = false;
        return older;
      }
      if (key === AUTOSAVE_REVISION_KEY && returnOlderRevision) {
        returnOlderRevision = false;
        return olderRevision;
      }
      return mocks.committed.get(key);
    });
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation());
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    const loaded = await loadAutosave();

    expect(loaded).toMatchObject({
      project: {
        title: "Newer no-lock tab",
        updatedAt: "2099-03-01T00:00:00.000Z",
      },
      autosaveRevision: "revision-newer",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(mocks.transactionPuts).toEqual([[], []]);
    expect(mocks.setMany).not.toHaveBeenCalled();
  });

  it("does not return an empty startup snapshot after another tab creates an autosave", async () => {
    const newer = createBlankProject();
    newer.title = "Created by another tab";
    newer.titleMode = "custom";
    newer.updatedAt = "2099-04-01T00:00:00.000Z";
    const tombstone = {
      schemaVersion: 1 as const,
      revision: "revision-empty",
      manifestHash: "",
      writerId: "writer-clear",
      sequence: 1,
      cleared: true,
    };
    const newerRevision = {
      schemaVersion: 1 as const,
      revision: "revision-created",
      manifestHash: autosaveManifestHash(newer)!,
      writerId: "writer-newer",
      sequence: 1,
    };
    mocks.committed.set(PROJECT_KEY, newer);
    mocks.committed.set(AUTOSAVE_REVISION_KEY, newerRevision);
    let returnEmptyManifest = true;
    let returnTombstone = true;
    mocks.get.mockImplementation(async (key: string) => {
      if (key === PROJECT_KEY && returnEmptyManifest) {
        returnEmptyManifest = false;
        return undefined;
      }
      if (key === AUTOSAVE_REVISION_KEY && returnTombstone) {
        returnTombstone = false;
        return tombstone;
      }
      return mocks.committed.get(key);
    });
    const request = vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation());
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });

    const loaded = await loadAutosave();

    expect(loaded).toMatchObject({
      project: {
        title: "Created by another tab",
        updatedAt: "2099-04-01T00:00:00.000Z",
      },
      autosaveRevision: "revision-created",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(mocks.transactionPuts).toEqual([[], []]);
  });
});
