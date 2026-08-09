import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const committed = new Map<string, unknown>();

  function transactionStore(): IDBObjectStore {
    const staged = new Map(committed);
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
    const request = (result: unknown) => {
      pendingReads += 1;
      const value = {
        error: null as Error | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        result: undefined as unknown,
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
      put: (value: unknown, key: string) => {
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
    ) => Promise.resolve(callback(transactionStore()))),
    get: vi.fn(),
    set: vi.fn(),
  };
});

vi.mock("idb-keyval", () => ({
  createStore: mocks.createStore,
  get: mocks.get,
  set: mocks.set,
}));

import {
  AuxiliaryStorageConflictError,
  commitAuxiliaryStorage,
  observationForValue,
} from "./auxiliary-persistence";
import {
  LEGACY_PERSONAL_LIBRARY_KEY,
  PERSONAL_LIBRARY_KEY,
} from "./storage-budget";

describe("transactional auxiliary persistence", () => {
  beforeEach(() => {
    mocks.committed.clear();
  });

  it("writes the canonical full list and deletes its legacy record in one transaction", async () => {
    const legacy = [[{ id: "legacy" }]];
    mocks.committed.set(LEGACY_PERSONAL_LIBRARY_KEY, legacy);

    await commitAuxiliaryStorage({
      collection: "library",
      value: [[{ id: "migrated" }]],
      expected: observationForValue(legacy, "legacy"),
    });

    expect(mocks.committed.get(PERSONAL_LIBRARY_KEY)).toEqual([[{ id: "migrated" }]]);
    expect(mocks.committed.has(LEGACY_PERSONAL_LIBRARY_KEY)).toBe(false);
  });

  it("rejects a second stale full-list writer after the first transaction commits", async () => {
    const initial = [[{ id: "initial" }]];
    mocks.committed.set(PERSONAL_LIBRARY_KEY, initial);
    const expected = observationForValue(initial, "canonical");

    await commitAuxiliaryStorage({
      collection: "library",
      value: [[{ id: "first" }]],
      expected,
    });

    await expect(commitAuxiliaryStorage({
      collection: "library",
      value: [[{ id: "stale" }]],
      expected,
    })).rejects.toBeInstanceOf(AuxiliaryStorageConflictError);
    expect(mocks.committed.get(PERSONAL_LIBRARY_KEY)).toEqual([[{ id: "first" }]]);
  });
});
