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
  getPdfExportResourceLimits,
  getBrowserPdfRasterBudget,
  getPdfExportRasterBudget,
  MAX_PDF_PAGE_EDGE_POINTS,
  pdfRasterCanvasToPngBytes,
  releasePdfRasterCanvas,
  type PdfExportResourceLimits,
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
import {
  drawHybridVectorRun,
  HybridAnnotationPlanError,
  planHybridAnnotationRuns,
  type HybridAnnotationPlan,
  type HybridAnnotationRun,
  type HybridRasterReason,
} from "./hybrid-annotations";

export type PdfExportMode = "expand" | "openboard-fit";

export interface ExportAnnotatedPdfOptions {
  signal?: AbortSignal;
  onProgress?: PdfOperationProgressCallback;
  /** Hybrid is primary; visual uses the legacy whole-annotation raster. */
  annotationMode?: PdfAnnotationExportMode;
  /** Local-only evidence for UI/debug output. Never transmitted or persisted. */
  onDiagnostics?: (diagnostics: Readonly<PdfExportDiagnostics>) => void;
  /** Finer progress/cancellation boundary for hybrid vector/raster runs. */
  onAnnotationRunProgress?: (
    progress: Readonly<PdfAnnotationRunProgress>,
  ) => void;
  /** Test/device override; production callers should use the defaults. */
  resourceLimits?: Partial<PdfExportResourceLimits>;
}

export interface ExportSlidesPdfOptions extends ExportAnnotatedPdfOptions {}

export type PdfAnnotationExportMode = "hybrid" | "visual";

export interface PdfAnnotationRunProgress {
  sceneId: string;
  pagePosition: number;
  pageTotal: number;
  runPosition: number;
  runTotal: number;
  runKind: "vector" | "raster";
}

export interface PdfExportPageDiagnostics {
  sceneId: string;
  annotationCount: number;
  runCount: number;
  vectorElementCount: number;
  rasterElementCount: number;
  rasterizedTypes: readonly string[];
  rasterReasons: Readonly<Partial<Record<HybridRasterReason, number>>>;
}

export interface PdfExportDiagnostics {
  annotationMode: PdfAnnotationExportMode;
  pageCount: number;
  sourceDocumentCount: number;
  vectorElementCount: number;
  vectorPathOperations: number;
  rasterElementCount: number;
  rasterRunCount: number;
  rasterPixels: number;
  rasterBytes: number;
  outputBytes: number;
  pages: readonly PdfExportPageDiagnostics[];
}

export interface PdfExportResult {
  blob: Blob;
  diagnostics: Readonly<PdfExportDiagnostics>;
}

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

export type PdfExportLimitCode =
  | "raster-geometry"
  | "raster-pixels"
  | "raster-bytes"
  | "vector-elements"
  | "vector-path-operations"
  | "output-bytes";

export class PdfExportLimitError extends Error {
  constructor(
    message: string,
    public readonly code: PdfExportLimitCode,
    public readonly actual: number,
    public readonly limit: number,
  ) {
    super(message);
    this.name = "PdfExportLimitError";
  }
}

export class PdfHybridFallbackRequiredError extends Error {
  readonly code = "hybrid-visual-fallback-required" as const;
  readonly fallbackMode = "visual" as const;

  constructor(
    message: string,
    public readonly reason:
      | "too-many-runs"
      | "dependent-elements-separated",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfHybridFallbackRequiredError";
  }
}

const EXPORT_PADDING = 24;
const ANNOTATION_SCALE = 2;

class PdfExportResourceTracker {
  vectorElements = 0;
  vectorPathOperations = 0;
  rasterPixels = 0;
  rasterBytes = 0;
  outputBytes = 0;

  constructor(readonly limits: Readonly<PdfExportResourceLimits>) {}

  chargeVector(elements: number, pathOperations: number): void {
    this.vectorElements += elements;
    this.vectorPathOperations += pathOperations;
    if (this.vectorElements > this.limits.maxVectorElements) {
      throw new PdfExportLimitError(
        "The PDF has too many vector annotations to export safely.",
        "vector-elements",
        this.vectorElements,
        this.limits.maxVectorElements,
      );
    }
    if (this.vectorPathOperations > this.limits.maxVectorPathOperations) {
      throw new PdfExportLimitError(
        "The PDF vector annotations are too complex to export safely.",
        "vector-path-operations",
        this.vectorPathOperations,
        this.limits.maxVectorPathOperations,
      );
    }
  }

  chargeRasterPixels(pixels: number): void {
    if (!Number.isSafeInteger(pixels) || pixels <= 0) {
      throw new PdfExportLimitError(
        "A PDF annotation raster has invalid dimensions.",
        "raster-geometry",
        pixels,
        this.limits.maxRasterPixels,
      );
    }
    this.rasterPixels += pixels;
    if (this.rasterPixels > this.limits.maxRasterPixels) {
      throw new PdfExportLimitError(
        "The PDF annotations require too much raster memory to export safely.",
        "raster-pixels",
        this.rasterPixels,
        this.limits.maxRasterPixels,
      );
    }
  }

  chargeRasterBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new PdfExportLimitError(
        "A PDF annotation raster produced invalid encoded data.",
        "raster-bytes",
        bytes,
        this.limits.maxRasterBytes,
      );
    }
    this.rasterBytes += bytes;
    if (this.rasterBytes > this.limits.maxRasterBytes) {
      throw new PdfExportLimitError(
        "The PDF annotations produce too much raster data to export safely.",
        "raster-bytes",
        this.rasterBytes,
        this.limits.maxRasterBytes,
      );
    }
  }

  chargeOutputBytes(bytes: number): void {
    this.outputBytes = bytes;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.limits.maxOutputBytes) {
      throw new PdfExportLimitError(
        "The exported PDF is larger than the safe local file limit.",
        "output-bytes",
        bytes,
        this.limits.maxOutputBytes,
      );
    }
  }
}

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

async function encodeExportCanvas(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await awaitPdfOperation(pdfRasterCanvasToPngBytes(canvas), signal);
  } finally {
    // The PNG helper releases on normal completion. This additional release is
    // what drops the bitmap immediately when AbortSignal wins a pending
    // browser toBlob callback (which cannot itself be cancelled).
    releasePdfRasterCanvas(canvas);
  }
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
  elements: readonly NonDeletedExcalidrawElement[],
  pageScale: number,
  rasterBudget: Readonly<PdfRasterBudget>,
  resources: PdfExportResourceTracker,
  signal?: AbortSignal,
): Promise<{
  bytes: Uint8Array;
  bounds: readonly [number, number, number, number];
} | null> {
  if (!scene.pdfPage) return null;
  if (!elements.length) return null;
  const bounds = getCommonBounds(elements);
  if (
    bounds.some((coordinate) => !Number.isFinite(coordinate))
    || bounds[2] <= bounds[0]
    || bounds[3] <= bounds[1]
  ) {
    throw new PdfExportLimitError(
      "A PDF annotation raster has invalid scene bounds.",
      "raster-geometry",
      Number.NaN,
      resources.limits.maxRasterPixels,
    );
  }
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
  const pixels = canvas.width * canvas.height;
  try {
    resources.chargeRasterPixels(pixels);
  } catch (error) {
    releasePdfRasterCanvas(canvas);
    throw error;
  }
  const bytes = await encodeExportCanvas(canvas, signal);
  resources.chargeRasterBytes(bytes.byteLength);
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

function emptyHybridPlan(
  elements: readonly NonDeletedExcalidrawElement[],
): HybridAnnotationPlan {
  const rasterReasons = Object.freeze({
    "unsupported-type": elements.length,
    "frame-clipping": 0,
    "visual-style": 0,
    "invalid-geometry": 0,
    "vector-budget": 0,
  });
  return Object.freeze({
    runs: elements.length
      ? Object.freeze([Object.freeze({
          kind: "raster" as const,
          elements: Object.freeze(elements.slice()),
          rasterReasons: Object.freeze(elements.map(() => "unsupported-type" as const)),
        })])
      : Object.freeze([]),
    vectorElementCount: 0,
    vectorPathOperations: 0,
    rasterElementCount: elements.length,
    rasterizedTypes: Object.freeze(Array.from(
      new Set(elements.map((element) => String(element.type))),
    ).sort()),
    rasterReasons,
  });
}

function pageDiagnostics(
  sceneId: string,
  annotationCount: number,
  plan: HybridAnnotationPlan,
): PdfExportPageDiagnostics {
  return Object.freeze({
    sceneId,
    annotationCount,
    runCount: plan.runs.length,
    vectorElementCount: plan.vectorElementCount,
    rasterElementCount: plan.rasterElementCount,
    rasterizedTypes: plan.rasterizedTypes,
    rasterReasons: plan.rasterReasons,
  });
}

async function drawRasterAnnotationRun(
  output: PDFDocument,
  targetPage: ReturnType<PDFDocument["addPage"]>,
  scene: SerializedScene,
  run: HybridAnnotationRun,
  target: {
    scale: number;
    originX: number;
    originFromTop: number;
    targetHeight: number;
  },
  rasterBudget: Readonly<PdfRasterBudget>,
  resources: PdfExportResourceTracker,
  signal?: AbortSignal,
): Promise<void> {
  const annotations = await renderAnnotations(
    scene,
    run.elements,
    target.scale,
    rasterBudget,
    resources,
    signal,
  );
  if (!annotations) return;
  const [x1, y1, x2, y2] = annotations.bounds;
  const image = await awaitPdfOperation(output.embedPng(annotations.bytes), signal);
  const width = (x2 - x1) * target.scale;
  const height = (y2 - y1) * target.scale;
  targetPage.drawImage(image, {
    x: target.originX + x1 * target.scale,
    y: target.targetHeight - (target.originFromTop + y1 * target.scale + height),
    width,
    height,
  });
  await awaitPdfOperation(image.embed(), signal);
}

function reportAnnotationRunProgress(
  options: ExportAnnotatedPdfOptions,
  progress: PdfAnnotationRunProgress,
): void {
  throwIfPdfOperationAborted(options.signal);
  options.onAnnotationRunProgress?.(Object.freeze({ ...progress }));
  throwIfPdfOperationAborted(options.signal);
}

export async function exportAnnotatedPdfWithDiagnostics(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  mode: PdfExportMode = "expand",
  options: ExportAnnotatedPdfOptions = {},
): Promise<PdfExportResult> {
  throwIfPdfOperationAborted(options.signal);
  const annotationMode = options.annotationMode ?? "hybrid";
  if (annotationMode !== "hybrid" && annotationMode !== "visual") {
    throw new Error("The PDF annotation export mode is invalid.");
  }
  const scenes = orderedPdfScenes(project)
    .filter((scene): scene is SerializedScene & { pdfPage: NonNullable<SerializedScene["pdfPage"]> } => !!scene.pdfPage);
  if (!scenes.length) throw new Error("This project has no imported PDF pages.");

  const output = await awaitPdfOperation(PDFDocument.create(), options.signal);
  const browserRasterBudget = getBrowserPdfRasterBudget();
  const requestedResourceLimits = getPdfExportResourceLimits(options.resourceLimits);
  const resources = new PdfExportResourceTracker(Object.freeze({
    ...requestedResourceLimits,
    maxRasterPixels: Math.min(
      requestedResourceLimits.maxRasterPixels,
      browserRasterBudget.maxPixelsPerDocument,
    ),
  }));
  const diagnosticPages = new Map<string, PdfExportPageDiagnostics>();
  const scenePositions = new Map(
    scenes.map((scene, index) => [scene.id, index + 1] as const),
  );
  let rasterRunCount = 0;
  let hybridRunCount = 0;
  const rasterBudget = getPdfAnnotationRasterBudget(
    scenes,
    browserRasterBudget,
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
      const elements = pdfAnnotationElements(scene);
      let plan: HybridAnnotationPlan;
      if (annotationMode === "visual") {
        plan = emptyHybridPlan(elements);
      } else if (elements.length) {
        const remainingRuns = resources.limits.maxHybridRuns - hybridRunCount;
        if (remainingRuns <= 0) {
          throw new PdfHybridFallbackRequiredError(
            "The annotation stack has too many alternating layers for safe hybrid export. Confirm the visual PDF fallback to retry.",
            "too-many-runs",
          );
        }
        try {
          plan = planHybridAnnotationRuns(elements, {
            maxRuns: remainingRuns,
            maxVectorElements: Math.max(
              0,
              resources.limits.maxVectorElements - resources.vectorElements,
            ),
            maxVectorPathOperations: Math.max(
              0,
              resources.limits.maxVectorPathOperations - resources.vectorPathOperations,
            ),
          });
        } catch (error) {
          if (error instanceof HybridAnnotationPlanError) {
            throw new PdfHybridFallbackRequiredError(
              `${error.message} Confirm the visual PDF fallback to retry.`,
              error.code,
              { cause: error },
            );
          }
          // Only an explicit planner incompatibility is eligible for the
          // user-confirmed visual retry. Unexpected runtime, memory, DOM, and
          // renderer failures must retain their original identity because the
          // visual path uses the same (or a larger) raster pipeline.
          throw error;
        }
        hybridRunCount += plan.runs.length;
      } else {
        plan = emptyHybridPlan(elements);
      }

      diagnosticPages.set(
        scene.id,
        pageDiagnostics(scene.id, elements.length, plan),
      );
      const pagePosition = scenePositions.get(scene.id) ?? targetIndex + 1;
      for (let runIndex = 0; runIndex < plan.runs.length; runIndex += 1) {
        const run = plan.runs[runIndex];
        // The ordinary operation callback is repeated between runs so existing
        // UI receives a cancellation boundary without requiring a new display.
        reportExportProgress(
          options,
          "rendering",
          documentIndex,
          documentTotal,
          targetIndex + 1,
          documentTargets.length,
          source.name,
        );
        reportAnnotationRunProgress(options, {
          sceneId: scene.id,
          pagePosition,
          pageTotal: scenes.length,
          runPosition: runIndex + 1,
          runTotal: plan.runs.length,
          runKind: run.kind,
        });
        if (run.kind === "vector") {
          resources.chargeVector(
            run.elements.length,
            run.vectorInstructions?.reduce(
              (total, vector) => total + vector.pathOperations,
              0,
            ) ?? 0,
          );
          drawHybridVectorRun(targetPage, run, {
            originX: target.originX,
            originFromTop: target.originFromTop,
            targetHeight: target.targetHeight,
            scale: target.scale,
          });
        } else {
          rasterRunCount += 1;
          await drawRasterAnnotationRun(
            output,
            targetPage,
            scene,
            run,
            target,
            rasterBudget,
            resources,
            options.signal,
          );
        }
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
  resources.chargeOutputBytes(savedBytes.byteLength);
  throwIfPdfOperationAborted(options.signal);
  const diagnostics = Object.freeze({
    annotationMode,
    pageCount: scenes.length,
    sourceDocumentCount: documentTotal,
    vectorElementCount: resources.vectorElements,
    vectorPathOperations: resources.vectorPathOperations,
    rasterElementCount: Array.from(diagnosticPages.values()).reduce(
      (total, page) => total + page.rasterElementCount,
      0,
    ),
    rasterRunCount,
    rasterPixels: resources.rasterPixels,
    rasterBytes: resources.rasterBytes,
    outputBytes: resources.outputBytes,
    pages: Object.freeze(scenes.map((scene) => (
      diagnosticPages.get(scene.id)
      ?? pageDiagnostics(scene.id, 0, emptyHybridPlan([]))
    ))),
  }) satisfies Readonly<PdfExportDiagnostics>;
  options.onDiagnostics?.(diagnostics);
  return Object.freeze({
    blob: new Blob([bytesForBlob(savedBytes)], { type: "application/pdf" }),
    diagnostics,
  });
}

export async function exportAnnotatedPdf(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  mode: PdfExportMode = "expand",
  options: ExportAnnotatedPdfOptions = {},
): Promise<Blob> {
  return (await exportAnnotatedPdfWithDiagnostics(
    project,
    pdfBytes,
    mode,
    options,
  )).blob;
}

export async function exportSlidesPdf(
  project: ClassroomProject,
  options: ExportSlidesPdfOptions = {},
): Promise<Blob> {
  throwIfPdfOperationAborted(options.signal);
  if (!project.slideOrder.length) throw new Error("Add at least one frame slide before exporting.");
  const output = await awaitPdfOperation(PDFDocument.create(), options.signal);
  const browserRasterBudget = getBrowserPdfRasterBudget();
  const requestedResourceLimits = getPdfExportResourceLimits(options.resourceLimits);
  const resources = new PdfExportResourceTracker(Object.freeze({
    ...requestedResourceLimits,
    maxRasterPixels: Math.min(
      requestedResourceLimits.maxRasterPixels,
      browserRasterBudget.maxPixelsPerDocument,
    ),
  }));
  const rasterBudget = getPdfExportRasterBudget(
    browserRasterBudget,
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
    try {
      resources.chargeRasterPixels(canvas.width * canvas.height);
    } catch (error) {
      releasePdfRasterCanvas(canvas);
      throw error;
    }
    const imageBytes = await encodeExportCanvas(canvas, options.signal);
    resources.chargeRasterBytes(imageBytes.byteLength);
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
  resources.chargeOutputBytes(savedBytes.byteLength);
  throwIfPdfOperationAborted(options.signal);
  return new Blob([bytesForBlob(savedBytes)], { type: "application/pdf" });
}
