import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { ClassroomProject, SerializedScene } from "../../types";

vi.mock("@excalidraw/excalidraw", () => ({
  exportToCanvas: vi.fn(),
  getCommonBounds: (elements: Array<{ x: number; y: number; width: number; height: number }>) => [
    Math.min(...elements.map((element) => element.x)),
    Math.min(...elements.map((element) => element.y)),
    Math.max(...elements.map((element) => element.x + element.width)),
    Math.max(...elements.map((element) => element.y + element.height)),
  ],
}));

import { exportAnnotatedPdf, getPdfPageExportBounds } from "./export-pdf";

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
