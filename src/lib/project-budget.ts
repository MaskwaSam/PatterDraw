import type { ClassroomProject, PdfDocumentId } from "../types";
import { MAX_PROJECT_BYTES } from "./safety";

export interface ProjectContentSize {
  manifestBytes: number;
  pdfBytes: number;
  totalBytes: number;
}

type JsonContainer = Record<PropertyKey, unknown> | readonly unknown[];

function jsonStringUtf8ByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON.stringify escapes an unpaired surrogate as \udxxx.
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonValueUtf8ByteLength(
  value: unknown,
  depth: number,
  ancestors: Set<JsonContainer>,
): number | undefined {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringUtf8ByteLength(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value).length : 4;
  }
  if (typeof value === "bigint") {
    throw new TypeError("BigInt values cannot be stored in a project.");
  }
  if (typeof value !== "object") return undefined;
  const container = value as JsonContainer;
  if (ancestors.has(container)) throw new TypeError("Circular project data cannot be saved.");
  ancestors.add(container);

  try {
    if (Array.isArray(value)) {
      if (!value.length) return 2;
      let bytes = 2;
      const indentation = (depth + 1) * 2;
      for (let index = 0; index < value.length; index += 1) {
        bytes += indentation;
        bytes += jsonValueUtf8ByteLength(value[index], depth + 1, ancestors) ?? 4;
        if (index < value.length - 1) bytes += 1;
        bytes += 1;
      }
      return bytes + depth * 2 + 1;
    }

    const entries = Object.keys(value)
      .map((key) => {
        const entryValue = jsonValueUtf8ByteLength(
          (value as Record<string, unknown>)[key],
          depth + 1,
          ancestors,
        );
        return entryValue === undefined ? null : [key, entryValue] as const;
      })
      .filter((entry): entry is readonly [string, number] => entry !== null);
    if (!entries.length) return 2;

    let bytes = 2;
    const indentation = (depth + 1) * 2;
    for (let index = 0; index < entries.length; index += 1) {
      const [key, entryBytes] = entries[index];
      bytes += indentation + jsonStringUtf8ByteLength(key) + 2 + entryBytes;
      if (index < entries.length - 1) bytes += 1;
      bytes += 1;
    }
    return bytes + depth * 2 + 1;
  } finally {
    ancestors.delete(container);
  }
}

/**
 * Counts the exact UTF-8 size of the two-space-indented plain JSON used by
 * PatterDraw archives without allocating a second full manifest string and
 * byte buffer during every autosave.
 */
export function getJsonUtf8ByteLength(value: unknown): number {
  return jsonValueUtf8ByteLength(value, 0, new Set()) ?? 0;
}

/**
 * Measures the complete uncompressed payload used by both autosave and the
 * portable project archive. Callers must sanitize and validate the project
 * before measuring it.
 */
export function getProjectContentSize(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
): ProjectContentSize {
  const manifestBytes = getJsonUtf8ByteLength(project);
  let pdfBytes = 0;

  for (const [id, source] of Object.entries(project.pdfDocuments)) {
    const bytes = pdfData[id];
    if (!bytes || bytes.byteLength !== source.byteLength) {
      throw new Error(`PDF data does not match project metadata for ${source.name}.`);
    }
    pdfBytes += bytes.byteLength;
    if (!Number.isSafeInteger(pdfBytes)) {
      throw new Error("The complete project is too large to save safely.");
    }
  }

  const totalBytes = manifestBytes + pdfBytes;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error("The complete project is too large to save safely.");
  }
  return { manifestBytes, pdfBytes, totalBytes };
}

export function assertProjectFitsContentBudget(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  maxBytes = MAX_PROJECT_BYTES,
): ProjectContentSize {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  const size = getProjectContentSize(project, pdfData);
  if (size.totalBytes > maxBytes) {
    throw new Error("The complete project is too large to save safely.");
  }
  return size;
}

export function assertProjectCanAcceptAdditionalBytes(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  additionalBytes: number,
  maxBytes = MAX_PROJECT_BYTES,
): ProjectContentSize {
  if (
    !Number.isSafeInteger(additionalBytes)
    || additionalBytes < 0
    || !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
  ) {
    throw new Error("The project size limit is invalid.");
  }
  const size = getProjectContentSize(project, pdfData);
  if (
    !Number.isSafeInteger(size.totalBytes + additionalBytes)
    || size.totalBytes + additionalBytes > maxBytes
  ) {
    throw new Error("The complete project is too large to save safely.");
  }
  return size;
}
