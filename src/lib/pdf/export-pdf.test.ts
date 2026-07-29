import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { exportToCanvas } from "@excalidraw/excalidraw";
import {
  degrees,
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
  getPdfAnnotationExportDimensions,
  getPdfPageExportBounds,
} from "./export-pdf";

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

  it("caps raster dimensions for annotations spread a million units apart", () => {
    const dimensions = getPdfAnnotationExportDimensions(1_000_000, 1_000_000);
    expect(dimensions.width).toBeLessThanOrEqual(8_192);
    expect(dimensions.height).toBeLessThanOrEqual(8_192);
    expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(16_000_000);
    expect(dimensions.scale).toBeLessThan(0.01);
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
});
