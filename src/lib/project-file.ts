import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import {
  assertLoadedProjectRasterSafety,
  assertSafeProject,
  assertSanitizedProject,
  MAX_PROJECT_BYTES,
  type ProjectRasterSafetyOptions,
  sanitizeProject,
} from "./safety";
import { sha256Hex } from "./sha256";
import { assertProjectFitsContentBudget } from "./project-budget";
import { createProjectArchive, extractProjectArchive } from "./project-archive-client";
import {
  assertImportBytes,
  assertImportTextBytes,
  assertProjectStructure,
} from "./structural-limits";

const MANIFEST_PATH = "project.json";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function encodeProject(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  maxUncompressedBytes: number,
  prepared: boolean,
  options: ProjectRasterSafetyOptions = {},
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  // The prepared path deliberately skips sanitizeProject for memory reasons,
  // so it explicitly validates the untrusted graph before archive
  // serialization can walk it. The normal path validates inside
  // sanitizeProject before its defensive clone.
  if (prepared) assertProjectStructure(project, { label: "Project" });
  const safe = prepared ? project : sanitizeProject(project);
  assertSanitizedProject(safe);
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
  // Perform the same local-image/PDF preflight used after extraction before
  // creating an archive. A malformed embedded image must never be written
  // successfully only to fail when the next restore hydrates it.
  await assertLoadedProjectRasterSafety({ project: verifiedProject, pdfBytes }, options);
  assertProjectFitsContentBudget(verifiedProject, pdfBytes, maxUncompressedBytes);
  const manifest = textEncoder.encode(JSON.stringify(verifiedProject, null, 2));
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: manifest,
  };

  for (const [id, source] of Object.entries(verifiedProject.pdfDocuments)) {
    const bytes = pdfBytes[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    entries[source.archivePath] = bytes;
  }
  return createProjectArchive(entries, maxUncompressedBytes, options.signal);
}

export function encodeProjectFile(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
  options: ProjectRasterSafetyOptions = {},
): Promise<Uint8Array> {
  return encodeProject(project, pdfBytes, maxUncompressedBytes, false, options);
}

export function encodePreparedProjectFile(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
  options: ProjectRasterSafetyOptions = {},
): Promise<Uint8Array> {
  return encodeProject(project, pdfBytes, maxUncompressedBytes, true, options);
}

export async function decodeProjectFile(
  bytes: Uint8Array,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
  options: ProjectRasterSafetyOptions = {},
): Promise<LoadedClassroomProject> {
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  const entries = await extractProjectArchive(bytes, maxUncompressedBytes, options.signal);
  if (!entries[MANIFEST_PATH]) throw new Error("Project manifest is missing.");
  assertImportBytes(entries[MANIFEST_PATH].byteLength, maxUncompressedBytes, "Project manifest");

  let project: ClassroomProject;
  const manifestText = textDecoder.decode(entries[MANIFEST_PATH]);
  assertImportTextBytes(manifestText, maxUncompressedBytes, "Project manifest");
  try {
    project = JSON.parse(manifestText) as ClassroomProject;
  } catch {
    throw new Error("Project manifest is not valid JSON.");
  }
  assertProjectStructure(project, { label: "Project manifest" });
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
  const loaded = { project: verifiedProject, pdfBytes };
  await assertLoadedProjectRasterSafety(loaded, options);
  return loaded;
}
