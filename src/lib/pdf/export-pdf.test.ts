import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { exportToCanvas } from "@excalidraw/excalidraw";
import {
  degrees,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFStream,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ClassroomProject, SerializedScene } from "../../types";
import transparencyGroupFixtureUrl from "../../../tests/fixtures/pdf/page-transparency-group.pdf?inline";
import reportLabAcroFormFixtureUrl from "../../../tests/fixtures/pdf/reportlab-acroform.pdf?inline";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToCanvas: vi.fn(),
  getCommonBounds: (elements: Array<{ x: number; y: number; width: number; height: number }>) => [
    Math.min(...elements.map((element) => element.x)),
    Math.min(...elements.map((element) => element.y)),
    Math.max(...elements.map((element) => element.x + element.width)),
    Math.max(...elements.map((element) => element.y + element.height)),
  ],
}));

import {
  exportAnnotatedPdf,
  exportAnnotatedPdfWithDiagnostics,
  exportSlidesPdf,
  getPdfAnnotationExportDimensions,
  getPdfAnnotationRasterBudget,
  getPdfPageExportBounds,
  getSlidePdfExportDimensions,
  normalizePdfExportError,
  PdfExportError,
  PdfExportLimitError,
  PdfHybridFallbackRequiredError,
} from "./export-pdf";
import { getPdfRasterBudget } from "./raster-limits";
import { copySourcePageTransparencyGroup } from "./source-page";

const baseElement = {
  id: "background",
  type: "image",
  x: 0,
  y: 0,
  width: 600,
  height: 800,
  angle: 0,
  strokeWidth: 1,
  isDeleted: false,
};

function fullAnnotation(overrides: Record<string, unknown> = {}) {
  return {
    id: "annotation",
    type: "rectangle",
    x: 20,
    y: 20,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "#ff0000",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roundness: null,
    roughness: 0,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 1,
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...overrides,
  };
}

function projectWithAnnotations(
  sourceByteLength: number,
  annotations: readonly Record<string, unknown>[],
): ClassroomProject {
  const scene = {
    id: "page",
    name: "Page 1",
    elements: [baseElement, ...annotations],
    appState: {},
    files: {},
    pdfPage: {
      documentId: "pdf",
      pageIndex: 0,
      width: 160,
      height: 160,
      rotation: 0 as const,
      backgroundElementId: "background",
    },
  } satisfies SerializedScene;
  return {
    schemaVersion: 1,
    id: "hybrid-project",
    title: "Hybrid annotations",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    activeSceneId: scene.id,
    scenes: { [scene.id]: scene },
    slideOrder: [],
    pdfPageOrder: [scene.id],
    pdfDocuments: {
      pdf: {
        id: "pdf",
        name: "hybrid-source.pdf",
        mimeType: "application/pdf",
        byteLength: sourceByteLength,
        pageCount: 1,
        archivePath: "documents/pdf.pdf",
      },
    },
  };
}

function blankPdfProjectForIntegrity(
  byteLength: number,
  sha256?: string,
): ClassroomProject {
  const scene = {
    id: "page",
    name: "Blank page",
    elements: [baseElement],
    appState: {},
    files: {},
    pdfPage: {
      documentId: "pdf",
      pageIndex: 0,
      width: 600,
      height: 800,
      rotation: 0,
      backgroundElementId: "background",
    },
  } satisfies SerializedScene;
  return {
    schemaVersion: 1,
    id: "project",
    title: "Blank worksheet",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    activeSceneId: "page",
    scenes: { page: scene },
    slideOrder: [],
    pdfDocuments: {
      pdf: {
        id: "pdf",
        name: "blank.pdf",
        mimeType: "application/pdf",
        byteLength,
        pageCount: 1,
        archivePath: "documents/pdf.pdf",
        ...(sha256 ? { sha256 } : {}),
      },
    },
  };
}

const standardFontDataUrl = decodeURIComponent(new URL(
  "./standard_fonts/",
  import.meta.resolve("pdfjs-dist/package.json"),
).pathname);

interface RenderedPdfPage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  operators: number[];
  text: string;
}

async function loadPdfFixture(dataUrl: string): Promise<Uint8Array> {
  const response = await fetch(dataUrl);
  return new Uint8Array(await response.arrayBuffer());
}

async function renderPdfPage(
  bytes: Uint8Array,
  pageNumber: number,
  scale = 1,
): Promise<RenderedPdfPage> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl,
  });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        background: "#ffffff",
      }).promise;
      const operatorList = await page.getOperatorList();
      const textContent = await page.getTextContent();
      return {
        width,
        height,
        rgba: Uint8ClampedArray.from(context.getImageData(0, 0, width, height).data),
        operators: Array.from(operatorList.fnArray),
        text: textContent.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" "),
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

function colorBounds(
  page: RenderedPdfPage,
  matches: (red: number, green: number, blue: number, alpha: number) => boolean,
): readonly [number, number, number, number] | null {
  let minX = page.width;
  let minY = page.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < page.height; y += 1) {
    for (let x = 0; x < page.width; x += 1) {
      const offset = (y * page.width + x) * 4;
      if (!matches(
        page.rgba[offset],
        page.rgba[offset + 1],
        page.rgba[offset + 2],
        page.rgba[offset + 3],
      )) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX, maxY];
}

function normalizedBounds(
  page: RenderedPdfPage,
  bounds: readonly [number, number, number, number] | null,
): number[] {
  if (!bounds) return [];
  return [
    bounds[0] / page.width,
    bounds[1] / page.height,
    bounds[2] / page.width,
    bounds[3] / page.height,
  ];
}

function rotateRenderedBounds(
  bounds: readonly [number, number, number, number],
  width: number,
  height: number,
  rotation: 0 | 90 | 180 | 270,
): readonly [number, number, number, number] {
  const points = [
    [bounds[0], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[1]],
    [bounds[2], bounds[3]],
  ].map(([x, y]) => {
    if (rotation === 90) return [height - y, x];
    if (rotation === 180) return [width - x, height - y];
    if (rotation === 270) return [y, width - x];
    return [x, y];
  });
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

async function createPdfFidelityFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fixedDate = new Date("2026-01-01T00:00:00.000Z");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const widgetPage = pdf.addPage([240, 160]);
  const form = pdf.getForm();
  const field = form.createTextField("fixture.answer");
  field.setText("FORM ONLY");
  field.addToPage(widgetPage, {
    x: 30,
    y: 55,
    width: 180,
    height: 44,
    font,
    borderWidth: 2,
    borderColor: rgb(1, 0, 1),
    backgroundColor: rgb(1, 1, 0),
    textColor: rgb(0, 0, 0),
  });
  const checkbox = form.createCheckBox("fixture.checked");
  checkbox.addToPage(widgetPage, {
    x: 8,
    y: 8,
    width: 24,
    height: 24,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
    backgroundColor: rgb(0, 1, 1),
  });
  checkbox.check();

  const stampPage = pdf.addPage([240, 160]);
  const appearance = pdf.context.flateStream(
    "q 1 0 1 rg 0 0 100 50 re f 0 1 0 rg 5 5 20 10 re f Q",
    {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: [0, 0, 100, 50],
      Matrix: [0, 1, -1, 0, 50, 0],
      Resources: {},
    },
  );
  const appearanceRef = pdf.context.register(appearance);
  const stamp = pdf.context.obj({
    Type: "Annot",
    Subtype: "Stamp",
    Rect: [40, 55, 140, 105],
    F: 4,
    AP: { N: appearanceRef },
  });
  stampPage.node.addAnnot(pdf.context.register(stamp));

  for (const rotation of [0, 90, 180, 270] as const) {
    const geometryPage = pdf.addPage([612, 792]);
    geometryPage.setCropBox(72, 108, 360, 480);
    geometryPage.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
    geometryPage.setRotation(degrees(rotation));
    geometryPage.drawRectangle({
      x: 82,
      y: 118,
      width: 36,
      height: 28,
      color: rgb(1, 0, 0),
    });
    geometryPage.drawRectangle({
      x: 386,
      y: 540,
      width: 36,
      height: 28,
      color: rgb(0, 0, 1),
    });
    geometryPage.drawText(`VECTOR_SENTINEL_${rotation}`, {
      x: 150,
      y: 340,
      size: 18,
      font,
    });
  }

  expect(widgetPage.node.Contents()).toBeUndefined();
  expect(stampPage.node.Contents()).toBeUndefined();
  expect(widgetPage.node.Annots()).toBeDefined();
  expect(stampPage.node.Annots()).toBeDefined();
  return pdf.save({ useObjectStreams: false });
}

describe("PDF export bounds", () => {
  it("keeps the source page bounds when there are no annotations", () => {
    const scene = {
      id: "page",
      name: "Page 1",
      elements: [baseElement],
      appState: {},
      files: {},
      pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
    } satisfies SerializedScene;
    expect(getPdfPageExportBounds(scene)).toEqual({ minX: 0, minY: 0, maxX: 600, maxY: 800, width: 600, height: 800 });
  });

  it("expands beyond every source-page edge", () => {
    const annotations = [
      { ...baseElement, id: "top-left", type: "rectangle", x: -100, y: -50, width: 20, height: 20 },
      { ...baseElement, id: "bottom-right", type: "rectangle", x: 650, y: 900, width: 30, height: 40 },
    ];
    const scene = {
      id: "page",
      name: "Page 1",
      elements: [baseElement, ...annotations],
      appState: {},
      files: {},
      pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
    } satisfies SerializedScene;
    const bounds = getPdfPageExportBounds(scene);
    expect(bounds.minX).toBeLessThan(-100);
    expect(bounds.minY).toBeLessThan(-50);
    expect(bounds.maxX).toBeGreaterThan(680);
    expect(bounds.maxY).toBeGreaterThan(940);
  });

  it("derives bounds from the same exportable annotation set used by rendering", () => {
    const included = {
      ...baseElement,
      id: "included",
      type: "rectangle",
      x: -10,
      y: -20,
      width: 20,
      height: 20,
    };
    const scene = {
      id: "page",
      name: "Page 1",
      elements: [
        baseElement,
        included,
        { ...included, id: "frame", type: "frame", x: -50_000 },
        { ...included, id: "embed", type: "iframe", y: 50_000 },
        { ...included, id: "deleted", isDeleted: true, x: 75_000 },
      ],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;

    expect(getPdfPageExportBounds(scene)).toEqual({
      minX: -34,
      minY: -44,
      maxX: 600,
      maxY: 800,
      width: 634,
      height: 844,
    });
  });

  it("normalizes encrypted and unsupported export failures with recovery guidance", () => {
    const encrypted = normalizePdfExportError(
      new Error("Input document is encrypted"),
      "locked.pdf",
    );
    expect(encrypted).toBeInstanceOf(PdfExportError);
    expect(encrypted).toMatchObject({ code: "encrypted-source" });
    expect(encrypted.message).toMatch(/unlocked copy.*re-import/i);

    const unsupported = normalizePdfExportError(
      new Error("visible Widget annotation without a reusable appearance"),
      "form.pdf",
    );
    expect(unsupported).toBeInstanceOf(PdfExportError);
    expect(unsupported).toMatchObject({ code: "unsupported-source" });
    expect(unsupported.message).toMatch(/flattened copy.*re-import/i);
  });

  it("caps raster dimensions for annotations spread a million units apart", () => {
    const dimensions = getPdfAnnotationExportDimensions(1_000_000, 1_000_000);
    expect(dimensions.width).toBeLessThanOrEqual(8_192);
    expect(dimensions.height).toBeLessThanOrEqual(8_192);
    expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(16_000_000);
    expect(dimensions.scale).toBeLessThan(0.01);
  });

  it("uses the active low-memory budget for annotation and slide rasters", () => {
    const budget = getPdfRasterBudget({ deviceMemory: 2, hardwareConcurrency: 2 });
    const annotations = getPdfAnnotationExportDimensions(10_000, 10_000, 1, budget);
    const slide = getSlidePdfExportDimensions(10_000, 10_000, budget);
    expect(annotations.width * annotations.height).toBeLessThanOrEqual(4_000_000);
    expect(slide.width * slide.height).toBeLessThanOrEqual(4_000_000);
    expect(annotations.width).toBeLessThanOrEqual(4_096);
    expect(slide.height).toBeLessThanOrEqual(4_096);
  });

  it("shares raster memory across annotated pages rather than blank source pages", () => {
    const blankScene = {
      id: "blank",
      name: "Blank",
      elements: [baseElement],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const annotation = {
      ...baseElement,
      id: "annotation",
      type: "rectangle",
      x: 20,
      y: 30,
      width: 100,
      height: 80,
    };
    const scenes = Array.from({ length: 250 }, (_, pageIndex) => ({
      ...blankScene,
      id: `page-${pageIndex}`,
      elements: pageIndex === 249 ? [baseElement, annotation] : [baseElement],
      pdfPage: {
        ...blankScene.pdfPage,
        pageIndex,
      },
    }));
    const lowMemoryBudget = getPdfRasterBudget({
      deviceMemory: 2,
      hardwareConcurrency: 2,
    });

    expect(
      getPdfAnnotationRasterBudget(scenes, lowMemoryBudget).maxPixelsPerPage,
    ).toBe(4_000_000);
  });

  it("renders OpenBoard-fit annotations only at the resolution needed by the fitted page", () => {
    expect(getPdfAnnotationExportDimensions(6_000, 8_000, 0.1)).toEqual({
      width: 1_200,
      height: 1_600,
      scale: 0.2,
    });
  });

  it("rejects non-finite annotation bounds", () => {
    expect(() => getPdfAnnotationExportDimensions(Number.POSITIVE_INFINITY, 800)).toThrow(/positive finite/);
  });

  it("caps presentation slide raster allocation", () => {
    const dimensions = getSlidePdfExportDimensions(10_000, 10_000);
    expect(dimensions.width).toBeLessThanOrEqual(8_192);
    expect(dimensions.height).toBeLessThanOrEqual(8_192);
    expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(16_000_000);
  });

  it("rejects presentation slide pages beyond the safe PDF edge", () => {
    expect(() => getSlidePdfExportDimensions(14_401, 800)).toThrow(/no larger than 200 inches/);
  });

  it("composes a fresh PDF while preserving page count and dimensions", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]).drawRectangle({ x: 40, y: 40, width: 120, height: 80 });
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Page 1",
      elements: [baseElement],
      appState: {},
      files: {},
      pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Worksheet",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: { id: "pdf", name: "source.pdf", mimeType: "application/pdf", byteLength: sourceBytes.byteLength, pageCount: 1, archivePath: "documents/pdf.pdf" },
      },
    } satisfies ClassroomProject;
    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes }, "expand");
    const output = await PDFDocument.load(await outputBlob.arrayBuffer());
    expect(output.getPageCount()).toBe(1);
    expect(output.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
  });

  it("exports a view-rotated page at display dimensions without changing source bytes", async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([600, 800]);
    sourcePage.drawRectangle({ x: 20, y: 30, width: 80, height: 40 });
    const sourceBytes = await source.save();
    const sourceSha = await (await import("../sha256")).sha256Hex(sourceBytes);
    const scene = {
      id: "rotated-page",
      name: "Rotated page",
      elements: [{ ...baseElement }],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0 as const,
        viewRotation: 90 as const,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "rotated-project",
      title: "Rotated",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      activeSceneId: scene.id,
      scenes: { [scene.id]: scene },
      slideOrder: [],
      pdfPageOrder: [scene.id],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "source.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          sha256: sourceSha,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const output = await PDFDocument.load(await outputBlob.arrayBuffer());
    expect(output.getPage(0).getSize()).toEqual({ width: 800, height: 600 });
    expect(await (await import("../sha256")).sha256Hex(sourceBytes)).toBe(sourceSha);
  });

  it("combines immutable source rotation with a view turn during export", async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([600, 800]);
    sourcePage.setRotation(degrees(90));
    sourcePage.drawRectangle({ x: 20, y: 30, width: 80, height: 40 });
    const sourceBytes = await source.save();
    const scene = {
      id: "source-and-view-rotated-page",
      name: "Source and view rotated page",
      elements: [{ ...baseElement, width: 800, height: 600 }],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 800,
        height: 600,
        rotation: 90 as const,
        viewRotation: 90 as const,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "source-and-view-rotated-project",
      title: "Source and view rotated",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      activeSceneId: scene.id,
      scenes: { [scene.id]: scene },
      slideOrder: [],
      pdfPageOrder: [scene.id],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "source.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const output = await PDFDocument.load(await outputBlob.arrayBuffer());
    expect(output.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
  });

  it("keeps native source content aligned for every source/view quarter-turn", async () => {
    const source = await PDFDocument.create();
    const rawWidth = 200;
    const rawHeight = 120;
    const rotations = [0, 90, 180, 270] as const;
    for (const rotation of rotations) {
      const page = source.addPage([rawWidth, rawHeight]);
      page.setRotation(degrees(rotation));
      // An asymmetric native marker makes both axis swaps and clockwise
      // versus counter-clockwise mistakes visible in the rendered bounds.
      page.drawRectangle({
        x: 20,
        y: 15,
        width: 40,
        height: 20,
        color: rgb(1, 0, 0),
      });
    }
    const sourceBytes = await source.save();
    const scenes: Record<string, SerializedScene> = {};
    const pdfPageOrder: string[] = [];
    for (const [sourceIndex, sourceRotation] of rotations.entries()) {
      const sourceWidth = sourceRotation === 90 || sourceRotation === 270
        ? rawHeight
        : rawWidth;
      const sourceHeight = sourceRotation === 90 || sourceRotation === 270
        ? rawWidth
        : rawHeight;
      for (const viewRotation of rotations) {
        const id = `matrix-${sourceRotation}-${viewRotation}`;
        const backgroundId = `${id}-background`;
        scenes[id] = {
          id,
          name: id,
          elements: [{
            ...baseElement,
            id: backgroundId,
            width: sourceWidth,
            height: sourceHeight,
          }],
          appState: {},
          files: {},
          pdfPage: {
            documentId: "pdf",
            pageIndex: sourceIndex,
            width: sourceWidth,
            height: sourceHeight,
            rotation: sourceRotation,
            viewRotation,
            backgroundElementId: backgroundId,
          },
        };
        pdfPageOrder.push(id);
      }
    }
    const project = {
      schemaVersion: 1,
      id: "source-view-matrix",
      title: "Source/view matrix",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      activeSceneId: pdfPageOrder[0],
      scenes,
      slideOrder: [],
      pdfPageOrder,
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "matrix.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: rotations.length,
          archivePath: "documents/matrix.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
    const sourcePages = await Promise.all(rotations.map((_, index) => renderPdfPage(sourceBytes, index + 1, 2)));
    const outputDocument = await PDFDocument.load(outputBytes);
    expect(outputDocument.getPageCount()).toBe(pdfPageOrder.length);
    const outputPages = await Promise.all(pdfPageOrder.map((_, index) => renderPdfPage(outputBytes, index + 1, 2)));
    const red = (r: number, g: number, b: number) => r > 220 && g < 80 && b < 80;

    for (const [outputIndex, id] of pdfPageOrder.entries()) {
      const [, sourceRotationText, viewRotationText] = id.split("-");
      const sourceRotation = Number(sourceRotationText) as 0 | 90 | 180 | 270;
      const viewRotation = Number(viewRotationText) as 0 | 90 | 180 | 270;
      const sourcePage = sourcePages[rotations.indexOf(sourceRotation)];
      const sourceBounds = colorBounds(sourcePage, red);
      const expectedBounds = rotateRenderedBounds(
        sourceBounds!,
        sourcePage.width,
        sourcePage.height,
        viewRotation,
      );
      const outputPage = outputPages[outputIndex];
      const outputBounds = colorBounds(outputPage, red);
      expect(outputBounds).not.toBeNull();
      const expectedNormalized = normalizedBounds(
        {
          ...sourcePage,
          width: viewRotation === 90 || viewRotation === 270 ? sourcePage.height : sourcePage.width,
          height: viewRotation === 90 || viewRotation === 270 ? sourcePage.width : sourcePage.height,
        },
        expectedBounds,
      );
      const actualNormalized = normalizedBounds(outputPage, outputBounds);
      expect(actualNormalized).toHaveLength(4);
      for (let coordinate = 0; coordinate < 4; coordinate += 1) {
        expect(actualNormalized[coordinate], `${id} coordinate ${coordinate}`)
          .toBeCloseTo(expectedNormalized[coordinate], 2);
      }
    }
  }, 30_000);

  it("aligns rotated native content with a display-space annotation", async () => {
    const source = await PDFDocument.create();
    const rawWidth = 200;
    const rawHeight = 120;
    const sourcePage = source.addPage([rawWidth, rawHeight]);
    sourcePage.setRotation(degrees(90));
    sourcePage.drawRectangle({
      x: 20,
      y: 15,
      width: 40,
      height: 20,
      color: rgb(1, 0, 0),
    });
    const sourceBytes = await source.save();
    const sourceRender = await renderPdfPage(sourceBytes, 1, 2);
    const red = (r: number, g: number, b: number) => r > 220 && g < 80 && b < 80;
    const sourceBounds = colorBounds(sourceRender, red);
    expect(sourceBounds).not.toBeNull();
    const expectedNativeBounds = rotateRenderedBounds(
      sourceBounds!,
      sourceRender.width,
      sourceRender.height,
      90,
    );
    const nativeWidth = (expectedNativeBounds[2] - expectedNativeBounds[0]) / 2;
    const nativeHeight = (expectedNativeBounds[3] - expectedNativeBounds[1]) / 2;
    const annotation = {
      ...baseElement,
      id: "rotated-annotation",
      type: "rectangle",
      // The live scene is already in display coordinates after the page turn.
      x: expectedNativeBounds[0] / 2 + nativeWidth / 4,
      y: expectedNativeBounds[1] / 2 + nativeHeight / 4,
      width: nativeWidth / 2,
      height: nativeHeight / 2,
      isDeleted: false,
    };
    const scene = {
      id: "rotated-annotation-page",
      name: "Rotated annotation page",
      elements: [{
        ...baseElement,
        id: "rotated-annotation-background",
        width: rawHeight,
        height: rawWidth,
      }, annotation],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: rawHeight,
        height: rawWidth,
        rotation: 90 as const,
        viewRotation: 90 as const,
        backgroundElementId: "rotated-annotation-background",
      },
    } satisfies SerializedScene;
    const sourceSha = await (await import("../sha256")).sha256Hex(sourceBytes);
    const project = {
      schemaVersion: 1,
      id: "rotated-annotation-project",
      title: "Rotated annotation",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      activeSceneId: scene.id,
      scenes: { [scene.id]: scene },
      slideOrder: [],
      pdfPageOrder: [scene.id],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "rotated-annotation.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          sha256: sourceSha,
          pageCount: 1,
          archivePath: "documents/rotated-annotation.pdf",
        },
      },
    } satisfies ClassroomProject;
    const exportBounds = getPdfPageExportBounds(scene);

    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    exportToCanvasMock.mockImplementation(async (options: Parameters<typeof exportToCanvas>[0]) => {
      const dimensions = options.getDimensions?.(annotation.width, annotation.height)
        ?? { width: annotation.width, height: annotation.height };
      const canvas = createCanvas(
        Math.max(1, Math.ceil(dimensions.width)),
        Math.max(1, Math.ceil(dimensions.height)),
      );
      const context = canvas.getContext("2d");
      context.fillStyle = "#00ff00";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas as unknown as HTMLCanvasElement;
    });
    try {
      const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
      const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
      const outputRender = await renderPdfPage(outputBytes, 1, 2);
      const expectedNativeOutputBounds: readonly [number, number, number, number] = [
        expectedNativeBounds[0] - exportBounds.minX * 2,
        expectedNativeBounds[1] - exportBounds.minY * 2,
        expectedNativeBounds[2] - exportBounds.minX * 2,
        expectedNativeBounds[3] - exportBounds.minY * 2,
      ];
      const expectedNativeNormalized = normalizedBounds(outputRender, expectedNativeOutputBounds);
      const outputNativeNormalized = normalizedBounds(
        outputRender,
        colorBounds(outputRender, red),
      );
      expect(outputNativeNormalized).toHaveLength(4);
      for (let coordinate = 0; coordinate < 4; coordinate += 1) {
        expect(outputNativeNormalized[coordinate], `native coordinate ${coordinate}`)
          .toBeCloseTo(expectedNativeNormalized[coordinate], 2);
      }

      const green = (r: number, g: number, b: number) => r < 80 && g > 220 && b < 80;
      const annotationPixelX = expectedNativeOutputBounds[0] + nativeWidth / 2;
      const annotationPixelY = expectedNativeOutputBounds[1] + nativeHeight / 2;
      const expectedAnnotationBounds: readonly [number, number, number, number] = [
        annotationPixelX,
        annotationPixelY,
        annotationPixelX + nativeWidth,
        annotationPixelY + nativeHeight,
      ];
      const outputAnnotationNormalized = normalizedBounds(
        outputRender,
        colorBounds(outputRender, green),
      );
      const expectedAnnotationNormalized = normalizedBounds(
        outputRender,
        expectedAnnotationBounds,
      );
      expect(outputAnnotationNormalized).toHaveLength(4);
      for (let coordinate = 0; coordinate < 4; coordinate += 1) {
        expect(outputAnnotationNormalized[coordinate], `annotation coordinate ${coordinate}`)
          .toBeCloseTo(expectedAnnotationNormalized[coordinate], 2);
      }
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  }, 30_000);

  it("reports structured export progress through the final save", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const project = blankPdfProjectForIntegrity(sourceBytes.byteLength);
    const progress: Array<{
      phase: string;
      documentPosition: number;
      documentTotal: number;
      pagePosition: number;
      pageTotal: number;
    }> = [];

    await exportAnnotatedPdf(project, { pdf: sourceBytes }, "expand", {
      onProgress: (update) => progress.push(update),
    });

    expect(progress).toContainEqual(expect.objectContaining({
      phase: "loading",
      documentPosition: 1,
      documentTotal: 1,
      pagePosition: 0,
      pageTotal: 1,
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      phase: "rendering",
      pagePosition: 1,
      pageTotal: 1,
    }));
    expect(progress.at(-1)).toEqual(expect.objectContaining({ phase: "saving" }));
  });

  it("cancels before returning any partially assembled export", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const project = blankPdfProjectForIntegrity(sourceBytes.byteLength);
    const controller = new AbortController();
    let returnedBlob: Blob | undefined;

    const result = exportAnnotatedPdf(project, { pdf: sourceBytes }, "expand", {
      signal: controller.signal,
      onProgress: (update) => {
        if (update.phase === "rendering") controller.abort();
      },
    }).then((blob) => {
      returnedBlob = blob;
      return blob;
    });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(returnedBlob).toBeUndefined();
  });

  it("surfaces encrypted source loading as an actionable typed failure", async () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    const project = blankPdfProjectForIntegrity(sourceBytes.byteLength);
    const loadSpy = vi.spyOn(PDFDocument, "load").mockRejectedValueOnce(
      new Error("Input document to PDFDocument.load is encrypted"),
    );

    try {
      await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }))
        .rejects.toMatchObject({ name: "PdfExportError", code: "encrypted-source" });
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("batches pages from one donor so shared PDF resources are copied once", async () => {
    const source = await PDFDocument.create();
    const sourcePageOne = source.addPage([600, 800]);
    sourcePageOne.drawRectangle({
      x: 40,
      y: 40,
      width: 120,
      height: 80,
    });
    const sourcePageTwo = source.addPage([600, 800]);
    sourcePageTwo.drawRectangle({
      x: 80,
      y: 80,
      width: 120,
      height: 80,
    });
    const sharedGroup = source.context.register(source.context.obj({
      S: PDFName.of("Transparency"),
      CS: PDFName.of("DeviceRGB"),
    }));
    sourcePageOne.node.set(PDFName.of("Group"), sharedGroup);
    sourcePageTwo.node.set(PDFName.of("Group"), sharedGroup);
    const sourceBytes = await source.save();
    const scenes = Object.fromEntries([0, 1].map((pageIndex) => {
      const id = `page-${pageIndex}`;
      return [id, {
        id,
        name: `Page ${pageIndex + 1}`,
        elements: [{ ...baseElement, id: `${id}-background` }],
        appState: {},
        files: {},
        pdfPage: {
          documentId: "pdf",
          pageIndex,
          width: 600,
          height: 800,
          rotation: 0 as const,
          backgroundElementId: `${id}-background`,
        },
      } satisfies SerializedScene];
    }));
    const project = {
      schemaVersion: 1,
      id: "batched-donor",
      title: "Batched donor",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      activeSceneId: "page-0",
      scenes,
      slideOrder: [],
      pdfPageOrder: ["page-0", "page-1"],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "source.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 2,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;
    const embedPages = vi.spyOn(PDFDocument.prototype, "embedPages");

    try {
      const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
      expect(embedPages).toHaveBeenCalledOnce();
      expect(embedPages.mock.calls[0][0]).toHaveLength(2);

      const output = await PDFDocument.load(await outputBlob.arrayBuffer());
      const groupReferences = output.getPages().map((page) => {
        const xObjects = page.node.Resources()?.lookupMaybe(
          PDFName.of("XObject"),
          PDFDict,
        );
        const firstXObject = xObjects?.entries()[0]?.[1];
        if (!firstXObject) throw new Error("Expected an embedded source page.");
        const embeddedForm = output.context.lookup(firstXObject, PDFStream);
        const group = embeddedForm.dict.get(PDFName.of("Group"));
        if (!group) throw new Error("Expected a copied transparency group.");
        return group.toString();
      });
      expect(groupReferences[0]).toBe(groupReferences[1]);
    } finally {
      embedPages.mockRestore();
    }
  });

  it("preserves a source page transparency group on the embedded Form XObject", async () => {
    const sourceBytes = await loadPdfFixture(transparencyGroupFixtureUrl);
    const sourceDocument = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const sourcePage = sourceDocument.getPage(0);
    const groupName = PDFName.of("Group");
    const sourceGroup = sourcePage.node.lookupMaybe(groupName, PDFDict);
    expect(sourceGroup?.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText())
      .toBe("Transparency");
    expect(sourceGroup?.lookupMaybe(PDFName.of("I"), PDFBool)?.asBoolean())
      .toBe(true);
    expect(sourceGroup?.lookupMaybe(PDFName.of("K"), PDFBool)?.asBoolean())
      .toBe(false);

    const scene = {
      id: "transparency-page",
      name: "Transparency group",
      elements: [{
        ...baseElement,
        id: "transparency-background",
        width: 180,
        height: 120,
      }],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 180,
        height: 120,
        rotation: 0,
        backgroundElementId: "transparency-background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "transparency-project",
      title: "Transparency group fixture",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      activeSceneId: scene.id,
      scenes: { [scene.id]: scene },
      slideOrder: [],
      pdfPageOrder: [scene.id],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "page-transparency-group.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
    const outputDocument = await PDFDocument.load(outputBytes);
    const outputPage = outputDocument.getPage(0);
    const xObjects = outputPage.node.Resources()
      ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    expect(xObjects?.entries()).toHaveLength(1);
    const embeddedForm = outputDocument.context.lookup(
      xObjects?.entries()[0][1],
      PDFStream,
    );
    const embeddedGroup = embeddedForm.dict.lookupMaybe(groupName, PDFDict);
    expect(embeddedGroup?.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText())
      .toBe("Transparency");
    expect(embeddedGroup?.lookupMaybe(PDFName.of("I"), PDFBool)?.asBoolean())
      .toBe(true);
    expect(embeddedGroup?.lookupMaybe(PDFName.of("K"), PDFBool)?.asBoolean())
      .toBe(false);

    const [sourceRender, outputRender] = await Promise.all([
      renderPdfPage(sourceBytes, 1, 2),
      renderPdfPage(outputBytes, 1, 2),
    ]);
    expect(outputRender.rgba).toEqual(sourceRender.rgba);
    const imageOperators = new Set([
      OPS.paintImageMaskXObject,
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
    ]);
    expect(outputRender.operators.every((operator) => !imageOperators.has(operator)))
      .toBe(true);

    const embedOverBackdrop = async (preserveGroup: boolean): Promise<Uint8Array> => {
      const document = await PDFDocument.create();
      const page = document.addPage([180, 120]);
      page.drawRectangle({
        x: 0,
        y: 0,
        width: 180,
        height: 120,
        color: rgb(0, 1, 0),
      });
      const embeddedPage = await document.embedPage(sourcePage);
      if (preserveGroup) {
        await copySourcePageTransparencyGroup(sourcePage, embeddedPage);
      }
      page.drawPage(embeddedPage, { x: 0, y: 0, width: 180, height: 120 });
      return document.save();
    };
    const [groupedRender, ungroupedRender] = await Promise.all([
      embedOverBackdrop(true).then((bytes) => renderPdfPage(bytes, 1, 2)),
      embedOverBackdrop(false).then((bytes) => renderPdfPage(bytes, 1, 2)),
    ]);
    expect(groupedRender.rgba).not.toEqual(ungroupedRender.rgba);
  }, 20_000);

  it("preserves vector form and annotation appearances with CropBox, UserUnit, and rotation", async () => {
    const sourceBytes = await createPdfFidelityFixture();
    const immutableSource = Uint8Array.from(sourceBytes);
    const sizes = [
      { width: 240, height: 160, rotation: 0 as const },
      { width: 240, height: 160, rotation: 0 as const },
      { width: 720, height: 960, rotation: 0 as const },
      { width: 960, height: 720, rotation: 90 as const },
      { width: 720, height: 960, rotation: 180 as const },
      { width: 960, height: 720, rotation: 270 as const },
    ];
    const scenes = Object.fromEntries(sizes.map(({ width, height, rotation }, pageIndex) => {
      const id = `fidelity-page-${pageIndex + 1}`;
      return [id, {
        id,
        name: `Fidelity page ${pageIndex + 1}`,
        elements: [{ ...baseElement, id: `${id}-background`, width, height }],
        appState: {},
        files: {},
        pdfPage: {
          documentId: "pdf",
          pageIndex,
          width,
          height,
          rotation,
          backgroundElementId: `${id}-background`,
        },
      } satisfies SerializedScene];
    }));
    const project = {
      schemaVersion: 1,
      id: "fidelity-project",
      title: "PDF fidelity fixture",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      activeSceneId: "fidelity-page-1",
      scenes,
      slideOrder: [],
      pdfPageOrder: Object.keys(scenes),
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "fidelity.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 6,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
    expect(sourceBytes).toEqual(immutableSource);

    const output = await PDFDocument.load(outputBytes);
    expect(output.getPages().map((page) => page.getSize())).toEqual([
      { width: 240, height: 160 },
      { width: 240, height: 160 },
      { width: 720, height: 960 },
      { width: 960, height: 720 },
      { width: 720, height: 960 },
      { width: 960, height: 720 },
    ]);
    expect(output.getPages().every((page) => (page.node.Annots()?.size() || 0) === 0)).toBe(true);

    const pageNumbers = [1, 2, 3, 4, 5, 6];
    const sourcePages = await Promise.all(pageNumbers.map((pageNumber) => (
      renderPdfPage(sourceBytes, pageNumber)
    )));
    const outputPages = await Promise.all(pageNumbers.map((pageNumber) => (
      renderPdfPage(outputBytes, pageNumber)
    )));
    const yellow = (red: number, green: number, blue: number) => red > 220 && green > 220 && blue < 80;
    const magenta = (red: number, green: number, blue: number) => red > 220 && green < 80 && blue > 220;
    const cyan = (red: number, green: number, blue: number) => red < 80 && green > 220 && blue > 220;
    const green = (red: number, g: number, blue: number) => red < 80 && g > 220 && blue < 80;
    const red = (r: number, g: number, b: number) => r > 220 && g < 80 && b < 80;
    const blue = (r: number, g: number, b: number) => r < 80 && g < 80 && b > 220;

    for (const [pageIndex, color] of [
      [0, yellow],
      [0, cyan],
      [1, magenta],
      [1, green],
      [2, red],
      [2, blue],
      [3, red],
      [3, blue],
      [4, red],
      [4, blue],
      [5, red],
      [5, blue],
    ] as const) {
      const outputColorBounds = normalizedBounds(
        outputPages[pageIndex],
        colorBounds(outputPages[pageIndex], color),
      );
      const sourceColorBounds = normalizedBounds(
        sourcePages[pageIndex],
        colorBounds(sourcePages[pageIndex], color),
      );
      expect(outputColorBounds).toHaveLength(4);
      expect(sourceColorBounds).toHaveLength(4);
      for (let coordinate = 0; coordinate < 4; coordinate += 1) {
        expect(outputColorBounds[coordinate]).toBeCloseTo(sourceColorBounds[coordinate], 2);
      }
    }
    for (const [pageIndex, rotation] of [0, 90, 180, 270].entries()) {
      expect(outputPages[pageIndex + 2].text).toContain(`VECTOR_SENTINEL_${rotation}`);
    }
    expect(outputPages[0].text).toContain("FORM ONLY");
    const imageOperators = new Set([
      OPS.paintImageMaskXObject,
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
    ]);
    expect(outputPages.every((page) => (
      page.operators.every((operator) => !imageOperators.has(operator))
    ))).toBe(true);
  }, 20_000);

  it("preserves an independently generated ReportLab AcroForm as aligned vector content", async () => {
    const sourceBytes = await loadPdfFixture(reportLabAcroFormFixtureUrl);
    const immutableSource = Uint8Array.from(sourceBytes);
    const sourceDocument = await PDFDocument.load(sourceBytes, { updateMetadata: false });
    const sourcePage = sourceDocument.getPage(0);
    const annotations = sourcePage.node.Annots();
    expect(sourceDocument.getPageCount()).toBe(1);
    expect(sourcePage.getSize()).toEqual({ width: 360, height: 240 });
    expect(sourcePage.getRotation().angle).toBe(0);
    expect(annotations?.size()).toBe(2);
    expect(sourceDocument.getForm().getTextField("fixture.answer").getText())
      .toBe("REPORTLAB_FORM_VALUE");
    expect(sourceDocument.getForm().getCheckBox("fixture.checked").isChecked()).toBe(true);

    const appearanceEntries = Array.from(
      { length: annotations?.size() || 0 },
      (_, index) => {
        const annotation = sourceDocument.context.lookup(
          annotations?.get(index),
          PDFDict,
        );
        const appearances = annotation.lookupMaybe(PDFName.of("AP"), PDFDict);
        return {
          annotation,
          normal: sourceDocument.context.lookup(appearances?.get(PDFName.of("N"))),
        };
      },
    );
    expect(appearanceEntries.some(({ normal }) => normal instanceof PDFStream)).toBe(true);
    const statefulAppearance = appearanceEntries.find(
      ({ normal }) => normal instanceof PDFDict,
    );
    expect(statefulAppearance?.normal).toBeInstanceOf(PDFDict);
    const appearanceState = statefulAppearance?.annotation
      .lookupMaybe(PDFName.of("AS"), PDFName);
    expect(appearanceState?.decodeText()).toBe("Yes");
    expect(
      statefulAppearance?.normal instanceof PDFDict && appearanceState
        ? statefulAppearance.normal.lookupMaybe(appearanceState, PDFStream)
        : undefined,
    ).toBeInstanceOf(PDFStream);

    const scene = {
      id: "reportlab-page",
      name: "ReportLab form",
      elements: [{
        ...baseElement,
        id: "reportlab-background",
        width: 360,
        height: 240,
      }],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 360,
        height: 240,
        rotation: 0,
        backgroundElementId: "reportlab-background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "reportlab-project",
      title: "ReportLab form fixture",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      activeSceneId: scene.id,
      scenes: { [scene.id]: scene },
      slideOrder: [],
      pdfPageOrder: [scene.id],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "reportlab-acroform.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const outputBytes = new Uint8Array(await outputBlob.arrayBuffer());
    expect(sourceBytes).toEqual(immutableSource);

    const outputDocument = await PDFDocument.load(outputBytes);
    const outputPage = outputDocument.getPage(0);
    expect(outputPage.getSize()).toEqual({ width: 360, height: 240 });
    expect(outputPage.getRotation().angle).toBe(0);
    expect(outputPage.node.Annots()?.size() || 0).toBe(0);

    const [sourceRender, outputRender] = await Promise.all([
      renderPdfPage(sourceBytes, 1, 2),
      renderPdfPage(outputBytes, 1, 2),
    ]);
    expect([outputRender.width, outputRender.height])
      .toEqual([sourceRender.width, sourceRender.height]);
    expect(sourceRender.text).toContain("REPORTLAB_VECTOR_SENTINEL");
    expect(outputRender.text).toContain("REPORTLAB_VECTOR_SENTINEL");
    expect(outputRender.text).toContain("REPORTLAB_FORM_VALUE");

    const red = (r: number, g: number, b: number) => r > 220 && g < 80 && b < 80;
    const blue = (r: number, g: number, b: number) => r < 80 && g < 80 && b > 220;
    const yellow = (r: number, g: number, b: number) => r > 220 && g > 220 && b < 80;
    const cyan = (r: number, g: number, b: number) => r < 80 && g > 220 && b > 220;
    for (const color of [red, blue, yellow, cyan]) {
      const sourceBounds = normalizedBounds(
        sourceRender,
        colorBounds(sourceRender, color),
      );
      const outputBounds = normalizedBounds(
        outputRender,
        colorBounds(outputRender, color),
      );
      expect(sourceBounds).toHaveLength(4);
      expect(outputBounds).toHaveLength(4);
      for (let coordinate = 0; coordinate < 4; coordinate += 1) {
        expect(outputBounds[coordinate]).toBeCloseTo(sourceBounds[coordinate], 2);
      }
    }

    const imageOperators = new Set([
      OPS.paintImageMaskXObject,
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
    ]);
    expect(sourceRender.operators.every((operator) => !imageOperators.has(operator))).toBe(true);
    expect(outputRender.operators.every((operator) => !imageOperators.has(operator))).toBe(true);
  }, 20_000);

  it("exports a valid source page that has no content stream", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Blank page",
      elements: [baseElement],
      appState: {},
      files: {},
      pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Blank worksheet",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: { id: "pdf", name: "blank.pdf", mimeType: "application/pdf", byteLength: sourceBytes.byteLength, pageCount: 1, archivePath: "documents/pdf.pdf" },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const output = await PDFDocument.load(await outputBlob.arrayBuffer());
    expect(output.getPageCount()).toBe(1);
    expect(output.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
  });

  it("rejects source PDF bytes whose length no longer matches project metadata", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const project = blankPdfProjectForIntegrity(sourceBytes.byteLength + 1);

    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }))
      .rejects.toThrow(/source PDF data no longer matches.*blank\.pdf/i);
  });

  it("rejects valid source PDF bytes whose digest no longer matches project metadata", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const project = blankPdfProjectForIntegrity(sourceBytes.byteLength, "0".repeat(64));

    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }))
      .rejects.toThrow(/source PDF data no longer matches.*blank\.pdf/i);
  });

  it("validates source geometry even when the PDF page has no content stream", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Blank mismatched page",
      elements: [{ ...baseElement, width: 300, height: 400 }],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 300,
        height: 400,
        rotation: 0,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Blank mismatched worksheet",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "blank-mismatch.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }))
      .rejects.toThrow(/geometry no longer matches/);
  });

  it("rejects source geometry that would require silently stretching the page", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Mismatched page",
      elements: [baseElement],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 600,
        height: 700,
        rotation: 0,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Mismatched worksheet",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "mismatched.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }))
      .rejects.toThrow(/geometry no longer matches/);
  });

  it("rejects uniformly scaled workspace geometry that lost the source UserUnit", async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([600, 800]);
    sourcePage.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
    sourcePage.drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Mismatched UserUnit page",
      elements: [{ ...baseElement, width: 600, height: 800 }],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Mismatched UserUnit worksheet",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "mismatched-user-unit.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 1,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }))
      .rejects.toThrow(/geometry no longer matches/);
  });

  it("does not let an unsupported annotation on an unused source page block export", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    const unusedPage = source.addPage([600, 800]);
    const unsupportedAnnotation = source.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [10, 10, 40, 40],
    });
    unusedPage.node.addAnnot(source.context.register(unsupportedAnnotation));
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Retained page",
      elements: [baseElement],
      appState: {},
      files: {},
      pdfPage: {
        documentId: "pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "background",
      },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Retained page only",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: {
          id: "pdf",
          name: "unused-annotation.pdf",
          mimeType: "application/pdf",
          byteLength: sourceBytes.byteLength,
          pageCount: 2,
          archivePath: "documents/pdf.pdf",
        },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes });
    const output = await PDFDocument.load(await outputBlob.arrayBuffer());
    expect(output.getPageCount()).toBe(1);
  });

  it("rejects expanded pages beyond the safe PDF edge before allocating an annotation canvas", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const scene = {
      id: "page",
      name: "Page with distant writing",
      elements: [
        baseElement,
        { ...baseElement, id: "distant", type: "rectangle", x: 20_000, y: 20, width: 20, height: 20 },
      ],
      appState: {},
      files: {},
      pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
    } satisfies SerializedScene;
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Distant writing",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: { page: scene },
      slideOrder: [],
      pdfDocuments: {
        pdf: { id: "pdf", name: "source.pdf", mimeType: "application/pdf", byteLength: sourceBytes.byteLength, pageCount: 1, archivePath: "documents/pdf.pdf" },
      },
    } satisfies ClassroomProject;

    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }, "expand"))
      .rejects.toThrow(/Fit like OpenBoard/);
    expect(vi.mocked(exportToCanvas)).not.toHaveBeenCalled();
  });

  it.each(["expand", "openboard-fit"] as const)("exports pages in the rearranged PDF-mode order for %s", async (mode) => {
    const sizes = [[500, 700], [600, 800], [700, 900]] as const;
    const source = await PDFDocument.create();
    sizes.forEach(([width, height]) => source.addPage([width, height]));
    const sourceBytes = await source.save();
    const scenes = Object.fromEntries(sizes.map(([width, height], pageIndex) => {
      const id = `page-${pageIndex + 1}`;
      return [id, {
        id,
        name: `Page ${pageIndex + 1}`,
        elements: [{ ...baseElement, id: `${id}-background`, width, height }],
        appState: {},
        files: {},
        pdfPage: { documentId: "pdf", pageIndex, width, height, rotation: 0, backgroundElementId: `${id}-background` },
      } satisfies SerializedScene];
    }));
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Reordered worksheet",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page-1",
      scenes,
      slideOrder: [],
      pdfPageOrder: ["page-3", "page-1", "page-2"],
      pdfDocuments: {
        pdf: { id: "pdf", name: "source.pdf", mimeType: "application/pdf", byteLength: sourceBytes.byteLength, pageCount: 3, archivePath: "documents/pdf.pdf" },
      },
    } satisfies ClassroomProject;

    const outputBlob = await exportAnnotatedPdf(project, { pdf: sourceBytes }, mode);
    const output = await PDFDocument.load(await outputBlob.arrayBuffer());
    expect(output.getPages().map((page) => page.getSize())).toEqual([
      { width: 700, height: 900 },
      { width: 500, height: 700 },
      { width: 600, height: 800 },
    ]);
    expect(project.scenes["page-3"].pdfPage?.pageIndex).toBe(2);
  });

  it("exports fidelity-safe annotation shapes as vectors with local diagnostics", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({ id: "red-rectangle" }),
      fullAnnotation({
        id: "blue-ellipse",
        type: "ellipse",
        x: 50,
        y: 50,
        width: 60,
        height: 40,
        backgroundColor: "#0000ff",
      }),
    ]);
    const reported: unknown[] = [];

    const result = await exportAnnotatedPdfWithDiagnostics(
      project,
      { pdf: sourceBytes },
      "expand",
      { onDiagnostics: (diagnostics) => reported.push(diagnostics) },
    );
    expect(result.diagnostics).toMatchObject({
      annotationMode: "hybrid",
      pageCount: 1,
      vectorElementCount: 2,
      rasterElementCount: 0,
      rasterRunCount: 0,
      rasterPixels: 0,
      rasterBytes: 0,
    });
    expect(result.diagnostics.pages[0]).toMatchObject({
      runCount: 1,
      vectorElementCount: 2,
      rasterizedTypes: [],
    });
    expect(result.diagnostics.outputBytes).toBe(result.blob.size);
    expect(reported).toEqual([result.diagnostics]);
    expect(vi.mocked(exportToCanvas)).not.toHaveBeenCalled();

    const rendered = await renderPdfPage(
      new Uint8Array(await result.blob.arrayBuffer()),
      1,
      1,
    );
    expect(rendered.operators).toContain(OPS.constructPath);
    expect(rendered.operators).not.toContain(OPS.paintImageXObject);
  });

  it("preserves vector/raster/vector scene z-order in the rendered page", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({ id: "red-back" }),
      fullAnnotation({
        id: "green-middle-text",
        type: "text",
        x: 40,
        y: 40,
        width: 60,
        height: 60,
        text: "middle",
        originalText: "middle",
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
      }),
      fullAnnotation({
        id: "blue-front",
        type: "ellipse",
        x: 50,
        y: 50,
        width: 60,
        height: 60,
        backgroundColor: "#0000ff",
      }),
    ]);
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    exportToCanvasMock.mockImplementation(async (options: Parameters<typeof exportToCanvas>[0]) => {
      const dimensions = options.getDimensions?.(60, 60) ?? { width: 60, height: 60 };
      const canvas = createCanvas(dimensions.width, dimensions.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#00ff00";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas as unknown as HTMLCanvasElement;
    });
    try {
      const runProgress: Array<{ runPosition: number; runKind: string }> = [];
      const result = await exportAnnotatedPdfWithDiagnostics(
        project,
        { pdf: sourceBytes },
        "expand",
        {
          onAnnotationRunProgress: ({ runPosition, runKind }) => {
            runProgress.push({ runPosition, runKind });
          },
        },
      );
      expect(result.diagnostics.pages[0]).toMatchObject({
        runCount: 3,
        vectorElementCount: 2,
        rasterElementCount: 1,
      });
      expect(runProgress).toEqual([
        { runPosition: 1, runKind: "vector" },
        { runPosition: 2, runKind: "raster" },
        { runPosition: 3, runKind: "vector" },
      ]);
      const rendered = await renderPdfPage(
        new Uint8Array(await result.blob.arrayBuffer()),
        1,
        2,
      );
      const pixel = (x: number, y: number) => {
        const offset = (Math.round(y * 2) * rendered.width + Math.round(x * 2)) * 4;
        return Array.from(rendered.rgba.slice(offset, offset + 3));
      };
      expect(pixel(25, 25)).toEqual([255, 0, 0]);
      expect(pixel(45, 45)).toEqual([0, 255, 0]);
      expect(pixel(80, 80)).toEqual([0, 0, 255]);
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });

  it("surfaces a typed hybrid fallback and retries only when visual mode is explicit", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({
        id: "container",
        boundElements: [{ id: "label", type: "text" }],
      }),
      fullAnnotation({ id: "vector" }),
      fullAnnotation({
        id: "label",
        type: "text",
        width: 40,
        height: 30,
        containerId: "container",
      }),
    ]);
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    exportToCanvasMock.mockImplementation(async (options: Parameters<typeof exportToCanvas>[0]) => {
      const dimensions = options.getDimensions?.(100, 100) ?? { width: 100, height: 100 };
      return createCanvas(dimensions.width, dimensions.height) as unknown as HTMLCanvasElement;
    });
    try {
      const hybrid = exportAnnotatedPdf(project, { pdf: sourceBytes });
      await expect(hybrid).rejects.toBeInstanceOf(PdfHybridFallbackRequiredError);
      await expect(hybrid).rejects.toMatchObject({
        code: "hybrid-visual-fallback-required",
        fallbackMode: "visual",
        reason: "dependent-elements-separated",
      });

      const result = await exportAnnotatedPdfWithDiagnostics(
        project,
        { pdf: sourceBytes },
        "expand",
        { annotationMode: "visual" },
      );
      expect(result.diagnostics).toMatchObject({
        annotationMode: "visual",
        vectorElementCount: 0,
        rasterElementCount: 3,
        rasterRunCount: 1,
      });
      expect(result.blob.type).toBe("application/pdf");
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });

  it("propagates raster PNG encoder failures instead of offering an unsafe visual retry", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({ id: "text", type: "text", width: 40, height: 30 }),
    ]);
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    const canvas = createCanvas(80, 60);
    Object.defineProperty(canvas, "toBlob", {
      configurable: true,
      value: (callback: BlobCallback) => callback(null),
    });
    exportToCanvasMock.mockResolvedValue(canvas as unknown as HTMLCanvasElement);
    try {
      const exporting = exportAnnotatedPdf(project, { pdf: sourceBytes });
      await expect(exporting).rejects.toThrow("PNG export failed.");
      await expect(exporting).rejects.not.toBeInstanceOf(PdfHybridFallbackRequiredError);
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });

  it.each([
    ["RangeError", () => new RangeError("Raster allocation failed.")],
    ["DOMException", () => new DOMException("Canvas unavailable.", "InvalidStateError")],
  ])("preserves a raster %s without misclassifying it as visual fallback", async (_label, makeError) => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({ id: "text", type: "text", width: 40, height: 30 }),
    ]);
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    const expectedError = makeError();
    exportToCanvasMock.mockRejectedValue(expectedError);
    try {
      const exporting = exportAnnotatedPdf(project, { pdf: sourceBytes });
      await expect(exporting).rejects.toBe(expectedError);
      await expect(exporting).rejects.not.toBeInstanceOf(PdfHybridFallbackRequiredError);
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });

  it("keeps hybrid run overflow distinct from hard export limits", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({ id: "vector-back" }),
      fullAnnotation({ id: "text", type: "text" }),
      fullAnnotation({ id: "vector-front" }),
    ]);
    await expect(exportAnnotatedPdf(project, { pdf: sourceBytes }, "expand", {
      resourceLimits: { maxHybridRuns: 2 },
    })).rejects.toMatchObject({
      name: "PdfHybridFallbackRequiredError",
      reason: "too-many-runs",
    });

    const outputLimit = exportAnnotatedPdf(projectWithAnnotations(sourceBytes.byteLength, []), {
      pdf: sourceBytes,
    }, "expand", {
      resourceLimits: { maxOutputBytes: 1 },
    });
    await expect(outputLimit).rejects.toBeInstanceOf(PdfExportLimitError);
    await expect(outputLimit).rejects.toMatchObject({ code: "output-bytes" });
  });

  it("does not misclassify a cumulative raster safety rejection as visual fallback", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const project = projectWithAnnotations(sourceBytes.byteLength, [
      fullAnnotation({ id: "text", type: "text", width: 40, height: 30 }),
    ]);
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    exportToCanvasMock.mockResolvedValue(
      createCanvas(80, 60) as unknown as HTMLCanvasElement,
    );
    try {
      const exporting = exportAnnotatedPdf(project, { pdf: sourceBytes }, "expand", {
        resourceLimits: { maxRasterPixels: 1 },
      });
      await expect(exporting).rejects.toBeInstanceOf(PdfExportLimitError);
      await expect(exporting).rejects.toMatchObject({ code: "raster-pixels" });
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });

  it("rasterizes later pages after the exact vector budget is exhausted", async () => {
    const source = await PDFDocument.create();
    source.addPage([160, 160]);
    source.addPage([160, 160]);
    const sourceBytes = await source.save();
    const scenes = Object.fromEntries([0, 1].map((pageIndex) => {
      const id = `page-${pageIndex}`;
      return [id, {
        id,
        name: id,
        elements: [
          { ...baseElement, id: `${id}-background`, width: 160, height: 160 },
          fullAnnotation({ id: `${id}-vector` }),
        ],
        appState: {},
        files: {},
        pdfPage: {
          documentId: "pdf",
          pageIndex,
          width: 160,
          height: 160,
          rotation: 0 as const,
          backgroundElementId: `${id}-background`,
        },
      } satisfies SerializedScene];
    }));
    const project: ClassroomProject = {
      ...projectWithAnnotations(sourceBytes.byteLength, []),
      activeSceneId: "page-0",
      scenes,
      pdfPageOrder: ["page-0", "page-1"],
      pdfDocuments: {
        pdf: {
          ...projectWithAnnotations(sourceBytes.byteLength, []).pdfDocuments.pdf,
          pageCount: 2,
        },
      },
    };
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    exportToCanvasMock.mockImplementation(async (options: Parameters<typeof exportToCanvas>[0]) => {
      const dimensions = options.getDimensions?.(100, 100) ?? { width: 100, height: 100 };
      return createCanvas(dimensions.width, dimensions.height) as unknown as HTMLCanvasElement;
    });
    try {
      const result = await exportAnnotatedPdfWithDiagnostics(
        project,
        { pdf: sourceBytes },
        "expand",
        { resourceLimits: { maxVectorElements: 1 } },
      );
      expect(result.diagnostics.vectorElementCount).toBe(1);
      expect(result.diagnostics.rasterElementCount).toBe(1);
      expect(result.diagnostics.pages.map((page) => page.rasterReasons["vector-budget"]))
        .toEqual([0, 1]);
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });

  it("releases a slide canvas immediately when export aborts during PNG encoding", async () => {
    const frame = fullAnnotation({
      id: "slide-frame",
      type: "frame",
      x: 0,
      y: 0,
      width: 160,
      height: 90,
      name: "Slide 1",
      customData: { classroomSlide: { kind: "slide", version: 1 } },
    });
    const scene = {
      id: "board",
      name: "Board",
      elements: [frame],
      appState: {},
      files: {},
    } satisfies SerializedScene;
    const project: ClassroomProject = {
      schemaVersion: 1,
      id: "slides-project",
      title: "Slides",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      activeSceneId: scene.id,
      scenes: { [scene.id]: scene },
      slideOrder: [{
        id: "slide",
        sceneId: scene.id,
        frameId: "slide-frame",
        title: "Slide 1",
      }],
      pdfDocuments: {},
    };
    const exportToCanvasMock = vi.mocked(exportToCanvas);
    const previousImplementation = exportToCanvasMock.getMockImplementation();
    let pngCallback: BlobCallback | undefined;
    let markEncodingStarted: (() => void) | undefined;
    const encodingStarted = new Promise<void>((resolve) => {
      markEncodingStarted = resolve;
    });
    const canvas = {
      width: 320,
      height: 180,
      toBlob: (callback: BlobCallback) => {
        pngCallback = callback;
        markEncodingStarted?.();
      },
    } as unknown as HTMLCanvasElement;
    exportToCanvasMock.mockResolvedValue(canvas);
    const controller = new AbortController();
    try {
      const exporting = exportSlidesPdf(project, { signal: controller.signal });
      await encodingStarted;
      controller.abort();
      await expect(exporting).rejects.toMatchObject({ name: "AbortError" });
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 0, height: 0 });
      pngCallback?.(new Blob([new Uint8Array([1])]));
    } finally {
      exportToCanvasMock.mockReset();
      if (previousImplementation) exportToCanvasMock.mockImplementation(previousImplementation);
    }
  });
});
