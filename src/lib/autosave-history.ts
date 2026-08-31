import { createStore } from "idb-keyval";
import type {
  ClassroomProject,
  LoadedClassroomProject,
  PdfDocumentId,
} from "../types";
import { createLocalId } from "./id";
import { assertProjectFitsContentBudget } from "./project-budget";
import {
  assertLoadedProjectRasterSafety,
  assertSafeProject,
  assertSanitizedProject,
  sanitizeProject,
} from "./safety";
import { sha256Hex } from "./sha256";

const HISTORY_SCHEMA_VERSION = 1 as const;
const HISTORY_INDEX_KEY = "index:v1";
const HISTORY_EPOCH_KEY = "epoch:v1";
const HISTORY_SNAPSHOT_PREFIX = "snapshot:v1:";
const HISTORY_PDF_PREFIX = "pdf:v1:";
const HISTORY_DATABASE_NAME = "patterdraw-autosave-history-v1";
const HISTORY_STORE_NAME = "history";

/** Bounded recovery pool; very large boards should use a downloaded archive. */
export const MAX_AUTOSAVE_HISTORY_BYTES = 160 * 1024 * 1024;
export const MAX_AUTOSAVE_HISTORY_SNAPSHOTS = 6;
export const MAX_AUTOSAVE_HISTORY_SNAPSHOTS_PER_PROJECT = 2;
const HISTORY_METADATA_RESERVE_BYTES = 1024 * 1024;

const historyStore = createStore(
  HISTORY_DATABASE_NAME,
  HISTORY_STORE_NAME,
) as ReturnType<typeof createStore> | undefined;

export interface AutosaveHistoryPdfReference {
  sha256: string;
  byteLength: number;
}

export interface AutosaveHistorySummary {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  snapshotId: string;
  projectId: string;
  title: string;
  capturedAt: string;
  projectUpdatedAt: string;
  manifestSha256: string;
  manifestBytes: number;
  logicalBytes: number;
  pdfReferences: readonly AutosaveHistoryPdfReference[];
}

interface AutosaveHistoryIndex {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  entries: AutosaveHistorySummary[];
}

interface AutosaveHistorySnapshotRecord {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION;
  summary: AutosaveHistorySummary;
  /** Compact UTF-8 JSON keeps the physical storage budget measurable. */
  manifest: Uint8Array;
  pdfRefsByDocumentId: Record<PdfDocumentId, string>;
}

interface PreparedAutosaveHistorySnapshot {
  record: AutosaveHistorySnapshotRecord;
  pdfBytesBySha256: ReadonlyMap<string, Uint8Array>;
}

export interface AutosaveHistoryLimits {
  maxBytes?: number;
  maxSnapshots?: number;
  maxSnapshotsPerProject?: number;
}

export interface SaveAutosaveHistoryOptions extends AutosaveHistoryLimits {
  signal?: AbortSignal;
  now?: () => Date;
}

export interface AutosaveHistoryCommitPlan {
  entries: AutosaveHistorySummary[];
  droppedSnapshotIds: string[];
  orphanedPdfSha256s: string[];
  physicalBytes: number;
  incomingRetained: boolean;
}

export interface SaveAutosaveHistoryResult {
  summary: AutosaveHistorySummary;
  retained: boolean;
  droppedSnapshotIds: readonly string[];
  physicalBytes: number;
}

export interface DeleteAutosaveHistoryResult {
  entries: readonly AutosaveHistorySummary[];
  deletedSnapshotIds: readonly string[];
  orphanedPdfSha256s: readonly string[];
  physicalBytes: number;
}

export interface AutosaveHistoryLoadFailure {
  snapshotId: string;
  message: string;
}

export interface AutosaveHistoryFallbackResult {
  requested: AutosaveHistorySummary;
  summary: AutosaveHistorySummary;
  loaded: LoadedClassroomProject;
  failed: readonly AutosaveHistoryLoadFailure[];
}

export class AutosaveHistoryRecoveryError extends Error {
  readonly failed: readonly AutosaveHistoryLoadFailure[];

  constructor(message: string, failed: readonly AutosaveHistoryLoadFailure[]) {
    super(message);
    this.name = "AutosaveHistoryRecoveryError";
    this.failed = failed;
  }
}

function historyAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The recovery snapshot operation was cancelled.", "AbortError");
  }
  const error = new Error("The recovery snapshot operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfHistoryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : historyAbortError();
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isHistorySummary(value: unknown): value is AutosaveHistorySummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<AutosaveHistorySummary>;
  return summary.schemaVersion === HISTORY_SCHEMA_VERSION
    && typeof summary.snapshotId === "string"
    && /^[a-zA-Z0-9_-]+$/.test(summary.snapshotId)
    && typeof summary.projectId === "string"
    && summary.projectId.length > 0
    && typeof summary.title === "string"
    && isIsoDate(summary.capturedAt)
    && isIsoDate(summary.projectUpdatedAt)
    && isSha256(summary.manifestSha256)
    && Number.isSafeInteger(summary.manifestBytes)
    && (summary.manifestBytes ?? -1) > 0
    && Number.isSafeInteger(summary.logicalBytes)
    && (summary.logicalBytes ?? -1) > 0
    && Array.isArray(summary.pdfReferences)
    && summary.pdfReferences.every((reference) => (
      reference
      && isSha256(reference.sha256)
      && Number.isSafeInteger(reference.byteLength)
      && reference.byteLength > 0
    ));
}

function parseHistoryEpoch(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("The local recovery-history privacy generation is damaged.");
  }
  return value as number;
}

function parseHistoryIndex(value: unknown): AutosaveHistoryIndex {
  if (value === undefined) return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [] };
  if (
    !value
    || typeof value !== "object"
    || (value as Partial<AutosaveHistoryIndex>).schemaVersion !== HISTORY_SCHEMA_VERSION
    || !Array.isArray((value as Partial<AutosaveHistoryIndex>).entries)
    || !(value as AutosaveHistoryIndex).entries.every(isHistorySummary)
  ) {
    throw new Error("The local recovery-history index is damaged. Existing recovery copies were kept.");
  }
  const entries = (value as AutosaveHistoryIndex).entries;
  const snapshotIds = new Set<string>();
  for (const entry of entries) {
    if (snapshotIds.has(entry.snapshotId)) {
      throw new Error("The local recovery-history index contains duplicate snapshots.");
    }
    snapshotIds.add(entry.snapshotId);
  }
  return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [...entries] };
}

function normalizedLimits(limits: AutosaveHistoryLimits = {}): Required<AutosaveHistoryLimits> {
  const normalized = {
    maxBytes: limits.maxBytes ?? MAX_AUTOSAVE_HISTORY_BYTES,
    maxSnapshots: limits.maxSnapshots ?? MAX_AUTOSAVE_HISTORY_SNAPSHOTS,
    maxSnapshotsPerProject: limits.maxSnapshotsPerProject
      ?? MAX_AUTOSAVE_HISTORY_SNAPSHOTS_PER_PROJECT,
  };
  if (
    !Number.isSafeInteger(normalized.maxBytes)
    || normalized.maxBytes <= HISTORY_METADATA_RESERVE_BYTES
    || !Number.isSafeInteger(normalized.maxSnapshots)
    || normalized.maxSnapshots < 1
    || !Number.isSafeInteger(normalized.maxSnapshotsPerProject)
    || normalized.maxSnapshotsPerProject < 1
    || normalized.maxSnapshotsPerProject > normalized.maxSnapshots
  ) {
    throw new Error("The recovery-history limits are invalid.");
  }
  return normalized;
}

function physicalHistoryBytes(entries: readonly AutosaveHistorySummary[]): number {
  let bytes = entries.reduce((total, entry) => total + entry.manifestBytes, 0);
  const pdfLengths = new Map<string, number>();
  for (const entry of entries) {
    for (const reference of entry.pdfReferences) {
      const existing = pdfLengths.get(reference.sha256);
      if (existing !== undefined && existing !== reference.byteLength) {
        throw new Error("Recovery history contains conflicting PDF content metadata.");
      }
      pdfLengths.set(reference.sha256, reference.byteLength);
    }
  }
  for (const byteLength of pdfLengths.values()) bytes += byteLength;
  if (!Number.isSafeInteger(bytes)) throw new Error("Recovery history is too large.");
  return bytes;
}

export function encodeAutosaveHistoryProjectManifest(
  project: ClassroomProject,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(project));
}

/** Pure bounded-pruning planner used by the atomic IndexedDB commit. */
export function planAutosaveHistoryCommit(
  existingEntries: readonly AutosaveHistorySummary[],
  incoming: AutosaveHistorySummary,
  limits: AutosaveHistoryLimits = {},
): AutosaveHistoryCommitPlan {
  if (!isHistorySummary(incoming) || !existingEntries.every(isHistorySummary)) {
    throw new Error("Recovery history metadata is invalid.");
  }
  const normalized = normalizedLimits(limits);
  if (incoming.logicalBytes > normalized.maxBytes - HISTORY_METADATA_RESERVE_BYTES) {
    throw new Error("This project is too large to retain as a local recovery copy.");
  }

  const previousPdfReferences = new Set(
    existingEntries.flatMap((entry) => entry.pdfReferences.map((reference) => reference.sha256)),
  );
  const droppedSnapshotIds: string[] = [];
  const entries = [incoming, ...existingEntries.filter((entry) => {
    const keep = entry.snapshotId !== incoming.snapshotId;
    if (!keep) droppedSnapshotIds.push(entry.snapshotId);
    return keep;
  })].sort(compareHistoryRecency);

  const dropAt = (index: number) => {
    const [dropped] = entries.splice(index, 1);
    if (dropped) droppedSnapshotIds.push(dropped.snapshotId);
  };
  const projectCounts = new Map<string, number>();
  for (let index = 0; index < entries.length;) {
    const candidate = entries[index];
    const retainedForProject = projectCounts.get(candidate.projectId) ?? 0;
    if (retainedForProject >= normalized.maxSnapshotsPerProject) {
      dropAt(index);
      continue;
    }
    projectCounts.set(candidate.projectId, retainedForProject + 1);
    index += 1;
  }
  while (entries.length > normalized.maxSnapshots) dropAt(entries.length - 1);
  while (
    entries.length > 1
    && physicalHistoryBytes(entries) > normalized.maxBytes - HISTORY_METADATA_RESERVE_BYTES
  ) {
    dropAt(entries.length - 1);
  }
  const physicalBytes = physicalHistoryBytes(entries);
  if (physicalBytes > normalized.maxBytes - HISTORY_METADATA_RESERVE_BYTES) {
    throw new Error("This project is too large to retain as a local recovery copy.");
  }
  const retainedPdfReferences = new Set(
    entries.flatMap((entry) => entry.pdfReferences.map((reference) => reference.sha256)),
  );
  const orphanedPdfSha256s = [...previousPdfReferences]
    .filter((sha256) => !retainedPdfReferences.has(sha256));

  return {
    entries,
    droppedSnapshotIds: [...new Set(droppedSnapshotIds)],
    orphanedPdfSha256s,
    physicalBytes,
    incomingRetained: entries.some((entry) => entry.snapshotId === incoming.snapshotId),
  };
}

function compareHistoryRecency(
  left: AutosaveHistorySummary,
  right: AutosaveHistorySummary,
): number {
  const timeDifference = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  if (timeDifference !== 0) return timeDifference;
  return right.snapshotId.localeCompare(left.snapshotId);
}

async function prepareAutosaveHistorySnapshot(
  ownedLoaded: LoadedClassroomProject,
  options: SaveAutosaveHistoryOptions,
): Promise<PreparedAutosaveHistorySnapshot> {
  throwIfHistoryAborted(options.signal);
  // Capture invocation time before hashing/raster preflight. Large projects
  // may finish after a later small snapshot; commit order must not redefine
  // which classroom state is newest.
  const capturedAt = (options.now?.() ?? new Date()).toISOString();
  if (!isIsoDate(capturedAt)) throw new Error("The recovery snapshot time is invalid.");
  const safeProject = sanitizeProject(ownedLoaded.project);
  assertSanitizedProject(safeProject);
  const pdfBytesBySha256 = new Map<string, Uint8Array>();
  const verifiedPdfBytes: Record<PdfDocumentId, Uint8Array> = {};
  const pdfRefsByDocumentId: Record<PdfDocumentId, string> = {};
  const pdfReferencesBySha256 = new Map<string, AutosaveHistoryPdfReference>();
  const verifiedDocuments = await Promise.all(
    Object.entries(safeProject.pdfDocuments).map(async ([documentId, source]) => {
      throwIfHistoryAborted(options.signal);
      const bytes = ownedLoaded.pdfBytes[documentId];
      if (!bytes || bytes.byteLength !== source.byteLength) {
        throw new Error(`PDF data does not match project metadata for ${source.name}.`);
      }
      // saveAutosaveHistorySnapshot synchronously owns every source view before
      // its first await. Reuse that private copy here: slicing it again would
      // transiently add another full source-PDF allocation during preflight.
      const protectedBytes = bytes;
      const sha256 = await sha256Hex(protectedBytes);
      throwIfHistoryAborted(options.signal);
      if (source.sha256 && source.sha256 !== sha256) {
        throw new Error(`PDF data does not match project content identity for ${source.name}.`);
      }
      const existingReference = pdfReferencesBySha256.get(sha256);
      if (existingReference && existingReference.byteLength !== protectedBytes.byteLength) {
        throw new Error("PDF content identity has conflicting byte lengths.");
      }
      pdfBytesBySha256.set(sha256, protectedBytes);
      verifiedPdfBytes[documentId] = protectedBytes;
      pdfRefsByDocumentId[documentId] = sha256;
      pdfReferencesBySha256.set(sha256, { sha256, byteLength: protectedBytes.byteLength });
      return [documentId, { ...source, sha256 }] as const;
    }),
  );
  const project: ClassroomProject = {
    ...safeProject,
    pdfDocuments: Object.fromEntries(verifiedDocuments),
  };
  assertSanitizedProject(project);
  const size = assertProjectFitsContentBudget(project, verifiedPdfBytes);
  await assertLoadedProjectRasterSafety(
    { project, pdfBytes: verifiedPdfBytes },
    { signal: options.signal },
  );
  throwIfHistoryAborted(options.signal);
  const manifest = encodeAutosaveHistoryProjectManifest(project);
  const manifestSha256 = await sha256Hex(manifest);
  throwIfHistoryAborted(options.signal);
  const summary: AutosaveHistorySummary = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    snapshotId: createLocalId(),
    projectId: project.id,
    title: project.title,
    capturedAt,
    projectUpdatedAt: project.updatedAt,
    manifestSha256,
    manifestBytes: manifest.byteLength,
    logicalBytes: size.totalBytes,
    pdfReferences: [...pdfReferencesBySha256.values()]
      .sort((left, right) => left.sha256.localeCompare(right.sha256)),
  };
  return {
    record: {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      summary,
      manifest,
      pdfRefsByDocumentId,
    },
    pdfBytesBySha256,
  };
}

function snapshotKey(snapshotId: string): string {
  return `${HISTORY_SNAPSHOT_PREFIX}${snapshotId}`;
}

function pdfKey(sha256: string): string {
  return `${HISTORY_PDF_PREFIX}${sha256}`;
}

function commitPreparedSnapshotTransaction(
  store: IDBObjectStore,
  prepared: PreparedAutosaveHistorySnapshot,
  limits: AutosaveHistoryLimits,
  expectedEpoch: number,
  signal?: AbortSignal,
): Promise<SaveAutosaveHistoryResult> {
  return new Promise((resolve, reject) => {
    const transaction = store.transaction;
    try {
      // Cancellation may land after the caller's final preflight but before
      // idb-keyval invokes this transaction callback.
      throwIfHistoryAborted(signal);
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction may not be active */ }
      reject(error);
      return;
    }
    let result: SaveAutosaveHistoryResult | undefined;
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already be committed; its terminal event wins.
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transaction.oncomplete = () => {
      if (settled || !result) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    transaction.onerror = () => finishReject(transaction.error ?? new Error("Recovery history could not be saved."));
    transaction.onabort = () => finishReject(
      signal?.aborted
        ? (signal.reason instanceof Error ? signal.reason : historyAbortError())
        : transaction.error ?? new Error("Recovery history could not be saved."),
    );
    const epochRequest = store.get(HISTORY_EPOCH_KEY);
    epochRequest.onerror = () => {
      try { transaction.abort(); } catch { /* transaction already failed */ }
    };
    epochRequest.onsuccess = () => {
      try {
        throwIfHistoryAborted(signal);
        if (parseHistoryEpoch(epochRequest.result) !== expectedEpoch) {
          throw new Error(
            "Recovery history was cleared while this copy was being prepared. The board remains open.",
          );
        }
        const indexRequest = store.get(HISTORY_INDEX_KEY);
        indexRequest.onerror = () => {
          try { transaction.abort(); } catch { /* transaction already failed */ }
        };
        indexRequest.onsuccess = () => {
          try {
            throwIfHistoryAborted(signal);
            const current = parseHistoryIndex(indexRequest.result);
            const plan = planAutosaveHistoryCommit(
              current.entries,
              prepared.record.summary,
              limits,
            );
            if (plan.incomingRetained) {
              store.put(prepared.record, snapshotKey(prepared.record.summary.snapshotId));
              for (const [sha256, bytes] of prepared.pdfBytesBySha256) {
                store.put(bytes, pdfKey(sha256));
              }
            }
            store.put({
              schemaVersion: HISTORY_SCHEMA_VERSION,
              entries: plan.entries,
            } satisfies AutosaveHistoryIndex, HISTORY_INDEX_KEY);
            store.put(expectedEpoch, HISTORY_EPOCH_KEY);
            for (const snapshotId of plan.droppedSnapshotIds) {
              if (snapshotId !== prepared.record.summary.snapshotId) {
                store.delete(snapshotKey(snapshotId));
              }
            }
            for (const sha256 of plan.orphanedPdfSha256s) store.delete(pdfKey(sha256));
            result = {
              summary: prepared.record.summary,
              retained: plan.incomingRetained,
              droppedSnapshotIds: plan.droppedSnapshotIds,
              physicalBytes: plan.physicalBytes,
            };
          } catch (error) {
            try { transaction.abort(); } catch { /* transaction already failed */ }
            finishReject(error);
          }
        };
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction already failed */ }
        finishReject(error);
      }
    };
  });
}

/**
 * Retain a validated recovery copy before replacing the active project. The
 * manifest, referenced PDF bytes, bounded index, and pruning deletes commit in
 * one IndexedDB transaction. This is intentionally not called by ordinary
 * autosave; UI should invoke it only after the teacher confirms project open.
 */
export async function saveAutosaveHistorySnapshot(
  loaded: LoadedClassroomProject,
  options: SaveAutosaveHistoryOptions = {},
): Promise<SaveAutosaveHistoryResult> {
  normalizedLimits(options);
  throwIfHistoryAborted(options.signal);
  // Own the exact invocation state before the first await. Reading the shared
  // clear-generation is asynchronous, and callers keep mutating the live
  // project and PDF views while that IndexedDB read is pending.
  const invocationTime = options.now?.() ?? new Date();
  const protectedLoaded: LoadedClassroomProject = {
    project: sanitizeProject(loaded.project),
    pdfBytes: Object.fromEntries(
      Object.entries(loaded.pdfBytes).map(([documentId, bytes]) => [documentId, bytes.slice()]),
    ),
  };
  if (!historyStore) throw new Error("Local recovery history is unavailable in this browser.");
  const expectedEpoch = parseHistoryEpoch(await historyStore(
    "readonly",
    (store) => new Promise<unknown>((resolve, reject) => {
      const request = store.get(HISTORY_EPOCH_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
  ));
  throwIfHistoryAborted(options.signal);
  const prepared = await prepareAutosaveHistorySnapshot(protectedLoaded, {
    ...options,
    now: () => invocationTime,
  });
  throwIfHistoryAborted(options.signal);
  return historyStore(
    "readwrite",
    (store) => commitPreparedSnapshotTransaction(
      store,
      prepared,
      options,
      expectedEpoch,
      options.signal,
    ),
  );
}

export async function listAutosaveHistorySnapshots(): Promise<readonly AutosaveHistorySummary[]> {
  if (!historyStore) return [];
  const index = await historyStore("readonly", (store) => new Promise<unknown>((resolve, reject) => {
    const request = store.get(HISTORY_INDEX_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
  return Object.freeze(parseHistoryIndex(index).entries.map((entry) => Object.freeze({ ...entry })));
}

function deleteSnapshotsTransaction(
  store: IDBObjectStore,
  snapshotIds: readonly string[],
  signal?: AbortSignal,
): Promise<DeleteAutosaveHistoryResult> {
  return new Promise((resolve, reject) => {
    const transaction = store.transaction;
    try {
      throwIfHistoryAborted(signal);
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction may not be active */ }
      reject(error);
      return;
    }
    let result: DeleteAutosaveHistoryResult | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      try { transaction.abort(); } catch { /* terminal event wins */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transaction.onerror = () => fail(transaction.error ?? new Error("Recovery history could not be changed."));
    transaction.onabort = () => fail(
      signal?.aborted
        ? (signal.reason instanceof Error ? signal.reason : historyAbortError())
        : transaction.error ?? new Error("Recovery history could not be changed."),
    );
    transaction.oncomplete = () => {
      if (settled || !result) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const indexRequest = store.get(HISTORY_INDEX_KEY);
    indexRequest.onerror = () => {
      try { transaction.abort(); } catch { /* transaction already failed */ }
    };
    indexRequest.onsuccess = () => {
      try {
        throwIfHistoryAborted(signal);
        const current = parseHistoryIndex(indexRequest.result);
        const requested = new Set(snapshotIds);
        const listed = new Set(current.entries.map((entry) => entry.snapshotId));
        for (const snapshotId of requested) {
          if (!listed.has(snapshotId)) {
            throw new Error("A selected recovery copy is no longer available.");
          }
        }

        const deletedEntries = current.entries.filter((entry) => requested.has(entry.snapshotId));
        const entries = current.entries.filter((entry) => !requested.has(entry.snapshotId));
        const retainedPdfSha256s = new Set(
          entries.flatMap((entry) => entry.pdfReferences.map((reference) => reference.sha256)),
        );
        const orphanedPdfSha256s = [...new Set(
          deletedEntries.flatMap((entry) => entry.pdfReferences.map((reference) => reference.sha256)),
        )].filter((sha256) => !retainedPdfSha256s.has(sha256));

        store.put({
          schemaVersion: HISTORY_SCHEMA_VERSION,
          entries,
        } satisfies AutosaveHistoryIndex, HISTORY_INDEX_KEY);
        for (const snapshotId of requested) store.delete(snapshotKey(snapshotId));
        for (const sha256 of orphanedPdfSha256s) store.delete(pdfKey(sha256));
        result = {
          entries,
          deletedSnapshotIds: [...requested],
          orphanedPdfSha256s,
          physicalBytes: physicalHistoryBytes(entries),
        };
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction already failed */ }
        fail(error);
      }
    };
  });
}

/**
 * Explicitly delete selected local-only recovery copies and any PDF blobs that
 * no remaining copy references. Index changes and all pruning share one
 * IndexedDB transaction so a quota/browser failure cannot strand a partial
 * history. Callers must obtain the teacher's explicit confirmation first.
 */
export async function deleteAutosaveHistorySnapshots(
  snapshotIds: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<DeleteAutosaveHistoryResult> {
  const uniqueSnapshotIds = [...new Set(snapshotIds)];
  if (
    uniqueSnapshotIds.length === 0
    || uniqueSnapshotIds.some((snapshotId) => !/^[a-zA-Z0-9_-]+$/.test(snapshotId))
  ) {
    throw new Error("Choose at least one valid recovery copy to delete.");
  }
  throwIfHistoryAborted(options.signal);
  if (!historyStore) throw new Error("Local recovery history is unavailable in this browser.");
  return historyStore(
    "readwrite",
    (store) => deleteSnapshotsTransaction(store, uniqueSnapshotIds, options.signal),
  );
}

function clearHistoryTransaction(
  store: IDBObjectStore,
  signal?: AbortSignal,
): Promise<DeleteAutosaveHistoryResult> {
  return new Promise((resolve, reject) => {
    const transaction = store.transaction;
    try {
      throwIfHistoryAborted(signal);
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction may not be active */ }
      reject(error);
      return;
    }
    let result: DeleteAutosaveHistoryResult | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      try { transaction.abort(); } catch { /* terminal event wins */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transaction.onerror = () => fail(transaction.error ?? new Error("Recovery history could not be cleared."));
    transaction.onabort = () => fail(
      signal?.aborted
        ? (signal.reason instanceof Error ? signal.reason : historyAbortError())
        : transaction.error ?? new Error("Recovery history could not be cleared."),
    );
    transaction.oncomplete = () => {
      if (settled || !result) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const epochRequest = store.get(HISTORY_EPOCH_KEY);
    epochRequest.onerror = () => {
      try { transaction.abort(); } catch { /* transaction already failed */ }
    };
    epochRequest.onsuccess = () => {
      try {
        throwIfHistoryAborted(signal);
        let currentEpoch = 0;
        try { currentEpoch = parseHistoryEpoch(epochRequest.result); } catch { /* clear repairs it */ }
        const nextEpoch = currentEpoch === Number.MAX_SAFE_INTEGER ? 0 : currentEpoch + 1;
        const indexRequest = store.get(HISTORY_INDEX_KEY);
        indexRequest.onerror = () => {
          try { transaction.abort(); } catch { /* transaction already failed */ }
        };
        indexRequest.onsuccess = () => {
          try {
            throwIfHistoryAborted(signal);
            let entries: AutosaveHistorySummary[] = [];
            try { entries = parseHistoryIndex(indexRequest.result).entries; } catch { /* clear repairs it */ }
            const orphanedPdfSha256s = [...new Set(
              entries.flatMap((entry) => entry.pdfReferences.map((reference) => reference.sha256)),
            )];
            store.clear();
            store.put({
              schemaVersion: HISTORY_SCHEMA_VERSION,
              entries: [],
            } satisfies AutosaveHistoryIndex, HISTORY_INDEX_KEY);
            store.put(nextEpoch, HISTORY_EPOCH_KEY);
            result = {
              entries: [],
              deletedSnapshotIds: entries.map((entry) => entry.snapshotId),
              orphanedPdfSha256s,
              physicalBytes: 0,
            };
          } catch (error) {
            try { transaction.abort(); } catch { /* transaction already failed */ }
            fail(error);
          }
        };
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction already failed */ }
        fail(error);
      }
    };
  });
}

/**
 * Delete every key in the dedicated local recovery store after explicit UI
 * consent. This repairs a damaged index, removes unindexed remnants, and
 * advances a privacy generation so a snapshot prepared before clear-all
 * cannot commit afterwards from this or another tab.
 */
export async function clearAutosaveHistorySnapshots(
  options: { signal?: AbortSignal } = {},
): Promise<DeleteAutosaveHistoryResult> {
  throwIfHistoryAborted(options.signal);
  if (!historyStore) throw new Error("Local recovery history is unavailable in this browser.");
  return historyStore(
    "readwrite",
    (store) => clearHistoryTransaction(store, options.signal),
  );
}

function readSnapshotTransaction(
  store: IDBObjectStore,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<{ record: AutosaveHistorySnapshotRecord; pdfBytes: Record<string, Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const transaction = store.transaction;
    let settled = false;
    let record: AutosaveHistorySnapshotRecord | undefined;
    let listedSummary: AutosaveHistorySummary | undefined;
    const pdfBytes: Record<string, Uint8Array> = {};
    let pendingPdfs = 0;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      try { transaction.abort(); } catch { /* terminal event wins */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transaction.onerror = () => fail(transaction.error ?? new Error("Recovery history could not be read."));
    transaction.onabort = () => fail(
      signal?.aborted
        ? (signal.reason instanceof Error ? signal.reason : historyAbortError())
        : transaction.error ?? new Error("Recovery history could not be read."),
    );
    transaction.oncomplete = () => {
      if (settled) return;
      if (!record || !listedSummary || pendingPdfs !== 0) {
        fail(new Error("The selected recovery copy is incomplete."));
        return;
      }
      if (JSON.stringify(record.summary) !== JSON.stringify(listedSummary)) {
        fail(new Error("The selected recovery copy does not match its history index."));
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ record, pdfBytes });
    };
    const indexRequest = store.get(HISTORY_INDEX_KEY);
    indexRequest.onerror = () => fail(indexRequest.error ?? new Error("Recovery history could not be read."));
    indexRequest.onsuccess = () => {
      try {
        listedSummary = parseHistoryIndex(indexRequest.result).entries
          .find((entry) => entry.snapshotId === snapshotId);
        if (!listedSummary) throw new Error("The selected recovery copy is not listed in history.");
      } catch (error) {
        fail(error);
      }
    };
    const request = store.get(snapshotKey(snapshotId));
    request.onerror = () => fail(request.error ?? new Error("Recovery history could not be read."));
    request.onsuccess = () => {
      try {
        throwIfHistoryAborted(signal);
        const candidate = request.result as Partial<AutosaveHistorySnapshotRecord> | undefined;
        const rawManifest = (candidate as { manifest?: unknown } | undefined)?.manifest;
        const manifest = rawManifest instanceof Uint8Array
          ? rawManifest
          : rawManifest instanceof ArrayBuffer
            ? new Uint8Array(rawManifest)
            : ArrayBuffer.isView(rawManifest)
              ? new Uint8Array(
                rawManifest.buffer,
                rawManifest.byteOffset,
                rawManifest.byteLength,
              )
              : undefined;
        if (
          !candidate
          || candidate.schemaVersion !== HISTORY_SCHEMA_VERSION
          || !isHistorySummary(candidate.summary)
          || candidate.summary.snapshotId !== snapshotId
          || !manifest
          || typeof candidate.pdfRefsByDocumentId !== "object"
          || candidate.pdfRefsByDocumentId === null
        ) {
          throw new Error("The selected recovery copy is damaged.");
        }
        record = {
          ...(candidate as AutosaveHistorySnapshotRecord),
          manifest,
        };
        const uniqueHashes = [...new Set(Object.values(record.pdfRefsByDocumentId))];
        pendingPdfs = uniqueHashes.length;
        for (const sha256 of uniqueHashes) {
          if (!isSha256(sha256)) throw new Error("The selected recovery copy has invalid PDF metadata.");
          const pdfRequest = store.get(pdfKey(sha256));
          pdfRequest.onerror = () => fail(pdfRequest.error ?? new Error("Recovery PDF data could not be read."));
          pdfRequest.onsuccess = () => {
            const value = pdfRequest.result;
            const bytes = value instanceof Uint8Array
              ? value
              : value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : ArrayBuffer.isView(value)
                  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                  : undefined;
            if (!bytes) {
              fail(new Error("The selected recovery copy is missing PDF data."));
              return;
            }
            pdfBytes[sha256] = bytes;
            pendingPdfs -= 1;
          };
        }
      } catch (error) {
        fail(error);
      }
    };
  });
}

/** Load and revalidate a recovery snapshot before it can replace live state. */
export async function loadAutosaveHistorySnapshot(
  snapshotId: string,
  options: { signal?: AbortSignal } = {},
): Promise<LoadedClassroomProject> {
  if (!/^[a-zA-Z0-9_-]+$/.test(snapshotId)) {
    throw new Error("The recovery snapshot identity is invalid.");
  }
  throwIfHistoryAborted(options.signal);
  if (!historyStore) throw new Error("Local recovery history is unavailable in this browser.");
  const { record, pdfBytes: pdfBytesBySha } = await historyStore(
    "readonly",
    (store) => readSnapshotTransaction(store, snapshotId, options.signal),
  );
  throwIfHistoryAborted(options.signal);
  if (record.manifest.byteLength !== record.summary.manifestBytes) {
    throw new Error("The selected recovery copy has an inconsistent manifest size.");
  }
  const manifestSha256 = await sha256Hex(record.manifest);
  if (manifestSha256 !== record.summary.manifestSha256) {
    throw new Error("The selected recovery copy failed its manifest integrity check.");
  }
  let project: ClassroomProject;
  try {
    project = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(record.manifest),
    ) as ClassroomProject;
  } catch {
    throw new Error("The selected recovery copy has an unreadable project manifest.");
  }
  assertSafeProject(project);
  assertSanitizedProject(project);
  if (
    record.summary.projectId !== project.id
    || record.summary.title !== project.title
    || record.summary.projectUpdatedAt !== project.updatedAt
  ) {
    throw new Error("The selected recovery copy has inconsistent project metadata.");
  }
  const documentIds = Object.keys(project.pdfDocuments).sort();
  const referencedDocumentIds = Object.keys(record.pdfRefsByDocumentId).sort();
  if (JSON.stringify(documentIds) !== JSON.stringify(referencedDocumentIds)) {
    throw new Error("The selected recovery copy has inconsistent PDF references.");
  }
  const pdfBytes: Record<PdfDocumentId, Uint8Array> = {};
  for (const [documentId, source] of Object.entries(project.pdfDocuments)) {
    const sha256 = record.pdfRefsByDocumentId[documentId];
    const bytes = pdfBytesBySha[sha256];
    if (!isSha256(sha256) || !bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`The recovery copy is missing PDF data for ${source.name}.`);
    }
    if (await sha256Hex(bytes) !== sha256 || (source.sha256 && source.sha256 !== sha256)) {
      throw new Error(`The recovery PDF data failed its integrity check for ${source.name}.`);
    }
    pdfBytes[documentId] = bytes;
  }
  const expectedPdfReferences = new Map<string, number>();
  for (const source of Object.values(project.pdfDocuments)) {
    if (!source.sha256) throw new Error("The selected recovery copy is missing a PDF content identity.");
    expectedPdfReferences.set(source.sha256, source.byteLength);
  }
  const actualPdfReferences = [...record.summary.pdfReferences]
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  const normalizedExpectedPdfReferences = [...expectedPdfReferences]
    .map(([sha256, byteLength]) => ({ sha256, byteLength }))
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  if (JSON.stringify(actualPdfReferences) !== JSON.stringify(normalizedExpectedPdfReferences)) {
    throw new Error("The selected recovery copy has inconsistent PDF content metadata.");
  }
  const loaded = { project, pdfBytes };
  const size = assertProjectFitsContentBudget(project, pdfBytes);
  if (size.totalBytes !== record.summary.logicalBytes) {
    throw new Error("The selected recovery copy has an inconsistent content size.");
  }
  await assertLoadedProjectRasterSafety(loaded, { signal: options.signal });
  throwIfHistoryAborted(options.signal);
  return loaded;
}

/**
 * Load the requested copy, falling back only to older snapshots of the same
 * project. Damaged records remain indexed until the teacher explicitly
 * deletes them; callers can show `failed` entries in the history manager.
 */
export async function loadAutosaveHistorySnapshotWithFallback(
  snapshotId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AutosaveHistoryFallbackResult> {
  const entries = [...await listAutosaveHistorySnapshots()].sort(compareHistoryRecency);
  const requested = entries.find((entry) => entry.snapshotId === snapshotId);
  if (!requested) throw new Error("The selected recovery copy is not listed in history.");
  const projectEntries = entries.filter((entry) => entry.projectId === requested.projectId);
  const requestedIndex = projectEntries.findIndex((entry) => entry.snapshotId === snapshotId);
  const failed: AutosaveHistoryLoadFailure[] = [];

  for (const summary of projectEntries.slice(requestedIndex)) {
    throwIfHistoryAborted(options.signal);
    try {
      const loaded = await loadAutosaveHistorySnapshot(summary.snapshotId, options);
      return { requested, summary, loaded, failed };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      failed.push({
        snapshotId: summary.snapshotId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new AutosaveHistoryRecoveryError(
    failed.length > 1
      ? "The selected recovery copy and its older copies are damaged or incomplete."
      : "The selected recovery copy is damaged or incomplete, and no older copy is available.",
    failed,
  );
}

export function latestAutosaveHistoryForProject(
  entries: readonly AutosaveHistorySummary[],
  projectId: string,
): AutosaveHistorySummary | null {
  return entries
    .filter((entry) => entry.projectId === projectId)
    .sort(compareHistoryRecency)[0] ?? null;
}
