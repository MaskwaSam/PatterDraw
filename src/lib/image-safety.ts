import {
  getBrowserPdfRasterBudget,
  getPdfImportEncodedByteBudget,
  MAX_PDF_ENCODED_PNG_BYTES_PER_PAGE,
  MAX_PDF_RASTER_EDGE,
  MAX_PDF_RASTER_PIXELS_PER_PAGE,
  type PdfRasterBudget,
} from "./pdf/raster-limits";
import { sha256Hex } from "./sha256";

/**
 * A persisted image is decoded by the browser when Excalidraw hydrates a
 * scene. Keep the dimensions and estimated decoded allocation bounded before
 * handing any data URL to an image decoder. These are absolute ceilings. The
 * active limits are derived from the same device-sensitive raster envelope
 * used by PDF import/export (see getLocalImageRasterBudget below).
 */
export const MAX_LOCAL_IMAGE_EDGE = MAX_PDF_RASTER_EDGE;
export const MAX_LOCAL_IMAGE_PIXELS = MAX_PDF_RASTER_PIXELS_PER_PAGE;
export const MAX_LOCAL_IMAGE_DECODED_BYTES = MAX_LOCAL_IMAGE_PIXELS * 4;
export const MAX_LOCAL_IMAGE_ENCODED_BYTES = MAX_PDF_ENCODED_PNG_BYTES_PER_PAGE;
export const MAX_LOCAL_PROJECT_RASTER_PIXELS = 64 * 1024 * 1024;
export const MAX_LOCAL_PROJECT_ENCODED_BYTES = 150 * 1024 * 1024;
export const MAX_LOCAL_SVG_NODES = 100_000;
export const MAX_LOCAL_SVG_COMPLEXITY = 8 * 1024 * 1024;

/** Keep cache retention bounded even when a project contains many images. */
export const MAX_LOCAL_IMAGE_CACHE_ENTRIES = 128;
export const MAX_LOCAL_IMAGE_CACHE_CHARS = 4 * 1024 * 1024;

const MAX_LOCAL_IMAGE_HEADER_BYTES = 1 * 1024 * 1024;
const BASE64_ABORT_CHECK_INTERVAL = 16 * 1024;
const SVG_ABORT_CHECK_INTERVAL = 4 * 1024;
const EXCALIDRAW_SVG_PAYLOAD_MARKER = "payload-type:application/vnd.excalidraw+json";
const EXCALIDRAW_PNG_PAYLOAD_KEYWORD = "application/vnd.excalidraw+json";
const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";

export interface LocalImageRasterBudget {
  maxEdge: number;
  /** Maximum pixel area charged to one Excalidraw file. */
  maxPixelsPerImage: number;
  /** Maximum pixel area charged to all local files in one project. */
  maxPixelsPerProject: number;
  maxDecodedBytesPerImage: number;
  maxEncodedBytesPerImage: number;
  maxEncodedBytesPerProject: number;
  maxSvgComplexityPerImage: number;
}

/** Alias retained for callers that describe this as an image-safety budget. */
export type LocalImageSafetyBudget = LocalImageRasterBudget;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.max(1, Math.floor(value!))
    : fallback;
}

/**
 * Derive local-image limits from the active PDF raster envelope. Every value
 * is also capped by the long-standing local-image ceiling, so a caller cannot
 * accidentally make restored classroom content less bounded than before.
 */
export function getLocalImageRasterBudget(
  rasterBudget: Readonly<PdfRasterBudget> = getBrowserPdfRasterBudget(),
): Readonly<LocalImageRasterBudget> {
  const maxEdge = Math.min(
    MAX_LOCAL_IMAGE_EDGE,
    positiveInteger(rasterBudget.maxEdge, MAX_LOCAL_IMAGE_EDGE),
  );
  const pagePixels = positiveInteger(rasterBudget.maxPixelsPerPage, MAX_LOCAL_IMAGE_PIXELS);
  const documentPixels = positiveInteger(rasterBudget.maxPixelsPerDocument, MAX_LOCAL_PROJECT_RASTER_PIXELS);
  const maxPixelsPerImage = Math.max(
    1,
    Math.min(MAX_LOCAL_IMAGE_PIXELS, pagePixels, documentPixels, maxEdge * maxEdge),
  );
  const maxPixelsPerProject = Math.max(
    1,
    Math.min(MAX_LOCAL_PROJECT_RASTER_PIXELS, documentPixels),
  );
  const encodedEnvelope = getPdfImportEncodedByteBudget(rasterBudget);
  const maxEncodedBytesPerImage = Math.max(
    1,
    Math.min(
      MAX_LOCAL_IMAGE_ENCODED_BYTES,
      encodedEnvelope.maxBytesPerPage || MAX_LOCAL_IMAGE_ENCODED_BYTES,
      maxPixelsPerImage * 4,
    ),
  );
  const maxEncodedBytesPerProject = Math.max(
    1,
    Math.min(
      MAX_LOCAL_PROJECT_ENCODED_BYTES,
      encodedEnvelope.maxBytesPerDocument || MAX_LOCAL_PROJECT_ENCODED_BYTES,
      maxPixelsPerProject * 4,
    ),
  );
  return Object.freeze({
    maxEdge,
    maxPixelsPerImage,
    maxPixelsPerProject,
    maxDecodedBytesPerImage: maxPixelsPerImage * 4,
    maxEncodedBytesPerImage,
    maxEncodedBytesPerProject,
    maxSvgComplexityPerImage: Math.max(
      1,
      Math.min(MAX_LOCAL_SVG_COMPLEXITY, maxEncodedBytesPerImage),
    ),
  });
}

/** Naming alias for integrations that use "safety" rather than "raster". */
export const getLocalImageSafetyBudget = getLocalImageRasterBudget;

export interface LocalImageRasterInfo {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
  width: number;
  height: number;
  pixels: number;
  decodedBytes: number;
  encodedBytes: number;
  complexity: number;
}

function normalizedLocalImageMimeType(value: string): LocalImageRasterInfo["mimeType"] | null {
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (
    normalized === "image/png"
    || normalized === "image/jpeg"
    || normalized === "image/gif"
    || normalized === "image/webp"
    || normalized === "image/svg+xml"
  ) return normalized;
  return null;
}

const WRAPPER_OWNED_IMAGE_EXTENSIONS = [".png", ".svg"] as const;
const WRAPPER_OWNED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/svg+xml",
]);

/**
 * Fast routing predicate for the wrapper-owned PNG/SVG drop path.
 *
 * File names and declared MIME types are both caller-controlled metadata, so
 * a match only claims the event for wrapper handling. The bytes must still be
 * passed through inspectLocalImageBlob (and any format-specific sanitization)
 * before decoding or persistence; extension/MIME false positives are expected
 * to be rejected there.
 */
export function isWrapperOwnedImageDrop(file: { name?: string; type?: string }): boolean {
  if (!file || typeof file !== "object") return false;
  const name = typeof file.name === "string" ? file.name.trim().toLowerCase() : "";
  const type = typeof file.type === "string"
    ? file.type.split(";", 1)[0].trim().toLowerCase()
    : "";
  return WRAPPER_OWNED_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension))
    || WRAPPER_OWNED_IMAGE_MIME_TYPES.has(type);
}

/**
 * Return whether a PNG contains Excalidraw's editable-scene text metadata.
 *
 * This intentionally inspects only PNG chunk framing and the reserved text
 * keyword; it does not inflate image data or decode the metadata payload.
 * Native chooser/clipboard files reach this helper before Excalidraw assigns a
 * file ID, so rejecting this one reserved keyword prevents dormant scene data
 * from entering project files while leaving ordinary PNG metadata untouched.
 */
export function hasExcalidrawPngSceneMetadata(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE.charCodeAt(index)) return false;
  }
  const keywordBytes = new TextEncoder().encode(EXCALIDRAW_PNG_PAYLOAD_KEYWORD);
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const chunkLength = uint32be(bytes, offset);
    if (chunkLength > bytes.length - offset - 12) return false;
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const isTextChunk = (
      bytes[typeOffset] === 0x74 && bytes[typeOffset + 1] === 0x45
      && bytes[typeOffset + 2] === 0x58 && bytes[typeOffset + 3] === 0x74
    ) || (
      bytes[typeOffset] === 0x7a && bytes[typeOffset + 1] === 0x54
      && bytes[typeOffset + 2] === 0x58 && bytes[typeOffset + 3] === 0x74
    ) || (
      bytes[typeOffset] === 0x69 && bytes[typeOffset + 1] === 0x54
      && bytes[typeOffset + 2] === 0x58 && bytes[typeOffset + 3] === 0x74
    );
    if (isTextChunk) {
      let keywordEnd = dataOffset;
      while (keywordEnd < dataEnd && bytes[keywordEnd] !== 0) keywordEnd += 1;
      if (
        keywordEnd < dataEnd
        && keywordEnd - dataOffset === keywordBytes.length
        && keywordBytes.every((value, index) => bytes[dataOffset + index] === value)
      ) {
        return true;
      }
    }
    const isIend = bytes[typeOffset] === 0x49
      && bytes[typeOffset + 1] === 0x45
      && bytes[typeOffset + 2] === 0x4e
      && bytes[typeOffset + 3] === 0x44;
    offset += 12 + chunkLength;
    if (isIend) break;
  }
  return false;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function assertPositiveDimensions(
  width: number,
  height: number,
  budget: Readonly<LocalImageRasterBudget>,
): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > budget.maxEdge
    || height > budget.maxEdge
  ) {
    throw new Error("A persisted image has unsupported dimensions.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > budget.maxPixelsPerImage) {
    throw new Error("A persisted image is too large to decode safely.");
  }
}

function base64Bytes(
  value: string,
  requestedMaxBytes = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): Uint8Array {
  if (value.length > MAX_LOCAL_IMAGE_ENCODED_BYTES * 4 / 3 + 8) {
    throw new Error("A persisted image is too large to decode safely.");
  }
  const outputLength = Math.floor(value.length * 3 / 4)
    - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (!Number.isSafeInteger(outputLength) || outputLength <= 0) {
    throw new Error("A persisted image has invalid local data.");
  }
  if (Number.isFinite(requestedMaxBytes) && outputLength > requestedMaxBytes) {
    // A header read may intentionally request a bounded prefix; callers that
    // need complete bytes pass a limit at least as large as outputLength.
    if (requestedMaxBytes <= MAX_LOCAL_IMAGE_HEADER_BYTES) {
      // Continue below with a truncated output for the header parser.
    } else {
      throw new Error("A persisted image is too large to decode safely.");
    }
  }
  const output = new Uint8Array(Math.min(outputLength, requestedMaxBytes));
  // Avoid relying on Node's Buffer. This module also runs in the static
  // browser bundle and only accepts the standard (non-URL) base64 alphabet.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (index % BASE64_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    const char = value[index];
    if (char === "=") break;
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("A persisted image has invalid local data.");
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (offset < output.length) output[offset] = (accumulator >>> bits) & 0xff;
      offset += 1;
    }
  }
  throwIfAborted(signal);
  if (output.length === outputLength && offset !== output.length) {
    throw new Error("A persisted image has invalid local data.");
  }
  return output;
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number, signal?: AbortSignal): string {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    if (index % SVG_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    result += String.fromCharCode(bytes[offset + index]);
  }
  return result;
}

function imageInfo(
  mimeType: LocalImageRasterInfo["mimeType"],
  width: number,
  height: number,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  complexity = encodedBytes,
): LocalImageRasterInfo {
  assertPositiveDimensions(width, height, budget);
  const pixels = width * height;
  const decodedBytes = pixels * 4;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > budget.maxDecodedBytesPerImage) {
    throw new Error("A persisted image is too large to decode safely.");
  }
  if (
    !Number.isSafeInteger(encodedBytes)
    || encodedBytes <= 0
    || encodedBytes > budget.maxEncodedBytesPerImage
    || (mimeType === "image/svg+xml" && complexity > budget.maxSvgComplexityPerImage)
  ) {
    throw new Error("A persisted image is too large to decode safely.");
  }
  return {
    mimeType,
    width,
    height,
    pixels,
    decodedBytes,
    encodedBytes,
    complexity,
  };
}

function parsePng(
  bytes: Uint8Array,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  signal?: AbortSignal,
): LocalImageRasterInfo {
  if (
    bytes.length < 24
    || ascii(bytes, 0, 8, signal) !== "\x89PNG\r\n\x1a\n"
    || ascii(bytes, 12, 4, signal) !== "IHDR"
  ) throw new Error("A persisted image has invalid local data.");
  const width = uint32be(bytes, 16);
  const height = uint32be(bytes, 20);
  return imageInfo("image/png", width, height, encodedBytes, budget, bytes.length);
}

function parseGif(
  bytes: Uint8Array,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  signal?: AbortSignal,
): LocalImageRasterInfo {
  if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6, signal))) {
    throw new Error("A persisted image has invalid local data.");
  }
  return imageInfo("image/gif", uint16le(bytes, 6), uint16le(bytes, 8), encodedBytes, budget, bytes.length);
}

function parseJpeg(
  bytes: Uint8Array,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  signal?: AbortSignal,
): LocalImageRasterInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("A persisted image has invalid local data.");
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (offset % SVG_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    if (bytes[offset] !== 0xff) throw new Error("A persisted image has invalid local data.");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (!Number.isSafeInteger(length) || length < 2 || offset + length > bytes.length) {
      throw new Error("A persisted image has invalid local data.");
    }
    const isFrame = (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);
    if (isFrame) {
      if (length < 7) throw new Error("A persisted image has invalid local data.");
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return imageInfo("image/jpeg", width, height, encodedBytes, budget, bytes.length);
    }
    if (marker === 0xda || marker === 0xd9) break;
    offset += length;
  }
  throwIfAborted(signal);
  throw new Error("A persisted image has invalid local data.");
}

function findByte(bytes: Uint8Array, value: number, start: number, signal?: AbortSignal): number {
  for (let index = start; index < bytes.length; index += 1) {
    if ((index - start) % SVG_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    if (bytes[index] === value) return index;
  }
  return -1;
}

function parseWebp(
  bytes: Uint8Array,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  signal?: AbortSignal,
): LocalImageRasterInfo {
  if (bytes.length < 30 || ascii(bytes, 0, 4, signal) !== "RIFF" || ascii(bytes, 8, 4, signal) !== "WEBP") {
    throw new Error("A persisted image has invalid local data.");
  }
  const kind = ascii(bytes, 12, 4, signal);
  if (kind === "VP8X") {
    return imageInfo("image/webp", uint24le(bytes, 24) + 1, uint24le(bytes, 27) + 1, encodedBytes, budget, bytes.length);
  }
  if (kind === "VP8 ") {
    const frame = findByte(bytes, 0x9d, 20, signal);
    if (frame < 0 || frame + 6 >= bytes.length || bytes[frame + 1] !== 0x01 || bytes[frame + 2] !== 0x2a) {
      throw new Error("A persisted image has invalid local data.");
    }
    return imageInfo("image/webp", uint16le(bytes, frame + 3) & 0x3fff, uint16le(bytes, frame + 5) & 0x3fff, encodedBytes, budget, bytes.length);
  }
  if (kind === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return imageInfo("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, encodedBytes, budget, bytes.length);
  }
  throw new Error("A persisted image has invalid local data.");
}

function scanSvgNodes(source: string, signal?: AbortSignal): { nodeCount: number; animationCount: number } {
  let nodeCount = 0;
  let animationCount = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (index % SVG_ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    if (source[index] !== "<") continue;
    let cursor = index + 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] === "/" || source[cursor] === "!" || source[cursor] === "?") continue;
    const start = cursor;
    while (cursor < source.length && /[A-Za-z]/.test(source[cursor])) cursor += 1;
    if (cursor === start) continue;
    nodeCount += 1;
    const tag = source.slice(start, cursor).toLowerCase();
    if (tag === "animate" || tag === "animatetransform" || tag === "animatemotion" || tag === "set") {
      animationCount += 1;
    }
  }
  return { nodeCount, animationCount };
}

function assertSafeSvgResources(source: string, signal?: AbortSignal): void {
  throwIfAborted(signal);
  const withoutNamespaceDeclarations = source.replace(
    /\bxmlns(?::[a-z][\w.-]*)?\s*=\s*["'][^"']*["']/gi,
    "",
  );
  // Namespace declarations are the only expected URLs in generated local
  // SVG. Everything else must remain self-contained and inert.
  if (
    /<\s*(?:script|foreignObject|iframe|object|embed|image)\b/i.test(source)
    || /(?:https?:|file:|javascript:|data:|blob:|ftp:|\/\/)/i.test(withoutNamespaceDeclarations)
    || /(?:xlink:href|href|src)\s*=/i.test(source)
    || /@import\b/i.test(source)
  ) {
    throw new Error("A persisted SVG contains an external or active resource.");
  }

  // Permit only the unquoted fragment form used by generated masks. In
  // particular, quoted CSS url("...") is rejected, including quoted local
  // fragments, because browser CSS parsers accept several escaping variants.
  const cssUrlPattern = /url\s*\(\s*([^)]*?)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = cssUrlPattern.exec(source))) {
    throwIfAborted(signal);
    const reference = match[1].trim();
    if (!/^#[A-Za-z][\w:.-]*$/.test(reference) || /^["']/.test(reference)) {
      throw new Error("A persisted SVG contains an external or active resource.");
    }
  }
}

function parseSvg(
  bytes: Uint8Array,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  signal?: AbortSignal,
): LocalImageRasterInfo {
  if (bytes.length > MAX_LOCAL_SVG_COMPLEXITY) {
    throw new Error("A persisted SVG is too complex to render safely.");
  }
  throwIfAborted(signal);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  throwIfAborted(signal);
  if (!/^\s*<\?xml[^>]*>\s*<\s*svg\b/i.test(source) && !/^\s*<\s*svg\b/i.test(source)) {
    throw new Error("A persisted SVG has an invalid root element.");
  }
  assertSafeSvgResources(source, signal);
  const { nodeCount, animationCount } = scanSvgNodes(source, signal);
  if (
    nodeCount > MAX_LOCAL_SVG_NODES
    || animationCount > 256
    || bytes.length + nodeCount * 256 > MAX_LOCAL_SVG_COMPLEXITY
    || bytes.length + nodeCount * 256 > budget.maxSvgComplexityPerImage
  ) {
    throw new Error("A persisted SVG is too complex to render safely.");
  }
  const root = source.match(/<\s*svg\b([^>]*)>/i)?.[1] || "";
  const readDimension = (name: string): number | undefined => {
    const match = root.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"));
    const value = match ? Number(match[1]) : undefined;
    return Number.isFinite(value) && (value ?? 0) > 0 ? Math.ceil(value!) : undefined;
  };
  const viewBox = root.match(/\bviewBox\s*=\s*["']\s*([0-9.+-]+)[\s,]+([0-9.+-]+)[\s,]+([0-9.+-]+)[\s,]+([0-9.+-]+)/i);
  const width = readDimension("width") ?? (viewBox ? Math.ceil(Number(viewBox[3])) : 300);
  const height = readDimension("height") ?? (viewBox ? Math.ceil(Number(viewBox[4])) : 150);
  throwIfAborted(signal);
  return imageInfo("image/svg+xml", width, height, encodedBytes, budget, bytes.length + nodeCount * 256);
}

function parseImageBytes(
  mimeType: LocalImageRasterInfo["mimeType"],
  bytes: Uint8Array,
  encodedBytes: number,
  budget: Readonly<LocalImageRasterBudget>,
  signal?: AbortSignal,
): LocalImageRasterInfo {
  if (mimeType === "image/png") return parsePng(bytes, encodedBytes, budget, signal);
  if (mimeType === "image/jpeg") return parseJpeg(bytes, encodedBytes, budget, signal);
  if (mimeType === "image/gif") return parseGif(bytes, encodedBytes, budget, signal);
  if (mimeType === "image/webp") return parseWebp(bytes, encodedBytes, budget, signal);
  return parseSvg(bytes, encodedBytes, budget, signal);
}

function parseDataUrl(value: string): { normalized: string; mimeType: LocalImageRasterInfo["mimeType"]; payload: string } {
  const normalized = value.trim();
  const match = /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml));base64,([a-z\d+/]*={0,2})$/i.exec(normalized);
  if (!match || !match[2] || match[2].length % 4 !== 0) {
    throw new Error("A persisted image has missing or unsafe local data.");
  }
  const mimeType = match[1].toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : match[1].toLowerCase() as LocalImageRasterInfo["mimeType"];
  return { normalized, mimeType, payload: match[2] };
}

/**
 * Pinned Excalidraw resizes GIFs through a canvas. Browsers encode that canvas
 * as PNG, but the upstream File wrapper retains image/gif. Normalize this one
 * known local encoder mismatch before persistence so the file can be safely
 * preflighted and reopened. Genuine GIF data remains untouched.
 */
export function canonicalizeCanvasEncodedGifDataUrl(value: string): string {
  let parsed;
  try {
    parsed = parseDataUrl(value);
  } catch {
    return value;
  }
  if (parsed.mimeType !== "image/gif") return parsed.normalized;
  const header = base64Bytes(parsed.payload, PNG_SIGNATURE.length);
  const isPng = header.length === PNG_SIGNATURE.length
    && [...PNG_SIGNATURE].every((character, index) => header[index] === character.charCodeAt(0));
  return isPng ? `data:image/png;base64,${parsed.payload}` : parsed.normalized;
}

interface LocalImageCacheEntry {
  info: LocalImageRasterInfo;
  chars: number;
}

const localImageCache = new Map<string, LocalImageCacheEntry>();
let localImageCacheChars = 0;

/** Test/support hook; production callers rely on bounded LRU eviction. */
export function clearLocalImageSafetyCache(): void {
  localImageCache.clear();
  localImageCacheChars = 0;
}

function cachedImageInfo(value: string, budget: Readonly<LocalImageRasterBudget>): LocalImageRasterInfo | undefined {
  const entry = localImageCache.get(value);
  if (!entry) return undefined;
  localImageCache.delete(value);
  localImageCache.set(value, entry);
  assertLocalImageRasterInfoWithinBudget(entry.info, budget);
  return entry.info;
}

function cacheImageInfo(value: string, info: LocalImageRasterInfo): void {
  // Do not retain a multi-megabyte data URL solely because a project was
  // opened once. The project itself remains the immutable content identity.
  if (value.length > MAX_LOCAL_IMAGE_CACHE_CHARS) return;
  const previous = localImageCache.get(value);
  if (previous) {
    localImageCacheChars -= previous.chars;
    localImageCache.delete(value);
  }
  localImageCache.set(value, { info, chars: value.length });
  localImageCacheChars += value.length;
  while (
    localImageCache.size > MAX_LOCAL_IMAGE_CACHE_ENTRIES
    || localImageCacheChars > MAX_LOCAL_IMAGE_CACHE_CHARS
  ) {
    const oldest = localImageCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const removed = localImageCache.get(oldest);
    localImageCache.delete(oldest);
    localImageCacheChars -= removed?.chars ?? 0;
  }
}

/** Validate an already-inspected image against a possibly lower-memory budget. */
export function assertLocalImageRasterInfoWithinBudget(
  info: LocalImageRasterInfo,
  budget: Readonly<LocalImageRasterBudget> = getLocalImageRasterBudget(),
): void {
  if (
    info.width > budget.maxEdge
    || info.height > budget.maxEdge
    || info.pixels > budget.maxPixelsPerImage
    || info.decodedBytes > budget.maxDecodedBytesPerImage
    || info.encodedBytes > budget.maxEncodedBytesPerImage
    || (info.mimeType === "image/svg+xml" && info.complexity > budget.maxSvgComplexityPerImage)
  ) {
    throw new Error("A persisted image is too large to decode safely.");
  }
}

export interface LocalImageInspectionOptions {
  signal?: AbortSignal;
  rasterBudget?: Readonly<PdfRasterBudget>;
}

function inspectionOptions(
  signalOrOptions?: AbortSignal | LocalImageInspectionOptions,
  rasterBudget?: Readonly<PdfRasterBudget>,
): LocalImageInspectionOptions {
  if (signalOrOptions && "aborted" in signalOrOptions) {
    return { signal: signalOrOptions as AbortSignal, rasterBudget };
  }
  return { ...(signalOrOptions as LocalImageInspectionOptions | undefined), rasterBudget };
}

/**
 * Validate an image's encoded bytes and intrinsic decoded dimensions without
 * fetching a URL. Header inspection happens before createImageBitmap so a
 * decompression bomb is rejected before the browser allocates its bitmap.
 */
export async function inspectLocalImageDataUrl(
  value: string,
  signalOrOptions?: AbortSignal | LocalImageInspectionOptions,
  rasterBudgetOverride?: Readonly<PdfRasterBudget>,
): Promise<LocalImageRasterInfo> {
  const options = inspectionOptions(signalOrOptions, rasterBudgetOverride);
  const signal = options.signal;
  const budget = getLocalImageRasterBudget(options.rasterBudget);
  throwIfAborted(signal);
  const { normalized, mimeType, payload } = parseDataUrl(value);
  const cached = cachedImageInfo(normalized, budget);
  if (cached) {
    throwIfAborted(signal);
    return cached;
  }
  const encodedBytes = Math.floor(payload.length * 3 / 4)
    - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes <= 0 || encodedBytes > budget.maxEncodedBytesPerImage) {
    throw new Error("A persisted image is too large to decode safely.");
  }
  // Reject oversized SVG payloads from their base64 length before allocating
  // and decoding the complete XML string. The SVG complexity ceiling is
  // intentionally lower than the general raster byte ceiling.
  if (mimeType === "image/svg+xml" && encodedBytes > budget.maxSvgComplexityPerImage) {
    throw new Error("A persisted SVG is too complex to render safely.");
  }
  const headerBytes = mimeType === "image/svg+xml"
    ? base64Bytes(payload, budget.maxEncodedBytesPerImage, signal)
    : base64Bytes(payload, Math.min(MAX_LOCAL_IMAGE_HEADER_BYTES, budget.maxEncodedBytesPerImage), signal);
  const completePngBytes = mimeType === "image/png"
    ? base64Bytes(payload, budget.maxEncodedBytesPerImage, signal)
    : undefined;
  if (completePngBytes && hasExcalidrawPngSceneMetadata(completePngBytes)) {
    throw new Error("The local PNG contains unsupported embedded scene data.");
  }
  if (
    mimeType === "image/svg+xml"
    && new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)
      .includes(EXCALIDRAW_SVG_PAYLOAD_MARKER)
  ) {
    throw new Error("The local SVG contains unsupported embedded scene data.");
  }
  const info = parseImageBytes(mimeType, headerBytes, encodedBytes, budget, signal);
  throwIfAborted(signal);

  // Raster decoders stay local: Blob bytes are never passed to fetch or a
  // network URL. SVGs are checked for external references before returning.
  if (mimeType !== "image/svg+xml" && typeof globalThis.createImageBitmap === "function") {
    const bytes = completePngBytes ?? base64Bytes(payload, budget.maxEncodedBytesPerImage, signal);
    const blobBytes = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const bitmapPromise = globalThis.createImageBitmap(new Blob([blobBytes], { type: mimeType }));
    let racedBitmap: ImageBitmap;
    let onAbort: (() => void) | undefined;
    try {
      const result = signal
        ? await Promise.race([
          bitmapPromise,
          new Promise<ImageBitmap>((_, reject) => {
            onAbort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
            signal.addEventListener("abort", onAbort!, { once: true });
          }),
        ])
        : await bitmapPromise;
      racedBitmap = result;
    } catch (error) {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) void bitmapPromise.then((lateBitmap) => lateBitmap.close(), () => undefined);
      throw error;
    }
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    try {
      throwIfAborted(signal);
      if (racedBitmap.width !== info.width || racedBitmap.height !== info.height) {
        throw new Error("A persisted image has invalid decoded dimensions.");
      }
    } finally {
      racedBitmap.close();
    }
  }
  throwIfAborted(signal);
  cacheImageInfo(normalized, info);
  return info;
}

/**
 * Preflight a native chooser/paste/drop Blob before Excalidraw decodes or
 * resizes it. Raster formats need only a bounded header read; SVG requires its
 * complete, size-capped source so active resources can be rejected first.
 */
export async function inspectLocalImageBlob(
  blob: Blob,
  signalOrOptions?: AbortSignal | LocalImageInspectionOptions,
  rasterBudgetOverride?: Readonly<PdfRasterBudget>,
): Promise<LocalImageRasterInfo> {
  const options = inspectionOptions(signalOrOptions, rasterBudgetOverride);
  const signal = options.signal;
  const budget = getLocalImageRasterBudget(options.rasterBudget);
  throwIfAborted(signal);
  const mimeType = normalizedLocalImageMimeType(blob.type);
  if (!mimeType) {
    throw new Error("PatterDraw supports PNG, JPEG, GIF, WebP, and safe SVG images.");
  }
  const encodedBytes = blob.size;
  if (
    !Number.isSafeInteger(encodedBytes)
    || encodedBytes <= 0
    || encodedBytes > budget.maxEncodedBytesPerImage
  ) {
    throw new Error("The local image is too large to decode safely.");
  }
  if (mimeType === "image/svg+xml" && encodedBytes > budget.maxSvgComplexityPerImage) {
    throw new Error("The local SVG is too complex to render safely.");
  }
  const bytesToRead = mimeType === "image/svg+xml"
    ? encodedBytes
    : Math.min(encodedBytes, MAX_LOCAL_IMAGE_HEADER_BYTES);
  const bytes = new Uint8Array(await blob.slice(0, bytesToRead).arrayBuffer());
  throwIfAborted(signal);
  return parseImageBytes(mimeType, bytes, encodedBytes, budget, signal);
}

/** Re-encode a preflighted local raster onto a transparent PNG canvas. */
export async function rasterizeLocalImageToPngForInsertion(
  source: Blob,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);
  if (!new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]).has(source.type)) {
    throw new Error("The local image cannot be prepared as a PNG.");
  }
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  let drawable: CanvasImageSource;
  let releaseDrawable: () => void;
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(source);
    drawable = bitmap;
    releaseDrawable = () => bitmap.close();
  } else {
    if (
      typeof Image !== "function"
      || typeof URL?.createObjectURL !== "function"
      || typeof URL?.revokeObjectURL !== "function"
    ) {
      throw new Error("This browser cannot prepare the local image.");
    }
    const objectUrl = URL.createObjectURL(source);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          image.onload = null;
          image.onerror = null;
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => {
          image.src = "";
          finish(signal?.reason instanceof Error ? signal.reason : abortError());
        };
        image.onload = () => finish();
        image.onerror = () => finish(new Error("This browser could not prepare the local image."));
        signal?.addEventListener("abort", onAbort, { once: true });
        image.src = objectUrl;
      });
      throwIfAborted(signal);
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    drawable = image;
    releaseDrawable = () => {
      image.src = "";
      URL.revokeObjectURL(objectUrl);
    };
  }
  try {
    throwIfAborted(signal);
    const canvas = document.createElement("canvas");
    canvas.width = safeWidth;
    canvas.height = safeHeight;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("This browser cannot prepare the local image.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, safeWidth, safeHeight);
    context.drawImage(drawable, 0, 0, safeWidth, safeHeight);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("This browser could not prepare the local image."));
      }, "image/png");
    });
    throwIfAborted(signal);
    return blob;
  } finally {
    releaseDrawable();
  }
}

/**
 * Re-encode a preflighted PNG while preserving transparency and stripping
 * embedded scene metadata before the bytes enter the classroom project.
 */
export async function rasterizeLocalPngForInsertion(
  source: Blob,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Blob> {
  if (source.type !== "image/png") throw new Error("The local image is not a PNG.");
  return rasterizeLocalImageToPngForInsertion(source, width, height, signal);
}

/**
 * Preserve a safe SVG as vector artwork while removing Excalidraw's embedded
 * scene payload. The payload is not needed for an inserted classroom image
 * and could otherwise become a dormant project/import bypass later.
 */
export async function stripExcalidrawSvgSceneMetadata(
  source: Blob,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);
  if (normalizedLocalImageMimeType(source.type) !== "image/svg+xml") {
    throw new Error("The local image is not an SVG.");
  }
  const text = await source.text();
  throwIfAborted(signal);
  if (!text.includes(EXCALIDRAW_SVG_PAYLOAD_MARKER)) return source;
  if (typeof DOMParser !== "function" || typeof XMLSerializer !== "function") {
    throw new Error("This browser cannot safely prepare the local SVG.");
  }
  const document = new DOMParser().parseFromString(text, "image/svg+xml");
  if (document.querySelector("parsererror")) {
    throw new Error("The local SVG has invalid XML.");
  }
  let removed = false;
  for (const metadata of Array.from(document.getElementsByTagName("metadata"))) {
    const serialized = new XMLSerializer().serializeToString(metadata);
    if (!serialized.includes(EXCALIDRAW_SVG_PAYLOAD_MARKER)) continue;
    metadata.remove();
    removed = true;
  }
  const sanitized = new XMLSerializer().serializeToString(document.documentElement);
  if (!removed || sanitized.includes(EXCALIDRAW_SVG_PAYLOAD_MARKER)) {
    throw new Error("The local SVG contains unsupported embedded scene data.");
  }
  const result = new Blob([sanitized], { type: "image/svg+xml" });
  await inspectLocalImageBlob(result, signal);
  return result;
}

/**
 * Shared Excalidraw generateIdForFile hook. The preflight runs before its
 * bitmap decoder, and the canonical MIME participates in the ID so identical
 * bytes declared as different formats cannot reuse stale file metadata.
 */
export async function generateSafeLocalImageFileId(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  const info = await inspectLocalImageBlob(file, signal);
  throwIfAborted(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  if (info.mimeType === "image/png" && hasExcalidrawPngSceneMetadata(bytes)) {
    throw new Error("The local PNG contains unsupported embedded scene data.");
  }
  if (
    info.mimeType === "image/svg+xml"
    && new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      .includes(EXCALIDRAW_SVG_PAYLOAD_MARKER)
  ) {
    throw new Error("The local SVG contains unsupported embedded scene data.");
  }
  const contentDigest = await sha256Hex(bytes);
  throwIfAborted(signal);
  return sha256Hex(new TextEncoder().encode(`${info.mimeType}\0${contentDigest}`));
}

export function assertLocalProjectRasterBudget(
  info: LocalImageRasterInfo,
  totals: { encodedBytes: number; pixels: number },
  rasterBudget: Readonly<PdfRasterBudget> = getBrowserPdfRasterBudget(),
): { encodedBytes: number; pixels: number } {
  const budget = getLocalImageRasterBudget(rasterBudget);
  assertLocalImageRasterInfoWithinBudget(info, budget);
  const encodedBytes = totals.encodedBytes + info.encodedBytes;
  const pixels = totals.pixels + info.pixels;
  if (
    !Number.isSafeInteger(encodedBytes)
    || !Number.isSafeInteger(pixels)
    || encodedBytes > budget.maxEncodedBytesPerProject
    || pixels > budget.maxPixelsPerProject
  ) {
    throw new Error("The project's persisted images are too large to decode safely.");
  }
  return { encodedBytes, pixels };
}
