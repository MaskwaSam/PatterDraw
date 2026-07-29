import { delMany, get, keys, setMany } from "idb-keyval";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, sanitizeProject } from "./safety";
import { sha256Hex } from "./sha256";

const PROJECT_KEY = "patterdraw:autosave:project:v1";
const PDF_KEY_PREFIX = "patterdraw:autosave:pdf:v1:";
const LEGACY_PROJECT_KEY = "excalidraw-classroom:autosave:project:v1";
const LEGACY_PDF_KEY_PREFIX = "excalidraw-classroom:autosave:pdf:v1:";
const MUTATION_LOCK = "patterdraw:autosave:mutation:v1";
let mutationQueue: Promise<void> = Promise.resolve();

type MutationOperation = (hasCrossContextLock: boolean) => Promise<void>;

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
): Promise<void> {
  const safe = sanitizeProject(project);
  assertSafeProject(safe);
  const verifiedDocuments = await Promise.all(
    Object.entries(safe.pdfDocuments).map(async ([id, source]) => {
      const bytes = pdfBytes[id];
      if (!bytes || bytes.byteLength !== source.byteLength) {
        throw new Error(`PDF data does not match project metadata for ${source.name}.`);
      }
      const sha256 = await sha256Hex(bytes);
      if (source.sha256 && source.sha256 !== sha256) {
        throw new Error(`PDF data does not match project metadata for ${source.name}.`);
      }
      return [id, { ...source, sha256 }] as const;
    }),
  );
  const verifiedProject: ClassroomProject = {
    ...safe,
    pdfDocuments: Object.fromEntries(verifiedDocuments),
  };
  const pdfEntries = Object.entries(verifiedProject.pdfDocuments).map(
    ([id, source]) => ({
      bytes: pdfBytes[id],
      key: `${PDF_KEY_PREFIX}${id}`,
      source,
    }),
  );

  await enqueueMutation(async (hasCrossContextLock) => {
    const entries: [string, ClassroomProject | Uint8Array][] = [[PROJECT_KEY, verifiedProject]];
    let storedKeys: IDBValidKey[] = [];
    if (hasCrossContextLock) {
      const [storedProject, existingKeys] = await Promise.all([
        get<ClassroomProject>(PROJECT_KEY),
        keys(),
      ]);
      storedKeys = existingKeys;
      const existingKeySet = new Set(existingKeys);
      for (const { bytes, key, source } of pdfEntries) {
        const storedSource = storedProject?.pdfDocuments?.[source.id];
        if (
          !existingKeySet.has(key)
          || storedSource?.byteLength !== source.byteLength
          || storedSource?.sha256 !== source.sha256
        ) {
          entries.push([key, bytes]);
        }
      }
    } else {
      entries.push(...pdfEntries.map(
        ({ bytes, key }): [string, Uint8Array] => [key, bytes],
      ));
    }
    await setMany(entries);
    if (!hasCrossContextLock) return;

    const referencedKeys = new Set(
      Object.keys(verifiedProject.pdfDocuments).map((id) => `${PDF_KEY_PREFIX}${id}`),
    );
    const staleKeys = storedKeys.filter((key): key is string => (
      typeof key === "string"
      && (
        (key.startsWith(PDF_KEY_PREFIX) && !referencedKeys.has(key))
        || key === LEGACY_PROJECT_KEY
        || key.startsWith(LEGACY_PDF_KEY_PREFIX)
      )
    ));
    if (staleKeys.length) await delMany(staleKeys);
  });
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
    const verifiedProject = sanitizeProject({
      ...safeProject,
      pdfDocuments: Object.fromEntries(
        loadedPdfEntries.map(({ id, source }) => [id, source]),
      ),
    });
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
