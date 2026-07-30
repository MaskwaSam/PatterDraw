import type { ClassroomProject, LoadedClassroomProject, PdfDocumentId } from "../types";
import { assertSafeProject, MAX_PROJECT_BYTES, sanitizeProject } from "./safety";
import { sha256Hex } from "./sha256";
import { assertProjectFitsContentBudget } from "./project-budget";
import { createProjectArchive, extractProjectArchive } from "./project-archive-client";

const MANIFEST_PATH = "project.json";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
  return createProjectArchive(entries, maxUncompressedBytes);
}

export async function decodeProjectFile(
  bytes: Uint8Array,
  maxUncompressedBytes = MAX_PROJECT_BYTES,
): Promise<LoadedClassroomProject> {
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  const entries = await extractProjectArchive(bytes, maxUncompressedBytes);
  if (!entries[MANIFEST_PATH]) throw new Error("Project manifest is missing.");

  let project: ClassroomProject;
  try {
    project = JSON.parse(textDecoder.decode(entries[MANIFEST_PATH])) as ClassroomProject;
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
