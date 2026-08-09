import { get } from "idb-keyval";
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_DATE_MS,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
  MAX_SCREENSHOT_SCENE_EDGE,
} from "./limits";
import {
  LEGACY_SCREENSHOT_LIBRARY_KEY,
  SCREENSHOT_LIBRARY_KEY,
} from "../storage-budget";
import {
  commitAuxiliaryStorage,
  enqueueAuxiliaryMutation,
  observationForValue,
  type AuxiliaryObservation,
} from "../auxiliary-persistence";

export { SCREENSHOT_LIBRARY_KEY };
export const SCREENSHOT_LIBRARY_LIMIT = 50;

export interface StoredScreenshot {
  id: string;
  createdAt: number;
  blob: Blob;
  width: number;
  height: number;
  sceneWidth: number;
  sceneHeight: number;
}

interface ScreenshotLibraryRecord {
  version: 1;
  items: StoredScreenshot[];
}

let observedScreenshotLibrary: AuxiliaryObservation | undefined;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IHDR_HEADER_BYTES = 33;

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isStoredScreenshot(value: unknown): value is StoredScreenshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredScreenshot>;
  return typeof item.id === "string"
    && item.id.length > 0
    && item.id.length <= 200
    && Number.isSafeInteger(item.createdAt)
    && isPositiveFinite(item.createdAt)
    && item.createdAt <= MAX_SCREENSHOT_DATE_MS
    && item.blob instanceof Blob
    && item.blob.type === "image/png"
    && item.blob.size > 0
    && item.blob.size <= MAX_SCREENSHOT_BYTES
    && Number.isInteger(item.width)
    && isPositiveFinite(item.width)
    && item.width <= MAX_SCREENSHOT_EDGE
    && Number.isInteger(item.height)
    && isPositiveFinite(item.height)
    && item.height <= MAX_SCREENSHOT_EDGE
    && item.width * item.height <= MAX_SCREENSHOT_PIXELS
    && isPositiveFinite(item.sceneWidth)
    && item.sceneWidth <= MAX_SCREENSHOT_SCENE_EDGE
    && isPositiveFinite(item.sceneHeight)
    && item.sceneHeight <= MAX_SCREENSHOT_SCENE_EDGE;
}

export function newestFirstScreenshots(items: readonly StoredScreenshot[]): StoredScreenshot[] {
  return [...items].sort((left, right) => (
    right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  ));
}

export function addScreenshotToLibrary(
  items: readonly StoredScreenshot[],
  screenshot: StoredScreenshot,
): StoredScreenshot[] {
  if (!isStoredScreenshot(screenshot)) throw new Error("The screenshot is not safe to store.");
  return newestFirstScreenshots([
    screenshot,
    ...items.filter((item) => item.id !== screenshot.id),
  ]).slice(0, SCREENSHOT_LIBRARY_LIMIT);
}

function readPngUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3];
}

function invalidScreenshotError(context: string, reason: string): Error {
  return new Error(`${context} contains invalid image: ${reason}`);
}

/**
 * Validate a persisted PNG without allocating its complete payload. The
 * metadata check above bounds the blob to MAX_SCREENSHOT_BYTES and the
 * dimensions to the existing edge/pixel limits before this header read or a
 * browser decoder can run.
 */
async function validateScreenshotBinary(
  screenshot: StoredScreenshot,
  context: string,
): Promise<void> {
  const header = new Uint8Array(await screenshot.blob.slice(0, PNG_IHDR_HEADER_BYTES).arrayBuffer());
  const validSignature = header.length >= PNG_IHDR_HEADER_BYTES
    && PNG_SIGNATURE.every((value, index) => header[index] === value);
  const ihdrLength = header.length >= 12 ? readPngUint32(header, 8) : 0;
  const validIhdr = validSignature
    && ihdrLength === 13
    && header[12] === 0x49
    && header[13] === 0x48
    && header[14] === 0x44
    && header[15] === 0x52;
  if (!validIhdr) {
    throw invalidScreenshotError(context, "PNG bytes are malformed.");
  }

  const width = readPngUint32(header, 16);
  const height = readPngUint32(header, 20);
  if (
    width !== screenshot.width
    || height !== screenshot.height
    || width <= 0
    || height <= 0
    || width > MAX_SCREENSHOT_EDGE
    || height > MAX_SCREENSHOT_EDGE
    || width * height > MAX_SCREENSHOT_PIXELS
  ) {
    throw invalidScreenshotError(context, "PNG dimensions do not match its metadata.");
  }

  const decoder = globalThis.createImageBitmap;
  if (typeof decoder !== "function") return;

  let bitmap: ImageBitmap;
  try {
    bitmap = await decoder(screenshot.blob);
  } catch (error) {
    const reason = error instanceof Error && error.message
      ? `could not be decoded safely: ${error.message}`
      : "could not be decoded safely.";
    throw invalidScreenshotError(context, reason);
  }
  try {
    if (
      !bitmap
      || typeof bitmap.close !== "function"
      || bitmap.width !== screenshot.width
      || bitmap.height !== screenshot.height
    ) {
      throw invalidScreenshotError(context, "decoded dimensions do not match its metadata.");
    }
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

async function validateScreenshotLibrary(value: unknown): Promise<StoredScreenshot[]> {
  if (!value || typeof value !== "object") throw new Error("The saved Screenshot Library is invalid.");
  const record = value as Partial<ScreenshotLibraryRecord>;
  if (record.version !== 1 || !Array.isArray(record.items)) {
    throw new Error("The saved Screenshot Library has an unsupported format.");
  }
  if (!record.items.every(isStoredScreenshot)) {
    throw new Error("The saved Screenshot Library contains an invalid image.");
  }
  if (new Set(record.items.map((item) => item.id)).size !== record.items.length) {
    throw new Error("The saved Screenshot Library contains duplicate images.");
  }
  // Keep decoder work bounded and deterministic. In particular, do not use
  // Promise.all here: each bitmap is closed before the next one is decoded.
  for (const item of record.items) {
    await validateScreenshotBinary(item, "The saved Screenshot Library");
  }
  return newestFirstScreenshots(record.items).slice(0, SCREENSHOT_LIBRARY_LIMIT);
}

export async function loadScreenshotLibrary(): Promise<StoredScreenshot[]> {
  const current = await get<unknown>(SCREENSHOT_LIBRARY_KEY);
  let currentError: unknown;
  if (current !== undefined && current !== null) {
    try {
      const items = await validateScreenshotLibrary(current);
      observedScreenshotLibrary = observationForValue(current, "canonical");
      return items;
    } catch (error) {
      // A malformed canonical record is recoverable when an older, valid
      // legacy record is still present.
      currentError = error;
    }
  }
  const legacy = await get<unknown>(LEGACY_SCREENSHOT_LIBRARY_KEY);
  if (legacy !== undefined && legacy !== null) {
    try {
      const items = await validateScreenshotLibrary(legacy);
      observedScreenshotLibrary = observationForValue(legacy, "legacy");
      return items;
    } catch (error) {
      observedScreenshotLibrary = undefined;
      if (currentError) throw currentError;
      throw error;
    }
  }
  if (currentError) {
    observedScreenshotLibrary = undefined;
    throw currentError;
  }
  observedScreenshotLibrary = observationForValue(undefined, "empty");
  return [];
}

export async function saveScreenshotLibrary(items: readonly StoredScreenshot[]): Promise<void> {
  const normalized = newestFirstScreenshots(items).slice(0, SCREENSHOT_LIBRARY_LIMIT);
  if (!normalized.every(isStoredScreenshot)) throw new Error("The Screenshot Library contains an invalid image.");
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) {
    throw new Error("The Screenshot Library contains duplicate images.");
  }
  const record: ScreenshotLibraryRecord = { version: 1, items: normalized };
  await enqueueAuxiliaryMutation(async () => {
    // Validate the PNG bytes inside the serialized mutation queue so two
    // simultaneous saves cannot drive multiple browser decoders in parallel.
    for (const item of normalized) {
      await validateScreenshotBinary(item, "The Screenshot Library");
    }
    const observation = await commitAuxiliaryStorage({
      collection: "screenshots",
      value: record,
      expected: observedScreenshotLibrary,
    });
    observedScreenshotLibrary = observation;
  });
}
