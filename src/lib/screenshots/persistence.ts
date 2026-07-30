import { get, set } from "idb-keyval";
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
} from "./limits";
import {
  assertAuxiliaryStorageBudget,
  LEGACY_SCREENSHOT_LIBRARY_KEY,
  SCREENSHOT_LIBRARY_KEY,
} from "../storage-budget";

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

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isStoredScreenshot(value: unknown): value is StoredScreenshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredScreenshot>;
  return typeof item.id === "string"
    && item.id.length > 0
    && item.id.length <= 200
    && isPositiveFinite(item.createdAt)
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
    && isPositiveFinite(item.sceneHeight);
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

function validateScreenshotLibrary(value: unknown): StoredScreenshot[] {
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
  return newestFirstScreenshots(record.items).slice(0, SCREENSHOT_LIBRARY_LIMIT);
}

export async function loadScreenshotLibrary(): Promise<StoredScreenshot[]> {
  const current = await get<unknown>(SCREENSHOT_LIBRARY_KEY);
  const stored = current ?? await get<unknown>(LEGACY_SCREENSHOT_LIBRARY_KEY);
  if (stored === undefined || stored === null) return [];
  return validateScreenshotLibrary(stored);
}

export async function saveScreenshotLibrary(items: readonly StoredScreenshot[]): Promise<void> {
  const normalized = newestFirstScreenshots(items).slice(0, SCREENSHOT_LIBRARY_LIMIT);
  if (!normalized.every(isStoredScreenshot)) throw new Error("The Screenshot Library contains an invalid image.");
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) {
    throw new Error("The Screenshot Library contains duplicate images.");
  }
  const record: ScreenshotLibraryRecord = { version: 1, items: normalized };
  await assertAuxiliaryStorageBudget({ screenshots: record });
  await set(SCREENSHOT_LIBRARY_KEY, record);
}
