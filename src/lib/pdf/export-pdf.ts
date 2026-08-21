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
import { isBlockedEmbeddedElementType } from "../embedded-content-policy";
import { sha256Hex } from "../sha256";
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
  releasePdfRasterCanvas,
  type PdfRasterBudget,
} from "./raster-limits";
import {
  awaitPdfOperation,
  reportPdfOperationProgress,
  throwIfPdfOperationAborted,
  type PdfOperationPhase,
  type PdfOperationProgressCallback,
} from "./operation-progress";
import { isPatterDrawPdfAnnotation } from "./annotations";
import {
  getPdfPageDisplayGeometry,
  getPdfPageEffectiveRotation,
} from "./page-rotation";

export type PdfExportMode = "expand" | "openboard-fit";

export interface ExportAnnotatedPdfOptions {
  signal?: AbortSignal;
  onProgress?: PdfOperationProgressCallback;
}

export interface ExportSlidesPdfOptions extends ExportAnnotatedPdfOptions {}

export type PdfExportFailureCode = "encrypted-source" | "unsupported-source";

export class PdfExportError extends Error {
  constructor(
    message: string,
    public readonly code: PdfExportFailureCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfExportError";
  }
}

const EXPORT_PADDING = 24;
const ANNOTATION_SCALE = 2;

function asElements(scene: SerializedScene): ExcalidrawElement[] {
  return scene.elements as unknown as ExcalidrawElement[];
}

function asFiles(scene: SerializedScene): BinaryFiles {
  return scene.files as unknown as BinaryFiles;
}

async function awaitExportCanvas(
  promise: Promise<HTMLCanvasElement>,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  const cleanupAfterLateAbort = promise.then((canvas) => {
    if (signal?.aborted) {
      releasePdfRasterCanvas(canvas);
      throwIfPdfOperationAborted(signal);
    }
    return canvas;
  });
  return awaitPdfOperation<HTMLCanvasElement>(cleanupAfterLateAbort, signal);
}

export function getPdfPageExportBounds(scene: SerializedScene): ExportBounds {
  if (!scene.pdfPage) throw new Error("Scene is not a PDF page workspace.");
  // This exact set is also passed to exportToCanvas. Elements omitted from
  // annotation output must never influence expanded page geometry.
  const annotationElements = pdfAnnotationElements(scene);
  const display = getPdfPageDisplayGeometry(scene.pdfPage);
  const base = [0, 0, display.width, display.height] as const;
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
  signal?: AbortSignal,
): Promise<{
  bytes: Uint8Array;
  bounds: readonly [number, number, number, number];
} | null> {
  if (!scene.pdfPage) return null;
  const elements = pdfAnnotationElements(scene);
  if (!elements.length) return null;
  const bounds = getCommonBounds(elements);
  throwIfPdfOperationAborted(signal);
  const canvasPromise = exportToCanvas({
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
  }) as Promise<HTMLCanvasElement>;
  const canvas = await awaitExportCanvas(canvasPromise, signal);
  const bytes = await awaitPdfOperation(pdfRasterCanvasToPngBytes(canvas), signal);
  throwIfPdfOperationAborted(signal);
  return { bytes, bounds };
}

function pdfAnnotationElements(
  scene: SerializedScene,
): NonDeletedExcalidrawElement[] {
  if (!scene.pdfPage) return [];
  return asElements(scene).filter(
    (element): element is NonDeletedExcalidrawElement =>
      isPatterDrawPdfAnnotation(scene, element) &&
      // Frames are counted and clearable user annotations, but are wrapper
      // navigation boundaries rather than visible PDF ink. Blocked embeds are
      // rejected at project-safety boundaries and remain defense-in-depth here.
      element.type !== "frame" &&
      !isBlockedEmbeddedElementType(element.type),
  );
}

function reportExportProgress(
  options: ExportAnnotatedPdfOptions,
  phase: PdfOperationPhase,
  documentPosition: number,
  documentTotal: number,
  pagePosition: number,
  pageTotal: number,
  documentName?: string,
): void {
  reportPdfOperationProgress(options.onProgress, {
    operation: "export",
    phase,
    documentPosition,
    documentTotal,
    pagePosition,
    pageTotal,
    ...(documentName ? { documentName } : {}),
  }, options.signal);
}

/** Convert parser-specific failures into stable, actionable export errors. */
export function normalizePdfExportError(
  error: unknown,
  documentName?: string,
): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  const label = documentName ? `“${documentName}”` : "The source PDF";
  if (/password|encrypted|encryption/i.test(message)) {
    return new PdfExportError(
      `${label} is password-protected or encrypted. Save or print an unlocked copy, re-import it, and export again.`,
      "encrypted-source",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (
    /unsupported|not supported|without a reusable appearance|NoZoom|NoRotate|invalid .* appearance|invalid .* transform|cannot (?:be )?embed|failed to parse/i.test(message)
  ) {
    return new PdfExportError(
      `PatterDraw cannot safely preserve a PDF feature used by ${label}. Save or print a flattened copy, re-import it, and export again.`,
      "unsupported-source",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return error instanceof Error ? error : new Error(message);
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
  options: ExportAnnotatedPdfOptions = {},
): Promise<Blob> {
  throwIfPdfOperationAborted(options.signal);
  const scenes = orderedPdfScenes(project)
    .filter((scene): scene is SerializedScene & { pdfPage: NonNullable<SerializedScene["pdfPage"]> } => !!scene.pdfPage);
  if (!scenes.length) throw new Error("This project has no imported PDF pages.");

  const output = await awaitPdfOperation(PDFDocument.create(), options.signal);
  const rasterBudget = getPdfAnnotationRasterBudget(
    scenes,
    getBrowserPdfRasterBudget(),
  );
  output.setTitle(project.title);
  output.setCreator("PatterDraw");
  output.setProducer("PatterDraw offline PDF exporter");

  const targets = scenes.map((scene) => {
    throwIfPdfOperationAborted(options.signal);
    const workspace = scene.pdfPage;
    const display = getPdfPageDisplayGeometry(workspace);
    const bounds = getPdfPageExportBounds(scene);
    const scale = mode === "openboard-fit"
      ? Math.min(display.width / bounds.width, display.height / bounds.height)
      : 1;
    const targetWidth = mode === "openboard-fit" ? display.width : bounds.width;
    const targetHeight = mode === "openboard-fit" ? display.height : bounds.height;
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
    const sourceBottom = targetHeight - originFromTop - display.height * scale;
    const targetPage = output.addPage([targetWidth, targetHeight]);
    return {
      originFromTop,
      originX,
      scale,
      scene,
      sourceBottom,
      displayWidth: display.width,
      displayHeight: display.height,
      targetHeight,
      targetPage,
    };
  });
  const targetsByDocument = new Map<PdfDocumentId, typeof targets>();
  for (const target of targets) {
    throwIfPdfOperationAborted(options.signal);
    const id = target.scene.pdfPage.documentId;
    const documentTargets = targetsByDocument.get(id);
    if (documentTargets) documentTargets.push(target);
    else targetsByDocument.set(id, [target]);
  }

  // Parse and flatten one donor PDF at a time. Its vector object graph is
  // copied into `output` before the next donor is opened, so every parsed
  // source context does not coexist with the growing export.
  const documentTotal = targetsByDocument.size;
  let documentIndex = 0;
  for (const [id, documentTargets] of targetsByDocument) {
    documentIndex += 1;
    throwIfPdfOperationAborted(options.signal);
    const bytes = pdfBytes[id];
    if (!bytes) throw new Error("The project is missing source PDF data.");
    const source = project.pdfDocuments[id];
    if (!source) throw new Error("The project is missing source PDF metadata.");
    reportExportProgress(
      options,
      "validating",
      documentIndex,
      documentTotal,
      0,
      documentTargets.length,
      source.name,
    );
    if (bytes.byteLength !== source.byteLength) {
      throw new Error(`The source PDF data no longer matches the saved project for ${source.name}.`);
    }
    if (
      source.sha256
      && await awaitPdfOperation(sha256Hex(bytes), options.signal) !== source.sha256
    ) {
      throw new Error(`The source PDF data no longer matches the saved project for ${source.name}.`);
    }
    reportExportProgress(
      options,
      "loading",
      documentIndex,
      documentTotal,
      0,
      documentTargets.length,
      source.name,
    );
    let sourceDocument: PDFDocument;
    try {
      sourceDocument = await awaitPdfOperation(
        PDFDocument.load(bytes, { updateMetadata: false }),
        options.signal,
      );
      reportExportProgress(
        options,
        "preflighting",
        documentIndex,
        documentTotal,
        0,
        documentTargets.length,
        source.name,
      );
      prepareSourcePdfForEmbedding(
        sourceDocument,
        documentTargets.map((target) => target.scene.pdfPage.pageIndex),
      );
    } catch (error) {
      throw normalizePdfExportError(error, source.name);
    }

    const preparedTargets = documentTargets.map((target, targetIndex) => {
      reportExportProgress(
        options,
        "preflighting",
        documentIndex,
        documentTotal,
        targetIndex + 1,
        documentTargets.length,
        source.name,
      );
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
    let embeddedPages: Awaited<ReturnType<PDFDocument["embedPages"]>>;
    try {
      embeddedPages = await awaitPdfOperation(output.embedPages(
        contentTargets.map(({ sourcePage }) => sourcePage),
        contentTargets.map(({ sourceBox }) => sourceBox),
      ), options.signal);
    } catch (error) {
      throw normalizePdfExportError(error, source.name);
    }
    const sourceObjectCopier = PDFObjectCopier.for(
      sourceDocument.context,
      output.context,
    );
    for (let index = 0; index < contentTargets.length; index += 1) {
      reportExportProgress(
        options,
        "embedding",
        documentIndex,
        documentTotal,
        index + 1,
        contentTargets.length,
        source.name,
      );
      const { sourcePage, target } = contentTargets[index];
      const embeddedPage = embeddedPages[index];
      const workspace = target.scene.pdfPage;
      try {
        await awaitPdfOperation(copySourcePageTransparencyGroup(
          sourcePage,
          embeddedPage,
          sourceObjectCopier,
        ), options.signal);
        await awaitPdfOperation(embeddedPage.embed(), options.signal);
      } catch (error) {
        throw normalizePdfExportError(error, source.name);
      }
      drawEmbeddedSourcePage(
        target.targetPage,
        embeddedPage,
        getPdfPageEffectiveRotation(workspace),
        target.originX,
        target.sourceBottom,
        target.scale,
        // drawPage's width/height are the current displayed page dimensions;
        // its quarter-turn branch swaps them back to the immutable source
        // form dimensions. This works for every source/view combination:
        // source 90 + view 90, for example, supplies display W/H = raw W/H
        // while the effective 180-degree branch leaves them unchanged.
        target.displayWidth,
        target.displayHeight,
      );
    }

    for (let targetIndex = 0; targetIndex < documentTargets.length; targetIndex += 1) {
      const target = documentTargets[targetIndex];
      reportExportProgress(
        options,
        "rendering",
        documentIndex,
        documentTotal,
        targetIndex + 1,
        documentTargets.length,
        source.name,
      );
      const { scene, targetPage } = target;
      const annotations = await renderAnnotations(
        scene,
        target.scale,
        rasterBudget,
        options.signal,
      );
      if (annotations) {
        const [x1, y1, x2, y2] = annotations.bounds;
        const image = await awaitPdfOperation(output.embedPng(annotations.bytes), options.signal);
        const width = (x2 - x1) * target.scale;
        const height = (y2 - y1) * target.scale;
        targetPage.drawImage(image, {
          x: target.originX + x1 * target.scale,
          y: target.targetHeight - (target.originFromTop + y1 * target.scale + height),
          width,
          height,
        });
        await awaitPdfOperation(image.embed(), options.signal);
      }
    }
  }

  reportExportProgress(
    options,
    "saving",
    documentTotal,
    documentTotal,
    0,
    scenes.length,
  );
  const savedBytes = await awaitPdfOperation(output.save(), options.signal);
  throwIfPdfOperationAborted(options.signal);
  return new Blob([bytesForBlob(savedBytes)], { type: "application/pdf" });
}

export async function exportSlidesPdf(
  project: ClassroomProject,
  options: ExportSlidesPdfOptions = {},
): Promise<Blob> {
  throwIfPdfOperationAborted(options.signal);
  if (!project.slideOrder.length) throw new Error("Add at least one frame slide before exporting.");
  const output = await awaitPdfOperation(PDFDocument.create(), options.signal);
  const rasterBudget = getPdfExportRasterBudget(
    getBrowserPdfRasterBudget(),
    project.slideOrder.length,
  );
  output.setTitle(`${project.title} — slides`);
  output.setCreator("PatterDraw");

  for (let slideIndex = 0; slideIndex < project.slideOrder.length; slideIndex += 1) {
    const slide = project.slideOrder[slideIndex];
    reportExportProgress(
      options,
      "rendering",
      1,
      1,
      slideIndex + 1,
      project.slideOrder.length,
      `${project.title} — slides`,
    );
    const scene = project.scenes[slide.sceneId];
    if (!scene) continue;
    const renderData = getSlideRenderData(scene, slide.frameId);
    if (!renderData) continue;
    const dimensions = getSlidePdfExportDimensions(
      renderData.frame.width,
      renderData.frame.height,
      rasterBudget,
    );
    const canvas = await awaitExportCanvas(exportToCanvas({
      elements: renderData.elements,
      files: renderData.files,
      exportingFrame: renderData.frame,
      appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
      exportPadding: 0,
      getDimensions: () => dimensions,
    }) as Promise<HTMLCanvasElement>, options.signal);
    const imageBytes = await awaitPdfOperation(
      pdfRasterCanvasToPngBytes(canvas),
      options.signal,
    );
    const image = await awaitPdfOperation(output.embedPng(imageBytes), options.signal);
    const page = output.addPage([
      Math.max(renderData.frame.width, 1),
      Math.max(renderData.frame.height, 1),
    ]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    await awaitPdfOperation(image.embed(), options.signal);
  }

  if (!output.getPageCount()) throw new Error("No valid frame slides were found.");
  reportExportProgress(
    options,
    "saving",
    1,
    1,
    0,
    project.slideOrder.length,
    `${project.title} — slides`,
  );
  const savedBytes = await awaitPdfOperation(output.save(), options.signal);
  throwIfPdfOperationAborted(options.signal);
  return new Blob([bytesForBlob(savedBytes)], { type: "application/pdf" });
}
