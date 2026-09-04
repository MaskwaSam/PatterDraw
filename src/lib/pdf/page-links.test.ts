import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { degrees, PDFDocument, PDFName, PDFString } from "pdf-lib";

const { getDocumentMock } = vi.hoisted(() => ({ getDocumentMock: vi.fn() }));

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (elements: unknown[]) => elements,
}));

vi.mock("pdfjs-dist", async () => {
  const legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { GlobalWorkerOptions: legacy.GlobalWorkerOptions, getDocument: getDocumentMock };
});

import { getDocument as legacyGetDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  extractPdfPageLinks,
  MAX_PDF_PAGE_LINKS,
  normalizePdfLinkRectangle,
  sanitizePdfLinkUrl,
} from "./page-links";
import { MAX_PDF_LINK_URL_LENGTH } from "./link-url";

interface LinkFixture {
  url: string;
  rect?: number[];
  flags?: number;
  subtype?: string;
}

async function fixtureBytes(
  links: LinkFixture[],
  options: { rotation?: number; crop?: boolean; userUnit?: number; leadingPage?: boolean } = {},
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  if (options.leadingPage) document.addPage([100, 100]);
  const page = document.addPage([200, 300]);
  page.setRotation(degrees(options.rotation ?? 0));
  if (options.crop) page.setCropBox(20, 30, 100, 150);
  if (options.userUnit) page.node.set(PDFName.of("UserUnit"), document.context.obj(options.userUnit));
  page.node.set(PDFName.of("Annots"), document.context.obj(links.map((link) => (
    document.context.register(document.context.obj({
      Type: "Annot",
      Subtype: link.subtype ?? "Link",
      Rect: link.rect ?? [10, 20, 50, 40],
      F: link.flags ?? 0,
      A: { S: "URI", URI: PDFString.of(link.url) },
    }))
  ))));
  return document.save();
}

beforeAll(async () => {
  const workerModulePath = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  Object.assign(globalThis, { pdfjsWorker: await import(workerModulePath) });
});

beforeEach(() => {
  getDocumentMock.mockReset().mockImplementation(legacyGetDocument);
});

describe("PDF web link URL boundary", () => {
  it("retains a long GeoGon fragment without changing model state", () => {
    const url = `https://geogon.spatterson.ca/#state=${"Ab09_-".repeat(1_500)}`;
    expect(sanitizePdfLinkUrl(url)).toBe(url);
    expect(sanitizePdfLinkUrl("HTTP://Example.org:80/lesson?a=b#part"))
      .toBe("http://example.org/lesson?a=b#part");
  });

  it.each([
    null,
    {},
    "",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/lesson.pdf",
    "blob:https://example.org/a",
    "mailto:teacher@example.org",
    "//example.org/model",
    "/model",
    "www.example.org/model",
    "https:example.org",
    "https:///example.org",
    "https://",
    " https://example.org",
    "https://example.org\n",
    "https://exam\tple.org",
    "https://example.org/\u0000test",
    "https://example.org/%0Aheader",
    "https://example.org/%00test",
    "https://example.org/\u202etest",
    "https://user:secret@example.org",
    "https://@example.org",
    "https://example.org\\@other.example",
    "https://example.org:99999",
  ])("rejects non-web, implicit, deceptive, or malformed input %j", (input) => {
    expect(sanitizePdfLinkUrl(input)).toBeNull();
  });

  it("bounds both input and normalized URL length", () => {
    expect(sanitizePdfLinkUrl(`https://example.org/#${"a".repeat(MAX_PDF_LINK_URL_LENGTH)}`))
      .toBeNull();
    expect(sanitizePdfLinkUrl(`https://example.org/${"é".repeat(6_000)}`)).toBeNull();
  });
});

describe("local PDF source link extraction", () => {
  it.each([
    [0, { x: 10, y: 260, width: 40, height: 20 }],
    [90, { x: 20, y: 10, width: 20, height: 40 }],
    [180, { x: 150, y: 20, width: 40, height: 20 }],
    [270, { x: 260, y: 150, width: 20, height: 40 }],
  ] as const)("uses the actual PDF.js display coordinates for source rotation %i", async (rotation, expected) => {
    const url = "https://example.org/#state=lesson";
    const bytes = await fixtureBytes([{ url }], { rotation });
    await expect(extractPdfPageLinks(bytes, 0)).resolves.toEqual([{ url, ...expected }]);
  });

  it("selects the immutable source index and leaves project bytes intact", async () => {
    const bytes = await fixtureBytes([{ url: "https://example.org/" }], { leadingPage: true });
    const original = bytes.slice();
    await expect(extractPdfPageLinks(bytes, 0)).resolves.toEqual([]);
    await expect(extractPdfPageLinks(bytes, 1)).resolves.toHaveLength(1);
    expect(bytes).toEqual(original);
    expect(Object.is((getDocumentMock.mock.calls[0][0] as { data: Uint8Array }).data, bytes)).toBe(false);
    expect(getDocumentMock.mock.calls[0][0]).toMatchObject({
      enableScripting: false,
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      useWasm: false,
    });
    expect(getDocumentMock.mock.calls[0][0]).not.toHaveProperty("url");
  });

  it("clips to the crop box, incorporates UserUnit and drops empty/off-page rectangles", async () => {
    const bytes = await fixtureBytes([
      { url: "https://example.org/clipped", rect: [10, 20, 50, 60] },
      { url: "https://example.org/outside", rect: [-50, -50, -20, -20] },
      { url: "https://example.org/empty", rect: [40, 40, 40, 50] },
    ], { crop: true, userUnit: 2 });
    await expect(extractPdfPageLinks(bytes, 0)).resolves.toEqual([
      { url: "https://example.org/clipped", x: 0, y: 240, width: 60, height: 60 },
    ]);
  });

  it("rejects unsafe originals even if PDF.js offers a repaired web URL", async () => {
    const bytes = await fixtureBytes([
      { url: "www.example.org/model" },
      { url: "https://exam\tple.org/model" },
      { url: "javascript:alert(1)" },
      { url: "https://user:secret@example.org/model" },
      { url: "https://example.org/visible" },
      { url: "https://example.org/hidden", flags: 2 },
      { url: "https://example.org/no-view", flags: 32 },
      { url: "https://example.org/note", subtype: "Text" },
    ]);
    await expect(extractPdfPageLinks(bytes, 0)).resolves.toEqual([
      { url: "https://example.org/visible", x: 10, y: 260, width: 40, height: 20 },
    ]);
  });

  it("caps retained links on annotation-heavy pages", async () => {
    const bytes = await fixtureBytes(Array.from({ length: MAX_PDF_PAGE_LINKS + 3 }, (_, index) => ({
      url: `https://example.org/${index}`,
    })));
    const links = await extractPdfPageLinks(bytes, 0);
    expect(links).toHaveLength(MAX_PDF_PAGE_LINKS);
    expect(links.at(-1)?.url).toBe(`https://example.org/${MAX_PDF_PAGE_LINKS - 1}`);
  });

  it("rejects invalid source identities and an already-aborted request before loading", async () => {
    const bytes = await fixtureBytes([]);
    await expect(extractPdfPageLinks(bytes, -1)).rejects.toThrow(/source page is invalid/i);
    await expect(extractPdfPageLinks(bytes, 0.5)).rejects.toThrow(/source page is invalid/i);
    await expect(extractPdfPageLinks(new Uint8Array([0]), 0)).rejects.toThrow(/source bytes are invalid/i);
    const controller = new AbortController();
    controller.abort();
    await expect(extractPdfPageLinks(bytes, 0, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(getDocumentMock).not.toHaveBeenCalled();
    await expect(extractPdfPageLinks(bytes, 1)).rejects.toThrow(/source page does not exist/i);
  });

  it("destroys a pending loading task exactly once when navigation cancels it", async () => {
    const destroy = vi.fn(async () => undefined);
    getDocumentMock.mockReturnValueOnce({ promise: new Promise(() => undefined), destroy });
    const controller = new AbortController();
    const bytes = await fixtureBytes([]);
    const pending = extractPdfPageLinks(bytes, 0, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(destroy).toHaveBeenCalledExactlyOnceWith();
  });

  it("cleans up the page and document when annotation loading fails or is cancelled", async () => {
    const cleanup = vi.fn();
    const destroy = vi.fn(async () => undefined);
    const getAnnotations = vi.fn().mockRejectedValueOnce(new Error("broken annotations"));
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ cleanup, getAnnotations, getViewport: () => ({ width: 200, height: 300 }) }),
      }),
      destroy,
    });
    const bytes = await fixtureBytes([]);
    await expect(extractPdfPageLinks(bytes, 0)).rejects.toThrow("broken annotations");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();

    getAnnotations.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = extractPdfPageLinks(bytes, 0, { signal: controller.signal });
    await vi.waitFor(() => expect(getAnnotations).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});

describe("PDF link rectangle validation", () => {
  const viewport = { width: 200, height: 300, convertToViewportPoint: (x: number, y: number) => [x, 300 - y] };

  it("normalizes reversed rectangle endpoints", () => {
    expect(normalizePdfLinkRectangle([50, 40, 10, 20], viewport))
      .toEqual({ x: 10, y: 260, width: 40, height: 20 });
  });

  it.each([null, [], [0, 0, 10], [0, 0, 10, NaN], [0, 0, Infinity, 10], ["0", 0, 10, 10]])(
    "rejects invalid rectangle %j",
    (rectangle) => expect(normalizePdfLinkRectangle(rectangle, viewport)).toBeNull(),
  );

  it("rejects invalid viewport dimensions and overflowing transforms", () => {
    expect(normalizePdfLinkRectangle([0, 0, 10, 10], { ...viewport, width: Infinity })).toBeNull();
    expect(normalizePdfLinkRectangle([0, 0, 10, 10], { ...viewport, height: 0 })).toBeNull();
    expect(normalizePdfLinkRectangle([0, 0, 10, 10], {
      ...viewport,
      convertToViewportPoint: () => [Infinity, 0],
    })).toBeNull();
  });
});
