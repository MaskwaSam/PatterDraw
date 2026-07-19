import { del, get, set } from "idb-keyval";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, sanitizeProject } from "./safety";

const PROJECT_KEY = "patterdraw:autosave:project:v1";
const PDF_KEY_PREFIX = "patterdraw:autosave:pdf:v1:";
const LEGACY_PROJECT_KEY = "excalidraw-classroom:autosave:project:v1";
const LEGACY_PDF_KEY_PREFIX = "excalidraw-classroom:autosave:pdf:v1:";

export async function saveAutosave(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
): Promise<void> {
  const safe = sanitizeProject(project);
  assertSafeProject(safe);
  await Promise.all([
    set(PROJECT_KEY, safe),
    ...Object.entries(pdfBytes).map(([id, bytes]) => set(`${PDF_KEY_PREFIX}${id}`, bytes)),
  ]);
}

export async function loadAutosave(): Promise<LoadedClassroomProject | null> {
  const currentProject = await get<ClassroomProject>(PROJECT_KEY);
  const project = currentProject || await get<ClassroomProject>(LEGACY_PROJECT_KEY);
  if (!project) return null;
  assertSafeProject(project);
  const safeProject = sanitizeProject(project);

  const pdfEntries = await Promise.all(
    Object.keys(safeProject.pdfDocuments).map(async (id) => {
      const bytes = await get<Uint8Array>(`${PDF_KEY_PREFIX}${id}`)
        || await get<Uint8Array>(`${LEGACY_PDF_KEY_PREFIX}${id}`);
      if (!bytes) throw new Error(`Autosave is missing PDF data for ${id}.`);
      return [id, bytes] as const;
    }),
  );

  return { project: safeProject, pdfBytes: Object.fromEntries(pdfEntries) };
}

export async function clearAutosave(project?: ClassroomProject): Promise<void> {
  const ids = project ? Object.keys(project.pdfDocuments) : [];
  await Promise.all([
    del(PROJECT_KEY),
    del(LEGACY_PROJECT_KEY),
    ...ids.map((id) => del(`${PDF_KEY_PREFIX}${id}`)),
    ...ids.map((id) => del(`${LEGACY_PDF_KEY_PREFIX}${id}`)),
  ]);
}
