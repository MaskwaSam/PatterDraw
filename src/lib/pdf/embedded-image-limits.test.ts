import { afterEach, describe, expect, it, vi } from "vitest";
import { zlibSync } from "fflate";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFPage,
  PDFRef,
} from "pdf-lib";
import { MAX_PDF_PAGES } from "../safety";
import {
  MAX_PDF_DECODED_CONTENT_BYTES,
  MAX_PDF_DECODED_CONTENT_BYTES_PER_DOCUMENT,
  MAX_PDF_GRAPHICS_STATE_DEPTH,
  MAX_PDF_RESOURCE_NAMES,
  assertPdfEmbeddedImageLimit,
} from "./embedded-image-limits";

const OVERSIZED_EDGE = 4_097;
const IMAGE_LIMIT = 16_000_000;

class EmbeddedWorkerStartupFailure {
  constructor() {
    throw new Error("Failed to load embedded-image worker module (CSP/MIME).");
  }
}

class EmbeddedWorkerTransportFailure {
  static instances: EmbeddedWorkerTransportFailure[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(() => {
    queueMicrotask(() => this.onerror?.({ message: "404 loading worker module" } as ErrorEvent));
  });
  terminate = vi.fn();

  constructor() {
    EmbeddedWorkerTransportFailure.instances.push(this);
  }
}

class EmbeddedWorkerSemanticFailure {
  static instances: EmbeddedWorkerSemanticFailure[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn((request: { bytes: Uint8Array }) => {
    queueMicrotask(() => this.onmessage?.({
      data: {
        ok: false,
        name: "Error",
        message: "This PDF contains an embedded image that is too large to import safely.",
      },
    } as MessageEvent<unknown>));
    // Keep the request referenced so the test's worker stub mirrors a real
    // structured-clone boundary without detaching the caller's bytes.
    void request.bytes.byteLength;
  });
  terminate = vi.fn();

  constructor() {
    EmbeddedWorkerSemanticFailure.instances.push(this);
  }
}

class EmbeddedWorkerPending {
  static instances: EmbeddedWorkerPending[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    EmbeddedWorkerPending.instances.push(this);
  }
}

function ascii85Encode(bytes: Uint8Array): Uint8Array {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 4));
    let value = 0;
    for (let index = 0; index < 4; index += 1) value = value * 256 + (chunk[index] ?? 0);
    const digits = new Array<number>(5);
    for (let index = 4; index >= 0; index -= 1) {
      digits[index] = (value % 85) + 33;
      value = Math.floor(value / 85);
    }
    encoded += String.fromCharCode(...digits.slice(0, chunk.length + 1));
  }
  return new TextEncoder().encode(`${encoded}~>`);
}

function overwriteAscii(bytes: Uint8Array, before: string, after: string): void {
  expect(after).toHaveLength(before.length);
  const source = new TextEncoder().encode(before);
  const replacement = new TextEncoder().encode(after);
  const index = bytes.findIndex((_value, candidate) => (
    candidate + source.length <= bytes.length
    && source.every((value, offset) => bytes[candidate + offset] === value)
  ));
  expect(index).toBeGreaterThanOrEqual(0);
  bytes.set(replacement, index);
}

function registerDeclaredImage(
  document: PDFDocument,
  width: number,
  height: number,
  options: { mask?: PDFRef; shortDimensions?: boolean; softMask?: PDFRef } = {},
): PDFRef {
  const dimensions = options.shortDimensions
    ? { W: width, H: height }
    : { Width: width, Height: height };
  return document.context.register(document.context.stream(new Uint8Array([0]), {
    Type: PDFName.of("XObject"),
    Subtype: PDFName.of("Image"),
    ...dimensions,
    ColorSpace: PDFName.of("DeviceGray"),
    BitsPerComponent: 8,
    Mask: options.mask,
    SMask: options.softMask,
  }));
}

function addContent(
  document: PDFDocument,
  page: PDFPage,
  content: string | Uint8Array,
): void {
  page.node.addContentStream(document.context.register(document.context.stream(content)));
}

function setPageResource(
  document: PDFDocument,
  page: PDFPage,
  categoryName: string,
  resourceName: string,
  value: PDFObject,
): void {
  const resources = page.node.normalizedEntries().Resources;
  const categoryKey = PDFName.of(categoryName);
  const category = resources.lookupMaybe(categoryKey, PDFDict) ?? document.context.obj({});
  resources.set(categoryKey, category);
  category.set(PDFName.of(resourceName), value);
}

function paintImage(
  document: PDFDocument,
  page: PDFPage,
  imageRef: PDFRef,
  resourceName = "Im1",
  operandName = `/${resourceName}`,
): void {
  page.node.setXObject(PDFName.of(resourceName), imageRef);
  addContent(document, page, `q 100 0 0 100 0 0 cm ${operandName} Do Q`);
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function jpegHeader(
  width: number,
  height: number,
  components = 1,
  marker = 0xc0,
  includeDht = false,
): Uint8Array {
  const dqtLength = 67;
  const dqt = new Uint8Array(2 + dqtLength);
  dqt.set([0xff, 0xdb, 0x00, dqtLength, 0x00]);
  dqt.fill(1, 5);

  // A pair of one-entry Huffman tables is enough for a structurally valid
  // one-component scan (the entropy byte below encodes DC=0 + AC=EOB).
  const dhtLength = 38;
  const dht = new Uint8Array(2 + dhtLength);
  dht.set([0xff, 0xc4, 0x00, dhtLength]);
  let dhtOffset = 4;
  dht[dhtOffset++] = 0x00;
  dht[dhtOffset++] = 1;
  dht.fill(0, dhtOffset, dhtOffset + 15);
  dhtOffset += 15;
  dht[dhtOffset++] = 0x00;
  dht[dhtOffset++] = 0x10;
  dht[dhtOffset++] = 1;
  dht.fill(0, dhtOffset, dhtOffset + 15);
  dhtOffset += 15;
  dht[dhtOffset] = 0x00;

  const sofLength = 8 + components * 3;
  const sof = new Uint8Array(2 + sofLength);
  sof.set([0xff, marker, (sofLength >>> 8) & 0xff, sofLength & 0xff, 8]);
  sof[5] = (height >>> 8) & 0xff;
  sof[6] = height & 0xff;
  sof[7] = (width >>> 8) & 0xff;
  sof[8] = width & 0xff;
  sof[9] = components;
  for (let index = 0; index < components; index += 1) {
    const componentOffset = 10 + index * 3;
    sof[componentOffset] = index + 1;
    sof[componentOffset + 1] = 0x11;
    sof[componentOffset + 2] = 0;
  }

  const sos = new Uint8Array([
    0xff, 0xda, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ]);
  const entropy = new Uint8Array([0x3f]);
  const eoi = new Uint8Array([0xff, 0xd9]);
  const segments = includeDht
    ? [new Uint8Array([0xff, 0xd8]), dht, dqt, sof, sos, entropy, eoi]
    : [new Uint8Array([0xff, 0xd8]), dqt, sof, dht, sos, entropy, eoi];
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const segment of segments) {
    bytes.set(segment, offset);
    offset += segment.length;
  }
  return bytes;
}

function jpxRawHeader(width: number, height: number, components = 1): Uint8Array {
  const sizLength = 38 + components * 3;
  const bytes = new Uint8Array(6 + sizLength + 2);
  bytes.set([0xff, 0x4f, 0xff, 0x51, (sizLength >>> 8) & 0xff, sizLength & 0xff]);
  writeUint32(bytes, 8, width);
  writeUint32(bytes, 12, height);
  writeUint32(bytes, 16, 0);
  writeUint32(bytes, 20, 0);
  writeUint32(bytes, 24, 1);
  writeUint32(bytes, 28, 1);
  writeUint32(bytes, 32, 0);
  writeUint32(bytes, 36, 0);
  bytes[40] = (components >>> 8) & 0xff;
  bytes[41] = components & 0xff;
  for (let index = 0; index < components; index += 1) {
    const componentOffset = 44 + index * 3;
    bytes[componentOffset] = 7;
    bytes[componentOffset + 1] = 0;
    bytes[componentOffset + 2] = 0;
  }
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

function jpegWithEmbeddedEoi(width: number, height: number): Uint8Array {
  const source = jpegHeader(width, height, 1, 0xc0, true);
  const app = new Uint8Array([
    0xff, 0xe1, 0x00, 0x08,
    0x41, 0xff, 0xd9, 0x42, 0x43, 0x44,
  ]);
  const bytes = new Uint8Array(source.length + app.length);
  bytes.set(source.subarray(0, 2));
  bytes.set(app, 2);
  bytes.set(source.subarray(2), 2 + app.length);
  return bytes;
}

function jp2Wrap(codestream: Uint8Array): Uint8Array {
  const signature = new Uint8Array([
    0x00, 0x00, 0x00, 0x0c,
    0x6a, 0x50, 0x20, 0x20,
    0x0d, 0x0a, 0x87, 0x0a,
  ]);
  const box = new Uint8Array(8 + codestream.length);
  writeUint32(box, 0, box.length);
  box.set([0x6a, 0x70, 0x32, 0x63], 4);
  box.set(codestream, 8);
  const bytes = new Uint8Array(signature.length + box.length);
  bytes.set(signature);
  bytes.set(box, signature.length);
  return bytes;
}

function registerFilteredImage(
  document: PDFDocument,
  width: number,
  height: number,
  payload: Uint8Array,
  filter: PDFObject,
): PDFRef {
  return document.context.register(document.context.stream(payload, {
    Type: PDFName.of("XObject"),
    Subtype: PDFName.of("Image"),
    Width: width,
    Height: height,
    ColorSpace: PDFName.of("DeviceGray"),
    BitsPerComponent: 8,
    Filter: filter,
  }));
}

async function pdfWithDeclaredImage(
  width: number,
  height: number,
  painted = true,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const imageRef = registerDeclaredImage(document, width, height);
  if (painted) paintImage(document, page, imageRef);
  return document.save({ useObjectStreams: false });
}

async function pdfWithInlineImage(width: number, height: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const compressed = zlibSync(new Uint8Array(Math.ceil(width / 8) * height));
  const header = new TextEncoder().encode(
    `q 100 0 0 100 0 0 cm BI /W ${width} /H ${height} /CS /G /BPC 1 /F /Fl ID\n`,
  );
  const footer = new TextEncoder().encode("\nEI Q");
  const contentBytes = new Uint8Array(header.length + compressed.length + footer.length);
  contentBytes.set(header);
  contentBytes.set(compressed, header.length);
  contentBytes.set(footer, header.length + compressed.length);
  addContent(document, page, contentBytes);
  return document.save({ useObjectStreams: false });
}

async function saveDocumentWithOversizedImage(
  configure: (document: PDFDocument, page: PDFPage, imageRef: PDFRef) => void,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const imageRef = registerDeclaredImage(document, OVERSIZED_EDGE, OVERSIZED_EDGE);
  configure(document, page, imageRef);
  return document.save({ useObjectStreams: false });
}

function registerType3ImageFont(
  document: PDFDocument,
  imageRef: PDFRef,
  withResources = true,
): PDFRef {
  const charProcRef = document.context.register(document.context.stream("1000 0 d0 /Im1 Do"));
  return document.context.register(document.context.obj({
    Type: PDFName.of("Font"),
    Subtype: PDFName.of("Type3"),
    FontBBox: [0, 0, 1_000, 1_000],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { A: charProcRef },
    Encoding: { Type: PDFName.of("Encoding"), Differences: [65, PDFName.of("A")] },
    FirstChar: 65,
    LastChar: 65,
    Widths: [1_000],
    ...(withResources ? { Resources: { XObject: { Im1: imageRef } } } : {}),
  }));
}

async function pdfWithType3ImageScenario(
  width: number,
  height: number,
  configure: (document: PDFDocument, page: PDFPage, fontRef: PDFRef) => void,
  withResources = true,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const imageRef = registerDeclaredImage(document, width, height);
  const fontRef = registerType3ImageFont(document, imageRef, withResources);
  page.node.setFontDictionary(PDFName.of("F1"), fontRef);
  configure(document, page, fontRef);
  return document.save({ useObjectStreams: false });
}

function distinctXObjectNameContent(count: number, offset = 0): string {
  return Array.from(
    { length: count },
    (_value, index) => `/${(index + offset).toString(36)} Do`,
  ).join(" ");
}

async function pdfWithDistinctXObjectNames(count: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  addContent(document, page, distinctXObjectNameContent(count));
  return document.save({ useObjectStreams: false });
}

async function pdfWithNestedDistinctXObjectNames(namesPerStream: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([100, 100]);
  const childRef = document.context.register(document.context.stream(
    distinctXObjectNameContent(namesPerStream, namesPerStream),
    {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      BBox: [0, 0, 1, 1],
    },
  ));
  const rootRef = document.context.register(document.context.stream(
    `${distinctXObjectNameContent(namesPerStream)} /Next Do`,
    {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      BBox: [0, 0, 1, 1],
      Resources: { XObject: { Next: childRef } },
    },
  ));
  page.node.setXObject(PDFName.of("Root"), rootRef);
  addContent(document, page, "/Root Do");
  return document.save({ useObjectStreams: false });
}

describe("PDF embedded-image limits", () => {
  afterEach(() => {
    EmbeddedWorkerTransportFailure.instances.length = 0;
    EmbeddedWorkerSemanticFailure.instances.length = 0;
    EmbeddedWorkerPending.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it("falls back to the bounded inline inspector when the worker cannot start", async () => {
    vi.stubGlobal("Worker", EmbeddedWorkerStartupFailure);
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(100, 100),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
  });

  it("falls back once after a worker transport error", async () => {
    vi.stubGlobal("Worker", EmbeddedWorkerTransportFailure);
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(100, 100),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
    expect(EmbeddedWorkerTransportFailure.instances).toHaveLength(1);
    expect(EmbeddedWorkerTransportFailure.instances[0].postMessage).toHaveBeenCalledOnce();
    expect(EmbeddedWorkerTransportFailure.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("does not retry a semantic unsafe-PDF verdict from the worker", async () => {
    vi.stubGlobal("Worker", EmbeddedWorkerSemanticFailure);
    await expect(assertPdfEmbeddedImageLimit(
      new TextEncoder().encode("not a PDF"),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
    expect(EmbeddedWorkerSemanticFailure.instances).toHaveLength(1);
    expect(EmbeddedWorkerSemanticFailure.instances[0].postMessage).toHaveBeenCalledOnce();
  });

  it("does not run inline recovery after an abort", async () => {
    vi.stubGlobal("Worker", EmbeddedWorkerPending);
    const controller = new AbortController();
    const validation = assertPdfEmbeddedImageLimit(
      new TextEncoder().encode("not a PDF"),
      IMAGE_LIMIT,
      { signal: controller.signal },
    );
    controller.abort();

    await expect(validation).rejects.toMatchObject({ name: "AbortError" });
    expect(EmbeddedWorkerPending.instances).toHaveLength(1);
    expect(EmbeddedWorkerPending.instances[0].postMessage).toHaveBeenCalledOnce();
    expect(EmbeddedWorkerPending.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("enforces a caller-supplied cumulative budget across distinct images", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const first = registerDeclaredImage(document, 2, 2);
    const second = registerDeclaredImage(document, 2, 2);
    paintImage(document, page, first, "Im1");
    paintImage(document, page, second, "Im2");
    const bytes = await document.save({ useObjectStreams: false });

    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT, {
      maxTotalPixels: 6,
      maxTotalEncodedBytes: 2,
    })).rejects.toThrow(/too large to import safely/i);
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT, {
      maxTotalPixels: 8,
      maxTotalEncodedBytes: 2,
    })).resolves.toBeUndefined();
  });

  it("accepts painted image XObjects within the configured pixel budget", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(2_000, 2_000),
      4_000_000,
    )).resolves.toBeUndefined();
  });

  it("rejects a rectangular painted image that exceeds maxEdge under the area budget", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(3_000, 2_000),
      IMAGE_LIMIT,
      { maxEdge: 2_048 },
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("accepts a painted image whose dimensions are exactly maxEdge", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(2_048, 1_024),
      IMAGE_LIMIT,
      { maxEdge: 2_048 },
    )).resolves.toBeUndefined();
  });

  it("rejects a painted image XObject that PDF.js would otherwise omit silently", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(4_097, 4_097),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("bounds Flate expansion for a tiny filtered image XObject", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const bomb = zlibSync(new Uint8Array(4 * 1024 * 1024));
    const imageRef = document.context.register(document.context.stream(bomb, {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Image"),
      Width: 1,
      Height: 1,
      ColorSpace: PDFName.of("DeviceGray"),
      BitsPerComponent: 8,
      Filter: PDFName.of("FlateDecode"),
    }));
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("accepts a filtered image with a resource-named colorspace", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const imageRef = document.context.register(document.context.stream(
      zlibSync(new Uint8Array(3 * 1_000 * 1_000)),
      {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Image"),
        Width: 1_000,
        Height: 1_000,
        ColorSpace: PDFName.of("CS0"),
        BitsPerComponent: 8,
        Filter: PDFName.of("FlateDecode"),
      },
    ));
    setPageResource(document, page, "ColorSpace", "CS0", PDFName.of("DeviceRGB"));
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
  });

  it("bounds a lossless wrapper before an opaque JPEG decoder", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const bomb = zlibSync(new Uint8Array(4 * 1024 * 1024));
    const imageRef = document.context.register(document.context.stream(bomb, {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Image"),
      Width: 1,
      Height: 1,
      ColorSpace: PDFName.of("DeviceGray"),
      BitsPerComponent: 8,
      Filter: [PDFName.of("FlateDecode"), PDFName.of("DCTDecode")],
    }));
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("checks intrinsic JPEG SOF dimensions, including DHT metadata before the SOF", async () => {
    const oversized = await PDFDocument.create();
    const oversizedPage = oversized.addPage([100, 100]);
    const oversizedImage = registerFilteredImage(
      oversized,
      1,
      1,
      jpegHeader(5_000, 4_000, 1, 0xc0, true),
      PDFName.of("DCTDecode"),
    );
    paintImage(oversized, oversizedPage, oversizedImage);
    await expect(assertPdfEmbeddedImageLimit(
      await oversized.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);

    const safe = await PDFDocument.create();
    const safePage = safe.addPage([100, 100]);
    const safeImage = registerFilteredImage(
      safe,
      1,
      1,
      jpegHeader(64, 32, 1, 0xc0, true),
      PDFName.of("DCTDecode"),
    );
    paintImage(safe, safePage, safeImage);
    await expect(assertPdfEmbeddedImageLimit(
      await safe.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
  });

  it("checks JPEG intrinsic dimensions after a lossless prefix and rejects an opaque suffix pipeline", async () => {
    const prefixed = await PDFDocument.create();
    const prefixedPage = prefixed.addPage([100, 100]);
    const prefixedImage = registerFilteredImage(
      prefixed,
      1,
      1,
      zlibSync(jpegHeader(5_000, 4_000)),
      prefixed.context.obj([PDFName.of("FlateDecode"), PDFName.of("DCTDecode")]),
    );
    paintImage(prefixed, prefixedPage, prefixedImage);
    await expect(assertPdfEmbeddedImageLimit(
      await prefixed.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);

    const suffixed = await PDFDocument.create();
    const suffixedPage = suffixed.addPage([100, 100]);
    const suffixedImage = registerFilteredImage(
      suffixed,
      2,
      2,
      jpegHeader(2, 2),
      suffixed.context.obj([PDFName.of("DCTDecode"), PDFName.of("FlateDecode")]),
    );
    paintImage(suffixed, suffixedPage, suffixedImage);
    await expect(assertPdfEmbeddedImageLimit(
      await suffixed.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("checks intrinsic JPEG2000 SIZ dimensions in raw and JP2-wrapped payloads", async () => {
    const raw = await PDFDocument.create();
    const rawPage = raw.addPage([100, 100]);
    const rawImage = registerFilteredImage(
      raw,
      1,
      1,
      jpxRawHeader(5_000, 4_000),
      PDFName.of("JPXDecode"),
    );
    paintImage(raw, rawPage, rawImage);
    await expect(assertPdfEmbeddedImageLimit(
      await raw.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);

    const rawSafe = await PDFDocument.create();
    const rawSafePage = rawSafe.addPage([100, 100]);
    const rawSafeImage = registerFilteredImage(
      rawSafe,
      1,
      1,
      jpxRawHeader(32, 32),
      PDFName.of("JPXDecode"),
    );
    paintImage(rawSafe, rawSafePage, rawSafeImage);
    await expect(assertPdfEmbeddedImageLimit(
      await rawSafe.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();

    const wrapped = await PDFDocument.create();
    const wrappedPage = wrapped.addPage([100, 100]);
    const wrappedImage = registerFilteredImage(
      wrapped,
      1,
      1,
      jp2Wrap(jpxRawHeader(32, 32, 3)),
      PDFName.of("JPXDecode"),
    );
    paintImage(wrapped, wrappedPage, wrappedImage);
    await expect(assertPdfEmbeddedImageLimit(
      await wrapped.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();

    const wrappedOversized = await PDFDocument.create();
    const wrappedOversizedPage = wrappedOversized.addPage([100, 100]);
    const wrappedOversizedImage = registerFilteredImage(
      wrappedOversized,
      1,
      1,
      jp2Wrap(jpxRawHeader(5_000, 4_000, 3)),
      PDFName.of("JPXDecode"),
    );
    paintImage(wrappedOversized, wrappedOversizedPage, wrappedOversizedImage);
    await expect(assertPdfEmbeddedImageLimit(
      await wrappedOversized.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("fails closed when an opaque image has no usable intrinsic header", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const imageRef = registerFilteredImage(
      document,
      1,
      1,
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      PDFName.of("DCTDecode"),
    );
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("finds inline JPEG EOI after marker metadata containing FF D9", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const header = new TextEncoder().encode(
      "q 100 0 0 100 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 /F /DCT ID\n",
    );
    const payload = jpegWithEmbeddedEoi(2, 2);
    const footer = new TextEncoder().encode("\nEI Q");
    const content = new Uint8Array(header.length + payload.length + footer.length);
    content.set(header);
    content.set(payload, header.length);
    content.set(footer, header.length + payload.length);
    addContent(document, page, content);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
  });

  it("fails closed for Brotli and unsupported multi-opaque image filter chains", async () => {
    const brotli = await PDFDocument.create();
    const brotliPage = brotli.addPage([100, 100]);
    const brotliImage = registerFilteredImage(
      brotli,
      1,
      1,
      new Uint8Array([0]),
      PDFName.of("BrotliDecode"),
    );
    paintImage(brotli, brotliPage, brotliImage);
    await expect(assertPdfEmbeddedImageLimit(
      await brotli.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);

    const wrappedBrotli = await PDFDocument.create();
    const wrappedBrotliPage = wrappedBrotli.addPage([100, 100]);
    const wrappedBrotliImage = registerFilteredImage(
      wrappedBrotli,
      1,
      1,
      jpegHeader(1, 1),
      wrappedBrotli.context.obj([PDFName.of("BrotliDecode"), PDFName.of("DCTDecode")]),
    );
    paintImage(wrappedBrotli, wrappedBrotliPage, wrappedBrotliImage);
    await expect(assertPdfEmbeddedImageLimit(
      await wrappedBrotli.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);

    const multiOpaque = await PDFDocument.create();
    const multiOpaquePage = multiOpaque.addPage([100, 100]);
    const multiOpaqueImage = registerFilteredImage(
      multiOpaque,
      1,
      1,
      jpegHeader(1, 1),
      multiOpaque.context.obj([PDFName.of("DCTDecode"), PDFName.of("JPXDecode")]),
    );
    paintImage(multiOpaque, multiOpaquePage, multiOpaqueImage);
    await expect(assertPdfEmbeddedImageLimit(
      await multiOpaque.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);

    const inline = await PDFDocument.create();
    const inlinePage = inline.addPage([100, 100]);
    const inlineHeader = new TextEncoder().encode(
      "BI /W 1 /H 1 /CS /G /BPC 8 /F /BrotliDecode ID\n",
    );
    const inlineFooter = new TextEncoder().encode("\nEI");
    const inlineContent = new Uint8Array(inlineHeader.length + 1 + inlineFooter.length);
    inlineContent.set(inlineHeader);
    inlineContent.set([0], inlineHeader.length);
    inlineContent.set(inlineFooter, inlineHeader.length + 1);
    addContent(inline, inlinePage, inlineContent);
    await expect(assertPdfEmbeddedImageLimit(
      await inline.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("does not reject an oversized image XObject that no page paints", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDeclaredImage(4_097, 4_097, false),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
  });

  it("rejects an oversized inline image", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithInlineImage(4_097, 4_097),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("applies maxEdge to rectangular inline images", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithInlineImage(3_000, 2_000),
      IMAGE_LIMIT,
      { maxEdge: 2_048 },
    )).rejects.toThrow(/too large to import safely/i);
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithInlineImage(2_048, 1_024),
      IMAGE_LIMIT,
      { maxEdge: 2_048 },
    )).resolves.toBeUndefined();
  });

  it("bounds Flate expansion for a tiny inline image", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const bomb = zlibSync(new Uint8Array(4 * 1024 * 1024));
    const header = new TextEncoder().encode(
      "BI /W 1 /H 1 /CS /G /BPC 8 /F /Fl ID\n",
    );
    const footer = new TextEncoder().encode("\nEI");
    const content = new Uint8Array(header.length + bomb.length + footer.length);
    content.set(header);
    content.set(bomb, header.length);
    content.set(footer, header.length + bomb.length);
    addContent(document, page, content);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("matches lowercase hexadecimal escapes in painted XObject names", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      paintImage(document, page, imageRef, "Imageo", "/Image#6f");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("recognizes abbreviated image dimensions", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const imageRef = registerDeclaredImage(
      document,
      OVERSIZED_EDGE,
      OVERSIZED_EDGE,
      { shortDimensions: true },
    );
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("gives abbreviated dimensions the same precedence as PDF.js", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const imageRef = document.context.register(document.context.stream(new Uint8Array([0]), {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Image"),
      Width: 1,
      Height: 1,
      W: OVERSIZED_EDGE,
      H: OVERSIZED_EDGE,
      ColorSpace: PDFName.of("DeviceGray"),
      BitsPerComponent: 8,
    }));
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("checks resource operators split across a page's content streams", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(document, page, "q /Im1 ");
      addContent(document, page, "Do Q");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("checks an operator token split across page content streams", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(document, page, "q /Im1 D");
      addContent(document, page, "o Q");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("merges a single page content stream's local resources like PDF.js", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.set(PDFName.of("Resources"), document.context.obj({}));
      const contentRef = document.context.register(document.context.stream("/Im1 Do", {
        Resources: { XObject: { Im1: imageRef } },
      }));
      page.node.set(PDFName.of("Contents"), contentRef);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("does not merge stream-local resources from a page Contents array", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.set(PDFName.of("Resources"), document.context.obj({}));
      const contentRef = document.context.register(document.context.stream("/Im1 Do", {
        Resources: { XObject: { Im1: imageRef } },
      }));
      page.node.set(PDFName.of("Contents"), document.context.obj([contentRef]));
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("inherits page resources into a form without its own resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const formRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
      }));
      page.node.setXObject(PDFName.of("Form1"), formRef);
      addContent(document, page, "/Form1 Do");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("inherits an outer form's resources into a nested form that omits resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const innerRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
      }));
      const outerRef = document.context.register(document.context.stream("/Inner Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef, Inner: innerRef } },
      }));
      page.node.setXObject(PDFName.of("Outer"), outerRef);
      addContent(document, page, "/Outer Do");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("lets an empty nested-form resource dictionary suppress outer resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const innerRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: {},
      }));
      const outerRef = document.context.register(document.context.stream("/Inner Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef, Inner: innerRef } },
      }));
      page.node.setXObject(PDFName.of("Outer"), outerRef);
      addContent(document, page, "/Outer Do");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("rejects predictor-coded content instead of scanning pre-predictor bytes", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const decoded = new TextEncoder().encode("q /Im1 Do Q");
      const predicted = new Uint8Array(decoded.length + 1);
      predicted[0] = 1;
      predicted[1] = decoded[0];
      for (let index = 1; index < decoded.length; index += 1) {
        predicted[index + 1] = (decoded[index] - decoded[index - 1]) & 0xff;
      }
      const contentRef = document.context.register(document.context.stream(zlibSync(predicted), {
        Filter: PDFName.of("FlateDecode"),
        DecodeParms: {
          Predictor: 12,
          Colors: 1,
          BitsPerComponent: 8,
          Columns: decoded.length,
        },
      }));
      page.node.set(PDFName.of("Contents"), contentRef);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/could not be checked/i);
  });

  it("decodes supported filters in declared order", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const encoded = zlibSync(ascii85Encode(new TextEncoder().encode("/Im1 Do")));
      const contentRef = document.context.register(document.context.stream(encoded, {
        Filter: [PDFName.of("FlateDecode"), PDFName.of("ASCII85Decode")],
      }));
      page.node.set(PDFName.of("Contents"), contentRef);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("does not truncate content after ASCII85 zero-group shorthand", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const encodedOperator = ascii85Encode(new TextEncoder().encode("/Im1 Do"));
      const zeroGroups = new TextEncoder().encode("z".repeat(2_000));
      const encoded = new Uint8Array(zeroGroups.length + encodedOperator.length);
      encoded.set(zeroGroups);
      encoded.set(encodedOperator, zeroGroups.length);
      const contentRef = document.context.register(document.context.stream(encoded, {
        Filter: PDFName.of("ASCII85Decode"),
      }));
      page.node.set(PDFName.of("Contents"), contentRef);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("rejects a compressed content stream before it can expand without bound", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const expanded = new Uint8Array(MAX_PDF_DECODED_CONTENT_BYTES + 1);
    expanded.fill(0x20);
    const content = document.context.flateStream(expanded);
    page.node.addContentStream(document.context.register(content));
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("bounds decoded content across the whole document", async () => {
    const document = await PDFDocument.create();
    const decoded = new Uint8Array(8 * 1024 * 1024);
    for (let offset = 0; offset < decoded.length; offset += 2) {
      decoded[offset] = 0x71;
      decoded[offset + 1] = 0x20;
    }
    const contentRef = document.context.register(document.context.flateStream(decoded));
    const requiredPages = Math.floor(
      MAX_PDF_DECODED_CONTENT_BYTES_PER_DOCUMENT / decoded.length,
    ) + 1;
    for (let index = 0; index < requiredPages; index += 1) {
      const page = document.addPage([10, 10]);
      page.node.set(PDFName.of("Contents"), contentRef);
    }
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("uses page resources even when a page content stream declares its own", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const content = document.context.stream("/Im1 Do", { Resources: {} });
      page.node.addContentStream(document.context.register(content));
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("recognizes escaped inline-image dimension keys", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    addContent(
      document,
      page,
      `BI /#57 ${OVERSIZED_EDGE} /#48 ${OVERSIZED_EDGE} /CS /G /BPC 1 ID\n0\nEI`,
    );
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("gives abbreviated inline-image dimensions PDF.js precedence", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    addContent(
      document,
      page,
      `BI /W ${OVERSIZED_EDGE} /Width 1 /H ${OVERSIZED_EDGE} /Height 1 /CS /G /BPC 1 ID\n0\nEI`,
    );
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("checks images painted by a tiling pattern", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const pattern = document.context.stream("/Im1 Do", {
        Type: PDFName.of("Pattern"),
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 10, 10],
        XStep: 10,
        YStep: 10,
        Resources: { XObject: { Im1: imageRef } },
      });
      setPageResource(
        document,
        page,
        "Pattern",
        "P1",
        document.context.register(pattern),
      );
      addContent(document, page, "/Pattern cs /P1 scn 0 0 100 100 re f");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("merges inherited resources into a tiling pattern's local resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const pattern = document.context.stream("/Im1 Do", {
        Type: PDFName.of("Pattern"),
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [0, 0, 10, 10],
        XStep: 10,
        YStep: 10,
        Resources: { ExtGState: {} },
      });
      setPageResource(
        document,
        page,
        "Pattern",
        "P1",
        document.context.register(pattern),
      );
      addContent(document, page, "/Pattern cs /P1 scn 0 0 100 100 re f");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("does not accept a delimiter after a fake inline-image EI marker", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const header = new TextEncoder().encode("BI /W 6 /H 1 /CS /G /BPC 8 ID\n");
      const imageData = new Uint8Array([0x00, 0x20, 0x45, 0x49, 0x29, 0x28]);
      // PDF.js accepts the real EI without preceding whitespace, then paints
      // Im1. The earlier " EI)(" bytes are part of the inline raster.
      const footer = new TextEncoder().encode("EI Q /Im1 Do Q");
      const content = new Uint8Array(header.length + imageData.length + footer.length);
      content.set(header);
      content.set(imageData, header.length);
      content.set(footer, header.length + imageData.length);
      addContent(document, page, content);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("does not accept a fake EI followed by an operator with the wrong arity", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(
        document,
        page,
        "BI /W 8 /H 1 /CS /G /BPC 8 ID\n0 EI 1 2 q0EI Q /Im1 Do Q",
      );
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("fails closed when a fake EI is followed by an unterminated literal string", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(
        document,
        page,
        "BI /W 1 /H 1 /CS /G /BPC 8 ID\nxx EI ( /NotACommand blah\nEI Q /Im1 Do Q",
      );
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/could not be checked/i);
  });

  it("fails closed when a fake EI is followed by an unterminated hex string", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(
        document,
        page,
        "BI /W 1 /H 1 /CS /G /BPC 8 ID\nxx EI <4e6f7441436f6d6d616e64\nEI Q /Im1 Do Q",
      );
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/could not be checked/i);
  });

  it("fails closed when an inline image has no terminator", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    addContent(document, page, "BI /W 1 /H 1 /CS /G /BPC 8 ID\nunterminated");
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("fails closed when an inline image header has no data marker", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    addContent(document, page, "BI /W 1 /H 1 /CS /G /BPC 8 ");
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("recognizes EI at the first inline-image data byte", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(document, page, "BI /W 1 /H 1 /CS /G /BPC 8 ID\nEI Q /Im1 Do Q");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("ignores EI-like operators inside ASCII85 inline-image data", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(
        document,
        page,
        "BI /W 1 /H 1 /CS /G /BPC 8 /F /A85 ID\n!!!!! EI q /Im1 Do ~> EI Q",
      );
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("checks images painted by a used Type 3 font", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const charProcRef = document.context.register(document.context.stream("/Im1 Do"));
      const fontRef = document.context.register(document.context.obj({
        Type: PDFName.of("Font"),
        Subtype: PDFName.of("Type3"),
        FontBBox: [0, 0, 1_000, 1_000],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { A: charProcRef },
        Encoding: { Type: PDFName.of("Encoding"), Differences: [65, PDFName.of("A")] },
        FirstChar: 65,
        LastChar: 65,
        Widths: [1_000],
        Resources: { XObject: { Im1: imageRef } },
      }));
      page.node.setFontDictionary(PDFName.of("F1"), fontRef);
      addContent(document, page, "BT /F1 12 Tf (A) Tj ET");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("checks an oversized Type 3 glyph image through an inherited Form font", async () => {
    const bytes = await pdfWithType3ImageScenario(
      OVERSIZED_EDGE,
      OVERSIZED_EDGE,
      (document, page) => {
        const formRef = document.context.register(document.context.stream("BT (A) Tj ET", {
          Type: PDFName.of("XObject"),
          Subtype: PDFName.of("Form"),
          BBox: [0, 0, 100, 100],
        }));
        page.node.setXObject(PDFName.of("Form1"), formRef);
        addContent(document, page, "BT /F1 12 Tf ET /Form1 Do");
      },
    );
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("accepts a safe Type 3 glyph image through an inherited Form font", async () => {
    const bytes = await pdfWithType3ImageScenario(
      10,
      10,
      (document, page) => {
        const formRef = document.context.register(document.context.stream("BT (A) Tj ET", {
          Type: PDFName.of("XObject"),
          Subtype: PDFName.of("Form"),
          BBox: [0, 0, 100, 100],
        }));
        page.node.setXObject(PDFName.of("Form1"), formRef);
        addContent(document, page, "BT /F1 12 Tf ET /Form1 Do");
      },
    );
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("checks an oversized Type 3 glyph image selected through ExtGState /Font", async () => {
    const bytes = await pdfWithType3ImageScenario(
      OVERSIZED_EDGE,
      OVERSIZED_EDGE,
      (document, page, fontRef) => {
        page.node.setExtGState(PDFName.of("GS1"), document.context.obj({
          Type: PDFName.of("ExtGState"),
          Font: [fontRef, 12],
        }));
        addContent(document, page, "/GS1 gs BT (A) Tj ET");
      },
    );
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("accepts a safe Type 3 glyph image selected through ExtGState /Font", async () => {
    const bytes = await pdfWithType3ImageScenario(
      10,
      10,
      (document, page, fontRef) => {
        page.node.setExtGState(PDFName.of("GS1"), document.context.obj({
          Type: PDFName.of("ExtGState"),
          Font: [fontRef, 12],
        }));
        addContent(document, page, "/GS1 gs BT (A) Tj ET");
      },
    );
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("restores the active Type 3 font across nested q/Q graphics state", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const imageGlyphRef = document.context.register(document.context.stream("/Im1 Do"));
      const plainGlyphRef = document.context.register(document.context.stream("0 0 m"));
      const fontDictionary = (charProcs: { A: PDFRef; B: PDFRef }) => document.context.register(
        document.context.obj({
          Type: PDFName.of("Font"),
          Subtype: PDFName.of("Type3"),
          FontBBox: [0, 0, 1_000, 1_000],
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: charProcs,
          Encoding: {
            Type: PDFName.of("Encoding"),
            Differences: [65, PDFName.of("A"), PDFName.of("B")],
          },
          FirstChar: 65,
          LastChar: 66,
          Widths: [1_000, 1_000],
          Resources: { XObject: { Im1: imageRef } },
        }),
      );
      page.node.setFontDictionary(
        PDFName.of("F1"),
        fontDictionary({ A: imageGlyphRef, B: plainGlyphRef }),
      );
      page.node.setFontDictionary(
        PDFName.of("F2"),
        fontDictionary({ A: plainGlyphRef, B: plainGlyphRef }),
      );
      addContent(document, page, "BT /F1 12 Tf q /F2 12 Tf (B) Tj Q (A) Tj ET");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("keeps PDF.js unmatched Q as a no-op", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      addContent(document, page, "Q /Im1 Do");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("does not inspect an unused Type 3 glyph's image", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const aRef = document.context.register(document.context.stream("0 0 m"));
      const bRef = document.context.register(document.context.stream("/Im1 Do"));
      const fontRef = document.context.register(document.context.obj({
        Type: PDFName.of("Font"),
        Subtype: PDFName.of("Type3"),
        FontBBox: [0, 0, 1_000, 1_000],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { A: aRef, B: bRef },
        Encoding: {
          Type: PDFName.of("Encoding"),
          Differences: [65, PDFName.of("A"), PDFName.of("B")],
        },
        FirstChar: 65,
        LastChar: 66,
        Widths: [1_000, 1_000],
        Resources: { XObject: { Im1: imageRef } },
      }));
      page.node.setFontDictionary(PDFName.of("F1"), fontRef);
      addContent(document, page, "BT /F1 12 Tf (A) Tj ET");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("inherits page resources into a Type 3 font without resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const charProcRef = document.context.register(document.context.stream("/Im1 Do"));
      const fontRef = document.context.register(document.context.obj({
        Type: PDFName.of("Font"),
        Subtype: PDFName.of("Type3"),
        FontBBox: [0, 0, 1_000, 1_000],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { A: charProcRef },
        Encoding: { Type: PDFName.of("Encoding"), Differences: [65, PDFName.of("A")] },
        FirstChar: 65,
        LastChar: 65,
        Widths: [1_000],
      }));
      page.node.setFontDictionary(PDFName.of("F1"), fontRef);
      addContent(document, page, "BT /F1 12 Tf (A) Tj ET");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("checks images painted by a visible annotation appearance", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const appearanceRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef } },
      }));
      const annotationRef = document.context.register(document.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Stamp"),
        Rect: [0, 0, 100, 100],
        F: 4,
        AP: { N: appearanceRef },
      }));
      page.node.addAnnot(annotationRef);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("does not render an annotation appearance-state dictionary without AS", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const oversizedRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef } },
      }));
      const tinyRef = document.context.register(document.context.stream("0 0 m", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
      }));
      page.node.addAnnot(document.context.register(document.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Stamp"),
        Rect: [0, 0, 100, 100],
        AP: { N: { On: oversizedRef, Off: tinyRef } },
      })));
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("does not inherit page resources into an annotation appearance", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const appearanceRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
      }));
      page.node.addAnnot(document.context.register(document.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Stamp"),
        Rect: [0, 0, 100, 100],
        AP: { N: appearanceRef },
      })));
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("checks an Invisible-flag annotation that PDF.js still renders", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const appearanceRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef } },
      }));
      const annotationRef = document.context.register(document.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Stamp"),
        Rect: [0, 0, 100, 100],
        F: 1,
        AP: { N: appearanceRef },
      }));
      page.node.addAnnot(annotationRef);
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("checks images painted by an ExtGState soft-mask group", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      const groupRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: { XObject: { Im1: imageRef } },
      }));
      const graphicsState = document.context.obj({
        Type: PDFName.of("ExtGState"),
        SMask: { S: PDFName.of("Alpha"), G: groupRef },
      });
      page.node.setExtGState(PDFName.of("GS1"), graphicsState);
      addContent(document, page, "/GS1 gs 0 0 100 100 re f");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("inherits page resources into a soft-mask group that omits resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const groupRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
      }));
      const graphicsState = document.context.obj({
        Type: PDFName.of("ExtGState"),
        SMask: { S: PDFName.of("Alpha"), G: groupRef },
      });
      page.node.setExtGState(PDFName.of("GS1"), graphicsState);
      addContent(document, page, "/GS1 gs 0 0 100 100 re f");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("lets an empty soft-mask resource dictionary suppress page resources", async () => {
    const bytes = await saveDocumentWithOversizedImage((document, page, imageRef) => {
      page.node.setXObject(PDFName.of("Im1"), imageRef);
      const groupRef = document.context.register(document.context.stream("/Im1 Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 100, 100],
        Resources: {},
      }));
      const graphicsState = document.context.obj({
        Type: PDFName.of("ExtGState"),
        SMask: { S: PDFName.of("Alpha"), G: groupRef },
      });
      page.node.setExtGState(PDFName.of("GS1"), graphicsState);
      addContent(document, page, "/GS1 gs 0 0 100 100 re f");
    });
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
  });

  it("checks an image XObject's soft-mask image", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const maskRef = registerDeclaredImage(document, OVERSIZED_EDGE, OVERSIZED_EDGE);
    const imageRef = registerDeclaredImage(document, 10, 10, { softMask: maskRef });
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("checks an image XObject's explicit mask image", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const maskRef = registerDeclaredImage(document, OVERSIZED_EDGE, OVERSIZED_EDGE);
    const imageRef = registerDeclaredImage(document, 10, 10, { mask: maskRef });
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/too large to import safely/i);
  });

  it("rechecks a byte array when a later device uses a smaller limit", async () => {
    const bytes = await pdfWithDeclaredImage(2_000, 2_000);
    await expect(assertPdfEmbeddedImageLimit(bytes, 4_000_000)).resolves.toBeUndefined();
    await expect(assertPdfEmbeddedImageLimit(bytes, 3_999_999))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("rechecks an immutable cache entry when maxEdge gets stricter", async () => {
    const bytes = await pdfWithDeclaredImage(3_000, 1_000);
    const immutableSha256 = "c".repeat(64);
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT, {
      immutableSha256,
      maxEdge: 3_000,
    })).resolves.toBeUndefined();
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT, {
      immutableSha256,
      maxEdge: 2_999,
    })).rejects.toThrow(/too large to import safely/i);
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT, {
      immutableSha256,
      maxEdge: 3_000,
    })).resolves.toBeUndefined();
  });

  it("fails closed for malformed abbreviated image dimensions", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const imageRef = document.context.register(document.context.stream(new Uint8Array([0]), {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Image"),
      W: PDFName.of("Bad"),
      Width: OVERSIZED_EDGE,
      H: OVERSIZED_EDGE,
      Height: OVERSIZED_EDGE,
      ColorSpace: PDFName.of("DeviceGray"),
      BitsPerComponent: 8,
    }));
    paintImage(document, page, imageRef);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("normalizes malformed page resource errors", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const contentRef = document.context.register(document.context.stream("0 0 m"));
    page.node.set(PDFName.of("Contents"), contentRef);
    page.node.set(PDFName.of("Resources"), PDFName.of("Bad"));
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("rejects resource graphs deeper than the traversal budget", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    let nestedRef = document.context.register(document.context.stream("0 0 m", {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      BBox: [0, 0, 1, 1],
    }));
    for (let depth = 0; depth <= 256; depth += 1) {
      nestedRef = document.context.register(document.context.stream("/Next Do", {
        Type: PDFName.of("XObject"),
        Subtype: PDFName.of("Form"),
        BBox: [0, 0, 1, 1],
        Resources: { XObject: { Next: nestedRef } },
      }));
    }
    page.node.setXObject(PDFName.of("Root"), nestedRef);
    addContent(document, page, "/Root Do");
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("rejects a content stream that exceeds the graphics-state stack budget", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([10, 10]);
    addContent(document, page, `${"q ".repeat(MAX_PDF_GRAPHICS_STATE_DEPTH + 1)}0 0 m`);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("accepts distinct resource names just under the scanner budget", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDistinctXObjectNames(MAX_PDF_RESOURCE_NAMES - 1),
      IMAGE_LIMIT,
    )).resolves.toBeUndefined();
  });

  it("rejects a content stream over the distinct resource-name budget", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithDistinctXObjectNames(MAX_PDF_RESOURCE_NAMES + 1),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("applies the resource-name budget across nested content streams", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      await pdfWithNestedDistinctXObjectNames(33_000),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });

  it("rejects documents over the page-count limit before traversing every page", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index <= MAX_PDF_PAGES; index += 1) document.addPage([10, 10]);
    await expect(assertPdfEmbeddedImageLimit(
      await document.save({ useObjectStreams: false }),
      IMAGE_LIMIT,
    )).rejects.toThrow(`more than ${MAX_PDF_PAGES} pages`);
  });

  it("does not reuse an unkeyed validation after the caller mutates its bytes", async () => {
    const bytes = await pdfWithDeclaredImage(1_000, 1_000);
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT)).resolves.toBeUndefined();
    overwriteAscii(bytes, "/Width 1000", `/Width ${OVERSIZED_EDGE}`);
    overwriteAscii(bytes, "/Height 1000", `/Height ${OVERSIZED_EDGE}`);
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT))
      .rejects.toThrow(/too large to import safely/i);
  });

  it("aborts a long content scan after navigation", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const content = new Uint8Array(2 * 1024 * 1024).fill(0x20);
    addContent(document, page, content);
    const bytes = await document.save({ useObjectStreams: false });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(assertPdfEmbeddedImageLimit(bytes, IMAGE_LIMIT, {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps concurrent strict and loose validations independent", async () => {
    const bytes = await pdfWithDeclaredImage(2_000, 2_000);
    const [strict, loose] = await Promise.allSettled([
      assertPdfEmbeddedImageLimit(bytes, 3_999_999),
      assertPdfEmbeddedImageLimit(bytes, 4_000_000),
    ]);
    expect(strict.status).toBe("rejected");
    expect(loose.status).toBe("fulfilled");
  });

  it("rejects invalid limit values before parsing", async () => {
    await expect(assertPdfEmbeddedImageLimit(new Uint8Array(), 0))
      .rejects.toThrow(/limit is invalid/i);
  });

  it("fails closed when the safety parser cannot load the PDF", async () => {
    await expect(assertPdfEmbeddedImageLimit(
      new TextEncoder().encode("not a PDF"),
      IMAGE_LIMIT,
    )).rejects.toThrow(/could not be checked/i);
  });
});
