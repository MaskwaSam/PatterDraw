import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, MAX_PROJECT_BYTES, sanitizeProject } from "./safety";

const MANIFEST_PATH = "project.json";
const MAX_ARCHIVE_ENTRIES = 512;

class ProjectArchiveError extends Error {}

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
  maxUncompressedBytes = MAX_PROJECT_BYTES,
): Uint8Array {
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  const safe = sanitizeProject(project);
  assertSafeProject(safe);
  const manifest = strToU8(JSON.stringify(safe, null, 2));
  if (manifest.byteLength > maxUncompressedBytes) {
    throw new Error("The complete project is too large to save safely.");
  }
  let uncompressedBytes = manifest.byteLength;
  let archiveEntries = 1;
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: manifest,
  };

  for (const [id, source] of Object.entries(safe.pdfDocuments)) {
    const bytes = pdfBytes[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    archiveEntries += 1;
    uncompressedBytes += bytes.byteLength;
    if (archiveEntries > MAX_ARCHIVE_ENTRIES || uncompressedBytes > maxUncompressedBytes) {
      throw new Error("The complete project is too large to save safely.");
    }
    entries[source.archivePath] = bytes;
  }
  const archive = zipSync(entries, { level: 6 });
  if (archive.byteLength > maxUncompressedBytes) {
    throw new Error("The complete project is too large to save safely.");
  }
  return archive;
}

export function decodeProjectFile(
  bytes: Uint8Array,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
): LoadedClassroomProject {
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  if (bytes.byteLength > maxUncompressedBytes) throw new Error("Project file is too large.");
  let archiveEntries = 0;
  let uncompressedBytes = 0;
  const archivePaths = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        assertArchivePath(name);
        if (archivePaths.has(name)) {
          throw new ProjectArchiveError(`Project archive contains a duplicate entry: ${name}.`);
        }
        archivePaths.add(name);
        archiveEntries += 1;
        uncompressedBytes += originalSize;
        if (
          archiveEntries > MAX_ARCHIVE_ENTRIES
          || !Number.isSafeInteger(originalSize)
          || originalSize < 0
          || !Number.isSafeInteger(uncompressedBytes)
          || uncompressedBytes > maxUncompressedBytes
        ) {
          throw new ProjectArchiveError("Project archive expands beyond the classroom safety limit.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectArchiveError) throw error;
    throw new Error("Project archive is not a valid PatterDraw file.");
  }
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
