import { createStore, delMany, get, keys, setMany } from "idb-keyval";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import {
  assertLoadedProjectRasterSafety,
  assertSafeProject,
  assertSanitizedProject,
  isPersistedWrapperTool,
  sanitizeProject,
} from "./safety";
import { cachedSha256Hex, sha256Hex } from "./sha256";
import {
  assertProjectFitsContentBudget,
  type ProjectContentSize,
} from "./project-budget";

const PROJECT_KEY = "patterdraw:autosave:project:v1";
const PDF_KEY_PREFIX = "patterdraw:autosave:pdf:v1:";
const LEGACY_PROJECT_KEY = "excalidraw-classroom:autosave:project:v1";
const LEGACY_PDF_KEY_PREFIX = "excalidraw-classroom:autosave:pdf:v1:";
export const AUTOSAVE_REVISION_KEY = "patterdraw:autosave:revision:v1";
const AUTOSAVE_REVISION_SCHEMA_VERSION = 1 as const;
const MUTATION_LOCK = "patterdraw:autosave:mutation:v1";
const AUTOSAVE_LOAD_RETRY_LIMIT = 2;
const AUTOSAVE_LOAD_SUPERSEDED = Symbol("autosave-load-superseded");
const AUTOSAVE_MIGRATION_REVISION_UNOBSERVED = Symbol("autosave-migration-revision-unobserved");
const AUTOSAVE_MIGRATION_REVISION_ABSENT = Symbol("autosave-migration-revision-absent");
const autosaveStore = createStore("keyval-store", "keyval") as ReturnType<typeof createStore> | undefined;
let mutationQueue: Promise<void> = Promise.resolve();
let writerSequence = 0;
let revisionSequence = 0;
const AUTOSAVE_WRITER_ID = createOpaqueId("writer");
let observedRevision: string | null | undefined;
let observedManifestHash: string | null | undefined;

function autosaveAbortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAutosaveAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : autosaveAbortError();
}

function autosaveAbortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : autosaveAbortError();
}

export interface AutosaveRevisionRecord {
  schemaVersion: typeof AUTOSAVE_REVISION_SCHEMA_VERSION;
  revision: string;
  manifestHash: string;
  writerId: string;
  sequence: number;
  cleared?: boolean;
}

export interface LoadedAutosaveProject extends LoadedClassroomProject {
  /** Opaque sidecar revision used as the optimistic-concurrency token. */
  autosaveRevision: string | null;
  /** Hash of the exact manifest represented by autosaveRevision. */
  autosaveManifestHash: string | null;
  /** Session that last committed this revision, when versioned metadata exists. */
  autosaveWriterId: string | null;
}

export interface SaveAutosaveOptions {
  prepared?: boolean;
  /** Cancel an obsolete preflight before any autosave write is queued. */
  signal?: AbortSignal;
  /**
   * Synchronous final caller invariant, evaluated inside the serialized
   * read-write transaction immediately before its first write is queued.
   * Throwing aborts the complete transaction without changing any key.
   */
  precommitGuard?: () => void;
  /**
   * Opaque revision observed by the caller before it started editing. `null`
   * means the caller expects no current autosave. Omitting the field uses the
   * process-local observation for backwards-compatible callers; a stored
   * revision still rejects unknown/stale writers.
   */
  expectedRevision?: string | null;
  /** Optional exact-manifest identity paired with expectedRevision. */
  expectedManifestHash?: string | null;
  /** Stable process/tab identity. Defaults to one random ID per JS context. */
  writerId?: string;
  /** Explicit recovery action that intentionally replaces a conflicting copy. */
  forceOverwrite?: boolean;
  /** Rewrite every referenced PDF blob as part of this save. */
  replacePdfBlobs?: boolean;
}

export interface LoadAutosaveOptions {
  /** Cancel an obsolete startup restore and its image/PDF preflight. */
  signal?: AbortSignal;
}

export interface AutosaveCommitResult {
  revision: string;
  writerId: string;
}

interface AutosaveMigrationCommitResult extends AutosaveCommitResult {
  revisionRecord: AutosaveRevisionRecord | null;
}

export class AutosaveConflictError extends Error {
  readonly name = "AutosaveConflictError";
  readonly expectedRevision: string | null | undefined;
  readonly actualRevision: string | null;
  readonly expectedManifestHash: string | null | undefined;
  readonly actualManifestHash: string | null;

  constructor(
    expectedRevision: string | null | undefined,
    actualRevision: string | null,
    expectedManifestHash?: string | null,
    actualManifestHash?: string | null,
  ) {
    super("Autosave changed in another tab. The newer work was kept; reload it before saving again.");
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.expectedManifestHash = expectedManifestHash;
    this.actualManifestHash = actualManifestHash ?? null;
  }
}

export interface AutosaveCasExpectation {
  revision: string | null | undefined;
  manifestHash: string | null | undefined;
  writerId: string;
  sequence: number;
  forceOverwrite?: boolean;
  allowOrderedWriterAdvance?: boolean;
}

function createOpaqueId(prefix: string): string {
  revisionSequence += 1;
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    // randomUUID() is restricted to secure contexts, while getRandomValues()
    // remains available to static classroom deployments served over plain
    // HTTP. Keep cross-tab writer/revision identities unpredictable there as
    // well; a timestamp plus a per-tab counter alone can collide when two
    // tabs start in the same millisecond.
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const random = crypto.getRandomValues(new Uint32Array(4));
      return `${prefix}-${Array.from(random, (value) => value.toString(16).padStart(8, "0")).join("")}`;
    }
  } catch {
    // Insecure contexts and test doubles may expose a partial crypto object.
  }
  return `${prefix}-${Date.now().toString(36)}-${revisionSequence.toString(36)}`;
}

export function autosaveManifestHash(project: ClassroomProject | undefined): string | null {
  if (!project) return null;
  try {
    const serialized = JSON.stringify(project);
    let hash = 0x811c9dc5;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  } catch {
    return null;
  }
}

function isAutosaveRevisionRecord(value: unknown): value is AutosaveRevisionRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AutosaveRevisionRecord>;
  return candidate.schemaVersion === AUTOSAVE_REVISION_SCHEMA_VERSION
    && typeof candidate.revision === "string"
    && candidate.revision.length > 0
    && typeof candidate.manifestHash === "string"
    && (candidate.cleared === true || candidate.manifestHash.length > 0)
    && typeof candidate.writerId === "string"
    && candidate.writerId.length > 0
    && typeof candidate.sequence === "number"
    && Number.isSafeInteger(candidate.sequence)
    && candidate.sequence >= 0;
}

function actualAutosaveRevision(
  storedProject: ClassroomProject | undefined,
  storedRevision: unknown,
): AutosaveRevisionRecord | null {
  if (isAutosaveRevisionRecord(storedRevision)) return storedRevision;
  const manifestHash = autosaveManifestHash(storedProject);
  if (!storedProject || !manifestHash) return null;
  // Pre-CAS v1 records have no sidecar. Treat their exact manifest as the
  // baseline token; the first successful save upgrades them transactionally.
  return {
    schemaVersion: AUTOSAVE_REVISION_SCHEMA_VERSION,
    revision: "legacy",
    manifestHash,
    writerId: "legacy",
    sequence: 0,
  };
}

function autosaveRawValuesMatch(expected: unknown, actual: unknown): boolean {
  if (Object.is(expected, actual)) return true;
  try {
    return JSON.stringify(expected) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

function autosaveBytesMatch(expected: Uint8Array | undefined, actual: unknown): boolean {
  if (!expected || !actual) return false;
  const actualBytes = actual instanceof Uint8Array
    ? actual
    : actual instanceof ArrayBuffer
      ? new Uint8Array(actual)
      : ArrayBuffer.isView(actual)
        ? new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength)
        : undefined;
  if (!actualBytes || actualBytes.byteLength !== expected.byteLength) return false;
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (expected[index] !== actualBytes[index]) return false;
  }
  return true;
}

function shouldAllowOrderedWriterAdvance(
  expected: AutosaveCasExpectation,
  actual: AutosaveRevisionRecord | null,
): boolean {
  if (!actual || actual.writerId !== expected.writerId) return false;
  // A save queued by this same JS context may have observed the same token as
  // its predecessor before the predecessor committed. The queue order and
  // monotonically increasing sequence make that ordered hand-off safe. A
  // caller that explicitly supplied a different/stale token is not allowed
  // to bypass the CAS merely because it reuses the same writer ID.
  return expected.allowOrderedWriterAdvance === true
    && actual.sequence < expected.sequence;
}

function autosaveRevisionMatches(
  expected: AutosaveCasExpectation,
  storedProject: ClassroomProject | undefined,
  storedRevision: unknown,
): boolean {
  if (expected.forceOverwrite) return true;
  const actual = actualAutosaveRevision(storedProject, storedRevision);
  const actualToken = actual?.revision ?? null;
  const actualHash = autosaveManifestHash(storedProject) ?? actual?.manifestHash ?? null;
  if (expected.revision === undefined) {
    // An unobserved first save may only create an empty autosave. It must not
    // overwrite an existing project from another tab.
    return !storedProject && !storedRevision;
  }
  if (expected.revision !== actualToken) {
    return shouldAllowOrderedWriterAdvance(expected, actual);
  }
  if (expected.manifestHash && expected.manifestHash !== actualHash) return false;
  return true;
}

function nextAutosaveRevision(
  verifiedProject: ClassroomProject,
  writerId: string,
  sequence: number,
): AutosaveRevisionRecord {
  const manifestHash = autosaveManifestHash(verifiedProject);
  if (!manifestHash) throw new Error("Autosave manifest could not be fingerprinted safely.");
  return {
    schemaVersion: AUTOSAVE_REVISION_SCHEMA_VERSION,
    revision: createOpaqueId("revision"),
    manifestHash,
    writerId,
    sequence,
  };
}

type MutationOperation = (hasCrossContextLock: boolean) => Promise<void>;

export function getStaleAutosaveKeys(
  storedKeys: readonly IDBValidKey[],
  referencedPdfKeys: ReadonlySet<string>,
): string[] {
  return storedKeys.filter((key): key is string => (
    typeof key === "string"
    && (
      (key.startsWith(PDF_KEY_PREFIX) && !referencedPdfKeys.has(key))
      || key === LEGACY_PROJECT_KEY
      || key.startsWith(LEGACY_PDF_KEY_PREFIX)
    )
  ));
}

export function getAutosaveWriteEntries(
  verifiedProject: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  storedProject: ClassroomProject | undefined,
  storedKeys: readonly IDBValidKey[],
  replacePdfBlobs = false,
): [string, ClassroomProject | Uint8Array | AutosaveRevisionRecord][] {
  // Ordinary saves trust the manifest identity so large immutable PDF blobs
  // are not read or rewritten. A deliberate replacement save cannot make
  // that assumption: the stored blob may be corrupt while its manifest still
  // has matching metadata, so it must be included in the atomic write.
  const entries: [string, ClassroomProject | Uint8Array][] = [
    [PROJECT_KEY, verifiedProject],
  ];
  const existingKeySet = new Set(storedKeys);
  for (const [id, source] of Object.entries(verifiedProject.pdfDocuments)) {
    const bytes = pdfBytes[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    const key = `${PDF_KEY_PREFIX}${id}`;
    const storedSource = storedProject?.pdfDocuments?.[id];
    if (
      replacePdfBlobs
      || !existingKeySet.has(key)
      || storedSource?.byteLength !== source.byteLength
      || storedSource?.sha256 !== source.sha256
    ) {
      entries.push([key, bytes]);
    }
  }
  return entries;
}

export function commitAutosaveTransaction(
  store: IDBObjectStore,
  verifiedProject: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  referencedPdfKeys: ReadonlySet<string>,
  replacePdfBlobs = false,
  expected?: AutosaveCasExpectation,
  signal?: AbortSignal,
  precommitGuard?: () => void,
): Promise<AutosaveCommitResult> {
  if (signal?.aborted) return Promise.reject(autosaveAbortReason(signal));
  const nextRevision = nextAutosaveRevision(
    verifiedProject,
    expected?.writerId || AUTOSAVE_WRITER_ID,
    expected?.sequence ?? 0,
  );
  return new Promise<AutosaveCommitResult>((resolve, reject) => {
    const transaction = store.transaction;
    let conflict: AutosaveConflictError | undefined;
    let settled = false;
    let signalAbort: Error | undefined;
    const removeAbortListener = () => signal?.removeEventListener("abort", abortForSignal);
    const settleResolve = (result: AutosaveCommitResult) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      resolve(result);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error);
    };
    const abortForSignal = () => {
      if (settled) return;
      signalAbort = autosaveAbortReason(signal);
      try {
        transaction.abort();
      } catch {
        // IndexedDB has already entered its irreversible commit window. Let
        // its terminal event decide the outcome so a committed save is never
        // reported as cancelled and its revision token remains observable.
        signalAbort = undefined;
        return;
      }
      settleReject(signalAbort);
    };
    transaction.oncomplete = () => conflict ? settleReject(conflict) : settleResolve({
      revision: nextRevision.revision,
      writerId: nextRevision.writerId,
    });
    transaction.onerror = () => settleReject(transaction.error);
    transaction.onabort = () => settleReject(signalAbort ?? transaction.error ?? autosaveAbortError());
    let storedProject: ClassroomProject | undefined;
    let storedRevision: unknown;
    let storedKeys: IDBValidKey[] = [];
    let projectReady = false;
    let revisionReady = false;
    let keysReady = false;
    let writesQueued = false;

    const abort = (error: unknown) => {
      // Preserve the actionable caller/write failure. Some IndexedDB
      // implementations surface only a generic AbortError on transaction
      // abort, but this branch always runs before commit is possible.
      settleReject(error);
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
    };
    const queueWrites = () => {
      if (!projectReady || !revisionReady || !keysReady || writesQueued) return;
      writesQueued = true;
      if (signal?.aborted) {
        abortForSignal();
        return;
      }
      if (expected && !autosaveRevisionMatches(expected, storedProject, storedRevision)) {
        const actual = actualAutosaveRevision(storedProject, storedRevision);
        conflict = new AutosaveConflictError(
          expected.revision,
          actual?.revision ?? null,
          expected.manifestHash,
          autosaveManifestHash(storedProject) ?? actual?.manifestHash,
        );
        return;
      }
      try {
        // This callback shares the same JavaScript turn as the first put. A
        // caller can therefore close a live-state TOCTOU after async
        // verification and Web Lock waiting without allowing a partial write.
        precommitGuard?.();
        for (const [key, value] of getAutosaveWriteEntries(
          verifiedProject,
          pdfBytes,
          storedProject,
          storedKeys,
          replacePdfBlobs,
        )) {
          store.put(value, key);
        }
        if (expected) store.put(nextRevision, AUTOSAVE_REVISION_KEY);
        for (const key of getStaleAutosaveKeys(storedKeys, referencedPdfKeys)) {
          store.delete(key);
        }
      } catch (error) {
        abort(error);
      }
    };

    try {
      signal?.addEventListener("abort", abortForSignal, { once: true });
      if (signal?.aborted) {
        abortForSignal();
        return;
      }
      // Read and conditionally write inside the same readwrite transaction.
      // IndexedDB serializes that transaction across tabs even when the Web
      // Locks API is unavailable, so unchanged large PDF blobs stay untouched
      // without reopening the manifest/blob race this fallback prevents.
      const projectRequest = store.get(PROJECT_KEY);
      const revisionRequest = store.get(AUTOSAVE_REVISION_KEY);
      const keyRequest = store.getAllKeys();
      projectRequest.onsuccess = () => {
        storedProject = projectRequest.result as ClassroomProject | undefined;
        projectReady = true;
        queueWrites();
      };
      projectRequest.onerror = () => abort(projectRequest.error);
      revisionRequest.onsuccess = () => {
        storedRevision = revisionRequest.result;
        revisionReady = true;
        queueWrites();
      };
      revisionRequest.onerror = () => abort(revisionRequest.error);
      keyRequest.onsuccess = () => {
        storedKeys = keyRequest.result;
        keysReady = true;
        queueWrites();
      };
      keyRequest.onerror = () => abort(keyRequest.error);
    } catch (error) {
      abort(error);
    }
  });
}

export function autosaveManifestsMatch(
  expected: ClassroomProject | undefined,
  stored: ClassroomProject | undefined,
): boolean {
  if (!expected || !stored) return expected === stored;
  try {
    // A migration is allowed to rewrite only the exact manifest it verified.
    // Comparing the complete structured value also protects against two tabs
    // producing different edits within the same timestamp resolution.
    return JSON.stringify(expected) === JSON.stringify(stored);
  } catch {
    return false;
  }
}

function commitAutosaveMigrationTransactionResult(
  store: IDBObjectStore,
  expectedProject: ClassroomProject,
  fromLegacyKey: boolean,
  verifiedProject: ClassroomProject,
  pdfEntries: readonly (readonly [PdfDocumentId, Uint8Array])[],
  writerId = AUTOSAVE_WRITER_ID,
  expectedRawRevision?: unknown,
  signal?: AbortSignal,
): Promise<AutosaveMigrationCommitResult | null> {
  if (signal?.aborted) return Promise.reject(autosaveAbortReason(signal));
  const rawRevisionObserved = arguments.length >= 7;
  const nextRevision = nextAutosaveRevision(verifiedProject, writerId, ++writerSequence);
  return new Promise<AutosaveMigrationCommitResult | null>((resolve, reject) => {
    const transaction = store.transaction;
    let settled = false;
    let signalAbort: Error | undefined;
    let migrated = false;
    let decisionMade = false;
    let currentReady = false;
    let legacyReady = !fromLegacyKey;
    let revisionReady = false;
    let keysReady = false;
    const sourcePdfIds = new Set<string>([
      ...Object.keys(expectedProject.pdfDocuments),
      ...pdfEntries.map(([id]) => id),
    ]);
    const expectedPdfBytes = new Map<string, Uint8Array>(pdfEntries);
    const storedPdfBytes = new Map<string, unknown>();
    let sourcePdfsReady = sourcePdfIds.size === 0;
    let storedCurrent: ClassroomProject | undefined;
    let storedLegacy: ClassroomProject | undefined;
    let storedRevision: unknown;
    let storedKeys: IDBValidKey[] = [];

    const removeAbortListener = () => signal?.removeEventListener("abort", abortForSignal);
    const settleResolve = (result: AutosaveMigrationCommitResult | null) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      resolve(result);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error);
    };
    const abortForSignal = () => {
      if (settled) return;
      signalAbort = autosaveAbortReason(signal);
      try {
        transaction.abort();
      } catch {
        // A transaction that can no longer be aborted is already committing.
        // Preserve that successful migration and let the caller discard its
        // now-obsolete load result after the terminal event.
        signalAbort = undefined;
        return;
      }
      settleReject(signalAbort);
    };
    transaction.oncomplete = () => settleResolve(migrated ? {
      revision: nextRevision.revision,
      writerId: nextRevision.writerId,
      revisionRecord: nextRevision,
    } : null);
    transaction.onerror = () => settleReject(transaction.error);
    transaction.onabort = () => settleReject(signalAbort ?? transaction.error ?? autosaveAbortError());

    const abort = (error: unknown) => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
      settleReject(error);
    };
    const queueMigration = () => {
      if (
        !currentReady
        || !legacyReady
        || !revisionReady
        || !keysReady
        || !sourcePdfsReady
        || decisionMade
      ) return;
      decisionMade = true;
      const sidecarStillCurrent = !rawRevisionObserved
        || expectedRawRevision === AUTOSAVE_MIGRATION_REVISION_UNOBSERVED
        || autosaveRawValuesMatch(
          expectedRawRevision === AUTOSAVE_MIGRATION_REVISION_ABSENT
            ? undefined
            : expectedRawRevision,
          storedRevision,
        );
      const sourcePdfsStillCurrent = [...sourcePdfIds].every((id) => (
        autosaveBytesMatch(expectedPdfBytes.get(id), storedPdfBytes.get(id))
      ));
      const sourceStillCurrent = fromLegacyKey
        ? !storedCurrent
          && !isAutosaveRevisionRecord(storedRevision)
          && sidecarStillCurrent
          && autosaveManifestsMatch(expectedProject, storedLegacy)
        : sidecarStillCurrent
          && !(isAutosaveRevisionRecord(storedRevision) && storedRevision.cleared === true)
          && autosaveManifestsMatch(expectedProject, storedCurrent);
      if (!sourceStillCurrent || !sourcePdfsStillCurrent) return;

      try {
        store.put(verifiedProject, PROJECT_KEY);
        store.put(nextRevision, AUTOSAVE_REVISION_KEY);
        for (const [id, bytes] of pdfEntries) {
          store.put(bytes, `${PDF_KEY_PREFIX}${id}`);
        }
        const referencedPdfKeys = new Set(
          pdfEntries.map(([id]) => `${PDF_KEY_PREFIX}${id}`),
        );
        for (const key of getStaleAutosaveKeys(storedKeys, referencedPdfKeys)) {
          store.delete(key);
        }
        migrated = true;
      } catch (error) {
        abort(error);
      }
    };

    try {
      signal?.addEventListener("abort", abortForSignal, { once: true });
      if (signal?.aborted) {
        abortForSignal();
        return;
      }
      // The comparison and conditional writes share one readwrite transaction.
      // IndexedDB therefore serializes them with saves from every other tab,
      // even in browsers that do not implement the Web Locks API.
      const currentRequest = store.get(PROJECT_KEY);
      const revisionRequest = store.get(AUTOSAVE_REVISION_KEY);
      const keyRequest = store.getAllKeys();
      currentRequest.onsuccess = () => {
        storedCurrent = currentRequest.result as ClassroomProject | undefined;
        currentReady = true;
        queueMigration();
      };
      currentRequest.onerror = () => abort(currentRequest.error);
      revisionRequest.onsuccess = () => {
        storedRevision = revisionRequest.result;
        revisionReady = true;
        queueMigration();
      };
      revisionRequest.onerror = () => abort(revisionRequest.error);
      keyRequest.onsuccess = () => {
        storedKeys = keyRequest.result;
        keysReady = true;
        queueMigration();
      };
      keyRequest.onerror = () => abort(keyRequest.error);

      for (const id of sourcePdfIds) {
        const sourcePrefix = fromLegacyKey ? LEGACY_PDF_KEY_PREFIX : PDF_KEY_PREFIX;
        const pdfRequest = store.get(`${sourcePrefix}${id}`);
        pdfRequest.onsuccess = () => {
          storedPdfBytes.set(id, pdfRequest.result);
          if (storedPdfBytes.size === sourcePdfIds.size) {
            sourcePdfsReady = true;
            queueMigration();
          }
        };
        pdfRequest.onerror = () => abort(pdfRequest.error);
      }

      if (fromLegacyKey) {
        const legacyRequest = store.get(LEGACY_PROJECT_KEY);
        legacyRequest.onsuccess = () => {
          storedLegacy = legacyRequest.result as ClassroomProject | undefined;
          legacyReady = true;
          queueMigration();
        };
        legacyRequest.onerror = () => abort(legacyRequest.error);
      }
    } catch (error) {
      abort(error);
    }
  });
}

export function commitAutosaveMigrationTransaction(
  store: IDBObjectStore,
  expectedProject: ClassroomProject,
  fromLegacyKey: boolean,
  verifiedProject: ClassroomProject,
  pdfEntries: readonly (readonly [PdfDocumentId, Uint8Array])[],
  writerId = AUTOSAVE_WRITER_ID,
  expectedRawRevision?: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  const migration = arguments.length >= 7
    ? commitAutosaveMigrationTransactionResult(
      store,
      expectedProject,
      fromLegacyKey,
      verifiedProject,
      pdfEntries,
      writerId,
      expectedRawRevision,
      signal,
    )
    : commitAutosaveMigrationTransactionResult(
      store,
      expectedProject,
      fromLegacyKey,
      verifiedProject,
      pdfEntries,
      writerId,
    );
  return migration.then((result) => result !== null);
}

export function validateAutosaveSnapshotTransaction(
  store: IDBObjectStore,
  expectedProject: ClassroomProject | undefined,
  fromLegacyKey: boolean,
  expectedRevision?: string | null,
  expectedManifestHash?: string | null,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const transaction = store.transaction;
    let matches = false;
    let decisionMade = false;
    let currentReady = false;
    const mustReadLegacy = fromLegacyKey || expectedProject === undefined;
    let legacyReady = !mustReadLegacy;
    let revisionReady = false;
    let storedCurrent: ClassroomProject | undefined;
    let storedLegacy: ClassroomProject | undefined;
    let storedRevision: unknown;

    transaction.oncomplete = () => resolve(matches);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    const abort = (error: unknown) => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
      reject(error);
    };
    const decide = () => {
      if (!currentReady || !legacyReady || !revisionReady || decisionMade) return;
      decisionMade = true;
      const manifestMatches = expectedProject === undefined
        ? !storedCurrent && !storedLegacy
        : fromLegacyKey
          ? !storedCurrent && autosaveManifestsMatch(expectedProject, storedLegacy)
          : autosaveManifestsMatch(expectedProject, storedCurrent);
      const actual = actualAutosaveRevision(
        fromLegacyKey ? storedLegacy : storedCurrent,
        storedRevision,
      );
      const revisionMatches = expectedRevision === undefined
        ? true
        : (actual?.revision ?? null) === expectedRevision;
      const hashMatches = !expectedManifestHash
        || expectedManifestHash === (autosaveManifestHash(
          fromLegacyKey ? storedLegacy : storedCurrent,
        ) ?? actual?.manifestHash);
      matches = manifestMatches && revisionMatches && hashMatches;
    };

    try {
      // A readwrite transaction acts as the same cross-tab serialization
      // point as save/migration transactions in browsers without Web Locks.
      // No data is written; it only proves that the manifest whose PDF bytes
      // were verified is still the current one before loadAutosave returns it.
      const currentRequest = store.get(PROJECT_KEY);
      const revisionRequest = store.get(AUTOSAVE_REVISION_KEY);
      currentRequest.onsuccess = () => {
        storedCurrent = currentRequest.result as ClassroomProject | undefined;
        currentReady = true;
        decide();
      };
      currentRequest.onerror = () => abort(currentRequest.error);
      revisionRequest.onsuccess = () => {
        storedRevision = revisionRequest.result;
        revisionReady = true;
        decide();
      };
      revisionRequest.onerror = () => abort(revisionRequest.error);

      if (mustReadLegacy) {
        const legacyRequest = store.get(LEGACY_PROJECT_KEY);
        legacyRequest.onsuccess = () => {
          storedLegacy = legacyRequest.result as ClassroomProject | undefined;
          legacyReady = true;
          decide();
        };
        legacyRequest.onerror = () => abort(legacyRequest.error);
      }
    } catch (error) {
      abort(error);
    }
  });
}

export function commitAutosaveClearTransaction(store: IDBObjectStore): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = store.transaction;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);

    const abort = (error: unknown) => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
      reject(error);
    };

    try {
      const keyRequest = store.getAllKeys();
      keyRequest.onsuccess = () => {
        try {
          for (const key of keyRequest.result) {
            if (
              typeof key === "string"
              && (
                key === PROJECT_KEY
                || key === AUTOSAVE_REVISION_KEY
                || key === LEGACY_PROJECT_KEY
                || key.startsWith(PDF_KEY_PREFIX)
                || key.startsWith(LEGACY_PDF_KEY_PREFIX)
              )
            ) store.delete(key);
          }
          // Keep a fresh tombstone instead of deleting the version record. A
          // stale writer that observed a prior non-null token must not be able
          // to resurrect an autosave after clear-and-recreate (ABA).
          store.put({
            schemaVersion: AUTOSAVE_REVISION_SCHEMA_VERSION,
            revision: createOpaqueId("clear"),
            manifestHash: "",
            writerId: AUTOSAVE_WRITER_ID,
            sequence: ++writerSequence,
            cleared: true,
          } satisfies AutosaveRevisionRecord, AUTOSAVE_REVISION_KEY);
        } catch (error) {
          abort(error);
        }
      };
      keyRequest.onerror = () => abort(keyRequest.error);
    } catch (error) {
      abort(error);
    }
  });
}

async function migrateAutosaveWithoutCrossContextLock(
  expectedProject: ClassroomProject,
  fromLegacyKey: boolean,
  verifiedProject: ClassroomProject,
  pdfEntries: readonly (readonly [PdfDocumentId, Uint8Array])[],
  writerId = AUTOSAVE_WRITER_ID,
  expectedRawRevision: unknown = AUTOSAVE_MIGRATION_REVISION_UNOBSERVED,
  signal?: AbortSignal,
): Promise<AutosaveMigrationCommitResult | null> {
  // Unit environments can replace createStore with an unavailable test
  // double. Production browsers always take the transaction branch below.
  if (!autosaveStore) {
    throwIfAutosaveAborted(signal);
    const referencedPdfKeys = new Set(
      pdfEntries.map(([id]) => `${PDF_KEY_PREFIX}${id}`),
    );
    const storedKeys = await keys();
    throwIfAutosaveAborted(signal);
    await setMany([
      [PROJECT_KEY, verifiedProject],
      ...pdfEntries.map(
        ([id, bytes]): [string, Uint8Array] => [`${PDF_KEY_PREFIX}${id}`, bytes],
      ),
    ]);
    const staleKeys = new Set(getStaleAutosaveKeys(storedKeys, referencedPdfKeys));
    if (fromLegacyKey) {
      staleKeys.add(LEGACY_PROJECT_KEY);
      for (const [id] of pdfEntries) {
        staleKeys.add(`${LEGACY_PDF_KEY_PREFIX}${id}`);
      }
    }
    if (staleKeys.size > 0) {
      await delMany([
        ...staleKeys,
      ]);
    }
    // The fallback path is retained for unit doubles and legacy environments
    // without a transaction-capable custom store. It cannot mint a sidecar
    // token atomically, so the caller must continue using its pre-migration
    // observation instead of reading a potentially newer token afterwards.
    return {
      revision: "",
      writerId,
      revisionRecord: null,
    };
  }
  return autosaveStore(
    "readwrite",
    (store) => commitAutosaveMigrationTransactionResult(
      store,
      expectedProject,
      fromLegacyKey,
      verifiedProject,
      pdfEntries,
      writerId,
      expectedRawRevision,
      signal,
    ),
  );
}

async function validateAutosaveWithoutCrossContextLock(
  expectedProject: ClassroomProject | undefined,
  fromLegacyKey: boolean,
  expectedRevision?: string | null,
  expectedManifestHash?: string | null,
): Promise<boolean> {
  // Unit suites that replace createStore exercise the transaction helper
  // directly. Production browsers always have this store function.
  if (!autosaveStore) return true;
  return autosaveStore(
    "readwrite",
    (store) => validateAutosaveSnapshotTransaction(
      store,
      expectedProject,
      fromLegacyKey,
      expectedRevision,
      expectedManifestHash,
    ),
  );
}

async function setManyAndDeleteStaleAtomically(
  verifiedProject: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  referencedPdfKeys: ReadonlySet<string>,
  replacePdfBlobs = false,
  expected?: AutosaveCasExpectation,
  signal?: AbortSignal,
  precommitGuard?: () => void,
): Promise<AutosaveCommitResult> {
  // Unit environments can replace createStore with an unavailable test
  // double. Production browsers always use this single readwrite transaction,
  // whose object-store serialization is the no-Web-Locks cross-tab mutex.
  if (!autosaveStore) {
    throwIfAutosaveAborted(signal);
    const [storedProject, storedRevision] = await Promise.all([
      get<ClassroomProject>(PROJECT_KEY),
      get<AutosaveRevisionRecord>(AUTOSAVE_REVISION_KEY),
    ]);
    throwIfAutosaveAborted(signal);
    if (expected && !autosaveRevisionMatches(expected, storedProject, storedRevision)) {
      const actual = actualAutosaveRevision(storedProject, storedRevision);
      throw new AutosaveConflictError(
        expected.revision,
        actual?.revision ?? null,
        expected.manifestHash,
        autosaveManifestHash(storedProject) ?? actual?.manifestHash,
      );
    }
    const nextRevision = nextAutosaveRevision(
      verifiedProject,
      expected?.writerId || AUTOSAVE_WRITER_ID,
      expected?.sequence ?? ++writerSequence,
    );
    const entries = getAutosaveWriteEntries(
      verifiedProject,
      pdfBytes,
      undefined,
      [],
      replacePdfBlobs,
    );
    if (expected) entries.push([AUTOSAVE_REVISION_KEY, nextRevision]);
    throwIfAutosaveAborted(signal);
    precommitGuard?.();
    await setMany(entries);
    return { revision: nextRevision.revision, writerId: nextRevision.writerId };
  }
  return autosaveStore(
    "readwrite",
    (store) => commitAutosaveTransaction(
      store,
      verifiedProject,
      pdfBytes,
      referencedPdfKeys,
      replacePdfBlobs,
      expected,
      signal,
      precommitGuard,
    ),
  );
}

async function withCrossContextLock<T>(
  operation: (hasCrossContextLock: boolean) => Promise<T>,
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return operation(false);
  }
  return navigator.locks.request(MUTATION_LOCK, () => operation(true));
}

function enqueueMutation(operation: MutationOperation): Promise<void> {
  const queued = mutationQueue
    .catch(() => undefined)
    .then(() => withCrossContextLock(operation));
  mutationQueue = queued;
  return queued;
}

export async function saveAutosave(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  options: SaveAutosaveOptions = {},
): Promise<ProjectContentSize & AutosaveCommitResult> {
  throwIfAutosaveAborted(options.signal);
  const writerId = options.writerId || AUTOSAVE_WRITER_ID;
  const sequence = ++writerSequence;
  const strictCas = Boolean(autosaveStore)
    || options.expectedRevision !== undefined
    || options.expectedManifestHash !== undefined
    || options.forceOverwrite === true;
  const expectedRevision = options.expectedRevision !== undefined
    ? options.expectedRevision
    : observedRevision;
  const expectedManifestHash = options.expectedManifestHash !== undefined
    ? options.expectedManifestHash
    : observedManifestHash;
  const explicitExpectation = options.expectedRevision !== undefined
    || options.expectedManifestHash !== undefined;
  const expected: AutosaveCasExpectation | undefined = strictCas ? {
    revision: expectedRevision,
    manifestHash: expectedManifestHash,
    writerId,
    sequence,
    forceOverwrite: options.forceOverwrite,
    allowOrderedWriterAdvance: !explicitExpectation
      && expectedRevision === observedRevision
      && expectedManifestHash === observedManifestHash,
  } : undefined;
  const safe = options.prepared ? project : sanitizeProject(project);
  assertSanitizedProject(safe);
  const documentVerifications = Object.entries(safe.pdfDocuments).map(([id, source]) => {
      throwIfAutosaveAborted(options.signal);
      const bytes = pdfBytes[id];
      if (!bytes || bytes.byteLength !== source.byteLength) {
        throw new Error(`PDF data does not match project metadata for ${source.name}.`);
      }
      const cachedSha256 = cachedSha256Hex(bytes);
      if (cachedSha256) {
        if (source.sha256 && source.sha256 !== cachedSha256) {
          throw new Error(`PDF data does not match project metadata for ${source.name}.`);
        }
        return [id, { ...source, sha256: cachedSha256 }] as const;
      }
      return sha256Hex(bytes).then((sha256) => {
        throwIfAutosaveAborted(options.signal);
        if (source.sha256 && source.sha256 !== sha256) {
          throw new Error(`PDF data does not match project metadata for ${source.name}.`);
        }
        return [id, { ...source, sha256 }] as const;
      });
    });
  const requiresAsyncVerification = documentVerifications.some(
    (entry) => entry instanceof Promise,
  );
  throwIfAutosaveAborted(options.signal);
  const verifiedDocuments = requiresAsyncVerification
    ? await Promise.all(documentVerifications)
    : documentVerifications as Array<readonly [
      string,
      ClassroomProject["pdfDocuments"][string],
    ]>;
  throwIfAutosaveAborted(options.signal);
  const verifiedProject: ClassroomProject = {
    ...safe,
    pdfDocuments: Object.fromEntries(verifiedDocuments),
  };
  // Keep autosave's write path subject to the same image/PDF preflight as
  // archive restore. This runs before the first IndexedDB put, so malformed or
  // oversized local images cannot be persisted and then rejected on reload.
  await assertLoadedProjectRasterSafety(
    { project: verifiedProject, pdfBytes },
    { signal: options.signal },
  );
  throwIfAutosaveAborted(options.signal);
  const contentSize = assertProjectFitsContentBudget(verifiedProject, pdfBytes);
  throwIfAutosaveAborted(options.signal);
  let commitResult: AutosaveCommitResult | undefined;

  await enqueueMutation(async (hasCrossContextLock) => {
    // A save may have waited behind a different tab/context mutation. Check
    // again at the queue boundary so an obsolete caller performs no writes.
    throwIfAutosaveAborted(options.signal);
    const referencedKeys = new Set(
      Object.keys(verifiedProject.pdfDocuments).map((id) => `${PDF_KEY_PREFIX}${id}`),
    );
    // A real IndexedDB store is the linearization point even when Web Locks
    // are available: tabs without Web Locks must serialize against this same
    // transaction. The setMany fallback exists only for unit doubles and old
    // environments that cannot expose a custom store.
    if (!hasCrossContextLock || autosaveStore) {
      commitResult = await setManyAndDeleteStaleAtomically(
        verifiedProject,
        pdfBytes,
        referencedKeys,
        options.replacePdfBlobs,
        expected,
        options.signal,
        options.precommitGuard,
      );
      return;
    }

    const [storedProject, storedRevision, existingKeys] = await Promise.all([
      get<ClassroomProject>(PROJECT_KEY),
      expected
        ? get<AutosaveRevisionRecord>(AUTOSAVE_REVISION_KEY)
        : Promise.resolve(undefined),
      keys(),
    ]);
    throwIfAutosaveAborted(options.signal);
    if (expected && !autosaveRevisionMatches(expected, storedProject, storedRevision)) {
      const actual = actualAutosaveRevision(storedProject, storedRevision);
      throw new AutosaveConflictError(
        expected.revision,
        actual?.revision ?? null,
        expected.manifestHash,
        autosaveManifestHash(storedProject) ?? actual?.manifestHash,
      );
    }
    const nextRevision = nextAutosaveRevision(verifiedProject, writerId, sequence);
    const entries = getAutosaveWriteEntries(
      verifiedProject,
      pdfBytes,
      storedProject,
      existingKeys,
      options.replacePdfBlobs,
    );
    if (expected) entries.push([AUTOSAVE_REVISION_KEY, nextRevision]);
    throwIfAutosaveAborted(options.signal);
    options.precommitGuard?.();
    await setMany(entries);
    commitResult = { revision: nextRevision.revision, writerId };

    const staleKeys = getStaleAutosaveKeys(existingKeys, referencedKeys);
    if (staleKeys.length && !options.signal?.aborted) {
      try {
        await delMany(staleKeys);
      } catch {
        // The manifest and every referenced PDF were committed atomically.
        // Orphan cleanup is optional and can be retried by the next save.
      }
    }
  });
  // Once the write transaction/promise has committed, cancellation is too
  // late to undo it. Report success and advance the observed token so a
  // follow-up save cannot self-conflict against work this caller did persist.
  if (!commitResult) throw new Error("Autosave did not commit a revision.");
  if (expected) {
    observedRevision = commitResult.revision;
    observedManifestHash = autosaveManifestHash(verifiedProject);
  }
  return { ...contentSize, ...commitResult };
}

async function loadAutosaveAttempt(
  remainingRetries: number,
  options: LoadAutosaveOptions = {},
): Promise<LoadedAutosaveProject | null> {
  throwIfAutosaveAborted(options.signal);
  const result = await withCrossContextLock(async () => {
    throwIfAutosaveAborted(options.signal);
    const currentProject = await get<ClassroomProject>(PROJECT_KEY);
    throwIfAutosaveAborted(options.signal);
    const storedRevision = autosaveStore
      ? await get<AutosaveRevisionRecord>(AUTOSAVE_REVISION_KEY)
      : undefined;
    throwIfAutosaveAborted(options.signal);
    const project = currentProject || await get<ClassroomProject>(LEGACY_PROJECT_KEY);
    throwIfAutosaveAborted(options.signal);
    if (!project) {
      const emptyRevision = isAutosaveRevisionRecord(storedRevision)
        ? storedRevision.revision
        : null;
      const emptyManifestHash = isAutosaveRevisionRecord(storedRevision)
        ? storedRevision.manifestHash
        : null;
      const emptySnapshotUnchanged = await validateAutosaveWithoutCrossContextLock(
        undefined,
        false,
        emptyRevision,
        emptyManifestHash,
      );
      throwIfAutosaveAborted(options.signal);
      if (!emptySnapshotUnchanged) return AUTOSAVE_LOAD_SUPERSEDED;
      observedRevision = emptyRevision;
      observedManifestHash = emptyManifestHash;
      return null;
    }
    assertSafeProject(project);
    const safeProject = sanitizeProject(project);
    const pdfKeyPrefix = currentProject ? PDF_KEY_PREFIX : LEGACY_PDF_KEY_PREFIX;

    const loadedPdfEntries = await Promise.all(
      Object.entries(safeProject.pdfDocuments).map(async ([id, source]) => {
        throwIfAutosaveAborted(options.signal);
        const bytes = await get<Uint8Array>(`${pdfKeyPrefix}${id}`);
        throwIfAutosaveAborted(options.signal);
        if (!bytes) {
          throw new Error(`Autosave is missing PDF data for ${id}.`);
        }
        if (bytes.byteLength !== source.byteLength) {
          throw new Error(`Autosave PDF data does not match project metadata for ${source.name}.`);
        }
        const sha256 = await sha256Hex(bytes);
        throwIfAutosaveAborted(options.signal);
        if (source.sha256 && source.sha256 !== sha256) {
          throw new Error(`Autosave PDF data does not match project content identity for ${source.name}.`);
        }
        return { bytes, id, source: { ...source, sha256 } };
      }),
    );
    const verifiedProject: ClassroomProject = {
      ...safeProject,
      pdfDocuments: Object.fromEntries(
        loadedPdfEntries.map(({ id, source }) => [id, source]),
      ),
    };
    assertSafeProject(verifiedProject);
    const pdfEntries = loadedPdfEntries.map(({ bytes, id }) => [id, bytes] as const);
    const loaded: LoadedAutosaveProject = {
      project: verifiedProject,
      pdfBytes: Object.fromEntries(pdfEntries),
      autosaveRevision: isAutosaveRevisionRecord(storedRevision)
        ? storedRevision.revision
        : (currentProject ? "legacy" : null),
      autosaveManifestHash: isAutosaveRevisionRecord(storedRevision)
        ? storedRevision.manifestHash
        : autosaveManifestHash(project),
      autosaveWriterId: isAutosaveRevisionRecord(storedRevision)
        ? storedRevision.writerId
        : null,
    };
    await assertLoadedProjectRasterSafety(loaded, { signal: options.signal });
    throwIfAutosaveAborted(options.signal);

    const needsMigration = !currentProject
      || Object.values(project.scenes).some((scene) => (
        isPersistedWrapperTool(scene.appState?.activeTool)
      ))
      || safeProject.title !== project.title
      || safeProject.titleMode !== project.titleMode
      || Object.values(safeProject.pdfDocuments).some((source) => !source.sha256)
      || !isAutosaveRevisionRecord(storedRevision)
      || (
        isAutosaveRevisionRecord(storedRevision)
        && storedRevision.manifestHash !== autosaveManifestHash(project)
      );
    let snapshotSuperseded = false;
    let migrationResult: AutosaveMigrationCommitResult | null | undefined;
    if (needsMigration) {
      try {
        throwIfAutosaveAborted(options.signal);
        migrationResult = await migrateAutosaveWithoutCrossContextLock(
          project,
          !currentProject,
          verifiedProject,
          pdfEntries,
          AUTOSAVE_WRITER_ID,
          storedRevision === undefined
            ? AUTOSAVE_MIGRATION_REVISION_ABSENT
            : storedRevision,
          options.signal,
        );
        throwIfAutosaveAborted(options.signal);
        // A clean false result means the transaction observed a newer
        // manifest. Storage failures are different: migration is optional
        // and the already-verified source can still be opened safely.
        snapshotSuperseded = migrationResult === null;
      } catch {
        // Opening valid work is more important than an eager schema upgrade.
        // The returned project carries hashes, so the next autosave retries.
        // Keep the pre-migration token; reading the sidecar again here could
        // pair these bytes with another writer's newer revision.
        throwIfAutosaveAborted(options.signal);
      }
    }
    if (!snapshotSuperseded) {
      // Web Locks are an optimization, not the consistency boundary. An
      // older bundle, a mixed-capability context, or a test double may still
      // write through IndexedDB without taking this lock. Revalidate the
      // manifest/revision inside one serialized readwrite transaction before
      // returning bytes assembled by separate idb-keyval reads.
      throwIfAutosaveAborted(options.signal);
      const migratedRevision = migrationResult?.revisionRecord;
      const validationProject = migratedRevision ? verifiedProject : project;
      const validationFromLegacyKey = migratedRevision ? false : !currentProject;
      const validationRevision = migratedRevision?.revision
        ?? (currentProject
          ? (loaded.autosaveRevision === "legacy" ? "legacy" : loaded.autosaveRevision)
          : undefined);
      const validationManifestHash = migratedRevision?.manifestHash
        ?? loaded.autosaveManifestHash;
      snapshotSuperseded = !(await validateAutosaveWithoutCrossContextLock(
        validationProject,
        validationFromLegacyKey,
        validationRevision,
        validationManifestHash,
      ));
      throwIfAutosaveAborted(options.signal);
    }
    if (snapshotSuperseded) {
      // Do not recurse while the Web Lock callback is still active: Web Locks
      // are non-reentrant, so requesting the same lock here would deadlock.
      return AUTOSAVE_LOAD_SUPERSEDED;
    }
    if (migrationResult?.revisionRecord && !snapshotSuperseded) {
      loaded.autosaveRevision = migrationResult.revisionRecord.revision;
      loaded.autosaveManifestHash = migrationResult.revisionRecord.manifestHash;
      loaded.autosaveWriterId = migrationResult.revisionRecord.writerId;
    }
    observedRevision = loaded.autosaveRevision;
    observedManifestHash = loaded.autosaveManifestHash;
    return loaded;
  });
  if (result === AUTOSAVE_LOAD_SUPERSEDED) {
    throwIfAutosaveAborted(options.signal);
    if (remainingRetries <= 0) {
      throw new Error("Autosave changed in another tab while it was opening. Try opening it again.");
    }
    return loadAutosaveAttempt(remainingRetries - 1, options);
  }
  return result;
}

export async function loadAutosave(
  options: LoadAutosaveOptions = {},
): Promise<LoadedAutosaveProject | null> {
  return loadAutosaveAttempt(AUTOSAVE_LOAD_RETRY_LIMIT, options);
}

/** Read the current sidecar token, including the clear tombstone when empty. */
export async function getAutosaveRevision(): Promise<AutosaveRevisionRecord | null> {
  const stored = await get<AutosaveRevisionRecord>(AUTOSAVE_REVISION_KEY);
  return isAutosaveRevisionRecord(stored) ? stored : null;
}

export async function clearAutosave(_project?: ClassroomProject): Promise<void> {
  await enqueueMutation(async () => {
    if (autosaveStore) {
      await autosaveStore("readwrite", commitAutosaveClearTransaction);
      const tombstone = await get<AutosaveRevisionRecord>(AUTOSAVE_REVISION_KEY);
      observedRevision = isAutosaveRevisionRecord(tombstone) ? tombstone.revision : null;
      observedManifestHash = isAutosaveRevisionRecord(tombstone)
        ? tombstone.manifestHash
        : null;
      return;
    }
    const storedKeys = await keys();
    const pdfKeys = storedKeys.filter((key): key is string => (
      typeof key === "string"
      && (key.startsWith(PDF_KEY_PREFIX) || key.startsWith(LEGACY_PDF_KEY_PREFIX))
    ));
    await delMany([
      PROJECT_KEY,
      ...(storedKeys.includes(AUTOSAVE_REVISION_KEY) ? [AUTOSAVE_REVISION_KEY] : []),
      LEGACY_PROJECT_KEY,
      ...pdfKeys,
    ]);
  });
  if (!autosaveStore) {
    observedRevision = null;
    observedManifestHash = null;
  }
}
