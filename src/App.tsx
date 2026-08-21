import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  DefaultSidebar,
  Excalidraw,
  getDataURL,
  getCommonBounds,
  newElementWith,
  sceneCoordsToViewportCoords,
  serializeAsJSON,
  Sidebar,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type { LassoGeometrySnapshot } from "./lib/lasso/stable-element-adapter";
import { TopBar } from "./components/TopBar";
import { SlideRail } from "./components/SlideRail";
import { PDF_RAIL_DEFAULT_WIDTH, PdfPageRail } from "./components/PdfPageRail";
import {
  PdfInsertDialog,
  defaultPdfPageRange,
  type PdfInsertFileRowMetadata,
  type PdfInsertOperationProgress,
  type PdfInsertSubmission,
} from "./components/PdfInsertDialog";
import {
  ClearPdfAnnotationsDialog,
  type PdfAnnotationScopeSummaries,
} from "./components/ClearPdfAnnotationsDialog";
import { VisualPdfFallbackDialog } from "./components/VisualPdfFallbackDialog";
import { PresentationOverlay } from "./components/PresentationOverlay";
import { StrokeWidthExtensions } from "./components/StrokeWidthExtensions";
import { MathToolsMenuExtension } from "./components/MathToolsMenuExtension";
import { MathToolsDialog } from "./components/MathToolsDialog";
import { GeoGonDialog } from "./components/GeoGonDialog";
import { MathInteractionOverlay, type CapturedMathPoint } from "./components/MathInteractionOverlay";
import { ProbabilityRandomizer } from "./components/ProbabilityRandomizer";
import { SpinnerPointerOverlay, type SpinnerPointerAnimation } from "./components/SpinnerPointerOverlay";
import {
  CLASSROOM_LASSO_TOOL,
  LassoOverlay,
  lassoSelectionSnapshot,
  type LassoInitialSelection,
} from "./components/LassoOverlay";
import { BucketFillMenuExtension } from "./components/BucketFillMenuExtension";
import {
  BucketFillOverlay,
  CLASSROOM_BUCKET_FILL_TOOL,
} from "./components/BucketFillOverlay";
import { EquationDialog } from "./components/EquationDialog";
import { MermaidDialog } from "./components/MermaidDialog";
import { ProjectFindPanel } from "./components/ProjectFindPanel";
import { useModalDialog } from "./components/useModalDialog";
import { ScreenshotCaptureOverlay } from "./components/ScreenshotCaptureOverlay";
import {
  SCREENSHOT_DRAG_MIME,
  SCREENSHOT_SIDEBAR_TAB,
  ScreenshotLibrary,
} from "./components/ScreenshotLibrary";
import {
  EnterFullscreenIcon,
  ExitFullscreenIcon,
  HideBottomBarIcon,
  InkIcon,
  MinusIcon,
  NextIcon,
  PlusIcon,
  PresentIcon,
  PreviousIcon,
  RedoIcon,
  ScreenshotIcon,
  SearchIcon,
  ShowBottomBarIcon,
  ShowPanelIcon,
  ShowTopBarIcon,
  UndoIcon,
} from "./components/Icons";
import type {
  ClassroomProject,
  ClassroomSlide,
  LoadedClassroomProject,
  PdfDocumentId,
  SerializedScene,
  SlideFrameAspectRatio,
} from "./types";
import { createBlankProject } from "./types";
import {
  AutosaveConflictError,
  loadAutosave,
  saveAutosave,
} from "./lib/persistence";
import {
  AUTOSAVE_BASE_INTERVAL_MS,
  getAutosaveCooldownMs,
  getAutosaveFollowupDelayMs,
} from "./lib/autosave-policy";
import {
  loadLibraryItems,
  loadSafeLibraryFromBlob,
  sanitizeLibraryItems,
  saveLibraryItems,
} from "./lib/library-persistence";
import { decodeProjectFile, encodePreparedProjectFile } from "./lib/project-file";
import { bytesForBlob } from "./lib/blob-bytes";
import { downloadBlob, safeFileStem } from "./lib/download";
import { exportFullBoardPng } from "./lib/export-board";
import { createLocalId } from "./lib/id";
import {
  beginPngClipboardWrite,
  downsamplePngToByteLimit,
  exportScreenshotArea,
  pngBlobToDataUrl,
  viewportCaptureRectToSceneBounds,
  type ClipboardWriteResult,
  type ViewportCaptureRect,
} from "./lib/screenshots/capture";
import {
  addScreenshotToLibrary,
  loadScreenshotLibrary,
  saveScreenshotLibrary,
  type StoredScreenshot,
} from "./lib/screenshots/persistence";
import type { RenderedLatex } from "./lib/latex/render-latex";
import type { RenderedMermaid } from "./lib/mermaid/safe-mermaid";
import { canonicalizePdfBackground } from "./lib/pdf/background";
import { retireDarkPdfDisplayFile } from "./lib/pdf/dark-display-file";
import {
  createActivePdfPagePreviewKey,
  getActivePdfPagePreviewTarget,
  renderLightPdfPagePreview,
  shouldRenderLightPdfPageRefinement,
  type PdfPagePreviewQuality,
  type PdfPagePreviewTheme,
} from "./lib/pdf/active-page-preview";
import {
  fitPdfRasterDimensions,
  getPdfRasterDimensions,
  renderDarkPdfPreview,
} from "./lib/pdf/dark-preview";
import {
  getBrowserPdfRasterDeviceTier,
  type PdfRasterDeviceTier,
} from "./lib/pdf/raster-limits";
import {
  darkPdfThumbnailRenderSceneIds,
  pruneDarkPdfThumbnails,
  retainedDarkPdfThumbnailSceneIds,
  storeDarkPdfThumbnail,
  type DarkPdfThumbnailCacheEntry,
} from "./lib/pdf/dark-thumbnail-cache";
import {
  movePdfPage,
  orderedPdfScenes,
  reconcilePdfPageOrder,
  shiftPdfPage,
  type PdfPageDropEdge,
} from "./lib/pdf/page-order";
import {
  assertProjectCanAcceptPdfPages,
  remainingProjectSceneCapacity,
} from "./lib/pdf/capacity";
import {
  clearPdfAnnotations,
  getPdfAnnotationScopeSummary,
  undoPdfAnnotationClear,
  type PdfAnnotationClearScope,
  type PdfAnnotationClearTransaction,
} from "./lib/pdf/annotations";
import { assertPdfAdditionPreservesAnnotationUndo } from "./lib/pdf/annotation-undo-reservation";
import {
  deletePdfPageReversibly,
  duplicatePdfPage,
  pdfAdditionPreservesPageDeleteUndo,
  undoPdfPageDelete,
  type PdfPageDeleteTransaction,
} from "./lib/pdf/page-actions";
import {
  getPdfPageDisplayGeometry,
  getPdfPageEffectiveRotation,
  getPdfPageViewRotation,
  rotatePdfSceneQuarterTurn,
  type PdfPageRotationDirection,
} from "./lib/pdf/page-rotation";
import type { PdfExportMode } from "./lib/pdf/export-pdf";
import type { PdfOperationProgress } from "./lib/pdf/operation-progress";
import {
  deleteSlideBoundary,
  detachElementsFromSlideFrames,
  focusSlide,
  moveSlide,
  reconcileSlides,
  removeSlide,
  syncSlideFrameNames,
} from "./lib/slides";
import {
  DEFAULT_SLIDE_MORPH_DURATION_MS,
  normalizeSlideMorphDurationMs,
} from "./lib/slide-transition";
import {
  assertLoadedProjectRasterSafety,
  canonicalizePersistedWrapperTool,
  isPersistedWrapperTool,
  MAX_PROJECT_BYTES,
  sanitizeProject,
  sanitizeScene,
} from "./lib/safety";
import {
  generateSafeLocalImageFileId,
  inspectLocalImageDataUrl,
  inspectLocalImageBlob,
  rasterizeLocalImageToPngForInsertion,
  rasterizeLocalPngForInsertion,
  stripExcalidrawSvgSceneMetadata,
} from "./lib/image-safety";
import { geoGonSvgFromClipboardText } from "./lib/geogon";
import {
  assertClipboardTextPayloadsWithinLimit,
  clipboardElementsContainBlockedContent,
  clipboardHtmlContainsBlockedContent,
  installSafeClipboardReadGuard,
  isBlockedEmbeddedElementType,
  isSafeLocalImageClipboardType,
  validateEmbeddedContentUrl,
} from "./lib/embedded-content-policy";
import {
  assertProjectCanAcceptAdditionalBytes,
  assertProjectFitsContentBudget,
  getProjectContentSize,
  getJsonUtf8ByteLength,
} from "./lib/project-budget";
import {
  MAX_NATIVE_SCENE_BLOB_BYTES,
  assertImportBlobBytes,
  assertSceneStructure,
  parseBoundedImportJson,
} from "./lib/structural-limits";
import {
  DEFAULT_FEATURE_PREFERENCES,
  persistFeaturePreference,
  persistFeaturePreferences,
  readFeaturePreferences,
  subscribeToFeaturePreferences,
  type FeaturePreferenceKey,
  type FeaturePreferences,
} from "./lib/feature-preferences";
import {
  persistPdfPreference,
  readPdfPreferences,
  restoreDefaultPdfPreferences,
  subscribeToPdfPreferences,
  type PdfPreferenceKey,
} from "./lib/pdf/pdf-preferences";
import {
  DEFAULT_THEME_PREFERENCE,
  persistThemePreference,
  readThemePreference,
  resolvedTheme,
  subscribeToSystemTheme,
  subscribeToThemePreference,
  systemPrefersDark,
  type ThemePreference,
} from "./lib/theme-preference";
import type { ProjectSearchResult } from "./lib/project-search";
import {
  activateSlideFrameTool,
  addBlankSlideFrame,
  addSlideFrameAtBounds,
  frameBoundsFromDrag,
  freeformFrameBoundsFromDrag,
  slideFrameAspectRatioValue,
  type SlideFrameBounds,
  type SlideFramePoint,
} from "./lib/slide-frame-tool";
import {
  sanitizeClassroomMathToolMetadata,
  type GeneratedMathToolInsertion,
  type MathToolConfiguration,
} from "./lib/math-tools/types";
import type { MathInteractionKind } from "./lib/math-tools/catalogue";
import {
  createAngleMeasurement,
  createCompassConstruction,
  transformElementGeometry,
  transformationMetadata,
  type AngleMeasurementOptions,
  type CompassOptions,
  type TransformationOptions,
} from "./lib/math-tools/interactive";
import {
  randomizeProbabilityPiece,
  spinnerPointerAngle,
  spinnerPointerAnimationEndAngle,
  summarizeSelectedProbabilityPieces,
  type ProbabilitySelectionSummary,
} from "./lib/math-tools/probability-randomizer";
import { createUnitCircleMathJaxAsset } from "./lib/math-tools/unit-circle-latex";
import {
  activatePresentationInk,
  DEFAULT_PRESENTATION_INK_COLOUR,
  DEFAULT_PRESENTATION_INK_WIDTH,
  promoteNewPresentationInk,
  type PresentationInkColour,
  type PresentationInkWidth,
} from "./lib/presentation-ink";
import {
  boardSceneId,
  projectForBoardStartup,
  workspaceModeClassName,
  type WorkspaceMode,
} from "./lib/workspace-mode";
import "./styles.css";

type SaveStatus = "saved" | "saving" | "error";
type AutosaveRecoveryKind = "conflict" | "unreadable";
type PresentationState = {
  index: number;
  tool: "laser" | "freedraw";
  inkColour: PresentationInkColour;
  inkWidth: PresentationInkWidth;
};
type EquationEditorState = { targetId: string | null; initialSource: string };
type MermaidEditorState = { targetDiagramId: string | null; initialSource: string };
type MathToolEditState = { targetId: string; initialConfiguration: MathToolConfiguration };
type MathInteractionState = {
  kind: MathInteractionKind;
  points: CapturedMathPoint[];
  compassOptions: CompassOptions;
  angleOptions: AngleMeasurementOptions;
  transformationOptions: TransformationOptions;
  sourceElementIds: string[];
};
type SlideFrameAction =
  | { kind: "add"; frameId: string; title: string }
  | { kind: "draw" };
type PendingSlideFrameAction = {
  action: SlideFrameAction;
  sceneId: string;
};
type SlideFrameGesture = {
  current: SlideFramePoint;
  origin: SlideFramePoint;
  pointerId: number;
};
type PendingPresentationTransition = { frameId: string; animate: boolean; durationMs: number };
type PendingProjectSearchTarget = Pick<ProjectSearchResult, "elementId" | "sceneId">;
type PendingVisualPdfFallback = {
  project: ClassroomProject;
  pdfBytes: Record<PdfDocumentId, Uint8Array>;
  mode: PdfExportMode;
};
export type PendingScenePersistence = {
  sceneId: string;
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  preserveDeleted?: boolean;
};

/**
 * Keep normal debounced scene work ahead of a hydration-window buffer across
 * scene boundaries. For the same scene, the buffered snapshot is newer than
 * the earlier debounced snapshot and therefore replaces it. A buffer for
 * another scene is retained so the caller can commit the pending scene first
 * and then replay the buffered snapshot in order.
 */
export function preservePendingScenePersistence(
  pending: PendingScenePersistence | null,
  buffered: PendingScenePersistence | null,
): { pending: PendingScenePersistence | null; buffered: PendingScenePersistence | null } {
  if (!buffered) return { pending, buffered: null };
  if (!pending) return { pending: buffered, buffered: null };
  if (pending.sceneId === buffered.sceneId) return { pending: buffered, buffered: null };
  return { pending, buffered };
}

export function preserveDeletedForPendingPdfUndo(
  pending: PendingScenePersistence | null,
  affectedPageIds: readonly string[] | undefined,
): PendingScenePersistence | null {
  if (
    !pending
    || pending.preserveDeleted === true
    || !affectedPageIds?.includes(pending.sceneId)
  ) return pending;
  return { ...pending, preserveDeleted: true };
}

type SceneHydrationBaseline = {
  generation: number;
  pending: PendingScenePersistence;
};
type FileOpenOperation = {
  generation: number;
  signal: AbortSignal;
};
type PendingPdfInsertFile = PdfInsertFileRowMetadata & {
  file: File;
  sha256: string;
};
type PendingPdfInsert = {
  files: PendingPdfInsertFile[];
  projectId: string;
  selectedPageId: string;
  hydrationGeneration: number;
};
type PendingPdfAnnotationClear = {
  projectId: string;
  sceneId: string;
  summaries: PdfAnnotationScopeSummaries;
  sourceName?: string;
};
type PendingPdfUndo =
  | {
      kind: "clear-annotations";
      token: number;
      transaction: PdfAnnotationClearTransaction;
    }
  | {
      kind: "delete-page";
      token: number;
      transaction: PdfPageDeleteTransaction;
    };
type PdfUndoToast =
  | {
      kind: "clear-annotations";
      token: number;
      annotationCount: number;
      affectedPageCount: number;
      expiresAt: number;
    }
  | {
      kind: "delete-page";
      token: number;
      deletedPageNumber: number;
      expiresAt: number;
    };

function pendingPdfAnnotationClearTransaction(
  pending: PendingPdfUndo | null,
): PdfAnnotationClearTransaction | undefined {
  return pending?.kind === "clear-annotations" ? pending.transaction : undefined;
}

const PDF_UNDO_RESERVATION_ERROR =
  "This PDF action cannot be completed while Undo is available because it would leave too little room to restore the previous content. Use Undo now or wait a few seconds, then try again.";

export function assertPdfAdditionPreservesPendingUndo(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  pending: PendingPdfUndo | null,
  now = Date.now(),
): void {
  if (!pending || now >= pending.transaction.expiresAt) return;
  if (pending.kind === "clear-annotations") {
    assertPdfAdditionPreservesAnnotationUndo(
      project,
      pdfData,
      pending.transaction,
      { now },
    );
    return;
  }
  try {
    if (!pdfAdditionPreservesPageDeleteUndo(
      project,
      pdfData,
      pending.transaction,
      { now },
    )) throw new Error(PDF_UNDO_RESERVATION_ERROR);
  } catch {
    throw new Error(PDF_UNDO_RESERVATION_ERROR);
  }
}

function pdfAnnotationScopeSummaries(
  project: ClassroomProject,
  sceneId: string,
): PdfAnnotationScopeSummaries {
  return {
    page: getPdfAnnotationScopeSummary(project, sceneId, "page"),
    "source-document": getPdfAnnotationScopeSummary(project, sceneId, "source-document"),
    "all-pdf-pages": getPdfAnnotationScopeSummary(project, sceneId, "all-pdf-pages"),
  };
}

export function pdfAnnotationSummaryMatches(
  displayed: PdfAnnotationScopeSummaries[PdfAnnotationClearScope],
  fresh: PdfAnnotationScopeSummaries[PdfAnnotationClearScope],
): boolean {
  return displayed.annotationCount === fresh.annotationCount
    && displayed.affectedPageCount === fresh.affectedPageCount
    && displayed.sourceIdentity === fresh.sourceIdentity
    && displayed.affectedPageIds.length === fresh.affectedPageIds.length
    && displayed.affectedPageIds.every((sceneId, index) => sceneId === fresh.affectedPageIds[index]);
}

export function pdfAnnotationUndoFitsContentBudget(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  maxBytes = MAX_PROJECT_BYTES,
): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  return getProjectContentSize(project, pdfData).totalBytes <= maxBytes;
}
export type SceneOperationFence = {
  projectId: string;
  sceneId: string;
  hydrationGeneration: number;
};
type SceneOperation = SceneOperationFence & {
  controller: AbortController;
  signal: AbortSignal;
};

/**
 * Async work that started against a canvas scene may only mutate that same
 * scene after its awaited work resolves. Keep this pure so lifecycle tests
 * can exercise the boundary without mounting the full Excalidraw wrapper.
 */
export function sceneOperationIsCurrent(
  operation: SceneOperationFence,
  current: SceneOperationFence & { cancelled?: boolean },
): boolean {
  return current.cancelled !== true
    && operation.projectId === current.projectId
    && operation.sceneId === current.sceneId
    && operation.hydrationGeneration === current.hydrationGeneration;
}

export function darkPdfDisplaySceneIsCurrent(
  sceneId: string,
  activeSceneId: string | null,
  hydratedSceneId: string | null,
  switchingScene: boolean,
): boolean {
  return !switchingScene
    && sceneId === activeSceneId
    && sceneId === hydratedSceneId;
}

/**
 * Browsers without matchMedia (and test/embedded hosts that expose a broken
 * implementation) should keep the normal animation path instead of leaving
 * presentation mode half-entered.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

export function presentationInkStrokeIsCurrent(
  stroke: { sceneId: string; generation: number },
  current: {
    sceneId: string | null;
    generation: number;
    tool: "laser" | "freedraw" | null;
  },
): boolean {
  return current.tool === "freedraw"
    && current.sceneId === stroke.sceneId
    && current.generation === stroke.generation;
}

export function presentationInkPointerDownIsCurrent(
  sceneId: string | null,
  hydratedSceneId: string | null,
  switching: boolean,
): boolean {
  return !switching
    && Boolean(sceneId)
    && hydratedSceneId === sceneId;
}

export function startupLoadGenerationIsCurrent(
  startupGeneration: number,
  currentGeneration: number,
  cancelled: boolean,
): boolean {
  return !cancelled && startupGeneration === currentGeneration;
}

/**
 * Read a classroom project only after its cheap Blob-size boundary has passed.
 * Keep this guard adjacent to arrayBuffer(): future call-site refactors must
 * not move the potentially very large allocation ahead of the import limit.
 */
export async function readBoundedProjectFileBytes(file: Blob): Promise<Uint8Array> {
  assertImportBlobBytes(file, MAX_PROJECT_BYTES, "Project file");
  return new Uint8Array(await file.arrayBuffer());
}
type ProjectFindShortcutBridge = {
  enabled: boolean;
  open: (() => void) | null;
};
const PROJECT_FIND_SHORTCUT_BRIDGE_KEY = "__patterdrawProjectFindShortcutBridgeV1";

function hasVisibleModalSurface(): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll<HTMLElement>(
    [
      '.modal-backdrop [role="dialog"]',
      '.settings-popover[role="dialog"]',
      '.slide-settings-popover[role="dialog"]',
      '.math-interaction-panel[role="dialog"]',
      '.topbar-menu-popover[role="menu"]',
      '.slide-thumbnail-menu[role="menu"]',
      '.editor-host .excalidraw .dropdown-menu',
      '.editor-host .excalidraw .context-menu',
      '.screenshot-capture-overlay',
      '.slide-frame-draw-overlay',
      '.lasso-overlay',
      '.busy-overlay',
      '.Modal',
    ].join(", "),
  )).some((dialog) => (
    !dialog.hidden
    && dialog.getClientRects().length > 0
  ));
}

function installProjectFindShortcutBridge(): ProjectFindShortcutBridge | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as Window & {
    [PROJECT_FIND_SHORTCUT_BRIDGE_KEY]?: ProjectFindShortcutBridge;
  };
  const existing = browserWindow[PROJECT_FIND_SHORTCUT_BRIDGE_KEY];
  if (existing) return existing;
  const bridge: ProjectFindShortcutBridge = { enabled: false, open: null };
  browserWindow[PROJECT_FIND_SHORTCUT_BRIDGE_KEY] = bridge;
  // Register before Excalidraw mounts. Its native scene-search shortcut stops
  // later listeners on the same window, while PatterDraw owns Ctrl/Cmd+F once
  // mounted: it opens project-wide Find when enabled and suppresses the native
  // search when the user has turned the feature off.
  window.addEventListener("keydown", (event) => {
    if (
      !bridge.open
      || event.altKey
      || event.shiftKey
      || (!event.ctrlKey && !event.metaKey)
      || event.key.toLowerCase() !== "f"
    ) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    // PatterDraw owns this shortcut across the editor. While a modal is open,
    // consume it without opening either project search or Excalidraw's
    // canvas search behind the modal.
    if (hasVisibleModalSurface()) return;
    if (bridge.enabled) bridge.open();
  }, true);
  return bridge;
}

const projectFindShortcutBridge = installProjectFindShortcutBridge();

/**
 * Excalidraw's public-library URL importer is an optional consumer hook, not
 * part of the component's normal local-library path. Strip its URL token at
 * the wrapper boundary so a future/default hook cannot turn a classroom URL
 * into a network fetch. Local personal-library state still arrives through
 * initialData and local .excalidrawlib imports.
 */
function stripPublicLibraryImportToken(): void {
  if (typeof window === "undefined") return;
  const current = new URL(window.location.href);
  let changed = false;
  const hash = new URLSearchParams(current.hash.slice(1));
  if (hash.has("addLibrary")) {
    hash.delete("addLibrary");
    hash.delete("token");
    changed = true;
  }
  const search = new URLSearchParams(current.search);
  if (search.has("addLibrary")) {
    search.delete("addLibrary");
    search.delete("token");
    changed = true;
  }
  if (!changed) return;
  current.search = search.toString();
  current.hash = hash.toString();
  window.history.replaceState(window.history.state, document.title, `${current.pathname}${current.search}${current.hash}`);
}

if (typeof window !== "undefined") {
  stripPublicLibraryImportToken();
  window.addEventListener("hashchange", stripPublicLibraryImportToken, true);
}

const CLASSROOM_UI_OPTIONS: ExcalidrawProps["UIOptions"] = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: true,
    toggleTheme: false,
  },
  tools: { image: true },
};
const SPINNER_ANIMATION_DURATION_MS = 1_100;
const SCENE_PERSISTENCE_DELAY_MS = 150;
const MAX_DARK_PDF_THUMBNAILS = 48;
// Pinned Excalidraw's native image insertion boundary. Its JSON clipboard
// route bypasses generateIdForFile and resizeImageFile, so enforce the same
// limit before allowing those files into the live scene.
const MAX_EXCALIDRAW_CLIPBOARD_IMAGE_EDGE = 1_440;
const MAX_EXCALIDRAW_CLIPBOARD_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_EXCALIDRAW_CLIPBOARD_IMAGE_FILES = 32;
const PERSONAL_LIBRARY_SIDEBAR_TAB = "library";
const PROJECT_FIND_SIDEBAR_TAB = "project-find";
type LibrarySidebarTab = typeof PERSONAL_LIBRARY_SIDEBAR_TAB | typeof SCREENSHOT_SIDEBAR_TAB;
type ScreenshotItemsUpdate =
  | readonly StoredScreenshot[]
  | ((current: readonly StoredScreenshot[]) => readonly StoredScreenshot[]);

// A non-null node prevents Excalidraw's embeddable renderer from falling back
// to its native frame. Native iframe elements are separately kept out of the
// live scene by the default-off embedded-content policy.
const renderDisabledEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]> = () => (
  <span aria-hidden="true" />
);

type LocalDropImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";

const LOCAL_DROP_IMAGE_EXTENSIONS: Record<string, LocalDropImageMime> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function localDropImageMimeFromType(value: string): LocalDropImageMime | null {
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (
    normalized === "image/png"
    || normalized === "image/jpeg"
    || normalized === "image/gif"
    || normalized === "image/webp"
    || normalized === "image/svg+xml"
  ) return normalized;
  return null;
}

function localDropImageMimeFromName(name: string): LocalDropImageMime | null {
  const lowerName = name.trim().toLowerCase();
  const extension = lowerName.slice(lowerName.lastIndexOf("."));
  return LOCAL_DROP_IMAGE_EXTENSIONS[extension] || null;
}

function localDropImageMimeFromBytes(bytes: Uint8Array): LocalDropImageMime | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6
    && (
      String.fromCharCode(...bytes.subarray(0, 6)) === "GIF87a"
      || String.fromCharCode(...bytes.subarray(0, 6)) === "GIF89a"
    )
  ) return "image/gif";
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";

  // Read only the bounded sniff prefix. inspectLocalImageBlob() remains the
  // authoritative full SVG validator once this candidate is canonicalized.
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  return /^\s*(?:<!--[\s\S]*?-->\s*|<\?xml[\s\S]*?\?>\s*|<!doctype\s+svg[^>]*>\s*)*<svg(?:\s|>)/i.test(text)
    ? "image/svg+xml"
    : null;
}

async function guessLocalDropImageMime(file: File): Promise<LocalDropImageMime | null> {
  const sniffLength = Math.min(file.size, 1 * 1024 * 1024);
  const bytes = new Uint8Array(await file.slice(0, sniffLength).arrayBuffer());
  return localDropImageMimeFromBytes(bytes)
    || localDropImageMimeFromName(file.name)
    || localDropImageMimeFromType(file.type);
}

function canonicalLocalDropImageFile(file: File, mimeType: LocalDropImageMime): File {
  if (file.type.trim().toLowerCase() === mimeType) return file;
  return new File([file], file.name || `patterdraw-drop.${mimeType.slice("image/".length)}`, {
    type: mimeType,
    lastModified: file.lastModified,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 100);
    window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
  });
}

function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = () => finish(false);
    const timer = window.setTimeout(() => finish(true), milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForSceneHydrationToSettle(isSwitching: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 4 && isSwitching(); attempt += 1) {
    await afterNextPaint();
  }
  if (isSwitching()) {
    throw new Error("The canvas is still loading. Wait a moment and try exporting again.");
  }
}

function screenshotDownloadName(createdAt: number): string {
  const timestamp = new Date(createdAt).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z").replaceAll(":", "-");
  return `patterdraw-screenshot-${timestamp}.png`;
}

function clipboardCaptureToast(result: ClipboardWriteResult): string {
  if (result === "success") return "Screenshot copied to the clipboard and saved to the Screenshot Library.";
  if (result === "denied") return "Screenshot saved. Clipboard permission was denied; use Copy in the Screenshot Library to retry.";
  if (result === "unsupported") return "Screenshot saved. Image clipboard access is unavailable in this browser.";
  return "Screenshot saved, but it could not be copied. Use Copy in the Screenshot Library to retry.";
}

function autosaveFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const storageFull = error instanceof DOMException && error.name === "QuotaExceededError";
  return storageFull
    ? "Autosave failed because browser storage is full. Download a .patterdraw backup now, then remove Personal Library items or Screenshot Library captures."
    : `Autosave failed: ${detail} Download a .patterdraw backup before closing this page.`;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function pdfOperationProgressMessage(progress: Readonly<PdfOperationProgress>): string {
  const name = progress.documentName ? ` ${progress.documentName}` : "";
  if (progress.pagePosition > 0 && progress.pageTotal > 0) {
    const action = progress.phase === "measuring" ? "Preparing" : "Rendering";
    return `${action}${name} — page ${progress.pagePosition} of ${progress.pageTotal}…`;
  }
  const action: Record<PdfOperationProgress["phase"], string> = {
    reading: "Reading",
    validating: "Checking",
    preflighting: "Checking compatibility for",
    loading: "Opening",
    measuring: "Preparing",
    rendering: "Rendering",
    embedding: "Combining",
    saving: "Finishing",
  };
  return `${action[progress.phase]}${name || " PDF"}…`;
}

function autosaveSnapshotsMatch(
  snapshot: LoadedClassroomProject | null,
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
): boolean {
  return snapshot?.project === project && snapshot.pdfBytes === pdfBytes;
}

function latexSourceForElement(element: ExcalidrawElement | undefined): string | null {
  if (!element || element.type !== "image" || !element.customData) return null;
  const latex = (element.customData as Record<string, unknown>).classroomLatex;
  if (!latex || typeof latex !== "object") return null;
  const source = (latex as Record<string, unknown>).source;
  return typeof source === "string" ? source : null;
}

function mermaidDataForElement(element: ExcalidrawElement | undefined): {
  diagramId: string;
  source: string;
} | null {
  if (!element?.customData) return null;
  const mermaid = (element.customData as Record<string, unknown>).classroomMermaid;
  if (!mermaid || typeof mermaid !== "object") return null;
  const data = mermaid as Record<string, unknown>;
  return typeof data.diagramId === "string" && typeof data.source === "string"
    ? { diagramId: data.diagramId, source: data.source }
    : null;
}

export function preserveDeletedSceneRecords(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  serializedElements: readonly Record<string, unknown>[],
  serializedFiles: Record<string, Record<string, unknown>>,
): {
  elements: readonly Record<string, unknown>[];
  files: Record<string, Record<string, unknown>>;
} {
  const serializedById = new Map(serializedElements.map((element) => [element.id, element]));
  const orderedElements: Record<string, unknown>[] = [];
  for (const element of elements) {
    if (element.isDeleted === true) {
      orderedElements.push(element as unknown as Record<string, unknown>);
      continue;
    }
    const serialized = serializedById.get(element.id);
    if (!serialized) continue;
    orderedElements.push(serialized);
    serializedById.delete(element.id);
  }
  orderedElements.push(...serializedById.values());
  const preservedFiles = { ...serializedFiles };
  for (const element of elements) {
    if (element.isDeleted !== true || element.type !== "image" || !element.fileId) continue;
    const file = files[element.fileId];
    if (file) preservedFiles[element.fileId] = file as unknown as Record<string, unknown>;
  }
  return { elements: orderedElements, files: preservedFiles };
}

function serializedSceneFromChange(
  previous: SerializedScene,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
  preserveDeleted = false,
): SerializedScene {
  const exported = JSON.parse(serializeAsJSON(elements, appState, files, "local")) as {
    elements: readonly Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  };
  // Theme and grid visibility are device preferences. Excalidraw serializes
  // them by default, so remove only those toggles while retaining scene data
  // such as the configured grid size and background colour.
  delete exported.appState.theme;
  delete exported.appState.gridModeEnabled;
  canonicalizePersistedWrapperTool(exported.appState);
  if (preserveDeleted) {
    // Excalidraw's local serializer intentionally removes tombstones and
    // files referenced only by them. Annotation clear/undo needs those exact
    // records for collision checks and must not orphan tombstone-owned files.
    const preserved = preserveDeletedSceneRecords(
      elements,
      files,
      exported.elements,
      exported.files || {},
    );
    exported.elements = preserved.elements;
    exported.files = preserved.files;
  }
  return sanitizeScene({
    ...previous,
    elements: exported.elements,
    appState: exported.appState,
    files: exported.files || {},
  });
}

function serializedPersistableAppState(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): Record<string, unknown> {
  const exported = JSON.parse(serializeAsJSON(elements, appState, files, "local")) as {
    appState: Record<string, unknown>;
  };
  // Theme and grid visibility are device preferences. Excalidraw keeps both
  // in its local export, but PatterDraw deliberately owns them outside the
  // classroom project.
  delete exported.appState.theme;
  delete exported.appState.gridModeEnabled;
  canonicalizePersistedWrapperTool(exported.appState);
  // sanitizeScene canonicalizes these UI-only browser fields to null before
  // persistence. Match that canonical form so opening a menu/sidebar during
  // the hydration window does not look like a classroom edit.
  exported.appState.openMenu = null;
  exported.appState.openSidebar = null;
  return exported.appState;
}

function persistentFilesForScene(
  scene: SerializedScene,
  liveFiles: BinaryFiles,
  transientFileIds: ReadonlySet<string>,
): BinaryFiles {
  if (!scene.pdfPage && transientFileIds.size === 0) return liveFiles;
  const files = { ...liveFiles } as BinaryFiles;
  for (const transientFileId of transientFileIds) {
    delete files[transientFileId as FileId];
  }
  const background = scene.pdfPage
    ? scene.elements.find((element) => element.id === scene.pdfPage?.backgroundElementId)
    : undefined;
  const lightFileId = typeof background?.fileId === "string"
    ? background.fileId as FileId
    : null;
  const lightFile = lightFileId
    ? scene.files[lightFileId] as unknown as BinaryFileData | undefined
    : undefined;
  if (lightFileId && lightFile) files[lightFileId] = lightFile;
  return files;
}

/**
 * Exports can yield to PDF/image workers while Excalidraw continues mutating
 * its live file map. Snapshot both the map and its records before handing it
 * to an async renderer so a later navigation cannot change the export input.
 */
function cloneBinaryFiles(files: BinaryFiles): BinaryFiles {
  return Object.fromEntries(
    Object.entries(files).map(([fileId, file]) => [
      fileId,
      file && typeof file === "object" ? { ...file } : file,
    ]),
  ) as BinaryFiles;
}

function clonePdfBytes(pdfBytes: Record<PdfDocumentId, Uint8Array>): Record<PdfDocumentId, Uint8Array> {
  // Source PDF byte arrays are immutable after import. Snapshot the map so a
  // later file-open cannot change which document an export sees, without
  // duplicating as much as 75 MiB of source data at export time.
  return Object.fromEntries(
    Object.entries(pdfBytes),
  );
}

function normalizedHydrationChange(
  scene: SerializedScene,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
  transientFileIds: ReadonlySet<string>,
): PendingScenePersistence {
  const backgroundSafeElements = canonicalizePdfBackground(
    scene,
    elements as unknown as readonly Record<string, unknown>[],
  ) as unknown as readonly ExcalidrawElement[];
  return {
    sceneId: scene.id,
    elements: detachElementsFromSlideFrames(backgroundSafeElements),
    appState,
    files: persistentFilesForScene(scene, files, transientFileIds),
  };
}

export function hydrationChangesMatch(
  left: PendingScenePersistence,
  right: PendingScenePersistence,
): boolean {
  return left.sceneId === right.sceneId
    && serializedValuesEqual(left.elements, right.elements)
    && serializedValuesEqual(left.files, right.files)
    // Compare Excalidraw's persistable appState rather than the live object.
    // This retains real zoom/pan edits made during hydration while ignoring
    // transient selection, pointer, dialog, and layout state.
    && serializedValuesEqual(
      serializedPersistableAppState(left.elements, left.appState, left.files),
      serializedPersistableAppState(right.elements, right.appState, right.files),
    );
}

function pdfPagePreviewCacheKey(
  project: ClassroomProject | null | undefined,
  scene: SerializedScene,
  preview: {
    deviceTier: PdfRasterDeviceTier;
    height: number;
    quality: PdfPagePreviewQuality;
    theme: PdfPagePreviewTheme;
    width: number;
  },
): string | null {
  const workspace = scene.pdfPage;
  const sourceSha256 = workspace
    ? project?.pdfDocuments[workspace.documentId]?.sha256
    : undefined;
  if (!workspace?.backgroundElementId || !sourceSha256) return null;
  // PDF source bytes and background identity are immutable project metadata.
  // Keeping element-array traversal out of this key prevents every ordinary
  // annotation edit from rescanning all page contents.
  return createActivePdfPagePreviewKey({
    sourceSha256,
    pageIndex: workspace.pageIndex,
    effectiveRotation: getPdfPageEffectiveRotation(workspace),
    theme: preview.theme,
    quality: preview.quality,
    deviceTier: preview.deviceTier,
    width: preview.width,
    height: preview.height,
    occurrenceId: scene.id,
  });
}

function darkPdfThumbnailCacheKey(
  project: ClassroomProject | null | undefined,
  scene: SerializedScene,
): string | null {
  const workspace = scene.pdfPage;
  if (!workspace) return null;
  const display = getPdfPageDisplayGeometry(workspace);
  const dimensions = fitPdfRasterDimensions({
    width: Math.max(1, Math.ceil(display.width)),
    height: Math.max(1, Math.ceil(display.height)),
  }, undefined, 256);
  return pdfPagePreviewCacheKey(project, scene, {
    ...dimensions,
    deviceTier: getBrowserPdfRasterDeviceTier(),
    quality: "thumbnail",
    theme: "dark",
  });
}

function serializedValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => serializedValuesEqual(value, right[index]));
  }
  if (
    !left
    || !right
    || typeof left !== "object"
    || typeof right !== "object"
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && serializedValuesEqual(leftRecord[key], rightRecord[key])
  ));
}

function projectWithPendingScene(
  current: ClassroomProject | null,
  pending: PendingScenePersistence,
): ClassroomProject | null {
  const previousScene = current?.scenes[pending.sceneId];
  if (!current || !previousScene) return null;
  const backgroundSafeElements = canonicalizePdfBackground(
    previousScene,
    pending.elements as unknown as readonly Record<string, unknown>[],
  ) as unknown as readonly ExcalidrawElement[];
  const detachedElements = detachElementsFromSlideFrames(backgroundSafeElements);
  const slideOrder = reconcileSlides(pending.sceneId, detachedElements, current.slideOrder);
  const namedElements = syncSlideFrameNames(detachedElements, slideOrder);
  const scene = serializedSceneFromChange(
    previousScene,
    namedElements,
    pending.appState,
    pending.files,
    pending.preserveDeleted === true,
  );
  if (
    serializedValuesEqual(scene, previousScene)
    && serializedValuesEqual(slideOrder, current.slideOrder)
  ) return current;
  return {
    ...current,
    updatedAt: nowIso(),
    scenes: { ...current.scenes, [pending.sceneId]: scene },
    slideOrder,
  };
}

function nativeExcalidrawProject(text: string): ClassroomProject {
  const data = parseBoundedImportJson<Record<string, unknown>>(text, "scene");
  const project = createBlankProject();
  const sceneId = project.activeSceneId;
  project.scenes[sceneId] = sanitizeScene({
    id: sceneId,
    name: "Imported drawing",
    elements: data.elements as readonly Record<string, unknown>[],
    appState: data.appState && typeof data.appState === "object"
      ? data.appState as Record<string, unknown>
      : {},
    files: data.files && typeof data.files === "object"
      ? data.files as Record<string, Record<string, unknown>>
      : {},
  });
  project.title = typeof data.name === "string" ? data.name : "Imported drawing";
  project.titleMode = "custom";
  project.slideOrder = reconcileSlides(
    sceneId,
    project.scenes[sceneId].elements as unknown as ExcalidrawElement[],
    [],
  );
  return sanitizeProject(project);
}

export default function App() {
  const [project, setProject] = useState<ClassroomProject | null>(null);
  const [projectHydrationRevision, setProjectHydrationRevision] = useState(0);
  const [pdfBytes, setPdfBytes] = useState<Record<PdfDocumentId, Uint8Array>>({});
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saving");
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [busyCanCancel, setBusyCanCancel] = useState(false);
  const busyCancelRef = useRef<(() => void) | null>(null);
  const [pendingPdfInsert, setPendingPdfInsert] = useState<PendingPdfInsert | null>(null);
  const [pdfInsertProcessing, setPdfInsertProcessing] = useState(false);
  const [pdfInsertCancelling, setPdfInsertCancelling] = useState(false);
  const [pdfInsertProgress, setPdfInsertProgress] = useState<PdfInsertOperationProgress | null>(null);
  const pdfInsertOperationGenerationRef = useRef<number | null>(null);
  const [pendingPdfAnnotationClear, setPendingPdfAnnotationClear] = useState<PendingPdfAnnotationClear | null>(null);
  const [pdfUndoToast, setPdfUndoToast] = useState<PdfUndoToast | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autosaveRecoveryDetail, setAutosaveRecoveryDetail] = useState<string | null>(null);
  const [autosaveRecoveryKind, setAutosaveRecoveryKind] = useState<AutosaveRecoveryKind | null>(null);
  const [initialExcalidrawData] = useState<Promise<{ libraryItems: LibraryItems } | null>>(() => (
    loadLibraryItems()
      .then((libraryItems) => ({ libraryItems }))
      .catch((error) => {
        setErrorMessage(`Personal library could not be opened: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
  ));
  const [exportOpen, setExportOpen] = useState(false);
  const [pendingVisualPdfFallback, setPendingVisualPdfFallback] = useState<PendingVisualPdfFallback | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isProjectFindOpen, setIsProjectFindOpen] = useState(false);
  const [isSizePositionOpen, setIsSizePositionOpen] = useState(false);
  const [screenshots, setScreenshots] = useState<StoredScreenshot[]>([]);
  const [isScreenshotLibraryLoading, setIsScreenshotLibraryLoading] = useState(true);
  const [isScreenshotCaptureActive, setIsScreenshotCaptureActive] = useState(false);
  const [isScreenshotBusy, setIsScreenshotBusy] = useState(false);
  const [presentation, setPresentation] = useState<PresentationState | null>(null);
  const presentationRef = useRef<PresentationState | null>(presentation);
  presentationRef.current = presentation;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("board");
  const [isSlideRailVisible, setIsSlideRailVisible] = useState(true);
  const [pdfRailWidth, setPdfRailWidth] = useState(PDF_RAIL_DEFAULT_WIDTH);
  const [isPdfRailVisible, setIsPdfRailVisible] = useState(true);
  const [isPdfToolbarVisible, setIsPdfToolbarVisible] = useState(true);
  const [areSlideFramesVisible, setAreSlideFramesVisible] = useState(true);
  const [isSlideFrameDrawingActive, setIsSlideFrameDrawingActive] = useState(false);
  const [isNavigationVisible, setIsNavigationVisible] = useState(true);
  const [featurePreferences, setFeaturePreferences] = useState(readFeaturePreferences);
  const [pdfPreferences, setPdfPreferences] = useState(readPdfPreferences);
  const [themePreference, setThemePreferenceState] = useState(readThemePreference);
  const [prefersDarkTheme, setPrefersDarkTheme] = useState(systemPrefersDark);
  const [darkPdfPreviewUrls, setDarkPdfPreviewUrls] = useState<Record<string, string>>({});
  const [darkPdfDisplayRevision, setDarkPdfDisplayRevision] = useState(0);
  const editorTheme = useMemo(
    () => resolvedTheme(themePreference, prefersDarkTheme),
    [prefersDarkTheme, themePreference],
  );
  const featurePreferencesRef = useRef(featurePreferences);
  featurePreferencesRef.current = featurePreferences;
  const pdfPreferencesRef = useRef(pdfPreferences);
  pdfPreferencesRef.current = pdfPreferences;
  const applyingEditorPreferencesRef = useRef<Pick<
    FeaturePreferences,
    "penOnly" | "showGrid" | "snapToObjects"
  > | null>(null);
  const editorThemeRef = useRef(editorTheme);
  editorThemeRef.current = editorTheme;
  const isFooterVisible = featurePreferences.footer;
  const [equationEditor, setEquationEditor] = useState<EquationEditorState | null>(null);
  const [mermaidEditor, setMermaidEditor] = useState<MermaidEditorState | null>(null);
  const [isMathToolsOpen, setIsMathToolsOpen] = useState(false);
  const [isGeoGonOpen, setIsGeoGonOpen] = useState(false);
  const [mathToolEdit, setMathToolEdit] = useState<MathToolEditState | null>(null);
  const [mathInteraction, setMathInteraction] = useState<MathInteractionState | null>(null);
  const [isLassoActive, setIsLassoActive] = useState(false);
  const [isBucketFillActive, setIsBucketFillActive] = useState(false);
  const [lassoGeometryFactory, setLassoGeometryFactory] = useState<
    ((elements: readonly ExcalidrawElement[]) => LassoGeometrySnapshot) | null
  >(null);
  const [lassoInitialSelection, setLassoInitialSelection] = useState<LassoInitialSelection | null>(null);
  const [probabilitySelection, setProbabilitySelection] = useState<ProbabilitySelectionSummary | null>(null);
  const [isProbabilitySpinning, setIsProbabilitySpinning] = useState(false);
  const [spinnerPointerAnimations, setSpinnerPointerAnimations] = useState<SpinnerPointerAnimation[]>([]);
  const pendingSlideFrameActionRef = useRef<PendingSlideFrameAction | null>(null);
  const setFeaturePreference = useCallback((key: FeaturePreferenceKey, enabled: boolean) => {
    if (key === "slides" && !enabled) pendingSlideFrameActionRef.current = null;
    if (featurePreferencesRef.current[key] === enabled) return;
    const next = persistFeaturePreference(featurePreferencesRef.current, key, enabled);
    featurePreferencesRef.current = next;
    setFeaturePreferences(next);
  }, []);
  const setThemePreference = useCallback((preference: ThemePreference) => {
    setThemePreferenceState(persistThemePreference(preference));
  }, []);
  const setPdfPreference = useCallback((key: PdfPreferenceKey, enabled: boolean) => {
    const result = persistPdfPreference(pdfPreferencesRef.current, key, enabled);
    pdfPreferencesRef.current = result.preferences;
    setPdfPreferences(result.preferences);
    if (result.status === "rolled-back") {
      setErrorMessage("PDF settings could not be saved on this device. The previous setting was kept.");
    }
  }, []);
  const restorePdfPreferences = useCallback(() => {
    const result = restoreDefaultPdfPreferences(pdfPreferencesRef.current);
    pdfPreferencesRef.current = result.preferences;
    setPdfPreferences(result.preferences);
    if (result.status === "rolled-back") {
      setErrorMessage("PDF settings could not be restored on this device. The previous settings were kept.");
    }
  }, []);
  const toggleFooterPreference = useCallback(() => {
    const next = persistFeaturePreference(
      featurePreferencesRef.current,
      "footer",
      !featurePreferencesRef.current.footer,
    );
    featurePreferencesRef.current = next;
    setFeaturePreferences(next);
  }, []);
  const restoreFeaturePreferences = useCallback(() => {
    const defaults = { ...DEFAULT_FEATURE_PREFERENCES };
    // Claim the editor-state transition synchronously. A rapid second setting
    // change can otherwise make Excalidraw emit its previous pen/grid/snapping
    // snapshot before the React effect below applies the restored defaults.
    applyingEditorPreferencesRef.current = {
      penOnly: defaults.penOnly,
      showGrid: defaults.showGrid,
      snapToObjects: defaults.snapToObjects,
    };
    persistFeaturePreferences(defaults);
    persistThemePreference(DEFAULT_THEME_PREFERENCE);
    featurePreferencesRef.current = defaults;
    setFeaturePreferences(defaults);
    setThemePreferenceState(DEFAULT_THEME_PREFERENCE);
  }, []);
  useEffect(() => subscribeToFeaturePreferences((nextPreferences) => {
    if (!nextPreferences.slides) pendingSlideFrameActionRef.current = null;
    applyingEditorPreferencesRef.current = {
      penOnly: nextPreferences.penOnly,
      showGrid: nextPreferences.showGrid,
      snapToObjects: nextPreferences.snapToObjects,
    };
    featurePreferencesRef.current = nextPreferences;
    setFeaturePreferences(nextPreferences);
  }), []);
  useEffect(() => subscribeToPdfPreferences((nextPreferences) => {
    pdfPreferencesRef.current = nextPreferences;
    setPdfPreferences(nextPreferences);
  }), []);
  useEffect(() => subscribeToThemePreference(setThemePreferenceState), []);
  useEffect(() => subscribeToSystemTheme(setPrefersDarkTheme), []);
  useEffect(() => {
    if (!api) return;
    const appState = api.getAppState();
    const preferences = featurePreferencesRef.current;
    if (
      appState.penMode === preferences.penOnly
      && appState.gridModeEnabled === preferences.showGrid
      && appState.objectsSnapModeEnabled === preferences.snapToObjects
    ) {
      applyingEditorPreferencesRef.current = null;
      return;
    }
    applyingEditorPreferencesRef.current = {
      penOnly: preferences.penOnly,
      showGrid: preferences.showGrid,
      snapToObjects: preferences.snapToObjects,
    };
    api.updateScene({
      appState: {
        penMode: preferences.penOnly,
        penDetected: true,
        gridModeEnabled: preferences.showGrid,
        objectsSnapModeEnabled: preferences.snapToObjects,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [
    api,
    featurePreferences.penOnly,
    featurePreferences.showGrid,
    featurePreferences.snapToObjects,
  ]);
  const inputRef = useRef<HTMLInputElement>(null);
  const pdfInsertInputRef = useRef<HTMLInputElement>(null);
  const pdfInsertTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pdfPageActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingPdfUndoRef = useRef<PendingPdfUndo | null>(null);
  const pdfUndoTimerRef = useRef<number | null>(null);
  const pdfUndoTokenRef = useRef(0);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const insertTriggerRef = useRef<HTMLButtonElement>(null);
  const exportOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const projectFindTriggerRef = useRef<HTMLButtonElement>(null);
  const slideRailShowButtonRef = useRef<HTMLButtonElement>(null);
  const pdfRailShowButtonRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const safeClipboardReadGuardRef = useRef(false);
  const finalizePendingPdfUndo = useCallback(() => {
    const pending = pendingPdfUndoRef.current;
    pendingPdfUndoRef.current = null;
    if (pdfUndoTimerRef.current !== null) {
      window.clearTimeout(pdfUndoTimerRef.current);
      pdfUndoTimerRef.current = null;
    }
    if (pending) {
      setPdfUndoToast((current) => current?.token === pending.token ? null : current);
    }
  }, []);
  useEffect(() => {
    const expirePendingUndo = () => {
      const pending = pendingPdfUndoRef.current;
      if (pending && Date.now() >= pending.transaction.expiresAt) {
        finalizePendingPdfUndo();
      }
    };
    document.addEventListener("visibilitychange", expirePendingUndo);
    window.addEventListener("focus", expirePendingUndo);
    return () => {
      document.removeEventListener("visibilitychange", expirePendingUndo);
      window.removeEventListener("focus", expirePendingUndo);
      const timer = pdfUndoTimerRef.current;
      if (timer !== null) window.clearTimeout(timer);
      pdfUndoTimerRef.current = null;
      pendingPdfUndoRef.current = null;
    };
  }, [finalizePendingPdfUndo]);
  const projectRef = useRef<ClassroomProject | null>(project);
  const pdfBytesRef = useRef<Record<PdfDocumentId, Uint8Array>>(pdfBytes);
  const currentSceneRef = useRef<SerializedScene | null>(null);
  const activeSceneIdRef = useRef<string | null>(null);
  // The React project/active-scene refs can advance before Excalidraw has
  // synchronously hydrated the replacement scene. Keep the scene represented
  // by the live imperative API separate so a rapid follow-up transition never
  // captures the outgoing PDF into the incoming Board (or vice versa).
  const hydratedSceneIdRef = useRef<string | null>(null);
  // A per-mount ID prevents imported user files from colliding with the one
  // transient active-page raster that is removed from saves and exports.
  const darkPdfActiveFileIdRef = useRef(
    `patterdraw-dark-pdf-${createLocalId()}` as FileId,
  );
  const darkPdfPreviewCacheRef = useRef(new Map<string, BinaryFileData>());
  const darkPdfThumbnailCacheRef = useRef(
    new Map<string, DarkPdfThumbnailCacheEntry<DataURL>>(),
  );
  const darkPdfDisplayFileIdsRef = useRef(new Map<string, FileId>());
  const darkPdfPreviewErrorsRef = useRef(new Set<string>());
  const transientDarkPdfFileIdsRef = useRef(new Set<string>([darkPdfActiveFileIdRef.current]));
  const darkPdfPreviewGenerationRef = useRef(0);
  const suspendDarkPdfDisplayRef = useRef(false);
  const darkPdfRenderControllersRef = useRef(new Set<AbortController>());
  const retireActiveDarkPdfDisplayFile = useCallback(() => {
    if (!api) return false;
    return retireDarkPdfDisplayFile(api, darkPdfActiveFileIdRef.current);
  }, [api]);
  const getActivePdfDisplayFile = useCallback(async (
    scene: SerializedScene,
    preview: {
      darkTreatment: boolean;
      sharpen: boolean;
      theme: PdfPagePreviewTheme;
    },
    signal?: AbortSignal,
  ): Promise<BinaryFileData | null> => {
    const workspace = scene.pdfPage;
    const background = workspace
      ? scene.elements.find((element) => element.id === workspace.backgroundElementId)
      : undefined;
    const lightFileId = typeof background?.fileId === "string" ? background.fileId : null;
    const lightFile = lightFileId
      ? scene.files[lightFileId] as Record<string, unknown> | undefined
      : undefined;
    const lightDataUrl = typeof lightFile?.dataURL === "string" ? lightFile.dataURL : null;
    const sourceBytes = workspace ? pdfBytesRef.current[workspace.documentId] : undefined;
    const immutableSha256 = workspace
      ? projectRef.current?.pdfDocuments[workspace.documentId]?.sha256
      : undefined;
    if (!workspace || !lightFileId || !lightDataUrl || !sourceBytes || !immutableSha256) {
      return Promise.reject(new Error("The original PDF page is unavailable."));
    }
    const canonicalDimensions = await getPdfRasterDimensions(lightDataUrl);
    const viewRotation = getPdfPageViewRotation(workspace);
    const display = getPdfPageDisplayGeometry(workspace);
    const effectiveRotation = getPdfPageEffectiveRotation(workspace);
    const canonicalDisplayDimensions = viewRotation === 90 || viewRotation === 270
      ? { width: canonicalDimensions.height, height: canonicalDimensions.width }
      : canonicalDimensions;
    const sharpTarget = getActivePdfPagePreviewTarget({
      displayWidth: display.width,
      displayHeight: display.height,
      effectiveRotation,
    });
    const dimensions = preview.sharpen
      ? { width: sharpTarget.width, height: sharpTarget.height }
      : fitPdfRasterDimensions(canonicalDisplayDimensions);
    if (
      !preview.darkTreatment
      && (!preview.sharpen
        || !shouldRenderLightPdfPageRefinement(canonicalDisplayDimensions, dimensions))
    ) return null;

    const cacheKey = pdfPagePreviewCacheKey(projectRef.current, scene, {
      ...dimensions,
      deviceTier: sharpTarget.deviceTier,
      quality: preview.sharpen ? sharpTarget.quality : "canonical",
      theme: preview.theme,
    });
    if (!cacheKey) throw new Error("The original PDF page is unavailable.");
    const cached = darkPdfPreviewCacheRef.current.get(cacheKey);
    if (cached) return cached;

    // Retain at most the active full-resolution raster. Rail previews have a
    // separate bounded cache, while scene navigation replaces this entry.
    darkPdfPreviewCacheRef.current.clear();
    const dataURL = preview.darkTreatment
      ? await renderDarkPdfPreview({
          bytes: sourceBytes,
          immutableSha256,
          pageIndex: workspace.pageIndex,
          viewRotation,
          ...dimensions,
          signal,
        })
      : (await renderLightPdfPagePreview({
          bytes: sourceBytes,
          immutableSha256,
          pageIndex: workspace.pageIndex,
          effectiveRotation,
          sourceRotation: workspace.rotation,
          viewRotation,
          ...dimensions,
          signal,
        })).dataURL;
    const file: BinaryFileData = {
      id: darkPdfActiveFileIdRef.current,
      // Excalidraw applies an additional image-preservation filter to PNGs
      // before its dark canvas filter. A custom dark raster already
      // compensates its picture regions, so opt out via the SVG MIME path.
      // Light refinements keep the normal PNG path and native theme behavior.
      mimeType: preview.darkTreatment ? "image/svg+xml" : "image/png",
      dataURL,
      created: Date.now(),
    };
    if (!signal?.aborted) darkPdfPreviewCacheRef.current.set(cacheKey, file);
    return file;
  }, []);
  const getDarkPdfThumbnailUrl = useCallback(async (
    scene: SerializedScene,
    signal?: AbortSignal,
  ): Promise<DataURL> => {
    const workspace = scene.pdfPage;
    const background = workspace
      ? scene.elements.find((element) => element.id === workspace.backgroundElementId)
      : undefined;
    const lightFileId = typeof background?.fileId === "string" ? background.fileId : null;
    const sourceBytes = workspace ? pdfBytesRef.current[workspace.documentId] : undefined;
    const immutableSha256 = workspace
      ? projectRef.current?.pdfDocuments[workspace.documentId]?.sha256
      : undefined;
    if (!workspace || !lightFileId || !sourceBytes || !immutableSha256) {
      throw new Error("The original PDF page is unavailable.");
    }
    const cacheKey = darkPdfThumbnailCacheKey(projectRef.current, scene);
    if (!cacheKey) throw new Error("The original PDF page is unavailable.");
    const cached = darkPdfThumbnailCacheRef.current.get(cacheKey);
    if (cached) {
      // Refresh insertion order so recently revisited pages survive the cap.
      darkPdfThumbnailCacheRef.current.delete(cacheKey);
      darkPdfThumbnailCacheRef.current.set(cacheKey, cached);
      return cached.dataURL;
    }

    const display = getPdfPageDisplayGeometry(workspace);
    const { width, height } = fitPdfRasterDimensions({
      width: Math.max(1, Math.ceil(display.width)),
      height: Math.max(1, Math.ceil(display.height)),
    }, undefined, 256);
    const dataURL = await renderDarkPdfPreview({
      bytes: sourceBytes,
      immutableSha256,
      pageIndex: workspace.pageIndex,
      viewRotation: getPdfPageViewRotation(workspace),
      width,
      height,
      signal,
    });
    if (!signal?.aborted) {
      storeDarkPdfThumbnail(
        darkPdfThumbnailCacheRef.current,
        cacheKey,
        { dataURL, sceneId: scene.id },
        MAX_DARK_PDF_THUMBNAILS,
      );
    }
    return dataURL;
  }, []);
  // Excalidraw can emit its initial blank scene after the API is ready but
  // before the asynchronously loaded classroom project reaches the editor.
  // Treat that window as a scene switch so the blank scene cannot overwrite
  // the stored project during startup.
  const switchingSceneRef = useRef(true);
  const sceneHydrationGenerationRef = useRef(0);
  const sceneHydrationOuterFrameRef = useRef<number | null>(null);
  const sceneHydrationInnerFrameRef = useRef<number | null>(null);
  // Excalidraw echoes wrapper-owned hydration through onChange. Keep the
  // normalized incoming scene as a baseline so a real edit made between the
  // two hydration paints can be replayed instead of being dropped.
  const sceneHydrationBaselineRef = useRef<SceneHydrationBaseline | null>(null);
  const bufferedHydrationChangeRef = useRef<PendingScenePersistence | null>(null);
  // File/PDF opens are latest-intent operations. Abort the previous parser
  // when possible and always suppress its result when it eventually resolves
  // (older importPdf versions may not consume the signal yet).
  const fileOpenGenerationRef = useRef(0);
  const fileOpenAbortControllerRef = useRef<AbortController | null>(null);
  const pdfExportAbortControllerRef = useRef<AbortController | null>(null);
  const startupAutosaveAbortControllerRef = useRef<AbortController | null>(null);
  const autosaveSuspensionGenerationRef = useRef<number | null>(null);
  const pendingFrameIdRef = useRef<string | null>(null);
  const pendingProjectSearchTargetRef = useRef<PendingProjectSearchTarget | null>(null);
  const pendingPresentationTransitionRef = useRef<PendingPresentationTransition | null>(null);
  const fullscreenIntentRef = useRef<{
    kind: "manual" | "presentation";
    entered: boolean;
  } | null>(null);
  const pendingCreatedFrameIdRef = useRef<string | null>(null);
  const slideFramesVisibleRef = useRef(true);
  const slideFrameDrawingActiveRef = useRef(false);
  const slideFrameAspectRatioRef = useRef<SlideFrameAspectRatio>("freeform");
  const slideFrameGestureRef = useRef<SlideFrameGesture | null>(null);
  const slideDetachmentFrameRef = useRef(0);
  const frameDragPreviewRef = useRef<HTMLDivElement>(null);
  const presentationInkStartElementIdsRef = useRef<{
    elementIds: ReadonlySet<string>;
    sceneId: string;
    generation: number;
  } | null>(null);
  const presentationInkFrameRef = useRef<number | null>(null);
  const presentationInkGenerationRef = useRef(0);
  const activeToolTypeRef = useRef<string | null>(null);
  const roughnessBeforeLineRef = useRef<number | null>(null);
  const focusAfterMathToolsRef = useRef<"editor" | "trigger" | null>(null);
  const nativeImageExportOpenRef = useRef(false);
  const libraryOpenRef = useRef(false);
  const nativeCanvasSearchOpenRef = useRef(false);
  const lastLibraryTabRef = useRef<LibrarySidebarTab>(PERSONAL_LIBRARY_SIDEBAR_TAB);
  const screenshotsRef = useRef<StoredScreenshot[]>([]);
  const screenshotPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const screenshotBusyOwnerRef = useRef(0);
  const sceneOperationMountedRef = useRef(true);
  const sceneOperationControllersRef = useRef(new Set<AbortController>());
  const sceneOperationBusyRef = useRef(new Set<SceneOperation>());
  const restoreExportOptionsFocusRef = useRef(false);
  const probabilityRandomizingRef = useRef(false);
  const probabilityOperationRef = useRef<SceneOperation | null>(null);
  const lassoActiveRef = useRef(false);
  const bucketFillActiveRef = useRef(false);
  const preparedLassoSelectionRef = useRef<LassoInitialSelection | null>(null);
  useLayoutEffect(() => {
    const guard = installSafeClipboardReadGuard();
    safeClipboardReadGuardRef.current = guard.installed;
    return () => {
      safeClipboardReadGuardRef.current = false;
      guard.restore();
    };
  }, []);
  const resetTransientPointerTools = useCallback(() => {
    preparedLassoSelectionRef.current = null;
    lassoActiveRef.current = false;
    bucketFillActiveRef.current = false;
    setIsLassoActive(false);
    setIsBucketFillActive(false);
  }, []);
  const autosaveSnapshotRef = useRef<LoadedClassroomProject | null>(null);
  const autosaveDirtyRef = useRef(false);
  const autosaveSavingRef = useRef(false);
  const autosaveSuspendedRef = useRef(false);
  const autosaveUrgentRef = useRef(false);
  const autosaveContentBytesRef = useRef(0);
  const autosaveLastDurationMsRef = useRef(0);
  // A page that is being torn down may emit a final transient empty scene
  // from Excalidraw. Do not let that teardown notification become a new
  // autosave after the next page has already started loading this project.
  const autosavePageExitRef = useRef(false);
  const autosaveExitFlushQueuedRef = useRef(false);
  // Identify the latest snapshot already queued by an exit flush. React can
  // commit the same project state after pagehide (for example when a pending
  // scene persistence update lands); that render must not turn the queued
  // snapshot dirty again. A different project/pdf tuple is genuine new work.
  const autosaveExitFlushSnapshotRef = useRef<LoadedClassroomProject | null>(null);
  // The latest snapshot covered by saveAutosave, including a write queued
  // behind an older transaction. Keep it through completion so a delayed
  // React commit of that same tuple cannot mark it dirty again; a genuinely
  // newer project/pdf tuple clears the token.
  const autosaveCoveredSnapshotRef = useRef<LoadedClassroomProject | null>(null);
  // Keep the startup save barrier closed until the first scene hydration has
  // settled. A valid loaded project has no write to perform, but Excalidraw
  // can still emit a late scene update while it mounts; reporting "Saved
  // locally" before that update is committed lets page-exit handling race the
  // just-loaded state.
  const autosaveStartupReadyRef = useRef(false);
  const skipNextAutosaveEffectRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveLastQueuedAtRef = useRef(0);
  const autosaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingScenePersistenceRef = useRef<PendingScenePersistence | null>(null);
  const scenePersistenceTimerRef = useRef<number | null>(null);
  projectRef.current = project;
  pdfBytesRef.current = pdfBytes;
  const abortSceneOperations = useCallback((clearBusy = false) => {
    for (const controller of sceneOperationControllersRef.current) controller.abort();
    sceneOperationControllersRef.current.clear();
    if (clearBusy && sceneOperationBusyRef.current.size > 0) {
      sceneOperationBusyRef.current.clear();
      setBusyMessage(null);
      setIsScreenshotBusy(false);
      screenshotBusyOwnerRef.current += 1;
    }
    if (clearBusy && probabilityOperationRef.current) {
      probabilityOperationRef.current = null;
      probabilityRandomizingRef.current = false;
      setIsProbabilitySpinning(false);
      setSpinnerPointerAnimations([]);
    }
  }, []);
  const beginSceneOperation = useCallback((): SceneOperation | null => {
    const projectId = projectRef.current?.id;
    const sceneId = hydratedSceneIdRef.current;
    if (
      !projectId
      || !sceneId
      || switchingSceneRef.current
      || projectRef.current?.activeSceneId !== sceneId
    ) return null;
    const controller = new AbortController();
    sceneOperationControllersRef.current.add(controller);
    return {
      controller,
      hydrationGeneration: sceneHydrationGenerationRef.current,
      projectId,
      sceneId,
      signal: controller.signal,
    };
  }, []);
  const isCurrentSceneOperation = useCallback((operation: SceneOperation | null): operation is SceneOperation => {
    if (
      !operation
      || operation.signal.aborted
      || !sceneOperationMountedRef.current
      || switchingSceneRef.current
      || projectRef.current?.activeSceneId !== hydratedSceneIdRef.current
    ) return false;
    return sceneOperationIsCurrent(operation, {
      cancelled: false,
      hydrationGeneration: sceneHydrationGenerationRef.current,
      projectId: projectRef.current?.id || "",
      sceneId: hydratedSceneIdRef.current || "",
    });
  }, []);
  const finishSceneOperation = useCallback((operation: SceneOperation | null) => {
    if (!operation) return;
    sceneOperationControllersRef.current.delete(operation.controller);
  }, []);
  const cancelSceneHydrationFrames = useCallback(() => {
    if (sceneHydrationOuterFrameRef.current !== null) {
      window.cancelAnimationFrame(sceneHydrationOuterFrameRef.current);
      sceneHydrationOuterFrameRef.current = null;
    }
    if (sceneHydrationInnerFrameRef.current !== null) {
      window.cancelAnimationFrame(sceneHydrationInnerFrameRef.current);
      sceneHydrationInnerFrameRef.current = null;
    }
  }, []);
  const cancelFileOpenOperations = useCallback((clearUi = false) => {
    fileOpenGenerationRef.current += 1;
    fileOpenAbortControllerRef.current?.abort();
    fileOpenAbortControllerRef.current = null;
    startupAutosaveAbortControllerRef.current?.abort();
    startupAutosaveAbortControllerRef.current = null;
    pdfInsertOperationGenerationRef.current = null;
    if (!clearUi) return;
    busyCancelRef.current = null;
    setBusyCanCancel(false);
    setBusyMessage(null);
    setPendingPdfInsert(null);
    setPdfInsertProcessing(false);
    setPdfInsertCancelling(false);
    setPdfInsertProgress(null);
  }, []);
  const beginFileOpenOperation = useCallback((): FileOpenOperation => {
    abortSceneOperations(true);
    startupAutosaveAbortControllerRef.current?.abort();
    startupAutosaveAbortControllerRef.current = null;
    fileOpenAbortControllerRef.current?.abort();
    // A superseded archive restore may have paused autosave while awaiting
    // its replacement write. Reopen that guard for the next intent; protected
    // recovery mode has no owner generation and remains paused.
    if (autosaveSuspensionGenerationRef.current !== null) {
      autosaveSuspendedRef.current = false;
      autosaveSuspensionGenerationRef.current = null;
    }
    const controller = new AbortController();
    fileOpenAbortControllerRef.current = controller;
    const operation = {
      generation: fileOpenGenerationRef.current + 1,
      signal: controller.signal,
    };
    fileOpenGenerationRef.current = operation.generation;
    return operation;
  }, [abortSceneOperations]);
  const isCurrentFileOpenOperation = useCallback((operation: FileOpenOperation) => (
    fileOpenGenerationRef.current === operation.generation
    && fileOpenAbortControllerRef.current?.signal === operation.signal
    && !operation.signal.aborted
  ), []);
  const beginSceneHydration = useCallback(() => {
    // Wrapper pointer overlays belong to the currently hydrated editor scene.
    // Unmount them before replacing Excalidraw state so their visible controls
    // and any armed pointer gesture cannot leak into the incoming scene/page.
    resetTransientPointerTools();
    abortSceneOperations(true);
    // A new scene supersedes any buffered edit from the outgoing hydration
    // window. Preserve it as ordinary pending scene work so navigation cannot
    // discard a real pointer/keyboard edit that arrived just before the
    // switch boundary.
    const adopted = preservePendingScenePersistence(
      pendingScenePersistenceRef.current,
      bufferedHydrationChangeRef.current,
    );
    pendingScenePersistenceRef.current = adopted.pending;
    bufferedHydrationChangeRef.current = adopted.buffered;
    sceneHydrationBaselineRef.current = null;
    // Do this while the outgoing dark background still references the
    // transient file, allowing Excalidraw to evict its decoded full-page image.
    retireActiveDarkPdfDisplayFile();
    // The outgoing scene's display ID is no longer valid once hydration clears
    // the live file map. Never let a later editor change reapply that missing
    // transient ID before the incoming dark render has completed.
    darkPdfDisplayFileIdsRef.current.clear();
    cancelSceneHydrationFrames();
    switchingSceneRef.current = true;
    sceneHydrationGenerationRef.current += 1;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
      presentationInkFrameRef.current = null;
    }
    presentationInkStartElementIdsRef.current = null;
    presentationInkGenerationRef.current += 1;
    darkPdfPreviewGenerationRef.current += 1;
    for (const controller of darkPdfRenderControllersRef.current) controller.abort();
    darkPdfRenderControllersRef.current.clear();
    return sceneHydrationGenerationRef.current;
  }, [
    abortSceneOperations,
    cancelSceneHydrationFrames,
    resetTransientPointerTools,
    retireActiveDarkPdfDisplayFile,
  ]);
  useEffect(() => {
    sceneOperationMountedRef.current = true;
    return () => {
      sceneOperationMountedRef.current = false;
      abortSceneOperations();
      sceneHydrationGenerationRef.current += 1;
      darkPdfPreviewGenerationRef.current += 1;
      fileOpenGenerationRef.current += 1;
      fileOpenAbortControllerRef.current?.abort();
      fileOpenAbortControllerRef.current = null;
      pdfExportAbortControllerRef.current?.abort();
      pdfExportAbortControllerRef.current = null;
      busyCancelRef.current = null;
      startupAutosaveAbortControllerRef.current?.abort();
      startupAutosaveAbortControllerRef.current = null;
      presentationInkGenerationRef.current += 1;
      presentationInkStartElementIdsRef.current = null;
      if (presentationInkFrameRef.current !== null) {
        window.cancelAnimationFrame(presentationInkFrameRef.current);
        presentationInkFrameRef.current = null;
      }
      sceneHydrationBaselineRef.current = null;
      bufferedHydrationChangeRef.current = null;
      for (const controller of darkPdfRenderControllersRef.current) controller.abort();
      darkPdfRenderControllersRef.current.clear();
      cancelSceneHydrationFrames();
    };
  }, [abortSceneOperations, cancelSceneHydrationFrames]);
  useEffect(() => () => {
    window.cancelAnimationFrame(slideDetachmentFrameRef.current);
  }, []);
  const closeExportDialog = useCallback(() => setExportOpen(false), []);
  const shouldRestoreExportDialogFocus = useCallback(
    () => !nativeImageExportOpenRef.current,
    [],
  );
  const exportDialogRef = useModalDialog<HTMLElement>({
    onClose: closeExportDialog,
    open: exportOpen,
    restoreFocus: shouldRestoreExportDialogFocus,
    returnFocusRef: exportOptionsTriggerRef,
  });
  const commitPendingScenePersistence = useCallback(() => {
    const adopted = preservePendingScenePersistence(
      pendingScenePersistenceRef.current,
      bufferedHydrationChangeRef.current,
    );
    pendingScenePersistenceRef.current = preserveDeletedForPendingPdfUndo(
      adopted.pending,
      pendingPdfAnnotationClearTransaction(pendingPdfUndoRef.current)?.affectedPageIds,
    );
    bufferedHydrationChangeRef.current = adopted.buffered;
    if (scenePersistenceTimerRef.current !== null) {
      window.clearTimeout(scenePersistenceTimerRef.current);
      scenePersistenceTimerRef.current = null;
    }
    const pending = pendingScenePersistenceRef.current;
    if (!pending) return projectRef.current;
    pendingScenePersistenceRef.current = null;
    const baseProject = projectRef.current;
    const nextProject = projectWithPendingScene(baseProject, pending);
    if (!nextProject) return baseProject;
    if (nextProject === baseProject) {
      if (
        !autosaveSuspendedRef.current
        && !autosaveDirtyRef.current
        && !autosaveSavingRef.current
        && autosaveStartupReadyRef.current
      ) setSaveStatus("saved");
      return baseProject;
    }
    projectRef.current = nextProject;
    const nextSnapshot = {
      project: nextProject,
      pdfBytes: pdfBytesRef.current,
    };
    autosaveSnapshotRef.current = nextSnapshot;
    const sameQueuedExitSnapshot = autosaveSnapshotsMatch(
      autosaveExitFlushSnapshotRef.current,
      nextSnapshot.project,
      nextSnapshot.pdfBytes,
    );
    if (!sameQueuedExitSnapshot) {
      autosaveCoveredSnapshotRef.current = null;
      autosaveExitFlushSnapshotRef.current = null;
      autosaveExitFlushQueuedRef.current = false;
      autosaveDirtyRef.current = true;
      if (autosaveSavingRef.current) autosaveUrgentRef.current = true;
    }
    setProject((current) => {
      if (current === baseProject) return nextProject;
      const mergedProject = projectWithPendingScene(current, pending);
      if (!mergedProject) return current;
      projectRef.current = mergedProject;
      const mergedSnapshot = {
        project: mergedProject,
        pdfBytes: pdfBytesRef.current,
      };
      autosaveSnapshotRef.current = mergedSnapshot;
      const sameQueuedMergedSnapshot = autosaveSnapshotsMatch(
        autosaveExitFlushSnapshotRef.current,
        mergedSnapshot.project,
        mergedSnapshot.pdfBytes,
      );
      if (!sameQueuedMergedSnapshot) {
        autosaveCoveredSnapshotRef.current = null;
        autosaveExitFlushSnapshotRef.current = null;
        autosaveExitFlushQueuedRef.current = false;
        autosaveDirtyRef.current = true;
        if (autosaveSavingRef.current) autosaveUrgentRef.current = true;
      }
      return mergedProject;
    });
    return nextProject;
  }, []);
  const commitLiveScenePersistence = useCallback((sceneId: string, preserveDeleted = false) => {
    const committed = commitPendingScenePersistence();
    const liveSceneId = hydratedSceneIdRef.current;
    if (
      !api
      || switchingSceneRef.current
      || !committed
      || liveSceneId !== sceneId
    ) return committed;
    const scene = committed.scenes[sceneId];
    if (!scene) return committed;
    const preserveDeletedForUndo = pendingPdfAnnotationClearTransaction(
      pendingPdfUndoRef.current,
    )?.affectedPageIds.includes(sceneId) === true;
    // Destructive controls can run before Excalidraw's debounced onChange
    // reaches pendingScenePersistenceRef. Capture the editor synchronously,
    // but send it through the same canonicalization, slide detachment,
    // serialization, and file filtering pipeline as an ordinary scene edit.
    pendingScenePersistenceRef.current = {
      sceneId,
      // Destructive wrapper transactions must retain Excalidraw tombstones:
      // they can still own local files and are part of safe annotation undo.
      elements: api.getSceneElementsIncludingDeleted(),
      appState: api.getAppState(),
      files: persistentFilesForScene(
        scene,
        api.getFiles(),
        transientDarkPdfFileIdsRef.current,
      ),
      preserveDeleted: preserveDeleted || preserveDeletedForUndo,
    };
    return commitPendingScenePersistence();
  }, [api, commitPendingScenePersistence]);
  const commitCurrentLiveScenePersistence = useCallback(() => (
    commitLiveScenePersistence(
      hydratedSceneIdRef.current
        || activeSceneIdRef.current
        || projectRef.current?.activeSceneId
        || "",
    )
  ), [commitLiveScenePersistence]);
  const queueScenePersistence = useCallback((pending: PendingScenePersistence) => {
    pendingScenePersistenceRef.current = pending;
    if (!autosaveSuspendedRef.current) setSaveStatus("saving");
    if (scenePersistenceTimerRef.current !== null) {
      window.clearTimeout(scenePersistenceTimerRef.current);
    }
    scenePersistenceTimerRef.current = window.setTimeout(
      commitPendingScenePersistence,
      SCENE_PERSISTENCE_DELAY_MS,
    );
  }, [commitPendingScenePersistence]);
  const flushAutosave = useCallback((urgent = false, queueBehindActive = false) => {
    if (autosaveSuspendedRef.current) return;
    if (urgent) autosaveUrgentRef.current = true;
    const snapshot = autosaveSnapshotRef.current;
    if (!snapshot || !autosaveDirtyRef.current) return;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    // Keep at most one write in flight. Edits made while it runs remain in
    // autosaveSnapshotRef and replace one another, so a slow device never
    // accumulates an ordinary queue of complete project snapshots. A page-exit
    // flush is the one exception: enqueue the newest snapshot immediately
    // behind the active IndexedDB transaction instead of relying on a timer
    // that may never run after the document is torn down.
    const sameCoveredSnapshot = autosaveSnapshotsMatch(
      autosaveCoveredSnapshotRef.current,
      snapshot.project,
      snapshot.pdfBytes,
    );
    if (sameCoveredSnapshot) {
      // A late React commit or urgent interaction timer can re-mark the tuple
      // that is already queued or was just committed. It is covered by that
      // write; only a different snapshot may be queued behind it.
      autosaveDirtyRef.current = false;
      autosaveUrgentRef.current = false;
      return;
    }
    if (autosaveSavingRef.current) {
      // Ordinary text-entry flushes only mark the current save for an
      // immediate follow-up. Page-exit/visibility flushes opt into queuing a
      // second snapshot behind the active transaction because their timers
      // may never run after the document is torn down.
      if (!queueBehindActive) return;
    }
    const elapsed = Date.now() - autosaveLastQueuedAtRef.current;
    const cooldown = getAutosaveCooldownMs(
      autosaveContentBytesRef.current,
      autosaveLastDurationMsRef.current,
    );
    if (
      !autosaveSavingRef.current
      && !urgent
      && autosaveLastQueuedAtRef.current > 0
      && elapsed < cooldown
    ) {
      autosaveTimerRef.current = window.setTimeout(
        () => flushAutosave(),
        cooldown - elapsed,
      );
      return;
    }

    autosaveDirtyRef.current = false;
    autosaveSavingRef.current = true;
    autosaveUrgentRef.current = false;
    autosaveLastQueuedAtRef.current = Date.now();
    autosaveCoveredSnapshotRef.current = snapshot;
    setSaveStatus("saving");
    const saveStartedAt = performance.now();
    const queuedSave = saveAutosave(
      snapshot.project,
      snapshot.pdfBytes,
      { prepared: true },
    ).then((contentSize) => {
      autosaveContentBytesRef.current = contentSize.totalBytes;
    }).finally(() => {
      autosaveLastDurationMsRef.current = Math.max(
        0,
        performance.now() - saveStartedAt,
      );
    });
    autosaveQueueRef.current = queuedSave;
    queuedSave.then(
      () => {
        if (autosaveQueueRef.current !== queuedSave) return;
        autosaveSavingRef.current = false;
        // Excalidraw can emit the initial scene update while this save is in
        // flight. queueScenePersistence marks the status as saving but waits
        // briefly before committing the scene, so checking only
        // autosaveDirtyRef here could briefly report "Saved locally" with a
        // stale snapshot still queued. Commit it now and keep the follow-up
        // write on the same autosave path.
        if (pendingScenePersistenceRef.current) commitPendingScenePersistence();
        if (!autosaveDirtyRef.current) {
          setSaveStatus(autosaveStartupReadyRef.current ? "saved" : "saving");
          return;
        }
        const elapsed = Date.now() - autosaveLastQueuedAtRef.current;
        const followupUrgent = autosaveUrgentRef.current;
        const delay = followupUrgent ? 0 : getAutosaveFollowupDelayMs(
          autosaveContentBytesRef.current,
          elapsed,
          autosaveLastDurationMsRef.current,
        );
        autosaveTimerRef.current = window.setTimeout(
          () => flushAutosave(followupUrgent),
          delay,
        );
      },
      (error) => {
        if (autosaveQueueRef.current !== queuedSave) return;
        autosaveSavingRef.current = false;
        autosaveCoveredSnapshotRef.current = null;
        autosaveUrgentRef.current = false;
        // Keep the newest snapshot eligible for a later interaction/page-exit
        // flush. Retrying here would create a tight loop while storage remains
        // unavailable; flushAutosave always reads autosaveSnapshotRef so a
        // newer edit is retried instead of this captured snapshot.
        autosaveExitFlushSnapshotRef.current = null;
        autosaveExitFlushQueuedRef.current = false;
        autosaveDirtyRef.current = true;
        setSaveStatus("error");
        if (error instanceof AutosaveConflictError) {
          // Preserve this tab's board without retrying over a newer revision.
          // The explicit recovery action below is the only path that may
          // intentionally replace another tab's saved work.
          autosaveSuspendedRef.current = true;
          autosaveSuspensionGenerationRef.current = null;
          setAutosaveRecoveryKind("conflict");
          setAutosaveRecoveryDetail(error.message);
          setErrorMessage(null);
        } else {
          setErrorMessage(autosaveFailureMessage(error));
        }
      },
    );
  }, []);

  const hideConstrainedFramePreview = useCallback(() => {
    if (frameDragPreviewRef.current) frameDragPreviewRef.current.hidden = true;
  }, []);

  const stopSlideFrameDrawing = useCallback(() => {
    slideFrameGestureRef.current = null;
    slideFrameDrawingActiveRef.current = false;
    pendingSlideFrameActionRef.current = null;
    hideConstrainedFramePreview();
    setIsSlideFrameDrawingActive(false);
    api?.setActiveTool({ type: "selection" });
    api?.updateFrameRendering({ enabled: true, outline: true, name: true, clip: false });
  }, [api, hideConstrainedFramePreview]);

  useEffect(() => {
    if (isMathToolsOpen || isGeoGonOpen || !focusAfterMathToolsRef.current) return;
    const focusTarget = focusAfterMathToolsRef.current;
    focusAfterMathToolsRef.current = null;
    const selector = focusTarget === "editor"
      ? ".excalidraw"
      : ".App-toolbar__extra-tools-trigger";
    editorHostRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [isGeoGonOpen, isMathToolsOpen]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    startupAutosaveAbortControllerRef.current = controller;
    // Startup autosave loading can spend time validating PDF/raster content.
    // A user may open a file before that work resolves; once a file-open
    // intent advances this generation, the stale startup result must not
    // replace the project the user explicitly selected (including recovery
    // state installed by a late rejection).
    const startupFileOpenGeneration = fileOpenGenerationRef.current;
    const isCurrentStartupLoad = () => (
      startupLoadGenerationIsCurrent(
        startupFileOpenGeneration,
        fileOpenGenerationRef.current,
        cancelled,
      )
    );
    loadAutosave({ signal: controller.signal })
      .then((loaded) => {
        if (!isCurrentStartupLoad()) return;
        if (loaded) {
          const framesVisible = loaded.project.slideFramesVisible !== false;
          const startupProject = projectForBoardStartup(loaded.project);
          slideFramesVisibleRef.current = framesVisible;
          projectRef.current = startupProject;
          activeSceneIdRef.current = startupProject.activeSceneId;
          pdfBytesRef.current = loaded.pdfBytes;
          autosaveSnapshotRef.current = {
            project: startupProject,
            pdfBytes: loaded.pdfBytes,
          };
          autosaveExitFlushSnapshotRef.current = null;
          autosaveCoveredSnapshotRef.current = null;
          autosaveDirtyRef.current = false;
          skipNextAutosaveEffectRef.current = true;
          setAreSlideFramesVisible(framesVisible);
          setProject(startupProject);
          setPdfBytes(loaded.pdfBytes);
        } else {
          const blankProject = createBlankProject();
          projectRef.current = blankProject;
          activeSceneIdRef.current = blankProject.activeSceneId;
          setProject(blankProject);
        }
      })
      .catch((error) => {
        if (isCurrentStartupLoad() && !isAbortLikeError(error)) {
          setAutosaveRecoveryKind("unreadable");
          setAutosaveRecoveryDetail(error instanceof Error ? error.message : String(error));
          // Keep the unread autosave untouched. Showing a temporary blank
          // board must not turn a transient IndexedDB/PDF-integrity failure
          // into permanent data loss before the teacher can recover storage.
          const fallbackProject = createBlankProject();
          projectRef.current = fallbackProject;
          activeSceneIdRef.current = fallbackProject.activeSceneId;
          pdfBytesRef.current = {};
          autosaveSnapshotRef.current = {
            project: fallbackProject,
            pdfBytes: {},
          };
          autosaveExitFlushSnapshotRef.current = null;
          autosaveCoveredSnapshotRef.current = null;
          autosaveDirtyRef.current = false;
          autosaveSuspendedRef.current = true;
          skipNextAutosaveEffectRef.current = true;
          setSaveStatus("error");
          setProject(fallbackProject);
        }
      })
      .finally(() => {
        if (startupAutosaveAbortControllerRef.current === controller) {
          startupAutosaveAbortControllerRef.current = null;
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (startupAutosaveAbortControllerRef.current === controller) {
        startupAutosaveAbortControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadScreenshotLibrary()
      .then((items) => {
        if (cancelled) return;
        screenshotsRef.current = items;
        setScreenshots(items);
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(`Screenshot Library could not be opened: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setIsScreenshotLibraryLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!project) return;
    activeSceneIdRef.current = project.activeSceneId;
  }, [project?.activeSceneId]);

  useEffect(() => {
    slideFrameAspectRatioRef.current = project?.slideFrameAspectRatio ?? "freeform";
  }, [project?.slideFrameAspectRatio]);

  useEffect(() => {
    setMathInteraction(null);
    setIsScreenshotCaptureActive(false);
    setIsProbabilitySpinning(false);
    setSpinnerPointerAnimations([]);
    if (workspaceMode !== "slides" && slideFrameDrawingActiveRef.current) {
      stopSlideFrameDrawing();
    }
    slideFrameGestureRef.current = null;
    if (frameDragPreviewRef.current) frameDragPreviewRef.current.hidden = true;
    api?.updateFrameRendering({
      enabled: slideFramesVisibleRef.current,
      outline: true,
      name: true,
      clip: false,
    });
  }, [api, project?.activeSceneId, stopSlideFrameDrawing, workspaceMode]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const shellIsFullscreen = Boolean(
        shellRef.current && document.fullscreenElement === shellRef.current,
      );
      const intent = fullscreenIntentRef.current;
      if (shellIsFullscreen && intent) {
        intent.entered = true;
      } else if (intent?.entered) {
        // A native Escape can end manual fullscreen without going through
        // toggleFullscreen. Retire that owner so a later stale request cannot
        // mistake it for a still-current fullscreen intent.
        fullscreenIntentRef.current = null;
      }
      setIsFullscreen(shellIsFullscreen);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    syncFullscreenState();
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    if (presentation) return;
    const toggleChrome = (event: KeyboardEvent) => {
      if (event.repeat || !event.shiftKey || (!event.ctrlKey && !event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "h" && key !== "f") return;
      if (hasVisibleModalSurface()) return;
      event.preventDefault();
      if (key === "h") setIsNavigationVisible((visible) => !visible);
      else toggleFooterPreference();
    };
    window.addEventListener("keydown", toggleChrome, true);
    return () => window.removeEventListener("keydown", toggleChrome, true);
  }, [presentation, toggleFooterPreference]);

  useLayoutEffect(() => {
    if (!project) return;
    const snapshot = { project, pdfBytes };
    const sameQueuedExitSnapshot = autosaveSnapshotsMatch(
      autosaveExitFlushSnapshotRef.current,
      snapshot.project,
      snapshot.pdfBytes,
    );
    const sameCoveredSnapshot = autosaveSnapshotsMatch(
      autosaveCoveredSnapshotRef.current,
      snapshot.project,
      snapshot.pdfBytes,
    );
    autosaveSnapshotRef.current = snapshot;
    if (skipNextAutosaveEffectRef.current) {
      skipNextAutosaveEffectRef.current = false;
      return;
    }
    if (autosaveSuspendedRef.current) return;
    if (sameQueuedExitSnapshot || sameCoveredSnapshot) {
      autosaveDirtyRef.current = false;
      return;
    }
    autosaveCoveredSnapshotRef.current = null;
    autosaveExitFlushSnapshotRef.current = null;
    autosaveExitFlushQueuedRef.current = false;
    autosaveDirtyRef.current = true;
    setSaveStatus("saving");
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);

    // A keyup can request an urgent text-entry flush just before React commits
    // the matching controlled-input update. This layout effect must replace
    // that timer so it saves the fresh snapshot, but it must not replace the
    // urgent intent with the ordinary trailing delay.
    if (autosaveUrgentRef.current) {
      autosaveTimerRef.current = window.setTimeout(
        () => flushAutosave(true),
        0,
      );
      return;
    }

    const elapsed = Date.now() - autosaveLastQueuedAtRef.current;
    const interval = Math.max(
      AUTOSAVE_BASE_INTERVAL_MS,
      getAutosaveCooldownMs(
        autosaveContentBytesRef.current,
        autosaveLastDurationMsRef.current,
      ),
    );
    if (!autosaveSavingRef.current && elapsed >= interval) {
      flushAutosave();
      return;
    }
    if (autosaveSavingRef.current) {
      // Preserve one immediate, latest-only follow-up when edits arrive while
      // a save is in flight. Waiting through a duration-based cooldown here
      // can leave the visible document ahead of its recovery copy for several
      // extra seconds on the slow devices that need autosave most.
      autosaveUrgentRef.current = true;
      return;
    }
    autosaveTimerRef.current = window.setTimeout(
      () => flushAutosave(),
      Math.max(0, interval - elapsed),
    );
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [project, pdfBytes, flushAutosave]);

  useEffect(() => {
    const scheduleInteractionFlush = (urgent = false) => {
      // Record urgency before yielding to a timer. A controlled input can
      // commit another render first, and its layout effect clears/replaces the
      // current autosave timer.
      if (urgent) autosaveUrgentRef.current = true;
      commitPendingScenePersistence();
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = window.setTimeout(() => flushAutosave(urgent), 0);
    };
    const flushAfterInteraction = () => scheduleInteractionFlush();
    const flushAfterMutationKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const target = event.target;
      const textEntry = (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      );
      if (
        textEntry
        || key === "delete"
        || key === "backspace"
        || key === "enter"
        || key === "escape"
        || key.startsWith("arrow")
        || ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y"))
      ) {
        // Text-entry commits are user-visible document changes. If an older
        // save is still in flight (or the normal project cooldown has not
        // elapsed), mark one immediate follow-up instead of making the user
        // wait for that trailing delay. `flushAutosave(true)` keeps the
        // one-write-at-a-time mutation queue intact while allowing the latest
        // snapshot to bypass the cooldown.
        scheduleInteractionFlush(textEntry);
      }
    };
    const flushNewestPageExitSnapshot = () => {
      // Excalidraw can hold the final pointer stroke in its live scene before
      // the debounced onChange callback reaches React. Capture that scene
      // synchronously while onChange is still allowed to run; only then let
      // page teardown suppress transient callbacks and flush the snapshot.
      commitLiveScenePersistence(
        hydratedSceneIdRef.current
          || activeSceneIdRef.current
          || projectRef.current?.activeSceneId
          || "",
      );
      commitPendingScenePersistence();
      const snapshot = autosaveSnapshotRef.current;
      if (!snapshot) return;
      // A late React commit can mark the same snapshot dirty after its exit
      // write was queued. Treat that tuple as already covered, even if a
      // second exit event reset the boolean guard in between.
      if (autosaveSnapshotsMatch(
        autosaveExitFlushSnapshotRef.current,
        snapshot.project,
        snapshot.pdfBytes,
      )) {
        autosaveDirtyRef.current = false;
        autosaveUrgentRef.current = false;
        return;
      }
      if (!autosaveDirtyRef.current || autosaveExitFlushQueuedRef.current) return;
      autosaveExitFlushQueuedRef.current = true;
      autosaveExitFlushSnapshotRef.current = snapshot;
      flushAutosave(true, true);
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushNewestPageExitSnapshot();
      else autosaveExitFlushQueuedRef.current = false;
    };
    const flushBeforePageExit = (event: BeforeUnloadEvent) => {
      // A dismissed beforeunload prompt leaves this document alive and does
      // not reliably emit pageshow. Let the guard reopen on the next task in
      // that case; during a real navigation the document is torn down before
      // this callback can run.
      window.setTimeout(() => {
        autosavePageExitRef.current = false;
        autosaveExitFlushQueuedRef.current = false;
      }, 0);
      flushNewestPageExitSnapshot();
      autosavePageExitRef.current = true;
      if (
        !pendingScenePersistenceRef.current
        && !autosaveDirtyRef.current
        && !autosaveSavingRef.current
      ) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const flushOnPageHide = () => {
      flushNewestPageExitSnapshot();
      autosavePageExitRef.current = true;
    };
    const resetPageExit = () => {
      autosavePageExitRef.current = false;
      autosaveExitFlushQueuedRef.current = false;
    };
    window.addEventListener("pointerup", flushAfterInteraction);
    window.addEventListener("click", flushAfterInteraction);
    window.addEventListener("keyup", flushAfterMutationKey);
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("beforeunload", flushBeforePageExit);
    window.addEventListener("pagehide", flushOnPageHide);
    window.addEventListener("pageshow", resetPageExit);
    return () => {
      window.removeEventListener("pointerup", flushAfterInteraction);
      window.removeEventListener("click", flushAfterInteraction);
      window.removeEventListener("keyup", flushAfterMutationKey);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("beforeunload", flushBeforePageExit);
      window.removeEventListener("pagehide", flushOnPageHide);
      window.removeEventListener("pageshow", resetPageExit);
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      if (scenePersistenceTimerRef.current !== null) {
        window.clearTimeout(scenePersistenceTimerRef.current);
      }
    };
  }, [commitLiveScenePersistence, commitPendingScenePersistence, flushAutosave]);

  const runSlideFrameAction = useCallback((action: SlideFrameAction) => {
    if (!api) return;
    slideFramesVisibleRef.current = true;
    api.updateFrameRendering({ enabled: true, clip: false });
    setAreSlideFramesVisible(true);
    setProject((current) => current && current.slideFramesVisible === false ? {
      ...current,
      updatedAt: nowIso(),
      slideFramesVisible: true,
    } : current);
    if (action.kind === "draw") {
      const aspectMode = slideFrameAspectRatioRef.current;
      activateSlideFrameTool(api, aspectMode);
      return;
    }
    pendingCreatedFrameIdRef.current = action.frameId;
    addBlankSlideFrame(api, action.title, action.frameId);
  }, [api]);

  const focusProjectSearchTarget = useCallback((target: PendingProjectSearchTarget) => {
    if (!api) return;
    pendingProjectSearchTargetRef.current = target;
    void afterNextPaint().then(() => {
      // PDF mode centers its page background over two paints. Search wins on
      // the following paint so the exact text, not the page, remains focused.
      window.requestAnimationFrame(() => {
        if (
          pendingProjectSearchTargetRef.current !== target
          || activeSceneIdRef.current !== target.sceneId
        ) return;
        pendingProjectSearchTargetRef.current = null;
        const element = api.getSceneElements().find((candidate) => (
          candidate.id === target.elementId && !candidate.isDeleted
        ));
        if (!element) {
          api.setToast({ message: "That search result is no longer on the canvas." });
          return;
        }
        api.setActiveTool({ type: "selection" });
        api.updateScene({
          appState: { selectedElementIds: { [element.id]: true } },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        api.scrollToContent(element, { animate: true, duration: 250 });
      });
    });
  }, [api]);

  const loadSceneIntoEditor = useCallback((scene: SerializedScene) => {
    if (!api) return;
    const hydrationGeneration = beginSceneHydration();
    const sceneId = scene.id;
    // Snapshot first: a stored scene can intentionally share the same live
    // BinaryFiles object returned by Excalidraw after persistence. Clearing
    // that map below must not also erase the source files we are about to add.
    const files = { ...scene.files } as unknown as BinaryFiles;
    const liveAppState = api.getAppState();
    const editorPreferences = featurePreferencesRef.current;
    // Legacy projects may contain a wrapper-owned custom tool marker, but the
    // corresponding pointer overlay is React state and is not persisted.
    // Normalize a clone on read so hydration cannot revive a dead tool.
    const hydratedAppState = { ...scene.appState };
    // Some generated scenes (notably PDF pages) intentionally omit activeTool.
    // Excalidraw merges absent app-state keys, so an outgoing wrapper custom
    // tool would otherwise survive even though its React overlay was torn down.
    if (!hydratedAppState.activeTool && isPersistedWrapperTool(liveAppState.activeTool)) {
      hydratedAppState.activeTool = { ...liveAppState.activeTool };
    }
    canonicalizePersistedWrapperTool(hydratedAppState);
    // Excalidraw's addFiles() is merge-only and its decoded-image cache is
    // keyed by file ID. Empty the live map before replacing the elements so
    // reopening a project with the same scene/file IDs cannot keep stale
    // image bytes or leak files from the previous scene. Adding after
    // updateScene also lets Excalidraw invalidate image caches against the new
    // elements that reference those IDs.
    const liveFiles = api.getFiles();
    for (const fileId of Object.keys(liveFiles)) delete liveFiles[fileId as FileId];
    api.updateScene({
      elements: scene.elements as unknown as readonly ExcalidrawElement[],
      appState: {
        ...(hydratedAppState as unknown as AppState),
        penMode: editorPreferences.penOnly,
        penDetected: true,
        gridModeEnabled: editorPreferences.showGrid,
        objectsSnapModeEnabled: editorPreferences.snapToObjects,
        theme: editorThemeRef.current,
        stats: liveAppState.stats,
        openSidebar: liveAppState.openSidebar,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    hydratedSceneIdRef.current = scene.id;
    api.addFiles(Object.values(files));
    api.updateFrameRendering({ enabled: slideFramesVisibleRef.current, clip: false });
    api.history.clear();
    sceneHydrationBaselineRef.current = {
      generation: hydrationGeneration,
      pending: normalizedHydrationChange(
        scene,
        api.getSceneElements(),
        api.getAppState(),
        api.getFiles(),
        transientDarkPdfFileIdsRef.current,
      ),
    };
    sceneHydrationOuterFrameRef.current = window.requestAnimationFrame(() => {
      sceneHydrationOuterFrameRef.current = null;
      if (
        sceneHydrationGenerationRef.current !== hydrationGeneration
        || projectRef.current?.activeSceneId !== sceneId
      ) return;
      // Excalidraw may deliver its initial onChange after updateScene returns.
      // Keep scene persistence suppressed through a second paint so the
      // startup "Saved locally" state cannot precede that hydration event.
      sceneHydrationInnerFrameRef.current = window.requestAnimationFrame(() => {
        sceneHydrationInnerFrameRef.current = null;
        if (
          sceneHydrationGenerationRef.current !== hydrationGeneration
          || projectRef.current?.activeSceneId !== sceneId
        ) return;
        switchingSceneRef.current = false;
        sceneHydrationBaselineRef.current = null;
        // The dark-PDF effect may have rendered while the replacement scene
        // was still behind the imperative editor boundary. Re-run it only
        // after both hydration paints have completed so no display-only
        // update can re-enter Excalidraw's LayerUI during scene replacement.
        setDarkPdfDisplayRevision((revision) => revision + 1);
        const bufferedHydrationChange = bufferedHydrationChangeRef.current;
        const pendingSceneId = pendingScenePersistenceRef.current?.sceneId;
        if (
          bufferedHydrationChange
          && bufferedHydrationChange.sceneId === sceneId
          && (!pendingSceneId || pendingSceneId === sceneId)
        ) {
          bufferedHydrationChangeRef.current = null;
          // Replay the latest non-hydration onChange through the normal
          // persistence debounce. This keeps the editor's synthetic
          // hydration echo out of autosave while retaining a real edit made
          // before the second paint completed.
          queueScenePersistence(bufferedHydrationChange);
        } else if (bufferedHydrationChange) {
          // A buffer for another scene can coexist with a normal pending
          // snapshot from an earlier transition. Drain both in order now
          // that the project map already contains every scene; never drop the
          // cross-scene buffer by blindly clearing the ref.
          commitPendingScenePersistence();
          commitPendingScenePersistence();
        }
        if (!autosaveStartupReadyRef.current) {
          autosaveStartupReadyRef.current = true;
          if (
            !autosaveSuspendedRef.current
            && !autosaveDirtyRef.current
            && !autosaveSavingRef.current
            && !pendingScenePersistenceRef.current
          ) {
            setSaveStatus("saved");
          }
        }
        if (pendingFrameIdRef.current) {
          focusSlide(api, pendingFrameIdRef.current, true);
          pendingFrameIdRef.current = null;
        }
        if (pendingSlideFrameActionRef.current) {
          const pendingAction = pendingSlideFrameActionRef.current;
          pendingSlideFrameActionRef.current = null;
          if (
            pendingAction.sceneId === sceneId
            && featurePreferencesRef.current.slides
          ) runSlideFrameAction(pendingAction.action);
        }
        const pendingSearchTarget = pendingProjectSearchTargetRef.current;
        if (pendingSearchTarget?.sceneId === sceneId) {
          focusProjectSearchTarget(pendingSearchTarget);
        }
      });
    });
  }, [
    api,
    beginSceneHydration,
    commitPendingScenePersistence,
    focusProjectSearchTarget,
    queueScenePersistence,
    runSlideFrameAction,
  ]);

  useEffect(() => {
    if (!api || !project) return;
    const scene = project.scenes[project.activeSceneId];
    if (scene) loadSceneIntoEditor(scene);
  }, [api, project?.id, project?.activeSceneId, projectHydrationRevision, loadSceneIntoEditor]);

  useEffect(() => {
    const frameId = pendingCreatedFrameIdRef.current;
    if (!frameId || !project) return;
    const slide = project.slideOrder.find((candidate) => candidate.frameId === frameId);
    if (!slide) return;
    pendingCreatedFrameIdRef.current = null;
    setActiveSlideId(slide.id);
  }, [project?.slideOrder]);

  const handleChange = useCallback<NonNullable<ExcalidrawProps["onChange"]>>((elements, appState, files) => {
    if (autosavePageExitRef.current) return;
    const isNativeImageExportOpen = appState.openDialog?.name === "imageExport";
    if (nativeImageExportOpenRef.current && !isNativeImageExportOpen) {
      if (restoreExportOptionsFocusRef.current) {
        restoreExportOptionsFocusRef.current = false;
        window.requestAnimationFrame(() => exportOptionsTriggerRef.current?.focus());
      }
      if (suspendDarkPdfDisplayRef.current) {
        suspendDarkPdfDisplayRef.current = false;
        setDarkPdfDisplayRevision((revision) => revision + 1);
      }
    }
    nativeImageExportOpenRef.current = isNativeImageExportOpen;
    const sidebarTab = appState.openSidebar?.name === "default" ? appState.openSidebar.tab : undefined;
    const redirectNativeSearchToProjectFind = sidebarTab === "search"
      && featurePreferencesRef.current.projectFind
      && !nativeCanvasSearchOpenRef.current;
    if (redirectNativeSearchToProjectFind) {
      api?.updateScene({
        appState: { openSidebar: { name: "default", tab: PROJECT_FIND_SIDEBAR_TAB } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setIsProjectFindOpen(true);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const input = editorHostRef.current?.querySelector<HTMLInputElement>(".project-find-query");
        input?.focus();
        input?.select();
      }));
    } else {
      if (sidebarTab !== "search") nativeCanvasSearchOpenRef.current = false;
      const projectFindOpen = sidebarTab === PROJECT_FIND_SIDEBAR_TAB;
      if (!projectFindOpen) pendingProjectSearchTargetRef.current = null;
      setIsProjectFindOpen(projectFindOpen);
    }
    if (sidebarTab === PERSONAL_LIBRARY_SIDEBAR_TAB || sidebarTab === SCREENSHOT_SIDEBAR_TAB) {
      lastLibraryTabRef.current = sidebarTab;
    }
    const isNativeLibraryOpen = appState.openSidebar?.name === "default"
      && (sidebarTab === PERSONAL_LIBRARY_SIDEBAR_TAB || sidebarTab === SCREENSHOT_SIDEBAR_TAB);
    if (libraryOpenRef.current !== isNativeLibraryOpen) {
      libraryOpenRef.current = isNativeLibraryOpen;
      setIsLibraryOpen(isNativeLibraryOpen);
    }
    const sizePositionEnabled = featurePreferencesRef.current.sizePosition;
    if (!sizePositionEnabled && appState.stats.open) {
      api?.updateScene({
        appState: { stats: { ...appState.stats, open: false } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    setIsSizePositionOpen(sizePositionEnabled && appState.stats.open);
    setZoom(Math.round(appState.zoom.value * 100));
    setStrokeWidth(appState.currentItemStrokeWidth);
    setAreSlideFramesVisible(appState.frameRendering.enabled);
    const nextProbabilitySelection = summarizeSelectedProbabilityPieces(elements, appState.selectedElementIds);
    setProbabilitySelection((current) => {
      if (!current && !nextProbabilitySelection) return current;
      if (current?.coins === nextProbabilitySelection?.coins && current?.dice === nextProbabilitySelection?.dice && current?.spinners === nextProbabilitySelection?.spinners) return current;
      return nextProbabilitySelection;
    });
    const containsBlockedContent = elements.some(
      (element) => isBlockedEmbeddedElementType(element.type) || !!element.link,
    );
    if (containsBlockedContent) {
      const safeElements = elements
        .filter((element) => !isBlockedEmbeddedElementType(element.type))
        .map((element) => element.link
          ? { ...element, link: null }
          : element) as readonly ExcalidrawElement[];
      api?.updateScene({ elements: safeElements, captureUpdate: CaptureUpdateAction.NEVER });
      api?.setToast({ message: "External links and web embeds are disabled in PatterDraw." });
      return;
    }
    if (switchingSceneRef.current) {
      const baseline = sceneHydrationBaselineRef.current;
      const sceneId = projectRef.current?.activeSceneId || activeSceneIdRef.current || null;
      const scene = sceneId
        ? (currentSceneRef.current?.id === sceneId
          ? currentSceneRef.current
          : projectRef.current?.scenes[sceneId])
        : null;
      if (
        baseline
        && baseline.generation === sceneHydrationGenerationRef.current
        && scene
        && scene.id === baseline.pending.sceneId
      ) {
        const normalized = normalizedHydrationChange(
          scene,
          elements,
          appState,
          files,
          transientDarkPdfFileIdsRef.current,
        );
        if (!hydrationChangesMatch(normalized, baseline.pending)) {
          // Keep only the newest callback. Synthetic hydration echoes match
          // the baseline and are ignored; a real edit is replayed after the
          // second hydration paint through queueScenePersistence().
          bufferedHydrationChangeRef.current = normalized;
        }
      }
      return;
    }
    const preferences = featurePreferencesRef.current;
    const applyingPreferences = applyingEditorPreferencesRef.current;
    const wrapperPreferenceUpdateSettled = !!applyingPreferences
      && appState.penMode === applyingPreferences.penOnly
      && appState.gridModeEnabled === applyingPreferences.showGrid
      && appState.objectsSnapModeEnabled === applyingPreferences.snapToObjects;
    if (wrapperPreferenceUpdateSettled) applyingEditorPreferencesRef.current = null;
    // Excalidraw can emit an older app-state snapshot between two rapid
    // settings changes. Ignore that stale snapshot until the wrapper-owned
    // update lands; native toolbar/shortcut changes still flow back once the
    // pending update has settled.
    if (!applyingPreferences || wrapperPreferenceUpdateSettled) {
      if (appState.penMode !== preferences.penOnly) {
        setFeaturePreference("penOnly", appState.penMode);
      }
      if (appState.gridModeEnabled !== preferences.showGrid) {
        setFeaturePreference("showGrid", appState.gridModeEnabled);
      }
      if (appState.objectsSnapModeEnabled !== preferences.snapToObjects) {
        setFeaturePreference("snapToObjects", appState.objectsSnapModeEnabled);
      }
    }
    const activeToolType = appState.activeTool.type;
    if (
      lassoActiveRef.current
      && !(activeToolType === "custom" && appState.activeTool.customType === CLASSROOM_LASSO_TOOL)
    ) {
      lassoActiveRef.current = false;
      setIsLassoActive(false);
    }
    if (
      bucketFillActiveRef.current
      && !(activeToolType === "custom" && appState.activeTool.customType === CLASSROOM_BUCKET_FILL_TOOL)
    ) {
      bucketFillActiveRef.current = false;
      setIsBucketFillActive(false);
      if (appState.activeTool.locked) {
        // Bucket Fill locks its custom tool to remain repeatable. Native tools
        // inherit that flag unless we explicitly release it at this boundary.
        api?.updateScene({
          appState: {
            activeTool: { ...appState.activeTool, locked: false },
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }
    }
    const previousToolType = activeToolTypeRef.current;
    if (activeToolType === "line" && previousToolType !== "line") {
      activeToolTypeRef.current = activeToolType;
      roughnessBeforeLineRef.current = appState.currentItemRoughness;
      if (appState.currentItemRoughness !== 0) {
        api?.updateScene({
          appState: { currentItemRoughness: 0 },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }
    } else if (activeToolType !== "line" && previousToolType === "line") {
      activeToolTypeRef.current = activeToolType;
      const restoredRoughness = roughnessBeforeLineRef.current;
      roughnessBeforeLineRef.current = null;
      if (restoredRoughness !== null && appState.currentItemRoughness !== restoredRoughness) {
        api?.updateScene({
          appState: { currentItemRoughness: restoredRoughness },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }
    } else {
      activeToolTypeRef.current = activeToolType;
    }
    const sceneId = activeSceneIdRef.current;
    if (!sceneId) return;
    const persistedScene = currentSceneRef.current?.id === sceneId
      ? currentSceneRef.current
      : null;
    const persistentBackgroundElements = persistedScene
      ? canonicalizePdfBackground(
        persistedScene,
        elements as unknown as readonly Record<string, unknown>[],
      ) as unknown as readonly ExcalidrawElement[]
      : elements;
    const persistentElements = detachElementsFromSlideFrames(persistentBackgroundElements);
    const displayFileId = persistedScene
      && !suspendDarkPdfDisplayRef.current
      ? darkPdfDisplayFileIdsRef.current.get(sceneId)
      : undefined;
    const editorBackgroundElements = persistedScene
      ? canonicalizePdfBackground(
        persistedScene,
        elements as unknown as readonly Record<string, unknown>[],
        displayFileId,
      ) as unknown as readonly ExcalidrawElement[]
      : elements;
    const editorElements = detachElementsFromSlideFrames(editorBackgroundElements);
    queueScenePersistence({
      sceneId,
      elements: persistentElements,
      appState,
      files: persistedScene
        ? persistentFilesForScene(
          persistedScene,
          files,
          transientDarkPdfFileIdsRef.current,
        )
        : files,
    });
    const elementGestureInProgress = !!(
      appState.newElement
      || appState.resizingElement
      || appState.isResizing
      || appState.isRotating
      || appState.multiElement
    );
    if (api && editorElements !== elements && !elementGestureInProgress) {
      window.cancelAnimationFrame(slideDetachmentFrameRef.current);
      slideDetachmentFrameRef.current = window.requestAnimationFrame(() => {
        if (switchingSceneRef.current || activeSceneIdRef.current !== sceneId) return;
        const liveElements = api.getSceneElements();
        const liveScene = currentSceneRef.current?.id === sceneId
          ? currentSceneRef.current
          : null;
        const liveDisplayFileId = liveScene
          && !suspendDarkPdfDisplayRef.current
          ? darkPdfDisplayFileIdsRef.current.get(sceneId)
          : undefined;
        const liveBackgroundSafeElements = liveScene
          ? canonicalizePdfBackground(
            liveScene,
            liveElements as unknown as readonly Record<string, unknown>[],
            liveDisplayFileId,
          ) as unknown as readonly ExcalidrawElement[]
          : liveElements;
        const liveDetachedElements = detachElementsFromSlideFrames(liveBackgroundSafeElements);
        if (liveDetachedElements === liveElements) return;
        api.updateScene({
          elements: liveDetachedElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      });
    }
  }, [api, queueScenePersistence, setFeaturePreference]);

  const toggleLibrary = useCallback(() => {
    if (!api) return;
    const nextOpen = api.toggleSidebar({ name: "default", tab: lastLibraryTabRef.current });
    libraryOpenRef.current = nextOpen;
    setIsLibraryOpen(nextOpen);
  }, [api]);

  const focusSidebarSearchInput = useCallback((selector: string) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const input = editorHostRef.current?.querySelector<HTMLInputElement>(selector);
      input?.focus();
      input?.select();
    }));
  }, []);

  const openProjectFind = useCallback(() => {
    if (!api || !featurePreferencesRef.current.projectFind) return;
    nativeCanvasSearchOpenRef.current = false;
    commitPendingScenePersistence();
    api.updateScene({
      appState: { openSidebar: { name: "default", tab: PROJECT_FIND_SIDEBAR_TAB } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setIsProjectFindOpen(true);
    focusSidebarSearchInput(".project-find-query");
  }, [api, commitPendingScenePersistence, focusSidebarSearchInput]);

  const toggleProjectFind = useCallback(() => {
    if (!api || !featurePreferencesRef.current.projectFind) return;
    const open = api.getAppState().openSidebar?.name === "default"
      && api.getAppState().openSidebar?.tab === PROJECT_FIND_SIDEBAR_TAB;
    if (open) {
      pendingProjectSearchTargetRef.current = null;
      api.updateScene({
        appState: { openSidebar: null },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setIsProjectFindOpen(false);
      window.requestAnimationFrame(() => projectFindTriggerRef.current?.focus());
      return;
    }
    openProjectFind();
  }, [api, openProjectFind]);

  const openCurrentCanvasSearch = useCallback(() => {
    if (!api || !featurePreferencesRef.current.projectFind) return;
    nativeCanvasSearchOpenRef.current = true;
    api.updateScene({
      appState: { openSidebar: { name: "default", tab: "search" } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setIsProjectFindOpen(false);
    focusSidebarSearchInput(".layer-ui__search input");
  }, [api, focusSidebarSearchInput]);

  const toggleSizePosition = useCallback(() => {
    if (!api) return;
    const appState = api.getAppState();
    const open = !appState.stats.open;
    api.updateScene({
      appState: {
        stats: {
          open,
          panels: appState.stats.panels || 3,
        },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setIsSizePositionOpen(open);
  }, [api]);

  useEffect(() => {
    if (!api || featurePreferences.sizePosition || !api.getAppState().stats.open) return;
    api.updateScene({
      appState: { stats: { ...api.getAppState().stats, open: false } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setIsSizePositionOpen(false);
  }, [api, featurePreferences.sizePosition]);

  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    const applyAccessibleLabel = () => {
      const panel = host.querySelector<HTMLElement>(".exc-stats");
      if (!panel) return;
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Size & Position");
      panel.querySelector(".title h2")?.setAttribute("aria-label", "Size & Position");
      const inputLabels: Record<string, string> = {
        X: "X position",
        Y: "Y position",
        W: "Width",
        H: "Height",
        A: "Angle",
      };
      for (const container of Array.from(panel.querySelectorAll<HTMLElement>(".drag-input-container"))) {
        const label = inputLabels[container.dataset.testid || ""];
        if (!label) continue;
        const input = container.querySelector<HTMLInputElement>("input.drag-input");
        input?.setAttribute("aria-label", label);
      }
    };
    applyAccessibleLabel();
    const observer = new MutationObserver(applyAccessibleLabel);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isSizePositionOpen]);

  useEffect(() => {
    if (!api || featurePreferences.projectFind) return;
    pendingProjectSearchTargetRef.current = null;
    const sidebar = api.getAppState().openSidebar;
    if (sidebar?.name !== "default" || (sidebar.tab !== PROJECT_FIND_SIDEBAR_TAB && sidebar.tab !== "search")) return;
    api.updateScene({
      appState: { openSidebar: null },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setIsProjectFindOpen(false);
  }, [api, featurePreferences.projectFind]);

  useEffect(() => {
    if (!projectFindShortcutBridge) return;
    projectFindShortcutBridge.enabled = !presentation && featurePreferences.projectFind;
    projectFindShortcutBridge.open = openProjectFind;
    return () => {
      if (projectFindShortcutBridge.open !== openProjectFind) return;
      projectFindShortcutBridge.enabled = false;
      projectFindShortcutBridge.open = null;
    };
  }, [featurePreferences.projectFind, openProjectFind, presentation]);

  useEffect(() => {
    if (featurePreferences.insert) return;
    setEquationEditor(null);
    setMermaidEditor(null);
  }, [featurePreferences.insert]);

  useEffect(() => {
    if (featurePreferences.mathTools) return;
    const lassoWasActive = lassoActiveRef.current;
    lassoActiveRef.current = false;
    preparedLassoSelectionRef.current = null;
    setIsLassoActive(false);
    setLassoGeometryFactory(null);
    setLassoInitialSelection(null);
    setIsMathToolsOpen(false);
    setIsGeoGonOpen(false);
    setMathToolEdit(null);
    setMathInteraction(null);
    setIsProbabilitySpinning(false);
    setSpinnerPointerAnimations([]);
    if (lassoWasActive) api?.setActiveTool({ type: "selection" });
  }, [api, featurePreferences.mathTools]);

  useEffect(() => {
    if (featurePreferences.library) return;
    setIsScreenshotCaptureActive(false);
    if (libraryOpenRef.current && api) {
      api.toggleSidebar({ name: "default", force: false });
    }
    libraryOpenRef.current = false;
    setIsLibraryOpen(false);
  }, [api, featurePreferences.library]);

  const handleLibraryChange = useCallback((libraryItems: LibraryItems) => {
    const safeLibraryItems = sanitizeLibraryItems(libraryItems);
    if (safeLibraryItems !== libraryItems && api) {
      api.setToast({ message: "Web embeds and external links were removed from the library." });
      void api.updateLibrary({
        libraryItems: (current) => sanitizeLibraryItems(current),
        merge: false,
      }).catch((error) => {
        setErrorMessage(`Personal library could not be cleaned: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    void saveLibraryItems(safeLibraryItems).catch((error) => {
      setErrorMessage(`Personal library could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [api]);

  const openLoadedProject = useCallback(async (
    loaded: LoadedClassroomProject,
    operation?: FileOpenOperation,
    forceOverwriteProtectedCopy = false,
  ): Promise<boolean> => {
    const isCurrentOperation = () => !operation || isCurrentFileOpenOperation(operation);
    if (!isCurrentOperation()) return false;
    finalizePendingPdfUndo();
    // A user can draw before the outgoing scene's two hydration paints have
    // completed. Fold that buffered edit into the old project before this
    // replacement starts, rather than clearing it below with the other
    // pending scene state.
    commitLiveScenePersistence(
      hydratedSceneIdRef.current || activeSceneIdRef.current || projectRef.current?.activeSceneId || "",
    );
    flushAutosave(true);
    pendingFrameIdRef.current = null;
    pendingProjectSearchTargetRef.current = null;
    pendingSlideFrameActionRef.current = null;
    autosaveStartupReadyRef.current = false;
    pendingScenePersistenceRef.current = null;
    if (scenePersistenceTimerRef.current !== null) {
      window.clearTimeout(scenePersistenceTimerRef.current);
      scenePersistenceTimerRef.current = null;
    }
    autosaveDirtyRef.current = false;
    autosaveUrgentRef.current = false;
    autosaveContentBytesRef.current = 0;
    autosaveLastDurationMsRef.current = 0;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await autosaveQueueRef.current.catch(() => undefined);
    if (!isCurrentOperation()) return false;
    autosaveSuspendedRef.current = true;
    autosaveSuspensionGenerationRef.current = operation?.generation ?? null;
    autosaveSavingRef.current = false;
    autosaveCoveredSnapshotRef.current = null;
    const startupProject = projectForBoardStartup(loaded.project);
    let replacementSaved = false;
    let replacementConflict: AutosaveConflictError | null = null;
    autosaveSavingRef.current = true;
    autosaveCoveredSnapshotRef.current = {
      project: startupProject,
      pdfBytes: loaded.pdfBytes,
    };
    const replacementSave = saveAutosave(
      startupProject,
      loaded.pdfBytes,
      {
        prepared: true,
        forceOverwrite: forceOverwriteProtectedCopy,
        replacePdfBlobs: true,
        signal: operation?.signal,
      },
    ).then((contentSize) => {
      autosaveContentBytesRef.current = contentSize.totalBytes;
    });
    autosaveQueueRef.current = replacementSave;
    try {
      await replacementSave;
      if (isCurrentOperation()) replacementSaved = true;
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        if (error instanceof AutosaveConflictError) {
          replacementConflict = error;
          setErrorMessage(null);
        } else {
          setErrorMessage(autosaveFailureMessage(error));
        }
      }
    }
    if (autosaveQueueRef.current === replacementSave) autosaveSavingRef.current = false;
    if (!isCurrentOperation()) return false;
    if (!replacementSaved) autosaveCoveredSnapshotRef.current = null;
    pendingScenePersistenceRef.current = null;
    if (scenePersistenceTimerRef.current !== null) {
      window.clearTimeout(scenePersistenceTimerRef.current);
      scenePersistenceTimerRef.current = null;
    }
    // Do not enter the hydration-suppression window until this operation is
    // still current and ready to commit. A superseded archive must not leave
    // the previous editor stuck with switchingSceneRef=true.
    beginSceneHydration();
    pdfBytesRef.current = loaded.pdfBytes;
    projectRef.current = startupProject;
    activeSceneIdRef.current = startupProject.activeSceneId;
    autosaveSnapshotRef.current = {
      project: startupProject,
      pdfBytes: loaded.pdfBytes,
    };
    autosaveExitFlushSnapshotRef.current = null;
    autosaveExitFlushQueuedRef.current = false;
    autosaveDirtyRef.current = !replacementSaved;
    autosaveLastQueuedAtRef.current = replacementSaved ? Date.now() : 0;
    skipNextAutosaveEffectRef.current = true;
    setPdfBytes(loaded.pdfBytes);
    const framesVisible = loaded.project.slideFramesVisible !== false;
    slideFramesVisibleRef.current = framesVisible;
    setAreSlideFramesVisible(framesVisible);
    // Project archives are allowed to reuse the same project and scene IDs.
    // Force the editor hydration effect to run for a full replacement even
    // when its identity fields are unchanged.
    setProjectHydrationRevision((revision) => revision + 1);
    setProject(startupProject);
    setActiveSlideId(null);
    setWorkspaceMode("board");
    pendingCreatedFrameIdRef.current = null;
    pendingSlideFrameActionRef.current = null;
    setEquationEditor(null);
    setMermaidEditor(null);
    setMathToolEdit(null);
    setIsMathToolsOpen(false);
    setSaveStatus(replacementSaved ? "saving" : "error");
    if (replacementConflict) {
      autosaveSuspendedRef.current = true;
      autosaveSuspensionGenerationRef.current = null;
      setAutosaveRecoveryKind("conflict");
      setAutosaveRecoveryDetail(replacementConflict.message);
    } else if (forceOverwriteProtectedCopy && !replacementSaved) {
      // The protected copy was not replaced. Keep recovery mode active while
      // showing the newly opened board so a quota/storage failure cannot turn
      // into a silent overwrite on the next edit.
      autosaveSuspendedRef.current = true;
      autosaveSuspensionGenerationRef.current = null;
    } else {
      autosaveSuspendedRef.current = false;
      autosaveSuspensionGenerationRef.current = null;
      setAutosaveRecoveryKind(null);
      setAutosaveRecoveryDetail(null);
    }
  return true;
  }, [
    beginSceneHydration,
    commitLiveScenePersistence,
    commitPendingScenePersistence,
    finalizePendingPdfUndo,
    flushAutosave,
    isCurrentFileOpenOperation,
  ]);

  const handleFile = useCallback(async (file: File) => {
    const operation = beginFileOpenOperation();
    const isCurrentOperation = () => isCurrentFileOpenOperation(operation);
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
      if (inputRef.current) inputRef.current.value = "";
    };
    setBusyCanCancel(true);
    setErrorMessage(null);
    setBusyMessage(`Opening ${file.name}…`);
    try {
      const lowerName = file.name.toLowerCase();
      const knownNonPdfFile = lowerName.endsWith(".patterdraw")
        || lowerName.endsWith(".canvasclassroom")
        || lowerName.endsWith(".excalidraw")
        || file.type === "application/vnd.excalidraw+json";
      let isPdfFile = file.type === "application/pdf" || lowerName.endsWith(".pdf");
      if (!isPdfFile && !knownNonPdfFile) {
        const { hasPdfByteSignature } = await import("./lib/pdf/import-pdf");
        const headerBytes = new Uint8Array(await file.slice(0, 1_029).arrayBuffer());
        if (!isCurrentOperation()) return;
        isPdfFile = hasPdfByteSignature(headerBytes);
      }
      const replaceProtectedAutosave = autosaveRecoveryDetail !== null;
      if (
        replaceProtectedAutosave
        && !window.confirm(
          autosaveRecoveryKind === "conflict"
            ? `Open ${file.name} and replace the newer autosave saved by another tab? Download this tab's board first if you want a separate backup.`
            : `Open ${file.name} and replace the protected unreadable autosave? Download the temporary board first if you want a separate backup.`,
        )
      ) return;
      if (!isPdfFile && file.size > MAX_PROJECT_BYTES) {
        throw new Error("The selected project is too large to open safely.");
      }
      if (isPdfFile) {
        const preflightProject = commitLiveScenePersistence(
          hydratedSceneIdRef.current
            || activeSceneIdRef.current
            || projectRef.current?.activeSceneId
            || "",
        ) || createBlankProject();
        assertProjectCanAcceptPdfPages(preflightProject, 1);
        const maxPages = remainingProjectSceneCapacity(preflightProject);
        const preflightSize = assertProjectCanAcceptAdditionalBytes(
          preflightProject,
          pdfBytesRef.current,
          file.size,
        );
        const maxEncodedBytesPerDocument = Math.max(
          0,
          Math.floor((MAX_PROJECT_BYTES - preflightSize.totalBytes - file.size) * 3 / 4),
        );
        const { importPdf } = await import("./lib/pdf/import-pdf");
        const imported = await importPdf(file, {
          maxEncodedBytesPerDocument,
          maxPages,
          onProgress: (progress) => {
            if (isCurrentOperation()) setBusyMessage(pdfOperationProgressMessage(progress));
          },
          signal: operation.signal,
        });
        if (!isCurrentOperation()) return;
        const scenes = Object.fromEntries(imported.scenes.map((scene) => [scene.id, scene]));
        const importedPageIds = imported.scenes.map((scene) => scene.id);
        // Capture any last live annotation before the imported PDF becomes
        // the active scene. The normal debounce may not have reached the
        // pending ref yet when a large PDF finishes parsing.
        const base = commitLiveScenePersistence(
          hydratedSceneIdRef.current
            || activeSceneIdRef.current
            || projectRef.current?.activeSceneId
            || "",
        ) || createBlankProject();
        const nextPdfBytes = {
          ...pdfBytesRef.current,
          [imported.source.id]: imported.bytes,
        };
        const nextProject: ClassroomProject = {
          ...base,
          updatedAt: nowIso(),
          activeSceneId: imported.scenes[0].id,
          scenes: { ...base.scenes, ...scenes },
          pdfPageOrder: [...reconcilePdfPageOrder(base), ...importedPageIds],
          pdfDocuments: { ...base.pdfDocuments, [imported.source.id]: imported.source },
        };
        assertProjectFitsContentBudget(nextProject, nextPdfBytes);
        assertPdfAdditionPreservesPendingUndo(
          nextProject,
          nextPdfBytes,
          pendingPdfUndoRef.current,
        );
        if (replaceProtectedAutosave) {
          setBusyMessage(`Saving ${file.name} locally…`);
          const contentSize = await saveAutosave(nextProject, nextPdfBytes, {
            forceOverwrite: true,
            prepared: true,
            replacePdfBlobs: true,
            signal: operation.signal,
          });
          if (!isCurrentOperation()) return;
          autosaveContentBytesRef.current = contentSize.totalBytes;
          autosaveCoveredSnapshotRef.current = {
            project: nextProject,
            pdfBytes: nextPdfBytes,
          };
          autosaveDirtyRef.current = false;
          autosaveLastQueuedAtRef.current = Date.now();
          skipNextAutosaveEffectRef.current = true;
          setErrorMessage(null);
          setSaveStatus("saved");
        }
        beginSceneHydration();
        pendingFrameIdRef.current = null;
        pendingProjectSearchTargetRef.current = null;
        pendingCreatedFrameIdRef.current = null;
        pendingSlideFrameActionRef.current = null;
        autosaveSuspendedRef.current = false;
        autosaveSuspensionGenerationRef.current = null;
        setAutosaveRecoveryKind(null);
        setAutosaveRecoveryDetail(null);
        pdfBytesRef.current = nextPdfBytes;
        projectRef.current = nextProject;
        activeSceneIdRef.current = nextProject.activeSceneId;
        setPdfBytes(nextPdfBytes);
        setProject(nextProject);
        setWorkspaceMode("pdf");
        setEquationEditor(null);
        setMermaidEditor(null);
      } else if (
        lowerName.endsWith(".patterdraw")
        || lowerName.endsWith(".canvasclassroom")
      ) {
        const bytes = await readBoundedProjectFileBytes(file);
        if (!isCurrentOperation()) return;
        const loaded = await decodeProjectFile(
          bytes,
          MAX_PROJECT_BYTES,
          { signal: operation.signal },
        );
        if (!isCurrentOperation()) return;
        setBusyMessage(`Saving ${file.name} locally…`);
        await openLoadedProject(loaded, operation, replaceProtectedAutosave);
      } else if (
        lowerName.endsWith(".excalidraw")
        || file.type === "application/vnd.excalidraw+json"
      ) {
        assertImportBlobBytes(file, MAX_NATIVE_SCENE_BLOB_BYTES, "Excalidraw file");
        const text = await file.text();
        if (!isCurrentOperation()) return;
        const loaded = {
          project: nativeExcalidrawProject(text),
          pdfBytes: {},
        };
        // Native Excalidraw files bypass decodeProjectFile(), so run the same
        // async raster/PDF safety gate before autosave or editor hydration.
        // Tie it to this file operation so a superseded open cannot continue
        // decoding an oversized image after a newer intent wins.
        await assertLoadedProjectRasterSafety(loaded, { signal: operation.signal });
        if (!isCurrentOperation()) return;
        setBusyMessage(`Saving ${file.name} locally…`);
        await openLoadedProject(loaded, operation, replaceProtectedAutosave);
      } else {
        throw new Error("Open a .patterdraw, legacy .canvasclassroom, .excalidraw, or PDF file.");
      }
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (fileOpenGenerationRef.current === operation.generation) {
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    }
  }, [
    autosaveRecoveryDetail,
    autosaveRecoveryKind,
    beginFileOpenOperation,
    beginSceneHydration,
    commitLiveScenePersistence,
    isCurrentFileOpenOperation,
    openLoadedProject,
  ]);

  const saveProjectFile = useCallback(async () => {
    const currentProject = commitCurrentLiveScenePersistence();
    if (!currentProject) return;
    const exportPdfBytes = clonePdfBytes(pdfBytesRef.current);
    setBusyMessage("Preparing project backup…");
    try {
      await afterNextPaint();
      const bytes = await encodePreparedProjectFile(currentProject, exportPdfBytes);
      downloadBlob(
        new Blob([bytesForBlob(bytes)], { type: "application/vnd.patterdraw+zip" }),
        `${safeFileStem(currentProject.title)}.patterdraw`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [commitCurrentLiveScenePersistence]);

  const resumeAutosaveWithCurrentBoard = useCallback(async () => {
    const currentProject = commitCurrentLiveScenePersistence();
    if (!currentProject || !autosaveRecoveryDetail) return;
    if (!window.confirm(
      autosaveRecoveryKind === "conflict"
        ? "Replace the newer autosave saved by another tab with this tab's board and resume autosave? Download this board first if you want a separate backup."
        : "Replace the unreadable stored autosave with this temporary board and resume autosave? Download this board first if you want a separate backup.",
    )) return;

    const snapshot = {
      project: currentProject,
      pdfBytes: pdfBytesRef.current,
    };
    autosaveSnapshotRef.current = snapshot;
    autosaveExitFlushSnapshotRef.current = null;
    autosaveExitFlushQueuedRef.current = false;
    setBusyMessage(
      autosaveRecoveryKind === "conflict"
        ? "Replacing the newer autosave…"
        : "Replacing the unreadable autosave…",
    );
    setSaveStatus("saving");
    let followupNeeded = false;
    try {
      await autosaveQueueRef.current.catch(() => undefined);
      autosaveSavingRef.current = true;
      autosaveCoveredSnapshotRef.current = snapshot;
      const replacementSave = saveAutosave(
        snapshot.project,
        snapshot.pdfBytes,
        { forceOverwrite: true, prepared: true, replacePdfBlobs: true },
      ).then((contentSize) => {
        autosaveContentBytesRef.current = contentSize.totalBytes;
      });
      autosaveQueueRef.current = replacementSave;
      await replacementSave;
      const latestSnapshot = autosaveSnapshotRef.current;
      const newerSnapshotPending = latestSnapshot?.project !== snapshot.project
        || latestSnapshot?.pdfBytes !== snapshot.pdfBytes;
      if (newerSnapshotPending) {
        autosaveCoveredSnapshotRef.current = null;
        autosaveExitFlushSnapshotRef.current = null;
        autosaveExitFlushQueuedRef.current = false;
      }
      autosaveDirtyRef.current = newerSnapshotPending;
      followupNeeded = newerSnapshotPending;
      autosaveUrgentRef.current = false;
      autosaveLastQueuedAtRef.current = Date.now();
      autosaveSuspendedRef.current = false;
      autosaveSuspensionGenerationRef.current = null;
      setAutosaveRecoveryKind(null);
      setAutosaveRecoveryDetail(null);
      setErrorMessage(null);
      setSaveStatus(newerSnapshotPending ? "saving" : "saved");
    } catch (error) {
      // Keep recovery mode active if the explicit replacement cannot be
      // committed atomically. The unreadable stored copy remains untouched.
      autosaveCoveredSnapshotRef.current = null;
      autosaveExitFlushSnapshotRef.current = null;
      autosaveExitFlushQueuedRef.current = false;
      autosaveDirtyRef.current = true;
      setSaveStatus("error");
      setErrorMessage(autosaveFailureMessage(error));
    } finally {
      autosaveSavingRef.current = false;
      setBusyMessage(null);
    }
    if (followupNeeded) flushAutosave(true);
  }, [autosaveRecoveryDetail, autosaveRecoveryKind, commitCurrentLiveScenePersistence, flushAutosave]);

  const executePdfExport = useCallback(async (
    currentProject: ClassroomProject,
    exportPdfBytes: Record<PdfDocumentId, Uint8Array>,
    kind: "slides" | PdfExportMode,
    annotationMode: "hybrid" | "visual" = "hybrid",
  ) => {
    pdfExportAbortControllerRef.current?.abort();
    const controller = new AbortController();
    pdfExportAbortControllerRef.current = controller;
    busyCancelRef.current = () => {
      if (pdfExportAbortControllerRef.current !== controller) return;
      controller.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
    };
    setBusyCanCancel(true);
    setExportOpen(false);
    setBusyMessage(kind === "slides" ? "Exporting slides…" : "Exporting annotated PDF…");
    try {
      await afterNextPaint();
      const {
        exportAnnotatedPdf,
        exportSlidesPdf,
        PdfHybridFallbackRequiredError,
      } = await import("./lib/pdf/export-pdf");
      const exportOptions = {
        signal: controller.signal,
        onProgress: (progress: PdfOperationProgress) => {
          if (!controller.signal.aborted && pdfExportAbortControllerRef.current === controller) {
            setBusyMessage(pdfOperationProgressMessage(progress));
          }
        },
      };
      let blob: Blob;
      if (kind === "slides") {
        blob = await exportSlidesPdf(currentProject, exportOptions);
      } else {
        try {
          blob = await exportAnnotatedPdf(currentProject, exportPdfBytes, kind, {
            ...exportOptions,
            annotationMode,
          });
        } catch (error) {
          if (
            annotationMode === "hybrid"
            && error instanceof PdfHybridFallbackRequiredError
          ) {
            if (pdfPreferencesRef.current.offerVisualPdfFallback) {
              setPendingVisualPdfFallback({
                project: currentProject,
                pdfBytes: exportPdfBytes,
                mode: kind,
              });
              return;
            }
            throw new Error(
              "Higher-fidelity PDF export could not safely preserve this annotation stack. Visual PDF fallback offers are turned off in PDF settings.",
              { cause: error },
            );
          }
          throw error;
        }
      }
      if (controller.signal.aborted || pdfExportAbortControllerRef.current !== controller) return;
      const suffix = kind === "slides" ? "slides" : kind === "expand" ? "annotated-expanded" : "annotated-openboard-fit";
      downloadBlob(blob, `${safeFileStem(currentProject.title)}-${suffix}.pdf`);
    } catch (error) {
      if (!isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (pdfExportAbortControllerRef.current === controller) {
        pdfExportAbortControllerRef.current = null;
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
      }
    }
  }, []);

  const runPdfExport = useCallback(async (kind: "slides" | PdfExportMode) => {
    const currentProject = commitCurrentLiveScenePersistence();
    if (!currentProject) return;
    setPendingVisualPdfFallback(null);
    const exportPdfBytes = clonePdfBytes(pdfBytesRef.current);
    await executePdfExport(currentProject, exportPdfBytes, kind);
  }, [commitCurrentLiveScenePersistence, executePdfExport]);

  const cancelVisualPdfFallback = useCallback(() => {
    setPendingVisualPdfFallback(null);
  }, []);

  const confirmVisualPdfFallback = useCallback(() => {
    const pending = pendingVisualPdfFallback;
    if (!pending) return;
    setPendingVisualPdfFallback(null);
    void executePdfExport(
      pending.project,
      pending.pdfBytes,
      pending.mode,
      "visual",
    );
  }, [executePdfExport, pendingVisualPdfFallback]);

  const runPptxExport = useCallback(async () => {
    const currentProject = commitCurrentLiveScenePersistence();
    if (!currentProject) return;
    setExportOpen(false);
    setBusyMessage("Exporting PowerPoint…");
    try {
      await afterNextPaint();
      const { exportSlidesPptx } = await import("./lib/export-pptx");
      const blob = await exportSlidesPptx(currentProject);
      downloadBlob(blob, `${safeFileStem(currentProject.title)}-slides.pptx`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [commitCurrentLiveScenePersistence]);

  const runFullBoardExport = useCallback(async () => {
    if (!api || !project) return;
    setExportOpen(false);
    setBusyMessage("Exporting the full board…");
    try {
      await waitForSceneHydrationToSettle(() => switchingSceneRef.current);
      await afterNextPaint();
      const scene = currentSceneRef.current;
      const liveElements = api.getSceneElements();
      const elements = scene
        ? canonicalizePdfBackground(
          scene,
          liveElements as unknown as readonly Record<string, unknown>[],
        ) as unknown as readonly ExcalidrawElement[]
        : liveElements;
      const files = scene
        ? cloneBinaryFiles(persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current))
        : cloneBinaryFiles(api.getFiles());
      const { blob, scale } = await exportFullBoardPng(api, { elements, files });
      downloadBlob(blob, `${safeFileStem(project.title)}-full-board.png`);
      api.setToast({
        message: scale < 1
          ? "Full board downloaded. A very large canvas was scaled to fit the safe image limit."
          : "Full board downloaded as a shareable PNG.",
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [api, project]);

  const openNativeImageExport = useCallback(async () => {
    if (!api || !project) return;
    setExportOpen(false);
    setBusyMessage("Preparing image export…");
    let suspendedPdfPreview = false;
    const showDialog = () => {
      nativeImageExportOpenRef.current = true;
      restoreExportOptionsFocusRef.current = true;
      api.updateScene({
        appState: {
          name: project.title,
          exportWithDarkMode: false,
          openDialog: { name: "imageExport" },
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    try {
      await waitForSceneHydrationToSettle(() => switchingSceneRef.current);
      if (api.getSceneElements().length === 0) return;
      const scene = currentSceneRef.current;
      if (scene?.pdfPage) {
        suspendedPdfPreview = true;
        suspendDarkPdfDisplayRef.current = true;
        darkPdfPreviewGenerationRef.current += 1;
        for (const controller of darkPdfRenderControllersRef.current) controller.abort();
        darkPdfRenderControllersRef.current.clear();
        // Retire the full-page display raster while the background still
        // references it so Excalidraw invalidates the decoded-image cache. The
        // native export dialog deliberately renders the canonical source page.
        retireActiveDarkPdfDisplayFile();
        darkPdfPreviewCacheRef.current.clear();
        darkPdfDisplayFileIdsRef.current.clear();
        const liveElements = api.getSceneElements();
        const lightElements = canonicalizePdfBackground(
          scene,
          liveElements as unknown as readonly Record<string, unknown>[],
        ) as unknown as readonly ExcalidrawElement[];
        if (lightElements !== liveElements) {
          api.updateScene({
            elements: lightElements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
        await afterNextPaint();
      }
      showDialog();
    } catch (error) {
      if (suspendedPdfPreview && !nativeImageExportOpenRef.current) {
        suspendDarkPdfDisplayRef.current = false;
        setDarkPdfDisplayRevision((revision) => revision + 1);
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [api, project, retireActiveDarkPdfDisplayFile]);

  const openEquationEditor = useCallback(() => {
    if (!api) return;
    const selectedIds = api.getAppState().selectedElementIds;
    const selectedEquation = api.getSceneElements().find(
      (element) => selectedIds[element.id] && latexSourceForElement(element),
    );
    setEquationEditor({
      targetId: selectedEquation?.id || null,
      initialSource: latexSourceForElement(selectedEquation) || "",
    });
    setMermaidEditor(null);
  }, [api]);

  const openMathTools = useCallback(() => {
    const selectedIds = api?.getAppState().selectedElementIds || {};
    const selectedFunctionPlot = api?.getSceneElements().find((element) => {
      if (!selectedIds[element.id]) return false;
      const metadata = sanitizeClassroomMathToolMetadata(
        (element.customData as { classroomMathTool?: unknown } | undefined)?.classroomMathTool,
      );
      return metadata?.kind === "function-plot";
    });
    const metadata = selectedFunctionPlot
      ? sanitizeClassroomMathToolMetadata(
        (selectedFunctionPlot.customData as { classroomMathTool?: unknown } | undefined)?.classroomMathTool,
      )
      : null;
    setMathToolEdit(selectedFunctionPlot && metadata?.kind === "function-plot" ? {
      targetId: selectedFunctionPlot.id,
      initialConfiguration: {
        kind: "function-plot",
        expression: metadata.expression,
        xMin: metadata.xMin,
        xMax: metadata.xMax,
        yMin: metadata.yMin,
        yMax: metadata.yMax,
        showGrid: metadata.showGrid,
        showAxes: metadata.showAxes,
      },
    } : null);
    setExportOpen(false);
    setEquationEditor(null);
    setMermaidEditor(null);
    setMathInteraction(null);
    setIsMathToolsOpen(true);
  }, [api]);

  const closeMathTools = useCallback(() => {
    focusAfterMathToolsRef.current = "trigger";
    setIsMathToolsOpen(false);
    setMathToolEdit(null);
  }, []);

  const openGeoGon = useCallback(() => {
    focusAfterMathToolsRef.current = null;
    setMathToolEdit(null);
    setIsMathToolsOpen(false);
    setIsGeoGonOpen(true);
  }, []);

  const closeGeoGon = useCallback(() => {
    focusAfterMathToolsRef.current = "trigger";
    setIsGeoGonOpen(false);
  }, []);

  const prepareLasso = useCallback(() => {
    if (api) preparedLassoSelectionRef.current = lassoSelectionSnapshot(api.getAppState());
  }, [api]);

  const startLasso = useCallback(async () => {
    if (!api) return;
    const initialSelection = preparedLassoSelectionRef.current || lassoSelectionSnapshot(api.getAppState());
    preparedLassoSelectionRef.current = null;
    try {
      const { createLassoGeometrySnapshot } = await import("./lib/lasso/stable-element-adapter");
      setLassoGeometryFactory(() => createLassoGeometrySnapshot);
      setLassoInitialSelection(initialSelection);
      setMathInteraction(null);
      setIsMathToolsOpen(false);
      setMathToolEdit(null);
      focusAfterMathToolsRef.current = null;
      lassoActiveRef.current = true;
      setIsLassoActive(true);
      api.setActiveTool({ type: "custom", customType: CLASSROOM_LASSO_TOOL });
    } catch (error) {
      console.error("Lasso selection could not be started.", error);
      api.setToast({ message: "Lasso selection could not be started." });
    }
  }, [api]);

  const finishLasso = useCallback(() => {
    lassoActiveRef.current = false;
    setIsLassoActive(false);
  }, []);

  const startBucketFill = useCallback(() => {
    if (!api) return;
    lassoActiveRef.current = false;
    setIsLassoActive(false);
    setMathInteraction(null);
    setIsMathToolsOpen(false);
    setMathToolEdit(null);
    bucketFillActiveRef.current = true;
    setIsBucketFillActive(true);
    // Bucket fill is a repeatable mode. Lock the custom tool so Excalidraw's
    // shared pointer lifecycle (including pinch gestures) does not reset it to
    // selection after every pointer-up.
    api.setActiveTool({ type: "custom", customType: CLASSROOM_BUCKET_FILL_TOOL, locked: true });
    // The upstream planar-region implementation is intentionally code-split.
    void import("./lib/bucket-fill/apply");
  }, [api]);

  const finishBucketFill = useCallback(() => {
    bucketFillActiveRef.current = false;
    setIsBucketFillActive(false);
  }, []);

  const fillBucketRegion = useCallback(async (point: { x: number; y: number }) => {
    if (!api || !projectRef.current || switchingSceneRef.current) return;
    const operation = {
      projectId: projectRef.current.id,
      sceneId: projectRef.current.activeSceneId,
      hydrationGeneration: sceneHydrationGenerationRef.current,
    };
    try {
      const { applyBucketFill } = await import("./lib/bucket-fill/apply");
      const currentProject = projectRef.current;
      if (
        !bucketFillActiveRef.current
        || !currentProject
        || !sceneOperationIsCurrent(operation, {
          projectId: currentProject.id,
          sceneId: currentProject.activeSceneId,
          hydrationGeneration: sceneHydrationGenerationRef.current,
          cancelled: switchingSceneRef.current,
        })
      ) return;
      const result = applyBucketFill(api, point);
      if (result.status !== "failed") return;
      if (result.reason === "too_complex") {
        api.setToast({ message: "This region is too complex to fill." });
      } else if (result.reason !== "no_owner") {
        api.setToast({ message: "No closed region was found here." });
      }
    } catch (error) {
      console.error("Bucket fill could not be applied.", error);
      api.setToast({ message: "Bucket fill could not be applied." });
    }
  }, [api]);

  const startMathInteraction = useCallback((kind: MathInteractionKind) => {
    const sourceElementIds = kind === "transformation" && api
      ? api.getSceneElements().filter((element) => api.getAppState().selectedElementIds[element.id] && ["diamond", "ellipse", "image", "rectangle"].includes(element.type)).map((element) => element.id)
      : [];
    focusAfterMathToolsRef.current = null;
    setIsMathToolsOpen(false);
    if (kind === "transformation" && !sourceElementIds.length) {
      setErrorMessage("Select at least one rectangle, diamond, ellipse, or image before opening the transformation tool.");
      return;
    }
    setMathInteraction({
      kind,
      points: [],
      sourceElementIds,
      compassOptions: { fullCircle: true, arcExtentDegrees: 180, direction: "clockwise", centerMark: true },
      angleOptions: { reflex: false, precision: 1 },
      transformationOptions: { transformationType: "translate", translateX: 100, translateY: 0, angleDegrees: 90, scaleFactor: 2, mirrorLineAngleDegrees: 45 },
    });
    api?.setActiveTool({ type: "selection" });
  }, [api]);

  const captureMathInteractionPoint = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!mathInteraction || !api || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".math-interaction-panel")) return;
    if (mathInteraction.kind === "transformation") return;
    const requiredPoints = mathInteraction.kind === "compass" ? 2 : 3;
    if (mathInteraction.points.length >= requiredPoints) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = editorHostRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const scene = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, api.getAppState());
    const point: CapturedMathPoint = {
      scene,
      viewport: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    };
    setMathInteraction((current) => current ? { ...current, points: [...current.points, point] } : current);
  }, [api, mathInteraction]);

  const insertMathTool = useCallback(async (requestedTool: GeneratedMathToolInsertion) => {
    if (!api) return;
    const operation = beginSceneOperation();
    if (!operation) return;
    let generatedTool = requestedTool;
    let renderingUnitCircle = false;
    try {
      if (!("pieces" in generatedTool) && generatedTool.metadata.kind === "unit-circle") {
        renderingUnitCircle = true;
        sceneOperationBusyRef.current.add(operation);
        setBusyMessage("Rendering unit-circle notation…");
        const rendered = await createUnitCircleMathJaxAsset(
          generatedTool.metadata.labelMode,
          generatedTool.metadata.showCoordinates,
        );
        if (!isCurrentSceneOperation(operation)) return;
        generatedTool = { ...generatedTool, asset: rendered.asset };
      }
      if (!isCurrentSceneOperation(operation)) return;
      if (mathToolEdit && !("pieces" in generatedTool) && generatedTool.metadata.kind === "function-plot") {
        const target = api.getSceneElements().find((element) => element.id === mathToolEdit.targetId);
        if (!target || target.type !== "image") throw new Error("The selected function plot is no longer available.");
        const fileId = createLocalId() as FileId;
        api.addFiles([{
          id: fileId,
          mimeType: "image/svg+xml",
          dataURL: generatedTool.asset.dataUrl as DataURL,
          created: Date.now(),
        }]);
        const updated = newElementWith(target, {
          fileId,
          status: "saved",
          customData: {
            ...(target.customData || {}),
            classroomMathTool: generatedTool.metadata,
          },
        });
        api.updateScene({
          elements: api.getSceneElements().map((element) => element.id === target.id ? updated : element),
          appState: { selectedElementIds: { [target.id]: true } },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        focusAfterMathToolsRef.current = "editor";
        setMathToolEdit(null);
        setIsMathToolsOpen(false);
        api.setToast({ message: "Function plot updated." });
        return;
      }
      const pieces = "pieces" in generatedTool
        ? generatedTool.pieces
        : [{ asset: generatedTool.asset, metadata: generatedTool.metadata, offsetX: 0, offsetY: 0 }];
      if (!pieces.length || pieces.length > 100) throw new Error("Math tool insertion has an invalid piece count.");
      if (!isCurrentSceneOperation(operation)) return;
      const appState = api.getAppState();
      const center = viewportCoordsToSceneCoords(
        {
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        },
        appState,
      );
      const minX = Math.min(...pieces.map((piece) => piece.offsetX));
      const minY = Math.min(...pieces.map((piece) => piece.offsetY));
      const maxX = Math.max(...pieces.map((piece) => piece.offsetX + piece.asset.width));
      const maxY = Math.max(...pieces.map((piece) => piece.offsetY + piece.asset.height));
      const scenePosition = "pieces" in generatedTool ? undefined : generatedTool.scenePosition;
      const originX = scenePosition ? scenePosition.x : center.x - (minX + maxX) / 2;
      const originY = scenePosition ? scenePosition.y : center.y - (minY + maxY) / 2;
      const fileIdByDataUrl = new Map<string, FileId>();
      const files: BinaryFileData[] = [];
      const insertedElements = pieces.map((piece) => {
        let fileId = fileIdByDataUrl.get(piece.asset.dataUrl);
        if (!fileId) {
          fileId = createLocalId() as FileId;
          fileIdByDataUrl.set(piece.asset.dataUrl, fileId);
          files.push({
            id: fileId,
            mimeType: "image/svg+xml",
            dataURL: piece.asset.dataUrl as DataURL,
            created: Date.now(),
          });
        }
        const [element] = convertToExcalidrawElements(
          [{
            id: createLocalId(),
            type: "image",
            x: originX + piece.offsetX,
            y: originY + piece.offsetY,
            width: piece.asset.width,
            height: piece.asset.height,
            fileId,
            status: "saved",
            strokeColor: "transparent",
            backgroundColor: "transparent",
            customData: {
              classroomMathTool: {
                ...piece.metadata,
              },
            },
          }],
          { regenerateIds: false },
        );
        return element;
      });
      api.addFiles(files);
      api.setActiveTool({ type: "selection" });
      api.updateScene({
        elements: [...api.getSceneElements(), ...insertedElements],
        appState: { selectedElementIds: Object.fromEntries(insertedElements.map((element) => [element.id, true])) },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      focusAfterMathToolsRef.current = "editor";
      setMathToolEdit(null);
      setIsMathToolsOpen(false);
      api.setToast({ message: generatedTool.toastMessage });
    } catch (error) {
      if (isCurrentSceneOperation(operation) && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (renderingUnitCircle && sceneOperationBusyRef.current.delete(operation)) {
        if (sceneOperationBusyRef.current.size === 0) setBusyMessage(null);
      }
      finishSceneOperation(operation);
    }
  }, [api, beginSceneOperation, finishSceneOperation, isCurrentSceneOperation, mathToolEdit]);

  const randomizeSelectedProbabilityPieces = useCallback(async () => {
    if (!api || probabilityRandomizingRef.current) return;
    const operation = beginSceneOperation();
    if (!operation) return;
    probabilityOperationRef.current = operation;
    probabilityRandomizingRef.current = true;
    try {
      const appState = api.getAppState();
      const selectedElementIds = appState.selectedElementIds;
      const selectedPieces = api.getSceneElements().flatMap((element) => {
        if (element.type !== "image" || element.isDeleted || !selectedElementIds[element.id]) return [];
        const metadata = sanitizeClassroomMathToolMetadata(
          (element.customData as { classroomMathTool?: unknown } | undefined)?.classroomMathTool,
        );
        if (metadata?.kind !== "probability-piece" || (metadata.componentType !== "die" && metadata.componentType !== "coin" && metadata.componentType !== "spinner")) return [];
        const randomized = randomizeProbabilityPiece(metadata);
        const fileId = createLocalId() as FileId;
        return [{
          angle: element.angle,
          componentType: metadata.componentType,
          currentValue: metadata.faceOrValue,
          dataURL: randomized.asset.dataUrl as DataURL,
          fileId,
          height: element.height,
          id: element.id,
          metadata: randomized.metadata,
          originalAngle: element.angle,
          scaleX: element.scale[0],
          scaleY: element.scale[1],
          value: randomized.metadata.faceOrValue,
          width: element.width,
          x: element.x,
          y: element.y,
        }];
      });
      if (!selectedPieces.length) throw new Error("Select at least one die, coin, or spinner to randomize.");

      const spinners = selectedPieces.filter((piece) => piece.componentType === "spinner");
      const reducedMotion = prefersReducedMotion();
      if (spinners.length && !reducedMotion) {
        const hostBounds = editorHostRef.current?.getBoundingClientRect();
        if (!hostBounds) throw new Error("The spinner animation surface is unavailable.");
        const sceneState = api.getAppState();
        const sceneZoom = sceneState.zoom.value;
        setSpinnerPointerAnimations(spinners.map((spinner) => {
          const startPointerAngle = spinnerPointerAngle(spinner.currentValue);
          const targetPointerAngle = spinnerPointerAngle(spinner.value);
          return {
            angle: spinner.angle,
            endPointerAngle: spinnerPointerAnimationEndAngle(startPointerAngle, targetPointerAngle),
            height: spinner.height * sceneZoom,
            id: spinner.id,
            left: (spinner.x + sceneState.scrollX) * sceneZoom + sceneState.offsetLeft - hostBounds.left,
            scaleX: spinner.scaleX,
            scaleY: spinner.scaleY,
            startPointerAngle,
            top: (spinner.y + sceneState.scrollY) * sceneZoom + sceneState.offsetTop - hostBounds.top,
            width: spinner.width * sceneZoom,
          };
        }));
        setIsProbabilitySpinning(true);
        const completed = await waitForAbortableDelay(SPINNER_ANIMATION_DURATION_MS, operation.signal);
        if (!completed || !isCurrentSceneOperation(operation)) return;
      }

      if (!isCurrentSceneOperation(operation)) return;

      const files: BinaryFileData[] = selectedPieces.map((piece) => ({
        id: piece.fileId,
        mimeType: "image/svg+xml",
        dataURL: piece.dataURL,
        created: Date.now(),
      }));
      const pieceById = new Map(selectedPieces.map((piece) => [piece.id, piece]));
      api.addFiles(files);
      api.updateScene({
        elements: api.getSceneElements().map((element) => {
          const piece = pieceById.get(element.id);
          if (!piece || element.type !== "image") return element;
          return newElementWith(element, {
            angle: piece.originalAngle,
            fileId: piece.fileId,
            status: "saved",
            customData: {
              ...(element.customData || {}),
              classroomMathTool: piece.metadata,
            },
          });
        }),
        appState: { selectedElementIds: api.getAppState().selectedElementIds },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      const dice = selectedPieces.filter((piece) => piece.componentType === "die");
      const coins = selectedPieces.filter((piece) => piece.componentType === "coin");
      const spinnerResults = selectedPieces.filter((piece) => piece.componentType === "spinner");
      const resultText = selectedPieces.map((piece) => piece.componentType === "coin" ? piece.value[0] : piece.value).join(", ");
      const countParts = [
        dice.length ? `${dice.length} ${dice.length === 1 ? "die" : "dice"}` : "",
        coins.length ? `${coins.length} ${coins.length === 1 ? "coin" : "coins"}` : "",
        spinnerResults.length ? `${spinnerResults.length} ${spinnerResults.length === 1 ? "spinner" : "spinners"}` : "",
      ].filter(Boolean);
      const actionText = countParts.length > 1
        ? `Randomized ${countParts.join(" and ")}`
        : dice.length
          ? `Rolled ${countParts[0]}`
          : coins.length
            ? `Flipped ${countParts[0]}`
            : `Spun ${countParts[0]}`;
      api.setToast({ message: `${actionText}: ${resultText}.` });
    } catch (error) {
      if (isCurrentSceneOperation(operation) && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (probabilityOperationRef.current === operation) {
        probabilityOperationRef.current = null;
        probabilityRandomizingRef.current = false;
        setIsProbabilitySpinning(false);
        setSpinnerPointerAnimations([]);
      }
      finishSceneOperation(operation);
    }
  }, [api, beginSceneOperation, finishSceneOperation, isCurrentSceneOperation]);

  const commitMathInteraction = useCallback(() => {
    if (!mathInteraction || !api) return;
    try {
      if (mathInteraction.kind === "transformation") {
        const sourceElements = api.getSceneElements().filter((element) => mathInteraction.sourceElementIds.includes(element.id));
        if (!sourceElements.length) throw new Error("The selected source objects are no longer available.");
        const [minX, minY, maxX, maxY] = getCommonBounds(sourceElements);
        const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        const transformed = sourceElements.map((element, index) => {
          const geometry = transformElementGeometry(element, centre, mathInteraction.transformationOptions);
          const updated = newElementWith(element, {
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            angle: geometry.angle as ExcalidrawElement["angle"],
            customData: {
              ...(element.customData || {}),
              classroomMathTool: transformationMetadata(element.id, geometry.width, geometry.height, centre, mathInteraction.transformationOptions),
            },
          });
          return {
            ...updated,
            id: createLocalId(),
            groupIds: [],
            boundElements: null,
            version: 1,
            versionNonce: Date.now() + index,
            updated: Date.now(),
          } as ExcalidrawElement;
        });
        api.updateScene({
          elements: [...api.getSceneElements(), ...transformed],
          appState: { selectedElementIds: Object.fromEntries(transformed.map((element) => [element.id, true])) },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.setToast({ message: `${transformed.length} transformed cop${transformed.length === 1 ? "y" : "ies"} added.` });
        setMathInteraction(null);
        return;
      }
      const scenePoints = mathInteraction.points.map((point) => point.scene);
      if (mathInteraction.kind === "compass" && mathInteraction.compassOptions.fullCircle) {
        const generated = createCompassConstruction(scenePoints[0], scenePoints[1], mathInteraction.compassOptions);
        if (generated.metadata.kind !== "compass") throw new Error("Compass construction metadata is invalid.");
        const radius = generated.metadata.radiusSceneUnits;
        const groupId = createLocalId();
        const metadata = { ...generated.metadata, naturalWidth: radius * 2, naturalHeight: radius * 2 };
        const nativeShapes = [
          {
            id: createLocalId(), type: "ellipse" as const,
            x: generated.metadata.centerX - radius, y: generated.metadata.centerY - radius,
            width: radius * 2, height: radius * 2,
            strokeColor: generated.metadata.strokeColor, backgroundColor: "transparent",
            strokeWidth: 2 as const, roughness: 0 as const,
            groupIds: generated.metadata.centerMark ? [groupId] : [],
            customData: { classroomMathTool: metadata, classroomMathToolPart: "construction" },
          },
          ...(generated.metadata.centerMark ? [{
            id: createLocalId(), type: "ellipse" as const,
            x: generated.metadata.centerX - 4, y: generated.metadata.centerY - 4,
            width: 8, height: 8,
            strokeColor: generated.metadata.strokeColor, backgroundColor: generated.metadata.strokeColor,
            strokeWidth: 1 as const, roughness: 0 as const,
            groupIds: [groupId],
            customData: { classroomMathTool: metadata, classroomMathToolPart: "center-mark" },
          }] : []),
        ];
        const elements = convertToExcalidrawElements(nativeShapes, { regenerateIds: false });
        api.setActiveTool({ type: "selection" });
        api.updateScene({
          elements: [...api.getSceneElements(), ...elements],
          appState: { selectedElementIds: Object.fromEntries(elements.map((element) => [element.id, true])) },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.setToast({ message: "Editable compass circle added." });
        setMathInteraction(null);
        return;
      }
      const generated = mathInteraction.kind === "compass"
        ? createCompassConstruction(scenePoints[0], scenePoints[1], mathInteraction.compassOptions)
        : createAngleMeasurement(scenePoints[0], scenePoints[1], scenePoints[2], mathInteraction.angleOptions);
      insertMathTool(generated);
      setMathInteraction(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [api, insertMathTool, mathInteraction]);

  const insertEquation = useCallback((rendered: RenderedLatex) => {
    if (!api) return;
    try {
      const fileId = createLocalId() as FileId;
      const file: BinaryFileData = {
        id: fileId,
        mimeType: "image/svg+xml",
        dataURL: rendered.dataUrl as DataURL,
        created: Date.now(),
      };
      api.addFiles([file]);
      const elements = api.getSceneElements();
      const target = equationEditor?.targetId
        ? elements.find((element) => element.id === equationEditor.targetId)
        : undefined;
      const customData = {
        ...(target?.customData || {}),
        classroomLatex: {
          source: rendered.source,
          renderer: "mathjax",
          rendererVersion: "4.1.3",
        },
      };

      let equation: ExcalidrawElement;
      if (target?.type === "image") {
        const height = Math.max(24, target.height);
        const width = height * (rendered.width / rendered.height);
        equation = newElementWith(target, {
          x: target.x + (target.width - width) / 2,
          y: target.y + (target.height - height) / 2,
          width,
          height,
          fileId,
          status: "saved",
          customData,
        });
      } else {
        const appState = api.getAppState();
        const center = viewportCoordsToSceneCoords(
          {
            clientX: appState.offsetLeft + appState.width / 2,
            clientY: appState.offsetTop + appState.height / 2,
          },
          appState,
        );
        const equationId = createLocalId();
        [equation] = convertToExcalidrawElements(
          [{
            id: equationId,
            type: "image",
            x: center.x - rendered.width / 2,
            y: center.y - rendered.height / 2,
            width: rendered.width,
            height: rendered.height,
            fileId,
            status: "saved",
            strokeColor: "transparent",
            backgroundColor: "transparent",
            customData,
          }],
          { regenerateIds: false },
        );
      }

      const nextElements = target
        ? elements.map((element) => element.id === target.id ? equation : element)
        : [...elements, equation];
      api.updateScene({
        elements: nextElements,
        appState: { selectedElementIds: { [equation.id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      api.setToast({ message: target ? "Equation updated." : "Equation added to the board." });
      setEquationEditor(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [api, equationEditor]);

  const openMermaidEditor = useCallback(() => {
    if (!api) return;
    const selectedIds = api.getAppState().selectedElementIds;
    const selectedDiagram = api.getSceneElements().find(
      (element) => selectedIds[element.id] && mermaidDataForElement(element),
    );
    const data = mermaidDataForElement(selectedDiagram);
    setMermaidEditor({
      targetDiagramId: data?.diagramId || null,
      initialSource: data?.source || "",
    });
    setEquationEditor(null);
  }, [api]);

  const insertMermaid = useCallback((rendered: RenderedMermaid) => {
    if (!api || !rendered.elements.length) return;
    try {
      const existing = api.getSceneElements();
      const targetDiagramId = mermaidEditor?.targetDiagramId;
      const targetElements = targetDiagramId
        ? existing.filter((element) => mermaidDataForElement(element)?.diagramId === targetDiagramId)
        : [];
      const diagramId = targetDiagramId || createLocalId();
      const [sourceMinX, sourceMinY, sourceMaxX, sourceMaxY] = getCommonBounds(rendered.elements);

      let centerX: number;
      let centerY: number;
      if (targetElements.length) {
        const [minX, minY, maxX, maxY] = getCommonBounds(targetElements);
        centerX = (minX + maxX) / 2;
        centerY = (minY + maxY) / 2;
      } else {
        const appState = api.getAppState();
        const center = viewportCoordsToSceneCoords(
          {
            clientX: appState.offsetLeft + appState.width / 2,
            clientY: appState.offsetTop + appState.height / 2,
          },
          appState,
        );
        centerX = center.x;
        centerY = center.y;
      }
      const offsetX = centerX - (sourceMinX + sourceMaxX) / 2;
      const offsetY = centerY - (sourceMinY + sourceMaxY) / 2;
      const diagramElements = rendered.elements.map((element) => newElementWith(element, {
        x: element.x + offsetX,
        y: element.y + offsetY,
        groupIds: element.groupIds.includes(diagramId)
          ? element.groupIds
          : [...element.groupIds, diagramId],
        customData: {
          ...(element.customData || {}),
          classroomMermaid: {
            diagramId,
            source: rendered.source,
            renderer: "mermaid-to-excalidraw",
            rendererVersion: "2.2.2",
          },
        },
      }));
      const replacedIds = new Set(targetElements.map((element) => element.id));
      const nextElements = [
        ...existing.filter((element) => !replacedIds.has(element.id)),
        ...diagramElements,
      ];
      api.updateScene({
        elements: nextElements,
        appState: { selectedElementIds: { [diagramElements[0].id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      api.scrollToContent(diagramElements, {
        fitToViewport: true,
        viewportZoomFactor: 0.65,
        maxZoom: 1,
        animate: false,
      });
      api.setToast({ message: targetElements.length ? "Mermaid diagram updated." : "Mermaid diagram added to the board." });
      setMermaidEditor(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [api, mermaidEditor]);

  const openScene = useCallback((sceneId: string, frameId?: string) => {
    pendingProjectSearchTargetRef.current = null;
    commitPendingScenePersistence();
    const currentSceneId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || projectRef.current?.activeSceneId;
    const isSceneChange = sceneId !== currentSceneId;
    if (isSceneChange) commitLiveScenePersistence(currentSceneId || "");
    if (
      isSceneChange
      && pendingSlideFrameActionRef.current?.sceneId !== sceneId
    ) pendingSlideFrameActionRef.current = null;
    if (frameId) pendingFrameIdRef.current = frameId;
    else if (isSceneChange) pendingFrameIdRef.current = null;
    if (isSceneChange) pendingCreatedFrameIdRef.current = null;
    if (isSceneChange) beginSceneHydration();
    setProject((current) => {
      if (!current) return current;
      const next = { ...current, activeSceneId: sceneId };
      projectRef.current = next;
      activeSceneIdRef.current = sceneId;
      return next;
    });
    if (api && sceneId === currentSceneId && frameId) {
      focusSlide(api, frameId);
      pendingFrameIdRef.current = null;
    }
  }, [api, beginSceneHydration, commitLiveScenePersistence, commitPendingScenePersistence]);

  const openSlide = useCallback((slide: ClassroomSlide) => {
    setActiveSlideId(slide.id);
    openScene(slide.sceneId, slide.frameId);
  }, [openScene]);

  const hideSlideRail = useCallback(() => {
    setIsSlideRailVisible(false);
    window.requestAnimationFrame(() => slideRailShowButtonRef.current?.focus());
  }, []);

  const showSlideRail = useCallback(() => {
    setIsSlideRailVisible(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const rail = shellRef.current?.querySelector<HTMLElement>("#slide-rail");
        const focusTarget = rail?.querySelector<HTMLButtonElement>(
          '.slide-thumbnail[aria-current="page"]',
        ) || rail?.querySelector<HTMLButtonElement>(".slide-add-button");
        focusTarget?.focus({ preventScroll: true });
      });
    });
  }, []);

  const openSlideFromRail = useCallback((slide: ClassroomSlide) => {
    openSlide(slide);
    if (window.matchMedia("(max-width: 640px)").matches) hideSlideRail();
  }, [hideSlideRail, openSlide]);

  const hidePdfRail = useCallback(() => {
    setIsPdfRailVisible(false);
    window.requestAnimationFrame(() => pdfRailShowButtonRef.current?.focus());
  }, []);

  const showPdfRail = useCallback(() => {
    setIsPdfRailVisible(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const rail = shellRef.current?.querySelector<HTMLElement>("#pdf-page-rail");
        const focusTarget = rail?.querySelector<HTMLButtonElement>(
          '.pdf-page-open[aria-current="page"]',
        ) || rail?.querySelector<HTMLButtonElement>(".pdf-page-open");
        focusTarget?.focus({ preventScroll: true });
      });
    });
  }, []);

  const openPdfPageFromRail = useCallback((sceneId: string) => {
    openScene(sceneId);
    if (window.matchMedia("(max-width: 640px)").matches) hidePdfRail();
  }, [hidePdfRail, openScene]);

  const activateProjectSearchResult = useCallback((result: ProjectSearchResult) => {
    if (!api) return;
    const latestProject = commitPendingScenePersistence();
    if (!latestProject?.scenes[result.sceneId]) {
      api.setToast({ message: "That search result is no longer in this project." });
      return;
    }
    if (result.scope === "slide" && featurePreferencesRef.current.slides) {
      setWorkspaceMode("slides");
      setIsSlideRailVisible(true);
      setActiveSlideId(result.slideId || null);
    } else if (result.scope === "pdf" && featurePreferencesRef.current.pdf) {
      setWorkspaceMode("pdf");
      setActiveSlideId(null);
    } else {
      setWorkspaceMode("board");
      setActiveSlideId(result.scope === "slide" ? result.slideId || null : null);
    }
    const target = { sceneId: result.sceneId, elementId: result.elementId };
    if (result.sceneId === activeSceneIdRef.current) {
      focusProjectSearchTarget(target);
    } else {
      openScene(result.sceneId);
      pendingProjectSearchTargetRef.current = target;
    }
  }, [api, commitPendingScenePersistence, focusProjectSearchTarget, openScene]);

  const setPresentationIndex = useCallback((index: number, allowMorph = true) => {
    // Presentation navigation is also a scene-switch boundary. Commit the
    // live editor state synchronously so a rapid edit on one slide cannot be
    // replaced by the next slide before the normal debounce runs.
    const currentProject = commitPendingScenePersistence();
    if (!currentProject?.slideOrder[index]) return;
    const slide = currentProject.slideOrder[index];
    const reducedMotion = prefersReducedMotion();
    pendingPresentationTransitionRef.current = {
      frameId: slide.frameId,
      animate: allowMorph && currentProject.slideMorphEnabled === true && !reducedMotion,
      durationMs: normalizeSlideMorphDurationMs(currentProject.slideMorphDurationMs),
    };
    setPresentation((current) => ({
      index,
      tool: current?.tool || "laser",
      inkColour: current?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: current?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
    }));
    setActiveSlideId(slide.id);
    const currentSceneId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || projectRef.current?.activeSceneId;
    if (slide.sceneId !== currentSceneId) {
      // A delayed presentation-ink promotion (or any other Excalidraw
      // onChange) can still be pending when navigation starts. Capture the
      // live outgoing scene before hydration invalidates its RAF generation.
      commitLiveScenePersistence(currentSceneId || "");
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      if (pendingSlideFrameActionRef.current?.sceneId !== slide.sceneId) {
        pendingSlideFrameActionRef.current = null;
      }
      beginSceneHydration();
    }
    setProject((current) => {
      if (!current || current.activeSceneId === slide.sceneId) return current;
      const next = { ...current, activeSceneId: slide.sceneId };
      projectRef.current = next;
      activeSceneIdRef.current = slide.sceneId;
      return next;
    });
  }, [beginSceneHydration, commitLiveScenePersistence, commitPendingScenePersistence]);

  const startPresentation = useCallback(async () => {
    if (!project || !api || workspaceMode !== "slides") return;
    if (!project.slideOrder.length) {
      api.setToast({ message: "Add a slide first; each frame becomes a slide." });
      return;
    }
    presentationInkGenerationRef.current += 1;
    presentationInkStartElementIdsRef.current = null;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
      presentationInkFrameRef.current = null;
    }
    const index = Math.max(0, project.slideOrder.findIndex((slide) => slide.id === activeSlideId));
    const previousPresentation = presentationRef.current;
    const previousOpenSidebar = api.getAppState().openSidebar;
    api.setToast(null);
    api.updateScene({
      appState: { openSidebar: null },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    pendingProjectSearchTargetRef.current = null;
    libraryOpenRef.current = false;
    setIsLibraryOpen(false);
    setIsProjectFindOpen(false);
    api.updateFrameRendering({ enabled: true, outline: false, name: false, clip: true });
    api.setActiveTool({ type: "laser" });
    try {
      setPresentationIndex(index, false);
    } catch (error) {
      // A host with a broken reduced-motion API (or another synchronous
      // presentation setup failure) must not leave the canvas clipped and in
      // laser mode while React still thinks presentation is closed.
      pendingPresentationTransitionRef.current = null;
      setPresentation(previousPresentation);
      api.updateScene({
        appState: { openSidebar: previousOpenSidebar },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.updateFrameRendering({
        enabled: slideFramesVisibleRef.current,
        outline: true,
        name: true,
        clip: false,
      });
      api.setActiveTool({ type: "selection" });
      setAreSlideFramesVisible(slideFramesVisibleRef.current);
      api.setToast({ message: "Presentation mode could not be started." });
      if (error) console.error("Presentation mode could not be started.", error);
      return;
    }
    const shell = shellRef.current;
    if (!shell) return;
    const intent = { kind: "presentation" as const, entered: false };
    fullscreenIntentRef.current = intent;
    try {
      await shell.requestFullscreen();
      intent.entered = document.fullscreenElement === shell;
      // Presentation state can stop while requestFullscreen() is unresolved.
      // Exit a late orphan, but preserve fullscreen when a newer presentation
      // or an explicit manual request now owns the same shell.
      if (fullscreenIntentRef.current === null && document.fullscreenElement === shell) {
        await document.exitFullscreen();
      }
    } catch {
      if (fullscreenIntentRef.current === intent && document.fullscreenElement !== shell) {
        fullscreenIntentRef.current = null;
      }
      // Fullscreen can be browser-blocked; presentation still works in-window.
    }
  }, [activeSlideId, api, project, setPresentationIndex, workspaceMode]);

  const presentationSlide = presentation && project
    ? project.slideOrder[presentation.index]
    : null;

  useEffect(() => {
    if (
      !api
      || !presentationSlide
      || presentationSlide.sceneId !== project?.activeSceneId
    ) return;

    let refreshFrame = 0;
    let focusFrame = 0;
    const transition = pendingPresentationTransitionRef.current?.frameId === presentationSlide.frameId
      ? pendingPresentationTransitionRef.current
      : null;
    const fitSlide = (animate = false) => {
      window.cancelAnimationFrame(refreshFrame);
      window.cancelAnimationFrame(focusFrame);
      refreshFrame = window.requestAnimationFrame(() => {
        api.updateFrameRendering({ enabled: true, outline: false, name: false, clip: true });
        api.refresh();
        focusFrame = window.requestAnimationFrame(() => {
          focusSlide(api, presentationSlide.frameId, animate, animate ? (transition?.durationMs || DEFAULT_SLIDE_MORPH_DURATION_MS) : 0);
          if (pendingPresentationTransitionRef.current?.frameId === presentationSlide.frameId) {
            pendingPresentationTransitionRef.current = null;
          }
        });
      });
    };
    const handleResize = () => fitSlide(false);
    fitSlide(transition?.animate === true);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(refreshFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [api, isFullscreen, presentationSlide?.frameId, presentationSlide?.sceneId, project?.activeSceneId]);

  const stopPresentation = useCallback(() => {
    if (fullscreenIntentRef.current?.kind === "presentation") {
      fullscreenIntentRef.current = null;
    }
    pendingPresentationTransitionRef.current = null;
    presentationInkGenerationRef.current += 1;
    presentationInkStartElementIdsRef.current = null;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
      presentationInkFrameRef.current = null;
    }
    setPresentation(null);
    api?.updateFrameRendering({
      enabled: slideFramesVisibleRef.current,
      outline: true,
      name: true,
      clip: false,
    });
    setAreSlideFramesVisible(slideFramesVisibleRef.current);
    api?.setActiveTool({ type: "selection" });
    if (document.fullscreenElement === shellRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [api]);

  useEffect(() => {
    if (!presentation) return;
    let presentationEnteredFullscreen = document.fullscreenElement === shellRef.current;
    const stopWhenPresentationFullscreenEnds = () => {
      if (document.fullscreenElement === shellRef.current) {
        presentationEnteredFullscreen = true;
      } else if (presentationEnteredFullscreen) {
        presentationEnteredFullscreen = false;
        stopPresentation();
      }
    };
    document.addEventListener("fullscreenchange", stopWhenPresentationFullscreenEnds);
    return () => document.removeEventListener("fullscreenchange", stopWhenPresentationFullscreenEnds);
  }, [presentation, stopPresentation]);

  const toggleFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    let requestIntent: { kind: "manual"; entered: boolean } | null = null;
    try {
      if (document.fullscreenElement) {
        fullscreenIntentRef.current = null;
        await document.exitFullscreen();
      } else if (shell) {
        const intent = { kind: "manual" as const, entered: false };
        requestIntent = intent;
        fullscreenIntentRef.current = intent;
        await shell.requestFullscreen();
        intent.entered = document.fullscreenElement === shell;
        // A newer owner supersedes this request. Only clean up if every
        // fullscreen intent was canceled while the browser request was
        // pending.
        if (fullscreenIntentRef.current === null && document.fullscreenElement === shell) {
          await document.exitFullscreen();
        }
      }
    } catch {
      if (
        requestIntent
        && fullscreenIntentRef.current === requestIntent
        && document.fullscreenElement !== shell
      ) {
        fullscreenIntentRef.current = null;
      }
      api?.setToast({ message: "Fullscreen mode is unavailable in this browser." });
    }
  }, [api]);

  const clickEditorControl = useCallback((selector: string) => {
    const control = editorHostRef.current?.querySelector<HTMLButtonElement>(selector);
    if (control && !control.disabled) control.click();
  }, []);

  const setPresentationTool = useCallback((tool: "laser" | "freedraw") => {
    presentationInkGenerationRef.current += 1;
    presentationInkStartElementIdsRef.current = null;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
      presentationInkFrameRef.current = null;
    }
    setPresentation((current) => current ? { ...current, tool } : current);
    if (!api) return;
    if (tool === "freedraw") {
      activatePresentationInk(
        api,
        presentation?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
        presentation?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
      );
    } else {
      api.setActiveTool({ type: "laser" });
    }
  }, [api, presentation?.inkColour, presentation?.inkWidth]);

  const setPresentationInkColour = useCallback((inkColour: PresentationInkColour) => {
    setPresentation((current) => current ? { ...current, tool: "freedraw", inkColour } : current);
    if (api) activatePresentationInk(api, inkColour, presentation?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH);
  }, [api, presentation?.inkWidth]);

  const setPresentationInkWidth = useCallback((inkWidth: PresentationInkWidth) => {
    setPresentation((current) => current ? { ...current, tool: "freedraw", inkWidth } : current);
    if (api) activatePresentationInk(api, presentation?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR, inkWidth);
  }, [api, presentation?.inkColour]);

  useEffect(() => {
    if (!api || !presentation) return;
    if (presentation.tool === "freedraw") {
      activatePresentationInk(api, presentation.inkColour, presentation.inkWidth);
    } else {
      api.setActiveTool({ type: "laser" });
    }
  }, [api, presentation?.inkColour, presentation?.inkWidth, presentation?.tool, project?.activeSceneId, zoom]);

  const syncPresentationInkOnPointerDown = useCallback(() => {
    if (!api || presentation?.tool !== "freedraw") return;
    const sceneId = activeSceneIdRef.current;
    if (!presentationInkPointerDownIsCurrent(
      sceneId,
      hydratedSceneIdRef.current,
      switchingSceneRef.current,
    )) return;
    if (!sceneId) return;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
      presentationInkFrameRef.current = null;
    }
    presentationInkGenerationRef.current += 1;
    presentationInkStartElementIdsRef.current = {
      elementIds: new Set(api.getSceneElements().map((element) => element.id)),
      sceneId,
      generation: presentationInkGenerationRef.current,
    };
    activatePresentationInk(api, presentation.inkColour, presentation.inkWidth);
  }, [api, presentation?.inkColour, presentation?.inkWidth, presentation?.tool]);

  const finishPresentationInkStroke = useCallback(() => {
    const stroke = presentationInkStartElementIdsRef.current;
    presentationInkStartElementIdsRef.current = null;
    if (!api || !stroke || presentation?.tool !== "freedraw") return;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
    }
    const frameGeneration = presentationInkGenerationRef.current;
    presentationInkFrameRef.current = window.requestAnimationFrame(() => {
      presentationInkFrameRef.current = null;
      if (
        frameGeneration !== presentationInkGenerationRef.current
        || !presentationInkStrokeIsCurrent(stroke, {
          sceneId: activeSceneIdRef.current,
          generation: presentationInkGenerationRef.current,
          tool: presentationRef.current?.tool || null,
        })
      ) return;
      const elements = api.getSceneElements();
      const promoted = promoteNewPresentationInk(elements, stroke.elementIds);
      if (promoted === elements) return;
      api.updateScene({
        elements: promoted,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  }, [api, presentation]);

  const currentScene = project ? project.scenes[project.activeSceneId] : null;
  currentSceneRef.current = currentScene;
  useEffect(() => {
    retireActiveDarkPdfDisplayFile();
    darkPdfPreviewGenerationRef.current += 1;
    darkPdfPreviewCacheRef.current.clear();
    darkPdfThumbnailCacheRef.current.clear();
    darkPdfDisplayFileIdsRef.current.clear();
    darkPdfPreviewErrorsRef.current.clear();
    // The editor retains one stable display-only file for this mounted
    // session. It is excluded from persistence and replaced in place below.
    suspendDarkPdfDisplayRef.current = false;
    setDarkPdfPreviewUrls({});
  }, [project?.id, projectHydrationRevision, retireActiveDarkPdfDisplayFile]);

  useEffect(() => {
    const scene = currentScene;
    if (!scene?.pdfPage) {
      retireActiveDarkPdfDisplayFile();
      darkPdfDisplayFileIdsRef.current.clear();
      darkPdfPreviewCacheRef.current.clear();
      return;
    }
    if (!api) return;
    if (!darkPdfDisplaySceneIsCurrent(
      scene.id,
      activeSceneIdRef.current,
      hydratedSceneIdRef.current,
      switchingSceneRef.current,
    )) return;
    const generation = ++darkPdfPreviewGenerationRef.current;
    const hydrationGeneration = sceneHydrationGenerationRef.current;
    const liveElements = api.getSceneElements();
    const darkTreatment = editorTheme === "dark" && pdfPreferences.darkPdfPreview;
    const sharpen = pdfPreferences.sharperActivePdfPage;
    // Always return to the immutable canonical background before starting a
    // replacement render. This prevents the previous page/theme/quality from
    // remaining visible while its successor is still in flight.
    retireActiveDarkPdfDisplayFile();
    darkPdfDisplayFileIdsRef.current.clear();
    const lightElements = canonicalizePdfBackground(
      scene,
      liveElements as unknown as readonly Record<string, unknown>[],
    ) as unknown as readonly ExcalidrawElement[];
    if (lightElements !== liveElements) {
      api.updateScene({
        elements: lightElements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    if ((!darkTreatment && !sharpen) || suspendDarkPdfDisplayRef.current) {
      darkPdfPreviewCacheRef.current.clear();
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    darkPdfRenderControllersRef.current.add(controller);
    void getActivePdfDisplayFile(scene, {
      darkTreatment,
      sharpen,
      theme: editorTheme,
    }, controller.signal).then((file) => {
      if (
        cancelled
        || generation !== darkPdfPreviewGenerationRef.current
        || hydrationGeneration !== sceneHydrationGenerationRef.current
        || editorThemeRef.current !== editorTheme
        || pdfPreferencesRef.current.darkPdfPreview !== pdfPreferences.darkPdfPreview
        || pdfPreferencesRef.current.sharperActivePdfPage !== sharpen
        || suspendDarkPdfDisplayRef.current
        || nativeImageExportOpenRef.current
        || !darkPdfDisplaySceneIsCurrent(
          scene.id,
          activeSceneIdRef.current,
          hydratedSceneIdRef.current,
          switchingSceneRef.current,
        )
      ) return;
      if (!file) return;
      darkPdfPreviewErrorsRef.current.delete(scene.id);
      darkPdfDisplayFileIdsRef.current.clear();
      darkPdfDisplayFileIdsRef.current.set(scene.id, file.id);
      const currentElements = api.getSceneElements();
      const darkElements = canonicalizePdfBackground(
        scene,
        currentElements as unknown as readonly Record<string, unknown>[],
        file.id,
      ) as unknown as readonly ExcalidrawElement[];
      if (darkElements !== currentElements) {
        api.updateScene({
          elements: darkElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      // Excalidraw's public addFiles API deliberately merges and its decoded
      // image cache is keyed by file ID. The pinned component exposes its live
      // file record through getFiles(), so remove the one transient ID only
      // after the current background references it; addFiles can then replace
      // the bytes and invalidate the matching decoded image/shape cache.
      delete api.getFiles()[darkPdfActiveFileIdRef.current];
      api.addFiles([file]);
    }).catch(() => {
      if (
        cancelled
        || controller.signal.aborted
        || generation !== darkPdfPreviewGenerationRef.current
        || hydrationGeneration !== sceneHydrationGenerationRef.current
        || !darkPdfDisplaySceneIsCurrent(
          scene.id,
          activeSceneIdRef.current,
          hydratedSceneIdRef.current,
          switchingSceneRef.current,
        )
        || (darkTreatment && darkPdfPreviewErrorsRef.current.has(scene.id))
      ) return;
      darkPdfDisplayFileIdsRef.current.clear();
      retireActiveDarkPdfDisplayFile();
      const currentElements = api.getSceneElements();
      const lightElements = canonicalizePdfBackground(
        scene,
        currentElements as unknown as readonly Record<string, unknown>[],
      ) as unknown as readonly ExcalidrawElement[];
      if (lightElements !== currentElements) {
        api.updateScene({
          elements: lightElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      if (darkTreatment) {
        darkPdfPreviewErrorsRef.current.add(scene.id);
        api.setToast({ message: "This PDF page could not be shown in dark mode." });
      }
    }).finally(() => {
      darkPdfRenderControllersRef.current.delete(controller);
    });
    return () => {
      cancelled = true;
      controller.abort();
      darkPdfRenderControllersRef.current.delete(controller);
    };
  }, [
    api,
    currentScene?.id,
    currentScene?.pdfPage?.backgroundElementId,
    currentScene?.pdfPage?.documentId,
    currentScene?.pdfPage?.height,
    currentScene?.pdfPage?.pageIndex,
    currentScene?.pdfPage?.rotation,
    currentScene?.pdfPage?.viewRotation,
    currentScene?.pdfPage?.width,
    darkPdfDisplayRevision,
    editorTheme,
    getActivePdfDisplayFile,
    pdfPreferences.darkPdfPreview,
    pdfPreferences.sharperActivePdfPage,
    projectHydrationRevision,
    retireActiveDarkPdfDisplayFile,
  ]);
  // Page membership/order and source metadata keep their object identities
  // during ordinary scene edits. Retain a structural snapshot so drawing on
  // one page does not re-sort every PDF page or walk every element array.
  const stablePdfScenes = useMemo(() => project
    ? orderedPdfScenes(project)
    : [], [
    project?.id,
    project?.pdfDocuments,
    project?.pdfPageOrder,
    projectHydrationRevision,
  ]);
  const pdfSceneIndexById = useMemo(() => new Map(
    stablePdfScenes.map((scene, index) => [scene.id, index]),
  ), [stablePdfScenes]);
  // Resolve the stable order through the latest immutable scene map. This is
  // only O(page count), while PdfPageRail's WeakMaps ensure that unchanged
  // pages do not rescan their element arrays. Keeping every page current also
  // preserves its annotation badge after the user navigates away from it.
  const pdfScenes = useMemo(() => {
    if (!project) return [];
    return stablePdfScenes.map((scene) => project.scenes[scene.id] || scene);
  }, [project?.scenes, stablePdfScenes]);
  const pdfThumbnailIdentity = useMemo(() => JSON.stringify(
    pdfScenes.map((scene) => darkPdfThumbnailCacheKey(project, scene)),
  ), [pdfScenes, project?.pdfDocuments]);
  const darkPdfThumbnailSceneIds = useMemo(() => darkPdfThumbnailRenderSceneIds(
    stablePdfScenes.map((scene) => scene.id),
    project?.activeSceneId,
    MAX_DARK_PDF_THUMBNAILS,
  ), [stablePdfScenes, project?.activeSceneId]);
  const darkPdfThumbnailTargetIdentity = darkPdfThumbnailSceneIds.join("\u0000");
  useEffect(() => {
    const validSceneIds = new Set(stablePdfScenes.map((scene) => scene.id));
    const validCacheKeys = new Set(
      pdfScenes
        .map((scene) => darkPdfThumbnailCacheKey(project, scene))
        .filter((key): key is string => !!key),
    );
    pruneDarkPdfThumbnails(darkPdfThumbnailCacheRef.current, validCacheKeys);
    const retainedCachedSceneIds = retainedDarkPdfThumbnailSceneIds(
      darkPdfThumbnailCacheRef.current,
    );
    setDarkPdfPreviewUrls((current) => {
      const entries = Object.entries(current).filter(([sceneId]) => (
        validSceneIds.has(sceneId) && retainedCachedSceneIds.has(sceneId)
      ));
      if (entries.length === Object.keys(current).length) return current;
      return Object.fromEntries(entries);
    });
    if (
      editorTheme !== "dark"
      || !pdfPreferences.darkPdfPreview
      || stablePdfScenes.length === 0
    ) {
      darkPdfThumbnailCacheRef.current.clear();
      setDarkPdfPreviewUrls({});
      return;
    }
    let cancelled = false;
    let nextIndex = 0;
    const scenesById = new Map(pdfScenes.map((scene) => [scene.id, scene]));
    const thumbnailScenes = darkPdfThumbnailSceneIds
      .map((sceneId) => scenesById.get(sceneId))
      .filter((scene): scene is SerializedScene => !!scene);
    const projectId = project?.id;
    const controller = new AbortController();
    const renderNextThumbnail = async () => {
      while (!cancelled && nextIndex < thumbnailScenes.length) {
        const scene = thumbnailScenes[nextIndex];
        nextIndex += 1;
        for (let attempt = 0; attempt < 2 && !cancelled; attempt += 1) {
          try {
            const dataURL = await getDarkPdfThumbnailUrl(scene, controller.signal);
            if (
              cancelled
              || controller.signal.aborted
              || editorThemeRef.current !== "dark"
              || !pdfPreferencesRef.current.darkPdfPreview
              || projectRef.current?.id !== projectId
            ) break;
            const retainedSceneIds = retainedDarkPdfThumbnailSceneIds(
              darkPdfThumbnailCacheRef.current,
            );
            setDarkPdfPreviewUrls((current) => {
              const next = Object.fromEntries(
                Object.entries(current).filter(([sceneId]) => retainedSceneIds.has(sceneId)),
              );
              if (retainedSceneIds.has(scene.id)) next[scene.id] = dataURL;
              return next;
            });
            break;
          } catch {
            if (controller.signal.aborted) break;
            // Retry once for transient PDF.js/worker failures. The active-page
            // renderer owns user-facing errors; the rail then falls back to
            // its canonical light thumbnail if both attempts fail.
          }
        }
      }
    };
    // Keep large classroom PDFs responsive while progressively darkening all
    // thumbnails in the active rail window. Each thumbnail is capped at 256px
    // on its longest edge. This controller is intentionally local: scene
    // hydration aborts the full-page renderer, but a thumbnail is keyed to its
    // immutable source scene and remains valid across rapid page switches.
    void Promise.all([renderNextThumbnail(), renderNextThumbnail()]);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    editorTheme,
    pdfPreferences.darkPdfPreview,
    darkPdfThumbnailTargetIdentity,
    getDarkPdfThumbnailUrl,
    pdfThumbnailIdentity,
    project?.activeSceneId,
    project?.id,
    projectHydrationRevision,
  ]);
  const pageIndex = currentScene?.pdfPage
    ? pdfSceneIndexById.get(currentScene.id) ?? -1
    : -1;
  const activeSlideIndex = project?.slideOrder.findIndex((slide) => slide.id === activeSlideId) ?? -1;

  const persistScreenshots = useCallback((update: ScreenshotItemsUpdate) => {
    // Capture/delete actions can be initiated faster than IndexedDB writes
    // complete. Serialize them and resolve updater functions against the
    // latest successfully committed list so one operation cannot overwrite a
    // later user's capture. Callers still receive the rejection and surface a
    // recovery message when storage fails.
    const queued = screenshotPersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const items = typeof update === "function"
          ? [...update(screenshotsRef.current)]
          : [...update];
        await saveScreenshotLibrary(items);
        screenshotsRef.current = items;
        if (sceneOperationMountedRef.current) setScreenshots(items);
      });
    screenshotPersistenceQueueRef.current = queued;
    return queued;
  }, []);

  const startScreenshotCapture = useCallback(() => {
    if (!api || isScreenshotBusy || isScreenshotLibraryLoading) return;
    lastLibraryTabRef.current = SCREENSHOT_SIDEBAR_TAB;
    setMathInteraction(null);
    lassoActiveRef.current = false;
    setIsLassoActive(false);
    api.toggleSidebar({ name: "default", force: false });
    libraryOpenRef.current = false;
    setIsLibraryOpen(false);
    setExportOpen(false);
    setIsScreenshotCaptureActive(true);
  }, [api, isScreenshotBusy, isScreenshotLibraryLoading]);

  const cancelScreenshotCapture = useCallback(() => {
    setIsScreenshotCaptureActive(false);
    api?.setToast({ message: "Area capture cancelled." });
  }, [api]);

  const finishScreenshotCapture = useCallback((rect: ViewportCaptureRect) => {
    const editorBounds = editorHostRef.current?.getBoundingClientRect();
    if (!api || !editorBounds) return cancelScreenshotCapture();
    const operation = beginSceneOperation();
    if (!operation) return cancelScreenshotCapture();
    sceneOperationBusyRef.current.add(operation);
    const screenshotBusyOwner = ++screenshotBusyOwnerRef.current;
    setIsScreenshotCaptureActive(false);
    setIsScreenshotBusy(true);
    setBusyMessage("Capturing area…");

    const sceneBounds = viewportCaptureRectToSceneBounds(
      rect,
      { x: editorBounds.left, y: editorBounds.top },
      api.getAppState(),
    );
    const scene = currentSceneRef.current;
    const liveElements = api.getSceneElements();
    const elements = scene
      ? canonicalizePdfBackground(
        scene,
        liveElements as unknown as readonly Record<string, unknown>[],
      ) as unknown as readonly ExcalidrawElement[]
      : liveElements;
    const files = scene
      ? cloneBinaryFiles(persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current))
      : cloneBinaryFiles(api.getFiles());
    const rendered = exportScreenshotArea(api, sceneBounds, { elements, files });
    // ClipboardItem accepts a promised Blob, so the privileged write begins
    // synchronously inside the pointer-up gesture while rendering continues.
    const clipboardWrite = beginPngClipboardWrite(rendered.then((capture) => capture.blob));

    void (async () => {
      try {
        const capture = await rendered;
        if (!isCurrentSceneOperation(operation)) return;
        const item: StoredScreenshot = {
          id: createLocalId(),
          createdAt: Date.now(),
          blob: capture.blob,
          width: capture.width,
          height: capture.height,
          sceneWidth: capture.sceneWidth,
          sceneHeight: capture.sceneHeight,
        };
        await persistScreenshots((current) => addScreenshotToLibrary(current, item));
        if (isCurrentSceneOperation(operation)) {
          api.setToast({ message: clipboardCaptureToast(await clipboardWrite) });
        }
      } catch (error) {
        if (isCurrentSceneOperation(operation) && !isAbortLikeError(error)) {
          setErrorMessage(`Area screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (
          screenshotBusyOwnerRef.current === screenshotBusyOwner
          && sceneOperationBusyRef.current.delete(operation)
        ) {
          if (sceneOperationBusyRef.current.size === 0) setBusyMessage(null);
          setIsScreenshotBusy(false);
        }
        finishSceneOperation(operation);
      }
    })();
  }, [api, beginSceneOperation, cancelScreenshotCapture, finishSceneOperation, isCurrentSceneOperation, persistScreenshots]);

  const insertScreenshot = useCallback(async (
    item: StoredScreenshot,
    viewportPoint?: { clientX: number; clientY: number },
  ) => {
    if (!api) return;
    const operation = beginSceneOperation();
    if (!operation) return;
    try {
      const dataURL = await pngBlobToDataUrl(item.blob);
      if (!isCurrentSceneOperation(operation)) return;
      const appState = api.getAppState();
      const activeScene = currentSceneRef.current;
      let center: { x: number; y: number };
      if (viewportPoint) {
        center = viewportCoordsToSceneCoords(viewportPoint, appState);
      } else if (activeScene?.pdfPage) {
        const display = getPdfPageDisplayGeometry(activeScene.pdfPage);
        const background = api.getSceneElements().find(
          (element) => element.id === activeScene.pdfPage?.backgroundElementId,
        );
        center = background
          ? { x: background.x + background.width / 2, y: background.y + background.height / 2 }
          : { x: display.width / 2, y: display.height / 2 };
      } else {
        center = viewportCoordsToSceneCoords({
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        }, appState);
      }

      const fileId = createLocalId() as FileId;
      const imageId = createLocalId();
      const file: BinaryFileData = {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: Date.now(),
      };
      const [image] = convertToExcalidrawElements([{
        id: imageId,
        type: "image",
        x: center.x - item.sceneWidth / 2,
        y: center.y - item.sceneHeight / 2,
        width: item.sceneWidth,
        height: item.sceneHeight,
        fileId,
        status: "saved",
        strokeColor: "transparent",
        backgroundColor: "transparent",
      }], { regenerateIds: false });
      if (!isCurrentSceneOperation(operation)) return;
      api.addFiles([file]);
      api.setActiveTool({ type: "selection" });
      api.updateScene({
        elements: [...api.getSceneElements(), image],
        appState: { selectedElementIds: { [image.id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      api.setToast({ message: viewportPoint ? "Screenshot placed on the canvas." : "Screenshot inserted at the center." });
    } catch (error) {
      if (isCurrentSceneOperation(operation) && !isAbortLikeError(error)) {
        setErrorMessage(`Screenshot could not be inserted: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      finishSceneOperation(operation);
    }
  }, [api, beginSceneOperation, finishSceneOperation, isCurrentSceneOperation]);

  const copyScreenshot = useCallback((item: StoredScreenshot) => {
    const write = beginPngClipboardWrite(Promise.resolve(item.blob));
    void write.then((result) => {
      api?.setToast({
        message: result === "success"
          ? "Screenshot copied to the clipboard."
          : result === "denied"
            ? "Clipboard permission was denied."
            : result === "unsupported"
              ? "Image clipboard access is unavailable in this browser."
              : "The screenshot could not be copied.",
      });
    });
  }, [api]);

  const downloadScreenshot = useCallback((item: StoredScreenshot) => {
    downloadBlob(item.blob, screenshotDownloadName(item.createdAt));
  }, []);

  const deleteScreenshot = useCallback((item: StoredScreenshot) => {
    const screenshotBusyOwner = ++screenshotBusyOwnerRef.current;
    setIsScreenshotBusy(true);
    void persistScreenshots((current) => current.filter((candidate) => candidate.id !== item.id))
      .then(() => api?.setToast({ message: "Screenshot deleted." }))
      .catch((error) => {
        if (sceneOperationMountedRef.current) {
          setErrorMessage(`Screenshot could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => {
        if (screenshotBusyOwnerRef.current === screenshotBusyOwner) setIsScreenshotBusy(false);
      });
  }, [api, persistScreenshots]);

  const insertDroppedLocalImage = useCallback(async (
    file: File,
    viewportPoint: { clientX: number; clientY: number },
    imageMimeHint?: LocalDropImageMime,
    customData?: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!api) return false;
    const operation = beginSceneOperation();
    if (!operation) return false;
    try {
      // PNG and SVG drops are wrapper-owned because Excalidraw otherwise
      // attempts to restore embedded scene metadata before its image hook.
      const imageMime = imageMimeHint || await guessLocalDropImageMime(file);
      if (!imageMime) {
        throw new Error("PatterDraw supports PNG, JPEG, GIF, WebP, and safe SVG images.");
      }
      const canonicalFile = canonicalLocalDropImageFile(file, imageMime);
      const info = await inspectLocalImageBlob(canonicalFile, operation.signal);
      let persistedBlob: Blob = file;
      let persistedMime = info.mimeType;
      let width = info.width;
      let height = info.height;
      if (info.mimeType === "image/png") {
        const edgeScale = Math.min(1, 1_440 / width, 1_440 / height);
        width = Math.max(1, Math.floor(width * edgeScale));
        height = Math.max(1, Math.floor(height * edgeScale));
        // Always re-encode, including small PNGs, so an Excalidraw tEXt scene
        // payload cannot survive as dormant metadata in the persisted image.
        persistedBlob = await rasterizeLocalPngForInsertion(
          canonicalFile,
          width,
          height,
          operation.signal,
        );
        const limited = await downsamplePngToByteLimit(
          persistedBlob,
          width,
          height,
          (source, nextWidth, nextHeight) => rasterizeLocalPngForInsertion(
            source,
            nextWidth,
            nextHeight,
            operation.signal,
          ),
        );
        persistedBlob = limited.blob;
        width = limited.width;
        height = limited.height;
        await inspectLocalImageBlob(persistedBlob, operation.signal);
      } else if (info.mimeType === "image/svg+xml") {
        const edgeScale = Math.min(1, 1_440 / width, 1_440 / height);
        width *= edgeScale;
        height *= edgeScale;
        persistedBlob = await stripExcalidrawSvgSceneMetadata(canonicalFile, operation.signal);
      } else if (info.mimeType === "image/gif") {
        const edgeScale = Math.min(1, 1_440 / width, 1_440 / height);
        width = Math.max(1, Math.floor(width * edgeScale));
        height = Math.max(1, Math.floor(height * edgeScale));
        // Canvas encoders do not reliably emit GIF. Convert the first frame to
        // an honestly-labelled PNG instead of persisting PNG bytes behind an
        // image/gif data URL, which cannot survive the next safety preflight.
        persistedBlob = await rasterizeLocalImageToPngForInsertion(
          canonicalFile,
          width,
          height,
          operation.signal,
        );
        const limited = await downsamplePngToByteLimit(
          persistedBlob,
          width,
          height,
          (source, nextWidth, nextHeight) => rasterizeLocalPngForInsertion(
            source,
            nextWidth,
            nextHeight,
            operation.signal,
          ),
        );
        persistedBlob = limited.blob;
        persistedMime = "image/png";
        width = limited.width;
        height = limited.height;
        await inspectLocalImageBlob(persistedBlob, operation.signal);
      } else {
        const edgeScale = Math.min(1, 1_440 / width, 1_440 / height);
        width *= edgeScale;
        height *= edgeScale;
        persistedBlob = canonicalFile;
      }
      const persistedFile = new File([persistedBlob], canonicalFile.name, {
        type: persistedMime,
        lastModified: canonicalFile.lastModified,
      });
      const fileIdValue = await generateSafeLocalImageFileId(persistedFile, operation.signal);
      const dataURL = await getDataURL(persistedBlob);
      if (!isCurrentSceneOperation(operation)) return false;
      const appState = api.getAppState();
      const center = viewportCoordsToSceneCoords(viewportPoint, appState);
      const fileId = fileIdValue as FileId;
      const imageId = createLocalId();
      const binaryFile: BinaryFileData = {
        id: fileId,
        mimeType: persistedMime,
        dataURL,
        created: Date.now(),
      };
      const [image] = convertToExcalidrawElements([{
        id: imageId,
        type: "image",
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
        fileId,
        status: "saved",
        strokeColor: "transparent",
        backgroundColor: "transparent",
        ...(customData ? { customData } : {}),
      }], { regenerateIds: false });
      api.addFiles([binaryFile]);
      api.setActiveTool({ type: "selection" });
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), image],
        appState: { selectedElementIds: { [image.id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return true;
    } catch (error) {
      if (isCurrentSceneOperation(operation) && !isAbortLikeError(error)) {
        setErrorMessage(`Image could not be inserted: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    } finally {
      finishSceneOperation(operation);
    }
  }, [api, beginSceneOperation, finishSceneOperation, isCurrentSceneOperation]);

  const insertGeoGonSvg = useCallback(async (rawSvg: string): Promise<boolean> => {
    const svg = geoGonSvgFromClipboardText(rawSvg);
    if (!svg || !api) {
      setErrorMessage("GeoGon returned a vector image that PatterDraw could not verify.");
      return false;
    }
    setErrorMessage(null);
    const appState = api.getAppState();
    const inserted = await insertDroppedLocalImage(
      new File([svg], "3DGeoGon-diagram.svg", { type: "image/svg+xml" }),
      {
        clientX: appState.offsetLeft + appState.width / 2,
        clientY: appState.offsetTop + appState.height / 2,
      },
      "image/svg+xml",
      { classroomGeoGon: { transfer: "svg", version: 1 } },
    );
    if (inserted) {
      focusAfterMathToolsRef.current = "editor";
      setIsGeoGonOpen(false);
      api.setToast({ message: "3D GeoGon diagram inserted." });
    }
    return inserted;
  }, [api, insertDroppedLocalImage]);

  const importDroppedLibrary = useCallback(async (file: File) => {
    if (!api) return;
    setErrorMessage(null);
    try {
      const safe = await loadSafeLibraryFromBlob(file);
      await api.updateLibrary({
        libraryItems: safe,
        merge: true,
        openLibraryMenu: true,
      });
    } catch (error) {
      setErrorMessage(`Personal library could not be imported: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);

  const handleEditorDropCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const hasScreenshotDragType = Array.from(event.dataTransfer.types).includes(SCREENSHOT_DRAG_MIME);
    const file = event.dataTransfer.files?.[0];
    if (hasScreenshotDragType) {
      const screenshotId = event.dataTransfer.getData(SCREENSHOT_DRAG_MIME);
      const screenshot = screenshotsRef.current.find((item) => item.id === screenshotId);
      if (screenshot) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        if (!(event.target instanceof Element && event.target.closest(".default-sidebar"))) {
          void insertScreenshot(screenshot, { clientX: event.clientX, clientY: event.clientY });
        }
        return;
      }
    }
    // A screenshot-library drag normally carries only its custom ID and is
    // handled by the bubbling handler below. If files are also present, keep
    // this capture boundary authoritative so Excalidraw cannot inspect a
    // scene-bearing image before the wrapper preflights it.
    if (!file) {
      const libraryPayload = event.dataTransfer.getData("application/vnd.excalidrawlib+json");
      if (!libraryPayload) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      const libraryFile = new File(
        [libraryPayload],
        "dropped-library.excalidrawlib",
        { type: "application/vnd.excalidrawlib+json" },
      );
      void importDroppedLibrary(libraryFile);
      return;
    }

    // Preserve Excalidraw's established 1,440px/4MiB local resize path for
    // correctly typed raster formats that cannot carry an Excalidraw scene.
    // PNG/SVG and every ambiguous or typeless file remain wrapper-owned so
    // their bytes can be inspected before Excalidraw attempts scene restore.
    const declaredImageMime = file.type.trim().toLowerCase();
    if (
      declaredImageMime === "image/jpeg"
        || declaredImageMime === "image/webp"
    ) return;

    const name = file.name.toLowerCase();
    const isLibrary = name.endsWith(".excalidrawlib")
      || file.type === "application/vnd.excalidrawlib+json";
    const isProjectFile = name.endsWith(".patterdraw")
      || name.endsWith(".canvasclassroom")
      || name.endsWith(".excalidraw")
      || name.endsWith(".pdf")
      || file.type === "application/vnd.excalidraw+json"
      || file.type === "application/pdf";
    const isUnownedJson = name.endsWith(".json") || file.type === "application/json";
    const viewportPoint = { clientX: event.clientX, clientY: event.clientY };
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    void (async () => {
      let imageMime: LocalDropImageMime | null = null;
      try {
        imageMime = await guessLocalDropImageMime(file);
      } catch {
        // Keep the drop owned by the wrapper even if a hostile/invalid File
        // cannot be sniffed. Known project/library routes still get their
        // normal parser below; unknown data receives a safe rejection.
      }
      if (imageMime) {
        await insertDroppedLocalImage(file, {
          ...viewportPoint,
        }, imageMime);
      } else if (isLibrary) {
        await importDroppedLibrary(file);
      } else if (isProjectFile) {
        await handleFile(file);
      } else if (isUnownedJson) {
        api?.setToast({ message: "Use Open for a supported PatterDraw or Excalidraw project file." });
      } else if (hasScreenshotDragType || file.type.trim() === "" || file.type.toLowerCase().startsWith("image/")) {
        api?.setToast({ message: "PatterDraw supports PNG, JPEG, GIF, WebP, and safe SVG images." });
      } else {
        api?.setToast({ message: "This file type cannot be placed on the canvas." });
      }
    })().catch((error) => {
      api?.setToast({ message: error instanceof Error ? error.message : String(error) });
    });
  }, [api, handleFile, importDroppedLibrary, insertDroppedLocalImage, insertScreenshot]);

  const screenshotIdFromTransfer = useCallback((transfer: DataTransfer): string | null => {
    const types = Array.from(transfer.types);
    const hasCustomType = types.includes(SCREENSHOT_DRAG_MIME);
    const candidate = hasCustomType
      ? transfer.getData(SCREENSHOT_DRAG_MIME)
      : types.includes("text/plain")
        ? transfer.getData("text/plain")
        : "";
    if (!candidate) return null;
    return screenshotsRef.current.some((item) => item.id === candidate) ? candidate : null;
  }, []);

  const handleScreenshotDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!screenshotIdFromTransfer(event.dataTransfer)) return;
    if (event.target instanceof Element && event.target.closest(".default-sidebar")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [screenshotIdFromTransfer]);

  const handleScreenshotDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const screenshotId = screenshotIdFromTransfer(event.dataTransfer);
    if (!screenshotId) return;
    if (event.target instanceof Element && event.target.closest(".default-sidebar")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = screenshotsRef.current.find((candidate) => candidate.id === screenshotId);
    if (item) void insertScreenshot(item, { clientX: event.clientX, clientY: event.clientY });
  }, [insertScreenshot, screenshotIdFromTransfer]);

  useEffect(() => {
    if (workspaceMode !== "pdf" || presentation || pageIndex < 0) return;
    const navigatePdfWithArrowKeys = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || hasVisibleModalSurface()
        || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(
        'input, textarea, select, button, [contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], [role="separator"], .busy-overlay',
      )) return;
      const nextIndex = pageIndex + (event.key === "ArrowLeft" ? -1 : 1);
      const nextPage = pdfScenes[nextIndex];
      if (!nextPage) return;
      event.preventDefault();
      openScene(nextPage.id);
    };
    window.addEventListener("keydown", navigatePdfWithArrowKeys, true);
    return () => window.removeEventListener("keydown", navigatePdfWithArrowKeys, true);
  }, [openScene, pageIndex, pdfScenes, presentation, workspaceMode]);

  useEffect(() => {
    if (!api || workspaceMode !== "pdf" || !currentScene?.pdfPage) return;
    let refreshFrame = 0;
    let centerFrame = 0;
    const centerPage = () => {
      window.cancelAnimationFrame(refreshFrame);
      window.cancelAnimationFrame(centerFrame);
      refreshFrame = window.requestAnimationFrame(() => {
        api.refresh();
        centerFrame = window.requestAnimationFrame(() => {
          const background = api.getSceneElements().find(
            (element) => element.id === currentScene.pdfPage?.backgroundElementId,
          );
          if (background) api.scrollToContent(background, { animate: false });
        });
      });
    };
    centerPage();
    window.addEventListener("resize", centerPage);
    return () => {
      window.removeEventListener("resize", centerPage);
      window.cancelAnimationFrame(refreshFrame);
      window.cancelAnimationFrame(centerFrame);
    };
  }, [
    api,
    currentScene?.id,
    currentScene?.pdfPage?.backgroundElementId,
    currentScene?.pdfPage?.viewRotation,
    isNavigationVisible,
    isPdfRailVisible,
    pdfRailWidth,
    workspaceMode,
  ]);

  const changeWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    pendingProjectSearchTargetRef.current = null;
    if (mode !== "slides") pendingSlideFrameActionRef.current = null;
    if (mode === "slides") {
      setIsSlideRailVisible(true);
      setActiveSlideId((current) => {
        if (project?.slideOrder.some((slide) => slide.id === current)) return current;
        return project?.slideOrder.find((slide) => slide.sceneId === project.activeSceneId)?.id
          || project?.slideOrder[0]?.id
          || null;
      });
    }
    if (mode !== "pdf") {
      if (mode === "board") api?.setActiveTool({ type: "selection" });
      if (!project) {
        setWorkspaceMode(mode);
        return;
      }
      // Board mode may be entered directly from a PDF-only project. Capture
      // the outgoing live scene before creating the replacement blank board;
      // its debounced onChange may still be waiting in Excalidraw.
      const currentProject = commitLiveScenePersistence(
        hydratedSceneIdRef.current
          || activeSceneIdRef.current
          || projectRef.current?.activeSceneId
          || project.activeSceneId,
      ) || project;
      setWorkspaceMode(mode);
      const targetSceneId = boardSceneId(currentProject);
      if (targetSceneId === currentProject.activeSceneId) return;
      if (targetSceneId) {
        openScene(targetSceneId);
        return;
      }
      const blank = createBlankProject();
      const scene = blank.scenes[blank.activeSceneId];
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      beginSceneHydration();
      const nextProject = {
        ...currentProject,
        updatedAt: nowIso(),
        activeSceneId: scene.id,
        scenes: { ...currentProject.scenes, [scene.id]: scene },
      };
      projectRef.current = nextProject;
      activeSceneIdRef.current = nextProject.activeSceneId;
      setProject(nextProject);
      return;
    }
    if (!project || !pdfScenes.length) return;
    setWorkspaceMode("pdf");
    if (!currentScene?.pdfPage) openScene(pdfScenes[0].id);
  }, [
    api,
    beginSceneHydration,
    commitLiveScenePersistence,
    currentScene?.pdfPage,
    openScene,
    pdfScenes,
    project,
  ]);

  useEffect(() => {
    if (presentation && !featurePreferences.slides) stopPresentation();
    const hiddenActiveMode = (workspaceMode === "slides" && !featurePreferences.slides)
      || (workspaceMode === "pdf" && !featurePreferences.pdf);
    if (hiddenActiveMode) changeWorkspaceMode("board");
  }, [
    changeWorkspaceMode,
    featurePreferences.pdf,
    featurePreferences.slides,
    presentation,
    stopPresentation,
    workspaceMode,
  ]);

  const beginSlideFrameAction = useCallback((action: SlideFrameAction) => {
    if (!api || !project) return;
    setIsSlideRailVisible(true);
    // A PDF-only project needs a new blank board before a slide can be
    // created. Capture the current PDF scene synchronously so its latest
    // annotation is part of the project before the scene map changes.
    const currentProject = commitLiveScenePersistence(
      hydratedSceneIdRef.current
        || activeSceneIdRef.current
        || projectRef.current?.activeSceneId
        || project.activeSceneId,
    ) || project;
    const targetSceneId = boardSceneId(currentProject);

    if (!targetSceneId) {
      setWorkspaceMode("slides");
      const blank = createBlankProject();
      const scene = blank.scenes[blank.activeSceneId];
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = { action, sceneId: scene.id };
      beginSceneHydration();
      const nextProject = {
        ...currentProject,
        updatedAt: nowIso(),
        activeSceneId: scene.id,
        scenes: { ...currentProject.scenes, [scene.id]: scene },
      };
      projectRef.current = nextProject;
      activeSceneIdRef.current = nextProject.activeSceneId;
      setProject(nextProject);
      return;
    }
    setWorkspaceMode("slides");
    if (targetSceneId !== currentProject.activeSceneId) {
      pendingSlideFrameActionRef.current = { action, sceneId: targetSceneId };
      openScene(targetSceneId);
      return;
    }
    if (switchingSceneRef.current) {
      const pendingAction = { action, sceneId: targetSceneId };
      pendingSlideFrameActionRef.current = pendingAction;
      if (
        sceneHydrationOuterFrameRef.current === null
        && sceneHydrationInnerFrameRef.current === null
      ) {
        const runWhenStable = (remainingFrames: number) => {
          if (pendingSlideFrameActionRef.current !== pendingAction) return;
          if (
            activeSceneIdRef.current !== targetSceneId
            || !featurePreferencesRef.current.slides
          ) {
            pendingSlideFrameActionRef.current = null;
            return;
          }
          if (switchingSceneRef.current && remainingFrames > 0) {
            window.requestAnimationFrame(() => runWhenStable(remainingFrames - 1));
            return;
          }
          pendingSlideFrameActionRef.current = null;
          if (!switchingSceneRef.current) runSlideFrameAction(action);
        };
        window.requestAnimationFrame(() => runWhenStable(3));
      }
      return;
    }
    runSlideFrameAction(action);
  }, [
    api,
    beginSceneHydration,
    commitLiveScenePersistence,
    openScene,
    project,
    runSlideFrameAction,
  ]);

  const addSlide = useCallback(() => {
    if (!project) return;
    beginSlideFrameAction({
      kind: "add",
      frameId: createLocalId(),
      title: `Slide ${project.slideOrder.length + 1}`,
    });
  }, [beginSlideFrameAction, project]);

  const toggleSlideFrameDrawing = useCallback(() => {
    if (!api || !project) return;
    if (slideFrameDrawingActiveRef.current) {
      slideFrameDrawingActiveRef.current = false;
      setIsSlideFrameDrawingActive(false);
      pendingSlideFrameActionRef.current = null;
      slideFrameGestureRef.current = null;
      if (frameDragPreviewRef.current) frameDragPreviewRef.current.hidden = true;
      api.setActiveTool({ type: "selection" });
      api.updateFrameRendering({ enabled: true, outline: true, name: true, clip: false });
      return;
    }
    slideFrameDrawingActiveRef.current = true;
    setIsSlideFrameDrawingActive(true);
    beginSlideFrameAction({ kind: "draw" });
  }, [api, beginSlideFrameAction, project]);

  const toggleSlideFrames = useCallback(() => {
    if (!api) return;
    const visible = !api.getAppState().frameRendering.enabled;
    slideFramesVisibleRef.current = visible;
    api.updateFrameRendering({ enabled: visible, clip: false });
    if (!visible) {
      api.updateScene({
        appState: {
          selectedElementIds: {},
          selectedGroupIds: {},
          editingFrame: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    setAreSlideFramesVisible(visible);
    setProject((current) => current ? {
      ...current,
      updatedAt: nowIso(),
      slideFramesVisible: visible,
    } : current);
  }, [api]);

  const setSlideFrameAspectRatio = useCallback((aspectRatio: SlideFrameAspectRatio) => {
    slideFrameAspectRatioRef.current = aspectRatio;
    setProject((current) => current ? {
      ...current,
      updatedAt: nowIso(),
      slideFrameAspectRatio: aspectRatio,
      slideWidescreenFrames: undefined,
    } : current);
    if (slideFrameDrawingActiveRef.current && api) activateSlideFrameTool(api, aspectRatio);
  }, [api]);

  const toggleSlideMorph = useCallback(() => {
    setProject((current) => current ? {
      ...current,
      updatedAt: nowIso(),
      slideMorphEnabled: current.slideMorphEnabled !== true,
    } : current);
  }, []);

  const setSlideMorphDuration = useCallback((durationMs: number) => {
    setProject((current) => current ? {
      ...current,
      updatedAt: nowIso(),
      slideMorphDurationMs: normalizeSlideMorphDurationMs(durationMs),
    } : current);
  }, []);

  const deleteSlide = useCallback((slide: ClassroomSlide) => {
    if (!api || !project) return;
    if (!window.confirm(`Delete ${slide.title}? The frame will be removed, but its board content will stay.`)) return;

    // A keyboard/programmatic activation can reach this callback before the
    // global pointerup/keyup autosave boundary. Commit first because the frame
    // is deleted from stored scene data below while its content must survive.
    const currentProject = commitLiveScenePersistence(slide.sceneId);
    if (!currentProject) return;

    const slideIndex = currentProject.slideOrder.findIndex((candidate) => candidate.id === slide.id);
    const remainingSlides = removeSlide(currentProject.slideOrder, slide.id);
    const nextSlide = remainingSlides[Math.min(slideIndex, remainingSlides.length - 1)] || null;
    const deletingActiveSlide = activeSlideId === slide.id;
    const isActiveScene = slide.sceneId === activeSceneIdRef.current;
    const ownsSuppression = isActiveScene && !switchingSceneRef.current;
    const suppressionGeneration = sceneHydrationGenerationRef.current;

    if (isActiveScene) {
      if (ownsSuppression) switchingSceneRef.current = true;
      const activeSceneElements = syncSlideFrameNames(
        deleteSlideBoundary(api.getSceneElements(), slide.frameId),
        remainingSlides,
      );
      api.updateScene({
        elements: activeSceneElements,
        ...(deletingActiveSlide ? {
          appState: {
            selectedElementIds: {},
            selectedGroupIds: {},
            editingFrame: null,
          },
        } : {}),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }

    setProject((current) => {
      if (!current?.scenes[slide.sceneId]) return current;
      const scenes = Object.fromEntries(Object.entries(current.scenes).map(([sceneId, scene]) => {
        const source = scene.elements as unknown as readonly ExcalidrawElement[];
        const withoutBoundary = sceneId === slide.sceneId
          ? deleteSlideBoundary(source, slide.frameId)
          : source;
        const elements = syncSlideFrameNames(withoutBoundary, remainingSlides);
        return [sceneId, { ...scene, elements: elements as unknown as readonly Record<string, unknown>[] }];
      }));
      return {
        ...current,
        updatedAt: nowIso(),
        scenes,
        slideOrder: remainingSlides,
      };
    });
    if (deletingActiveSlide) setActiveSlideId(nextSlide?.id || null);
    api.setToast({ message: "Slide deleted. Its content is still on the board." });
    window.requestAnimationFrame(() => {
      if (ownsSuppression) {
        if (sceneHydrationGenerationRef.current !== suppressionGeneration) return;
        switchingSceneRef.current = false;
      }
      if (deletingActiveSlide && nextSlide) openSlide(nextSlide);
    });
  }, [activeSlideId, api, commitLiveScenePersistence, openSlide, project]);

  const reorderSlides = useCallback((slideId: string, targetId: string) => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const slideOrder = moveSlide(currentProject.slideOrder, slideId, targetId);
    const updatedAt = nowIso();
    const projectWithSlideOrder = (source: ClassroomProject): ClassroomProject => {
      const scenes = Object.fromEntries(Object.entries(source.scenes).map(([sceneId, scene]) => {
        const elements = syncSlideFrameNames(
          scene.elements as unknown as readonly ExcalidrawElement[],
          slideOrder,
        );
        return [sceneId, { ...scene, elements: elements as unknown as readonly Record<string, unknown>[] }];
      }));
      return { ...source, updatedAt, scenes, slideOrder };
    };
    projectRef.current = projectWithSlideOrder(currentProject);
    const activeSceneId = activeSceneIdRef.current;
    if (api && activeSceneId) {
      const currentElements = api.getSceneElements();
      const namedElements = syncSlideFrameNames(currentElements, slideOrder);
      if (namedElements !== currentElements) {
        api.updateScene({ elements: namedElements, captureUpdate: CaptureUpdateAction.NEVER });
      }
    }
    setProject((current) => {
      if (!current) return current;
      const next = projectWithSlideOrder(current);
      projectRef.current = next;
      return next;
    });
  }, [api]);

  const reorderPdfPage = useCallback((movingId: string, targetId: string, edge: PdfPageDropEdge) => {
    setProject((current) => current ? {
      ...current,
      updatedAt: nowIso(),
      pdfPageOrder: movePdfPage(reconcilePdfPageOrder(current), movingId, targetId, edge),
    } : current);
  }, []);

  const shiftPdfPagePosition = useCallback((sceneId: string, direction: -1 | 1) => {
    setProject((current) => current ? {
      ...current,
      updatedAt: nowIso(),
      pdfPageOrder: shiftPdfPage(reconcilePdfPageOrder(current), sceneId, direction),
    } : current);
  }, []);

  const requestPdfAnnotationClear = useCallback((sceneId: string) => {
    try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const currentProject = commitLiveScenePersistence(sceneId, true);
      const scene = currentProject?.scenes[sceneId];
      if (!currentProject || !scene?.pdfPage) {
        throw new Error("The selected PDF page no longer exists.");
      }
      const summaries = pdfAnnotationScopeSummaries(currentProject, sceneId);
      setErrorMessage(null);
      setPendingPdfAnnotationClear({
        projectId: currentProject.id,
        sceneId,
        summaries,
        sourceName: scene.pdfPage.sourceName
          || currentProject.pdfDocuments[scene.pdfPage.documentId]?.name,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [abortSceneOperations, cancelFileOpenOperations, commitLiveScenePersistence]);

  const closePdfAnnotationClearDialog = useCallback(() => {
    setPendingPdfAnnotationClear(null);
  }, []);

  const confirmPdfAnnotationClear = useCallback((scope: PdfAnnotationClearScope) => {
    const pending = pendingPdfAnnotationClear;
    if (!pending) return;
    try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const currentProject = commitLiveScenePersistence(pending.sceneId, true);
      if (!currentProject || currentProject.id !== pending.projectId) {
        throw new Error("The PDF document changed before annotations could be cleared.");
      }
      const freshSummaries = pdfAnnotationScopeSummaries(currentProject, pending.sceneId);
      if (!pdfAnnotationSummaryMatches(pending.summaries[scope], freshSummaries[scope])) {
        const scene = currentProject.scenes[pending.sceneId];
        setPendingPdfAnnotationClear({
          ...pending,
          summaries: freshSummaries,
          sourceName: scene?.pdfPage?.sourceName
            || (scene?.pdfPage
              ? currentProject.pdfDocuments[scene.pdfPage.documentId]?.name
              : pending.sourceName),
        });
        setErrorMessage("Annotations changed while this dialog was open. Review the updated counts, then confirm again.");
        return;
      }
      setErrorMessage(null);
      const now = Date.now();
      const cleared = clearPdfAnnotations(currentProject, pending.sceneId, scope, {
        now,
        updatedAt: nowIso(),
      });
      // Replace an older reversible action only after every validation and
      // the new atomic clear have succeeded. A stale confirmation or failed
      // clear attempt must not consume the still-valid prior Undo.
      finalizePendingPdfUndo();
      const activeSceneId = activeSceneIdRef.current || cleared.project.activeSceneId;
      const activeScene = cleared.project.scenes[activeSceneId];
      const activeSceneWasCleared = cleared.transaction.affectedPageIds.includes(activeSceneId);
      const token = ++pdfUndoTokenRef.current;

      pendingProjectSearchTargetRef.current = null;
      projectRef.current = cleared.project;
      activeSceneIdRef.current = cleared.project.activeSceneId;
      pendingPdfUndoRef.current = {
        kind: "clear-annotations",
        token,
        transaction: cleared.transaction,
      };
      pdfUndoTimerRef.current = window.setTimeout(() => {
        if (pendingPdfUndoRef.current?.token === token) {
          finalizePendingPdfUndo();
        }
      }, Math.max(0, cleared.transaction.expiresAt - Date.now()));
      setPdfUndoToast({
        kind: "clear-annotations",
        token,
        annotationCount: cleared.summary.annotationCount,
        affectedPageCount: cleared.summary.affectedPageCount,
        expiresAt: cleared.transaction.expiresAt,
      });
      setPendingPdfAnnotationClear(null);
      setProject(cleared.project);
      if (activeSceneWasCleared && activeScene) loadSceneIntoEditor(activeScene);
    } catch (error) {
      setPendingPdfAnnotationClear(null);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    abortSceneOperations,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    loadSceneIntoEditor,
    pendingPdfAnnotationClear,
  ]);

  const undoPendingPdfAction = useCallback(() => {
    const pending = pendingPdfUndoRef.current;
    if (!pending) return;
    const now = Date.now();
    if (now >= pending.transaction.expiresAt) {
      finalizePendingPdfUndo();
      return;
    }
    try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const activeSceneId = activeSceneIdRef.current
        || projectRef.current?.activeSceneId
        || "";
      const currentProject = commitLiveScenePersistence(activeSceneId, true);
      if (!currentProject) throw new Error("The current project is unavailable.");
      if (pending.kind === "delete-page") {
        const restored = undoPdfPageDelete(
          currentProject,
          pdfBytesRef.current,
          pending.transaction,
          { now, updatedAt: nowIso() },
        );
        if (getProjectContentSize(restored.project, restored.pdfBytes).totalBytes > MAX_PROJECT_BYTES) {
          setErrorMessage(
            "The deleted page could not be restored because the project is now too large to save safely. Remove recently added content and try Undo again before it expires.",
          );
          return;
        }
        const activeSceneWillChange = restored.project.activeSceneId !== currentProject.activeSceneId;
        finalizePendingPdfUndo();
        setErrorMessage(null);
        pendingProjectSearchTargetRef.current = null;
        if (activeSceneWillChange) beginSceneHydration();
        pdfBytesRef.current = restored.pdfBytes;
        projectRef.current = restored.project;
        activeSceneIdRef.current = restored.project.activeSceneId;
        setPdfBytes(restored.pdfBytes);
        setProject(restored.project);
        setWorkspaceMode("pdf");
        return;
      }
      const restored = undoPdfAnnotationClear(currentProject, pending.transaction, {
        now,
        updatedAt: nowIso(),
      });
      const activeScene = restored.project.scenes[activeSceneId];
      const activeSceneWasRestored = restored.affectedPageIds.includes(activeSceneId);

      if (!pdfAnnotationUndoFitsContentBudget(restored.project, pdfBytesRef.current)) {
        setErrorMessage(
          "Annotations could not be restored because the project is now too large to save safely. Remove recently added content and try Undo again before it expires.",
        );
        return;
      }

      finalizePendingPdfUndo();
      setErrorMessage(null);
      pendingProjectSearchTargetRef.current = null;
      projectRef.current = restored.project;
      activeSceneIdRef.current = restored.project.activeSceneId;
      setProject(restored.project);
      if (activeSceneWasRestored && activeScene) loadSceneIntoEditor(activeScene);
    } catch (error) {
      finalizePendingPdfUndo();
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    abortSceneOperations,
    beginSceneHydration,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    loadSceneIntoEditor,
  ]);

  useEffect(() => {
    if (!pendingPdfAnnotationClear) return;
    if (
      project?.id === pendingPdfAnnotationClear.projectId
      && project.activeSceneId === pendingPdfAnnotationClear.sceneId
    ) return;
    setPendingPdfAnnotationClear(null);
  }, [pendingPdfAnnotationClear, project?.activeSceneId, project?.id]);

  const duplicatePdfPageAction = useCallback((sceneId: string) => {
    try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const currentProject = commitLiveScenePersistence(sceneId, true);
      if (!currentProject?.scenes[sceneId]?.pdfPage) {
        throw new Error("The selected PDF page no longer exists.");
      }
      const duplicated = duplicatePdfPage(
        currentProject,
        pdfBytesRef.current,
        sceneId,
        {
          updatedAt: nowIso(),
          validateCandidate: (candidate, candidatePdfBytes) => {
            assertPdfAdditionPreservesPendingUndo(
              candidate,
              candidatePdfBytes,
              pendingPdfUndoRef.current,
            );
          },
        },
      );
      beginSceneHydration();
      pendingFrameIdRef.current = null;
      pendingProjectSearchTargetRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = null;
      projectRef.current = duplicated.project;
      activeSceneIdRef.current = duplicated.project.activeSceneId;
      setProject(duplicated.project);
      setWorkspaceMode("pdf");
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    abortSceneOperations,
    beginSceneHydration,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
  ]);

  const rotatePdfPageAction = useCallback((
    sceneId: string,
    direction: PdfPageRotationDirection,
  ) => {
    try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const currentProject = commitLiveScenePersistence(sceneId, true);
      const scene = currentProject?.scenes[sceneId];
      if (!currentProject || !scene?.pdfPage) {
        throw new Error("The selected PDF page no longer exists.");
      }
      const rotatedScene = rotatePdfSceneQuarterTurn(scene, direction);
      const rotatedProject: ClassroomProject = {
        ...currentProject,
        updatedAt: nowIso(),
        scenes: { ...currentProject.scenes, [sceneId]: rotatedScene },
      };
      assertProjectFitsContentBudget(rotatedProject, pdfBytesRef.current);
      // Rotation is destructive wrapper state. Replace an older reversible
      // action only after the complete rotated candidate has passed safety.
      finalizePendingPdfUndo();
      pendingProjectSearchTargetRef.current = null;
      projectRef.current = rotatedProject;
      activeSceneIdRef.current = rotatedProject.activeSceneId;
      setProject(rotatedProject);
      if (rotatedProject.activeSceneId === sceneId) loadSceneIntoEditor(rotatedScene);
      setWorkspaceMode("pdf");
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    abortSceneOperations,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    loadSceneIntoEditor,
  ]);

  const deletePdfPage = useCallback((sceneId: string) => {
    const initialProject = projectRef.current;
    if (!initialProject) return;
    const initialScene = initialProject.scenes[sceneId];
    if (!initialScene?.pdfPage) return;
    const initialOrder = reconcilePdfPageOrder(initialProject);
    const initialPageIndex = initialOrder.indexOf(sceneId);
    if (initialPageIndex < 0) return;
    if (!window.confirm(
      `Delete output page ${initialPageIndex + 1}? This removes the page and its annotations from the project. You can undo for ten seconds.`,
    )) return;
    try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      // Capture the newest live stroke and retained tombstones before the
      // scene leaves the project map and becomes the memory-only undo record.
      const currentProject = commitLiveScenePersistence(sceneId, true);
      if (!currentProject) throw new Error("The current project is unavailable.");
      const deleted = deletePdfPageReversibly(
        currentProject,
        pdfBytesRef.current,
        sceneId,
        { updatedAt: nowIso() },
      );
      // Failed validation or a cancelled confirmation must not consume the
      // previous Undo. Replace it only after the deletion candidate exists.
      finalizePendingPdfUndo();
      const token = ++pdfUndoTokenRef.current;
      pendingPdfUndoRef.current = {
        kind: "delete-page",
        token,
        transaction: deleted.transaction,
      };
      pdfUndoTimerRef.current = window.setTimeout(() => {
        if (pendingPdfUndoRef.current?.token === token) finalizePendingPdfUndo();
      }, Math.max(0, deleted.transaction.expiresAt - Date.now()));
      setPdfUndoToast({
        kind: "delete-page",
        token,
        deletedPageNumber: deleted.deletedPageNumber,
        expiresAt: deleted.transaction.expiresAt,
      });

      if (deleted.project.activeSceneId !== currentProject.activeSceneId) beginSceneHydration();
      pendingFrameIdRef.current = null;
      pendingProjectSearchTargetRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = null;
      pdfBytesRef.current = deleted.pdfBytes;
      projectRef.current = deleted.project;
      activeSceneIdRef.current = deleted.project.activeSceneId;
      setPdfBytes(deleted.pdfBytes);
      setProject(deleted.project);
      setWorkspaceMode(reconcilePdfPageOrder(deleted.project).length ? "pdf" : "board");
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    abortSceneOperations,
    beginSceneHydration,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
  ]);

  const addPdfPage = useCallback(async () => {
    const workspace = currentScene?.pdfPage;
    if (!workspace || !project) return;
    const insertAfterId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || projectRef.current?.activeSceneId
      || project.activeSceneId;
    const sourceProjectId = projectRef.current?.id || project.id;
    const sourceSceneId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || projectRef.current?.activeSceneId
      || project.activeSceneId;
    const sourceHydrationGeneration = sceneHydrationGenerationRef.current;
    const operation = beginFileOpenOperation();
    const isCurrentFileOperation = () => isCurrentFileOpenOperation(operation);
    const isCurrentOperation = () => (
      isCurrentFileOperation()
      && projectRef.current?.id === sourceProjectId
      && activeSceneIdRef.current === sourceSceneId
      && sceneHydrationGenerationRef.current === sourceHydrationGeneration
    );
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
    };
    setBusyCanCancel(true);
    setErrorMessage(null);
    setBusyMessage("Adding a blank PDF page…");
    try {
      const sourceProject = projectRef.current;
      if (!sourceProject) return;
      assertProjectCanAcceptPdfPages(sourceProject, 1);
      const [{ importPdf }, { createBlankPdfFile }] = await Promise.all([
        import("./lib/pdf/import-pdf"),
        import("./lib/pdf/create-blank-page"),
      ]);
      const display = getPdfPageDisplayGeometry(workspace);
      const blankPdf = await createBlankPdfFile(display.width, display.height);
      if (!isCurrentOperation()) return;
      const sourceSize = assertProjectCanAcceptAdditionalBytes(
        sourceProject,
        pdfBytesRef.current,
        blankPdf.size,
      );
      const maxEncodedBytesPerDocument = Math.max(
        0,
        Math.floor((MAX_PROJECT_BYTES - sourceSize.totalBytes - blankPdf.size) * 3 / 4),
      );
      const imported = await importPdf(blankPdf, {
        maxEncodedBytesPerDocument,
        maxPages: remainingProjectSceneCapacity(sourceProject),
        onProgress: (progress) => {
          if (isCurrentOperation()) setBusyMessage(pdfOperationProgressMessage(progress));
        },
        signal: operation.signal,
      });
      if (!isCurrentOperation()) return;
      const importedScene = imported.scenes[0];
      const scene = {
        ...importedScene,
        name: "Blank page",
        pdfPage: importedScene.pdfPage
          ? { ...importedScene.pdfPage, sourceName: "Blank page" }
          : undefined,
      };
      const source = { ...imported.source, name: "Blank page" };
      const current = commitLiveScenePersistence(sourceSceneId);
      if (!current || !isCurrentOperation()) return;
      const order = reconcilePdfPageOrder(current);
      const currentIndex = order.indexOf(insertAfterId);
      const insertAt = currentIndex < 0 ? order.length : currentIndex + 1;
      const nextPdfBytes = { ...pdfBytesRef.current, [source.id]: imported.bytes };
      const nextProject: ClassroomProject = {
        ...current,
        updatedAt: nowIso(),
        activeSceneId: scene.id,
        scenes: { ...current.scenes, [scene.id]: scene },
        pdfPageOrder: [...order.slice(0, insertAt), scene.id, ...order.slice(insertAt)],
        pdfDocuments: { ...current.pdfDocuments, [source.id]: source },
      };
      assertProjectFitsContentBudget(nextProject, nextPdfBytes);
      assertPdfAdditionPreservesPendingUndo(
        nextProject,
        nextPdfBytes,
        pendingPdfUndoRef.current,
      );
      beginSceneHydration();
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = null;
      pdfBytesRef.current = nextPdfBytes;
      projectRef.current = nextProject;
      activeSceneIdRef.current = nextProject.activeSceneId;
      setPdfBytes(nextPdfBytes);
      setProject(nextProject);
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (fileOpenGenerationRef.current === operation.generation) {
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
      }
    }
  }, [
    beginFileOpenOperation,
    beginSceneHydration,
    commitLiveScenePersistence,
    currentScene?.pdfPage,
    isCurrentFileOpenOperation,
    project,
  ]);

  const openPdfInsertFilePicker = useCallback(() => {
    const currentProject = projectRef.current;
    const selectedPageId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || currentProject?.activeSceneId;
    if (!currentProject || !selectedPageId || !currentProject.scenes[selectedPageId]?.pdfPage) {
      setErrorMessage("Select a PDF page before inserting more PDF pages.");
      return;
    }
    if (remainingProjectSceneCapacity(currentProject) < 1) {
      setErrorMessage("This project has reached its page and scene limit.");
      return;
    }
    setErrorMessage(null);
    pdfInsertInputRef.current?.click();
  }, []);

  const inspectPdfInsertFiles = useCallback(async (files: readonly File[]) => {
    if (!files.length) return;
    const sourceProject = projectRef.current;
    const selectedPageId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || sourceProject?.activeSceneId;
    if (!sourceProject || !selectedPageId || !sourceProject.scenes[selectedPageId]?.pdfPage) {
      setErrorMessage("Select a PDF page before inserting more PDF pages.");
      return;
    }
    try {
      // Every selected file must contribute at least one page. This cheap
      // lower-bound gate prevents an impossible oversized file list from
      // triggering hundreds of sequential PDF parser starts.
      assertProjectCanAcceptPdfPages(sourceProject, files.length);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    const sourceProjectId = sourceProject.id;
    const sourceHydrationGeneration = sceneHydrationGenerationRef.current;
    const operation = beginFileOpenOperation();
    const isCurrentOperation = () => (
      isCurrentFileOpenOperation(operation)
      && projectRef.current?.id === sourceProjectId
      && activeSceneIdRef.current === selectedPageId
      && sceneHydrationGenerationRef.current === sourceHydrationGeneration
    );
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
    };
    setBusyCanCancel(true);
    setBusyMessage(`Inspecting ${files[0].name}…`);
    setErrorMessage(null);
    try {
      const { inspectPdfFile } = await import("./lib/pdf/import-pdf");
      const inspected: PendingPdfInsertFile[] = [];
      const knownSources = new Map(
        Object.values(sourceProject.pdfDocuments)
          .filter((source) => !!source.sha256)
          .map((source) => [source.sha256 as string, source]),
      );
      let additionalSourceBytes = 0;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const inspection = await inspectPdfFile(file, {
          documentPosition: index + 1,
          documentTotal: files.length,
          onProgress: (progress) => {
            if (isCurrentOperation()) setBusyMessage(pdfOperationProgressMessage(progress));
          },
          signal: operation.signal,
        });
        if (!isCurrentOperation()) return;
        const existing = knownSources.get(inspection.sha256);
        if (existing) {
          if (existing.byteLength !== file.size || existing.pageCount !== inspection.pageCount) {
            throw new Error(`The stored PDF source does not match ${file.name}.`);
          }
        } else {
          additionalSourceBytes += file.size;
          if (!Number.isSafeInteger(additionalSourceBytes)) {
            throw new Error("The selected PDF files are too large to insert safely.");
          }
          // Stop inspecting the batch as soon as its unique immutable source
          // bytes cannot fit. Parsing every remaining file would be expensive
          // work for a transaction that is already impossible to commit.
          assertProjectCanAcceptAdditionalBytes(
            sourceProject,
            pdfBytesRef.current,
            additionalSourceBytes,
          );
          knownSources.set(inspection.sha256, {
            id: "pending",
            name: file.name,
            mimeType: "application/pdf",
            byteLength: file.size,
            sha256: inspection.sha256,
            pageCount: inspection.pageCount,
            archivePath: "documents/pending.pdf",
          });
        }
        inspected.push({
          file,
          id: createLocalId(),
          name: file.name,
          pageCount: inspection.pageCount,
          rangeText: defaultPdfPageRange(inspection.pageCount),
          sha256: inspection.sha256,
        });
      }
      if (!isCurrentOperation()) return;
      setPendingPdfInsert({
        files: inspected,
        projectId: sourceProjectId,
        selectedPageId,
        hydrationGeneration: sourceHydrationGeneration,
      });
      setPdfInsertProgress(null);
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (fileOpenGenerationRef.current === operation.generation) {
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
      }
    }
  }, [beginFileOpenOperation, isCurrentFileOpenOperation]);

  const closePdfInsertDialog = useCallback(() => {
    if (pdfInsertProcessing) return;
    setPendingPdfInsert(null);
    setPdfInsertProgress(null);
    setPdfInsertCancelling(false);
  }, [pdfInsertProcessing]);

  const cancelPdfInsertion = useCallback(() => {
    const generation = pdfInsertOperationGenerationRef.current;
    if (generation === null || fileOpenGenerationRef.current !== generation) return;
    setPdfInsertCancelling(true);
    fileOpenAbortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!pendingPdfInsert) return;
    if (
      project?.id === pendingPdfInsert.projectId
      && project.activeSceneId === pendingPdfInsert.selectedPageId
      && sceneHydrationGenerationRef.current === pendingPdfInsert.hydrationGeneration
    ) return;
    const generation = pdfInsertOperationGenerationRef.current;
    if (generation !== null && fileOpenGenerationRef.current === generation) {
      fileOpenAbortControllerRef.current?.abort();
    }
    pdfInsertOperationGenerationRef.current = null;
    setPendingPdfInsert(null);
    setPdfInsertProcessing(false);
    setPdfInsertCancelling(false);
    setPdfInsertProgress(null);
  }, [pendingPdfInsert, project?.activeSceneId, project?.id, projectHydrationRevision]);

  const submitPdfInsertion = useCallback(async (submission: PdfInsertSubmission) => {
    const pending = pendingPdfInsert;
    if (!pending || pdfInsertProcessing) return;
    const operation = beginFileOpenOperation();
    pdfInsertOperationGenerationRef.current = operation.generation;
    const isCurrentOperation = () => (
      isCurrentFileOpenOperation(operation)
      && projectRef.current?.id === pending.projectId
      && activeSceneIdRef.current === pending.selectedPageId
      && sceneHydrationGenerationRef.current === pending.hydrationGeneration
    );
    setPdfInsertProcessing(true);
    setPdfInsertCancelling(false);
    setPdfInsertProgress(null);
    setErrorMessage(null);
    try {
      const sourceProject = commitLiveScenePersistence(pending.selectedPageId);
      if (!sourceProject || !isCurrentOperation()) return;
      const filesById = new Map(pending.files.map((file) => [file.id, file]));
      const selections = submission.selections.map((selection) => {
        const source = filesById.get(selection.id);
        if (!source) throw new Error("A selected PDF is no longer available.");
        return {
          file: source.file,
          pageCount: source.pageCount,
          sha256: source.sha256,
          sourceInstanceId: source.id,
          sourcePageIndices: selection.pageIndices,
        };
      });
      const { importPdfBatchAtomically } = await import("./lib/pdf/batch-import");
      const imported = await importPdfBatchAtomically(
        sourceProject,
        pdfBytesRef.current,
        selections,
        submission.placement,
        pending.selectedPageId,
        {
          onProgress: (progress) => {
            if (!isCurrentOperation()) return;
            setPdfInsertProgress({
              ...progress,
              message: pdfOperationProgressMessage(progress),
            });
          },
          signal: operation.signal,
        },
      );
      if (!isCurrentOperation()) return;
      assertPdfAdditionPreservesPendingUndo(
        imported.project,
        imported.pdfBytes,
        pendingPdfUndoRef.current,
      );
      beginSceneHydration();
      pendingFrameIdRef.current = null;
      pendingProjectSearchTargetRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = null;
      pdfBytesRef.current = imported.pdfBytes;
      projectRef.current = imported.project;
      activeSceneIdRef.current = imported.project.activeSceneId;
      setPdfBytes(imported.pdfBytes);
      setProject(imported.project);
      setWorkspaceMode("pdf");
      setPendingPdfInsert(null);
      setPdfInsertProgress(null);
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (pdfInsertOperationGenerationRef.current === operation.generation) {
        pdfInsertOperationGenerationRef.current = null;
        setPdfInsertProcessing(false);
        setPdfInsertCancelling(false);
      }
    }
  }, [
    beginFileOpenOperation,
    beginSceneHydration,
    commitLiveScenePersistence,
    isCurrentFileOpenOperation,
    pdfInsertProcessing,
    pendingPdfInsert,
  ]);

  useEffect(() => {
    const handleDocumentPasteCapture = (event: ClipboardEvent) => {
      const host = editorHostRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement;
      if (
        !host
        || (!target || (!host.contains(target) && (!activeElement || !host.contains(activeElement))))
        || target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
      ) return;
      const clipboard = event.clipboardData;
      try {
        assertClipboardTextPayloadsWithinLimit(
          clipboard?.getData("text/plain"),
          clipboard?.getData("text/html"),
        );
      } catch (error) {
        event.preventDefault();
        event.stopImmediatePropagation();
        api?.setToast({ message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (clipboardHtmlContainsBlockedContent(
        clipboard?.getData("text/html"),
        Array.from(clipboard?.files || []).some((file) => (
          isSafeLocalImageClipboardType(file.type)
        )),
      )) {
        event.preventDefault();
        event.stopImmediatePropagation();
        api?.setToast({ message: "Embedded web content and URL-backed images are disabled." });
        return;
      }
      const geoGonSvg = geoGonSvgFromClipboardText(clipboard?.getData("text/plain"));
      if (!geoGonSvg || !api) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const appState = api.getAppState();
      void insertDroppedLocalImage(
        new File([geoGonSvg], "3DGeoGon-diagram.svg", { type: "image/svg+xml" }),
        {
          clientX: appState.offsetLeft + appState.width / 2,
          clientY: appState.offsetTop + appState.height / 2,
        },
        "image/svg+xml",
        { classroomGeoGon: { transfer: "svg", version: 1 } },
      );
    };
    document.addEventListener("paste", handleDocumentPasteCapture, true);
    return () => document.removeEventListener("paste", handleDocumentPasteCapture, true);
  }, [api, insertDroppedLocalImage]);

  const handlePaste = useCallback<NonNullable<ExcalidrawProps["onPaste"]>>(async (data, event) => {
    const clipboard = event?.clipboardData;
    try {
      // Excalidraw JSON clipboard payloads reach this callback before its
      // restore/addFiles path. Bound the complete graph before any wrapper or
      // dependency code walks, clones, or decodes it.
      assertSceneStructure({
        elements: data.elements || [],
        appState: {},
        files: data.files || {},
      }, { label: "Clipboard drawing" });
    } catch (error) {
      api?.setToast({ message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (
      clipboardHtmlContainsBlockedContent(
        clipboard?.getData("text/html"),
        Array.from(clipboard?.files || []).some((file) => (
          isSafeLocalImageClipboardType(file.type)
        )),
      )
      || clipboardElementsContainBlockedContent(data.elements)
    ) {
      api?.setToast({ message: "Embedded web content and URL-backed images are disabled." });
      return false;
    }
    const projectId = projectRef.current?.id;
    const sceneId = activeSceneIdRef.current;
    const hydrationGeneration = sceneHydrationGenerationRef.current;
    try {
      const incomingFiles = Object.entries(data.files || {});
      if (incomingFiles.length > MAX_EXCALIDRAW_CLIPBOARD_IMAGE_FILES) {
        throw new Error("The clipboard contains too many images to paste safely.");
      }
      const currentProject = projectRef.current;
      if (!currentProject || !sceneId) return false;
      const existingFiles = currentProject.scenes[sceneId]?.files || {};
      const newFiles: Record<string, unknown> = {};
      for (const [fileId, file] of incomingFiles) {
        const info = await inspectLocalImageDataUrl(file.dataURL);
        if (
          info.width > MAX_EXCALIDRAW_CLIPBOARD_IMAGE_EDGE
          || info.height > MAX_EXCALIDRAW_CLIPBOARD_IMAGE_EDGE
          || info.encodedBytes > MAX_EXCALIDRAW_CLIPBOARD_IMAGE_BYTES
        ) {
          throw new Error(
            "Paste this image directly or use the Image tool so PatterDraw can resize it safely.",
          );
        }
        if (!Object.hasOwn(existingFiles, fileId)) newFiles[fileId] = file;
      }
      assertProjectCanAcceptAdditionalBytes(
        currentProject,
        pdfBytesRef.current,
        getJsonUtf8ByteLength({ elements: data.elements || [], files: newFiles }),
      );
    } catch (error) {
      api?.setToast({ message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (
      !projectId
      || !sceneId
      || switchingSceneRef.current
      || projectRef.current?.id !== projectId
      || activeSceneIdRef.current !== sceneId
      || sceneHydrationGenerationRef.current !== hydrationGeneration
    ) return false;
    return true;
  }, [api]);

  const handleEditorClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-testid="lib-dropdown--load"]')) {
      // Own the native library chooser so its bytes and recursive shape are
      // checked before Excalidraw's migration/restore code can traverse them.
      const menuTrigger = editorHostRef.current?.querySelector<HTMLButtonElement>(
        '.layer-ui__library [data-testid="dropdown-menu-button"]',
      );
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      libraryInputRef.current?.click();
      // Stopping the native menu item's event also prevents Excalidraw from
      // clearing its internal open state. Close it after preserving the
      // synchronous user gesture used to launch the local file chooser.
      globalThis.queueMicrotask(() => {
        if (menuTrigger?.isConnected) menuTrigger.click();
      });
      return;
    }
    if (
      safeClipboardReadGuardRef.current
      || !target?.closest('.context-menu [data-testid="paste"]')
    ) return;
    event.preventDefault();
    event.stopPropagation();
    api?.setToast({ message: "Use Ctrl/⌘+V to paste local content safely." });
  }, [api]);

  const generateNativeImageFileId = useCallback<NonNullable<ExcalidrawProps["generateIdForFile"]>>(
    async (file) => {
      const projectId = projectRef.current?.id;
      const sceneId = activeSceneIdRef.current;
      const hydrationGeneration = sceneHydrationGenerationRef.current;
      if (!projectId || !sceneId || switchingSceneRef.current) {
        throw new DOMException("The canvas changed before the image was ready.", "AbortError");
      }
      const fileId = await generateSafeLocalImageFileId(file);
      if (
        switchingSceneRef.current
        || projectRef.current?.id !== projectId
        || activeSceneIdRef.current !== sceneId
        || sceneHydrationGenerationRef.current !== hydrationGeneration
      ) {
        throw new DOMException("The canvas changed before the image was ready.", "AbortError");
      }
      return fileId;
    },
    [],
  );

  const handleEditorKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    // Project Find owns keyboard interaction inside its query/results. Keep
    // editor-level shortcuts from consuming a focused button's activation.
    if (target?.closest(".project-find-panel")) return;
    if (
      !presentationRef.current
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === "b"
      && !target?.isContentEditable
      && !target?.closest("input, textarea, select, [role='dialog']")
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      startBucketFill();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      api?.setToast({ message: "External links are disabled in PatterDraw." });
    }
  }, [api, startBucketFill]);

  const handleLinkOpen = useCallback<NonNullable<ExcalidrawProps["onLinkOpen"]>>((_element, event) => {
    event.preventDefault();
    api?.setToast({ message: "External links are disabled in PatterDraw." });
  }, [api]);

  const renderConstrainedFramePreview = useCallback((bounds: SlideFrameBounds) => {
    const preview = frameDragPreviewRef.current;
    const host = editorHostRef.current;
    if (!api || !preview || !host) return;
    const appState = api.getAppState();
    const hostBounds = host.getBoundingClientRect();
    const topLeft = sceneCoordsToViewportCoords(
      { sceneX: bounds.x, sceneY: bounds.y },
      appState,
    );
    const bottomRight = sceneCoordsToViewportCoords(
      { sceneX: bounds.x + bounds.width, sceneY: bounds.y + bounds.height },
      appState,
    );
    preview.hidden = false;
    preview.dataset.aspectRatio = slideFrameAspectRatioRef.current;
    preview.style.transform = `translate3d(${topLeft.x - hostBounds.left}px, ${topLeft.y - hostBounds.top}px, 0)`;
    preview.style.width = `${Math.max(0, bottomRight.x - topLeft.x)}px`;
    preview.style.height = `${Math.max(0, bottomRight.y - topLeft.y)}px`;
  }, [api]);

  const handleEditorPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const sidebarTrigger = target?.closest(".default-sidebar .sidebar-tab-trigger");
    const triggerList = sidebarTrigger?.parentElement;
    if (sidebarTrigger && triggerList?.querySelector(".sidebar-tab-trigger") === sidebarTrigger) {
      nativeCanvasSearchOpenRef.current = true;
    }
    captureMathInteractionPoint(event);
  }, [captureMathInteractionPoint]);

  const slideBoundsForGesture = useCallback((gesture: SlideFrameGesture): SlideFrameBounds => {
    const aspectRatio = slideFrameAspectRatioValue(slideFrameAspectRatioRef.current);
    return aspectRatio
      ? frameBoundsFromDrag(gesture.origin, gesture.current, aspectRatio)
      : freeformFrameBoundsFromDrag(gesture.origin, gesture.current);
  }, []);

  const beginSlideFramePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!api || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic browser tests and a few touch engines can omit capture
      // bookkeeping; the full-screen overlay still receives the gesture.
    }
    const origin = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      api.getAppState(),
    );
    slideFrameGestureRef.current = {
      current: origin,
      origin,
      pointerId: event.pointerId,
    };
    hideConstrainedFramePreview();
  }, [api, hideConstrainedFramePreview]);

  const updateSlideFramePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = slideFrameGestureRef.current;
    if (!api || !gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    gesture.current = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      api.getAppState(),
    );
    const bounds = slideBoundsForGesture(gesture);
    if (bounds.width >= 1 && bounds.height >= 1) renderConstrainedFramePreview(bounds);
  }, [api, renderConstrainedFramePreview, slideBoundsForGesture]);

  const finishSlideFramePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = slideFrameGestureRef.current;
    if (!api || !gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = viewportCoordsToSceneCoords(
      { clientX: event.clientX, clientY: event.clientY },
      api.getAppState(),
    );
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const bounds = slideBoundsForGesture(gesture);
    if (bounds.width >= 4 && bounds.height >= 4) {
      const frameId = createLocalId();
      pendingCreatedFrameIdRef.current = frameId;
      addSlideFrameAtBounds(api, bounds, `Slide ${(project?.slideOrder.length || 0) + 1}`, frameId);
    } else {
      api.setToast({ message: "Drag farther to create a slide." });
    }
    stopSlideFrameDrawing();
  }, [api, project?.slideOrder.length, slideBoundsForGesture, stopSlideFrameDrawing]);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && slideFrameDrawingActiveRef.current) {
        event.preventDefault();
        event.stopPropagation();
        stopSlideFrameDrawing();
      }
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    return () => window.removeEventListener("keydown", cancelOnEscape, true);
  }, [stopSlideFrameDrawing]);

  const defaultSidebar = useMemo(() => (
    <DefaultSidebar>
      {featurePreferences.library ? (
        <>
          <DefaultSidebar.TabTriggers>
            <Sidebar.TabTrigger
              tab={SCREENSHOT_SIDEBAR_TAB}
              aria-label="Screenshot Library"
              title="Screenshot Library"
            >
              <ScreenshotIcon />
            </Sidebar.TabTrigger>
          </DefaultSidebar.TabTriggers>
          <Sidebar.Tab tab={SCREENSHOT_SIDEBAR_TAB}>
            <ScreenshotLibrary
              busy={isScreenshotBusy}
              loading={isScreenshotLibraryLoading}
              items={screenshots}
              onCaptureArea={startScreenshotCapture}
              onCopy={copyScreenshot}
              onDelete={deleteScreenshot}
              onDownload={downloadScreenshot}
              onInsert={(item) => void insertScreenshot(item)}
            />
          </Sidebar.Tab>
        </>
      ) : null}
      {featurePreferences.projectFind && project ? (
        <>
          <DefaultSidebar.TabTriggers>
            <Sidebar.TabTrigger
              tab={PROJECT_FIND_SIDEBAR_TAB}
              aria-label="Project Find"
              title="Project Find"
            >
              <SearchIcon />
            </Sidebar.TabTrigger>
          </DefaultSidebar.TabTriggers>
          <Sidebar.Tab tab={PROJECT_FIND_SIDEBAR_TAB}>
            <ProjectFindPanel
              project={project}
              onActivate={activateProjectSearchResult}
              onClose={toggleProjectFind}
              onOpenCanvasSearch={openCurrentCanvasSearch}
            />
          </Sidebar.Tab>
        </>
      ) : null}
    </DefaultSidebar>
  ), [
    activateProjectSearchResult,
    copyScreenshot,
    deleteScreenshot,
    downloadScreenshot,
    featurePreferences.library,
    featurePreferences.projectFind,
    insertScreenshot,
    isScreenshotBusy,
    isScreenshotLibraryLoading,
    openCurrentCanvasSearch,
    project,
    screenshots,
    startScreenshotCapture,
    toggleProjectFind,
  ]);

  if (!project || !currentScene) return <div className="loading-screen">Opening PatterDraw…</div>;

  return (
    <div
      ref={shellRef}
      className={`app-shell ${workspaceModeClassName(workspaceMode)} ${workspaceMode === "slides" && !isSlideRailVisible ? "is-slide-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfRailVisible ? "is-pdf-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfToolbarVisible ? "is-pdf-toolbar-hidden" : ""} ${!isNavigationVisible ? "is-nav-hidden" : ""} ${!isFooterVisible ? "is-footer-hidden" : ""} ${!featurePreferences.projectFind ? "is-project-find-disabled" : ""} ${!featurePreferences.library ? "is-library-disabled" : ""} ${featurePreferences.iconOnlyControls ? "is-icon-only-controls" : ""} ${presentation ? "is-presenting" : ""}`}
      data-theme={editorTheme}
      style={{ "--pdf-rail-width": `${pdfRailWidth}px` } as CSSProperties}
    >
      {!presentation && isNavigationVisible && (
        <TopBar
          title={project.title}
          status={saveStatus}
          featurePreferences={featurePreferences}
          pdfPreferences={pdfPreferences}
          themePreference={themePreference}
          onTitleChange={(title) => setProject((current) => current ? {
            ...current,
            title,
            titleMode: "custom",
            updatedAt: nowIso(),
          } : current)}
          onFeaturePreferenceChange={setFeaturePreference}
          onPdfPreferenceChange={setPdfPreference}
          onThemePreferenceChange={setThemePreference}
          onRestoreFeaturePreferences={restoreFeaturePreferences}
          onRestorePdfPreferences={restorePdfPreferences}
          onOpen={() => inputRef.current?.click()}
          onSave={saveProjectFile}
          onEquation={openEquationEditor}
          onMermaid={openMermaidEditor}
          onExportAll={() => void runFullBoardExport()}
          onExportOptions={() => setExportOpen(true)}
          insertButtonRef={insertTriggerRef}
          exportOptionsButtonRef={exportOptionsTriggerRef}
          mode={workspaceMode}
          onModeChange={changeWorkspaceMode}
          pdfAvailable={pdfScenes.length > 0}
          libraryAvailable={Boolean(api)}
          libraryOpen={isLibraryOpen}
          onLibraryToggle={toggleLibrary}
          sizePositionOpen={isSizePositionOpen}
          onSizePositionToggle={toggleSizePosition}
          projectFindOpen={isProjectFindOpen}
          projectFindButtonRef={projectFindTriggerRef}
          onProjectFindToggle={toggleProjectFind}
          onHide={() => setIsNavigationVisible(false)}
        />
      )}
      {autosaveRecoveryDetail && (
        <section
          className="autosave-recovery-banner"
          role="alert"
          aria-labelledby="autosave-recovery-title"
        >
          <div className="autosave-recovery-copy">
            <strong id="autosave-recovery-title">Autosave is paused</strong>
            <span>
              {autosaveRecoveryKind === "conflict" ? (
                <>Another tab saved a newer autosave. PatterDraw kept that newer stored copy and paused this tab, so this board is not saving automatically.</>
              ) : (
                <>Autosave could not be opened: {autosaveRecoveryDetail.replace(/[.!?]\s*$/, "")}. PatterDraw has not replaced that stored copy, and this temporary board is not saving automatically.</>
              )}
            </span>
          </div>
          <div className="autosave-recovery-actions">
            <button type="button" onClick={() => inputRef.current?.click()}>Open a replacement file</button>
            <button type="button" onClick={() => void saveProjectFile()}>Download this board</button>
            <button
              className="is-primary"
              type="button"
              onClick={() => void resumeAutosaveWithCurrentBoard()}
            >
              Use this board and resume autosave
            </button>
          </div>
        </section>
      )}
      {!presentation && workspaceMode === "slides" && isSlideRailVisible && (
        <button
          className="slide-rail-backdrop"
          type="button"
          aria-label="Close slide navigator"
          onClick={hideSlideRail}
        />
      )}
      {!presentation && workspaceMode === "pdf" && isPdfRailVisible && (
        <button
          className="slide-rail-backdrop"
          type="button"
          aria-label="Close PDF page navigator"
          onClick={hidePdfRail}
        />
      )}
      {!presentation && workspaceMode === "slides" && isSlideRailVisible && (
        <SlideRail
          project={project}
          activeSlideId={activeSlideId}
          onAddSlide={addSlide}
          frameDrawingActive={isSlideFrameDrawingActive}
          onToggleFrameDrawing={toggleSlideFrameDrawing}
          onOpenSlide={openSlideFromRail}
          onMoveSlide={reorderSlides}
          onDeleteSlide={deleteSlide}
          onHide={hideSlideRail}
          framesVisible={areSlideFramesVisible}
          onToggleFrames={toggleSlideFrames}
          frameAspectRatio={project.slideFrameAspectRatio ?? "freeform"}
          onFrameAspectRatioChange={setSlideFrameAspectRatio}
          morphEnabled={project.slideMorphEnabled === true}
          morphDurationMs={normalizeSlideMorphDurationMs(project.slideMorphDurationMs)}
          onToggleMorph={toggleSlideMorph}
          onMorphDurationChange={setSlideMorphDuration}
        />
      )}
      {!presentation && workspaceMode === "pdf" && isPdfRailVisible && (
        <PdfPageRail
          project={project}
          pages={pdfScenes}
          activeSceneId={project.activeSceneId}
          thumbnailDataUrls={editorTheme === "dark" && pdfPreferences.darkPdfPreview
            ? darkPdfPreviewUrls
            : undefined}
          onOpenPage={openPdfPageFromRail}
          onMovePage={reorderPdfPage}
          onShiftPage={shiftPdfPagePosition}
          onAddBlankPage={() => void addPdfPage()}
          onInsertPdfPages={openPdfInsertFilePicker}
          addPageTriggerRef={pdfInsertTriggerRef}
          pageActionsTriggerRef={pdfPageActionsTriggerRef}
          onDuplicatePage={duplicatePdfPageAction}
          onRotatePage={rotatePdfPageAction}
          onRequestClearAnnotations={requestPdfAnnotationClear}
          onDeletePage={deletePdfPage}
          width={pdfRailWidth}
          onWidthChange={setPdfRailWidth}
          onHide={hidePdfRail}
        />
      )}
      <main
        className="editor-region"
        data-presentation-zoom={presentation ? zoom : undefined}
        data-slide-transition={presentation ? (project.slideMorphEnabled === true ? "morph" : "none") : undefined}
        data-morph-duration-ms={presentation ? normalizeSlideMorphDurationMs(project.slideMorphDurationMs) : undefined}
        onPointerDownCapture={syncPresentationInkOnPointerDown}
        onPointerUp={finishPresentationInkStroke}
        onPointerCancel={finishPresentationInkStroke}
      >
        {!presentation && !isNavigationVisible && (
          <button
            className="topbar-show"
            type="button"
            onClick={() => setIsNavigationVisible(true)}
            aria-label="Show navigation"
            title="Show navigation (Ctrl/⌘ + Shift + H)"
          >
            <ShowTopBarIcon />
          </button>
        )}
        {!presentation && !isFooterVisible && (
          <button
            className="footer-show"
            type="button"
            onClick={() => setFeaturePreference("footer", true)}
            aria-label="Show footer"
            title="Show footer (Ctrl/⌘ + Shift + F)"
          >
            <ShowBottomBarIcon />
          </button>
        )}
        {!presentation && workspaceMode === "slides" && !isSlideRailVisible && !isFooterVisible && (
          <button
            ref={slideRailShowButtonRef}
            className="slide-rail-show-floating"
            type="button"
            onClick={showSlideRail}
            aria-label="Show slide navigator"
            aria-controls="slide-rail"
            aria-expanded="false"
            title="Show slide navigator"
          >
            <ShowPanelIcon />
          </button>
        )}
        {!presentation && workspaceMode === "pdf" && !isPdfRailVisible && !isFooterVisible && (
          <button
            ref={pdfRailShowButtonRef}
            className="slide-rail-show-floating"
            type="button"
            onClick={showPdfRail}
            aria-label="Show PDF pages"
            aria-controls="pdf-page-rail"
            aria-expanded="false"
            title="Show PDF pages"
          >
            <ShowPanelIcon />
          </button>
        )}
        <div
          ref={editorHostRef}
          className={`editor-host ${isScreenshotCaptureActive ? "is-screenshot-capture-active" : ""} ${isSlideFrameDrawingActive ? "is-slide-frame-drawing-active" : ""}`}
          onClickCapture={handleEditorClickCapture}
          onKeyDownCapture={handleEditorKeyDownCapture}
          onPointerDownCapture={handleEditorPointerDownCapture}
          onDropCapture={handleEditorDropCapture}
          onDragOver={handleScreenshotDragOver}
          onDrop={handleScreenshotDrop}
        >
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={initialExcalidrawData}
            onChange={handleChange}
            onLibraryChange={handleLibraryChange}
            onPaste={handlePaste}
            onLinkOpen={handleLinkOpen}
            generateIdForFile={generateNativeImageFileId}
            aiEnabled={false}
            validateEmbeddable={validateEmbeddedContentUrl}
            renderEmbeddable={renderDisabledEmbeddable}
            isCollaborating={false}
            theme={editorTheme}
            UIOptions={CLASSROOM_UI_OPTIONS}
          >
            {featurePreferences.library || featurePreferences.projectFind ? defaultSidebar : null}
          </Excalidraw>
          {isSlideFrameDrawingActive && workspaceMode === "slides" && (
            <div
              className="slide-frame-draw-overlay"
              data-testid="slide-frame-draw-overlay"
              aria-label="Draw slide"
              onPointerDown={beginSlideFramePointer}
              onPointerMove={updateSlideFramePointer}
              onPointerUp={finishSlideFramePointer}
              onPointerCancel={stopSlideFrameDrawing}
            />
          )}
          <div
            ref={frameDragPreviewRef}
            className="slide-frame-drag-preview"
            data-testid="slide-frame-drag-preview"
            aria-hidden="true"
            hidden
          />
          {isScreenshotCaptureActive && (
            <ScreenshotCaptureOverlay
              onCancel={cancelScreenshotCapture}
              onCapture={finishScreenshotCapture}
            />
          )}
          {spinnerPointerAnimations.length > 0 && (
            <SpinnerPointerOverlay durationMs={SPINNER_ANIMATION_DURATION_MS} spinners={spinnerPointerAnimations} />
          )}
          {api && (
            <>
              <StrokeWidthExtensions
                api={api}
                editorHost={editorHostRef.current}
                strokeWidth={strokeWidth}
              />
              {!presentation ? (
                <BucketFillMenuExtension
                  active={isBucketFillActive}
                  editorHost={editorHostRef.current}
                  onStart={startBucketFill}
                />
              ) : null}
              {featurePreferences.mathTools ? (
                <MathToolsMenuExtension
                  editorHost={editorHostRef.current}
                  onOpen={openMathTools}
                  onPrepareLasso={prepareLasso}
                  onStartLasso={startLasso}
                />
              ) : null}
              {featurePreferences.mathTools && !presentation && !mathInteraction && probabilitySelection ? (
                <ProbabilityRandomizer
                  isSpinning={isProbabilitySpinning}
                  summary={probabilitySelection}
                  onRandomize={randomizeSelectedProbabilityPieces}
                />
              ) : null}
            </>
          )}
          {api && isLassoActive && lassoGeometryFactory && lassoInitialSelection && editorHostRef.current ? (
            <LassoOverlay
              api={api}
              createGeometrySnapshot={lassoGeometryFactory}
              editorHost={editorHostRef.current}
              initialSelection={lassoInitialSelection}
              onExit={finishLasso}
            />
          ) : null}
          {api && isBucketFillActive && editorHostRef.current ? (
            <BucketFillOverlay
              api={api}
              editorHost={editorHostRef.current}
              onExit={finishBucketFill}
              onFill={fillBucketRegion}
            />
          ) : null}
          {mathInteraction && (
            <MathInteractionOverlay
              kind={mathInteraction.kind}
              points={mathInteraction.points}
              compassOptions={mathInteraction.compassOptions}
              angleOptions={mathInteraction.angleOptions}
              transformationOptions={mathInteraction.transformationOptions}
              sourceElementCount={mathInteraction.sourceElementIds.length}
              onCancel={() => setMathInteraction(null)}
              onReset={() => setMathInteraction((current) => current ? { ...current, points: [] } : current)}
              onCommit={commitMathInteraction}
              onCompassOptionsChange={(options) => setMathInteraction((current) => current ? { ...current, compassOptions: options } : current)}
              onAngleOptionsChange={(options) => setMathInteraction((current) => current ? { ...current, angleOptions: options } : current)}
              onTransformationOptionsChange={(options) => setMathInteraction((current) => current ? { ...current, transformationOptions: options } : current)}
            />
          )}
        </div>
        {!presentation && isFooterVisible && (
          <footer className="statusbar">
            <div className="page-status">
              <button
                className="footer-hide"
                type="button"
                aria-label="Hide footer"
                title="Hide footer (Ctrl/⌘ + Shift + F)"
                onClick={() => setFeaturePreference("footer", false)}
              >
                <HideBottomBarIcon />
              </button>
              {workspaceMode === "pdf" && !isPdfRailVisible && (
                <button
                  ref={pdfRailShowButtonRef}
                  className="pdf-rail-show"
                  type="button"
                  onClick={showPdfRail}
                  aria-label="Show PDF pages"
                  aria-controls="pdf-page-rail"
                  aria-expanded="false"
                  title="Show PDF pages"
                >
                  <ShowPanelIcon />
                  <span className="icon-label">Pages</span>
                </button>
              )}
              {workspaceMode === "slides" && !isSlideRailVisible && (
                <button
                  ref={slideRailShowButtonRef}
                  className="slide-rail-show"
                  type="button"
                  onClick={showSlideRail}
                  aria-label="Show slide navigator"
                  aria-controls="slide-rail"
                  aria-expanded="false"
                  title="Show slide navigator"
                >
                  <ShowPanelIcon />
                  <span className="icon-label">Slides</span>
                </button>
              )}
              {pageIndex >= 0 ? (
                <>
                  <button type="button" disabled={pageIndex === 0} onClick={() => openScene(pdfScenes[pageIndex - 1].id)} aria-label="Previous PDF page"><PreviousIcon /></button>
                  <span>Page {pageIndex + 1} of {pdfScenes.length}</span>
                  <button type="button" disabled={pageIndex >= pdfScenes.length - 1} onClick={() => openScene(pdfScenes[pageIndex + 1].id)} aria-label="Next PDF page"><NextIcon /></button>
                </>
              ) : workspaceMode === "slides" ? (
                <>
                  <button
                    type="button"
                    disabled={activeSlideIndex <= 0}
                    onClick={() => openSlide(project.slideOrder[activeSlideIndex - 1])}
                    aria-label="Previous slide"
                  >
                    <PreviousIcon />
                  </button>
                  <span data-testid="slide-page-indicator" aria-live="polite">
                    {activeSlideIndex >= 0
                      ? `Slide ${activeSlideIndex + 1} of ${project.slideOrder.length}`
                      : `Overview · ${project.slideOrder.length} slide${project.slideOrder.length === 1 ? "" : "s"}`}
                  </span>
                  <button
                    type="button"
                    disabled={project.slideOrder.length === 0 || activeSlideIndex >= project.slideOrder.length - 1}
                    onClick={() => openSlide(project.slideOrder[activeSlideIndex + 1])}
                    aria-label="Next slide"
                  >
                    <NextIcon />
                  </button>
                </>
              ) : <span>Board</span>}
            </div>
            <div className="footer-zoom-controls" role="group" aria-label={`${workspaceMode === "pdf" ? "PDF" : workspaceMode === "slides" ? "Slides" : "Board"} zoom controls`}>
              <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => clickEditorControl(".zoom-out-button")}><MinusIcon /></button>
              <button className="footer-reset-zoom" type="button" aria-label="Reset zoom" title="Reset zoom" onClick={() => clickEditorControl(".reset-zoom-button")}>{zoom}%</button>
              <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => clickEditorControl(".zoom-in-button")}><PlusIcon /></button>
            </div>
            <div className="statusbar-actions">
              {workspaceMode === "slides" && (
                <>
                  <button className="present-button" type="button" onClick={startPresentation} title="Start presentation">
                    <PresentIcon /><span className="icon-label">Present</span>
                  </button>
                  <button className="footer-history-button" type="button" aria-label="Undo" title="Undo" onClick={() => clickEditorControl('[data-testid="button-undo"]')}><UndoIcon /></button>
                  <button className="footer-history-button" type="button" aria-label="Redo" title="Redo" onClick={() => clickEditorControl('[data-testid="button-redo"]')}><RedoIcon /></button>
                </>
              )}
              {workspaceMode === "pdf" && (
                <>
                  <button
                    className={`pdf-toolbar-toggle ${isPdfToolbarVisible ? "is-active" : ""}`}
                    type="button"
                    aria-label={isPdfToolbarVisible ? "Hide drawing tools" : "Show drawing tools"}
                    aria-pressed={isPdfToolbarVisible}
                    title={isPdfToolbarVisible ? "Hide drawing tools" : "Show drawing tools"}
                    onClick={() => setIsPdfToolbarVisible((visible) => !visible)}
                  >
                    <InkIcon />
                  </button>
                  <button className="footer-history-button" type="button" aria-label="Undo" title="Undo" onClick={() => clickEditorControl('[data-testid="button-undo"]')}><UndoIcon /></button>
                  <button className="footer-history-button" type="button" aria-label="Redo" title="Redo" onClick={() => clickEditorControl('[data-testid="button-redo"]')}><RedoIcon /></button>
                </>
              )}
              {workspaceMode === "board" && (
                <>
                  <button className="footer-history-button" type="button" aria-label="Undo" title="Undo" onClick={() => clickEditorControl('[data-testid="button-undo"]')}><UndoIcon /></button>
                  <button className="footer-history-button" type="button" aria-label="Redo" title="Redo" onClick={() => clickEditorControl('[data-testid="button-redo"]')}><RedoIcon /></button>
                </>
              )}
              <button
                className={`fullscreen-button ${isFullscreen ? "is-active" : ""}`}
                type="button"
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                aria-pressed={isFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                onClick={() => void toggleFullscreen()}
              >
                {isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
              </button>
            </div>
          </footer>
        )}
      </main>
      {presentation && (
        <PresentationOverlay
          slides={project.slideOrder}
          index={presentation.index}
          tool={presentation.tool}
          inkColour={presentation.inkColour}
          inkWidth={presentation.inkWidth}
          onIndexChange={setPresentationIndex}
          onToolChange={setPresentationTool}
          onInkColourChange={setPresentationInkColour}
          onInkWidthChange={setPresentationInkWidth}
          onExit={stopPresentation}
        />
      )}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        aria-label="Open project file"
        accept=".patterdraw,.canvasclassroom,.excalidraw,.pdf,application/pdf"
        onChange={(event) => event.target.files?.[0] && void handleFile(event.target.files[0])}
      />
      <input
        ref={pdfInsertInputRef}
        className="visually-hidden"
        type="file"
        multiple
        aria-label="Select PDFs to insert"
        accept=".pdf,application/pdf,application/octet-stream"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = "";
          if (files.length) void inspectPdfInsertFiles(files);
        }}
      />
      <input
        ref={libraryInputRef}
        className="visually-hidden"
        type="file"
        aria-label="Import personal library file"
        accept=".excalidrawlib,application/vnd.excalidrawlib+json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importDroppedLibrary(file);
        }}
      />
      {pendingPdfInsert ? (
        <PdfInsertDialog
          files={pendingPdfInsert.files}
          remainingPageCapacity={project ? remainingProjectSceneCapacity(project) : 0}
          processing={pdfInsertProcessing}
          cancelling={pdfInsertCancelling}
          progress={pdfInsertProgress}
          onCancel={closePdfInsertDialog}
          onCancelProcessing={cancelPdfInsertion}
          onSubmit={(submission) => void submitPdfInsertion(submission)}
          returnFocusRef={pdfInsertTriggerRef}
        />
      ) : null}
      {pendingPdfAnnotationClear ? (
        <ClearPdfAnnotationsDialog
          summaries={pendingPdfAnnotationClear.summaries}
          sourceName={pendingPdfAnnotationClear.sourceName}
          onCancel={closePdfAnnotationClearDialog}
          onConfirm={confirmPdfAnnotationClear}
          returnFocusRef={pdfPageActionsTriggerRef}
        />
      ) : null}
      {pendingVisualPdfFallback ? (
        <VisualPdfFallbackDialog
          onCancel={cancelVisualPdfFallback}
          onConfirm={confirmVisualPdfFallback}
          returnFocusRef={exportOptionsTriggerRef}
        />
      ) : null}
      {exportOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeExportDialog}>
          <section ref={exportDialogRef} className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="export-title">More exports</h2>
            <p>Export the current board, presentation frames, or imported PDF pages.</p>
            <button type="button" onClick={openNativeImageExport} disabled={!api?.getSceneElements().length}>
              <strong>Export image…</strong><span>Use Excalidraw’s image options for a selection or the complete active scene.</span>
            </button>
            <button type="button" onClick={() => void runFullBoardExport()} disabled={!api?.getSceneElements().length}>
              <strong>Full board PNG</strong><span>Everything on this board, including content outside the window. Editable scene data is embedded when supported.</span>
            </button>
            {workspaceMode === "slides" && (
              <>
                <button type="button" onClick={() => void runPdfExport("slides")} disabled={!project.slideOrder.length}>
                  <strong>Presentation PDF</strong><span>One ordered frame per slide.</span>
                </button>
                <button type="button" onClick={() => void runPptxExport()} disabled={!project.slideOrder.length}>
                  <strong>PowerPoint (.pptx)</strong><span>High-fidelity visual slides for PowerPoint, Keynote, or Google Slides. Slide contents are not individually editable.</span>
                </button>
              </>
            )}
            <button type="button" onClick={() => void runPdfExport("expand")} disabled={!Object.keys(project.pdfDocuments).length}>
              <strong>Annotated PDF — expand pages</strong><span>Keep original scale and grow pages to include off-page writing.</span>
            </button>
            <button type="button" onClick={() => void runPdfExport("openboard-fit")} disabled={!Object.keys(project.pdfDocuments).length}>
              <strong>Annotated PDF — fit like OpenBoard</strong><span>Keep original paper size and scale all visible content to fit.</span>
            </button>
            <button className="dialog-cancel" type="button" onClick={closeExportDialog}>Cancel</button>
          </section>
        </div>
      )}
      {equationEditor && (
        <EquationDialog
          initialSource={equationEditor.initialSource}
          editing={!!equationEditor.targetId}
          onCancel={() => setEquationEditor(null)}
          onSubmit={insertEquation}
          returnFocusRef={insertTriggerRef}
        />
      )}
      {mermaidEditor && (
        <MermaidDialog
          initialSource={mermaidEditor.initialSource}
          editing={!!mermaidEditor.targetDiagramId}
          onCancel={() => setMermaidEditor(null)}
          onSubmit={insertMermaid}
          returnFocusRef={insertTriggerRef}
        />
      )}
      {featurePreferences.mathTools && isMathToolsOpen ? (
        <MathToolsDialog
          initialConfiguration={mathToolEdit?.initialConfiguration}
          onCancel={closeMathTools}
          onOpenGeoGon={openGeoGon}
          onInsert={insertMathTool}
          onStartInteraction={startMathInteraction}
        />
      ) : null}
      {featurePreferences.mathTools && isGeoGonOpen ? (
        <GeoGonDialog
          onCancel={closeGeoGon}
          onInsert={insertGeoGonSvg}
        />
      ) : null}
      {busyMessage && (
        <div className="busy-overlay" role="status">
          <span className="spinner" />
          <span>{busyMessage}</span>
          {busyCanCancel ? (
            <button type="button" onClick={() => busyCancelRef.current?.()}>Cancel</button>
          ) : null}
        </div>
      )}
      {errorMessage && (
        <div className="error-toast" role="alert"><span>{errorMessage}</span><button type="button" onClick={() => setErrorMessage(null)}>Dismiss</button></div>
      )}
      {pdfUndoToast && (
        <div className="pdf-annotation-clear-toast" role="status">
          <span>
            {pdfUndoToast.kind === "clear-annotations" ? (
              <>
                Cleared {pdfUndoToast.annotationCount} {pdfUndoToast.annotationCount === 1 ? "annotation" : "annotations"}
                {" from "}{pdfUndoToast.affectedPageCount} {pdfUndoToast.affectedPageCount === 1 ? "page" : "pages"}
              </>
            ) : (
              <>Deleted output page {pdfUndoToast.deletedPageNumber}</>
            )}
          </span>
          <span aria-hidden="true">—</span>
          <button type="button" onClick={undoPendingPdfAction}>Undo</button>
        </div>
      )}
    </div>
  );
}
