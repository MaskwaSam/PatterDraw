import { get } from "idb-keyval";

export const PERSONAL_LIBRARY_KEY = "patterdraw:library:v1";
export const LEGACY_PERSONAL_LIBRARY_KEY = "excalidraw-classroom:library:v1";
export const SCREENSHOT_LIBRARY_KEY = "patterdraw:screenshot-library:v1";
export const LEGACY_SCREENSHOT_LIBRARY_KEY = "excalidraw-classroom:screenshot-library:v1";

/**
 * Project content has its own 150 MB ceiling. Device-wide reusable libraries
 * share this separate allowance so they cannot silently consume an unbounded
 * amount of the same browser storage used by autosave.
 */
export const MAX_AUXILIARY_STORAGE_BYTES = 64 * 1024 * 1024;

const textEncoder = new TextEncoder();

export function estimateStructuredStorageBytes(value: unknown): number {
  let binaryBytes = 0;
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, candidate: unknown) => {
      if (candidate instanceof Blob) {
        binaryBytes += candidate.size;
        return { type: candidate.type, size: candidate.size };
      }
      if (candidate instanceof ArrayBuffer) {
        binaryBytes += candidate.byteLength;
        return { byteLength: candidate.byteLength };
      }
      if (ArrayBuffer.isView(candidate)) {
        binaryBytes += candidate.byteLength;
        return { byteLength: candidate.byteLength };
      }
      return candidate;
    });
  } catch {
    throw new Error("Local library storage contains data that cannot be measured safely.");
  }
  const metadataBytes = json === undefined ? 0 : textEncoder.encode(json).byteLength;
  const totalBytes = metadataBytes + binaryBytes;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error("Local library storage is too large.");
  }
  return totalBytes;
}

export function assertAuxiliaryStorageValuesFit(
  libraryValue: unknown,
  screenshotValue: unknown,
  maxBytes = MAX_AUXILIARY_STORAGE_BYTES,
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The local library size limit is invalid.");
  }
  const totalBytes = (
    estimateStructuredStorageBytes(libraryValue)
    + estimateStructuredStorageBytes(screenshotValue)
  );
  if (totalBytes > maxBytes) {
    throw new Error(
      "The Personal and Screenshot Libraries are full. Delete saved library items or screenshots before adding more.",
    );
  }
  return totalBytes;
}

interface AuxiliaryStorageReplacement {
  library?: unknown;
  screenshots?: unknown;
}

export async function assertAuxiliaryStorageBudget(
  replacement: AuxiliaryStorageReplacement,
): Promise<void> {
  const [
    currentLibrary,
    legacyLibrary,
    currentScreenshots,
    legacyScreenshots,
  ] = await Promise.all([
    get<unknown>(PERSONAL_LIBRARY_KEY),
    get<unknown>(LEGACY_PERSONAL_LIBRARY_KEY),
    get<unknown>(SCREENSHOT_LIBRARY_KEY),
    get<unknown>(LEGACY_SCREENSHOT_LIBRARY_KEY),
  ]);
  const libraryValue = Object.hasOwn(replacement, "library")
    ? replacement.library
    : currentLibrary ?? legacyLibrary ?? [];
  const screenshotValue = Object.hasOwn(replacement, "screenshots")
    ? replacement.screenshots
    : currentScreenshots ?? legacyScreenshots ?? { version: 1, items: [] };
  assertAuxiliaryStorageValuesFit(libraryValue, screenshotValue);
}
