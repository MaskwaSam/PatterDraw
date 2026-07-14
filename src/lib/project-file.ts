import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, MAX_PROJECT_BYTES, sanitizeProject } from "./safety";

const MANIFEST_PATH = "project.json";

function assertArchivePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.split(/[\\/]+/).some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Unsafe archive entry: ${path || "(empty)"}`);
  }
}

export function encodeProjectFile(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
): Uint8Array {
  const safe = sanitizeProject(project);
  assertSafeProject(safe);
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(JSON.stringify(safe, null, 2)),
  };

  for (const [id, source] of Object.entries(safe.pdfDocuments)) {
    const bytes = pdfBytes[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    entries[source.archivePath] = bytes;
  }
  return zipSync(entries, { level: 6 });
}

export function decodeProjectFile(bytes: Uint8Array): LoadedClassroomProject {
  if (bytes.byteLength > MAX_PROJECT_BYTES) throw new Error("Project file is too large.");
  const entries = unzipSync(bytes);
  for (const path of Object.keys(entries)) assertArchivePath(path);
  if (!entries[MANIFEST_PATH]) throw new Error("Project manifest is missing.");

  let project: ClassroomProject;
  try {
    project = JSON.parse(strFromU8(entries[MANIFEST_PATH])) as ClassroomProject;
  } catch {
    throw new Error("Project manifest is not valid JSON.");
  }
  assertSafeProject(project);

  const pdfBytes: Record<PdfDocumentId, Uint8Array> = {};
  for (const [id, source] of Object.entries(project.pdfDocuments)) {
    const data = entries[source.archivePath];
    if (!data || data.byteLength !== source.byteLength) {
      throw new Error(`Project is missing PDF data for ${source.name}.`);
    }
    pdfBytes[id] = data;
  }

  return { project: sanitizeProject(project), pdfBytes };
}

