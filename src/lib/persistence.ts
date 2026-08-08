import { createStore, delMany, get, keys, setMany } from "idb-keyval";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import {
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
const MUTATION_LOCK = "patterdraw:autosave:mutation:v1";
const AUTOSAVE_LOAD_RETRY_LIMIT = 2;
const autosaveStore = createStore("keyval-store", "keyval");
let mutationQueue: Promise<void> = Promise.resolve();

type MutationOperation = (hasCrossContextLock: boolean) => Promise<void>;
interface SaveAutosaveOptions {
  prepared?: boolean;
  /**
   * Rewrite every referenced PDF blob as part of this save. Recovery and
   * project-replacement saves use this to repair a blob whose manifest still
   * happens to carry the same byte length and hash.
   */
  replacePdfBlobs?: boolean;
}

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
): [string, ClassroomProject | Uint8Array][] {
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
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = store.transaction;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    let storedProject: ClassroomProject | undefined;
    let storedKeys: IDBValidKey[] = [];
    let projectReady = false;
    let keysReady = false;
    let writesQueued = false;

    const abort = (error: unknown) => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of the request.
      }
      reject(error);
    };
    const queueWrites = () => {
      if (!projectReady || !keysReady || writesQueued) return;
      writesQueued = true;
      try {
        for (const [key, value] of getAutosaveWriteEntries(
          verifiedProject,
          pdfBytes,
          storedProject,
          storedKeys,
          replacePdfBlobs,
        )) {
          store.put(value, key);
        }
        for (const key of getStaleAutosaveKeys(storedKeys, referencedPdfKeys)) {
          store.delete(key);
        }
      } catch (error) {
        abort(error);
      }
    };

    try {
      // Read and conditionally write inside the same readwrite transaction.
      // IndexedDB serializes that transaction across tabs even when the Web
      // Locks API is unavailable, so unchanged large PDF blobs stay untouched
      // without reopening the manifest/blob race this fallback prevents.
      const projectRequest = store.get(PROJECT_KEY);
      const keyRequest = store.getAllKeys();
      projectRequest.onsuccess = () => {
        storedProject = projectRequest.result as ClassroomProject | undefined;
        projectReady = true;
        queueWrites();
      };
      projectRequest.onerror = () => abort(projectRequest.error);
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

export function commitAutosaveMigrationTransaction(
  store: IDBObjectStore,
  expectedProject: ClassroomProject,
  fromLegacyKey: boolean,
  verifiedProject: ClassroomProject,
  pdfEntries: readonly (readonly [PdfDocumentId, Uint8Array])[],
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const transaction = store.transaction;
    let migrated = false;
    let decisionMade = false;
    let currentReady = false;
    let legacyReady = !fromLegacyKey;
    let storedCurrent: ClassroomProject | undefined;
    let storedLegacy: ClassroomProject | undefined;

    transaction.oncomplete = () => resolve(migrated);
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
    const queueMigration = () => {
      if (!currentReady || !legacyReady || decisionMade) return;
      decisionMade = true;
      const sourceStillCurrent = fromLegacyKey
        ? !storedCurrent && autosaveManifestsMatch(expectedProject, storedLegacy)
        : autosaveManifestsMatch(expectedProject, storedCurrent);
      if (!sourceStillCurrent) return;

      try {
        store.put(verifiedProject, PROJECT_KEY);
        for (const [id, bytes] of pdfEntries) {
          store.put(bytes, `${PDF_KEY_PREFIX}${id}`);
        }
        if (fromLegacyKey) {
          store.delete(LEGACY_PROJECT_KEY);
          for (const [id] of pdfEntries) {
            store.delete(`${LEGACY_PDF_KEY_PREFIX}${id}`);
          }
        }
        migrated = true;
      } catch (error) {
        abort(error);
      }
    };

    try {
      // The comparison and conditional writes share one readwrite transaction.
      // IndexedDB therefore serializes them with saves from every other tab,
      // even in browsers that do not implement the Web Locks API.
      const currentRequest = store.get(PROJECT_KEY);
      currentRequest.onsuccess = () => {
        storedCurrent = currentRequest.result as ClassroomProject | undefined;
        currentReady = true;
        queueMigration();
      };
      currentRequest.onerror = () => abort(currentRequest.error);

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

export function validateAutosaveSnapshotTransaction(
  store: IDBObjectStore,
  expectedProject: ClassroomProject,
  fromLegacyKey: boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const transaction = store.transaction;
    let matches = false;
    let decisionMade = false;
    let currentReady = false;
    let legacyReady = !fromLegacyKey;
    let storedCurrent: ClassroomProject | undefined;
    let storedLegacy: ClassroomProject | undefined;

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
      if (!currentReady || !legacyReady || decisionMade) return;
      decisionMade = true;
      matches = fromLegacyKey
        ? !storedCurrent && autosaveManifestsMatch(expectedProject, storedLegacy)
        : autosaveManifestsMatch(expectedProject, storedCurrent);
    };

    try {
      // A readwrite transaction acts as the same cross-tab serialization
      // point as save/migration transactions in browsers without Web Locks.
      // No data is written; it only proves that the manifest whose PDF bytes
      // were verified is still the current one before loadAutosave returns it.
      const currentRequest = store.get(PROJECT_KEY);
      currentRequest.onsuccess = () => {
        storedCurrent = currentRequest.result as ClassroomProject | undefined;
        currentReady = true;
        decide();
      };
      currentRequest.onerror = () => abort(currentRequest.error);

      if (fromLegacyKey) {
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
                || key === LEGACY_PROJECT_KEY
                || key.startsWith(PDF_KEY_PREFIX)
                || key.startsWith(LEGACY_PDF_KEY_PREFIX)
              )
            ) store.delete(key);
          }
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
): Promise<boolean> {
  // Unit environments can replace createStore with an unavailable test
  // double. Production browsers always take the transaction branch below.
  if (!autosaveStore) {
    await setMany([
      [PROJECT_KEY, verifiedProject],
      ...pdfEntries.map(
        ([id, bytes]): [string, Uint8Array] => [`${PDF_KEY_PREFIX}${id}`, bytes],
      ),
    ]);
    if (fromLegacyKey) {
      await delMany([
        LEGACY_PROJECT_KEY,
        ...pdfEntries.map(([id]) => `${LEGACY_PDF_KEY_PREFIX}${id}`),
      ]);
    }
    return true;
  }
  return autosaveStore(
    "readwrite",
    (store) => commitAutosaveMigrationTransaction(
      store,
      expectedProject,
      fromLegacyKey,
      verifiedProject,
      pdfEntries,
    ),
  );
}

async function validateAutosaveWithoutCrossContextLock(
  expectedProject: ClassroomProject,
  fromLegacyKey: boolean,
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
    ),
  );
}

async function setManyAndDeleteStaleAtomically(
  verifiedProject: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  referencedPdfKeys: ReadonlySet<string>,
  replacePdfBlobs = false,
): Promise<void> {
  // Unit environments can replace createStore with an unavailable test
  // double. Production browsers always use this single readwrite transaction,
  // whose object-store serialization is the no-Web-Locks cross-tab mutex.
  if (!autosaveStore) {
    await setMany(getAutosaveWriteEntries(
      verifiedProject,
      pdfBytes,
      undefined,
      [],
      replacePdfBlobs,
    ));
    return;
  }
  await autosaveStore(
    "readwrite",
    (store) => commitAutosaveTransaction(
      store,
      verifiedProject,
      pdfBytes,
      referencedPdfKeys,
      replacePdfBlobs,
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
): Promise<ProjectContentSize> {
  const safe = options.prepared ? project : sanitizeProject(project);
  assertSanitizedProject(safe);
  const documentVerifications = Object.entries(safe.pdfDocuments).map(([id, source]) => {
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
        if (source.sha256 && source.sha256 !== sha256) {
          throw new Error(`PDF data does not match project metadata for ${source.name}.`);
        }
        return [id, { ...source, sha256 }] as const;
      });
    });
  const requiresAsyncVerification = documentVerifications.some(
    (entry) => entry instanceof Promise,
  );
  const verifiedDocuments = requiresAsyncVerification
    ? await Promise.all(documentVerifications)
    : documentVerifications as Array<readonly [
      string,
      ClassroomProject["pdfDocuments"][string],
    ]>;
  const verifiedProject: ClassroomProject = {
    ...safe,
    pdfDocuments: Object.fromEntries(verifiedDocuments),
  };
  const contentSize = assertProjectFitsContentBudget(verifiedProject, pdfBytes);

  await enqueueMutation(async (hasCrossContextLock) => {
    const referencedKeys = new Set(
      Object.keys(verifiedProject.pdfDocuments).map((id) => `${PDF_KEY_PREFIX}${id}`),
    );
    if (!hasCrossContextLock) {
      await setManyAndDeleteStaleAtomically(
        verifiedProject,
        pdfBytes,
        referencedKeys,
        options.replacePdfBlobs,
      );
      return;
    }

    const [storedProject, existingKeys] = await Promise.all([
      get<ClassroomProject>(PROJECT_KEY),
      keys(),
    ]);
    await setMany(getAutosaveWriteEntries(
      verifiedProject,
      pdfBytes,
      storedProject,
      existingKeys,
      options.replacePdfBlobs,
    ));

    const staleKeys = getStaleAutosaveKeys(existingKeys, referencedKeys);
    if (staleKeys.length) {
      try {
        await delMany(staleKeys);
      } catch {
        // The manifest and every referenced PDF were committed atomically.
        // Orphan cleanup is optional and can be retried by the next save.
      }
    }
  });
  return contentSize;
}

async function loadAutosaveAttempt(
  remainingRetries: number,
): Promise<LoadedClassroomProject | null> {
  return withCrossContextLock(async (hasCrossContextLock) => {
    const currentProject = await get<ClassroomProject>(PROJECT_KEY);
    const project = currentProject || await get<ClassroomProject>(LEGACY_PROJECT_KEY);
    if (!project) return null;
    assertSafeProject(project);
    const safeProject = sanitizeProject(project);
    const pdfKeyPrefix = currentProject ? PDF_KEY_PREFIX : LEGACY_PDF_KEY_PREFIX;

    const loadedPdfEntries = await Promise.all(
      Object.entries(safeProject.pdfDocuments).map(async ([id, source]) => {
        const bytes = await get<Uint8Array>(`${pdfKeyPrefix}${id}`);
        if (!bytes) {
          throw new Error(`Autosave is missing PDF data for ${id}.`);
        }
        if (bytes.byteLength !== source.byteLength) {
          throw new Error(`Autosave PDF data does not match project metadata for ${source.name}.`);
        }
        const sha256 = await sha256Hex(bytes);
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

    const needsMigration = !currentProject
      || Object.values(project.scenes).some((scene) => (
        isPersistedWrapperTool(scene.appState?.activeTool)
      ))
      || safeProject.title !== project.title
      || safeProject.titleMode !== project.titleMode
      || Object.values(safeProject.pdfDocuments).some((source) => !source.sha256);
    let snapshotSuperseded = false;
    if (needsMigration) {
      if (!hasCrossContextLock) {
        try {
          const migrated = await migrateAutosaveWithoutCrossContextLock(
            project,
            !currentProject,
            verifiedProject,
            pdfEntries,
          );
          // A clean false result means the transaction observed a newer
          // manifest. Storage failures are different: migration is optional
          // and the already-verified source can still be opened safely.
          snapshotSuperseded = !migrated;
        } catch {
          // Preserve the existing recovery contract for quota/upgrade write
          // failures. A later autosave can retry the schema migration.
        }
      } else {
        try {
          await setMany([
            [PROJECT_KEY, verifiedProject],
            ...pdfEntries.map(
              ([id, bytes]): [string, Uint8Array] => [`${PDF_KEY_PREFIX}${id}`, bytes],
            ),
          ]);
          if (!currentProject) {
            try {
              await delMany([
                LEGACY_PROJECT_KEY,
                ...pdfEntries.map(([id]) => `${LEGACY_PDF_KEY_PREFIX}${id}`),
              ]);
            } catch {
              // The verified current copy is complete; stale legacy cleanup can
              // be retried by a later save or explicit clear.
            }
          }
        } catch {
          // Opening valid work is more important than an eager schema upgrade
          // while a browser-wide Web Lock already prevents a competing save.
          // The returned project carries hashes, so the next autosave retries.
        }
      }
    }
    if (!hasCrossContextLock && !needsMigration) {
      snapshotSuperseded = !(await validateAutosaveWithoutCrossContextLock(
        project,
        !currentProject,
      ));
    }
    if (snapshotSuperseded) {
      if (remainingRetries <= 0) {
        throw new Error("Autosave changed in another tab while it was opening. Try opening it again.");
      }
      return loadAutosaveAttempt(remainingRetries - 1);
    }
    return { project: verifiedProject, pdfBytes: Object.fromEntries(pdfEntries) };
  });
}

export async function loadAutosave(): Promise<LoadedClassroomProject | null> {
  return loadAutosaveAttempt(AUTOSAVE_LOAD_RETRY_LIMIT);
}

export async function clearAutosave(_project?: ClassroomProject): Promise<void> {
  await enqueueMutation(async () => {
    if (autosaveStore) {
      await autosaveStore("readwrite", commitAutosaveClearTransaction);
      return;
    }
    const pdfKeys = (await keys()).filter((key): key is string => (
      typeof key === "string"
      && (key.startsWith(PDF_KEY_PREFIX) || key.startsWith(LEGACY_PDF_KEY_PREFIX))
    ));
    await delMany([PROJECT_KEY, LEGACY_PROJECT_KEY, ...pdfKeys]);
  });
}
