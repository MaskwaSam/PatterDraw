import { unzipSync, zipSync } from "fflate";

export const MAX_PROJECT_ARCHIVE_ENTRIES = 512;

class ProjectArchiveError extends Error {}

function assertArchivePath(path: string): void {
  if (
    !path
    || path.startsWith("/")
    || path.startsWith("\\")
    || path.split(/[\\/]+/).some((part) => part === "." || part === "..")
  ) {
    throw new ProjectArchiveError(`Unsafe archive entry: ${path || "(empty)"}`);
  }
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
}

export function createProjectArchiveSync(
  entries: Record<string, Uint8Array>,
  maxBytes: number,
): Uint8Array {
  assertMaxBytes(maxBytes);
  const paths = Object.keys(entries);
  if (paths.length > MAX_PROJECT_ARCHIVE_ENTRIES) {
    throw new Error("The complete project is too large to save safely.");
  }
  let uncompressedBytes = 0;
  for (const path of paths) {
    assertArchivePath(path);
    uncompressedBytes += entries[path].byteLength;
    if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > maxBytes) {
      throw new Error("The complete project is too large to save safely.");
    }
  }
  const archive = zipSync(entries, { level: 6 });
  if (archive.byteLength > maxBytes) {
    throw new Error("The complete project is too large to save safely.");
  }
  return archive;
}

export function extractProjectArchiveSync(
  bytes: Uint8Array,
  maxBytes: number,
): Record<string, Uint8Array> {
  assertMaxBytes(maxBytes);
  if (bytes.byteLength > maxBytes) throw new Error("Project file is too large.");
  let archiveEntries = 0;
  let uncompressedBytes = 0;
  const archivePaths = new Set<string>();
  try {
    return unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        assertArchivePath(name);
        if (archivePaths.has(name)) {
          throw new ProjectArchiveError(`Project archive contains a duplicate entry: ${name}.`);
        }
        archivePaths.add(name);
        archiveEntries += 1;
        uncompressedBytes += originalSize;
        if (
          archiveEntries > MAX_PROJECT_ARCHIVE_ENTRIES
          || !Number.isSafeInteger(originalSize)
          || originalSize < 0
          || !Number.isSafeInteger(uncompressedBytes)
          || uncompressedBytes > maxBytes
        ) {
          throw new ProjectArchiveError("Project archive expands beyond the PatterDraw safety limit.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectArchiveError) throw error;
    throw new Error("Project archive is not a valid PatterDraw file.");
  }
}
