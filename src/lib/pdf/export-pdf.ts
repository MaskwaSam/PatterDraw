import {
  exportToCanvas,
  getCommonBounds,
} from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { PDFDocument, PDFObjectCopier, degrees } from "pdf-lib";
import type {
  ClassroomProject,
  ExportBounds,
  PdfDocumentId,
  SerializedScene,
} from "../../types";
import { bytesForBlob } from "../blob-bytes";
import { getSlideRenderData } from "../slide-render";
import { orderedPdfScenes } from "./page-order";
import {
  copySourcePageTransparencyGroup,
  getSourcePageUserUnit,
  getVisibleSourcePageBox,
  prepareSourcePdfForEmbedding,
  type PdfSourcePageBox,
} from "./source-page";
import {
  DEFAULT_PDF_RASTER_BUDGET,
  getBrowserPdfRasterBudget,
  getPdfExportRasterBudget,
  MAX_PDF_PAGE_EDGE_POINTS,
  pdfRasterCanvasToPngBytes,
  type PdfRasterBudget,
} from "./raster-limits";

export type PdfExportMode = "expand" | "openboard-fit";

const EXPORT_PADDING = 24;
const ANNOTATION_SCALE = 2;

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

export function getPdfAnnotationExportDimensions(
  width: number,
  height: number,
  pageScale = 1,
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
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
    rasterBudget.maxEdge / width,
    rasterBudget.maxEdge / height,
    Math.sqrt(rasterBudget.maxPixelsPerPage) / Math.sqrt(width) / Math.sqrt(height),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

export function getSlidePdfExportDimensions(
  width: number,
  height: number,
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
): { width: number; height: number; scale: number } {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
    || width > MAX_PDF_PAGE_EDGE_POINTS
    || height > MAX_PDF_PAGE_EDGE_POINTS
  ) {
    throw new Error("Presentation slide frames must have valid dimensions no larger than 200 inches.");
  }
  return getPdfAnnotationExportDimensions(width, height, 1, rasterBudget);
}

async function renderAnnotations(
  scene: SerializedScene,
  pageScale: number,
  rasterBudget: Readonly<PdfRasterBudget>,
): Promise<{
  bytes: Uint8Array;
  bounds: readonly [number, number, number, number];
} | null> {
  if (!scene.pdfPage) return null;
  const elements = pdfAnnotationElements(scene);
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
      getPdfAnnotationExportDimensions(width, height, pageScale, rasterBudget)
    ),
  });
  return { bytes: await pdfRasterCanvasToPngBytes(canvas), bounds };
}

function pdfAnnotationElements(
  scene: SerializedScene,
): NonDeletedExcalidrawElement[] {
  if (!scene.pdfPage) return [];
  return asElements(scene).filter(
    (element): element is NonDeletedExcalidrawElement =>
      !element.isDeleted &&
      element.id !== scene.pdfPage?.backgroundElementId &&
      element.type !== "frame" &&
      element.type !== "embeddable" &&
      element.type !== "iframe" &&
      element.type !== "magicframe",
  );
}

export function getPdfAnnotationRasterBudget(
  scenes: readonly SerializedScene[],
  rasterBudget: Readonly<PdfRasterBudget> = DEFAULT_PDF_RASTER_BUDGET,
): Readonly<PdfRasterBudget> {
  const annotationPageCount = scenes.reduce(
    (count, scene) => count + (pdfAnnotationElements(scene).length ? 1 : 0),
    0,
  );
  return getPdfExportRasterBudget(
    rasterBudget,
    Math.max(1, annotationPageCount),
  );
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

  const output = await PDFDocument.create();
  const rasterBudget = getPdfAnnotationRasterBudget(
    scenes,
    getBrowserPdfRasterBudget(),
  );
  output.setTitle(project.title);
  output.setCreator("PatterDraw");
  output.setProducer("PatterDraw offline PDF exporter");

  const targets = scenes.map((scene) => {
    const workspace = scene.pdfPage;
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
    return {
      originFromTop,
      originX,
      scale,
      scene,
      sourceBottom,
      targetHeight,
      targetPage,
    };
  });
  const targetsByDocument = new Map<PdfDocumentId, typeof targets>();
  for (const target of targets) {
    const id = target.scene.pdfPage.documentId;
    const documentTargets = targetsByDocument.get(id);
    if (documentTargets) documentTargets.push(target);
    else targetsByDocument.set(id, [target]);
  }

  // Parse and flatten one donor PDF at a time. Its vector object graph is
  // copied into `output` before the next donor is opened, so every parsed
  // source context does not coexist with the growing export.
  for (const [id, documentTargets] of targetsByDocument) {
    const bytes = pdfBytes[id];
    if (!bytes) throw new Error("The project is missing source PDF data.");
    const sourceDocument = await PDFDocument.load(bytes, { updateMetadata: false });
    prepareSourcePdfForEmbedding(
      sourceDocument,
      documentTargets.map((target) => target.scene.pdfPage.pageIndex),
    );

    const preparedTargets = documentTargets.map((target) => {
      const { scene } = target;
      const workspace = scene.pdfPage;
      const sourcePage = sourceDocument.getPage(workspace.pageIndex);
      const sourceBox = getVisibleSourcePageBox(sourcePage);
      validateSourcePageGeometry(
        workspace.rotation,
        workspace.width,
        workspace.height,
        sourceBox,
        getSourcePageUserUnit(sourcePage),
        sourcePage.getRotation().angle,
      );
      return { sourceBox, sourcePage, target };
    });

    // One embedPages call reuses a single PDFObjectCopier, preserving shared
    // fonts/images across donor pages. Calling embedPage per page duplicates
    // those resources and can inflate a worksheet many times over.
    const contentTargets = preparedTargets.filter(
      ({ sourcePage }) => !!sourcePage.node.Contents(),
    );
    const embeddedPages = await output.embedPages(
      contentTargets.map(({ sourcePage }) => sourcePage),
      contentTargets.map(({ sourceBox }) => sourceBox),
    );
    const sourceObjectCopier = PDFObjectCopier.for(
      sourceDocument.context,
      output.context,
    );
    for (let index = 0; index < contentTargets.length; index += 1) {
      const { sourcePage, target } = contentTargets[index];
      const embeddedPage = embeddedPages[index];
      const workspace = target.scene.pdfPage;
      await copySourcePageTransparencyGroup(
        sourcePage,
        embeddedPage,
        sourceObjectCopier,
      );
      await embeddedPage.embed();
      drawEmbeddedSourcePage(
        target.targetPage,
        embeddedPage,
        workspace.rotation,
        target.originX,
        target.sourceBottom,
        target.scale,
        workspace.width,
        workspace.height,
      );
    }

    for (const target of documentTargets) {
      const { scene, targetPage } = target;
      const annotations = await renderAnnotations(scene, target.scale, rasterBudget);
      if (annotations) {
        const [x1, y1, x2, y2] = annotations.bounds;
        const image = await output.embedPng(annotations.bytes);
        const width = (x2 - x1) * target.scale;
        const height = (y2 - y1) * target.scale;
        targetPage.drawImage(image, {
          x: target.originX + x1 * target.scale,
          y: target.targetHeight - (target.originFromTop + y1 * target.scale + height),
          width,
          height,
        });
        await image.embed();
      }
    }
  }

  return new Blob([bytesForBlob(await output.save())], { type: "application/pdf" });
}

export async function exportSlidesPdf(project: ClassroomProject): Promise<Blob> {
  if (!project.slideOrder.length) throw new Error("Add at least one frame slide before exporting.");
  const output = await PDFDocument.create();
  const rasterBudget = getPdfExportRasterBudget(
    getBrowserPdfRasterBudget(),
    project.slideOrder.length,
  );
  output.setTitle(`${project.title} — slides`);
  output.setCreator("PatterDraw");

  for (const slide of project.slideOrder) {
    const scene = project.scenes[slide.sceneId];
    if (!scene) continue;
    const renderData = getSlideRenderData(scene, slide.frameId);
    if (!renderData) continue;
    const dimensions = getSlidePdfExportDimensions(
      renderData.frame.width,
      renderData.frame.height,
      rasterBudget,
    );
    const canvas = await exportToCanvas({
      elements: renderData.elements,
      files: renderData.files,
      exportingFrame: renderData.frame,
      appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
      exportPadding: 0,
      getDimensions: () => dimensions,
    });
    const image = await output.embedPng(await pdfRasterCanvasToPngBytes(canvas));
    const page = output.addPage([
      Math.max(renderData.frame.width, 1),
      Math.max(renderData.frame.height, 1),
    ]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    await image.embed();
  }

  if (!output.getPageCount()) throw new Error("No valid frame slides were found.");
  return new Blob([bytesForBlob(await output.save())], { type: "application/pdf" });
}
