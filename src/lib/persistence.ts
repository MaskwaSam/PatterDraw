import { createStore, delMany, get, keys, setMany } from "idb-keyval";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import {
  assertSafeProject,
  assertSanitizedProject,
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
const autosaveStore = createStore("keyval-store", "keyval");
let mutationQueue: Promise<void> = Promise.resolve();

type MutationOperation = (hasCrossContextLock: boolean) => Promise<void>;
interface SaveAutosaveOptions {
  prepared?: boolean;
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
): [string, ClassroomProject | Uint8Array][] {
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
      !existingKeySet.has(key)
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

async function setManyAndDeleteStaleAtomically(
  verifiedProject: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  referencedPdfKeys: ReadonlySet<string>,
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

export async function loadAutosave(): Promise<LoadedClassroomProject | null> {
  return withCrossContextLock(async () => {
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
      || Object.values(safeProject.pdfDocuments).some((source) => !source.sha256);
    if (needsMigration) {
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
        // Opening valid work is more important than an eager schema upgrade.
        // The returned project carries hashes, so the next autosave retries
        // the same atomic migration.
      }
    }
    return { project: verifiedProject, pdfBytes: Object.fromEntries(pdfEntries) };
  });
}

export async function clearAutosave(_project?: ClassroomProject): Promise<void> {
  await enqueueMutation(async () => {
    const pdfKeys = (await keys()).filter((key): key is string => (
      typeof key === "string"
      && (key.startsWith(PDF_KEY_PREFIX) || key.startsWith(LEGACY_PDF_KEY_PREFIX))
    ));
    await delMany([PROJECT_KEY, LEGACY_PROJECT_KEY, ...pdfKeys]);
  });
}
