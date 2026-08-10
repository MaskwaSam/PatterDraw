import { Inflate, zipSync } from "fflate";

export const MAX_PROJECT_ARCHIVE_ENTRIES = 512;

class ProjectArchiveError extends Error {}

interface CentralDirectoryEntry {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
  crc: number;
  flags: number;
  localOffset: number;
}

interface CentralDirectory {
  entries: CentralDirectoryEntry[];
  offset: number;
}

interface LocalArchiveEntry {
  metadata: CentralDirectoryEntry;
  compressed: Uint8Array;
  rangeStart: number;
  rangeEnd: number;
}

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL = 0xffff;
const ZIP32_SENTINEL = 0xffffffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_SUPPORTED_FLAGS = 0x0002 | 0x0004 | ZIP_UTF8_FLAG;
const INFLATE_INPUT_CHUNK_BYTES = 16 * 1024;

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function decodeArchiveName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(bytes);
  let name = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    name += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return name;
}

/**
 * Read central-directory CRCs without trusting the uncompressed-size field.
 * fflate exposes size/originalSize to its filter but not CRC; checking CRC
 * after extraction catches a deflate stream whose originalSize was forged
 * down to zero (which otherwise makes fflate return an empty output buffer).
 * PatterDraw archives are capped far below ZIP32's 4 GiB limits, so ZIP64 is
 * never required for a legitimate project. Reject it instead of dropping the
 * CRC/integrity boundary and delegating attacker-controlled 64-bit metadata.
 */
function readCentralDirectory(bytes: Uint8Array): CentralDirectory | undefined {
  const minimumEndOffset = Math.max(0, bytes.byteLength - 65_558);
  let endOffset = -1;
  for (let candidate = bytes.byteLength - 22; candidate >= minimumEndOffset; candidate -= 1) {
    if (
      readUint32(bytes, candidate) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && candidate + 22 + readUint16(bytes, candidate + 20) === bytes.byteLength
    ) {
      endOffset = candidate;
      break;
    }
  }
  if (endOffset < 0) return undefined;

  const diskNumber = readUint16(bytes, endOffset + 4);
  const centralDiskNumber = readUint16(bytes, endOffset + 6);
  const diskCount = readUint16(bytes, endOffset + 8);
  const count = readUint16(bytes, endOffset + 10);
  const centralSize = readUint32(bytes, endOffset + 12);
  const centralOffset = readUint32(bytes, endOffset + 16);
  if (diskCount >= ZIP64_SENTINEL || count >= ZIP64_SENTINEL
    || centralSize === ZIP32_SENTINEL || centralOffset === ZIP32_SENTINEL) {
    throw new ProjectArchiveError("ZIP64 project archives are not supported.");
  }
  if (
    diskNumber !== 0
    || centralDiskNumber !== 0
    || diskCount !== count
    || count > MAX_PROJECT_ARCHIVE_ENTRIES
    || centralOffset > endOffset
    || centralSize !== endOffset - centralOffset
  ) {
    throw new ProjectArchiveError("Project archive metadata is inconsistent.");
  }

  const entries: CentralDirectoryEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset > bytes.byteLength - 46 || readUint32(bytes, offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ProjectArchiveError("Project archive metadata is inconsistent.");
    }
    const flags = readUint16(bytes, offset + 8);
    const compression = readUint16(bytes, offset + 10);
    const crc = readUint32(bytes, offset + 16);
    const size = readUint32(bytes, offset + 20);
    const originalSize = readUint32(bytes, offset + 24);
    const localOffset = readUint32(bytes, offset + 42);
    if (size === ZIP32_SENTINEL || originalSize === ZIP32_SENTINEL || localOffset === ZIP32_SENTINEL) {
      throw new ProjectArchiveError("ZIP64 project archives are not supported.");
    }
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const diskStart = readUint16(bytes, offset + 34);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (
      diskStart !== 0
      || (flags & ~ZIP_SUPPORTED_FLAGS) !== 0
      || (compression !== 0 && compression !== 8)
      || recordLength > bytes.byteLength - offset
      || offset + recordLength > centralOffset + centralSize
    ) {
      throw new ProjectArchiveError("Project archive metadata is inconsistent.");
    }
    const name = decodeArchiveName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      (flags & 0x0800) !== 0,
    );
    if (names.has(name)) {
      throw new ProjectArchiveError(`Project archive contains a duplicate entry: ${name}.`);
    }
    names.add(name);
    entries.push({ name, size, originalSize, compression, crc, flags, localOffset });
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new ProjectArchiveError("Project archive metadata is inconsistent.");
  }
  return { entries, offset: centralOffset };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readLocalArchiveEntry(
  bytes: Uint8Array,
  metadata: CentralDirectoryEntry,
  centralOffset: number,
): LocalArchiveEntry {
  const { localOffset } = metadata;
  if (
    localOffset > centralOffset - 30
    || readUint32(bytes, localOffset) !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    throw new ProjectArchiveError("Project archive metadata is inconsistent.");
  }

  const flags = readUint16(bytes, localOffset + 6);
  const compression = readUint16(bytes, localOffset + 8);
  const localCrc = readUint32(bytes, localOffset + 14);
  const localSize = readUint32(bytes, localOffset + 18);
  const localOriginalSize = readUint32(bytes, localOffset + 22);
  const nameLength = readUint16(bytes, localOffset + 26);
  const extraLength = readUint16(bytes, localOffset + 28);
  const payloadOffset = localOffset + 30 + nameLength + extraLength;
  const payloadEnd = payloadOffset + metadata.size;
  if (
    flags !== metadata.flags
    || compression !== metadata.compression
    || localSize === ZIP32_SENTINEL
    || localOriginalSize === ZIP32_SENTINEL
    || payloadOffset > centralOffset
    || payloadEnd > centralOffset
    || payloadEnd < payloadOffset
  ) {
    throw new ProjectArchiveError("Project archive metadata is inconsistent.");
  }

  const localName = decodeArchiveName(
    bytes.subarray(localOffset + 30, localOffset + 30 + nameLength),
    (flags & ZIP_UTF8_FLAG) !== 0,
  );
  if (localName !== metadata.name) {
    throw new ProjectArchiveError("Project archive metadata is inconsistent.");
  }

  if (
    localCrc !== metadata.crc
    || localSize !== metadata.size
    || localOriginalSize !== metadata.originalSize
  ) {
    throw new ProjectArchiveError("Project archive metadata is inconsistent.");
  }

  return {
    metadata,
    compressed: bytes.subarray(payloadOffset, payloadEnd),
    rangeStart: localOffset,
    rangeEnd: payloadEnd,
  };
}

function inflateArchiveEntry(entry: LocalArchiveEntry): Uint8Array {
  const expectedBytes = entry.metadata.originalSize;
  const output = new Uint8Array(expectedBytes);
  let outputOffset = 0;
  const inflator = new Inflate((chunk) => {
    if (chunk.byteLength > expectedBytes - outputOffset) {
      throw new ProjectArchiveError("Project archive metadata does not match extracted data.");
    }
    output.set(chunk, outputOffset);
    outputOffset += chunk.byteLength;
  });

  if (entry.compressed.byteLength === 0) {
    inflator.push(entry.compressed, true);
  } else {
    for (let offset = 0; offset < entry.compressed.byteLength; offset += INFLATE_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + INFLATE_INPUT_CHUNK_BYTES, entry.compressed.byteLength);
      inflator.push(entry.compressed.subarray(offset, end), end === entry.compressed.byteLength);
    }
  }
  if (outputOffset !== expectedBytes) {
    throw new ProjectArchiveError("Project archive metadata does not match extracted data.");
  }
  return output;
}

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
  try {
    const centralDirectory = readCentralDirectory(bytes);
    if (!centralDirectory) {
      throw new ProjectArchiveError("Project archive metadata is inconsistent.");
    }
    let uncompressedBytes = 0;
    const localEntries: LocalArchiveEntry[] = [];
    for (const metadata of centralDirectory.entries) {
      assertArchivePath(metadata.name);
      if (
        !Number.isSafeInteger(metadata.size)
        || metadata.size < 0
        || !Number.isSafeInteger(metadata.originalSize)
        || metadata.originalSize < 0
        || metadata.size > bytes.byteLength
        || (metadata.compression === 0 && metadata.size !== metadata.originalSize)
      ) {
        throw new ProjectArchiveError("Project archive metadata is inconsistent.");
      }
      uncompressedBytes += metadata.originalSize;
      if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > maxBytes) {
        throw new ProjectArchiveError("Project archive expands beyond the PatterDraw safety limit.");
      }
      localEntries.push(readLocalArchiveEntry(bytes, metadata, centralDirectory.offset));
    }

    const orderedRanges = [...localEntries].sort((left, right) => left.rangeStart - right.rangeStart);
    for (let index = 1; index < orderedRanges.length; index += 1) {
      if (orderedRanges[index].rangeStart < orderedRanges[index - 1].rangeEnd) {
        throw new ProjectArchiveError("Project archive metadata is inconsistent.");
      }
    }

    const entries = Object.create(null) as Record<string, Uint8Array>;
    for (const localEntry of localEntries) {
      const entry = localEntry.metadata.compression === 0
        ? localEntry.compressed.slice()
        : inflateArchiveEntry(localEntry);
      if (
        entry.byteLength !== localEntry.metadata.originalSize
        || crc32(entry) !== localEntry.metadata.crc
      ) {
        throw new ProjectArchiveError("Project archive metadata does not match extracted data.");
      }
      entries[localEntry.metadata.name] = entry;
    }
    return entries;
  } catch (error) {
    if (error instanceof ProjectArchiveError) throw error;
    throw new Error("Project archive is not a valid PatterDraw file.");
  }
}
