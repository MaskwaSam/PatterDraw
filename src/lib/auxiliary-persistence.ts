import * as idbKeyval from "idb-keyval";
import {
  assertAuxiliaryStoragePhysicalValuesFit,
  LEGACY_PERSONAL_LIBRARY_KEY,
  LEGACY_SCREENSHOT_LIBRARY_KEY,
  PERSONAL_LIBRARY_KEY,
  SCREENSHOT_LIBRARY_KEY,
} from "./storage-budget";

type IdKeyvalApi = {
  createStore?: typeof idbKeyval.createStore;
  del?: typeof idbKeyval.del;
  delMany?: typeof idbKeyval.delMany;
  get?: typeof idbKeyval.get;
  set?: typeof idbKeyval.set;
  setMany?: typeof idbKeyval.setMany;
};

const keyval = idbKeyval as unknown as IdKeyvalApi;

function optionalApiMethod<Key extends keyof IdKeyvalApi>(
  name: Key,
): IdKeyvalApi[Key] | undefined {
  try {
    return keyval[name];
  } catch {
    // Vitest/custom adapters may intentionally expose only get/set. Keep the
    // transaction path optional so those adapters retain the old behavior.
    return undefined;
  }
}

// idb-keyval's default store is also the store used by the rest of PatterDraw.
// Keeping one readwrite transaction for all four auxiliary keys makes the
// budget check and the full-list replacement one IndexedDB serialization
// point, including when two tabs do not share a Web Locks implementation.
const createStore = optionalApiMethod("createStore");
const auxiliaryStore = typeof createStore === "function"
  ? createStore("keyval-store", "keyval")
  : undefined;
const getValue = optionalApiMethod("get");
const setValue = optionalApiMethod("set");
const setManyValues = optionalApiMethod("setMany");
const deleteValue = optionalApiMethod("del");
const deleteManyValues = optionalApiMethod("delMany");
const AUXILIARY_MUTATION_LOCK = "patterdraw:auxiliary-mutation:v1";

export type AuxiliaryCollection = "library" | "screenshots";
export type AuxiliaryObservationSource = "canonical" | "legacy" | "empty";

export interface AuxiliaryObservation {
  source: AuxiliaryObservationSource;
  fingerprint: string | null;
}

export interface CommitAuxiliaryStorageOptions {
  collection: AuxiliaryCollection;
  value: unknown;
  /**
   * The source read by the caller before it started editing. Omitting this
   * expectation is intentionally strict: a direct first write may create an
   * empty library, but it cannot overwrite data it never observed.
   */
  expected?: AuxiliaryObservation;
}

export interface AuxiliaryStorageSnapshot {
  library: unknown;
  legacyLibrary: unknown;
  screenshots: unknown;
  legacyScreenshots: unknown;
}

export class AuxiliaryStorageConflictError extends Error {
  readonly collection: AuxiliaryCollection;

  constructor(collection: AuxiliaryCollection) {
    super(
      `${collection === "library" ? "Personal" : "Screenshot"} Library changed in another tab. Reload it before saving again.`,
    );
    this.name = "AuxiliaryStorageConflictError";
    this.collection = collection;
  }
}

let mutationQueue: Promise<void> = Promise.resolve();

/** Serialize auxiliary writes made by one JavaScript context. */
export function enqueueAuxiliaryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = mutationQueue
    .catch(() => undefined)
    .then(operation);
  mutationQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Produce a small, deterministic compare-and-swap token for structured
 * values. Blob bytes are represented by their persisted metadata here; the
 * screenshot record's ID, dimensions, and byte length still make accidental
 * same-shape overwrites highly unlikely, while avoiding an async blob read
 * before opening the IndexedDB transaction.
 */
export function auxiliaryValueFingerprint(value: unknown): string | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, candidate: unknown) => {
      if (candidate instanceof Blob) {
        return {
          type: candidate.type,
          size: candidate.size,
        };
      }
      if (candidate instanceof ArrayBuffer) {
        return { byteLength: candidate.byteLength };
      }
      if (ArrayBuffer.isView(candidate)) {
        return { byteLength: candidate.byteLength };
      }
      return candidate;
    });
  } catch {
    return null;
  }
  if (json === undefined) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${json.length.toString(16)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function observationForValue(
  value: unknown,
  source: AuxiliaryObservationSource,
): AuxiliaryObservation {
  return {
    source,
    fingerprint: source === "empty" ? null : auxiliaryValueFingerprint(value),
  };
}

export function auxiliarySnapshotFromValues(
  values: readonly unknown[],
): AuxiliaryStorageSnapshot {
  return {
    library: values[0],
    legacyLibrary: values[1],
    screenshots: values[2],
    legacyScreenshots: values[3],
  };
}

function collectionValues(
  snapshot: AuxiliaryStorageSnapshot,
  collection: AuxiliaryCollection,
): { canonical: unknown; legacy: unknown } {
  return collection === "library"
    ? { canonical: snapshot.library, legacy: snapshot.legacyLibrary }
    : { canonical: snapshot.screenshots, legacy: snapshot.legacyScreenshots };
}

function currentValueForObservation(
  snapshot: AuxiliaryStorageSnapshot,
  collection: AuxiliaryCollection,
  source: AuxiliaryObservationSource,
): unknown {
  const values = collectionValues(snapshot, collection);
  if (source === "legacy") return hasValue(values.legacy) ? values.legacy : values.canonical;
  return hasValue(values.canonical) ? values.canonical : values.legacy;
}

function observationMatches(
  snapshot: AuxiliaryStorageSnapshot,
  options: CommitAuxiliaryStorageOptions,
): boolean {
  const expected = options.expected;
  const values = collectionValues(snapshot, options.collection);
  if (!expected) {
    // A direct save may intentionally upgrade a legacy-only record. Once a
    // canonical value exists, however, an unobserved writer is stale and must
    // not replace it (the first transaction in a race wins; later writers
    // reload and retry with an observation token).
    return !hasValue(values.canonical);
  }
  if (expected.source === "empty") {
    return !hasValue(values.canonical) && !hasValue(values.legacy);
  }
  const current = currentValueForObservation(snapshot, options.collection, expected.source);
  return hasValue(current) && auxiliaryValueFingerprint(current) === expected.fingerprint;
}

function replacementSnapshot(
  snapshot: AuxiliaryStorageSnapshot,
  options: CommitAuxiliaryStorageOptions,
): AuxiliaryStorageSnapshot {
  if (options.collection === "library") {
    return {
      ...snapshot,
      library: options.value,
      // A canonical write is the migration point for this namespace. Keep
      // legacy data out of the committed physical byte count and final store.
      legacyLibrary: undefined,
    };
  }
  return {
    ...snapshot,
    screenshots: options.value,
    legacyScreenshots: undefined,
  };
}

function canonicalKey(collection: AuxiliaryCollection): string {
  return collection === "library" ? PERSONAL_LIBRARY_KEY : SCREENSHOT_LIBRARY_KEY;
}

function legacyKey(collection: AuxiliaryCollection): string {
  return collection === "library" ? LEGACY_PERSONAL_LIBRARY_KEY : LEGACY_SCREENSHOT_LIBRARY_KEY;
}

function readSnapshotFallback(): Promise<AuxiliaryStorageSnapshot> {
  if (!getValue) throw new Error("IndexedDB storage is unavailable.");
  return Promise.all([
    getValue<unknown>(PERSONAL_LIBRARY_KEY),
    getValue<unknown>(LEGACY_PERSONAL_LIBRARY_KEY),
    getValue<unknown>(SCREENSHOT_LIBRARY_KEY),
    getValue<unknown>(LEGACY_SCREENSHOT_LIBRARY_KEY),
  ]).then((values) => auxiliarySnapshotFromValues(values));
}

async function withCrossContextLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) return operation();
  return navigator.locks.request(AUXILIARY_MUTATION_LOCK, operation);
}

function deleteFallback(key: string): Promise<void> {
  if (deleteManyValues) return deleteManyValues([key]);
  if (deleteValue) return deleteValue(key);
  // Existing test doubles and very old idb-keyval-compatible adapters may
  // expose only get/set. The canonical write remains usable; a later write
  // retries this best-effort legacy cleanup when deletion becomes available.
  return Promise.resolve();
}

function writeFallback(key: string, value: unknown): Promise<void> {
  if (setManyValues) return setManyValues([[key, value]]);
  if (setValue) return setValue(key, value);
  throw new Error("IndexedDB storage is unavailable.");
}

async function commitFallback(options: CommitAuxiliaryStorageOptions): Promise<AuxiliaryObservation> {
  const snapshot = await readSnapshotFallback();
  if (!observationMatches(snapshot, options)) {
    throw new AuxiliaryStorageConflictError(options.collection);
  }
  const finalSnapshot = replacementSnapshot(snapshot, options);
  assertAuxiliaryStoragePhysicalValuesFit([
    finalSnapshot.library,
    finalSnapshot.legacyLibrary,
    finalSnapshot.screenshots,
    finalSnapshot.legacyScreenshots,
  ]);
  await writeFallback(canonicalKey(options.collection), options.value);
  await deleteFallback(legacyKey(options.collection));
  return observationForValue(options.value, "canonical");
}

/**
 * Commit one full-list replacement. In production this opens one readwrite
 * IndexedDB transaction and performs the CAS, shared budget check, canonical
 * write, and legacy cleanup before that transaction can complete.
 */
export async function commitAuxiliaryStorage(
  options: CommitAuxiliaryStorageOptions,
): Promise<AuxiliaryObservation> {
  return withCrossContextLock(async () => {
    if (!auxiliaryStore) return commitFallback(options);
    return auxiliaryStore(
      "readwrite",
      (store) => commitAuxiliaryStorageTransaction(store, options),
    );
  });
}

export function commitAuxiliaryStorageTransaction(
  store: IDBObjectStore,
  options: CommitAuxiliaryStorageOptions,
): Promise<AuxiliaryObservation> {
  return new Promise<AuxiliaryObservation>((resolve, reject) => {
    const transaction = store.transaction;
    let settled = false;
    let conflict = false;
    let snapshot: AuxiliaryStorageSnapshot | undefined;
    let readyCount = 0;
    const values = new Array<unknown>(4);

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const abort = (error: unknown) => {
      rejectOnce(error);
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
    };
    const queueCommit = () => {
      if (readyCount !== values.length || snapshot || settled) return;
      snapshot = auxiliarySnapshotFromValues(values);
      if (!observationMatches(snapshot, options)) {
        conflict = true;
        return;
      }
      const finalSnapshot = replacementSnapshot(snapshot, options);
      try {
        assertAuxiliaryStoragePhysicalValuesFit([
          finalSnapshot.library,
          finalSnapshot.legacyLibrary,
          finalSnapshot.screenshots,
          finalSnapshot.legacyScreenshots,
        ]);
        store.put(options.value, canonicalKey(options.collection));
        store.delete(legacyKey(options.collection));
      } catch (error) {
        abort(error);
      }
    };

    transaction.oncomplete = () => {
      if (conflict) rejectOnce(new AuxiliaryStorageConflictError(options.collection));
      else if (!settled) {
        settled = true;
        resolve(observationForValue(options.value, "canonical"));
      }
    };
    transaction.onerror = () => rejectOnce(transaction.error);
    transaction.onabort = () => rejectOnce(transaction.error);

    try {
      [
        PERSONAL_LIBRARY_KEY,
        LEGACY_PERSONAL_LIBRARY_KEY,
        SCREENSHOT_LIBRARY_KEY,
        LEGACY_SCREENSHOT_LIBRARY_KEY,
      ].forEach((key, index) => {
        const request = store.get(key);
        request.onsuccess = () => {
          values[index] = request.result;
          readyCount += 1;
          queueCommit();
        };
        request.onerror = () => abort(request.error);
      });
    } catch (error) {
      abort(error);
    }
  });
}

/** Read all four physical records in one readonly transaction when possible. */
export async function readAuxiliaryStorage(): Promise<AuxiliaryStorageSnapshot> {
  if (!auxiliaryStore) return readSnapshotFallback();
  return auxiliaryStore("readonly", (store) => new Promise((resolve, reject) => {
    const values = new Array<unknown>(4);
    let readyCount = 0;
    const transaction = store.transaction;
    const abort = (error: unknown) => {
      reject(error);
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve(auxiliarySnapshotFromValues(values));
    try {
      [
        PERSONAL_LIBRARY_KEY,
        LEGACY_PERSONAL_LIBRARY_KEY,
        SCREENSHOT_LIBRARY_KEY,
        LEGACY_SCREENSHOT_LIBRARY_KEY,
      ].forEach((key, index) => {
        const request = store.get(key);
        request.onsuccess = () => {
          values[index] = request.result;
          readyCount += 1;
        };
        request.onerror = () => abort(request.error);
      });
    } catch (error) {
      abort(error);
    }
  }));
}
