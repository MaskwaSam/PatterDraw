import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import { Unzlib } from "fflate";
import { MAX_PDF_PAGES } from "../safety";

interface ImageLimitCacheState {
  /** Successful validations retained as a Pareto frontier of constraints. */
  validated: ImageLimitConstraint[];
  /** Pending checks are deduplicated only for identical constraints. */
  pending: Map<string, PendingImageLimitValidation>;
}

interface ImageLimitConstraint {
  maxPixels: number;
  maxEdge?: number;
  maxTotalPixels: number;
  maxTotalEncodedBytes: number;
}

interface PendingImageLimitValidation {
  controller: AbortController;
  persistent: boolean;
  promise: Promise<void>;
  subscribers: number;
}

interface ContentToken {
  bytes?: Uint8Array;
  end: number;
  kind: "name" | "other" | "string" | "word";
  value: string;
}

type ResourceScope = readonly PDFDict[];

interface ActiveFontState {
  /** A resolved font dictionary when PDF.js has already loaded the font. */
  font?: PDFDict;
  /** The resource name is retained when the font could not be resolved yet. */
  resourceName?: string;
  /** Resources used as the Type 3 font's fallback environment. */
  resources: ResourceScope;
}

interface ContentResourceUsage {
  extGStates: Set<string>;
  fonts: Map<string, Set<number>>;
  /** Resolved fonts, keyed by the actual font object and fallback resources. */
  fontObjects: Map<PDFDict, Map<ResourceScope, Set<number>>>;
  patterns: Set<string>;
  xObjects: Set<string>;
  /** Font state observed at each XObject invocation (for Form inheritance). */
  xObjectFonts: Map<string, Map<PDFDict | string | null, Set<ResourceScope>>>;
  /** Font state observed at each ExtGState invocation (for soft-mask Forms). */
  extGStateFonts: Map<string, Map<PDFDict | string | null, Set<ResourceScope>>>;
}

interface InspectionContext {
  activeStreams: WeakSet<PDFStream>;
  /** Image XObjects may be painted repeatedly; charge each stream once. */
  inspectedImages: WeakSet<PDFStream>;
  embeddedImagePixels: number;
  embeddedImageBytes: number;
  decodedContentBytes: number;
  inspectedStreams: number;
  resourceNameCount: number;
  maxEmbeddedImagePixels: number;
  maxEmbeddedImageBytes: number;
  signal?: AbortSignal;
}

export interface PdfEmbeddedImageLimitOptions {
  /** Verified SHA-256 for immutable, wrapper-owned PDF bytes. */
  immutableSha256?: string;
  /** Optional per-dimension image edge limit. */
  maxEdge?: number;
  /** Optional cumulative decoded-pixel budget for all embedded images. */
  maxTotalPixels?: number;
  /** Optional cumulative encoded-byte budget for all embedded images. */
  maxTotalEncodedBytes?: number;
  signal?: AbortSignal;
}

const validatedImageLimits = new Map<string, ImageLimitCacheState>();
const MAX_VALIDATED_PDF_CACHE_ENTRIES = 32;
const MAX_VALIDATED_CONSTRAINTS_PER_PDF = 16;
export const MAX_PDF_DECODED_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_PDF_DECODED_CONTENT_BYTES_PER_DOCUMENT = 32 * 1024 * 1024;
const FLATE_INPUT_CHUNK_BYTES = 1_024;
const CANCELLATION_YIELD_BYTES = 256 * 1_024;
const MAX_PDF_CONTENT_TOKEN_BYTES = 1024 * 1024;
const MAX_PDF_RESOURCE_DEPTH = 256;
const MAX_PDF_INSPECTED_STREAMS = 4_096;
const MAX_PDF_EMBEDDED_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_PDF_EMBEDDED_IMAGE_BYTES = 75 * 1024 * 1024;

interface EffectiveImageLimitBudget {
  maxTotalPixels: number;
  maxTotalEncodedBytes: number;
}

function effectiveImageLimitBudget(
  options: Pick<PdfEmbeddedImageLimitOptions, "maxTotalPixels" | "maxTotalEncodedBytes">,
): EffectiveImageLimitBudget {
  const requestedPixels = options.maxTotalPixels;
  const requestedBytes = options.maxTotalEncodedBytes;
  if (
    requestedPixels !== undefined
    && (!Number.isSafeInteger(requestedPixels) || requestedPixels < 0)
  ) {
    throw new Error("The PDF embedded-image cumulative pixel limit is invalid.");
  }
  if (
    requestedBytes !== undefined
    && (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0)
  ) {
    throw new Error("The PDF embedded-image cumulative byte limit is invalid.");
  }
  return {
    maxTotalPixels: Math.min(
      MAX_PDF_EMBEDDED_IMAGE_PIXELS,
      requestedPixels ?? MAX_PDF_EMBEDDED_IMAGE_PIXELS,
    ),
    maxTotalEncodedBytes: Math.min(
      MAX_PDF_EMBEDDED_IMAGE_BYTES,
      requestedBytes ?? MAX_PDF_EMBEDDED_IMAGE_BYTES,
    ),
  };
}
/**
 * Keep content scanning's graphics-state model bounded independently from
 * the recursive resource graph. PDF.js restores the complete text state,
 * including the active font, for each q/Q pair.
 */
export const MAX_PDF_GRAPHICS_STATE_DEPTH = 256;
/**
 * A content stream can name resources without ever resolving them. Bound the
 * distinct names and resolved font-state bindings retained by the scanner so
 * a legal-sized stream cannot turn into an unbounded Set/Map allocation before
 * resource resolution.
 */
export const MAX_PDF_RESOURCE_NAMES = 65_536;
const SUBTYPE = PDFName.of("Subtype");
const IMAGE = "/Image";
const FORM = "/Form";
const TYPE3 = "/Type3";
const WIDTH = PDFName.of("Width");
const WIDTH_SHORT = PDFName.of("W");
const HEIGHT = PDFName.of("Height");
const HEIGHT_SHORT = PDFName.of("H");
const BITS_PER_COMPONENT = PDFName.of("BitsPerComponent");
const BITS_PER_COMPONENT_SHORT = PDFName.of("BPC");
const COLOR_SPACE = PDFName.of("ColorSpace");
const COLOR_SPACE_SHORT = PDFName.of("CS");
const IMAGE_MASK = PDFName.of("ImageMask");
const IMAGE_MASK_SHORT = PDFName.of("IM");
const RESOURCES = PDFName.of("Resources");
const XOBJECT = PDFName.of("XObject");
const PATTERN = PDFName.of("Pattern");
const FONT = PDFName.of("Font");
const CHAR_PROCS = PDFName.of("CharProcs");
const EXT_G_STATE = PDFName.of("ExtGState");
const SOFT_MASK = PDFName.of("SMask");
const MASK = PDFName.of("Mask");
const GROUP = PDFName.of("G");
const APPEARANCE = PDFName.of("AP");
const NORMAL_APPEARANCE = PDFName.of("N");
const APPEARANCE_STATE = PDFName.of("AS");
const FLAGS = PDFName.of("F");
const FILTER = PDFName.of("Filter");
const DECODE_PARMS = PDFName.of("DecodeParms");
const PREDICTOR = PDFName.of("Predictor");
const ENCODING = PDFName.of("Encoding");
const DIFFERENCES = PDFName.of("Differences");
// PDF.js renders an annotation with the Invisible bit when it has an explicit
// appearance. Only Hidden and NoView reliably suppress screen rendering.
const HIDDEN_ANNOTATION_FLAGS = 2 | 32;
const FLATE_FILTERS = new Set(["/Fl", "/FlateDecode"]);
const ASCII_85_FILTERS = new Set(["/A85", "/ASCII85Decode"]);
const ASCII_HEX_FILTERS = new Set(["/AHx", "/ASCIIHexDecode"]);
const LZW_FILTERS = new Set(["/LZW", "/LZWDecode"]);
const RUN_LENGTH_FILTERS = new Set(["/RL", "/RunLengthDecode"]);
const BROTLI_FILTERS = new Set(["/BrotliDecode"]);
const DCT_FILTERS = new Set(["/DCT", "/DCTDecode"]);
const JPX_FILTERS = new Set(["/JPX", "/JPXDecode"]);
const OPAQUE_IMAGE_FILTERS = new Set([
  ...DCT_FILTERS,
  ...JPX_FILTERS,
  "/JBIG2Decode",
  "/CCF",
  "/CCITTFaxDecode",
]);
const MAX_IMAGE_COMPONENTS = 32;
const DEFAULT_IMAGE_COMPONENTS_FALLBACK = 4;
const MAX_IMAGE_FILTER_DECODE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_FILTER_BUDGET_BYTES_PER_PIXEL = 8;
const MIN_IMAGE_FILTER_BUDGET_BYTES = 64 * 1024;
/**
 * Opaque image decoders can learn dimensions from their payload before
 * PDF.js applies the image dictionary's maxImageSize check. Keep header
 * inspection finite while allowing ordinary metadata and marker segments.
 */
const MAX_OPAQUE_IMAGE_HEADER_BYTES = 1024 * 1024;
const MAX_JPX_BOX_HEADERS = 4_096;
interface PdfContentOperatorArity {
  maxArgs: number;
  variable?: boolean;
}

const PDF_CONTENT_OPERATOR_ARITIES: Readonly<Record<string, PdfContentOperatorArity>> = {
  w: { maxArgs: 1 }, J: { maxArgs: 1 }, j: { maxArgs: 1 }, M: { maxArgs: 1 },
  d: { maxArgs: 2 }, ri: { maxArgs: 1 }, i: { maxArgs: 1 }, gs: { maxArgs: 1 },
  q: { maxArgs: 0 }, Q: { maxArgs: 0 }, cm: { maxArgs: 6 }, m: { maxArgs: 2 },
  l: { maxArgs: 2 }, c: { maxArgs: 6 }, v: { maxArgs: 4 }, y: { maxArgs: 4 },
  h: { maxArgs: 0 }, re: { maxArgs: 4 }, S: { maxArgs: 0 }, s: { maxArgs: 0 },
  f: { maxArgs: 0 }, F: { maxArgs: 0 }, "f*": { maxArgs: 0 }, B: { maxArgs: 0 },
  "B*": { maxArgs: 0 }, b: { maxArgs: 0 }, "b*": { maxArgs: 0 }, n: { maxArgs: 0 },
  W: { maxArgs: 0 }, "W*": { maxArgs: 0 }, BT: { maxArgs: 0 }, ET: { maxArgs: 0 },
  Tc: { maxArgs: 1 }, Tw: { maxArgs: 1 }, Tz: { maxArgs: 1 }, TL: { maxArgs: 1 },
  Tf: { maxArgs: 2 }, Tr: { maxArgs: 1 }, Ts: { maxArgs: 1 }, Td: { maxArgs: 2 },
  TD: { maxArgs: 2 }, Tm: { maxArgs: 6 }, "T*": { maxArgs: 0 }, Tj: { maxArgs: 1 },
  TJ: { maxArgs: 1 }, "'": { maxArgs: 1 }, "\"": { maxArgs: 3 }, d0: { maxArgs: 2 },
  d1: { maxArgs: 6 }, CS: { maxArgs: 1 }, cs: { maxArgs: 1 },
  SC: { maxArgs: 4, variable: true }, SCN: { maxArgs: 33, variable: true },
  sc: { maxArgs: 4, variable: true }, scn: { maxArgs: 33, variable: true },
  G: { maxArgs: 1 }, g: { maxArgs: 1 }, RG: { maxArgs: 3 }, rg: { maxArgs: 3 },
  K: { maxArgs: 4 }, k: { maxArgs: 4 }, sh: { maxArgs: 1 }, BI: { maxArgs: 0 },
  ID: { maxArgs: 0 }, EI: { maxArgs: 1 }, Do: { maxArgs: 1 }, MP: { maxArgs: 1 },
  DP: { maxArgs: 2 }, BMC: { maxArgs: 1 }, BDC: { maxArgs: 2 }, EMC: { maxArgs: 0 },
  BX: { maxArgs: 0 }, EX: { maxArgs: 0 },
};

function embeddedImageLimitError(): Error {
  return new Error(
    "This PDF contains an embedded image that is too large to import safely. Reduce the image resolution and try again.",
  );
}

function contentInspectionError(): Error {
  return new Error("This PDF's page content could not be checked for safe embedded-image sizes.");
}

function imageFilterLimitError(): Error {
  return new Error("This PDF's filtered image data exceeds the safe decoded-byte budget.");
}

function isImageFilterLimitError(error: unknown): boolean {
  return error instanceof Error && error.message === imageFilterLimitError().message;
}

function isWhitespace(byte: number | undefined): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isDelimiter(byte: number | undefined): boolean {
  return byte === 0x28
    || byte === 0x29
    || byte === 0x3c
    || byte === 0x3e
    || byte === 0x5b
    || byte === 0x5d
    || byte === 0x7b
    || byte === 0x7d
    || byte === 0x2f
    || byte === 0x25;
}

function byteString(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) value += String.fromCharCode(bytes[index]);
  return value;
}

function normalizedPdfName(value: string): string {
  let normalized = value;
  // pdf-lib currently decodes uppercase name escapes while parsing, but keeps
  // lowercase escapes as an escaped literal '#'. Decode repeatedly so both
  // representations compare like their PDF name value (for example #6f).
  for (let pass = 0; pass < value.length; pass += 1) {
    const decoded = normalized.replace(/#([0-9a-f]{2})/gi, (_match, hex: string) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    if (decoded === normalized) break;
    normalized = decoded;
  }
  return normalized;
}

function skipSpacingAndComments(bytes: Uint8Array, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < bytes.length) {
    if (offset - initialOffset > MAX_PDF_CONTENT_TOKEN_BYTES) throw contentInspectionError();
    if (isWhitespace(bytes[offset])) {
      offset += 1;
      continue;
    }
    if (bytes[offset] !== 0x25) break;
    while (offset < bytes.length && bytes[offset] !== 10 && bytes[offset] !== 13) offset += 1;
  }
  return offset;
}

function readLiteralString(bytes: Uint8Array, initialOffset: number): Pick<ContentToken, "bytes" | "end"> {
  const decoded = new Uint8Array(Math.min(
    MAX_PDF_CONTENT_TOKEN_BYTES + 1,
    bytes.length - initialOffset - 1,
  ));
  let decodedLength = 0;
  const append = (value: number) => {
    if (decodedLength >= MAX_PDF_CONTENT_TOKEN_BYTES) throw contentInspectionError();
    decoded[decodedLength] = value;
    decodedLength += 1;
  };
  let offset = initialOffset + 1;
  let depth = 1;
  while (offset < bytes.length && depth > 0) {
    if (offset - initialOffset > MAX_PDF_CONTENT_TOKEN_BYTES) throw contentInspectionError();
    const byte = bytes[offset];
    offset += 1;
    if (byte === 0x5c) {
      const escaped = bytes[offset];
      if (escaped === undefined) break;
      if (escaped === 13 || escaped === 10) {
        offset += escaped === 13 && bytes[offset + 1] === 10 ? 2 : 1;
        continue;
      }
      const escapedValues: Record<number, number> = {
        0x62: 0x08,
        0x66: 0x0c,
        0x6e: 0x0a,
        0x72: 0x0d,
        0x74: 0x09,
      };
      if (escaped >= 0x30 && escaped <= 0x37) {
        let octal = escaped - 0x30;
        offset += 1;
        for (let count = 1; count < 3; count += 1) {
          const digit = bytes[offset];
          if (digit === undefined || digit < 0x30 || digit > 0x37) break;
          octal = (octal * 8) + digit - 0x30;
          offset += 1;
        }
        append(octal & 0xff);
      } else {
        append(escapedValues[escaped] ?? escaped);
        offset += 1;
      }
      continue;
    }
    if (byte === 0x28) {
      depth += 1;
      append(byte);
    } else if (byte === 0x29) {
      depth -= 1;
      if (depth > 0) append(byte);
    } else {
      append(byte);
    }
  }
  if (depth !== 0) throw contentInspectionError();
  return { bytes: decoded.subarray(0, decodedLength), end: offset };
}

function readHexString(bytes: Uint8Array, initialOffset: number): Pick<ContentToken, "bytes" | "end"> {
  const decoded = new Uint8Array(Math.min(
    MAX_PDF_CONTENT_TOKEN_BYTES + 1,
    Math.ceil((bytes.length - initialOffset - 1) / 2),
  ));
  let decodedLength = 0;
  let highNibble: number | undefined;
  let offset = initialOffset + 1;
  while (offset < bytes.length && bytes[offset] !== 0x3e) {
    if (offset - initialOffset > MAX_PDF_CONTENT_TOKEN_BYTES) throw contentInspectionError();
    const byte = bytes[offset];
    offset += 1;
    if (isWhitespace(byte)) continue;
    const nibble = byte >= 0x30 && byte <= 0x39
      ? byte - 0x30
      : byte >= 0x41 && byte <= 0x46
        ? byte - 0x41 + 10
        : byte >= 0x61 && byte <= 0x66
          ? byte - 0x61 + 10
          : -1;
    if (nibble < 0) throw contentInspectionError();
    if (highNibble === undefined) highNibble = nibble;
    else {
      decoded[decodedLength] = (highNibble << 4) | nibble;
      decodedLength += 1;
      highNibble = undefined;
    }
  }
  if (bytes[offset] !== 0x3e) throw contentInspectionError();
  if (highNibble !== undefined) {
    decoded[decodedLength] = highNibble << 4;
    decodedLength += 1;
  }
  offset += 1;
  return { bytes: decoded.subarray(0, decodedLength), end: offset };
}

function readContentToken(bytes: Uint8Array, initialOffset: number): ContentToken | null {
  let offset = skipSpacingAndComments(bytes, initialOffset);
  if (offset >= bytes.length) return null;
  if (bytes[offset] === 0x28) {
    const string = readLiteralString(bytes, offset);
    return { ...string, kind: "string", value: "" };
  }
  if (bytes[offset] === 0x3c && bytes[offset + 1] !== 0x3c) {
    const string = readHexString(bytes, offset);
    return { ...string, kind: "string", value: "" };
  }
  if (bytes[offset] === 0x2f) {
    const start = offset;
    offset += 1;
    while (
      offset < bytes.length
      && !isWhitespace(bytes[offset])
      && !isDelimiter(bytes[offset])
    ) {
      if (offset - start > MAX_PDF_CONTENT_TOKEN_BYTES) throw contentInspectionError();
      offset += 1;
    }
    return {
      end: offset,
      kind: "name",
      value: normalizedPdfName(byteString(bytes, start, offset)),
    };
  }
  if (isDelimiter(bytes[offset])) {
    return { end: offset + 1, kind: "other", value: String.fromCharCode(bytes[offset]) };
  }
  const start = offset;
  while (
    offset < bytes.length
    && !isWhitespace(bytes[offset])
    && !isDelimiter(bytes[offset])
  ) {
    if (offset - start > MAX_PDF_CONTENT_TOKEN_BYTES) throw contentInspectionError();
    offset += 1;
  }
  return { end: offset, kind: "word", value: byteString(bytes, start, offset) };
}

function assertImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
  maxEdge?: number,
): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > Math.floor(maxPixels / height)
    || (maxEdge !== undefined && (width > maxEdge || height > maxEdge))
  ) throw embeddedImageLimitError();
}

function assertImageEdge(
  width: number | undefined,
  height: number | undefined,
  maxEdge: number | undefined,
): void {
  if (
    maxEdge !== undefined
    && ((width !== undefined && width > maxEdge)
      || (height !== undefined && height > maxEdge))
  ) throw embeddedImageLimitError();
}

function chargeEmbeddedImageBudget(
  context: InspectionContext,
  width: number,
  height: number,
  encodedBytes: number,
): void {
  const pixels = width * height;
  const nextPixels = context.embeddedImagePixels + pixels;
  const nextBytes = context.embeddedImageBytes + Math.max(0, encodedBytes);
  if (
    !Number.isSafeInteger(pixels)
    || !Number.isSafeInteger(nextPixels)
    || !Number.isSafeInteger(nextBytes)
    || nextPixels > context.maxEmbeddedImagePixels
    || nextBytes > context.maxEmbeddedImageBytes
  ) throw embeddedImageLimitError();
  context.embeddedImagePixels = nextPixels;
  context.embeddedImageBytes = nextBytes;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

async function yieldForCancellation(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

async function findInlineEncodedEnd(
  bytes: Uint8Array,
  dataStart: number,
  filterName: string | undefined,
  signal?: AbortSignal,
): Promise<number | undefined> {
  let nextYield = dataStart + CANCELLATION_YIELD_BYTES;
  const checkpoint = (offset: number): Promise<void> | undefined => {
    if (offset < nextYield) return undefined;
    nextYield = offset + CANCELLATION_YIELD_BYTES;
    return yieldForCancellation(signal);
  };
  if (filterName && ASCII_85_FILTERS.has(filterName)) {
    for (let offset = dataStart; offset < bytes.length; offset += 1) {
      const pendingYield = checkpoint(offset);
      if (pendingYield) await pendingYield;
      if (bytes[offset] !== 0x7e) continue;
      let cursor = offset + 1;
      while (isWhitespace(bytes[cursor])) {
        const pendingWhitespaceYield = checkpoint(cursor);
        if (pendingWhitespaceYield) await pendingWhitespaceYield;
        cursor += 1;
      }
      if (bytes[cursor] === 0x3e) return cursor + 1;
    }
    return undefined;
  }
  if (filterName && ASCII_HEX_FILTERS.has(filterName)) {
    for (let offset = dataStart; offset < bytes.length; offset += 1) {
      const pendingYield = checkpoint(offset);
      if (pendingYield) await pendingYield;
      if (bytes[offset] === 0x3e) return offset + 1;
    }
    return undefined;
  }
  if (filterName && DCT_FILTERS.has(filterName)) {
    // Match PDF.js' findDCTDecodeInlineStreamEnd: EOI is structural only
    // outside stuffed bytes and known length-delimited marker segments. A
    // literal FF D9 inside APP/DQT/DHT metadata must not truncate the payload
    // before the real EOI (and therefore before the following /EI/ token).
    const lengthDelimitedMarkers = new Set<number>([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
      0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
      0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
      0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe,
    ]);
    for (let offset = dataStart; offset + 1 < bytes.length;) {
      const pendingYield = checkpoint(offset);
      if (pendingYield) await pendingYield;
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0x00) {
        offset += 2;
        continue;
      }
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd9) return offset + 2;
      if (lengthDelimitedMarkers.has(marker)) {
        const markerLength = readBigEndianUint16(bytes, offset + 2);
        if (markerLength === undefined) return undefined;
        if (markerLength > 2) {
          const segmentEnd = offset + 2 + markerLength;
          if (segmentEnd > bytes.length) return undefined;
          offset = segmentEnd;
        } else {
          // PDF.js rewinds malformed <=2-byte lengths and continues scanning
          // from the length field instead of treating the next FF D9 as EOI.
          offset += 2;
        }
        continue;
      }
      offset += 2;
    }
  }
  return undefined;
}

function isLikelyInlineImageEnd(bytes: Uint8Array, eiOffset: number): boolean {
  const following = bytes[eiOffset + 2];
  // Match PDF.js' primary inline-image terminator rule: EI must be followed
  // by a regular space or line ending (or be the end of the stream). Broad
  // PDF delimiters such as '(' are legal image data and are not terminators.
  if (
    following !== undefined
    && following !== 0x20
    && following !== 0x0a
    && following !== 0x0d
  ) return false;

  let offset = eiOffset + 2;
  const inspectionEnd = Math.min(bytes.length, offset + 75);
  let arrayDepth = 0;
  let dictDepth = 0;
  let numArgs = 0;
  while (offset < inspectionEnd) {
    const token = readContentToken(bytes.subarray(0, inspectionEnd), offset);
    if (!token) return true;
    offset = token.end;
    if (token.kind === "other") {
      if (token.value === "[") {
        if (arrayDepth === 0 && dictDepth === 0) numArgs += 1;
        arrayDepth += 1;
      } else if (token.value === "]") {
        arrayDepth = Math.max(0, arrayDepth - 1);
      } else if (token.value === "<") {
        if (arrayDepth === 0 && dictDepth === 0) numArgs += 1;
        dictDepth += 1;
      } else if (token.value === ">") {
        dictDepth = Math.max(0, dictDepth - 1);
      }
      continue;
    }
    if (arrayDepth > 0 || dictDepth > 0) continue;
    if (token.kind !== "word" || isOperandWord(token.value)) {
      numArgs += 1;
      continue;
    }
    const arity = PDF_CONTENT_OPERATOR_ARITIES[token.value];
    if (!arity) return false;
    if (arity.variable ? numArgs <= arity.maxArgs : numArgs === arity.maxArgs) return true;
    numArgs = 0;
  }
  return offset >= bytes.length;
}

async function skipInlineImageData(
  bytes: Uint8Array,
  initialOffset: number,
  filterName: string | undefined,
  signal?: AbortSignal,
): Promise<number> {
  const dataStart = inlineImageDataStart(bytes, initialOffset);
  const encodedEnd = await findInlineEncodedEnd(bytes, dataStart, filterName, signal);
  if (encodedEnd !== undefined) {
    let encodedNextYield = encodedEnd + CANCELLATION_YIELD_BYTES;
    for (let offset = encodedEnd; offset + 1 < bytes.length; offset += 1) {
      if (offset >= encodedNextYield) {
        await yieldForCancellation(signal);
        encodedNextYield = offset + CANCELLATION_YIELD_BYTES;
      }
      if (bytes[offset] === 0x45 && bytes[offset + 1] === 0x49) return offset + 2;
    }
    throw contentInspectionError();
  }
  let nextYield = dataStart + CANCELLATION_YIELD_BYTES;
  for (let offset = dataStart; offset + 1 < bytes.length; offset += 1) {
    if (offset >= nextYield) {
      await yieldForCancellation(signal);
      nextYield = offset + CANCELLATION_YIELD_BYTES;
    }
    if (
      bytes[offset] === 0x45
      && bytes[offset + 1] === 0x49
      && isLikelyInlineImageEnd(bytes, offset)
    ) return offset + 2;
  }
  throw contentInspectionError();
}

function inlineImageDataStart(bytes: Uint8Array, initialOffset: number): number {
  let dataStart = initialOffset;
  if (bytes[dataStart] === 13 && bytes[dataStart + 1] === 10) dataStart += 2;
  else if (isWhitespace(bytes[dataStart])) dataStart += 1;
  return dataStart;
}

async function inspectInlineImage(
  document: PDFDocument,
  bytes: Uint8Array,
  initialOffset: number,
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
  signal?: AbortSignal,
): Promise<number> {
  let offset = initialOffset;
  let pendingKey: string | null = null;
  let shortWidthPresent = false;
  let shortWidth: number | undefined;
  let longWidth: number | undefined;
  let shortHeightPresent = false;
  let shortHeight: number | undefined;
  let longHeight: number | undefined;
  let firstFilterName: string | undefined;
  const inlineFilterNames: string[] = [];
  let shortBitsPerComponent: number | undefined;
  let longBitsPerComponent: number | undefined;
  let inlineColorSpace: PDFObject | undefined;
  let inlineImageMask = false;
  let arrayKey: string | null = null;
  let arrayDepth = 0;
  while (offset < bytes.length) {
    const token = readContentToken(bytes, offset);
    if (!token) throw contentInspectionError();
    offset = token.end;
    if (token.kind === "word" && token.value === "ID") {
      const width = shortWidthPresent ? shortWidth : longWidth;
      const height = shortHeightPresent ? shortHeight : longHeight;
      if (width === undefined || height === undefined) throw contentInspectionError();
      assertImageEdge(width, height, maxEdge);
      assertImageDimensions(width, height, maxPixels, maxEdge);
      const dataStart = inlineImageDataStart(bytes, offset);
      validateImageFilterChain(inlineFilterNames);
      const dataEnd = await skipInlineImageData(bytes, offset, firstFilterName, signal);
      chargeEmbeddedImageBudget(
        context,
        width,
        height,
        Math.max(0, dataEnd - dataStart),
      );
      if (
        inlineFilterNames.some(isLosslessImageFilter)
      ) {
        if (width === undefined || height === undefined) throw contentInspectionError();
        const bitsPerComponent = shortBitsPerComponent ?? longBitsPerComponent;
        const components = inlineImageMask
          ? 1
          : imageColorSpaceComponents(inlineColorSpace) ?? DEFAULT_IMAGE_COMPONENTS_FALLBACK;
        if (bitsPerComponent === undefined || components <= 0) {
          throw contentInspectionError();
        }
        const metadata = imagePayloadMetadataFromValues(
          bitsPerComponent,
          components,
          width,
          height,
        );
        inspectLosslessImagePayload(
          document,
          bytes.subarray(dataStart, Math.max(dataStart, dataEnd - 2)),
          inlineFilterNames,
          inlineFilterNames.map(() => undefined),
          metadata,
          maxPixels,
          maxEdge,
          signal,
        );
      } else if (inlineFilterNames.length > 0 && isOpaqueImageFilter(inlineFilterNames[0])) {
        inspectOpaqueImagePayload(
          bytes.subarray(dataStart, Math.max(dataStart, dataEnd - 2)),
          inlineFilterNames[0],
          maxPixels,
          maxEdge,
          signal,
        );
      }
      return dataEnd;
    }
    if (arrayKey) {
      if (token.kind === "other" && token.value === "[") arrayDepth += 1;
      else if (token.kind === "other" && token.value === "]") {
        arrayDepth -= 1;
        if (arrayDepth <= 0) arrayKey = null;
      } else if (
        token.kind === "name"
        && (arrayKey === "/F" || arrayKey === "/Filter")
      ) {
        inlineFilterNames.push(token.value);
        firstFilterName ??= token.value;
      }
      continue;
    }
    if (token.kind === "other" && token.value === "[" && pendingKey) {
      arrayKey = pendingKey;
      arrayDepth = 1;
      pendingKey = null;
      continue;
    }
    if (token.kind === "name") {
      if (pendingKey) {
        if (pendingKey === "/F" || pendingKey === "/Filter") {
          inlineFilterNames.push(token.value);
          firstFilterName = token.value;
        }
        if (pendingKey === "/CS" || pendingKey === "/ColorSpace") {
          inlineColorSpace = PDFName.of(token.value.slice(1));
        }
        pendingKey = null;
        continue;
      }
      pendingKey = token.value;
      if (token.value === "/W") shortWidthPresent = true;
      if (token.value === "/H") shortHeightPresent = true;
      if (token.value === "/BPC") shortBitsPerComponent = undefined;
      if (token.value === "/BitsPerComponent") longBitsPerComponent = undefined;
      continue;
    }
    if (pendingKey && token.kind === "word") {
      const numericValue = Number(token.value);
      if (Number.isFinite(numericValue)) {
        if (pendingKey === "/W") shortWidth = numericValue;
        if (pendingKey === "/Width") longWidth = numericValue;
        if (pendingKey === "/H") shortHeight = numericValue;
        if (pendingKey === "/Height") longHeight = numericValue;
        if (pendingKey === "/BPC") shortBitsPerComponent = numericValue;
        if (pendingKey === "/BitsPerComponent") longBitsPerComponent = numericValue;
      } else if (pendingKey === "/IM" || pendingKey === "/ImageMask") {
        inlineImageMask = token.value === "true";
      }
    }
    pendingKey = null;
  }
  throw contentInspectionError();
}

function isOperandWord(value: string): boolean {
  return value === "true"
    || value === "false"
    || value === "null"
    || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

async function scanContent(
  document: PDFDocument,
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
  resources: ResourceScope,
  inheritedFont: ActiveFontState | null,
): Promise<ContentResourceUsage> {
  const { signal } = context;
  // Give a queued navigation abort a chance to run before any single large
  // whitespace/string token enters the synchronous lexical reader.
  if (bytes.length >= CANCELLATION_YIELD_BYTES) await yieldForCancellation(signal);
  const usage: ContentResourceUsage = {
    extGStates: new Set(),
    fonts: new Map(),
    fontObjects: new Map(),
    patterns: new Set(),
    xObjects: new Set(),
    xObjectFonts: new Map(),
    extGStateFonts: new Map(),
  };
  // Only resource operators need an operand here, and each uses the most
  // recent name. Retaining every numeric operand lets a legal 16 MiB stream
  // amplify into millions of token objects, so keep constant-size state.
  let lastName: string | null = null;
  let activeFont: ActiveFontState | null = inheritedFont;
  const savedFonts: Array<ActiveFontState | null> = [];
  const retainResourceName = (collection: Set<string>, value: string): void => {
    if (collection.has(value)) return;
    if (context.resourceNameCount >= MAX_PDF_RESOURCE_NAMES) throw contentInspectionError();
    collection.add(value);
    context.resourceNameCount += 1;
  };
  const fontStateCache = new Map<string, ActiveFontState>();
  const resolveFontState = (resourceName: string): ActiveFontState => {
    const cached = fontStateCache.get(resourceName);
    if (cached) return cached;
    if (fontStateCache.size >= MAX_PDF_RESOURCE_NAMES) throw contentInspectionError();
    const font = resourceObject(document, resources, FONT, resourceName);
    const state = font instanceof PDFDict
      ? { font, resources }
      : { resourceName, resources };
    fontStateCache.set(resourceName, state);
    return state;
  };
  const extGStateFontCache = new Map<string, ActiveFontState | null>();
  const resolveExtGStateFont = (resourceName: string): ActiveFontState | undefined => {
    if (extGStateFontCache.has(resourceName)) {
      return extGStateFontCache.get(resourceName) ?? undefined;
    }
    const fontState = fontStateFromExtGState(document, resources, resourceName);
    extGStateFontCache.set(resourceName, fontState ?? null);
    return fontState;
  };
  const retainFontState = (
    collection: Map<string, Map<PDFDict | string | null, Set<ResourceScope>>>,
    resourceName: string,
  ): void => {
    let states = collection.get(resourceName);
    if (!states) {
      states = new Map();
      collection.set(resourceName, states);
    }
    const stateKey = activeFont?.font ?? activeFont?.resourceName ?? null;
    let scopes = states.get(stateKey);
    if (!scopes) {
      // The first state for a resource name is already covered by the
      // retainResourceName call above. Charge the shared budget only for
      // additional state variants retained for the same operator name.
      if (stateKey !== null && states.size > 0) {
        if (context.resourceNameCount >= MAX_PDF_RESOURCE_NAMES) {
          throw contentInspectionError();
        }
        context.resourceNameCount += 1;
      }
      scopes = new Set();
      states.set(stateKey, scopes);
    }
    scopes.add(activeFont?.resources ?? resources);
  };
  const recordGlyphCodes = (): void => {
    if (!activeFont) return;
    if (activeFont.font) {
      let byResources = usage.fontObjects.get(activeFont.font);
      if (!byResources) {
        byResources = new Map();
        usage.fontObjects.set(activeFont.font, byResources);
      }
      let glyphCodes = byResources.get(activeFont.resources);
      if (!glyphCodes) {
        if (context.resourceNameCount >= MAX_PDF_RESOURCE_NAMES) {
          throw contentInspectionError();
        }
        context.resourceNameCount += 1;
        glyphCodes = new Set();
        byResources.set(activeFont.resources, glyphCodes);
      }
      for (const byte of pendingGlyphCodes) glyphCodes.add(byte);
      return;
    }
    if (activeFont.resourceName) {
      let glyphCodes = usage.fonts.get(activeFont.resourceName);
      if (!glyphCodes) {
        if (context.resourceNameCount >= MAX_PDF_RESOURCE_NAMES) {
          throw contentInspectionError();
        }
        context.resourceNameCount += 1;
        glyphCodes = new Set();
        usage.fonts.set(activeFont.resourceName, glyphCodes);
      }
      for (const byte of pendingGlyphCodes) glyphCodes.add(byte);
    }
  };
  let pendingGlyphCodes = new Set<number>();
  let offset = 0;
  let nextYield = CANCELLATION_YIELD_BYTES;
  while (offset < bytes.length) {
    if (offset >= nextYield) {
      await yieldForCancellation(signal);
      nextYield = offset + CANCELLATION_YIELD_BYTES;
    }
    const token = readContentToken(bytes, offset);
    if (!token) break;
    offset = token.end;
    if (token.kind === "word" && token.value === "BI") {
      offset = await inspectInlineImage(document, bytes, offset, maxPixels, maxEdge, context, signal);
      lastName = null;
      pendingGlyphCodes.clear();
      continue;
    }
    if (token.kind === "string") {
      if (token.bytes) {
        for (const byte of token.bytes) pendingGlyphCodes.add(byte);
      }
      continue;
    }
    if (token.kind === "word" && token.value === "q") {
      if (savedFonts.length >= MAX_PDF_GRAPHICS_STATE_DEPTH) throw contentInspectionError();
      savedFonts.push(activeFont);
      pendingGlyphCodes = new Set();
      lastName = null;
      continue;
    }
    if (token.kind === "word" && token.value === "Q") {
      // PDF.js StateManager.restore() treats an unmatched Q as a no-op. A
      // stream that ends with saved states is likewise tolerated by PDF.js;
      // only the bounded stack itself is rejected above.
      if (savedFonts.length > 0) activeFont = savedFonts.pop() ?? null;
      pendingGlyphCodes = new Set();
      lastName = null;
      continue;
    }
    if (token.kind !== "word" || isOperandWord(token.value)) {
      if (token.kind === "name") lastName = token.value;
      continue;
    }
    const resourceName = lastName;
    if (resourceName) {
      if (token.value === "Do") {
        retainResourceName(usage.xObjects, resourceName);
        retainFontState(usage.xObjectFonts, resourceName);
      } else if (token.value === "Tf") {
        activeFont = resolveFontState(resourceName);
      } else if (token.value === "gs") {
        retainResourceName(usage.extGStates, resourceName);
        const gStateFont = resolveExtGStateFont(resourceName);
        if (gStateFont) activeFont = gStateFont;
        retainFontState(usage.extGStateFonts, resourceName);
      } else if (token.value === "scn" || token.value === "SCN") {
        retainResourceName(usage.patterns, resourceName);
      }
    }
    if (token.value === "Tj" || token.value === "TJ" || token.value === "'" || token.value === "\"") {
      recordGlyphCodes();
    }
    pendingGlyphCodes = new Set();
    lastName = null;
  }
  return usage;
}

function rawDictEntry(dict: PDFDict, key: PDFName): PDFObject | undefined {
  const direct = dict.get(key);
  if (direct) return direct;
  const expected = normalizedPdfName(key.asString());
  return dict.entries().find(([name]) => (
    normalizedPdfName(name.asString()) === expected
  ))?.[1];
}

function lookupName(dict: PDFDict, key: PDFName): PDFName | undefined {
  try {
    const raw = rawDictEntry(dict, key);
    const value = raw ? dict.context.lookup(raw) : undefined;
    return value instanceof PDFName ? value : undefined;
  } catch {
    return undefined;
  }
}

function lookupDict(dict: PDFDict, key: PDFName): PDFDict | undefined {
  try {
    const raw = rawDictEntry(dict, key);
    const value = raw ? dict.context.lookup(raw) : undefined;
    return value instanceof PDFDict ? value : undefined;
  } catch {
    return undefined;
  }
}

function lookupNumber(dict: PDFDict, ...keys: PDFName[]): number | undefined {
  for (const key of keys) {
    try {
      const raw = rawDictEntry(dict, key);
      if (!raw) continue;
      const value = raw ? dict.context.lookup(raw) : undefined;
      if (value instanceof PDFNumber) return value.asNumber();
      // PDF.js only tries a long alias when the short key is absent. A present
      // value of the wrong type makes the field invalid rather than falling
      // through to a second spelling.
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function lookupObject(document: PDFDocument, dict: PDFDict, key: PDFName): unknown {
  const raw = rawDictEntry(dict, key);
  if (!raw) return undefined;
  try {
    return document.context.lookup(raw);
  } catch {
    return undefined;
  }
}

function resourceObject(
  document: PDFDocument,
  resources: ResourceScope,
  category: PDFName,
  resourceName: string,
): unknown {
  for (const resourceDict of resources) {
    const categoryDict = lookupDict(resourceDict, category);
    const entry = categoryDict?.entries().find(([name]) => (
      normalizedPdfName(name.asString()) === resourceName
    ))?.[1];
    if (!entry) continue;
    try {
      return document.context.lookup(entry);
    } catch {
      throw contentInspectionError();
    }
  }
  return undefined;
}

function fontStateFromExtGState(
  document: PDFDocument,
  resources: ResourceScope,
  resourceName: string,
): ActiveFontState | undefined {
  const graphicsState = resourceObject(document, resources, EXT_G_STATE, resourceName);
  if (!(graphicsState instanceof PDFDict)) return undefined;
  const rawFont = rawDictEntry(graphicsState, FONT);
  if (!rawFont) return undefined;
  let fontArray: PDFObject | undefined;
  try {
    fontArray = graphicsState.context.lookup(rawFont);
  } catch {
    throw contentInspectionError();
  }
  if (!(fontArray instanceof PDFArray) || fontArray.size() < 1) {
    throw contentInspectionError();
  }
  let font: PDFObject | undefined;
  try {
    font = fontArray.lookup(0);
  } catch {
    throw contentInspectionError();
  }
  if (!(font instanceof PDFDict)) throw contentInspectionError();
  return { font, resources };
}

function type3GlyphNamesForCodes(
  document: PDFDocument,
  font: PDFDict,
  glyphCodes: ReadonlySet<number>,
): Set<string> | undefined {
  const encoding = lookupObject(document, font, ENCODING);
  if (!(encoding instanceof PDFDict)) return undefined;
  const differences = lookupObject(document, encoding, DIFFERENCES);
  if (!(differences instanceof PDFArray)) return undefined;
  const namesByCode = new Map<number, string>();
  let currentCode: number | undefined;
  for (let index = 0; index < differences.size(); index += 1) {
    let entry: PDFObject | undefined;
    try {
      entry = differences.lookup(index);
    } catch {
      return undefined;
    }
    if (entry instanceof PDFNumber) {
      const code = entry.asNumber();
      if (!Number.isSafeInteger(code) || code < 0 || code > 255) return undefined;
      currentCode = code;
    } else if (entry instanceof PDFName && currentCode !== undefined) {
      namesByCode.set(currentCode, normalizedPdfName(entry.asString()));
      currentCode += 1;
    } else {
      return undefined;
    }
  }
  const glyphNames = new Set<string>();
  for (const code of glyphCodes) {
    const name = namesByCode.get(code);
    if (!name) return undefined;
    glyphNames.add(name);
  }
  return glyphNames;
}

function filterNames(stream: PDFRawStream): string[] {
  const raw = rawDictEntry(stream.dict, FILTER);
  if (!raw) return [];
  let filter: PDFObject | undefined;
  try {
    filter = stream.dict.context.lookup(raw);
  } catch {
    throw contentInspectionError();
  }
  if (filter instanceof PDFName) return [normalizedPdfName(filter.asString())];
  if (!(filter instanceof PDFArray)) throw contentInspectionError();
  const names: string[] = [];
  for (let index = 0; index < filter.size(); index += 1) {
    let entry: PDFObject | undefined;
    try {
      entry = filter.lookup(index);
    } catch {
      throw contentInspectionError();
    }
    if (!(entry instanceof PDFName)) throw contentInspectionError();
    names.push(normalizedPdfName(entry.asString()));
  }
  return names;
}

function decodeParamsForFilter(
  stream: PDFRawStream,
  filterIndex: number,
  filterCount: number,
): PDFDict | undefined {
  const raw = rawDictEntry(stream.dict, DECODE_PARMS);
  if (!raw) return undefined;
  let params: PDFObject | undefined;
  try {
    params = stream.dict.context.lookup(raw);
  } catch {
    throw contentInspectionError();
  }
  if (params === PDFNull) return undefined;
  if (params instanceof PDFDict) {
    if (filterCount !== 1) throw contentInspectionError();
    return params;
  }
  if (!(params instanceof PDFArray) || params.size() !== filterCount) {
    throw contentInspectionError();
  }
  let aligned: PDFObject | undefined;
  try {
    aligned = params.lookup(filterIndex);
  } catch {
    throw contentInspectionError();
  }
  if (aligned === PDFNull) return undefined;
  if (!(aligned instanceof PDFDict)) throw contentInspectionError();
  return aligned;
}

function assertSupportedPredictor(params: PDFDict | undefined): void {
  if (!params) return;
  const predictor = lookupNumber(params, PREDICTOR) ?? 1;
  // Applying PNG/TIFF predictors incorrectly can turn operators into harmless
  // bytes and bypass resource discovery. Until the preflight implements those
  // row transforms, reject them explicitly instead of inspecting the wrong
  // content. Predictor 1 is the PDF default and requires no transform.
  if (!Number.isSafeInteger(predictor) || predictor !== 1) throw contentInspectionError();
}

function boundedPdfLibFilterDecode(
  stream: PDFRawStream,
  bytes: Uint8Array,
  filter: string,
  params: PDFDict | undefined,
  maxBytes: number,
  signal?: AbortSignal,
  limitError?: Error,
): Uint8Array {
  const canonicalFilter = LZW_FILTERS.has(filter)
    ? PDFName.of("LZWDecode")
    : PDFName.of("RunLengthDecode");
  const dict = stream.dict.context.obj({ Filter: canonicalFilter }) as PDFDict;
  if (params) dict.set(DECODE_PARMS, params);
  try {
    throwIfAborted(signal);
    const decoded = decodePDFRawStream(PDFRawStream.of(dict, bytes)).getBytes(maxBytes + 1);
    throwIfAborted(signal);
    if (decoded.length > maxBytes) throw limitError ?? contentInspectionError();
    return decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded);
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.name === "AbortError"
        || error.message === contentInspectionError().message
        || isImageFilterLimitError(error)
      )
    ) throw error;
    throw contentInspectionError();
  }
}

function boundedAsciiHexDecode(
  bytes: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
  limitError?: Error,
): Uint8Array {
  const output = new Uint8Array(Math.min(maxBytes + 1, Math.ceil(bytes.length / 2)));
  let highNibble: number | undefined;
  let outputLength = 0;
  const append = (value: number) => {
    if (outputLength >= maxBytes) throw limitError ?? contentInspectionError();
    output[outputLength] = value;
    outputLength += 1;
  };
  for (let index = 0; index < bytes.length; index += 1) {
    if (index % CANCELLATION_YIELD_BYTES === 0) throwIfAborted(signal);
    const byte = bytes[index];
    if (isWhitespace(byte)) continue;
    if (byte === 0x3e) break;
    const nibble = byte >= 0x30 && byte <= 0x39
      ? byte - 0x30
      : byte >= 0x41 && byte <= 0x46
        ? byte - 0x41 + 10
        : byte >= 0x61 && byte <= 0x66
          ? byte - 0x61 + 10
          : -1;
    if (nibble < 0) throw contentInspectionError();
    if (highNibble === undefined) highNibble = nibble;
    else {
      append((highNibble << 4) | nibble);
      highNibble = undefined;
    }
  }
  if (highNibble !== undefined) append(highNibble << 4);
  return output.slice(0, outputLength);
}

function boundedAscii85Decode(
  bytes: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
  limitError?: Error,
): Uint8Array {
  // A regular five-character group decodes to four bytes, but the legal `z`
  // shorthand expands one character to four zero bytes. Size for that true
  // worst case so typed-array writes cannot truncate operators silently.
  const output = new Uint8Array(Math.min(maxBytes + 1, bytes.length * 4 + 4));
  const group: number[] = [];
  let outputLength = 0;
  const append = (value: number) => {
    if (outputLength >= maxBytes) throw limitError ?? contentInspectionError();
    output[outputLength] = value;
    outputLength += 1;
  };
  const flushGroup = (length: number) => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) value = value * 85 + group[index];
    if (value > 0xffffffff) throw contentInspectionError();
    const decoded = [
      Math.floor(value / 0x1000000) & 0xff,
      Math.floor(value / 0x10000) & 0xff,
      Math.floor(value / 0x100) & 0xff,
      value & 0xff,
    ];
    for (let index = 0; index < length; index += 1) append(decoded[index]);
    group.length = 0;
  };

  for (let index = 0; index < bytes.length; index += 1) {
    if (index % CANCELLATION_YIELD_BYTES === 0) throwIfAborted(signal);
    const byte = bytes[index];
    if (isWhitespace(byte)) continue;
    if (byte === 0x7e) break;
    if (byte === 0x7a) {
      if (group.length) throw contentInspectionError();
      append(0);
      append(0);
      append(0);
      append(0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) throw contentInspectionError();
    group.push(byte - 0x21);
    if (group.length === 5) flushGroup(4);
  }
  if (group.length === 1) throw contentInspectionError();
  if (group.length > 1) {
    const decodedLength = group.length - 1;
    while (group.length < 5) group.push(84);
    flushGroup(decodedLength);
  }
  return output.slice(0, outputLength);
}

function boundedFlateDecode(
  bytes: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
  limitError?: Error,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let outputLength = 0;
  const inflater = new Unzlib((chunk) => {
    throwIfAborted(signal);
    if (chunk.length > maxBytes - outputLength) throw limitError ?? contentInspectionError();
    if (chunk.length) chunks.push(chunk);
    outputLength += chunk.length;
  });
  try {
    if (!bytes.length) throw contentInspectionError();
    for (let offset = 0; offset < bytes.length; offset += FLATE_INPUT_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(bytes.length, offset + FLATE_INPUT_CHUNK_BYTES);
      inflater.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.name === "AbortError"
        || error.message === contentInspectionError().message
        || isImageFilterLimitError(error)
      )
    ) throw error;
    throw contentInspectionError();
  }
  if (chunks.length === 1) return chunks[0];
  const output = new Uint8Array(outputLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function decodedContentBytes(stream: PDFStream, maxBytes: number): Uint8Array {
  if (!(stream instanceof PDFRawStream)) throw contentInspectionError();
  const filters = filterNames(stream);
  if (!filters.length) {
    if (stream.contents.length > maxBytes) throw contentInspectionError();
    return stream.contents;
  }

  let decoded = stream.contents;
  for (let filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
    const filter = filters[filterIndex];
    const params = decodeParamsForFilter(stream, filterIndex, filters.length);
    if (ASCII_HEX_FILTERS.has(filter)) {
      decoded = boundedAsciiHexDecode(decoded, maxBytes);
    } else if (ASCII_85_FILTERS.has(filter)) {
      decoded = boundedAscii85Decode(decoded, maxBytes);
    } else if (FLATE_FILTERS.has(filter)) {
      assertSupportedPredictor(params);
      decoded = boundedFlateDecode(decoded, maxBytes);
    } else if (LZW_FILTERS.has(filter) || RUN_LENGTH_FILTERS.has(filter)) {
      if (LZW_FILTERS.has(filter)) assertSupportedPredictor(params);
      decoded = boundedPdfLibFilterDecode(stream, decoded, filter, params, maxBytes);
    } else {
      throw contentInspectionError();
    }
  }
  return decoded;
}

function lookupObjectFromKeys(
  document: PDFDocument,
  dict: PDFDict,
  ...keys: PDFName[]
): PDFObject | undefined {
  for (const key of keys) {
    const raw = rawDictEntry(dict, key);
    if (!raw) continue;
    try {
      return document.context.lookup(raw);
    } catch {
      throw contentInspectionError();
    }
  }
  return undefined;
}

function lookupBoolean(dict: PDFDict, ...keys: PDFName[]): boolean | undefined {
  for (const key of keys) {
    const raw = rawDictEntry(dict, key);
    if (!raw) continue;
    try {
      const value = dict.context.lookup(raw);
      return value instanceof PDFBool ? value.asBoolean() : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function imageColorSpaceComponents(
  value: PDFObject | undefined,
  depth = 0,
): number | undefined {
  if (!value || depth > 8) return undefined;
  if (value instanceof PDFName) {
    switch (normalizedPdfName(value.asString())) {
      case "/G":
      case "/DeviceGray":
      case "/CalGray":
        return 1;
      case "/RGB":
      case "/DeviceRGB":
      case "/CalRGB":
      case "/Lab":
        return 3;
      case "/CMYK":
      case "/DeviceCMYK":
      case "/DeviceRGBA":
        return 4;
      case "/Pattern":
        return 1;
      default:
        return undefined;
    }
  }
  if (value instanceof PDFDict) {
    const components = lookupNumber(value, PDFName.of("N"));
    return components !== undefined && Number.isSafeInteger(components) && components > 0
      ? components
      : undefined;
  }
  if (!(value instanceof PDFArray)) return undefined;
  let mode: PDFObject | undefined;
  try {
    mode = value.lookup(0);
  } catch {
    return undefined;
  }
  if (!(mode instanceof PDFName)) return undefined;
  switch (normalizedPdfName(mode.asString())) {
    case "/ICCBased": {
      let profile: PDFObject | undefined;
      try {
        profile = value.lookup(1);
      } catch {
        return undefined;
      }
      return imageColorSpaceComponents(profile, depth + 1);
    }
    case "/Indexed":
    case "/I": {
      let base: PDFObject | undefined;
      try {
        base = value.lookup(1);
      } catch {
        return undefined;
      }
      return imageColorSpaceComponents(base, depth + 1);
    }
    case "/Separation":
      return 1;
    case "/DeviceN": {
      let names: PDFObject | undefined;
      try {
        names = value.lookup(1);
      } catch {
        return undefined;
      }
      if (!(names instanceof PDFArray) || names.size() <= 0) return undefined;
      return names.size();
    }
    case "/Pattern": {
      if (value.size() < 2) return 1;
      let base: PDFObject | undefined;
      try {
        base = value.lookup(1);
      } catch {
        return undefined;
      }
      return imageColorSpaceComponents(base, depth + 1);
    }
    default:
      return undefined;
  }
}

interface ImagePayloadMetadata {
  bitsPerComponent: number;
  components: number;
  height: number;
  rowBytes: number;
  width: number;
}

function imagePayloadMetadataFromValues(
  bitsPerComponent: number,
  components: number,
  width: number,
  height: number,
): ImagePayloadMetadata {
  if (
    !Number.isSafeInteger(bitsPerComponent)
    || ![1, 2, 4, 8, 16].includes(bitsPerComponent)
    || !Number.isSafeInteger(components)
    || components <= 0
    || components > MAX_IMAGE_COMPONENTS
  ) throw contentInspectionError();
  const rowBits = width * components * bitsPerComponent;
  if (!Number.isSafeInteger(rowBits) || rowBits <= 0) throw contentInspectionError();
  const rowBytes = Math.ceil(rowBits / 8);
  if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0) throw contentInspectionError();
  return { bitsPerComponent, components, height, rowBytes, width };
}

function imagePayloadMetadata(
  document: PDFDocument,
  dict: PDFDict,
  width: number,
  height: number,
): ImagePayloadMetadata {
  const imageMask = lookupBoolean(dict, IMAGE_MASK_SHORT, IMAGE_MASK) ?? false;
  const bitsPerComponent = lookupNumber(
    dict,
    BITS_PER_COMPONENT_SHORT,
    BITS_PER_COMPONENT,
  ) ?? (imageMask ? 1 : undefined);
  if (
    bitsPerComponent === undefined
    || !Number.isSafeInteger(bitsPerComponent)
    || ![1, 2, 4, 8, 16].includes(bitsPerComponent)
  ) throw contentInspectionError();
  let components = 1;
  if (!imageMask) {
    const colorSpace = lookupObjectFromKeys(document, dict, COLOR_SPACE_SHORT, COLOR_SPACE);
    // Resource-named and codec-specific color spaces may only be resolvable by
    // PDF.js' resource environment. Use a conservative common fallback; the
    // firm decoded-byte budget still bounds any lossless expansion.
    components = imageColorSpaceComponents(colorSpace) ?? DEFAULT_IMAGE_COMPONENTS_FALLBACK;
    if (components <= 0 || components > MAX_IMAGE_COMPONENTS) {
      throw contentInspectionError();
    }
  }
  return imagePayloadMetadataFromValues(bitsPerComponent, components, width, height);
}

function imageFilterDecodedByteAllowance(
  metadata: ImagePayloadMetadata,
  maxPixels: number,
  filterParams: readonly (PDFDict | undefined)[],
): number {
  const rawBytes = metadata.rowBytes * metadata.height;
  if (!Number.isSafeInteger(rawBytes) || rawBytes <= 0) throw contentInspectionError();
  const pixelBudget = maxPixels > Math.floor(
    (MAX_IMAGE_FILTER_DECODE_BYTES - MIN_IMAGE_FILTER_BUDGET_BYTES)
      / MAX_IMAGE_FILTER_BUDGET_BYTES_PER_PIXEL,
  )
    ? MAX_IMAGE_FILTER_DECODE_BYTES
    : Math.min(
      MAX_IMAGE_FILTER_DECODE_BYTES,
      maxPixels * MAX_IMAGE_FILTER_BUDGET_BYTES_PER_PIXEL + MIN_IMAGE_FILTER_BUDGET_BYTES,
    );
  if (rawBytes > pixelBudget) throw contentInspectionError();
  let decodedBytes = rawBytes;
  for (const params of filterParams) {
    if (!params) continue;
    const predictor = lookupNumber(params, PREDICTOR) ?? 1;
    if (
      !Number.isSafeInteger(predictor)
      || predictor < 0
      || predictor > 15
      || (predictor > 2 && predictor < 10)
    ) {
      throw contentInspectionError();
    }
    if (predictor <= 2) continue;
    const colors = lookupNumber(params, PDFName.of("Colors")) ?? metadata.components;
    const bits = lookupNumber(
      params,
      BITS_PER_COMPONENT_SHORT,
      BITS_PER_COMPONENT,
    ) ?? metadata.bitsPerComponent;
    const columns = lookupNumber(params, PDFName.of("Columns")) ?? metadata.width;
    if (
      !Number.isSafeInteger(colors) || colors <= 0 || colors > MAX_IMAGE_COMPONENTS
      || !Number.isSafeInteger(bits) || ![1, 2, 4, 8, 16].includes(bits)
      || !Number.isSafeInteger(columns) || columns <= 0
    ) throw contentInspectionError();
    const predictorRowBits = columns * colors * bits;
    if (!Number.isSafeInteger(predictorRowBits) || predictorRowBits <= 0) {
      throw contentInspectionError();
    }
    const predictorRowBytes = Math.ceil(predictorRowBits / 8);
    const predictorBytes = (predictorRowBytes + 1) * metadata.height;
    if (!Number.isSafeInteger(predictorBytes)) throw contentInspectionError();
    decodedBytes = Math.max(decodedBytes, predictorBytes);
  }
  const headroom = Math.max(64 * 1024, metadata.rowBytes);
  const allowance = decodedBytes + headroom;
  if (!Number.isSafeInteger(allowance)) throw contentInspectionError();
  return Math.min(pixelBudget, allowance);
}

function isOpaqueImageFilter(filter: string): boolean {
  return OPAQUE_IMAGE_FILTERS.has(filter);
}

function isLosslessImageFilter(filter: string): boolean {
  return FLATE_FILTERS.has(filter)
    || LZW_FILTERS.has(filter)
    || RUN_LENGTH_FILTERS.has(filter)
    || ASCII_85_FILTERS.has(filter)
    || ASCII_HEX_FILTERS.has(filter);
}

function validateImageFilterChain(filters: readonly string[]): void {
  if (filters.some((filter) => BROTLI_FILTERS.has(filter))) {
    // PDF.js' BrotliStream materializes the entire decoded payload on demand;
    // this preflight has no bounded Brotli decoder, so fail closed rather than
    // allowing a Brotli image (or wrapper around an opaque codec) to bypass the
    // filtered-image byte budget.
    throw contentInspectionError();
  }
  const opaqueCount = filters.filter(isOpaqueImageFilter).length;
  if (
    opaqueCount > 1
    || filters.some((filter) => !isLosslessImageFilter(filter) && !isOpaqueImageFilter(filter))
  ) {
    throw contentInspectionError();
  }
}

function readBigEndianUint16(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > bytes.length) return undefined;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readBigEndianUint32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  return bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3];
}

function readBigEndianUint64(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 8 > bytes.length) return undefined;
  let value = 0;
  for (let index = 0; index < 8; index += 1) {
    value = value * 256 + bytes[offset + index];
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
}

function assertOpaqueIntrinsicDimensions(
  width: number,
  height: number,
  maxPixels: number,
  maxEdge: number | undefined,
): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) throw contentInspectionError();
  assertImageDimensions(width, height, maxPixels, maxEdge);
}

function inspectJpegIntrinsicDimensions(
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
): void {
  const scanEnd = Math.min(bytes.length - 1, MAX_OPAQUE_IMAGE_HEADER_BYTES);
  let soiOffset = -1;
  let nextYield = CANCELLATION_YIELD_BYTES;
  for (let offset = 0; offset < scanEnd; offset += 1) {
    if (offset >= nextYield) {
      throwIfAborted(signal);
      nextYield = offset + CANCELLATION_YIELD_BYTES;
    }
    if (bytes[offset] === 0xff && bytes[offset + 1] === 0xd8) {
      soiOffset = offset;
      break;
    }
  }
  if (soiOffset < 0) throw contentInspectionError();

  const headerEnd = Math.min(bytes.length, soiOffset + MAX_OPAQUE_IMAGE_HEADER_BYTES);
  let offset = soiOffset + 2;
  while (offset + 1 < headerEnd) {
    throwIfAborted(signal);
    if (bytes[offset] !== 0xff) throw contentInspectionError();
    while (offset < headerEnd && bytes[offset] === 0xff) offset += 1;
    if (offset >= headerEnd) throw contentInspectionError();
    const marker = bytes[offset++];
    if (marker === 0x00) throw contentInspectionError();
    if (marker === 0xd9) throw contentInspectionError();
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    const segmentLength = readBigEndianUint16(bytes, offset);
    if (
      segmentLength === undefined
      || segmentLength < 2
      || offset + segmentLength > bytes.length
      || offset + segmentLength > headerEnd
    ) throw contentInspectionError();

    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (segmentLength < 8) throw contentInspectionError();
      const precision = bytes[offset + 2];
      const height = readBigEndianUint16(bytes, offset + 3);
      const width = readBigEndianUint16(bytes, offset + 5);
      const components = bytes[offset + 7];
      if (
        precision !== 8
        || height === undefined
        || width === undefined
        || components < 1
        || components > 4
        || segmentLength < 8 + components * 3
      ) throw contentInspectionError();
      assertOpaqueIntrinsicDimensions(width, height, maxPixels, maxEdge);
      return;
    }

    // PDF.js' built-in JPEG parser supports baseline, extended sequential,
    // and progressive SOFs (C0/C1/C2). Other SOFs are rejected by that parser;
    // DHT (C4) and DAC (CC), however, are ordinary table segments that may
    // legitimately precede the supported SOF and must be skipped.
    if (
      marker >= 0xc0
      && marker <= 0xcf
      && marker !== 0xc4
      && marker !== 0xcc
    ) throw contentInspectionError();
    if (marker === 0xda) throw contentInspectionError();
    offset += segmentLength;
  }
  throw contentInspectionError();
}

function hasJp2Signature(bytes: Uint8Array): boolean {
  return bytes.length >= 12
    && bytes[0] === 0x00
    && bytes[1] === 0x00
    && bytes[2] === 0x00
    && bytes[3] === 0x0c
    && bytes[4] === 0x6a
    && bytes[5] === 0x50
    && bytes[6] === 0x20
    && bytes[7] === 0x20
    && bytes[8] === 0x0d
    && bytes[9] === 0x0a
    && bytes[10] === 0x87
    && bytes[11] === 0x0a;
}

function inspectJpxSiz(
  bytes: Uint8Array,
  start: number,
  end: number,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
): void {
  const boundedEnd = Math.min(bytes.length, end, start + MAX_OPAQUE_IMAGE_HEADER_BYTES);
  let nextYield = start + CANCELLATION_YIELD_BYTES;
  for (let offset = start; offset + 1 < boundedEnd; offset += 1) {
    if (offset >= nextYield) {
      throwIfAborted(signal);
      nextYield = offset + CANCELLATION_YIELD_BYTES;
    }
    if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0x51) continue;
    const segmentLength = readBigEndianUint16(bytes, offset + 2);
    if (
      segmentLength === undefined
      || segmentLength < 38
      || offset + 2 + segmentLength > end
      || offset + 2 + segmentLength > boundedEnd
    ) throw contentInspectionError();
    const xSize = readBigEndianUint32(bytes, offset + 6);
    const ySize = readBigEndianUint32(bytes, offset + 10);
    const xOrigin = readBigEndianUint32(bytes, offset + 14);
    const yOrigin = readBigEndianUint32(bytes, offset + 18);
    const components = readBigEndianUint16(bytes, offset + 38);
    if (
      xSize === undefined
      || ySize === undefined
      || xOrigin === undefined
      || yOrigin === undefined
      || components === undefined
      || components < 1
      || components > MAX_IMAGE_COMPONENTS
      || xSize <= xOrigin
      || ySize <= yOrigin
      || segmentLength < 38 + components * 3
    ) throw contentInspectionError();
    assertOpaqueIntrinsicDimensions(
      xSize - xOrigin,
      ySize - yOrigin,
      maxPixels,
      maxEdge,
    );
    return;
  }
  throw contentInspectionError();
}

function inspectJpxIntrinsicDimensions(
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
): void {
  if (!hasJp2Signature(bytes)) {
    inspectJpxSiz(
      bytes,
      0,
      Math.min(bytes.length, MAX_OPAQUE_IMAGE_HEADER_BYTES),
      maxPixels,
      maxEdge,
      signal,
    );
    return;
  }

  let offset = 0;
  for (let boxIndex = 0; boxIndex < MAX_JPX_BOX_HEADERS; boxIndex += 1) {
    throwIfAborted(signal);
    if (offset + 8 > bytes.length) throw contentInspectionError();
    const boxLength32 = readBigEndianUint32(bytes, offset);
    if (boxLength32 === undefined) throw contentInspectionError();
    const typeOffset = offset + 4;
    let headerLength = 8;
    let boxLength = boxLength32;
    if (boxLength32 === 1) {
      const largeLength = readBigEndianUint64(bytes, offset + 8);
      if (largeLength === undefined || largeLength < 16) throw contentInspectionError();
      boxLength = largeLength;
      headerLength = 16;
    } else if (boxLength32 === 0) {
      boxLength = bytes.length - offset;
    }
    if (
      boxLength < headerLength
      || !Number.isSafeInteger(boxLength)
      || offset + boxLength > bytes.length
    ) throw contentInspectionError();
    const boxEnd = offset + boxLength;
    const isJp2c = bytes[typeOffset] === 0x6a
      && bytes[typeOffset + 1] === 0x70
      && bytes[typeOffset + 2] === 0x32
      && bytes[typeOffset + 3] === 0x63;
    if (isJp2c) {
      inspectJpxSiz(
        bytes,
        offset + headerLength,
        boxEnd,
        maxPixels,
        maxEdge,
        signal,
      );
      return;
    }
    offset = boxEnd;
    if (offset >= bytes.length) break;
  }
  throw contentInspectionError();
}

function inspectOpaqueImagePayload(
  bytes: Uint8Array,
  filter: string,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
): void {
  if (DCT_FILTERS.has(filter)) {
    inspectJpegIntrinsicDimensions(bytes, maxPixels, maxEdge, signal);
  } else if (JPX_FILTERS.has(filter)) {
    inspectJpxIntrinsicDimensions(bytes, maxPixels, maxEdge, signal);
  } else if (OPAQUE_IMAGE_FILTERS.has(filter)) {
    // JBIG2/CCITT/CCF dimensions are codec-dependent and PDF.js may decode
    // them into a surface larger than the image dictionary advertises. Until
    // a bounded header parser exists for each codec, reject them rather than
    // trusting a potentially malicious Width/Height pair.
    throw contentInspectionError();
  }
}

function inspectLosslessImagePayload(
  document: PDFDocument,
  contents: Uint8Array,
  filters: readonly string[],
  filterParams: readonly (PDFDict | undefined)[],
  metadata: ImagePayloadMetadata,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
): void {
  if (!filters.some(isLosslessImageFilter)) return;
  validateImageFilterChain(filters);
  const firstOpaqueIndex = filters.findIndex(isOpaqueImageFilter);
  const losslessEnd = firstOpaqueIndex >= 0 ? firstOpaqueIndex : filters.length;
  if (filters.slice(0, losslessEnd).some((filter) => !isLosslessImageFilter(filter))) {
    throw contentInspectionError();
  }
  if (
    firstOpaqueIndex >= 0
    && filters.slice(firstOpaqueIndex + 1).length > 0
  ) {
    // PDF.js composes streams in filter-list order, and an outer lossless
    // decoder can request/expand the opaque decoder's output without exposing
    // a bounded intrinsic length to this preflight. Do not accept a
    // potentially unbounded opaque->lossless (or second opaque) suffix merely
    // because the first codec's header is small; callers can remove the
    // suffix or flatten the image before importing.
    throw contentInspectionError();
  }
  if (losslessEnd === 0) return;
  const allowance = imageFilterDecodedByteAllowance(
    metadata,
    maxPixels,
    filterParams.slice(0, losslessEnd),
  );
  const prefixAllowance = Math.min(
    MAX_IMAGE_FILTER_DECODE_BYTES,
    Math.max(allowance, contents.length + 64 * 1024),
  );
  const decodedAllowance = firstOpaqueIndex >= 0 ? prefixAllowance : allowance;
  const limitError = imageFilterLimitError();
  let decoded = contents;
  try {
    for (let index = 0; index < losslessEnd; index += 1) {
      throwIfAborted(signal);
      const filter = filters[index];
      const params = filterParams[index];
      // ASCII wrappers can legitimately expand a small encoded payload before
      // a later Flate/LZW/RLE stage. Keep every intermediate bounded by a firm
      // 64 MiB ceiling and the already-loaded source length, then enforce the
      // dimension-derived allowance at the final decoded stage.
      const stageBytes = Math.min(
        MAX_IMAGE_FILTER_DECODE_BYTES,
        Math.max(allowance, decoded.length + 64 * 1024),
      );
      if (ASCII_HEX_FILTERS.has(filter)) {
        decoded = boundedAsciiHexDecode(decoded, stageBytes, signal, limitError);
      } else if (ASCII_85_FILTERS.has(filter)) {
        decoded = boundedAscii85Decode(decoded, stageBytes, signal, limitError);
      } else if (FLATE_FILTERS.has(filter)) {
        decoded = boundedFlateDecode(decoded, stageBytes, signal, limitError);
      } else if (LZW_FILTERS.has(filter) || RUN_LENGTH_FILTERS.has(filter)) {
        decoded = boundedPdfLibFilterDecode(
          PDFRawStream.of(document.context.obj({}) as PDFDict, decoded),
          decoded,
          filter,
          params,
          stageBytes,
          signal,
          limitError,
        );
      }
      if (decoded.length > decodedAllowance) throw limitError;
    }
    if (decoded.length > decodedAllowance) throw limitError;
    if (firstOpaqueIndex >= 0) {
      inspectOpaqueImagePayload(decoded, filters[firstOpaqueIndex], maxPixels, maxEdge, signal);
    }
  } catch (error) {
    if (isImageFilterLimitError(error)) throw embeddedImageLimitError();
    throw error;
  }
}

function combinedContentBytes(
  streams: readonly PDFStream[],
  context: InspectionContext,
): Uint8Array {
  const decoded: Uint8Array[] = [];
  let decodedLength = 0;
  for (const stream of streams) {
    const bytes = decodedContentBytes(
      stream,
      Math.min(
        MAX_PDF_DECODED_CONTENT_BYTES - decodedLength,
        MAX_PDF_DECODED_CONTENT_BYTES_PER_DOCUMENT - context.decodedContentBytes,
      ),
    );
    decoded.push(bytes);
    decodedLength += bytes.length;
    context.decodedContentBytes += bytes.length;
    if (context.decodedContentBytes > MAX_PDF_DECODED_CONTENT_BYTES_PER_DOCUMENT) {
      throw contentInspectionError();
    }
  }
  if (decoded.length === 1) return decoded[0];
  // PDF.js treats a Contents array as one byte-for-byte stream; operators and
  // names may legally cross an object boundary.
  const totalLength = decodedLength;
  if (
    !Number.isSafeInteger(totalLength)
    || totalLength > MAX_PDF_DECODED_CONTENT_BYTES
  ) throw contentInspectionError();
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const bytes of decoded) {
    combined.set(bytes, offset);
    offset += bytes.length;
  }
  return combined;
}

function contentStreams(contents: PDFStream | PDFArray | undefined): PDFStream[] {
  if (contents instanceof PDFStream) return [contents];
  if (!(contents instanceof PDFArray)) return [];
  const streams: PDFStream[] = [];
  for (let index = 0; index < contents.size(); index += 1) {
    try {
      const stream = contents.lookup(index);
      if (stream instanceof PDFStream) streams.push(stream);
    } catch {
      // PDF.js will provide the primary malformed-document error later.
    }
  }
  return streams;
}

function assertTraversalBudget(context: InspectionContext, depth: number, streamCount = 1): void {
  throwIfAborted(context.signal);
  if (depth > MAX_PDF_RESOURCE_DEPTH) throw contentInspectionError();
  context.inspectedStreams += streamCount;
  if (context.inspectedStreams > MAX_PDF_INSPECTED_STREAMS) throw contentInspectionError();
}

async function inspectImageStream(
  document: PDFDocument,
  stream: PDFStream,
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
  depth: number,
): Promise<void> {
  if (context.activeStreams.has(stream)) return;
  if (context.inspectedImages.has(stream)) return;
  assertTraversalBudget(context, depth);
  context.inspectedImages.add(stream);
  context.activeStreams.add(stream);
  try {
    // Match PDF.js' image-dictionary precedence when both aliases are present.
    const width = lookupNumber(stream.dict, WIDTH_SHORT, WIDTH);
    const height = lookupNumber(stream.dict, HEIGHT_SHORT, HEIGHT);
    if (width === undefined || height === undefined) throw contentInspectionError();
    assertImageEdge(width, height, maxEdge);
    assertImageDimensions(width, height, maxPixels, maxEdge);
    chargeEmbeddedImageBudget(
      context,
      width,
      height,
      stream instanceof PDFRawStream ? stream.contents.length : 0,
    );
    if (stream instanceof PDFRawStream) {
      const filters = filterNames(stream);
      validateImageFilterChain(filters);
      if (filters.some(isLosslessImageFilter)) {
        if (width === undefined || height === undefined) throw contentInspectionError();
        const metadata = imagePayloadMetadata(document, stream.dict, width, height);
        const filterParams = filters.map((_, index) => (
          decodeParamsForFilter(stream, index, filters.length)
        ));
        inspectLosslessImagePayload(
          document,
          stream.contents,
          filters,
          filterParams,
          metadata,
          maxPixels,
          maxEdge,
          context.signal,
        );
      } else if (filters.length > 0 && isOpaqueImageFilter(filters[0])) {
        inspectOpaqueImagePayload(
          stream.contents,
          filters[0],
          maxPixels,
          maxEdge,
          context.signal,
        );
      }
    }
    for (const key of [SOFT_MASK, MASK]) {
      const mask = lookupObject(document, stream.dict, key);
      if (mask instanceof PDFStream) {
        await inspectImageStream(document, mask, maxPixels, maxEdge, context, depth + 1);
      }
    }
  } finally {
    context.activeStreams.delete(stream);
  }
}

async function inspectAppearanceObject(
  document: PDFDocument,
  appearance: unknown,
  selectedState: string | undefined,
  inheritedResources: ResourceScope,
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
  depth: number,
): Promise<void> {
  if (appearance instanceof PDFStream) {
    await inspectContentStreams(
      document,
      [appearance],
      inheritedResources,
      "isolated",
      maxPixels,
      maxEdge,
      context,
      depth + 1,
    );
    return;
  }
  if (!(appearance instanceof PDFDict)) return;
  // PDF.js renders no state-dictionary appearance unless /AS selects one.
  if (!selectedState) return;
  const entries = appearance.entries().filter(([name]) => (
    normalizedPdfName(name.asString()) === selectedState
  ));
  for (const [, raw] of entries) {
    let stream: unknown;
    try {
      stream = document.context.lookup(raw);
    } catch {
      throw contentInspectionError();
    }
    if (stream instanceof PDFStream) {
      await inspectContentStreams(
        document,
        [stream],
        inheritedResources,
        "isolated",
        maxPixels,
        maxEdge,
        context,
        depth + 1,
      );
    }
  }
}

async function inspectAnnotations(
  document: PDFDocument,
  annotations: PDFArray | undefined,
  pageResources: ResourceScope,
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
): Promise<void> {
  if (!annotations) return;
  for (let index = 0; index < annotations.size(); index += 1) {
    throwIfAborted(context.signal);
    let annotation: unknown;
    try {
      annotation = annotations.lookup(index);
    } catch {
      throw contentInspectionError();
    }
    if (!(annotation instanceof PDFDict)) continue;
    const flags = lookupNumber(annotation, FLAGS) ?? 0;
    if ((flags & HIDDEN_ANNOTATION_FLAGS) !== 0) continue;
    const appearances = lookupDict(annotation, APPEARANCE);
    if (!appearances) continue;
    const normal = lookupObject(document, appearances, NORMAL_APPEARANCE);
    const state = lookupName(annotation, APPEARANCE_STATE)?.asString();
    await inspectAppearanceObject(
      document,
      normal,
      state ? normalizedPdfName(state) : undefined,
      pageResources,
      maxPixels,
      maxEdge,
      context,
      0,
    );
  }
}

async function inspectType3FontGlyphs(
  document: PDFDocument,
  font: PDFDict,
  glyphCodes: ReadonlySet<number>,
  fallbackResources: ResourceScope,
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
  depth: number,
): Promise<void> {
  if (
    normalizedPdfName(lookupName(font, SUBTYPE)?.asString() ?? "") !== TYPE3
  ) return;
  const charProcs = lookupDict(font, CHAR_PROCS);
  if (!charProcs) return;
  const selectedGlyphNames = type3GlyphNamesForCodes(document, font, glyphCodes);
  const fontResourceDict = lookupDict(font, RESOURCES);
  // PDF.js loads Type 3 CharProcs with the font's /Resources when present,
  // otherwise with the resource environment in which the font was selected.
  const fontResources: ResourceScope = fontResourceDict
    ? [fontResourceDict]
    : fallbackResources;
  const entries = selectedGlyphNames
    ? charProcs.entries().filter(([name]) => (
      selectedGlyphNames.has(normalizedPdfName(name.asString()))
    ))
    : charProcs.entries();
  for (const [, raw] of entries) {
    let charProc: unknown;
    try {
      charProc = document.context.lookup(raw);
    } catch {
      throw contentInspectionError();
    }
    if (charProc instanceof PDFStream) {
      await inspectContentStreams(
        document,
        [charProc],
        fontResources,
        "inherit",
        maxPixels,
        maxEdge,
        context,
        depth + 1,
      );
    }
  }
}

async function inspectContentStreams(
  document: PDFDocument,
  streams: readonly PDFStream[],
  inheritedResources: ResourceScope,
  resourceMode: "fallback" | "inherit" | "isolated" | "merge" | "replace",
  maxPixels: number,
  maxEdge: number | undefined,
  context: InspectionContext,
  depth: number,
  isPageContent = false,
  inheritedFont: ActiveFontState | null = null,
): Promise<void> {
  const available = streams.filter((stream) => !context.activeStreams.has(stream));
  if (!available.length) return;
  assertTraversalBudget(context, depth, available.length);
  for (const stream of available) context.activeStreams.add(stream);
  try {
    const streamResources = resourceMode !== "inherit" && available.length === 1
      ? lookupDict(available[0].dict, RESOURCES)
      : undefined;
    // PDF.js gives a Form's explicit /Resources dictionary replacement
    // semantics, but falls back to the caller's resources when /Resources is
    // absent. `isolated` is reserved for appearance streams, which do not
    // inherit the page resource environment.
    const resources: ResourceScope = streamResources
      ? resourceMode === "merge"
        ? [streamResources, ...inheritedResources]
        : [streamResources]
      : resourceMode === "isolated" ? [] : inheritedResources;
    const usage = await scanContent(
      document,
      combinedContentBytes(available, context),
      maxPixels,
      maxEdge,
      context,
      resources,
      inheritedFont,
    );

    for (const resourceName of usage.xObjects) {
      const object = resourceObject(document, resources, XOBJECT, resourceName);
      if (!(object instanceof PDFStream)) continue;
      const subtype = normalizedPdfName(lookupName(object.dict, SUBTYPE)?.asString() ?? "");
      if (subtype === IMAGE) {
        await inspectImageStream(document, object, maxPixels, maxEdge, context, depth + 1);
      } else if (subtype === FORM) {
        const stateMap = usage.xObjectFonts.get(resourceName);
        const inheritedFonts: Array<ActiveFontState | null> = [];
        if (stateMap) {
          for (const [fontKey, scopes] of stateMap) {
            for (const scope of scopes) {
              inheritedFonts.push(
                fontKey instanceof PDFDict
                  ? { font: fontKey, resources: scope }
                  : typeof fontKey === "string"
                    ? { resourceName: fontKey, resources: scope }
                    : null,
              );
            }
          }
        } else {
          inheritedFonts.push(null);
        }
        for (const inheritedFormFont of inheritedFonts) {
          await inspectContentStreams(
            document,
            [object],
            resources,
            isPageContent ? "replace" : "fallback",
            maxPixels,
            maxEdge,
            context,
            depth + 1,
            false,
            inheritedFormFont,
          );
        }
      }
    }

    for (const resourceName of usage.patterns) {
      const pattern = resourceObject(document, resources, PATTERN, resourceName);
      if (pattern instanceof PDFStream) {
        await inspectContentStreams(
          document,
          [pattern],
          resources,
          "merge",
          maxPixels,
          maxEdge,
          context,
          depth + 1,
        );
      }
    }

    for (const [resourceName, glyphCodes] of usage.fonts) {
      if (!glyphCodes.size) continue;
      const font = resourceObject(document, resources, FONT, resourceName);
      if (font instanceof PDFDict) {
        await inspectType3FontGlyphs(
          document,
          font,
          glyphCodes,
          resources,
          maxPixels,
          maxEdge,
          context,
          depth,
        );
      }
    }

    for (const [font, byResources] of usage.fontObjects) {
      for (const [fallbackResources, glyphCodes] of byResources) {
        if (!glyphCodes.size) continue;
        await inspectType3FontGlyphs(
          document,
          font,
          glyphCodes,
          fallbackResources,
          maxPixels,
          maxEdge,
          context,
          depth,
        );
      }
    }

    for (const resourceName of usage.extGStates) {
      const graphicsState = resourceObject(document, resources, EXT_G_STATE, resourceName);
      if (!(graphicsState instanceof PDFDict)) continue;
      const softMask = lookupObject(document, graphicsState, SOFT_MASK);
      if (!(softMask instanceof PDFDict)) continue;
      const group = lookupObject(document, softMask, GROUP);
      if (group instanceof PDFStream) {
        const stateMap = usage.extGStateFonts.get(resourceName);
        const inheritedFonts: Array<ActiveFontState | null> = [];
        if (stateMap) {
          for (const [fontKey, scopes] of stateMap) {
            for (const scope of scopes) {
              inheritedFonts.push(
                fontKey instanceof PDFDict
                  ? { font: fontKey, resources: scope }
                  : typeof fontKey === "string"
                    ? { resourceName: fontKey, resources: scope }
                    : null,
              );
            }
          }
        } else {
          inheritedFonts.push(null);
        }
        for (const inheritedGroupFont of inheritedFonts) {
          await inspectContentStreams(
            document,
            [group],
            resources,
            "fallback",
            maxPixels,
            maxEdge,
            context,
            depth + 1,
            false,
            inheritedGroupFont,
          );
        }
      }
    }
  } finally {
    for (const stream of available) context.activeStreams.delete(stream);
  }
}

function isExpectedInspectionError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError"
    || error.message === embeddedImageLimitError().message
    || error.message === imageFilterLimitError().message
    || error.message === contentInspectionError().message
    || /^The PDF has more than \d+ pages\.$/.test(error.message)
  );
}

async function inspectEmbeddedImageLimitsInline(
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
  maxTotalPixels = MAX_PDF_EMBEDDED_IMAGE_PIXELS,
  maxTotalEncodedBytes = MAX_PDF_EMBEDDED_IMAGE_BYTES,
): Promise<void> {
  throwIfAborted(signal);
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      parseSpeed: 100,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (isExpectedInspectionError(error)) throw error;
    // Safety inspection is fail-closed. Parser disagreement must not let a
    // crafted PDF bypass the image limits and rely on PDF.js silently dropping
    // content later.
    throw contentInspectionError();
  }
  throwIfAborted(signal);

  try {
    const pages = document.getPages();
    if (pages.length > MAX_PDF_PAGES) {
      throw new Error(`The PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    const context: InspectionContext = {
      activeStreams: new WeakSet<PDFStream>(),
      inspectedImages: new WeakSet<PDFStream>(),
      embeddedImagePixels: 0,
      embeddedImageBytes: 0,
      decodedContentBytes: 0,
      inspectedStreams: 0,
      resourceNameCount: 0,
      maxEmbeddedImagePixels: maxTotalPixels,
      maxEmbeddedImageBytes: maxTotalEncodedBytes,
      signal,
    };
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      if (pageIndex > 0 && pageIndex % 8 === 0) await yieldForCancellation(signal);
      const page = pages[pageIndex];
      const resources = page.node.Resources();
      const resourceScope: ResourceScope = resources ? [resources] : [];
      const contents = page.node.Contents();
      await inspectContentStreams(
        document,
        contentStreams(contents),
        resourceScope,
        contents instanceof PDFStream ? "merge" : "inherit",
        maxPixels,
        maxEdge,
        context,
        0,
        true,
      );
      await inspectAnnotations(
        document,
        page.node.Annots(),
        resourceScope,
        maxPixels,
        maxEdge,
        context,
      );
    }
  } catch (error) {
    if (isExpectedInspectionError(error)) throw error;
    throw contentInspectionError();
  }
}

interface EmbeddedImageWorkerResponse {
  message?: string;
  name?: string;
  ok: boolean;
}

/** Worker startup/transport failures may be retried with the bounded inline
 * inspector. Responses with `ok: false` are semantic verdicts from a running
 * worker and must be surfaced without a retry. */
class EmbeddedImageWorkerInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedImageWorkerInfrastructureError";
  }
}

const MAX_PDF_INSPECTION_MILLISECONDS = 30_000;

function canUseEmbeddedImageWorker(): boolean {
  return typeof window !== "undefined" && typeof Worker === "function";
}

function isEmbeddedImageWorkerInfrastructureError(error: unknown): boolean {
  return error instanceof EmbeddedImageWorkerInfrastructureError;
}

function inspectEmbeddedImageLimitsInWorker(
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
  maxTotalPixels = MAX_PDF_EMBEDDED_IMAGE_PIXELS,
  maxTotalEncodedBytes = MAX_PDF_EMBEDDED_IMAGE_BYTES,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./embedded-image-limits.worker.ts", import.meta.url),
        { type: "module", name: "patterdraw-pdf-image-limits" },
      );
    } catch (error) {
      reject(new EmbeddedImageWorkerInfrastructureError(
        error instanceof Error && error.message
          ? error.message
          : "PDF embedded-image worker could not be started.",
      ));
      return;
    }
    let finished = false;
    let timeout: ReturnType<typeof globalThis.setTimeout>;
    const finish = () => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const fail = (error: Error) => {
      finish();
      reject(error);
    };
    const onAbort = () => fail(abortReason(signal!));
    timeout = globalThis.setTimeout(() => {
      fail(new EmbeddedImageWorkerInfrastructureError(
        "PDF embedded-image worker timed out.",
      ));
    }, MAX_PDF_INSPECTION_MILLISECONDS);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<EmbeddedImageWorkerResponse>) => {
      const response = event.data;
      if (!response || typeof response.ok !== "boolean") {
        fail(new EmbeddedImageWorkerInfrastructureError(
          "PDF embedded-image worker returned an invalid response.",
        ));
        return;
      }
      if (response.ok) {
        finish();
        resolve();
        return;
      }
      const error = new Error(response.message || contentInspectionError().message);
      if (response.name) error.name = response.name;
      fail(error);
    };
    worker.onerror = (event) => fail(new EmbeddedImageWorkerInfrastructureError(
      event.message || "PDF embedded-image worker failed.",
    ));
    worker.onmessageerror = () => fail(new EmbeddedImageWorkerInfrastructureError(
      "PDF embedded-image worker returned unreadable data.",
    ));
    try {
      // Structured-cloning the caller's view preserves its buffer while
      // avoiding an eager full-size JS allocation. Transferring bytes.slice()
      // would still require that allocation and would not improve ownership
      // semantics for immutable source buffers.
      worker.postMessage(
        {
          bytes,
          maxPixels,
          maxEdge,
          maxTotalPixels,
          maxTotalEncodedBytes,
        },
      );
    } catch (error) {
      fail(new EmbeddedImageWorkerInfrastructureError(
        error instanceof Error && error.message
          ? error.message
          : "PDF embedded-image worker could not receive the request.",
      ));
    }
  });
}

async function inspectEmbeddedImageLimits(
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge: number | undefined,
  signal?: AbortSignal,
  maxTotalPixels = MAX_PDF_EMBEDDED_IMAGE_PIXELS,
  maxTotalEncodedBytes = MAX_PDF_EMBEDDED_IMAGE_BYTES,
): Promise<void> {
  if (canUseEmbeddedImageWorker()) {
    try {
      await inspectEmbeddedImageLimitsInWorker(
        bytes,
        maxPixels,
        maxEdge,
        signal,
        maxTotalPixels,
        maxTotalEncodedBytes,
      );
      return;
    } catch (error) {
      if (!isEmbeddedImageWorkerInfrastructureError(error)) throw error;
      // Abort must remain terminal, even if the worker failed at the same
      // moment. The inline inspector receives the same signal and limits.
      throwIfAborted(signal);
      await inspectEmbeddedImageLimitsInline(
        bytes,
        maxPixels,
        maxEdge,
        signal,
        maxTotalPixels,
        maxTotalEncodedBytes,
      );
      return;
    }
  }
  await inspectEmbeddedImageLimitsInline(
    bytes,
    maxPixels,
    maxEdge,
    signal,
    maxTotalPixels,
    maxTotalEncodedBytes,
  );
}

/** Worker entrypoint; callers should use assertPdfEmbeddedImageLimit. */
export async function inspectPdfEmbeddedImageLimitsInCurrentThread(
  bytes: Uint8Array,
  maxPixels: number,
  maxEdge?: number,
  maxTotalPixels?: number,
  maxTotalEncodedBytes?: number,
): Promise<void> {
  const budget = effectiveImageLimitBudget({ maxTotalPixels, maxTotalEncodedBytes });
  await inspectEmbeddedImageLimitsInline(
    bytes,
    maxPixels,
    maxEdge,
    undefined,
    budget.maxTotalPixels,
    budget.maxTotalEncodedBytes,
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function waitForPendingValidation(
  pending: PendingImageLimitValidation,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    pending.persistent = true;
    return pending.promise;
  }
  if (signal.aborted) return Promise.reject(abortReason(signal));
  pending.subscribers += 1;
  return new Promise<void>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", onAbort);
      pending.subscribers -= 1;
      if (!pending.persistent && pending.subscribers === 0) pending.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.promise.then(
      () => {
        release();
        resolve();
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}

function validationConstraintSatisfies(
  validated: ImageLimitConstraint,
  requested: ImageLimitConstraint,
): boolean {
  const validatedMaxEdge = validated.maxEdge ?? Number.POSITIVE_INFINITY;
  const requestedMaxEdge = requested.maxEdge ?? Number.POSITIVE_INFINITY;
  return validated.maxPixels <= requested.maxPixels
    && validatedMaxEdge <= requestedMaxEdge
    && validated.maxTotalPixels <= requested.maxTotalPixels
    && validated.maxTotalEncodedBytes <= requested.maxTotalEncodedBytes;
}

function validationConstraintKey(constraint: ImageLimitConstraint): string {
  return `${constraint.maxPixels}:${constraint.maxEdge ?? "none"}`
    + `:${constraint.maxTotalPixels}:${constraint.maxTotalEncodedBytes}`;
}

function rememberValidatedConstraint(
  state: ImageLimitCacheState,
  constraint: ImageLimitConstraint,
): void {
  // A successful validation under a stronger (smaller) pair of limits also
  // proves every looser request. Keep only the Pareto frontier so limits in
  // one dimension do not incorrectly mask a stricter request in the other.
  if (state.validated.some((existing) => (
    validationConstraintSatisfies(existing, constraint)
  ))) return;
  state.validated = state.validated.filter((existing) => (
    !validationConstraintSatisfies(constraint, existing)
  ));
  state.validated.push({ ...constraint });
  if (state.validated.length > MAX_VALIDATED_CONSTRAINTS_PER_PDF) {
    state.validated.shift();
  }
}

/**
 * Rejects rendered image XObjects, masks, and inline images before PDF.js can
 * silently omit them at its maxImageSize boundary. Completed checks are
 * cached only when the wrapper supplies the verified SHA-256 for its immutable
 * source bytes. Unkeyed callers are always reparsed, so mutating a Uint8Array
 * cannot reuse a stale validation. Pending checks with different constraints
 * remain independent so a stricter rejection cannot leak to a looser caller.
 */
export async function assertPdfEmbeddedImageLimit(
  bytes: Uint8Array,
  maxPixels: number,
  options: PdfEmbeddedImageLimitOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new Error("The PDF embedded-image limit is invalid.");
  }
  if (
    options.maxEdge !== undefined
    && (!Number.isSafeInteger(options.maxEdge) || options.maxEdge <= 0)
  ) {
    throw new Error("The PDF embedded-image edge limit is invalid.");
  }
  const imageBudget = effectiveImageLimitBudget(options);
  throwIfAborted(options.signal);
  const constraint: ImageLimitConstraint = {
    maxPixels,
    maxEdge: options.maxEdge,
    ...imageBudget,
  };
  const cacheKey = options.immutableSha256?.toLowerCase();
  if (!cacheKey || !/^[a-f0-9]{64}$/.test(cacheKey)) {
    await inspectEmbeddedImageLimits(
      bytes,
      maxPixels,
      options.maxEdge,
      options.signal,
      imageBudget.maxTotalPixels,
      imageBudget.maxTotalEncodedBytes,
    );
    return;
  }

  let state = validatedImageLimits.get(cacheKey);
  if (!state) {
    state = { validated: [], pending: new Map() };
    validatedImageLimits.set(cacheKey, state);
    if (validatedImageLimits.size > MAX_VALIDATED_PDF_CACHE_ENTRIES) {
      const oldest = validatedImageLimits.keys().next().value as string | undefined;
      if (oldest) validatedImageLimits.delete(oldest);
    }
  } else {
    validatedImageLimits.delete(cacheKey);
    validatedImageLimits.set(cacheKey, state);
  }
  if (state.validated.some((validated) => (
    validationConstraintSatisfies(validated, constraint)
  ))) {
    return;
  }

  const pendingKey = validationConstraintKey(constraint);
  let pending = state.pending.get(pendingKey);
  if (pending?.controller.signal.aborted) {
    state.pending.delete(pendingKey);
    pending = undefined;
  }
  if (!pending) {
    const controller = new AbortController();
    const promise = inspectEmbeddedImageLimits(
      bytes,
      maxPixels,
      options.maxEdge,
      controller.signal,
      imageBudget.maxTotalPixels,
      imageBudget.maxTotalEncodedBytes,
    );
    pending = {
      controller,
      persistent: !options.signal,
      promise,
      subscribers: 0,
    };
    state.pending.set(pendingKey, pending);
    const currentPending = pending;
    void promise.then(
      () => {
        rememberValidatedConstraint(state!, constraint);
      },
      () => undefined,
    ).finally(() => {
      if (state!.pending.get(pendingKey) === currentPending) state!.pending.delete(pendingKey);
    });
  }
  await waitForPendingValidation(pending, options.signal);
}
