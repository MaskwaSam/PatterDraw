import { delMany, get, keys, setMany } from "idb-keyval";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, sanitizeProject } from "./safety";

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
  const pdfEntries: Array<[string, Uint8Array]> = [];

  for (const [id, source] of Object.entries(safe.pdfDocuments)) {
    const bytes = pdfBytes[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    pdfEntries.push([`${PDF_KEY_PREFIX}${id}`, bytes]);
  }

  await enqueueMutation(async (hasCrossContextLock) => {
    const entries: [string, ClassroomProject | Uint8Array][] = [[PROJECT_KEY, safe]];
    if (hasCrossContextLock) {
      const storedPdfBytes = await Promise.all(
        pdfEntries.map(([key]) => get<Uint8Array>(key)),
      );
      for (const [index, entry] of pdfEntries.entries()) {
        if (storedPdfBytes[index]?.byteLength !== entry[1].byteLength) entries.push(entry);
      }
    } else {
      entries.push(...pdfEntries);
    }
    await setMany(entries);
    if (!hasCrossContextLock) return;

    const referencedKeys = new Set(
      Object.keys(safe.pdfDocuments).map((id) => `${PDF_KEY_PREFIX}${id}`),
    );
    const staleKeys = (await keys()).filter((key): key is string => (
      typeof key === "string"
      && (
        (key.startsWith(PDF_KEY_PREFIX) && !referencedKeys.has(key))
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

    const pdfEntries = await Promise.all(
      Object.entries(safeProject.pdfDocuments).map(async ([id, source]) => {
        const currentBytes = await get<Uint8Array>(`${PDF_KEY_PREFIX}${id}`);
        const bytes = currentBytes?.byteLength === source.byteLength
          ? currentBytes
          : await get<Uint8Array>(`${LEGACY_PDF_KEY_PREFIX}${id}`);
        if (!bytes) {
          if (currentBytes) {
            throw new Error(`Autosave PDF data does not match project metadata for ${source.name}.`);
          }
          throw new Error(`Autosave is missing PDF data for ${id}.`);
        }
        if (bytes.byteLength !== source.byteLength) {
          throw new Error(`Autosave PDF data does not match project metadata for ${source.name}.`);
        }
        return [id, bytes] as const;
      }),
    );

    return { project: safeProject, pdfBytes: Object.fromEntries(pdfEntries) };
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
