import type { ClassroomProject, SerializedScene } from "../types";
import { MAX_AUXILIARY_STORAGE_BYTES } from "./storage-budget";

/**
 * Structural limits are deliberately independent from the semantic project
 * validator. They run while data is still untrusted, before a defensive
 * structuredClone/sanitizer or an Excalidraw migration routine can walk it.
 *
 * The byte ceilings leave room for the existing 150 MiB project archive and
 * 64 MiB auxiliary-storage budgets while bounding the shapes that can make a
 * browser spend disproportionate time or memory traversing otherwise small
 * JSON values. PDF pages can retain large local raster data URLs, hence the
 * per-string ceiling is intentionally generous (96 MiB).
 */

const MEBIBYTE = 1024 * 1024;

export const MAX_STRUCTURAL_DEPTH = 64;
export const MAX_STRUCTURAL_OBJECT_KEYS = 4_096;
export const MAX_STRUCTURAL_ARRAY_LENGTH = 100_000;
export const MAX_STRUCTURAL_STRING_BYTES = 96 * MEBIBYTE;
export const MAX_STRUCTURAL_TOTAL_STRING_BYTES = 140 * MEBIBYTE;
export const MAX_STRUCTURAL_TOTAL_KEYS = 2_000_000;
export const MAX_STRUCTURAL_TOTAL_NODES = 5_000_000;
export const MAX_STRUCTURAL_POINTS_PER_ELEMENT = 100_000;
export const MAX_STRUCTURAL_TOTAL_POINTS = 1_000_000;
/** Clipboard strings are transient selections, not full project archives. */
export const MAX_CLIPBOARD_TEXT_BYTES = 8 * MEBIBYTE;

/** A board plus a large imported PDF, with a small amount of migration headroom. */
export const MAX_PROJECT_SCENES = 512;
export const MAX_PROJECT_ELEMENTS_PER_SCENE = 100_000;
export const MAX_PROJECT_TOTAL_ELEMENTS = 250_000;
export const MAX_PROJECT_FILES_PER_SCENE = 10_000;
export const MAX_PROJECT_TOTAL_FILES = 25_000;

/** The auxiliary storage budget is 64 MiB; these counts leave migration room. */
export const MAX_LIBRARY_ITEMS = 4_096;
export const MAX_LIBRARY_ELEMENTS_PER_ITEM = 10_000;
export const MAX_LIBRARY_TOTAL_ELEMENTS = 50_000;

/**
 * Native Excalidraw scene files become PatterDraw projects, so their input
 * envelope matches the existing project ceiling. Libraries are retained in
 * the 64 MiB auxiliary-storage namespace and therefore use that ceiling.
 */
export const MAX_NATIVE_SCENE_TEXT_BYTES = 150 * MEBIBYTE;
export const MAX_NATIVE_SCENE_BLOB_BYTES = MAX_NATIVE_SCENE_TEXT_BYTES;
export const MAX_NATIVE_LIBRARY_TEXT_BYTES = MAX_AUXILIARY_STORAGE_BYTES;
export const MAX_NATIVE_LIBRARY_BLOB_BYTES = MAX_NATIVE_LIBRARY_TEXT_BYTES;

// Short aliases make the intended App integration obvious without requiring
// callers to know whether the input arrived as text or a File/Blob.
export const MAX_NATIVE_TEXT_BYTES = MAX_NATIVE_SCENE_TEXT_BYTES;
export const MAX_NATIVE_BLOB_BYTES = MAX_NATIVE_SCENE_BLOB_BYTES;

export type StructuralImportKind = "project" | "scene" | "library";

export interface StructuralLimits {
  maxDepth: number;
  maxObjectKeys: number;
  maxArrayLength: number;
  maxStringBytes: number;
  maxTotalStringBytes: number;
  maxTotalKeys: number;
  maxTotalNodes: number;
  maxPointsPerElement: number;
  maxTotalPoints: number;
}

export interface StructuralValidationOptions extends Partial<StructuralLimits> {
  /** Used only to make a rejection actionable at an import boundary. */
  label?: string;
}

export interface StructuralCounts {
  arrays: number;
  objects: number;
  nodes: number;
  keys: number;
  stringBytes: number;
  points: number;
}

const DEFAULT_LIMITS: StructuralLimits = Object.freeze({
  maxDepth: MAX_STRUCTURAL_DEPTH,
  maxObjectKeys: MAX_STRUCTURAL_OBJECT_KEYS,
  maxArrayLength: MAX_STRUCTURAL_ARRAY_LENGTH,
  maxStringBytes: MAX_STRUCTURAL_STRING_BYTES,
  maxTotalStringBytes: MAX_STRUCTURAL_TOTAL_STRING_BYTES,
  maxTotalKeys: MAX_STRUCTURAL_TOTAL_KEYS,
  maxTotalNodes: MAX_STRUCTURAL_TOTAL_NODES,
  maxPointsPerElement: MAX_STRUCTURAL_POINTS_PER_ELEMENT,
  maxTotalPoints: MAX_STRUCTURAL_TOTAL_POINTS,
});

function assertPositiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${name} structural limit is invalid.`);
  }
}

function limitsFor(options: StructuralValidationOptions): StructuralLimits {
  const limits = {
    ...DEFAULT_LIMITS,
    ...options,
  } as StructuralLimits;
  assertPositiveLimit("depth", limits.maxDepth);
  assertPositiveLimit("object-key", limits.maxObjectKeys);
  assertPositiveLimit("array-length", limits.maxArrayLength);
  assertPositiveLimit("string-byte", limits.maxStringBytes);
  assertPositiveLimit("total-string-byte", limits.maxTotalStringBytes);
  assertPositiveLimit("total-key", limits.maxTotalKeys);
  assertPositiveLimit("total-node", limits.maxTotalNodes);
  assertPositiveLimit("point", limits.maxPointsPerElement);
  assertPositiveLimit("total-point", limits.maxTotalPoints);
  return limits;
}

function labelFor(options: StructuralValidationOptions): string {
  return options.label?.trim() || "Structured data";
}

/** Return the actual UTF-8 byte length without allocating an encoded copy. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // TextEncoder replaces an unpaired surrogate with U+FFFD.
        bytes += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isPlainArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

function displayPath(path: string): string {
  if (path.length <= 120) return path;
  return `${path.slice(0, 116)}…`;
}

function structuralError(label: string, path: string, message: string): Error {
  return new Error(`${label} ${message}${path ? ` at ${displayPath(path)}` : ""}.`);
}

function ownKeys(value: object, label: string, path: string): string[] {
  let symbols: symbol[];
  let names: string[];
  let keys: string[];
  try {
    symbols = Object.getOwnPropertySymbols(value);
    names = Object.getOwnPropertyNames(value);
    keys = Object.keys(value);
  } catch {
    throw structuralError(label, path, "contains an unreadable object");
  }
  if (symbols.length > 0) {
    throw structuralError(label, path, "contains symbol keys; only JSON-like string keys are supported");
  }
  // JSON.parse/structured-clone records expose enumerable data properties.
  // Refuse hidden own properties so a crafted object cannot smuggle work past
  // the visible key/array counters.
  const keySet = new Set(keys);
  const hiddenNames = names.filter((name) => !keySet.has(name));
  if (hiddenNames.length > 0 && !(Array.isArray(value) && hiddenNames.length === 1 && hiddenNames[0] === "length")) {
    throw structuralError(label, path, "contains non-enumerable keys; only JSON-like properties are supported");
  }
  return keys;
}

function readDataProperty(value: object, key: string, label: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw structuralError(label, path, "contains an unreadable property");
  }
  if (!descriptor || !("value" in descriptor)) {
    throw structuralError(label, `${path}.${key}`, "contains accessors; only data properties are supported");
  }
  return descriptor.value;
}

function pathFor(path: string, key: string | number): string {
  return path ? `${path}.${String(key)}` : String(key);
}

/**
 * Validate a JSON-like object graph without cloning it. The returned counters
 * are useful to callers that want to log or test the envelope they accepted.
 */
export function assertStructuredData(
  value: unknown,
  options: StructuralValidationOptions = {},
): StructuralCounts {
  const limits = limitsFor(options);
  const label = labelFor(options);
  const counts: StructuralCounts = {
    arrays: 0,
    objects: 0,
    nodes: 0,
    keys: 0,
    stringBytes: 0,
    points: 0,
  };
  const active = new WeakSet<{}>();

  const visit = (
    current: unknown,
    depth: number,
    path: string,
    parentKey: string | undefined,
  ): void => {
    if (depth > limits.maxDepth) {
      throw structuralError(label, path, `exceeds the maximum structural depth of ${limits.maxDepth}`);
    }
    counts.nodes += 1;
    if (counts.nodes > limits.maxTotalNodes) {
      throw structuralError(label, path, `exceeds the maximum node count of ${limits.maxTotalNodes}`);
    }

    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      const bytes = utf8ByteLength(current);
      if (bytes > limits.maxStringBytes) {
        throw structuralError(label, path, `contains a string larger than ${limits.maxStringBytes} UTF-8 bytes`);
      }
      counts.stringBytes += bytes;
      if (!Number.isSafeInteger(counts.stringBytes) || counts.stringBytes > limits.maxTotalStringBytes) {
        throw structuralError(label, path, `exceeds the total string budget of ${limits.maxTotalStringBytes} UTF-8 bytes`);
      }
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw structuralError(label, path, "contains a non-finite number");
      }
      return;
    }
    if (typeof current === "undefined") return;
    if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol") {
      throw structuralError(label, path, "contains a value that is not JSON-like");
    }
    if (typeof current !== "object") return;

    const objectValue = current as object;
    if (active.has(objectValue)) {
      throw structuralError(label, path, "contains a circular reference");
    }
    active.add(objectValue);
    try {
      if (isPlainArray(current)) {
        counts.arrays += 1;
        const array = current as readonly unknown[];
        if (array.length > limits.maxArrayLength) {
          throw structuralError(label, path, `contains an array longer than ${limits.maxArrayLength}`);
        }
        const keys = ownKeys(array, label, path);
        // JSON arrays are dense and have no custom properties. Refusing sparse
        // or decorated arrays avoids hidden work outside the advertised count.
        if (keys.length !== array.length || keys.some((key, index) => key !== String(index))) {
          throw structuralError(label, path, "contains a sparse or decorated array");
        }
        for (let index = 0; index < array.length; index += 1) {
          const childPath = pathFor(path, index);
          const child = readDataProperty(array, String(index), label, path);
          visit(child, depth + 1, childPath, parentKey === "points" ? "point" : undefined);
        }
        return;
      }

      if (!isPlainObject(current)) {
        throw structuralError(label, path, "must contain only plain objects and arrays");
      }
      counts.objects += 1;
      const keys = ownKeys(current, label, path);
      if (keys.length > limits.maxObjectKeys) {
        throw structuralError(label, path, `contains more than ${limits.maxObjectKeys} object keys`);
      }
      counts.keys += keys.length;
      if (!Number.isSafeInteger(counts.keys) || counts.keys > limits.maxTotalKeys) {
        throw structuralError(label, path, `exceeds the total object-key count of ${limits.maxTotalKeys}`);
      }
      for (const key of keys) {
        const keyBytes = utf8ByteLength(key);
        if (keyBytes > limits.maxStringBytes) {
          throw structuralError(label, pathFor(path, key), `contains a key larger than ${limits.maxStringBytes} UTF-8 bytes`);
        }
        counts.stringBytes += keyBytes;
        if (!Number.isSafeInteger(counts.stringBytes) || counts.stringBytes > limits.maxTotalStringBytes) {
          throw structuralError(label, pathFor(path, key), `exceeds the total string budget of ${limits.maxTotalStringBytes} UTF-8 bytes`);
        }
        const childPath = pathFor(path, key);
        const child = readDataProperty(current, key, label, path);
        if (key === "points" && Array.isArray(child)) {
          if (child.length > limits.maxPointsPerElement) {
            throw structuralError(label, childPath, `contains more than ${limits.maxPointsPerElement} points`);
          }
          counts.points += child.length;
          if (!Number.isSafeInteger(counts.points) || counts.points > limits.maxTotalPoints) {
            throw structuralError(label, childPath, `exceeds the total point count of ${limits.maxTotalPoints}`);
          }
        }
        visit(child, depth + 1, childPath, key);
      }
    } finally {
      active.delete(objectValue);
    }
  };

  visit(value, 0, "", undefined);
  return counts;
}

function requirePlainRecord(value: unknown, label: string, path: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw structuralError(label, path, "must be a plain object");
  }
}

function requireArray(value: unknown, label: string, path: string): asserts value is readonly unknown[] {
  if (!isPlainArray(value)) {
    throw structuralError(label, path, "must be a plain array");
  }
}

/** Validate a complete PatterDraw project before sanitizeProject/clone. */
export function assertProjectStructure(
  value: unknown,
  options: StructuralValidationOptions = {},
): asserts value is ClassroomProject {
  const label = options.label?.trim() || "Project";
  assertStructuredData(value, { ...options, label });
  requirePlainRecord(value, label, "");
  const project = value;
  const scenes = project.scenes;
  requirePlainRecord(scenes, label, "scenes");
  const sceneIds = Object.keys(scenes);
  if (sceneIds.length > MAX_PROJECT_SCENES) {
    throw structuralError(label, "scenes", `contains more than ${MAX_PROJECT_SCENES} scenes`);
  }
  let totalElements = 0;
  let totalFiles = 0;
  for (const sceneId of sceneIds) {
    const scene = scenes[sceneId];
    requirePlainRecord(scene, label, `scenes.${sceneId}`);
    const elements = scene.elements;
    requireArray(elements, label, `scenes.${sceneId}.elements`);
    if (elements.length > MAX_PROJECT_ELEMENTS_PER_SCENE) {
      throw structuralError(label, `scenes.${sceneId}.elements`, `contains more than ${MAX_PROJECT_ELEMENTS_PER_SCENE} elements`);
    }
    totalElements += elements.length;
    if (!Number.isSafeInteger(totalElements) || totalElements > MAX_PROJECT_TOTAL_ELEMENTS) {
      throw structuralError(label, "scenes", `exceeds the total element count of ${MAX_PROJECT_TOTAL_ELEMENTS}`);
    }
    const files = scene.files;
    requirePlainRecord(files, label, `scenes.${sceneId}.files`);
    const fileIds = Object.keys(files);
    if (fileIds.length > MAX_PROJECT_FILES_PER_SCENE) {
      throw structuralError(label, `scenes.${sceneId}.files`, `contains more than ${MAX_PROJECT_FILES_PER_SCENE} files`);
    }
    totalFiles += fileIds.length;
    if (!Number.isSafeInteger(totalFiles) || totalFiles > MAX_PROJECT_TOTAL_FILES) {
      throw structuralError(label, "scenes", `exceeds the total file count of ${MAX_PROJECT_TOTAL_FILES}`);
    }
  }
  const slideOrder = project.slideOrder;
  requireArray(slideOrder, label, "slideOrder");
  if (slideOrder.length > MAX_PROJECT_TOTAL_ELEMENTS) {
    throw structuralError(label, "slideOrder", `contains more than ${MAX_PROJECT_TOTAL_ELEMENTS} slide records`);
  }
  const pdfPageOrder = project.pdfPageOrder;
  if (pdfPageOrder !== undefined) {
    requireArray(pdfPageOrder, label, "pdfPageOrder");
    if (pdfPageOrder.length > MAX_PROJECT_SCENES) {
      throw structuralError(label, "pdfPageOrder", `contains more than ${MAX_PROJECT_SCENES} pages`);
    }
  }
  requirePlainRecord(project.pdfDocuments, label, "pdfDocuments");
  if (Object.keys(project.pdfDocuments).length > MAX_PROJECT_SCENES) {
    throw structuralError(label, "pdfDocuments", `contains more than ${MAX_PROJECT_SCENES} documents`);
  }
}

/** Validate an Excalidraw scene or the scene-shaped native import object. */
export function assertSceneStructure(
  value: unknown,
  options: StructuralValidationOptions = {},
): asserts value is SerializedScene {
  const label = options.label?.trim() || "Scene";
  assertStructuredData(value, { ...options, label });
  requirePlainRecord(value, label, "");
  requireArray(value.elements, label, "elements");
  if (value.elements.length > MAX_PROJECT_ELEMENTS_PER_SCENE) {
    throw structuralError(label, "elements", `contains more than ${MAX_PROJECT_ELEMENTS_PER_SCENE} elements`);
  }
  if (value.appState !== undefined) requirePlainRecord(value.appState, label, "appState");
  if (value.files !== undefined) {
    requirePlainRecord(value.files, label, "files");
    if (Object.keys(value.files).length > MAX_PROJECT_FILES_PER_SCENE) {
      throw structuralError(label, "files", `contains more than ${MAX_PROJECT_FILES_PER_SCENE} files`);
    }
  }
}

export const assertNativeSceneStructure = assertSceneStructure;

/** Validate both v2 library item objects and legacy nested-array items. */
export function assertLibraryStructure(
  value: unknown,
  options: StructuralValidationOptions = {},
): asserts value is readonly unknown[] {
  const label = options.label?.trim() || "Library";
  assertStructuredData(value, { ...options, label });
  requireArray(value, label, "");
  if (value.length > MAX_LIBRARY_ITEMS) {
    throw structuralError(label, "", `contains more than ${MAX_LIBRARY_ITEMS} items`);
  }
  let totalElements = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    let elements: readonly unknown[];
    if (Array.isArray(item)) {
      elements = item;
    } else {
      requirePlainRecord(item, label, `${index}`);
      if (!Object.hasOwn(item, "elements")) {
        throw structuralError(label, `${index}`, "library item is missing its elements array");
      }
      requireArray(item.elements, label, `${index}.elements`);
      elements = item.elements;
    }
    if (elements.length > MAX_LIBRARY_ELEMENTS_PER_ITEM) {
      throw structuralError(label, `${index}.elements`, `contains more than ${MAX_LIBRARY_ELEMENTS_PER_ITEM} elements`);
    }
    totalElements += elements.length;
    if (!Number.isSafeInteger(totalElements) || totalElements > MAX_LIBRARY_TOTAL_ELEMENTS) {
      throw structuralError(label, "", `exceeds the total element count of ${MAX_LIBRARY_TOTAL_ELEMENTS}`);
    }
  }
}

export const assertNativeLibraryStructure = assertLibraryStructure;

export function importByteLimitFor(kind: StructuralImportKind): number {
  return kind === "library" ? MAX_NATIVE_LIBRARY_TEXT_BYTES : MAX_NATIVE_SCENE_TEXT_BYTES;
}

function assertByteLimit(maxBytes: number, label: string): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`The ${label.toLowerCase()} byte limit is invalid.`);
  }
}

export function assertImportBytes(
  byteLength: number,
  maxBytes: number,
  label = "Import",
): number {
  assertByteLimit(maxBytes, label);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`${label} byte length is invalid.`);
  }
  if (byteLength > maxBytes) {
    throw new Error(`${label} is larger than the ${maxBytes}-byte import limit.`);
  }
  return byteLength;
}

/** Check a text payload before the caller invokes JSON.parse. */
export function assertImportTextBytes(
  value: string,
  maxBytes = MAX_NATIVE_SCENE_TEXT_BYTES,
  label = "Import text",
): number {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return assertImportBytes(utf8ByteLength(value), maxBytes, label);
}

/** Check a File/Blob payload before invoking .text() or a dependency parser. */
export function assertImportBlobBytes(
  value: Blob,
  maxBytes = MAX_NATIVE_SCENE_BLOB_BYTES,
  label = "Import file",
): number {
  if (!value || typeof value !== "object" || typeof value.size !== "number") {
    throw new Error(`${label} is not a Blob-like value.`);
  }
  return assertImportBytes(value.size, maxBytes, label);
}

// Explicit aliases are convenient when the caller is guarding a native file
// path and make the pre-read/pre-parse intent difficult to miss at call sites.
export const assertBlobWithinLimit = assertImportBlobBytes;
export const assertTextWithinLimit = assertImportTextBytes;

/**
 * Parse and structurally validate a native JSON import in one bounded helper.
 * Callers that need a custom error message can still invoke the lower-level
 * byte and structure helpers separately.
 */
export function parseBoundedImportJson<T = unknown>(
  text: string,
  kind: StructuralImportKind,
  maxBytes = importByteLimitFor(kind),
): T {
  assertImportTextBytes(text, maxBytes, `${kind} import text`);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`The ${kind} import is not valid JSON.`);
  }
  if (kind === "project") assertProjectStructure(value, { label: "Project import" });
  else if (kind === "scene") assertSceneStructure(value, { label: "Scene import" });
  else assertLibraryStructure(value, { label: "Library import" });
  return value as T;
}

export const parseBoundedJson = parseBoundedImportJson;
