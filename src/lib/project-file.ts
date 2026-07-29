import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, MAX_PROJECT_BYTES, sanitizeProject } from "./safety";
import { sha256Hex } from "./sha256";

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

export async function encodeProjectFile(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
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
  const manifest = strToU8(JSON.stringify(verifiedProject, null, 2));
  if (manifest.byteLength > maxUncompressedBytes) {
    throw new Error("The complete project is too large to save safely.");
  }
  let uncompressedBytes = manifest.byteLength;
  let archiveEntries = 1;
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: manifest,
  };

  for (const [id, source] of Object.entries(verifiedProject.pdfDocuments)) {
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

export async function decodeProjectFile(
  bytes: Uint8Array,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
): Promise<LoadedClassroomProject> {
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
  const verifiedDocuments = await Promise.all(
    Object.entries(project.pdfDocuments).map(async ([id, source]) => {
      const data = entries[source.archivePath];
      if (!data || data.byteLength !== source.byteLength) {
        throw new Error(`Project is missing PDF data for ${source.name}.`);
      }
      const sha256 = await sha256Hex(data);
      if (source.sha256 && source.sha256 !== sha256) {
        throw new Error(`Project PDF data does not match its content identity for ${source.name}.`);
      }
      pdfBytes[id] = data;
      return [id, { ...source, sha256 }] as const;
    }),
  );
  const verifiedProject = sanitizeProject({
    ...project,
    pdfDocuments: Object.fromEntries(verifiedDocuments),
  });
  assertSafeProject(verifiedProject);
  return { project: verifiedProject, pdfBytes };
}
