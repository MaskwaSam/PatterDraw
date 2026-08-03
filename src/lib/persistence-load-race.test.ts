import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject } from "../types";

const mocks = vi.hoisted(() => {
  const committed = new Map<string, unknown>();
  const transactionPuts: string[][] = [];

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
  };
});

vi.mock("idb-keyval", () => ({
  createStore: mocks.createStore,
  delMany: mocks.delMany,
  get: mocks.get,
  keys: mocks.keys,
  setMany: mocks.setMany,
}));

import { loadAutosave, saveAutosave } from "./persistence";

const PROJECT_KEY = "patterdraw:autosave:project:v1";
let originalLocks: LockManager | undefined;

describe("no-Web-Locks autosave load race", () => {
  beforeEach(() => {
    mocks.committed.clear();
    mocks.transactionPuts.length = 0;
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
    expect(mocks.transactionPuts).toEqual([[], []]);
    expect(mocks.setMany).not.toHaveBeenCalled();
  });
});
