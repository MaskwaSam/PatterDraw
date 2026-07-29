import {
  exportToCanvas,
  getCommonBounds,
} from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { PDFDocument, degrees } from "pdf-lib";
import type {
  ClassroomProject,
  ExportBounds,
  PdfDocumentId,
  SerializedScene,
} from "../../types";
import { getSlideRenderData } from "../slide-render";
import { orderedPdfScenes } from "./page-order";
import {
  getSourcePageUserUnit,
  getVisibleSourcePageBox,
  prepareSourcePdfForEmbedding,
  type PdfSourcePageBox,
} from "./source-page";

export type PdfExportMode = "expand" | "openboard-fit";

const EXPORT_PADDING = 24;
const ANNOTATION_SCALE = 2;
const MAX_ANNOTATION_EDGE = 8_192;
const MAX_ANNOTATION_PIXELS = 16_000_000;
const MAX_PDF_PAGE_EDGE_POINTS = 14_400;

function asElements(scene: SerializedScene): ExcalidrawElement[] {
  return scene.elements as unknown as ExcalidrawElement[];
}

function asFiles(scene: SerializedScene): BinaryFiles {
  return scene.files as unknown as BinaryFiles;
}

export function getPdfPageExportBounds(scene: SerializedScene): ExportBounds {
  if (!scene.pdfPage) throw new Error("Scene is not a PDF page workspace.");
  const annotationElements = asElements(scene).filter(
    (element) => !element.isDeleted && element.id !== scene.pdfPage?.backgroundElementId,
  );
  const base = [0, 0, scene.pdfPage.width, scene.pdfPage.height] as const;
  if (!annotationElements.length) {
    return {
      minX: 0,
      minY: 0,
      maxX: base[2],
      maxY: base[3],
      width: base[2],
      height: base[3],
    };
  }
  const [x1, y1, x2, y2] = getCommonBounds(annotationElements);
  const minX = Math.min(base[0], x1 - EXPORT_PADDING);
  const minY = Math.min(base[1], y1 - EXPORT_PADDING);
  const maxX = Math.max(base[2], x2 + EXPORT_PADDING);
  const maxY = Math.max(base[3], y2 + EXPORT_PADDING);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG export failed."))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export function getPdfAnnotationExportDimensions(
  width: number,
  height: number,
  pageScale = 1,
): { width: number; height: number; scale: number } {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
    || !Number.isFinite(pageScale)
    || pageScale <= 0
  ) {
    throw new Error("PDF annotation bounds must be positive finite numbers.");
  }
  const scale = Math.min(
    ANNOTATION_SCALE * pageScale,
    MAX_ANNOTATION_EDGE / width,
    MAX_ANNOTATION_EDGE / height,
    Math.sqrt(MAX_ANNOTATION_PIXELS) / Math.sqrt(width) / Math.sqrt(height),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

async function renderAnnotations(scene: SerializedScene, pageScale: number): Promise<{
  bytes: Uint8Array;
  bounds: readonly [number, number, number, number];
} | null> {
  if (!scene.pdfPage) return null;
  const elements = asElements(scene).filter(
    (element): element is NonDeletedExcalidrawElement =>
      !element.isDeleted &&
      element.id !== scene.pdfPage?.backgroundElementId &&
      element.type !== "frame" &&
      element.type !== "embeddable" &&
      element.type !== "iframe",
  );
  if (!elements.length) return null;
  const bounds = getCommonBounds(elements);
  const canvas = await exportToCanvas({
    elements,
    files: asFiles(scene),
    appState: {
      exportBackground: false,
      viewBackgroundColor: "#ffffff",
    },
    exportPadding: 0,
    getDimensions: (width: number, height: number) => (
      getPdfAnnotationExportDimensions(width, height, pageScale)
    ),
  });
  return { bytes: await canvasPngBytes(canvas), bounds };
}

function validateSourcePageGeometry(
  rotation: 0 | 90 | 180 | 270,
  workspaceWidth: number,
  workspaceHeight: number,
  sourceBox: PdfSourcePageBox,
  sourceUserUnit: number,
  sourceRotation: number,
): void {
  const sourceWidth = sourceBox.right - sourceBox.left;
  const sourceHeight = sourceBox.top - sourceBox.bottom;
  const expectedWorkspaceWidth = (
    rotation === 0 || rotation === 180 ? sourceWidth : sourceHeight
  ) * sourceUserUnit;
  const expectedWorkspaceHeight = (
    rotation === 0 || rotation === 180 ? sourceHeight : sourceWidth
  ) * sourceUserUnit;
  const widthMismatch = Math.abs(workspaceWidth / expectedWorkspaceWidth - 1);
  const heightMismatch = Math.abs(workspaceHeight / expectedWorkspaceHeight - 1);
  const normalizedSourceRotation = ((sourceRotation % 360) + 360) % 360;
  if (
    !Number.isFinite(widthMismatch)
    || !Number.isFinite(heightMismatch)
    || widthMismatch > 0.005
    || heightMismatch > 0.005
    || normalizedSourceRotation !== rotation
  ) {
    throw new Error("The saved PDF page geometry no longer matches its original source page.");
  }
}

function drawEmbeddedSourcePage(
  targetPage: ReturnType<PDFDocument["addPage"]>,
  embeddedPage: Awaited<ReturnType<PDFDocument["embedPage"]>>,
  rotation: 0 | 90 | 180 | 270,
  x: number,
  y: number,
  scale: number,
  workspaceWidth: number,
  workspaceHeight: number,
): void {
  const width = (rotation === 0 || rotation === 180 ? workspaceWidth : workspaceHeight) * scale;
  const height = (rotation === 0 || rotation === 180 ? workspaceHeight : workspaceWidth) * scale;
  if (rotation === 0) {
    targetPage.drawPage(embeddedPage, { x, y, width, height });
  } else if (rotation === 90) {
    targetPage.drawPage(embeddedPage, { x, y: y + width, width, height, rotate: degrees(270) });
  } else if (rotation === 180) {
    targetPage.drawPage(embeddedPage, { x: x + width, y: y + height, width, height, rotate: degrees(180) });
  } else {
    targetPage.drawPage(embeddedPage, { x: x + height, y, width, height, rotate: degrees(90) });
  }
}

export async function exportAnnotatedPdf(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  mode: PdfExportMode = "expand",
): Promise<Blob> {
  const scenes = orderedPdfScenes(project)
    .filter((scene): scene is SerializedScene & { pdfPage: NonNullable<SerializedScene["pdfPage"]> } => !!scene.pdfPage);
  if (!scenes.length) throw new Error("This project has no imported PDF pages.");

  const sourceDocuments = new Map<PdfDocumentId, PDFDocument>();
  for (const id of new Set(scenes.map((scene) => scene.pdfPage.documentId))) {
    const bytes = pdfBytes[id];
    if (!bytes) throw new Error("The project is missing source PDF data.");
    const sourceDocument = await PDFDocument.load(bytes, { updateMetadata: false });
    prepareSourcePdfForEmbedding(
      sourceDocument,
      scenes
        .filter((scene) => scene.pdfPage.documentId === id)
        .map((scene) => scene.pdfPage.pageIndex),
    );
    sourceDocuments.set(id, sourceDocument);
  }

  const output = await PDFDocument.create();
  output.setTitle(project.title);
  output.setCreator("PatterDraw");
  output.setProducer("PatterDraw offline PDF exporter");

  for (const scene of scenes) {
    const workspace = scene.pdfPage;
    const sourceDocument = sourceDocuments.get(workspace.documentId);
    if (!sourceDocument) throw new Error("Source PDF could not be opened.");
    const sourcePage = sourceDocument.getPage(workspace.pageIndex);
    const bounds = getPdfPageExportBounds(scene);
    const scale = mode === "openboard-fit"
      ? Math.min(workspace.width / bounds.width, workspace.height / bounds.height)
      : 1;
    const targetWidth = mode === "openboard-fit" ? workspace.width : bounds.width;
    const targetHeight = mode === "openboard-fit" ? workspace.height : bounds.height;
    if (
      !Number.isFinite(targetWidth)
      || !Number.isFinite(targetHeight)
      || targetWidth <= 0
      || targetHeight <= 0
      || targetWidth > MAX_PDF_PAGE_EDGE_POINTS
      || targetHeight > MAX_PDF_PAGE_EDGE_POINTS
    ) {
      throw new Error(
        mode === "expand"
          ? "Expanded PDF pages cannot exceed 200 inches. Move distant writing closer or use Fit like OpenBoard."
          : "The source PDF page is too large to export safely.",
      );
    }
    const contentWidth = bounds.width * scale;
    const contentHeight = bounds.height * scale;
    const originX = (targetWidth - contentWidth) / 2 - bounds.minX * scale;
    const originFromTop = (targetHeight - contentHeight) / 2 - bounds.minY * scale;
    const sourceBottom = targetHeight - originFromTop - workspace.height * scale;
    const targetPage = output.addPage([targetWidth, targetHeight]);
    const sourceBox = getVisibleSourcePageBox(sourcePage);
    validateSourcePageGeometry(
      workspace.rotation,
      workspace.width,
      workspace.height,
      sourceBox,
      getSourcePageUserUnit(sourcePage),
      sourcePage.getRotation().angle,
    );

    // pdf-lib defers a failure for valid blank pages until save time. A truly
    // blank page is already represented by the blank target. Widget- or
    // annotation-only pages now have vector content after source preparation.
    if (sourcePage.node.Contents()) {
      const embeddedPage = await output.embedPage(sourcePage, sourceBox);
      drawEmbeddedSourcePage(
        targetPage,
        embeddedPage,
        workspace.rotation,
        originX,
        sourceBottom,
        scale,
        workspace.width,
        workspace.height,
      );
    }

    const annotations = await renderAnnotations(scene, scale);
    if (annotations) {
      const [x1, y1, x2, y2] = annotations.bounds;
      const image = await output.embedPng(annotations.bytes);
      const width = (x2 - x1) * scale;
      const height = (y2 - y1) * scale;
      targetPage.drawImage(image, {
        x: originX + x1 * scale,
        y: targetHeight - (originFromTop + y1 * scale + height),
        width,
        height,
      });
    }
  }

  return new Blob([Uint8Array.from(await output.save()).buffer], { type: "application/pdf" });
}

export async function exportSlidesPdf(project: ClassroomProject): Promise<Blob> {
  if (!project.slideOrder.length) throw new Error("Add at least one frame slide before exporting.");
  const output = await PDFDocument.create();
  output.setTitle(`${project.title} — slides`);
  output.setCreator("PatterDraw");

  for (const slide of project.slideOrder) {
    const scene = project.scenes[slide.sceneId];
    if (!scene) continue;
    const renderData = getSlideRenderData(scene, slide.frameId);
    if (!renderData) continue;
    const canvas = await exportToCanvas({
      elements: renderData.elements,
      files: renderData.files,
      exportingFrame: renderData.frame,
      appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
      exportPadding: 0,
      getDimensions: (width: number, height: number) => ({
        width: Math.max(1, Math.ceil(width * ANNOTATION_SCALE)),
        height: Math.max(1, Math.ceil(height * ANNOTATION_SCALE)),
        scale: ANNOTATION_SCALE,
      }),
    });
    const image = await output.embedPng(await canvasPngBytes(canvas));
    const page = output.addPage([
      Math.max(renderData.frame.width, 1),
      Math.max(renderData.frame.height, 1),
    ]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }

  if (!output.getPageCount()) throw new Error("No valid frame slides were found.");
  return new Blob([Uint8Array.from(await output.save()).buffer], { type: "application/pdf" });
}
