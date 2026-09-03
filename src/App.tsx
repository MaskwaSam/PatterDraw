import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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
import { ClearBoardDialog } from "./components/ClearBoardDialog";
import { boardClearSummary, slideOrderForBoardClearUndo } from "./lib/board-clear";
import { SlideRail } from "./components/SlideRail";
import { SlideRotationDialog } from "./components/SlideRotationDialog";
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
import { PdfCompatibilityImportDialog } from "./components/PdfCompatibilityImportDialog";
import { ProjectSwitchDialog } from "./components/ProjectSwitchDialog";
import {
  RecoveryHistoryDialog,
  type RecoveryHistoryStatus,
} from "./components/RecoveryHistoryDialog";
import {
  PresentationOverlay,
  type PresentationTool,
} from "./components/PresentationOverlay";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { StrokeWidthExtensions } from "./components/StrokeWidthExtensions";
import { MathToolsMenuExtension } from "./components/MathToolsMenuExtension";
import { MathToolsDialog } from "./components/MathToolsDialog";
import {
  ClassroomTimeDialog,
  type ClassroomCalendarEventDraft,
  type ClassroomCalendarEventCreateResult,
} from "./components/ClassroomTimeDialog";
import {
  ClassroomTimeOverlay,
  type ClassroomTimeOverlayCommand,
  type ClassroomTimeOverlayTarget,
} from "./components/ClassroomTimeOverlay";
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
import { ObsCaptureGuide } from "./components/ObsCaptureGuide";
import { WorkspaceStatusControls } from "./components/WorkspaceStatusControls";
import {
  SCREENSHOT_DRAG_MIME,
  SCREENSHOT_SIDEBAR_TAB,
  ScreenshotLibrary,
} from "./components/ScreenshotLibrary";
import {
  ScreenshotIcon,
  SearchIcon,
  ShowBottomBarIcon,
  ShowPanelIcon,
  ShowTopBarIcon,
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
  autosaveManifestHash,
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
import type { AutosaveHistorySummary } from "./lib/autosave-history";
import type { PdfImportRecovery } from "./lib/pdf/import-compatibility";
import type { InspectedPdfFile } from "./lib/pdf/import-pdf";
import type { ProjectArchiveWorkerReadiness } from "./lib/project-archive-client";
import type { StorageReadiness } from "./lib/storage-readiness";
import { projectNeedsSwitchProtection } from "./lib/project-switch-safety";
import { bytesForBlob } from "./lib/blob-bytes";
import { downloadBlob, safeFileStem } from "./lib/download";
import { exportFullBoardPng } from "./lib/export-board";
import { createLocalId } from "./lib/id";
import { isEditableKeyboardTarget } from "./lib/keyboard-targets";
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
  getBrowserPdfRasterBudget,
  getBrowserPdfRasterDeviceTier,
  type PdfRasterDeviceTier,
} from "./lib/pdf/raster-limits";
import { getPdfStorageAdmissionRequirement } from "./lib/pdf/storage-admission";
import { projectForPdfReplacement, replaceProjectPdf } from "./lib/pdf/replacement";
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
  remainingProjectPdfPageCapacity,
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
  deletePdfPagesReversibly,
  duplicatePdfPage,
  pdfAdditionPreservesPageDeleteUndo,
  pdfAdditionPreservesPdfPageBatchDeleteUndo,
  undoPdfPageBatchDelete,
  undoPdfPageDelete,
  type PdfPageBatchDeleteTransaction,
  type PdfPageDeleteTransaction,
} from "./lib/pdf/page-actions";
import {
  retainedPdfActiveTool,
  type PdfActiveTool,
} from "./lib/pdf/active-tool";
import {
  centeredPdfViewport,
  normalizeSharedPdfZoom,
} from "./lib/pdf/shared-viewport";
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
import { rotateSlideContent } from "./lib/slide-content-rotation";
import {
  DEFAULT_SLIDE_MORPH_DURATION_MS,
  normalizeSlideMorphDurationMs,
} from "./lib/slide-transition";
import {
  assertLoadedProjectRasterSafety,
  canonicalizePersistedWrapperTool,
  countProjectClassroomTimeWidgets,
  isPersistedWrapperTool,
  MAX_PROJECT_BYTES,
  sanitizeProject,
  sanitizeScene,
} from "./lib/safety";
import {
  addLocalProjectRasterUsage,
  generateSafeLocalImageFileId,
  inspectLocalProjectRasterUsage,
  inspectLocalImageDataUrl,
  inspectLocalImageBlob,
  rasterizeLocalImageToPngForInsertion,
  rasterizeLocalPngForInsertion,
  remainingLocalProjectRasterCapacity,
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
import {
  DEFAULT_CLASSROOM_TIME_PREFERENCES,
  CLASSROOM_ALARM_REGISTRY_STORAGE_KEY,
  acknowledgeBlockedClassroomAlarmJobs,
  activateClassroomAlarmTransaction,
  activeClassroomTimeAlarmDescriptors,
  advanceExpiredClassroomTimeWidget,
  applyClassroomAlarmCancellationAuthority,
  applyClassroomTimeControl,
  cancelClassroomAlarmIdentitiesWithReceipt,
  classroomTimePreferencePatchForMetadata,
  classroomTimeRenderContext,
  claimAndMarkDueClassroomAlarmJobs,
  createClassroomAlarmJob,
  createClassroomCalendarStoreV1,
  createClassroomTimeMetadataFromPreferences,
  createProjectCalendarTransferCache,
  hasClassroomAlarmDeliveredGeneration,
  importProjectCalendarTransferCache,
  isClassroomAlarmJobCancelled,
  listStagedClassroomAlarmTransactions,
  matchStagedClassroomAlarmTransaction,
  mutateDeviceClassroomCalendar,
  nextClassroomAlarmGenerationStartMs,
  playClassroomAlarmTone,
  prepareClassroomAlarmAudio,
  projectTrackedStagedClassroomAlarmTransactionsAsPending,
  pruneClassroomAlarmCancellationTombstones,
  pruneClassroomAlarmDeliveryTombstones,
  persistClassroomTimePreferencePatch,
  readClassroomAlarmRegistry,
  readClassroomTimePreferences,
  readDeviceClassroomCalendar,
  recoverClassroomAlarmJob,
  replayBlockedClassroomAlarmJobs,
  rollbackClassroomAlarmTransaction,
  selectedClassroomTimeWidget,
  subscribeToClassroomTimePreferences,
  subscribeToDeviceClassroomCalendar,
  stageCancelledClassroomAlarmReceipt,
  stageRecoveredClassroomAlarmJobs,
  stageSchedulerClassroomAlarmJobs,
  stageTrustedClassroomAlarmJobs,
  testClassroomAlarmTone,
  upsertClassroomCalendarEvent,
  type ClassroomAlarmJobV1,
  type ClassroomAlarmIdentity,
  type ClassroomAlarmCancellationReceiptV1,
  type ClassroomAlarmStorage,
  type ClassroomAlarmTone,
  type ClassroomAlarmTransactionReceiptV1,
  type ClassroomAlarmRegistryStateV1,
  type ClassroomAlarmRegistryV1,
  type ClassroomCalendarEventV1,
  type ClassroomDeviceCalendarStoreV1,
  type ClassroomProjectCalendarStoreV1,
  type ClassroomTimePreferencesV1,
  type ClassroomTimeAlarmDescriptor,
  type ClassroomTimeWidgetKind,
  type ClassroomTimeWidgetMetadataV1,
  type SelectedClassroomTimeWidget,
} from "./lib/classroom-time";
import {
  MAX_CLASSROOM_TIME_WIDGETS,
  canonicalizeClassroomTimeWidgetsForPersistence,
  classroomTimeWidgetMetadata,
  classroomTimeWidgetOwnerId,
  createClassroomTimeWidgetScene,
  forkDuplicatedClassroomTimeWidgets,
  forkClassroomTimeWidgets,
  materializeClassroomTimeWidgetsForExport,
  reconcileClassroomTimeWidgets,
  tickClassroomTimeWidgets,
  ungroupClassroomTimeWidget,
  type ClassroomTimeRenderContext,
} from "./lib/classroom-time/scene";
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
  kind: "pdf" | "slides";
  index: number;
  tool: PresentationTool;
  inkColour: PresentationInkColour;
  inkWidth: PresentationInkWidth;
};
export type PresentationClassroomTimeSelection = SelectedClassroomTimeWidget & {
  projectId: string;
  sceneId: string;
};

export function classroomAlarmStartWarning(
  preparationStatus: "blocked" | "ready" | "unavailable",
  muted: boolean,
  masterVolume: number,
): string | null {
  if (muted) {
    return "Countdown started, but classroom alarms are muted on this device. Unmute alarms before time is up.";
  }
  if (!Number.isFinite(masterVolume) || masterVolume <= 0) {
    return "Countdown started, but alarm volume is 0%. Raise the alarm volume before time is up.";
  }
  if (preparationStatus === "blocked") {
    return "Countdown started, but your browser blocked alarm sound. Test the alarm before relying on it.";
  }
  if (preparationStatus === "unavailable") {
    return "Countdown started, but alarm sound is unavailable in this browser.";
  }
  return null;
}
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
type PendingSlideRotationAction = {
  degrees: number;
  frameId: string;
  sceneId: string;
  slideId: string;
  title: string;
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
  deviceCalendarSnapshot: ClassroomDeviceCalendarStoreV1;
  mode: PdfExportMode;
  capturedAt: number;
  boardTheme: "light" | "dark";
};
type PendingProjectSwitch = {
  file: File;
  processing: boolean;
};
type PdfCompatibilityAttempt = {
  originalFailure: unknown;
  originalFile: File;
  rejectedOriginalInspection: Readonly<Pick<InspectedPdfFile, "pageCount" | "sha256">>;
};
type PendingPdfCompatibilityImport = {
  failure: unknown;
  file: File;
  processing: boolean;
  rejectedOriginalInspection?: Readonly<Pick<InspectedPdfFile, "pageCount" | "sha256">>;
  recovery: PdfImportRecovery;
} & (
  | { context: "direct" }
  | {
    context: "batch";
    sourceInstanceId: string;
    submission: PdfInsertSubmission;
  }
);
export type ClassroomTimeLibraryTransferIntent = {
  baselineItemIds: ReadonlySet<string>;
  cacheByAnchorId: ReadonlyMap<string, {
    ownerId: string;
    kind: "calendar" | "dashboard";
    transferCache: NonNullable<
      Extract<ClassroomTimeWidgetMetadataV1, { kind: "calendar" | "dashboard" }>["calendar"]["transferCache"]
    >;
  }>;
  expiresAt: number;
};
type ClassroomTimeSchedulerSceneIndex = {
  sceneId: string;
  ownerIds: readonly string[];
  nextTransitionAtMs: number | null;
};
export type ClassroomTimeSchedulerIndex = {
  projectId: string | null;
  widgetCount: number;
  scenes: ReadonlyMap<string, ClassroomTimeSchedulerSceneIndex>;
};
type ClassroomTimeDialogState = {
  mode: "insert" | "update";
  metadata: ClassroomTimeWidgetMetadataV1;
  anchorId?: string;
};
export type ClassroomTimeAlarmNotice = {
  jobs: readonly ClassroomAlarmJobV1[];
  jobIds: readonly string[];
  message: string;
  blocked: boolean;
  deliveryPending: boolean;
};
export type ClassroomTimeTickFence = {
  sceneId: string;
  elementFingerprint: string;
  fileFingerprint: string;
  /**
   * Ordinary clock/timer redraws are display-only. Excalidraw may normalize
   * revision bookkeeping while applying updateScene(), so retain the exact
   * expected content and accept revision-only drift without weakening the
   * user-edit fence.
   */
  expectedDisplayContentFingerprint?: string;
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

export type SceneHydrationSnapshot = {
  appState: Record<string, unknown>;
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  sceneId: string;
};
type SceneHydrationBaseline = {
  generation: number;
  snapshot: SceneHydrationSnapshot;
};
type FileOpenOperation = {
  generation: number;
  signal: AbortSignal;
};
type PendingPdfInsertFile = PdfInsertFileRowMetadata & {
  compatibilityAttempted?: boolean;
  compatibilityOriginal?: {
    failure: unknown;
    file: File;
    rejectedOriginalInspection: Readonly<Pick<InspectedPdfFile, "pageCount" | "sha256">>;
  };
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
      cancelledAlarmIdentities: readonly ClassroomAlarmIdentity[];
      cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null;
    }
  | {
      kind: "delete-page";
      token: number;
      transaction: PdfPageDeleteTransaction;
      cancelledAlarmIdentities: readonly ClassroomAlarmIdentity[];
      cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null;
    }
  | {
      kind: "delete-pages";
      token: number;
      transaction: PdfPageBatchDeleteTransaction;
      cancelledAlarmIdentities: readonly ClassroomAlarmIdentity[];
      cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null;
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
    }
  | {
      kind: "delete-pages";
      token: number;
      deletedPageNumbers: readonly number[];
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
    const preservesUndo = pending.kind === "delete-pages"
      ? pdfAdditionPreservesPdfPageBatchDeleteUndo(
        project,
        pdfData,
        pending.transaction,
        { now },
      )
      : pdfAdditionPreservesPageDeleteUndo(
        project,
        pdfData,
        pending.transaction,
        { now },
      );
    if (!preservesUndo) throw new Error(PDF_UNDO_RESERVATION_ERROR);
  } catch {
    throw new Error(PDF_UNDO_RESERVATION_ERROR);
  }
}

async function assertPdfAdditionPreservesPendingUndoRaster(
  project: ClassroomProject,
  pdfData: Record<PdfDocumentId, Uint8Array>,
  pending: PendingPdfUndo | null,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<void> {
  if (!pending || now >= pending.transaction.expiresAt) return;
  try {
    const restoredProject = pending.kind === "clear-annotations"
      ? undoPdfAnnotationClear(project, pending.transaction, {
        now,
        updatedAt: project.updatedAt,
      }).project
      : pending.kind === "delete-pages"
        ? undoPdfPageBatchDelete(project, pdfData, pending.transaction, {
          now,
          updatedAt: project.updatedAt,
        }).project
        : undoPdfPageDelete(project, pdfData, pending.transaction, {
          now,
          updatedAt: project.updatedAt,
        }).project;
    await inspectLocalProjectRasterUsage(restoredProject, {
      rasterBudget: getBrowserPdfRasterBudget(),
      signal,
    });
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
    tool: PresentationTool | null;
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

/**
 * Keep the classroom-time widget chosen before presentation as presentation
 * state, rather than as an Excalidraw selection. Scene hydration necessarily
 * clears the editor selection; a matching live selection may refresh the
 * remembered metadata, but a missing or different selection must not replace
 * the presentation target.
 */
export function updateRememberedPresentationClassroomTimeSelection(
  remembered: PresentationClassroomTimeSelection | null,
  liveSelection: SelectedClassroomTimeWidget | null,
  liveContext: {
    projectId: string | null;
    sceneId: string | null;
  },
): PresentationClassroomTimeSelection | null {
  if (
    !remembered
    || !liveSelection
    || liveContext.projectId !== remembered.projectId
    || liveContext.sceneId !== remembered.sceneId
    || liveSelection.anchorId !== remembered.anchorId
    || liveSelection.ownerId !== remembered.ownerId
  ) return remembered;
  return {
    ...liveSelection,
    projectId: remembered.projectId,
    sceneId: remembered.sceneId,
  };
}

export function classroomTimeActiveTargetAfterSelection(
  current: ClassroomTimeOverlayTarget,
  liveSelection: SelectedClassroomTimeWidget | null,
  presentationActive: boolean,
): ClassroomTimeOverlayTarget {
  if (presentationActive) return current;
  if (liveSelection?.metadata.kind === "pomodoro") return "pomodoro";
  if (liveSelection?.metadata.kind === "timer") return "timer";
  return current;
}

/**
 * Presentation controls may use a remembered selection only after the live
 * editor has finished hydrating the active scene and confirms the exact
 * widget anchor and owner. This prevents a stale control from mutating a
 * different widget while rapidly moving between slides in separate scenes.
 */
export function presentationClassroomTimeSelectionForLiveScene(
  remembered: PresentationClassroomTimeSelection | null,
  liveElements: readonly ExcalidrawElement[],
  sceneState: {
    activeSceneId: string | null;
    hydratedSceneId: string | null;
    projectId: string | null;
    switching: boolean;
  },
): PresentationClassroomTimeSelection | null {
  if (
    !remembered
    || sceneState.switching
    || !sceneState.activeSceneId
    || sceneState.projectId !== remembered.projectId
    || sceneState.activeSceneId !== remembered.sceneId
    || sceneState.activeSceneId !== sceneState.hydratedSceneId
  ) return null;
  const anchor = liveElements.find((element) => (
    !element.isDeleted && element.id === remembered.anchorId
  ));
  const metadata = anchor ? classroomTimeWidgetMetadata(anchor) : null;
  if (!metadata || metadata.ownerId !== remembered.ownerId) return null;
  return {
    anchorId: remembered.anchorId,
    elementIds: liveElements.flatMap((element) => (
      !element.isDeleted && classroomTimeWidgetOwnerId(element) === remembered.ownerId
        ? [element.id]
        : []
    )),
    metadata,
    ownerId: remembered.ownerId,
    projectId: remembered.projectId,
    sceneId: remembered.sceneId,
  };
}

/**
 * Excalidraw's native eraser reports only the final deletion set: when a
 * gesture touches a frame boundary, it does not distinguish children erased
 * by the frame cascade from children hit directly by that same gesture.
 * Conservatively reject all newly deleted members of that protected frame as
 * one atomic gesture. Previously deleted children stay deleted, erasures
 * outside the frame remain valid, and a separate child-only gesture remains
 * erasable while the slide frame itself stays intact.
 */
export function protectPresentationSlideFrameElements(
  elements: readonly ExcalidrawElement[],
  protectedFrameIds: ReadonlySet<string>,
  previousElements: readonly ExcalidrawElement[] = [],
): readonly ExcalidrawElement[] {
  const previousById = new Map(previousElements.map((element) => [element.id, element]));
  const erasedProtectedFrameIds = new Set(elements.flatMap((element) => (
    element.type === "frame"
    && element.isDeleted
    && protectedFrameIds.has(element.id)
    && previousById.get(element.id)?.isDeleted !== true
      ? [element.id]
      : []
  )));
  if (!erasedProtectedFrameIds.size) return elements;
  return elements.map((element) => (
    element.isDeleted
    && previousById.get(element.id)?.isDeleted !== true
    && (
      erasedProtectedFrameIds.has(element.id)
      || (element.frameId !== null && erasedProtectedFrameIds.has(element.frameId))
    )
      ? newElementWith(element, { isDeleted: false })
      : element
  ));
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
      '.classroom-time-dialog[role="dialog"]',
      '.classroom-time-overlay-menu[role="menu"]',
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
    if (isEditableKeyboardTarget(event.target)) return;
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

type ShortcutHelpBridge = {
  open: (() => void) | null;
};
const SHORTCUT_HELP_BRIDGE_KEY = "__patterdrawShortcutHelpBridgeV1";

function installShortcutHelpBridge(): ShortcutHelpBridge | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as Window & {
    [SHORTCUT_HELP_BRIDGE_KEY]?: ShortcutHelpBridge;
  };
  const existing = browserWindow[SHORTCUT_HELP_BRIDGE_KEY];
  if (existing) return existing;
  const bridge: ShortcutHelpBridge = { open: null };
  browserWindow[SHORTCUT_HELP_BRIDGE_KEY] = bridge;
  // Own the question-mark shortcut before Excalidraw mounts so PatterDraw's
  // complete wrapper and editor shortcut guide replaces the narrower native
  // drawing-only help dialog.
  window.addEventListener("keydown", (event) => {
    const isQuestionMark = event.key === "?"
      || (event.code === "Slash" && event.shiftKey);
    if (
      !bridge.open
      || event.repeat
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || !isQuestionMark
    ) return;
    if (isEditableKeyboardTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (hasVisibleModalSurface()) return;
    bridge.open();
  }, true);
  return bridge;
}

const shortcutHelpBridge = installShortcutHelpBridge();

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
const EXCALIDRAW_LIBRARY_MIME = "application/vnd.excalidrawlib+json";
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
  const storageFull = isQuotaExceededLikeError(error);
  return storageFull
    ? "Autosave failed because browser storage is full. Download a .patterdraw backup now, then remove Personal Library items or Screenshot Library captures."
    : `Autosave failed: ${detail} Download a .patterdraw backup before closing this page.`;
}

function isQuotaExceededLikeError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { name?: unknown }).name === "QuotaExceededError",
  );
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
  const backgroundSafeElements = canonicalizePdfBackgroundForPersistence(
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

/**
 * Freeze the comparison side of the hydration fence. Excalidraw may retain
 * and normalize element objects handed to updateScene(); keeping those same
 * references in the baseline would let an in-place user move mutate both
 * sides and be misclassified as a synthetic hydration echo.
 */
export function snapshotSceneHydrationChange(
  pending: PendingScenePersistence,
): SceneHydrationSnapshot {
  return {
    sceneId: pending.sceneId,
    elements: structuredClone(pending.elements),
    appState: serializedPersistableAppState(
      pending.elements,
      pending.appState,
      pending.files,
    ),
    // BinaryFileData is flat and its potentially large dataURL is an
    // immutable string. Clone each record to sever mutable object aliases
    // without duplicating the encoded image bytes.
    files: Object.fromEntries(
      Object.entries(pending.files).map(([fileId, file]) => [fileId, { ...file }]),
    ) as BinaryFiles,
  };
}

export function hydrationChangeMatchesSnapshot(
  pending: PendingScenePersistence,
  snapshot: SceneHydrationSnapshot,
): boolean {
  return pending.sceneId === snapshot.sceneId
    && serializedValuesEqual(pending.elements, snapshot.elements)
    && serializedValuesEqual(pending.files, snapshot.files)
    && serializedValuesEqual(
      serializedPersistableAppState(pending.elements, pending.appState, pending.files),
      snapshot.appState,
    );
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

function classroomTimeElementFingerprint(elements: readonly ExcalidrawElement[]): string {
  return elements.map((element) => (
    `${element.id}:${element.version}:${element.versionNonce}:${element.updated}:${element.isDeleted ? 1 : 0}`
  )).join("|");
}

const CLASSROOM_TIME_TRANSIENT_ELEMENT_REVISION_KEYS = new Set([
  "version",
  "versionNonce",
  "updated",
]);

/**
 * Returns true only when Excalidraw changed its element revision bookkeeping.
 * Every persisted/user-editable field, including fractional z-order index,
 * remains part of the signature, so a draw, move, delete, style edit,
 * widget-state transition, or layer-order change cannot be mistaken for a
 * wrapper-owned display tick.
 */
export function classroomTimeDisplayTickContentFingerprint(
  elements: readonly ExcalidrawElement[],
): string {
  return JSON.stringify(elements.map((element) => Object.fromEntries(
    Object.entries(element as unknown as Record<string, unknown>).filter(
      ([key]) => !CLASSROOM_TIME_TRANSIENT_ELEMENT_REVISION_KEYS.has(key),
    ),
  )));
}

export function classroomTimeDisplayTickElementsMatch(
  expected: readonly ExcalidrawElement[],
  actual: readonly ExcalidrawElement[],
): boolean {
  return classroomTimeDisplayTickContentFingerprint(expected)
    === classroomTimeDisplayTickContentFingerprint(actual);
}

function classroomTimeFileFingerprint(files: BinaryFiles): string {
  return Object.values(files)
    .map((file) => `${file.id}:${file.created}:${file.dataURL.length}`)
    .sort()
    .join("|");
}

/**
 * A dark/sharp PDF preview is a device-only replacement for the immutable
 * source background. Persistence must retain the scene's stable canonical
 * background record while preserving every live annotation in exact order.
 * Canonicalizing the live preview itself would continually bump the locked
 * background revision and turn display refinement into project edits.
 */
export function canonicalizePdfBackgroundForPersistence(
  scene: SerializedScene,
  liveElements: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const backgroundId = scene.pdfPage?.backgroundElementId;
  if (!backgroundId) return liveElements;
  const canonicalSceneElements = canonicalizePdfBackground(
    scene,
    scene.elements as unknown as readonly Record<string, unknown>[],
  );
  const background = canonicalSceneElements.find((element) => element.id === backgroundId);
  if (!background) return liveElements;
  return [
    background,
    ...liveElements.filter((element) => element.id !== backgroundId),
  ];
}

export function classroomTimeOperationSceneSignature(
  scene: SerializedScene | null | undefined,
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  transientFileIds: ReadonlySet<string>,
): Pick<
  ClassroomTimeSchedulerPublicationFence,
  "elementContentFingerprint" | "elementFingerprint" | "fileFingerprint"
> {
  const persistentElements = scene
    ? canonicalizePdfBackgroundForPersistence(
      scene,
      elements as unknown as readonly Record<string, unknown>[],
    ) as unknown as readonly ExcalidrawElement[]
    : elements;
  const persistentFiles = scene
    ? persistentFilesForScene(scene, files, transientFileIds)
    : files;
  return {
    elementContentFingerprint: classroomTimeDisplayTickContentFingerprint(persistentElements),
    elementFingerprint: classroomTimeElementFingerprint(persistentElements),
    fileFingerprint: classroomTimeFileFingerprint(persistentFiles),
  };
}

export function classroomTimeTickFenceMatches(
  fence: ClassroomTimeTickFence,
  sceneId: string | null,
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
): boolean {
  if (fence.sceneId !== sceneId || fence.fileFingerprint !== classroomTimeFileFingerprint(files)) {
    return false;
  }
  return fence.elementFingerprint === classroomTimeElementFingerprint(elements)
    || (
      !!fence.expectedDisplayContentFingerprint
      && fence.expectedDisplayContentFingerprint
        === classroomTimeDisplayTickContentFingerprint(elements)
    );
}

export type ClassroomTimeConfirmationToast = {
  token: number;
  message: string;
};

export const CLASSROOM_TIME_CONFIRMATION_TOAST_DURATION_MS = 2_500;

/**
 * Wrapper-owned confirmations use a hard deadline: Excalidraw's native toast
 * timer restarts during live widget redraws and pauses while hovered. Keeping
 * the current token in a ref prevents an older deadline from clearing a newer
 * confirmation while remaining independent of React/Excalidraw rerenders.
 */
export function scheduleClassroomTimeConfirmationToast(
  toast: ClassroomTimeConfirmationToast,
  currentToastRef: { current: ClassroomTimeConfirmationToast | null },
  publish: (toast: ClassroomTimeConfirmationToast | null) => void,
  durationMs = CLASSROOM_TIME_CONFIRMATION_TOAST_DURATION_MS,
): () => void {
  currentToastRef.current = toast;
  publish(toast);
  const timeoutId = window.setTimeout(() => {
    if (currentToastRef.current?.token !== toast.token) return;
    currentToastRef.current = null;
    publish(null);
  }, durationMs);
  return () => window.clearTimeout(timeoutId);
}

function classroomTimeGestureInProgress(appState: AppState): boolean {
  const extended = appState as AppState & {
    draggingElement?: unknown;
    selectedElementsAreBeingDragged?: boolean;
  };
  return Boolean(
    appState.newElement
    || appState.resizingElement
    || appState.isResizing
    || appState.isRotating
    || appState.multiElement
    || extended.draggingElement
    || extended.selectedElementsAreBeingDragged,
  );
}

function replaceClassroomTimeMetadata(
  element: ExcalidrawElement,
  metadata: ClassroomTimeWidgetMetadataV1,
): ExcalidrawElement {
  return newElementWith(element, {
    customData: {
      ...(element.customData || {}),
      classroomTimeWidget: metadata,
    },
  });
}

export function attachProjectCalendarTransferCache(
  elements: readonly ExcalidrawElement[],
  project: ClassroomProject,
  ownerIds?: ReadonlySet<string>,
): readonly ExcalidrawElement[] {
  const projectCalendar = project.projectCalendar
    ?? createClassroomCalendarStoreV1("project");
  let changed = false;
  const updated = elements.map((element) => {
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")) return element;
    if (ownerIds && !ownerIds.has(metadata.ownerId)) return element;
    const existingCache = metadata.calendar.transferCache;
    if (existingCache && existingCache.sourceProjectId !== project.id) return element;
    const referenced = new Set(metadata.calendar.projectEventIds);
    const events = referenced.size
      ? projectCalendar.events.filter((event) => referenced.has(event.id))
      : projectCalendar.events;
    const transferCache = createProjectCalendarTransferCache(
      project.id,
      createClassroomCalendarStoreV1("project", events),
    );
    if (serializedValuesEqual(metadata.calendar.transferCache, transferCache)) return element;
    changed = true;
    return replaceClassroomTimeMetadata(element, {
      ...metadata,
      calendar: { ...metadata.calendar, transferCache },
    });
  });
  return changed ? updated : elements;
}

export type PreparedClassroomTimeLibraryItem = {
  item: LibraryItems[number];
  ownerIds: readonly string[];
};

export function shouldAllowNativePersonalLibraryCanvasDrop(
  nativeLibraryCardDragStarted: boolean,
  dataTransferTypes: readonly string[],
  hasFile: boolean,
): boolean {
  return nativeLibraryCardDragStarted
    && !hasFile
    && dataTransferTypes.includes(EXCALIDRAW_LIBRARY_MIME);
}

/**
 * Builds the one library item that Excalidraw's native image guard cannot.
 * The selection must consist exclusively of complete Classroom Time owner
 * groups. Device-calendar display rows are canonicalized away first, while a
 * bounded project-event transfer cache is attached to each Calendar or
 * Dashboard anchor. Native library v2 has no file table, so its image anchor
 * remains a local logical reference; insertion regenerates the deterministic
 * SVG shell from sanitized metadata before the scene is published.
 */
export function prepareClassroomTimeLibraryItemForSelection(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  project: ClassroomProject,
  selectedElementIds: Readonly<Record<string, boolean>>,
  now = Date.now(),
  createId: () => string = createLocalId,
): PreparedClassroomTimeLibraryItem | null {
  const liveElements = elements.filter((element) => !element.isDeleted);
  const selectedElements = liveElements.filter((element) => selectedElementIds[element.id]);
  if (!selectedElements.length) return null;
  const hasSelectedClassroomTimeElement = selectedElements.some((element) => (
    classroomTimeWidgetOwnerId(element) !== null
  ));
  if (!hasSelectedClassroomTimeElement) return null;
  const selectedWidget = selectedClassroomTimeWidget(elements, selectedElementIds);
  if (!selectedWidget) {
    throw new Error("Select one complete Classroom Time widget before adding it to Personal Library.");
  }
  if (selectedElements.some((element) => (
    classroomTimeWidgetOwnerId(element) !== selectedWidget.ownerId
  ))) {
    throw new Error("Add the Classroom Time widget by itself so its complete local content stays together.");
  }
  const ownerIds = new Set([selectedWidget.ownerId]);

  const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
    elements,
    files,
    project.projectCalendar,
    now,
    createId,
  );
  const portable = attachProjectCalendarTransferCache(
    canonical.elements,
    project,
    ownerIds,
  );
  const itemElements = portable.filter((element) => (
    !element.isDeleted
    && ownerIds.has(classroomTimeWidgetOwnerId(element) ?? "")
  ));
  for (const ownerId of ownerIds) {
    const anchor = itemElements.find((element) => (
      classroomTimeWidgetMetadata(element)?.ownerId === ownerId
    ));
    const file = anchor?.type === "image" && anchor.fileId
      ? canonical.files[anchor.fileId]
      : undefined;
    if (
      !anchor
      || !file
      || file.mimeType !== "image/svg+xml"
      || !String(file.dataURL).startsWith("data:image/svg+xml")
      || String(file.dataURL).length > MAX_EXCALIDRAW_CLIPBOARD_IMAGE_BYTES
    ) {
      throw new Error("The selected Classroom Time widget does not have a safe local SVG shell.");
    }
  }

  const firstMetadata = itemElements
    .map((element) => classroomTimeWidgetMetadata(element))
    .find((metadata): metadata is ClassroomTimeWidgetMetadataV1 => metadata !== null);
  const item = {
    id: createId(),
    status: "unpublished" as const,
    elements: itemElements.map((element) => ({ ...element, frameId: null })),
    created: now,
    name: ownerIds.size === 1
      ? firstMetadata?.label || "Classroom Time"
      : `${ownerIds.size} Classroom Time widgets`,
  } as LibraryItems[number];
  const safe = sanitizeLibraryItems([item]);
  if (safe.length !== 1) {
    throw new Error("The selected Classroom Time widget could not be prepared safely.");
  }
  return { item: safe[0], ownerIds: [...ownerIds] };
}

/**
 * Applies a one-shot Add-to-library transfer snapshot to at most one new,
 * source-matching item. Existing portable caches are authoritative and are
 * never rewritten from the project that merely happens to be open now.
 */
export function applyClassroomTimeLibraryTransferIntent(
  items: LibraryItems,
  intent: ClassroomTimeLibraryTransferIntent | null,
): { items: LibraryItems; matchedItemId: string | null } {
  if (!intent?.cacheByAnchorId.size) return { items, matchedItemId: null };
  let matchedItemId: string | null = null;
  let changed = false;
  const prepared = items.map((item) => {
    if (matchedItemId || intent.baselineItemIds.has(item.id)) return item;
    let itemMatched = false;
    let itemChanged = false;
    const elements = (item.elements as unknown as readonly ExcalidrawElement[]).map((element) => {
      const source = intent.cacheByAnchorId.get(element.id);
      if (!source) return element;
      const metadata = classroomTimeWidgetMetadata(element);
      if (
        !metadata
        || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")
        || metadata.ownerId !== source.ownerId
        || metadata.kind !== source.kind
      ) return element;
      itemMatched = true;
      if (metadata.calendar.transferCache !== null) return element;
      itemChanged = true;
      return replaceClassroomTimeMetadata(element, {
        ...metadata,
        calendar: {
          ...metadata.calendar,
          transferCache: source.transferCache,
        },
      });
    });
    if (!itemMatched) return item;
    matchedItemId = item.id;
    if (!itemChanged) return item;
    changed = true;
    return { ...item, elements };
  }) as LibraryItems;
  return { items: changed ? prepared : items, matchedItemId };
}

export function importClassroomTimeCalendarTransfer(
  metadata: ClassroomTimeWidgetMetadataV1,
  currentProjectId: string,
  projectCalendar: ClassroomProjectCalendarStoreV1,
): {
  metadata: ClassroomTimeWidgetMetadataV1;
  projectCalendar: ClassroomProjectCalendarStoreV1;
  calendarChanged: boolean;
} {
  if (
    (metadata.kind !== "calendar" && metadata.kind !== "dashboard")
    || metadata.calendar.transferCache === null
  ) return { metadata, projectCalendar, calendarChanged: false };
  const transfer = metadata.calendar.transferCache;
  if (transfer.sourceProjectId === currentProjectId) {
    return {
      metadata: {
        ...metadata,
        calendar: { ...metadata.calendar, transferCache: null },
      },
      projectCalendar,
      calendarChanged: false,
    };
  }
  const imported = importProjectCalendarTransferCache(projectCalendar, transfer);
  const sourceIds = metadata.calendar.projectEventIds.length
    ? metadata.calendar.projectEventIds
    : transfer.events.map((event) => event.id);
  const projectEventIds = [...new Set(sourceIds.flatMap((eventId) => {
    const destinationId = imported.idMap[eventId];
    return destinationId ? [destinationId] : [];
  }))];
  return {
    metadata: {
      ...metadata,
      calendar: {
        ...metadata.calendar,
        showProjectEvents: sourceIds.length > 0
          ? metadata.calendar.showProjectEvents
          : false,
        projectEventIds,
        transferCache: null,
      },
    },
    projectCalendar: imported.store,
    calendarChanged: imported.importedEventIds.length > 0,
  };
}

function classroomTimeNextTransitionAtMs(
  metadata: ClassroomTimeWidgetMetadataV1,
): number | null {
  const deadlines: number[] = [];
  const collect = (runtime: { status: string; deadlineMs: number | null }) => {
    if (runtime.status === "running" && runtime.deadlineMs !== null) {
      deadlines.push(runtime.deadlineMs);
    }
  };
  if (metadata.kind === "timer" || metadata.kind === "pomodoro") {
    collect(metadata.runtime);
  } else if (metadata.kind === "dashboard") {
    if (metadata.panels.timer) collect(metadata.timerRuntime);
    if (metadata.panels.pomodoro) collect(metadata.pomodoroRuntime);
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}

function classroomTimeSchedulerSceneIndex(
  sceneId: string,
  elements: readonly ExcalidrawElement[],
  capacity: number,
): ClassroomTimeSchedulerSceneIndex | null {
  const ownerIds: string[] = [];
  const seenOwners = new Set<string>();
  let nextTransitionAtMs: number | null = null;
  for (const element of elements) {
    if (ownerIds.length >= capacity) break;
    if (element.isDeleted) continue;
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata || seenOwners.has(metadata.ownerId)) continue;
    seenOwners.add(metadata.ownerId);
    ownerIds.push(metadata.ownerId);
    const deadline = classroomTimeNextTransitionAtMs(metadata);
    if (deadline !== null && (nextTransitionAtMs === null || deadline < nextTransitionAtMs)) {
      nextTransitionAtMs = deadline;
    }
  }
  return ownerIds.length ? { sceneId, ownerIds, nextTransitionAtMs } : null;
}

export function createClassroomTimeSchedulerIndex(
  project: ClassroomProject | null,
): ClassroomTimeSchedulerIndex {
  if (!project) return { projectId: null, widgetCount: 0, scenes: new Map() };
  const scenes = new Map<string, ClassroomTimeSchedulerSceneIndex>();
  let widgetCount = 0;
  for (const scene of Object.values(project.scenes)) {
    if (widgetCount >= MAX_CLASSROOM_TIME_WIDGETS) break;
    const entry = classroomTimeSchedulerSceneIndex(
      scene.id,
      scene.elements as unknown as readonly ExcalidrawElement[],
      MAX_CLASSROOM_TIME_WIDGETS - widgetCount,
    );
    if (!entry) continue;
    scenes.set(scene.id, entry);
    widgetCount += entry.ownerIds.length;
  }
  return { projectId: project.id, widgetCount, scenes };
}

export function updateClassroomTimeSchedulerSceneIndex(
  current: ClassroomTimeSchedulerIndex,
  projectId: string,
  sceneId: string,
  elements: readonly ExcalidrawElement[],
): ClassroomTimeSchedulerIndex {
  const scenes = new Map(
    current.projectId === projectId ? current.scenes : [],
  );
  scenes.delete(sceneId);
  let widgetCount = [...scenes.values()].reduce(
    (count, entry) => count + entry.ownerIds.length,
    0,
  );
  const entry = classroomTimeSchedulerSceneIndex(
    sceneId,
    elements,
    Math.max(0, MAX_CLASSROOM_TIME_WIDGETS - widgetCount),
  );
  if (entry) {
    scenes.set(sceneId, entry);
    widgetCount += entry.ownerIds.length;
  }
  return { projectId, widgetCount, scenes };
}

function classroomTimeOwnerIds(project: ClassroomProject): ReadonlySet<string> {
  const ownerIds = new Set<string>();
  for (const scene of Object.values(project.scenes)) {
    for (const element of scene.elements as unknown as readonly ExcalidrawElement[]) {
      if (element.isDeleted) continue;
      const metadata = classroomTimeWidgetMetadata(element);
      if (metadata) ownerIds.add(metadata.ownerId);
    }
  }
  return ownerIds;
}

export function removedClassroomTimeAlarmIdentities(
  previous: ClassroomProject,
  next: ClassroomProject,
): readonly ClassroomAlarmIdentity[] {
  if (previous.id !== next.id) return [];
  const retainedOwners = classroomTimeOwnerIds(next);
  return [...classroomTimeOwnerIds(previous)]
    .filter((ownerId) => !retainedOwners.has(ownerId))
    .flatMap((ownerId) => ([
      { sourceProjectId: previous.id, ownerId, target: "timer" as const },
      { sourceProjectId: previous.id, ownerId, target: "pomodoro" as const },
    ]));
}

export function replacedClassroomTimeAlarmIdentities(
  outgoing: ClassroomProject | null,
  incoming: ClassroomProject,
): readonly ClassroomAlarmIdentity[] {
  if (!outgoing || outgoing.id !== incoming.id) return [];
  const incomingByIdentity = new Map(
    projectClassroomTimeAlarmDescriptors(incoming).map((descriptor) => [
      classroomAlarmIdentityKey(descriptor),
      descriptor,
    ]),
  );
  return [...new Map(projectClassroomTimeAlarmDescriptors(outgoing).flatMap((descriptor) => {
    const retained = incomingByIdentity.get(classroomAlarmIdentityKey(descriptor));
    if (
      retained
      && classroomAlarmJobMatchesDescriptor(classroomAlarmJobFromDescriptor(descriptor), retained)
    ) return [];
    const identity = {
      sourceProjectId: descriptor.sourceProjectId,
      ownerId: descriptor.ownerId,
      target: descriptor.target,
    } as const;
    return [[classroomAlarmIdentityKey(identity), identity] as const];
  })).values()];
}

export function pauseClassroomAlarmIdentitiesInProject(
  project: ClassroomProject,
  identities: readonly ClassroomAlarmIdentity[],
  now = Date.now(),
): ClassroomProject {
  const targetsByOwner = new Map<string, Set<"timer" | "pomodoro">>();
  for (const identity of identities) {
    if (identity.sourceProjectId !== project.id) continue;
    const targets = targetsByOwner.get(identity.ownerId) ?? new Set();
    targets.add(identity.target);
    targetsByOwner.set(identity.ownerId, targets);
  }
  if (!targetsByOwner.size) return project;
  let changed = false;
  const scenes = Object.fromEntries(Object.entries(project.scenes).map(([sceneId, scene]) => {
    let sceneChanged = false;
    const elements = (scene.elements as unknown as readonly ExcalidrawElement[]).map((element) => {
      if (element.isDeleted) return element;
      const metadata = classroomTimeWidgetMetadata(element);
      const targets = metadata ? targetsByOwner.get(metadata.ownerId) : undefined;
      if (!metadata || !targets) return element;
      let paused = metadata;
      for (const target of targets) {
        paused = applyClassroomTimeControl(paused, target, "pause", now);
      }
      if (paused === metadata || serializedValuesEqual(paused, metadata)) return element;
      sceneChanged = true;
      return replaceClassroomTimeMetadata(element, paused);
    });
    if (!sceneChanged) return [sceneId, scene];
    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      elements,
      scene.files as unknown as BinaryFiles,
      project.projectCalendar,
      now,
      createLocalId,
    );
    changed = true;
    return [sceneId, {
      ...scene,
      elements: canonical.elements as unknown as SerializedScene["elements"],
      files: canonical.files as unknown as SerializedScene["files"],
    }];
  }));
  return changed ? { ...project, scenes, updatedAt: nowIso() } : project;
}

function projectClassroomTimeAlarmDescriptors(
  project: ClassroomProject,
): readonly ClassroomTimeAlarmDescriptor[] {
  return Object.values(project.scenes).flatMap((scene) => (
    activeClassroomTimeAlarmDescriptors(
      project.id,
      scene.elements as unknown as readonly ExcalidrawElement[],
    )
  ));
}

function classroomAlarmIdentityKey(identity: ClassroomAlarmIdentity): string {
  return `${identity.sourceProjectId}:${identity.ownerId}:${identity.target}`;
}

export function prepareSameProjectClassroomAlarmReplacement(
  outgoing: ClassroomProject | null,
  incoming: ClassroomProject,
  registry: ClassroomAlarmRegistryV1,
  now = Date.now(),
): {
  project: ClassroomProject;
  state: ClassroomAlarmRegistryStateV1;
  cancelledIdentities: readonly ClassroomAlarmIdentity[];
  cancelledJobs: readonly ClassroomAlarmJobV1[];
  recoveredJobs: readonly ClassroomAlarmJobV1[];
  pausedIdentities: readonly ClassroomAlarmIdentity[];
} {
  const replacesSameProject = outgoing?.id === incoming.id;
  const outgoingDescriptors = replacesSameProject && outgoing
    ? projectClassroomTimeAlarmDescriptors(outgoing)
    : [];
  const incomingDescriptors = projectClassroomTimeAlarmDescriptors(incoming);
  const incomingById = new Map(incomingDescriptors.map((descriptor) => [descriptor.id, descriptor]));
  const cancellationAdditions = new Map<string, {
    identity: ClassroomAlarmIdentity;
    tombstone: ClassroomAlarmRegistryV1["cancellationTombstones"][number];
    cancelledJob: ClassroomAlarmJobV1 | null;
  }>();
  for (const descriptor of outgoingDescriptors) {
    const incomingDescriptor = incomingById.get(descriptor.id);
    if (incomingDescriptor && classroomAlarmJobMatchesDescriptor(
      classroomAlarmJobFromDescriptor(descriptor),
      incomingDescriptor,
    )) continue;
    const currentJob = registry.jobs.find((job) => (
      classroomAlarmJobMatchesDescriptor(job, descriptor)
    ));
    // A different/newer job can belong to another tab using the same project.
    // Only cancel the exact outgoing generation this tab is replacing.
    if (!currentJob) continue;
    const identity = {
      sourceProjectId: descriptor.sourceProjectId,
      ownerId: descriptor.ownerId,
      target: descriptor.target,
    } as const;
    cancellationAdditions.set(classroomAlarmIdentityKey(identity), {
      identity,
      tombstone: {
        version: 1,
        ...identity,
        cancelledAtMs: Math.max(now, currentJob.createdAtMs),
        cancelledGeneration: currentJob.deliveryState === "pending" ? {
          jobId: currentJob.id,
          createdAtMs: currentJob.createdAtMs,
          deadlineMs: currentJob.deadlineMs,
        } : null,
        restoredAtMs: null,
      },
      cancelledJob: currentJob.deliveryState === "pending" ? currentJob : null,
    });
  }
  const cancellationTombstones = pruneClassroomAlarmCancellationTombstones([
    ...registry.cancellationTombstones,
    ...[...cancellationAdditions.values()].map((addition) => addition.tombstone),
  ], now);
  const deliveredTombstones = pruneClassroomAlarmDeliveryTombstones(
    registry.deliveredTombstones,
    now,
  );
  let jobs = applyClassroomAlarmCancellationAuthority(
    registry.jobs,
    cancellationTombstones,
    now,
  );
  for (const descriptor of incomingDescriptors) {
    const requested = classroomAlarmJobFromDescriptor(descriptor);
    const crossIdentityIdCollision = jobs.some((job) => (
      job.id === requested.id
      && classroomAlarmIdentityKey(job) !== classroomAlarmIdentityKey(requested)
    ));
    // Alarm IDs are intentionally compact (`owner:target`). A project copied
    // on another device can therefore collide with an unrelated project's
    // owner ID; recovery must never replace that unrelated durable job.
    if (crossIdentityIdCollision) continue;
    jobs = recoverClassroomAlarmJob({
      version: 1,
      revision: registry.revision,
      jobs,
      deliveredTombstones,
      cancellationTombstones,
    }, requested, now);
  }
  const pausedByKey = new Map<string, ClassroomAlarmIdentity>();
  for (const descriptor of incomingDescriptors) {
    const authorized = jobs.some((job) => (
      job.deliveryState === "pending"
      && classroomAlarmJobMatchesDescriptor(job, descriptor)
    ));
    if (authorized) continue;
    const identity = {
      sourceProjectId: descriptor.sourceProjectId,
      ownerId: descriptor.ownerId,
      target: descriptor.target,
    } as const;
    pausedByKey.set(classroomAlarmIdentityKey(identity), identity);
  }
  const pausedIdentities = [...pausedByKey.values()];
  const recoveredJobs = incomingDescriptors.flatMap((descriptor) => {
    const recovered = jobs.find((job) => (
      job.deliveryState === "pending"
      && classroomAlarmJobMatchesDescriptor(job, descriptor)
    ));
    if (!recovered || registry.jobs.some((job) => serializedValuesEqual(job, recovered))) return [];
    return [recovered];
  });
  return {
    project: pauseClassroomAlarmIdentitiesInProject(incoming, pausedIdentities, now),
    state: { jobs, deliveredTombstones, cancellationTombstones },
    cancelledIdentities: [...cancellationAdditions.values()].map((addition) => addition.identity),
    cancelledJobs: [...cancellationAdditions.values()].flatMap((addition) => (
      addition.cancelledJob ? [addition.cancelledJob] : []
    )),
    recoveredJobs,
    pausedIdentities,
  };
}

/**
 * Adapts Excalidraw's already-duplicated scene to Classroom Time ownership
 * without invalidating Excalidraw's selected IDs, binding repair, or frames.
 */
export function forkNativeClassroomTimeWidgetDuplicates(
  nextElements: readonly ExcalidrawElement[],
  previousElements: readonly ExcalidrawElement[],
  now = Date.now(),
  createId: () => string = createLocalId,
): ReturnType<typeof forkDuplicatedClassroomTimeWidgets> {
  const previousIds = new Set(previousElements.map((element) => element.id));
  const duplicatedElements = nextElements.filter((element) => !previousIds.has(element.id));
  if (!duplicatedElements.length) {
    return { elements: nextElements, ownerIdMap: {}, elementIdMap: {} };
  }
  const sourceAnchors = new Map<string, ExcalidrawElement>();
  for (const element of previousElements) {
    if (element.isDeleted) continue;
    const metadata = classroomTimeWidgetMetadata(element);
    if (metadata) sourceAnchors.set(metadata.ownerId, element);
  }
  const sourceToDuplicateGroupIds = new Map<string, string>();
  for (const element of duplicatedElements) {
    if (element.isDeleted) continue;
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata) continue;
    const source = sourceAnchors.get(metadata.ownerId);
    const ownerGroupIndex = source?.groupIds.indexOf(metadata.ownerId) ?? -1;
    const duplicateGroupId = ownerGroupIndex >= 0
      ? element.groupIds[ownerGroupIndex]
      : element.groupIds[0];
    if (!duplicateGroupId) {
      throw new Error(`Duplicated classroom widget ${metadata.ownerId} has no owner group.`);
    }
    const existing = sourceToDuplicateGroupIds.get(metadata.ownerId);
    if (existing && existing !== duplicateGroupId) {
      throw new Error(`Duplicated classroom widget ${metadata.ownerId} has inconsistent owner groups.`);
    }
    sourceToDuplicateGroupIds.set(metadata.ownerId, duplicateGroupId);
  }
  if (!sourceToDuplicateGroupIds.size) {
    return { elements: nextElements, ownerIdMap: {}, elementIdMap: {} };
  }
  const forked = forkDuplicatedClassroomTimeWidgets(duplicatedElements, {
    sourceToDuplicateGroupIds,
    now,
    createId,
  });
  const byId = new Map(forked.elements.map((element) => [element.id, element]));
  return {
    ...forked,
    elements: nextElements.map((element) => byId.get(element.id) ?? element),
  };
}

function mergeClassroomTimeFiles(
  files: BinaryFiles,
  addedFiles: readonly BinaryFileData[],
  orphanedFileIds: readonly FileId[],
): BinaryFiles {
  const merged = { ...files } as BinaryFiles;
  for (const file of addedFiles) merged[file.id] = file;
  for (const fileId of orphanedFileIds) delete merged[fileId];
  return merged;
}

const EMPTY_DEVICE_CLASSROOM_CALENDAR = createClassroomCalendarStoreV1("device");

/** Device-calendar labels exist only in the live editor or an explicit export. */
export function materializeClassroomTimeSceneForDisplay(
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
  projectCalendar: ClassroomProjectCalendarStoreV1 | null | undefined,
  deviceCalendar: ClassroomDeviceCalendarStoreV1,
  now = Date.now(),
  createId: () => string = createLocalId,
  boardTheme: "light" | "dark" = "light",
): {
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
  addedFiles: readonly BinaryFileData[];
  orphanedFileIds: readonly FileId[];
} {
  const renderContext = classroomTimeRenderContext(
    elements,
    projectCalendar,
    deviceCalendar,
    now,
    boardTheme,
  );
  const reconciled = reconcileClassroomTimeWidgets(elements, {
    now,
    files,
    createId,
    renderContext,
  });
  return {
    elements: reconciled.elements,
    files: mergeClassroomTimeFiles(files, reconciled.addedFiles, reconciled.orphanedFileIds),
    addedFiles: reconciled.addedFiles,
    orphanedFileIds: reconciled.orphanedFileIds,
  };
}

export function materializeProjectClassroomTimeWidgets(
  project: ClassroomProject,
  capturedAt: number,
  deviceCalendar: ClassroomDeviceCalendarStoreV1,
  boardTheme: "light" | "dark",
  createId: () => string = createLocalId,
): ClassroomProject {
  let changed = false;
  const scenes = Object.fromEntries(Object.entries(project.scenes).map(([sceneId, scene]) => {
    const source = scene.elements as unknown as readonly ExcalidrawElement[];
    if (!source.some((element) => classroomTimeWidgetMetadata(element))) {
      return [sceneId, scene];
    }
    const materialized = materializeClassroomTimeSceneForDisplay(
      source,
      scene.files as unknown as BinaryFiles,
      project.projectCalendar,
      deviceCalendar,
      capturedAt,
      createId,
      boardTheme,
    );
    changed = true;
    return [sceneId, {
      ...scene,
      elements: materialized.elements as unknown as SerializedScene["elements"],
      files: materialized.files as unknown as SerializedScene["files"],
    }];
  }));
  return changed ? { ...project, scenes } : project;
}

function classroomAlarmNoticeMessage(jobs: readonly ClassroomAlarmJobV1[]): string {
  const labels = [...new Set(jobs.map((job) => job.label.trim()).filter(Boolean))];
  if (!labels.length) return "A classroom timer has finished.";
  if (labels.length === 1) return `${labels[0]} has finished.`;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]} have finished.`;
  return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more timers have finished.`;
}

export function classroomTimeAlarmNoticeAfterSupersedingJob(
  notice: ClassroomTimeAlarmNotice | null,
  jobId: string,
): ClassroomTimeAlarmNotice | null {
  if (!notice?.jobIds.includes(jobId)) return notice;
  const jobs = notice.jobs.filter((job) => job.id !== jobId);
  if (!jobs.length) return null;
  return {
    jobs,
    jobIds: jobs.map((job) => job.id),
    message: classroomAlarmNoticeMessage(jobs),
    blocked: notice.blocked || jobs.some((job) => job.deliveryState === "blocked"),
    deliveryPending: notice.deliveryPending,
  };
}

export function classroomTimeAlarmNoticeCanDismiss(
  notice: ClassroomTimeAlarmNotice | null,
): notice is ClassroomTimeAlarmNotice {
  return !!notice && !notice.deliveryPending;
}

function classroomAlarmJobMatchesDescriptor(
  job: ClassroomAlarmJobV1,
  descriptor: ClassroomTimeAlarmDescriptor,
): boolean {
  return job.id === descriptor.id
    && job.sourceProjectId === descriptor.sourceProjectId
    && job.ownerId === descriptor.ownerId
    && job.widgetKind === descriptor.widgetKind
    && job.target === descriptor.target
    && job.label === descriptor.label
    && job.deadlineMs === descriptor.deadlineMs
    && job.tone === descriptor.tone
    && job.repeat === descriptor.repeat
    && job.createdAtMs === descriptor.createdAtMs;
}

export function classroomAlarmJobFromDescriptor(
  descriptor: ClassroomTimeAlarmDescriptor,
): ClassroomAlarmJobV1 {
  return createClassroomAlarmJob({
    id: descriptor.id,
    sourceProjectId: descriptor.sourceProjectId,
    ownerId: descriptor.ownerId,
    widgetKind: descriptor.widgetKind,
    target: descriptor.target,
    label: descriptor.label,
    deadlineMs: descriptor.deadlineMs,
    tone: descriptor.tone,
    repeat: descriptor.repeat,
    createdAtMs: descriptor.createdAtMs,
  });
}

function pendingClassroomAlarmJob(
  job: ClassroomAlarmJobV1,
): ClassroomAlarmJobV1 {
  return {
    ...job,
    deliveryState: "pending",
    deliveryStateAtMs: null,
  };
}

export function classroomAlarmTransactionReceiptMatchesProject(
  receipt: ClassroomAlarmTransactionReceiptV1,
  project: ClassroomProject,
): boolean {
  const descriptors = projectClassroomTimeAlarmDescriptors(project);
  return receipt.stagedJobs.length > 0 && receipt.stagedJobs.every((job) => (
    descriptors.some((descriptor) => classroomAlarmJobMatchesDescriptor(job, descriptor))
  ));
}

export function classroomAlarmIdentitiesForTransactionReceipts(
  receipts: readonly ClassroomAlarmTransactionReceiptV1[],
): readonly ClassroomAlarmIdentity[] {
  return [...new Map(receipts.flatMap((receipt) => receipt.stagedJobs).map((job) => {
    const identity = {
      sourceProjectId: job.sourceProjectId,
      ownerId: job.ownerId,
      target: job.target,
    } as const;
    return [classroomAlarmIdentityKey(identity), identity];
  })).values()];
}

export interface PreparedClassroomAlarmPublication {
  project: ClassroomProject;
  receipts: readonly ClassroomAlarmTransactionReceiptV1[];
  pausedIdentities: readonly ClassroomAlarmIdentity[];
}

/**
 * Project reconciliation is an authority repair, not a generic project-change
 * notification. Avoid advancing the shared async-operation generation when an
 * idle project (for example, the result of native Undo) has no alarm work, or
 * when every running descriptor already has its exact pending authority.
 */
export function classroomTimeAlarmReconciliationNeeded(
  project: ClassroomProject,
  registry: ClassroomAlarmRegistryV1,
): boolean {
  const descriptors = projectClassroomTimeAlarmDescriptors(project);
  if (!descriptors.length) return false;
  const byIdentity = new Map<string, ClassroomTimeAlarmDescriptor>();
  for (const descriptor of descriptors) {
    const key = classroomAlarmIdentityKey(descriptor);
    const prior = byIdentity.get(key);
    if (
      prior
      && !classroomAlarmJobMatchesDescriptor(classroomAlarmJobFromDescriptor(prior), descriptor)
    ) return true;
    byIdentity.set(key, descriptor);
  }
  return [...byIdentity.values()].some((descriptor) => !registry.jobs.some((job) => (
    job.deliveryState === "pending"
    && classroomAlarmJobMatchesDescriptor(job, descriptor)
  )));
}

/**
 * Prepares alarm authority without making any newly requested job deliverable.
 * Callers must recheck their UI/file fence, synchronously publish `project`,
 * and only then activate every returned receipt. A stale caller must roll the
 * receipts back exactly.
 */
export async function prepareClassroomAlarmPublication(
  incomingProject: ClassroomProject,
  nowMs: number,
  options: {
    resolvePersistedTransactions?: boolean;
    storage?: ClassroomAlarmStorage | null;
  } = {},
): Promise<PreparedClassroomAlarmPublication> {
  const storage = options.storage;
  const receipts: ClassroomAlarmTransactionReceiptV1[] = [];
  const pausedByIdentity = new Map<string, ClassroomAlarmIdentity>();
  const pauseJobs = (jobs: readonly ClassroomAlarmJobV1[]) => {
    for (const job of jobs) {
      const identity = {
        sourceProjectId: job.sourceProjectId,
        ownerId: job.ownerId,
        target: job.target,
      } as const;
      pausedByIdentity.set(classroomAlarmIdentityKey(identity), identity);
    }
  };

  if (options.resolvePersistedTransactions) {
    const persistedReceipts = listStagedClassroomAlarmTransactions(
      readClassroomAlarmRegistry(storage),
    );
    for (const persistedReceipt of persistedReceipts) {
      const currentRegistry = readClassroomAlarmRegistry(storage);
      const exactMatch = matchStagedClassroomAlarmTransaction(
        currentRegistry,
        persistedReceipt.stagedJobs.map(pendingClassroomAlarmJob),
        nowMs,
      );
      if (
        exactMatch?.transactionId === persistedReceipt.transactionId
        && classroomAlarmTransactionReceiptMatchesProject(persistedReceipt, incomingProject)
      ) {
        receipts.push(persistedReceipt);
        continue;
      }
      try {
        const rolledBack = await rollbackClassroomAlarmTransaction(
          persistedReceipt,
          nowMs,
          storage,
        );
        if (rolledBack.status !== "persisted") pauseJobs(persistedReceipt.stagedJobs);
      } catch {
        pauseJobs(persistedReceipt.stagedJobs);
      }
    }
  }

  const descriptorsByIdentity = new Map<string, ClassroomTimeAlarmDescriptor>();
  for (const descriptor of projectClassroomTimeAlarmDescriptors(incomingProject)) {
    const key = classroomAlarmIdentityKey(descriptor);
    const existing = descriptorsByIdentity.get(key);
    if (
      existing
      && !classroomAlarmJobMatchesDescriptor(classroomAlarmJobFromDescriptor(existing), descriptor)
    ) {
      pausedByIdentity.set(key, {
        sourceProjectId: descriptor.sourceProjectId,
        ownerId: descriptor.ownerId,
        target: descriptor.target,
      });
      descriptorsByIdentity.delete(key);
      continue;
    }
    if (!pausedByIdentity.has(key)) descriptorsByIdentity.set(key, descriptor);
  }

  for (const descriptor of descriptorsByIdentity.values()) {
    const requestedJob = classroomAlarmJobFromDescriptor(descriptor);
    const registry = readClassroomAlarmRegistry(storage);
    const alreadyPending = registry.jobs.some((job) => (
      job.deliveryState === "pending"
      && classroomAlarmJobMatchesDescriptor(job, descriptor)
    ));
    const alreadyStaged = receipts.some((receipt) => receipt.stagedJobs.some((job) => (
      classroomAlarmJobMatchesDescriptor(job, descriptor)
    )));
    if (alreadyPending || alreadyStaged) continue;

    const identity = {
      sourceProjectId: descriptor.sourceProjectId,
      ownerId: descriptor.ownerId,
      target: descriptor.target,
    } as const;
    const key = classroomAlarmIdentityKey(identity);
    const compactIdCollision = registry.jobs.some((job) => (
      job.id === requestedJob.id
      && classroomAlarmIdentityKey(job) !== key
    ));
    if (
      compactIdCollision
      || isClassroomAlarmJobCancelled(registry, requestedJob, nowMs)
      || hasClassroomAlarmDeliveredGeneration(registry, requestedJob, nowMs)
    ) {
      pausedByIdentity.set(key, identity);
      continue;
    }
    try {
      const staged = await stageRecoveredClassroomAlarmJobs(
        [requestedJob],
        nowMs,
        storage,
      );
      if (staged.status !== "persisted" || !staged.receipt) {
        pausedByIdentity.set(key, identity);
        continue;
      }
      receipts.push(staged.receipt);
    } catch {
      pausedByIdentity.set(key, identity);
    }
  }

  const stagedAsPending = receipts.flatMap((receipt) => (
    receipt.stagedJobs.map(pendingClassroomAlarmJob)
  ));
  const registry = readClassroomAlarmRegistry(storage);
  let project = pauseUnauthorizedClassroomTimeWidgetsInProject(
    incomingProject,
    { ...registry, jobs: [...registry.jobs, ...stagedAsPending] },
    nowMs,
  );
  if (pausedByIdentity.size) {
    project = pauseClassroomAlarmIdentitiesInProject(
      project,
      [...pausedByIdentity.values()],
      nowMs,
    );
  }
  return {
    project,
    receipts,
    pausedIdentities: [...pausedByIdentity.values()],
  };
}

export async function rollbackClassroomAlarmPublicationReceipts(
  receipts: readonly ClassroomAlarmTransactionReceiptV1[],
  nowMs: number,
  storage?: ClassroomAlarmStorage | null,
  onRefreshedCancellationReceipt?: (
    transactionReceipt: ClassroomAlarmTransactionReceiptV1,
    cancellationReceipt: ClassroomAlarmCancellationReceiptV1,
  ) => void,
): Promise<boolean> {
  let durable = true;
  for (const receipt of [...receipts].reverse()) {
    try {
      const result = await rollbackClassroomAlarmTransaction(receipt, nowMs, storage);
      if (result.status !== "persisted") durable = false;
      if (result.cancellationReceipt) {
        onRefreshedCancellationReceipt?.(receipt, result.cancellationReceipt);
      }
    } catch {
      durable = false;
    }
  }
  return durable;
}

export function classroomTimeAlarmDescriptorsNeedingTrustedStart(
  previous: readonly ClassroomTimeAlarmDescriptor[],
  next: readonly ClassroomTimeAlarmDescriptor[],
): readonly ClassroomTimeAlarmDescriptor[] {
  const previousByIdentity = new Map(previous.map((descriptor) => [
    classroomAlarmIdentityKey(descriptor),
    descriptor,
  ]));
  return next.filter((descriptor) => {
    const prior = previousByIdentity.get(classroomAlarmIdentityKey(descriptor));
    return !prior || !classroomAlarmJobMatchesDescriptor(
      classroomAlarmJobFromDescriptor(prior),
      descriptor,
    );
  });
}

export function finalizeClassroomTimeSchedulerAlarmReservation(
  project: ClassroomProject,
  descriptors: readonly ClassroomTimeAlarmDescriptor[],
  registry: ClassroomAlarmRegistryV1 | null,
  now = Date.now(),
): { project: ClassroomProject; authorized: boolean } {
  if (!descriptors.length) return { project, authorized: true };
  const authorized = registry !== null && descriptors.every((descriptor) => (
    registry.jobs.some((job) => (
      job.deliveryState === "pending"
      && classroomAlarmJobMatchesDescriptor(job, descriptor)
    ))
  ));
  if (authorized) return { project, authorized: true };
  const identities = [...new Map(descriptors.map((descriptor) => {
    const identity = {
      sourceProjectId: descriptor.sourceProjectId,
      ownerId: descriptor.ownerId,
      target: descriptor.target,
    } as const;
    return [classroomAlarmIdentityKey(identity), identity];
  })).values()];
  return {
    project: pauseClassroomAlarmIdentitiesInProject(project, identities, now),
    authorized: false,
  };
}

export interface ClassroomTimeSchedulerPublicationFence {
  project: ClassroomProject | null;
  activeSceneId: string | null;
  hydrationGeneration: number;
  operationGeneration: number;
  elementContentFingerprint?: string | null;
  elementFingerprint: string | null;
  fileFingerprint: string | null;
}

export function classroomTimeSchedulerPublicationFenceMatches(
  expected: ClassroomTimeSchedulerPublicationFence,
  current: ClassroomTimeSchedulerPublicationFence,
  interactionBlocked = false,
): boolean {
  return !interactionBlocked
    && expected.project === current.project
    && expected.activeSceneId === current.activeSceneId
    && expected.hydrationGeneration === current.hydrationGeneration
    && expected.operationGeneration === current.operationGeneration
    && expected.elementFingerprint === current.elementFingerprint
    && expected.fileFingerprint === current.fileFingerprint;
}

/**
 * Direct widget controls merge into the latest live anchor/project rather
 * than publishing a captured whole-project snapshot. They may therefore
 * tolerate React/autosave replacing the immutable project object, but only
 * while the stable project ID and every scene/content fence still match.
 */
export function classroomTimeControlPublicationFenceMatches(
  expected: ClassroomTimeSchedulerPublicationFence,
  current: ClassroomTimeSchedulerPublicationFence,
  interactionBlocked = false,
): boolean {
  const contentMatches = expected.elementContentFingerprint !== undefined
    && current.elementContentFingerprint !== undefined
    ? expected.elementContentFingerprint === current.elementContentFingerprint
    : expected.elementFingerprint === current.elementFingerprint;
  return !interactionBlocked
    && expected.project?.id === current.project?.id
    && expected.activeSceneId === current.activeSceneId
    && expected.hydrationGeneration === current.hydrationGeneration
    && expected.operationGeneration === current.operationGeneration
    // Excalidraw and the wrapper-owned widget renderer may bump only revision
    // bookkeeping while an alarm storage lock is pending. Direct controls read
    // and merge into the latest live scene, so accept that display-only churn
    // while still rejecting every persisted content change.
    && contentMatches
    && expected.fileFingerprint === current.fileFingerprint;
}

export function pauseClassroomTimeElementsWithoutMatchingAlarmJob(
  elements: readonly ExcalidrawElement[],
  projectId: string,
  registry: ReturnType<typeof readClassroomAlarmRegistry>,
  now = Date.now(),
  trackedStagedTransactionIds: ReadonlySet<string> = new Set(),
): readonly ExcalidrawElement[] {
  const authorityRegistry = projectTrackedStagedClassroomAlarmTransactionsAsPending(
    registry,
    trackedStagedTransactionIds,
    now,
  );
  let changed = false;
  const paused = elements.map((element) => {
    if (element.isDeleted) return element;
    const metadata = classroomTimeWidgetMetadata(element);
    if (!metadata) return element;
    let safeMetadata = metadata;
    for (const descriptor of activeClassroomTimeAlarmDescriptors(projectId, [element])) {
      const scheduled = authorityRegistry.jobs.find((job) => (
        job.deliveryState === "pending"
        && job.id === descriptor.id
        && classroomAlarmJobMatchesDescriptor(job, descriptor)
      ));
      if (!scheduled) {
        safeMetadata = applyClassroomTimeControl(
          safeMetadata,
          descriptor.target,
          "pause",
          now,
        );
      }
    }
    if (safeMetadata === metadata || serializedValuesEqual(safeMetadata, metadata)) return element;
    changed = true;
    return replaceClassroomTimeMetadata(element, safeMetadata);
  });
  return changed ? paused : elements;
}

export function pauseUnauthorizedClassroomTimeWidgetsInProject(
  project: ClassroomProject,
  registry: ClassroomAlarmRegistryV1,
  now = Date.now(),
  trackedStagedTransactionIds: ReadonlySet<string> = new Set(),
): ClassroomProject {
  let changed = false;
  const scenes = Object.fromEntries(Object.entries(project.scenes).map(([sceneId, scene]) => {
    const sourceElements = scene.elements as unknown as readonly ExcalidrawElement[];
    const pausedElements = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
      sourceElements,
      project.id,
      registry,
      now,
      trackedStagedTransactionIds,
    );
    if (pausedElements === sourceElements) return [sceneId, scene];
    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      pausedElements,
      scene.files as unknown as BinaryFiles,
      project.projectCalendar,
      now,
      createLocalId,
    );
    changed = true;
    return [sceneId, {
      ...scene,
      elements: canonical.elements as unknown as SerializedScene["elements"],
      files: canonical.files as unknown as SerializedScene["files"],
    }];
  }));
  return changed ? { ...project, scenes, updatedAt: nowIso() } : project;
}

export function projectWithPendingScene(
  current: ClassroomProject | null,
  pending: PendingScenePersistence,
  clearedSlideOrder: readonly ClassroomSlide[] = [],
): ClassroomProject | null {
  const previousScene = current?.scenes[pending.sceneId];
  if (!current || !previousScene) return null;
  const backgroundSafeElements = canonicalizePdfBackgroundForPersistence(
    previousScene,
    pending.elements as unknown as readonly Record<string, unknown>[],
  ) as unknown as readonly ExcalidrawElement[];
  const detachedElements = detachElementsFromSlideFrames(backgroundSafeElements);
  const classroomSafeScene = canonicalizeClassroomTimeWidgetsForPersistence(
    detachedElements,
    pending.files,
    current.projectCalendar,
  );
  const slideOrder = reconcileSlides(
    pending.sceneId,
    classroomSafeScene.elements,
    slideOrderForBoardClearUndo(current.slideOrder, clearedSlideOrder, pending.sceneId, classroomSafeScene.elements),
  );
  const namedElements = syncSlideFrameNames(classroomSafeScene.elements, slideOrder);
  const scene = serializedSceneFromChange(
    previousScene,
    namedElements,
    pending.appState,
    classroomSafeScene.files,
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
  const [isSceneInputBlocked, setIsSceneInputBlocked] = useState(true);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saving");
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [slideRotationTargetId, setSlideRotationTargetId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [busyCanCancel, setBusyCanCancel] = useState(false);
  const busyCancelRef = useRef<(() => void) | null>(null);
  const [pendingPdfInsert, setPendingPdfInsert] = useState<PendingPdfInsert | null>(null);
  const [pdfInsertProcessing, setPdfInsertProcessing] = useState(false);
  const [pdfInsertCancelling, setPdfInsertCancelling] = useState(false);
  const [pdfInsertCommitStarted, setPdfInsertCommitStarted] = useState(false);
  const [pdfInsertProgress, setPdfInsertProgress] = useState<PdfInsertOperationProgress | null>(null);
  const pdfInsertOperationGenerationRef = useRef<number | null>(null);
  const submitPdfInsertionRef = useRef<((
    submission: PdfInsertSubmission,
    pendingOverride?: PendingPdfInsert,
  ) => Promise<void>) | null>(null);
  const [pendingPdfAnnotationClear, setPendingPdfAnnotationClear] = useState<PendingPdfAnnotationClear | null>(null);
  const [pdfUndoToast, setPdfUndoToast] = useState<PdfUndoToast | null>(null);
  const [classroomTimeConfirmationToast, setClassroomTimeConfirmationToast] = useState<ClassroomTimeConfirmationToast | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autosaveRecoveryDetail, setAutosaveRecoveryDetail] = useState<string | null>(null);
  const [autosaveRecoveryKind, setAutosaveRecoveryKind] = useState<AutosaveRecoveryKind | null>(null);
  const libraryItemIdsRef = useRef(new Set<string>());
  const pendingClassroomTimeLibraryTransferRef = useRef<ClassroomTimeLibraryTransferIntent | null>(null);
  const libraryPersistencePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const nativePersonalLibraryDragRef = useRef(false);
  const [initialExcalidrawData] = useState<Promise<{ libraryItems: LibraryItems } | null>>(() => (
    loadLibraryItems()
      .then((libraryItems) => {
        libraryItemIdsRef.current = new Set(libraryItems.map((item) => item.id));
        return { libraryItems };
      })
      .catch((error) => {
        setErrorMessage(`Personal library could not be opened: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
  ));
  const [exportOpen, setExportOpen] = useState(false);
  const [pendingVisualPdfFallback, setPendingVisualPdfFallback] = useState<PendingVisualPdfFallback | null>(null);
  const [pendingProjectSwitch, setPendingProjectSwitch] = useState<PendingProjectSwitch | null>(null);
  const [pendingBoardClear, setPendingBoardClear] = useState<{
    projectId: string;
    sceneId: string;
    objectCount: number;
    slideCount: number;
    fingerprint: string;
  } | null>(null);
  const [boardClearProcessing, setBoardClearProcessing] = useState(false);
  const boardClearProcessingRef = useRef(false);
  const boardClearDialogOpenRef = useRef(false);
  boardClearDialogOpenRef.current = pendingBoardClear !== null;
  const clearBoardButtonRef = useRef<HTMLButtonElement>(null);
  const clearedBoardSlidesRef = useRef<readonly ClassroomSlide[]>([]);
  const [pendingPdfCompatibilityImport, setPendingPdfCompatibilityImport] = useState<PendingPdfCompatibilityImport | null>(null);
  const [archiveWorkerReadiness, setArchiveWorkerReadiness] = useState<ProjectArchiveWorkerReadiness | null>(null);
  const [storageReadiness, setStorageReadiness] = useState<StorageReadiness | null>(null);
  const [recoverySnapshots, setRecoverySnapshots] = useState<readonly AutosaveHistorySummary[]>([]);
  const [isRecoveryHistoryOpen, setIsRecoveryHistoryOpen] = useState(false);
  const [recoveryHistoryStatus, setRecoveryHistoryStatus] = useState<RecoveryHistoryStatus | null>(null);
  const [recoveryHistoryUnreadable, setRecoveryHistoryUnreadable] = useState(false);
  const [damagedRecoverySnapshotIds, setDamagedRecoverySnapshotIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const recoveryHistoryReturnFocusRef = useRef<HTMLElement | null>(null);
  const [dismissedRecoverySnapshotId, setDismissedRecoverySnapshotId] = useState<string | null>(null);
  const [localReadinessDismissed, setLocalReadinessDismissed] = useState(false);
  const [localReadinessBusy, setLocalReadinessBusy] = useState(false);
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
  const stopPresentationRef = useRef<(() => void) | null>(null);
  const presentationReturnFocusRef = useRef<HTMLElement | null>(null);
  const presentationReturnFocusWasTriggerRef = useRef(false);
  const presentationFocusRestoreFrameRef = useRef<number | null>(null);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const shortcutHelpReturnFocusRef = useRef<HTMLElement | null>(null);
  const openShortcutHelp = useCallback((returnFocusTarget?: HTMLElement | null) => {
    shortcutHelpReturnFocusRef.current = returnFocusTarget
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setIsShortcutHelpOpen(true);
  }, []);
  const [isCleanFullscreen, setIsCleanFullscreen] = useState(false);
  const isCleanFullscreenRef = useRef(isCleanFullscreen);
  isCleanFullscreenRef.current = isCleanFullscreen;
  const [isNativeZenMode, setIsNativeZenMode] = useState(false);
  const nativeZenModeRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("board");
  const workspaceModeRef = useRef<WorkspaceMode>(workspaceMode);
  workspaceModeRef.current = workspaceMode;
  const [isSlideRailVisible, setIsSlideRailVisible] = useState(true);
  const [pdfRailWidth, setPdfRailWidth] = useState(PDF_RAIL_DEFAULT_WIDTH);
  const [isPdfRailVisible, setIsPdfRailVisible] = useState(true);
  const [isPdfToolbarVisible, setIsPdfToolbarVisible] = useState(true);
  const [areSlideFramesVisible, setAreSlideFramesVisible] = useState(true);
  const [isSlideFrameDrawingActive, setIsSlideFrameDrawingActive] = useState(false);
  const [isNavigationVisible, setIsNavigationVisible] = useState(true);
  const [featurePreferences, setFeaturePreferences] = useState(readFeaturePreferences);
  const [pdfPreferences, setPdfPreferences] = useState(readPdfPreferences);
  const [classroomTimePreferences, setClassroomTimePreferences] = useState(readClassroomTimePreferences);
  const [deviceClassroomCalendar, setDeviceClassroomCalendar] = useState(readDeviceClassroomCalendar);
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
  const classroomTimePreferencesRef = useRef(classroomTimePreferences);
  classroomTimePreferencesRef.current = classroomTimePreferences;
  const deviceClassroomCalendarRef = useRef(deviceClassroomCalendar);
  deviceClassroomCalendarRef.current = deviceClassroomCalendar;
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
  const [classroomTimeDialog, setClassroomTimeDialog] = useState<ClassroomTimeDialogState | null>(null);
  const [selectedClassroomTime, setSelectedClassroomTime] = useState<SelectedClassroomTimeWidget | null>(null);
  const [presentationClassroomTimeSelection, setPresentationClassroomTimeSelection] = useState<
    PresentationClassroomTimeSelection | null
  >(null);
  const [classroomTimeActiveTarget, setClassroomTimeActiveTarget] = useState<ClassroomTimeOverlayTarget>("timer");
  const [classroomTimeNowMs, setClassroomTimeNowMs] = useState(Date.now);
  const [classroomTimeAlarmNotice, setClassroomTimeAlarmNotice] = useState<ClassroomTimeAlarmNotice | null>(null);
  const classroomTimeAlarmNoticeRef = useRef(classroomTimeAlarmNotice);
  classroomTimeAlarmNoticeRef.current = classroomTimeAlarmNotice;
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
  const pendingSlideRotationActionRef = useRef<PendingSlideRotationAction | null>(null);
  const slideRotationReturnFocusRef = useRef<HTMLElement | null>(null);
  const setFeaturePreference = useCallback((key: FeaturePreferenceKey, enabled: boolean) => {
    if (key === "slides" && !enabled) {
      pendingSlideFrameActionRef.current = null;
      pendingSlideRotationActionRef.current = null;
      setSlideRotationTargetId(null);
    }
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
    if (!nextPreferences.slides) {
      pendingSlideFrameActionRef.current = null;
      pendingSlideRotationActionRef.current = null;
      setSlideRotationTargetId(null);
    }
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
  useEffect(() => subscribeToClassroomTimePreferences((nextPreferences) => {
    classroomTimePreferencesRef.current = nextPreferences;
    setClassroomTimePreferences(nextPreferences);
  }), []);
  useEffect(() => subscribeToDeviceClassroomCalendar((nextCalendar) => {
    deviceClassroomCalendarRef.current = nextCalendar;
    setDeviceClassroomCalendar(nextCalendar);
  }), []);
  useEffect(() => subscribeToThemePreference(setThemePreferenceState), []);
  useEffect(() => subscribeToSystemTheme(setPrefersDarkTheme), []);
  useEffect(() => {
    if (presentation || featurePreferences.obsCaptureArea) setClassroomTimeDialog(null);
  }, [featurePreferences.obsCaptureArea, presentation]);
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
  const pdfOpenInputRef = useRef<HTMLInputElement>(null);
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
  const presentationTriggerRef = useRef<HTMLButtonElement>(null);
  const slideRailShowButtonRef = useRef<HTMLButtonElement>(null);
  const pdfRailShowButtonRef = useRef<HTMLButtonElement>(null);
  const pdfSharedZoomRef = useRef<number | null>(null);
  const pdfActiveToolRef = useRef<{
    projectId: string;
    tool: PdfActiveTool;
  } | null>(null);
  useEffect(() => {
    pdfSharedZoomRef.current = null;
    pdfActiveToolRef.current = null;
  }, [project?.id]);
  const shellRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const safeClipboardReadGuardRef = useRef(false);
  const classroomTimeTickFenceRef = useRef<ClassroomTimeTickFence[]>([]);
  const classroomTimeAlarmAuthorityFenceRef = useRef<ClassroomTimeTickFence[]>([]);
  const classroomTimePointerActiveRef = useRef(false);
  const classroomTimeSchedulerRunningRef = useRef(false);
  const classroomTimeAsyncOperationGenerationRef = useRef(0);
  const classroomTimeStagedTransactionIdsRef = useRef(new Set<string>());
  const classroomTimeSchedulerIndexRef = useRef<ClassroomTimeSchedulerIndex>(
    createClassroomTimeSchedulerIndex(null),
  );
  const classroomTimeOverlayNeedsTicksRef = useRef(false);
  const classroomTimeClaimantIdRef = useRef(`classroom-time-${createLocalId()}`);
  const classroomTimeClipboardRestoreTimerRef = useRef<number | null>(null);
  const classroomTimeConfirmationToastTokenRef = useRef(0);
  const classroomTimeConfirmationToastRef = useRef<ClassroomTimeConfirmationToast | null>(null);
  const classroomTimeConfirmationToastCleanupRef = useRef<(() => void) | null>(null);
  const showClassroomTimeConfirmationToast = useCallback((message: string) => {
    classroomTimeConfirmationToastCleanupRef.current?.();
    const toast = {
      token: ++classroomTimeConfirmationToastTokenRef.current,
      message,
    };
    classroomTimeConfirmationToastCleanupRef.current = scheduleClassroomTimeConfirmationToast(
      toast,
      classroomTimeConfirmationToastRef,
      setClassroomTimeConfirmationToast,
    );
  }, []);
  useEffect(() => () => {
    classroomTimeConfirmationToastCleanupRef.current?.();
    classroomTimeConfirmationToastCleanupRef.current = null;
    classroomTimeConfirmationToastRef.current = null;
  }, []);
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
  const retryArchiveWorkerReadiness = useCallback(async () => {
    setLocalReadinessDismissed(false);
    setLocalReadinessBusy(true);
    try {
      const { preflightProjectArchiveWorker } = await import("./lib/project-archive-client");
      setArchiveWorkerReadiness(await preflightProjectArchiveWorker());
    } catch (error) {
      setArchiveWorkerReadiness({
        available: false,
        message: error instanceof Error && error.message
          ? error.message
          : "The project archive worker could not be checked.",
      });
    } finally {
      setLocalReadinessBusy(false);
    }
  }, []);
  const requestLocalStorageProtection = useCallback(async () => {
    setLocalReadinessDismissed(false);
    setLocalReadinessBusy(true);
    try {
      const { requestDurableStorage } = await import("./lib/storage-readiness");
      setStorageReadiness(await requestDurableStorage());
    } catch (error) {
      setStorageReadiness({
        durableStorage: "unavailable",
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
        requiredBytes: 0,
        hasRequiredCapacity: null,
        advisory: error instanceof Error && error.message
          ? error.message
          : "Durable local storage could not be requested.",
      });
    } finally {
      setLocalReadinessBusy(false);
    }
  }, []);
  const assessAdditionalStorage = useCallback(async (
    requiredBytes: number,
    signal?: AbortSignal,
  ) => {
    const { assessStorageReadiness } = await import("./lib/storage-readiness");
    const readiness = await assessStorageReadiness({ requiredBytes, signal });
    setStorageReadiness(readiness);
    if (readiness.hasRequiredCapacity === false) {
      const availableMiB = readiness.availableBytes === null
        ? "unknown"
        : `${Math.max(0, Math.floor(readiness.availableBytes / (1024 * 1024)))} MiB`;
      const requiredMiB = Math.ceil(requiredBytes / (1024 * 1024));
      throw new Error(
        `This operation needs about ${requiredMiB} MiB of additional local storage, but the browser reports ${availableMiB} available. Download a backup and free browser storage before trying again.`,
      );
    }
    return readiness;
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void import("./lib/project-archive-client")
      .then(({ preflightProjectArchiveWorker }) => preflightProjectArchiveWorker(controller.signal))
      .then((readiness) => {
        if (active) setArchiveWorkerReadiness(readiness);
      })
      .catch((error) => {
        if (!active || isAbortLikeError(error)) return;
        setArchiveWorkerReadiness({
          available: false,
          message: error instanceof Error && error.message
            ? error.message
            : "The project archive worker could not be checked.",
        });
      });
    void import("./lib/storage-readiness")
      .then(({ assessStorageReadiness }) => assessStorageReadiness())
      .then((readiness) => {
        if (active) setStorageReadiness(readiness);
      })
      .catch((error) => {
        if (!active) return;
        // Storage readiness is advisory. If its optional startup chunk cannot
        // be loaded (for example, a first offline visit with an incomplete
        // browser cache), keep the editor usable and surface the conservative
        // backup warning instead of leaving an unhandled rejection behind.
        setStorageReadiness({
          durableStorage: "unavailable",
          quotaBytes: null,
          usageBytes: null,
          availableBytes: null,
          requiredBytes: 0,
          hasRequiredCapacity: null,
          advisory: error instanceof Error && error.message
            ? error.message
            : "Durable local storage could not be checked.",
        });
      });
    void import("./lib/autosave-history")
      .then(({ listAutosaveHistorySnapshots }) => listAutosaveHistorySnapshots())
      .then((entries) => {
        if (active) {
          setRecoverySnapshots(entries);
          setRecoveryHistoryUnreadable(false);
        }
      })
      .catch(() => {
        // A damaged history store must never stop the current autosave from
        // opening. A later explicit project switch surfaces the actionable
        // integrity error before replacing the current board.
        if (active) setRecoveryHistoryUnreadable(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
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
  // React project metadata can publish before the imperative Excalidraw scene
  // replacement settles. Block editor input for that short transition so a
  // fast first mark cannot land on the outgoing scene and then be silently
  // overwritten, and wrapper tools cannot reject a gesture halfway through.
  const sceneInputBlockedRef = useRef(true);
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
    kind: "manual" | "presentation" | "clean";
    entered: boolean;
  } | null>(null);
  const pendingCreatedFrameIdRef = useRef<string | null>(null);
  const slideFramesVisibleRef = useRef(true);
  const slideFrameDrawingActiveRef = useRef(false);
  const slideQuickDrawEnabledRef = useRef(false);
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
  const nativeImageExportRequestGenerationRef = useRef(0);
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
  // A failed write is stronger than the ordinary dirty flag: a later React
  // commit or an exit-flush dedupe must not accidentally make the browser
  // believe it is safe to leave. This is deliberately a ref-only guard. It
  // does not claim that an async IndexedDB write can finish during unload;
  // it only keeps the native unload warning until a later save succeeds.
  const autosaveNeedsUnloadWarningRef = useRef(false);
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
  const renderedClassroomTimeSchedulerIndex = useMemo(
    () => createClassroomTimeSchedulerIndex(project),
    [project],
  );
  useLayoutEffect(() => {
    classroomTimeSchedulerIndexRef.current = renderedClassroomTimeSchedulerIndex;
  }, [renderedClassroomTimeSchedulerIndex]);
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
  const beginClassroomTimeAsyncOperation = useCallback((): ClassroomTimeSchedulerPublicationFence | null => {
    const operationGeneration = ++classroomTimeAsyncOperationGenerationRef.current;
    const currentProject = projectRef.current;
    const activeSceneId = hydratedSceneIdRef.current;
    if (
      !api
      || !currentProject
      || !activeSceneId
      || switchingSceneRef.current
      || currentProject.activeSceneId !== activeSceneId
    ) return null;
    const signature = classroomTimeOperationSceneSignature(
      currentProject.scenes[activeSceneId],
      api.getSceneElementsIncludingDeleted(),
      api.getFiles(),
      transientDarkPdfFileIdsRef.current,
    );
    return {
      project: currentProject,
      activeSceneId,
      hydrationGeneration: sceneHydrationGenerationRef.current,
      operationGeneration,
      ...signature,
    };
  }, [api]);
  const isCurrentClassroomTimeAsyncOperation = useCallback((
    expected: ClassroomTimeSchedulerPublicationFence | null,
    allowEquivalentProjectForDirectControl = false,
  ): expected is ClassroomTimeSchedulerPublicationFence => {
    if (!api || !expected || !sceneOperationMountedRef.current) return false;
    const activeSceneId = hydratedSceneIdRef.current;
    const currentProject = projectRef.current;
    const signature = activeSceneId
      ? classroomTimeOperationSceneSignature(
        currentProject?.scenes[activeSceneId],
        api.getSceneElementsIncludingDeleted(),
        api.getFiles(),
        transientDarkPdfFileIdsRef.current,
      )
      : { elementFingerprint: null, fileFingerprint: null };
    const currentFence: ClassroomTimeSchedulerPublicationFence = {
      project: currentProject,
      activeSceneId,
      hydrationGeneration: sceneHydrationGenerationRef.current,
      operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
      ...signature,
    };
    return (allowEquivalentProjectForDirectControl
      ? classroomTimeControlPublicationFenceMatches
      : classroomTimeSchedulerPublicationFenceMatches)(
      expected,
      currentFence,
      switchingSceneRef.current,
    );
  }, [api]);
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
    classroomTimeAsyncOperationGenerationRef.current += 1;
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
    classroomTimeAsyncOperationGenerationRef.current += 1;
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
    // Excalidraw history is scene-local. Retain this sidecar only for the
    // matching live history; recovery snapshots cover navigation/reload.
    clearedBoardSlidesRef.current = [];
    classroomTimeAsyncOperationGenerationRef.current += 1;
    // Wrapper pointer overlays belong to the currently hydrated editor scene.
    // Unmount them before replacing Excalidraw state so their visible controls
    // and any armed pointer gesture cannot leak into the incoming scene/page.
    resetTransientPointerTools();
    setSelectedClassroomTime(null);
    setClassroomTimeDialog(null);
    classroomTimePointerActiveRef.current = false;
    classroomTimeTickFenceRef.current = [];
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
    sceneInputBlockedRef.current = true;
    setIsSceneInputBlocked(true);
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
    const nextProject = projectWithPendingScene(baseProject, pending, clearedBoardSlidesRef.current);
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
      const mergedProject = projectWithPendingScene(current, pending, clearedBoardSlidesRef.current);
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
  const stageProjectMutationForAutosave = useCallback((nextProject: ClassroomProject) => {
    projectRef.current = nextProject;
    const nextSchedulerIndex = createClassroomTimeSchedulerIndex(nextProject);
    classroomTimeSchedulerIndexRef.current = nextSchedulerIndex;
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
    if (!autosaveSuspendedRef.current) setSaveStatus("saving");
    setProject(nextProject);
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
          autosaveNeedsUnloadWarningRef.current = false;
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
        autosaveNeedsUnloadWarningRef.current = true;
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

  const persistPdfCandidateBeforePublication = useCallback(async (
    candidateProject: ClassroomProject,
    candidatePdfBytes: Record<PdfDocumentId, Uint8Array>,
    options: {
      forceOverwrite?: boolean;
      isBaseCurrent?: () => boolean;
      publish: () => void;
      signal?: AbortSignal;
    },
  ) => {
    const assertBaseCurrent = () => {
      if (options.isBaseCurrent && !options.isBaseCurrent()) {
        throw new Error(
          "The board changed while the PDF pages were being prepared. Nothing was imported; try again so the new content is included.",
        );
      }
    };
    // Let an already-linearized save finish before freezing the ordinary
    // scheduler. saveAutosave's CAS then orders this candidate after that
    // exact revision instead of allowing an older queued snapshot to land
    // after the PDF import.
    try {
      await autosaveQueueRef.current;
    } catch (error) {
      if (error instanceof AutosaveConflictError && !options.forceOverwrite) throw error;
      // A prior storage failure does not make this candidate unsafe to try;
      // its own atomic transaction below is the authoritative capacity test.
    }
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("The operation was aborted.", "AbortError");
    }
    assertBaseCurrent();

    const previous = {
      coveredSnapshot: autosaveCoveredSnapshotRef.current,
      dirty: autosaveDirtyRef.current,
      exitFlushQueued: autosaveExitFlushQueuedRef.current,
      exitFlushSnapshot: autosaveExitFlushSnapshotRef.current,
      saving: autosaveSavingRef.current,
      suspended: autosaveSuspendedRef.current,
      urgent: autosaveUrgentRef.current,
    };
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    autosaveSuspendedRef.current = true;
    autosaveDirtyRef.current = false;
    autosaveUrgentRef.current = false;
    autosaveSavingRef.current = true;
    const snapshot = {
      project: candidateProject,
      pdfBytes: candidatePdfBytes,
    };
    const saveStartedAt = performance.now();
    const candidateSave = saveAutosave(candidateProject, candidatePdfBytes, {
      prepared: true,
      forceOverwrite: options.forceOverwrite,
      replacePdfBlobs: options.forceOverwrite,
      // Recheck after PDF/raster verification and Web Lock waiting, inside
      // the IndexedDB transaction in the same turn as its first write.
      precommitGuard: assertBaseCurrent,
      signal: options.signal,
    });
    // Keep page-exit and later PDF publications ordered behind this exact
    // transaction without exposing a rejected promise as an unhandled task.
    const trackedSave = candidateSave.then(() => undefined, () => undefined);
    autosaveQueueRef.current = trackedSave;

    let contentSize;
    try {
      contentSize = await candidateSave;
    } catch (error) {
      const liveBaseChanged = Boolean(
        options.isBaseCurrent && !options.isBaseCurrent(),
      );
      autosaveCoveredSnapshotRef.current = liveBaseChanged
        ? null
        : previous.coveredSnapshot;
      autosaveDirtyRef.current = previous.dirty || liveBaseChanged;
      autosaveExitFlushQueuedRef.current = previous.exitFlushQueued;
      autosaveExitFlushSnapshotRef.current = previous.exitFlushSnapshot;
      autosaveUrgentRef.current = previous.urgent || liveBaseChanged;
      if (autosaveQueueRef.current === trackedSave) {
        autosaveSavingRef.current = previous.saving;
      }
      autosaveSuspendedRef.current = previous.suspended;
      if (!previous.suspended && (previous.dirty || liveBaseChanged)) {
        autosaveTimerRef.current = window.setTimeout(
          () => flushAutosave(previous.urgent || liveBaseChanged),
          liveBaseChanged ? 0 : AUTOSAVE_BASE_INTERVAL_MS,
        );
      }
      if (isQuotaExceededLikeError(error)) {
        throw new Error(
          "The rendered PDF could not be saved because browser storage became full. Nothing was imported. Download a backup and free browser storage before trying again.",
          { cause: error },
        );
      }
      throw error;
    }

    if (autosaveQueueRef.current === trackedSave) {
      autosaveSavingRef.current = previous.saving;
    }
    autosaveSuspendedRef.current = previous.suspended;
    autosaveLastDurationMsRef.current = Math.max(
      0,
      performance.now() - saveStartedAt,
    );
    autosaveContentBytesRef.current = contentSize.totalBytes;
    autosaveSnapshotRef.current = snapshot;
    autosaveCoveredSnapshotRef.current = snapshot;
    autosaveExitFlushSnapshotRef.current = null;
    autosaveExitFlushQueuedRef.current = false;
    autosaveDirtyRef.current = false;
    autosaveUrgentRef.current = false;
    autosaveNeedsUnloadWarningRef.current = false;
    autosaveLastQueuedAtRef.current = Date.now();
    // The immediately following React publication is already durable and
    // must not enqueue an identical full-project write.
    skipNextAutosaveEffectRef.current = true;
    setSaveStatus("saved");
    // IndexedDB commit is the irreversible boundary. Cancellation before it
    // aborts saveAutosave and never reaches this callback. Once commit
    // succeeds, publish synchronously in the same microtask even if a newer
    // intent has just advanced the generation; returning without publishing
    // would leave durable storage ahead of the live editor. A newer intent
    // remains ordered after this revision and may replace it normally.
    options.publish();
    return contentSize;
  }, [flushAutosave]);

  const pausePublishedClassroomAlarmIdentities = useCallback((
    identities: readonly ClassroomAlarmIdentity[],
    now = Date.now(),
  ) => {
    if (!identities.length) return;
    const baseProject = commitCurrentLiveScenePersistence() ?? projectRef.current;
    if (!baseProject) return;
    const pausedProject = pauseClassroomAlarmIdentitiesInProject(baseProject, identities, now);
    if (pausedProject === baseProject) return;
    stageProjectMutationForAutosave(pausedProject);
    const sceneId = hydratedSceneIdRef.current;
    const scene = sceneId && pausedProject.activeSceneId === sceneId
      ? pausedProject.scenes[sceneId]
      : null;
    if (api && switchingSceneRef.current) {
      // A publication such as project-open or PDF Undo may already have
      // scheduled hydration of the running snapshot. Force one more hydration
      // from the fail-safe paused project after that in-flight paint settles.
      setProjectHydrationRevision((revision) => revision + 1);
    } else if (api && scene) {
      const display = materializeClassroomTimeSceneForDisplay(
        scene.elements as unknown as readonly ExcalidrawElement[],
        scene.files as unknown as BinaryFiles,
        pausedProject.projectCalendar,
        deviceClassroomCalendarRef.current,
        now,
        createLocalId,
        editorThemeRef.current,
      );
      if (display.addedFiles.length) api.addFiles([...display.addedFiles]);
      for (const fileId of display.orphanedFileIds) delete api.getFiles()[fileId];
      classroomTimeAlarmAuthorityFenceRef.current.push({
        sceneId: scene.id,
        elementFingerprint: classroomTimeElementFingerprint(display.elements),
        fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
      });
      if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
        classroomTimeAlarmAuthorityFenceRef.current.shift();
      }
      api.updateScene({
        elements: display.elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    window.requestAnimationFrame(() => flushAutosave(true));
  }, [api, commitCurrentLiveScenePersistence, flushAutosave, stageProjectMutationForAutosave]);
  // Alarm activation is also used by the one-shot startup loader. Keep its
  // callback stable when Excalidraw publishes a new imperative API, while
  // still routing activation failures through the newest live-editor owner.
  // Otherwise mounting the editor can restart startup autosave loading and a
  // late second result can replace an edit made immediately after launch.
  const pausePublishedClassroomAlarmIdentitiesRef = useRef(
    pausePublishedClassroomAlarmIdentities,
  );
  pausePublishedClassroomAlarmIdentitiesRef.current = pausePublishedClassroomAlarmIdentities;

  const rollbackPreparedClassroomAlarmReceipts = useCallback(async (
    receipts: readonly ClassroomAlarmTransactionReceiptV1[],
    onRefreshedCancellationReceipt?: (
      transactionReceipt: ClassroomAlarmTransactionReceiptV1,
      cancellationReceipt: ClassroomAlarmCancellationReceiptV1,
    ) => void,
  ): Promise<boolean> => {
    if (!receipts.length) return true;
    try {
      let durable = false;
      try {
        durable = await rollbackClassroomAlarmPublicationReceipts(
          receipts,
          Date.now(),
          undefined,
          onRefreshedCancellationReceipt,
        );
      } catch {
        // The exact rollback may fail before or after its storage attempt.
        // Re-cancel the same identities below so no staged generation can be
        // treated as usable authority by the caller.
      }
      if (durable) return true;
      const identities = classroomAlarmIdentitiesForTransactionReceipts(receipts);
      try {
        const cancelled = await cancelClassroomAlarmIdentitiesWithReceipt(
          identities,
          Date.now(),
        );
        if (cancelled.status !== "persisted") return false;
        if (
          receipts.length === 1
          && receipts[0].mode === "cancelled-restore"
          && cancelled.receipt
        ) {
          onRefreshedCancellationReceipt?.(receipts[0], cancelled.receipt);
        }
      } catch {
        return false;
      }
      return true;
    } finally {
      for (const receipt of receipts) {
        classroomTimeStagedTransactionIdsRef.current.delete(receipt.transactionId);
      }
    }
  }, []);

  const activatePublishedClassroomAlarmReceipts = useCallback(async (
    receipts: readonly ClassroomAlarmTransactionReceiptV1[],
  ): Promise<boolean> => {
    if (!receipts.length) return true;
    try {
      for (const receipt of receipts) {
        const activated = await activateClassroomAlarmTransaction(
          receipt,
          Date.now(),
        );
        if (activated.status !== "persisted") {
          throw new Error(`alarm storage returned ${activated.status}`);
        }
      }
      return true;
    } catch {
      const identities = classroomAlarmIdentitiesForTransactionReceipts(receipts);
      try {
        await cancelClassroomAlarmIdentitiesWithReceipt(identities, Date.now());
      } catch {
        // The matching project is paused below even when storage itself is
        // unavailable, so a partially activated generation never looks safe.
      }
      pausePublishedClassroomAlarmIdentitiesRef.current(identities);
      return false;
    } finally {
      for (const receipt of receipts) {
        classroomTimeStagedTransactionIdsRef.current.delete(receipt.transactionId);
      }
    }
  }, []);

  const trackPreparedClassroomAlarmReceipts = useCallback((
    receipts: readonly ClassroomAlarmTransactionReceiptV1[],
  ) => {
    for (const receipt of receipts) {
      classroomTimeStagedTransactionIdsRef.current.add(receipt.transactionId);
    }
  }, []);

  const restoreAbandonedOpenClassroomAlarms = useCallback(async (
    cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null,
    outgoingProject: ClassroomProject | null,
  ): Promise<boolean> => {
    if (!cancellationReceipt || !outgoingProject) return true;
    const visibleProject = projectRef.current;
    const visibleSceneId = hydratedSceneIdRef.current;
    if (!visibleProject) {
      pausePublishedClassroomAlarmIdentities(cancellationReceipt.identities);
      return false;
    }
    const sourceProjectIsVisible = visibleProject.id === outgoingProject.id;
    const sourceProject = sourceProjectIsVisible ? visibleProject : outgoingProject;
    if (
      !cancellationReceipt.cancelledJobs.length
      || !cancellationReceipt.cancelledJobs.every((job) => (
        projectClassroomTimeAlarmDescriptors(sourceProject).some((descriptor) => (
          classroomAlarmJobMatchesDescriptor(job, descriptor)
        ))
      ))
    ) {
      // The exact pre-open generation is no longer represented by the board,
      // or there was no durable job to restore. Keep the visible metadata from
      // advertising alarm authority that the registry does not have.
      pausePublishedClassroomAlarmIdentities(cancellationReceipt.identities);
      return false;
    }
    const fence: ClassroomTimeSchedulerPublicationFence = {
      project: visibleProject,
      activeSceneId: visibleSceneId,
      hydrationGeneration: sceneHydrationGenerationRef.current,
      operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
      elementFingerprint: api && visibleSceneId
        ? classroomTimeElementFingerprint(api.getSceneElementsIncludingDeleted())
        : null,
      fileFingerprint: api && visibleSceneId
        ? classroomTimeFileFingerprint(api.getFiles())
        : null,
    };
    let stagedReceipt: ClassroomAlarmTransactionReceiptV1 | null = null;
    try {
      const staged = await stageCancelledClassroomAlarmReceipt(
        cancellationReceipt,
        Date.now(),
      );
      if (staged.status !== "persisted" || !staged.receipt) {
        pausePublishedClassroomAlarmIdentities(cancellationReceipt.identities);
        return false;
      }
      stagedReceipt = staged.receipt;
      trackPreparedClassroomAlarmReceipts([stagedReceipt]);
      const currentSceneId = hydratedSceneIdRef.current;
      const currentFence: ClassroomTimeSchedulerPublicationFence = {
        project: projectRef.current,
        activeSceneId: currentSceneId,
        hydrationGeneration: sceneHydrationGenerationRef.current,
        operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
        elementFingerprint: api && currentSceneId
          ? classroomTimeElementFingerprint(api.getSceneElementsIncludingDeleted())
          : null,
        fileFingerprint: api && currentSceneId
          ? classroomTimeFileFingerprint(api.getFiles())
          : null,
      };
      if (
        !classroomTimeSchedulerPublicationFenceMatches(
          fence,
          currentFence,
          switchingSceneRef.current,
        )
        || !projectRef.current
        || !classroomAlarmTransactionReceiptMatchesProject(
          stagedReceipt,
          sourceProject,
        )
      ) {
        if (!await rollbackPreparedClassroomAlarmReceipts([stagedReceipt])) {
          pausePublishedClassroomAlarmIdentities(cancellationReceipt.identities);
          return false;
        }
        // Rolling back the restore keeps the original cancellation active.
        // A draw/navigation change invalidates publication even if the timer
        // descriptor itself looks unchanged, so fail safe in the live board.
        pausePublishedClassroomAlarmIdentities(cancellationReceipt.identities);
        return false;
      }
      if (!sourceProjectIsVisible) {
        // A later different-project open deliberately preserves background
        // alarms from the prior project. `outgoingProject` was committed and
        // its autosave queue settled before cancellation; the one-use receipt
        // binds the exact generation to that durable source snapshot. Fence
        // the currently published project as well so another open/navigation
        // cannot cross this background restoration.
      }
      // Reaffirm the exact currently published ref immediately before making
      // either its foreground alarm or the preserved background alarm live.
      projectRef.current = visibleProject;
      return activatePublishedClassroomAlarmReceipts([stagedReceipt]);
    } catch {
      if (
        stagedReceipt
        && classroomTimeStagedTransactionIdsRef.current.has(stagedReceipt.transactionId)
      ) {
        await rollbackPreparedClassroomAlarmReceipts([stagedReceipt]);
      }
      pausePublishedClassroomAlarmIdentities(cancellationReceipt.identities);
      return false;
    }
  }, [
    activatePublishedClassroomAlarmReceipts,
    api,
    pausePublishedClassroomAlarmIdentities,
    rollbackPreparedClassroomAlarmReceipts,
    trackPreparedClassroomAlarmReceipts,
  ]);

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
    let animationFrameId: number | null = null;
    let cancelled = false;
    let focusedTarget: HTMLElement | null = null;
    let focusedTargetKind: "editor" | "trigger" | null = null;
    const retryDeadline = window.performance.now() + 2_000;

    const finishExpiredFocusRequest = (focusTarget: "editor" | "trigger") => {
      // A hidden/disabled toolbar can make its trigger legitimately absent.
      // Leave keyboard users on the current editor instead of running a
      // permanent animation loop. If even that target is unavailable, consume
      // only the still-pending request so a later dialog close can start fresh.
      if (focusTarget === "trigger") {
        const host = editorHostRef.current;
        const editor = host?.querySelector<HTMLElement>(".excalidraw") || null;
        if (editor?.isConnected && host?.contains(editor)) {
          editor.focus();
        }
      }
      if (focusAfterMathToolsRef.current === focusTarget) {
        focusAfterMathToolsRef.current = null;
      }
    };

    const restoreFocus = () => {
      if (cancelled) return;
      const focusTarget = focusAfterMathToolsRef.current;
      if (!focusTarget) return;
      if (window.performance.now() >= retryDeadline) {
        finishExpiredFocusRequest(focusTarget);
        return;
      }
      const selector = focusTarget === "editor"
        ? ".excalidraw"
        : ".App-toolbar__extra-tools-trigger";
      const host = editorHostRef.current;
      const target = host?.querySelector<HTMLElement>(selector) || null;

      if (!target || !target.isConnected || !host?.contains(target)) {
        focusedTarget = null;
        focusedTargetKind = null;
        animationFrameId = window.requestAnimationFrame(restoreFocus);
        return;
      }

      if (document.activeElement !== target) target.focus();
      const currentHost = editorHostRef.current;
      const currentTarget = currentHost?.querySelector<HTMLElement>(selector) || null;
      const ownsFocus = (
        currentTarget === target
        && target.isConnected
        && currentHost?.contains(target)
        && document.activeElement === target
      );
      if (!ownsFocus) {
        focusedTarget = null;
        focusedTargetKind = null;
        animationFrameId = window.requestAnimationFrame(restoreFocus);
        return;
      }

      // Responsive Excalidraw layouts can replace the toolbar or editor root
      // during the paint following a dialog close. Confirm that the exact
      // currently mounted target still owns focus on a second frame before
      // consuming the pending restoration request.
      if (focusedTarget !== target || focusedTargetKind !== focusTarget) {
        focusedTarget = target;
        focusedTargetKind = focusTarget;
        animationFrameId = window.requestAnimationFrame(restoreFocus);
        return;
      }

      focusAfterMathToolsRef.current = null;
    };

    animationFrameId = window.requestAnimationFrame(restoreFocus);
    return () => {
      cancelled = true;
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [isGeoGonOpen, isMathToolsOpen]);

  useEffect(() => {
    // A project already published by an earlier startup pass is authoritative.
    // This is a second, identity-independent fence against effect dependency
    // drift ever launching another autosave load over a teacher's first edit.
    if (projectRef.current) return;
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
      .then(async (loaded) => {
        if (!isCurrentStartupLoad()) return;
        if (loaded) {
          const framesVisible = loaded.project.slideFramesVisible !== false;
          const loadedStartupProject = projectForBoardStartup(loaded.project);
          const preparedAlarms = await prepareClassroomAlarmPublication(
            loadedStartupProject,
            Date.now(),
            { resolvePersistedTransactions: true },
          );
          trackPreparedClassroomAlarmReceipts(preparedAlarms.receipts);
          if (!isCurrentStartupLoad()) {
            if (!await rollbackPreparedClassroomAlarmReceipts(preparedAlarms.receipts)) {
              setErrorMessage("A superseded saved-board alarm preparation could not be rolled back durably.");
            }
            return;
          }
          const startupProject = preparedAlarms.project;
          slideFramesVisibleRef.current = framesVisible;
          projectRef.current = startupProject;
          activeSceneIdRef.current = startupProject.activeSceneId;
          pdfBytesRef.current = loaded.pdfBytes;
          autosaveSnapshotRef.current = {
            project: startupProject,
            pdfBytes: loaded.pdfBytes,
          };
          // This is the exact durable baseline represented by IndexedDB. The
          // startup projection may contain unsaved timer/active-scene changes,
          // so admission checks compare candidates against the loaded payload
          // rather than mistaking those live changes for already stored data.
          autosaveContentBytesRef.current = getProjectContentSize(
            loaded.project,
            loaded.pdfBytes,
          ).totalBytes;
          autosaveExitFlushSnapshotRef.current = null;
          autosaveCoveredSnapshotRef.current = null;
          autosaveDirtyRef.current = false;
          // A cancellation fence can safely pause stale running metadata from
          // an interrupted prior edit. Persist that correction so the next
          // startup does not have to rediscover the same unsafe generation.
          skipNextAutosaveEffectRef.current = startupProject === loadedStartupProject;
          setAreSlideFramesVisible(framesVisible);
          setProject(startupProject);
          setPdfBytes(loaded.pdfBytes);
          if (!await activatePublishedClassroomAlarmReceipts(preparedAlarms.receipts)) {
            setErrorMessage("Saved classroom timers were paused because their alarm schedule could not be activated durably.");
          } else if (preparedAlarms.pausedIdentities.length) {
            setErrorMessage("Some saved classroom timers were paused because their prior alarm authority was no longer safe to resume.");
          }
        } else {
          const blankProject = createBlankProject();
          const preparedAlarms = await prepareClassroomAlarmPublication(
            blankProject,
            Date.now(),
            { resolvePersistedTransactions: true },
          );
          trackPreparedClassroomAlarmReceipts(preparedAlarms.receipts);
          if (!isCurrentStartupLoad()) {
            await rollbackPreparedClassroomAlarmReceipts(preparedAlarms.receipts);
            return;
          }
          projectRef.current = blankProject;
          activeSceneIdRef.current = blankProject.activeSceneId;
          setProject(blankProject);
          await activatePublishedClassroomAlarmReceipts(preparedAlarms.receipts);
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
  }, [
    activatePublishedClassroomAlarmReceipts,
    rollbackPreparedClassroomAlarmReceipts,
    trackPreparedClassroomAlarmReceipts,
  ]);

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
    slideQuickDrawEnabledRef.current = project?.slideQuickDrawEnabled === true;
  }, [project?.slideQuickDrawEnabled]);

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
        if (intent.kind === "clean") {
          isCleanFullscreenRef.current = false;
          setIsCleanFullscreen(false);
        }
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
      if (isEditableKeyboardTarget(event.target)) return;
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
      // IndexedDB work started here is best effort only: browsers may tear
      // down the document before its promise settles. The sticky ref below
      // keeps the native warning honest after a failed write instead of
      // implying that this async callback can guarantee recovery on unload.
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
        && !autosaveNeedsUnloadWarningRef.current
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

  const runSlideRotationAction = useCallback((action: PendingSlideRotationAction): boolean => {
    if (
      !api
      || switchingSceneRef.current
      || activeSceneIdRef.current !== action.sceneId
      || hydratedSceneIdRef.current !== action.sceneId
    ) return false;

    const currentProject = projectRef.current;
    const currentSlide = currentProject?.slideOrder.find((slide) => slide.id === action.slideId);
    if (
      !currentSlide
      || currentSlide.sceneId !== action.sceneId
      || currentSlide.frameId !== action.frameId
    ) {
      api.setToast({ message: "That slide is no longer available." });
      return true;
    }

    try {
      const result = rotateSlideContent(api.getSceneElements(), action.frameId, action.degrees);
      if (result.status === "no-content") {
        api.setToast({ message: "This slide has no content to rotate." });
        return true;
      }
      if (result.status === "no-op") {
        api.setToast({ message: "Choose an angle that changes the slide." });
        return true;
      }
      api.updateScene({
        elements: result.elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      const direction = action.degrees < 0 ? "left" : "right";
      const amount = Number(Math.abs(action.degrees).toFixed(2));
      api.setToast({
        message: `Rotated ${action.title} ${direction} ${amount}°. Undo is available.`,
      });
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return true;
    }
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
    const canonicalFiles = { ...scene.files } as unknown as BinaryFiles;
    const canonicalElements = scene.elements as unknown as readonly ExcalidrawElement[];
    const displayScene = materializeClassroomTimeSceneForDisplay(
      canonicalElements,
      canonicalFiles,
      projectRef.current?.projectCalendar,
      deviceClassroomCalendarRef.current,
      Date.now(),
      createLocalId,
      editorThemeRef.current,
    );
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
    const currentProject = projectRef.current;
    const outgoingSceneId = hydratedSceneIdRef.current;
    const outgoingSceneIsPdf = !!(
      outgoingSceneId
      && currentProject?.scenes[outgoingSceneId]?.pdfPage
    );
    if (
      workspaceModeRef.current === "pdf"
      && scene.pdfPage
      && !presentationRef.current
    ) {
      const rememberedPdfTool = pdfActiveToolRef.current;
      const retainedTool = (
        rememberedPdfTool && rememberedPdfTool.projectId === currentProject?.id
          ? rememberedPdfTool.tool
          : null
      )
        || (outgoingSceneIsPdf ? retainedPdfActiveTool(liveAppState.activeTool) : null)
        || retainedPdfActiveTool(hydratedAppState.activeTool);
      if (retainedTool) {
        hydratedAppState.activeTool = retainedTool;
        if (currentProject) {
          pdfActiveToolRef.current = {
            projectId: currentProject.id,
            tool: retainedTool,
          };
        }
      }
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
    classroomTimeTickFenceRef.current.push({
      sceneId,
      elementFingerprint: classroomTimeElementFingerprint(displayScene.elements),
      fileFingerprint: classroomTimeFileFingerprint(displayScene.files),
    });
    if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
    api.updateScene({
      elements: displayScene.elements,
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
    api.addFiles(Object.values(displayScene.files));
    api.updateFrameRendering({ enabled: slideFramesVisibleRef.current, clip: false });
    api.history.clear();
    const hydrationBaseline = normalizedHydrationChange(
      scene,
      canonicalElements,
      api.getAppState(),
      canonicalFiles,
      transientDarkPdfFileIdsRef.current,
    );
    sceneHydrationBaselineRef.current = {
      generation: hydrationGeneration,
      snapshot: snapshotSceneHydrationChange(hydrationBaseline),
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
        sceneInputBlockedRef.current = false;
        setIsSceneInputBlocked(false);
        sceneHydrationBaselineRef.current = null;
        if (workspaceModeRef.current === "pdf" && scene.pdfPage) {
          const background = api.getSceneElements().find(
            (element) => element.id === scene.pdfPage?.backgroundElementId,
          );
          if (background) {
            const rememberedZoom = pdfSharedZoomRef.current;
            if (rememberedZoom === null) {
              api.scrollToContent(background, { animate: false });
              pdfSharedZoomRef.current = normalizeSharedPdfZoom(api.getAppState().zoom.value);
            } else {
              const appState = api.getAppState();
              const viewport = centeredPdfViewport(
                background,
                appState.width,
                appState.height,
                rememberedZoom,
              );
              api.updateScene({
                appState: {
                  scrollX: viewport.scrollX,
                  scrollY: viewport.scrollY,
                  zoom: { value: viewport.zoom as AppState["zoom"]["value"] },
                },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        }
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
        const pendingRotation = pendingSlideRotationActionRef.current;
        if (
          pendingRotation
          && pendingRotation.sceneId === sceneId
          && featurePreferencesRef.current.slides
          && runSlideRotationAction(pendingRotation)
        ) pendingSlideRotationActionRef.current = null;
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
    runSlideRotationAction,
  ]);

  useLayoutEffect(() => {
    if (!api || !project) return;
    const scene = project.scenes[project.activeSceneId];
    if (scene) loadSceneIntoEditor(scene);
  }, [api, project?.id, project?.activeSceneId, projectHydrationRevision, loadSceneIntoEditor]);

  useEffect(() => {
    if (!api || !project || switchingSceneRef.current) return;
    const sceneId = hydratedSceneIdRef.current;
    if (!sceneId || classroomTimeSchedulerIndexRef.current.widgetCount === 0) return;
    const scene = project.scenes[sceneId];
    if (!scene) return;
    const liveElements = api.getSceneElementsIncludingDeleted();
    const liveFiles = api.getFiles();
    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      liveElements,
      persistentFilesForScene(scene, liveFiles, transientDarkPdfFileIdsRef.current),
      project.projectCalendar,
      Date.now(),
      createLocalId,
    );
    const display = materializeClassroomTimeSceneForDisplay(
      canonical.elements,
      canonical.files,
      project.projectCalendar,
      deviceClassroomCalendarRef.current,
      Date.now(),
      createLocalId,
      editorThemeRef.current,
    );
    const filesToAdd = Object.values(display.files).filter((file) => (
      liveFiles[file.id]?.dataURL !== file.dataURL
    ));
    if (filesToAdd.length) api.addFiles(filesToAdd);
    for (const fileId of display.orphanedFileIds) delete liveFiles[fileId];
    if (classroomTimeElementFingerprint(display.elements)
      === classroomTimeElementFingerprint(liveElements)) return;
    classroomTimeTickFenceRef.current.push({
      sceneId,
      elementFingerprint: classroomTimeElementFingerprint(display.elements),
      fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
    });
    if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
    api.updateScene({
      elements: display.elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api, deviceClassroomCalendar, project?.id, project?.projectCalendar]);

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
    if (nativeZenModeRef.current !== appState.zenModeEnabled) {
      nativeZenModeRef.current = appState.zenModeEnabled;
      setIsNativeZenMode(appState.zenModeEnabled);
    }
    if (presentationRef.current?.tool === "eraser" && api) {
      const activeSceneId = activeSceneIdRef.current;
      const protectedFrameIds = new Set(
        projectRef.current?.slideOrder.flatMap((slide) => (
          slide.sceneId === activeSceneId ? [slide.frameId] : []
        )) ?? [],
      );
      const protectedElements = protectPresentationSlideFrameElements(
        elements,
        protectedFrameIds,
        pendingScenePersistenceRef.current?.sceneId === activeSceneId
          ? pendingScenePersistenceRef.current.elements as readonly ExcalidrawElement[]
          : projectRef.current?.scenes[activeSceneId || ""]?.elements as readonly ExcalidrawElement[] | undefined,
      );
      if (protectedElements !== elements) {
        api.updateScene({
          elements: protectedElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        api.setToast({ message: "The slide boundary is protected. That eraser gesture inside the slide was cancelled." });
        return;
      }
    }
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
    const nextClassroomTimeSelection = selectedClassroomTimeWidget(elements, appState.selectedElementIds);
    setSelectedClassroomTime((current) => {
      if (!current && !nextClassroomTimeSelection) return current;
      if (
        current
        && nextClassroomTimeSelection
        && current.anchorId === nextClassroomTimeSelection.anchorId
        && current.ownerId === nextClassroomTimeSelection.ownerId
        && serializedValuesEqual(current.elementIds, nextClassroomTimeSelection.elementIds)
        && serializedValuesEqual(current.metadata, nextClassroomTimeSelection.metadata)
      ) return current;
      return nextClassroomTimeSelection;
    });
    setPresentationClassroomTimeSelection((remembered) => (
      updateRememberedPresentationClassroomTimeSelection(
        remembered,
        nextClassroomTimeSelection,
        {
          projectId: projectRef.current?.id || null,
          sceneId: hydratedSceneIdRef.current,
        },
      )
    ));
    setClassroomTimeActiveTarget((current) => classroomTimeActiveTargetAfterSelection(
      current,
      nextClassroomTimeSelection,
      presentationRef.current !== null,
    ));
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
    const fencedSceneId = activeSceneIdRef.current;
    const elementFingerprint = classroomTimeElementFingerprint(elements);
    const fileFingerprint = classroomTimeFileFingerprint(files);
    const tickFenceIndex = classroomTimeTickFenceRef.current.findIndex((fence) => (
      classroomTimeTickFenceMatches(fence, fencedSceneId, elements, files)
    ));
    if (tickFenceIndex >= 0) {
      classroomTimeTickFenceRef.current.splice(tickFenceIndex, 1);
      return;
    }
    if (fencedSceneId && classroomTimeTickFenceRef.current.some((fence) => fence.sceneId === fencedSceneId)) {
      classroomTimeTickFenceRef.current = classroomTimeTickFenceRef.current.filter(
        (fence) => fence.sceneId !== fencedSceneId,
      );
    }
    const alarmAuthorityFenceIndex = classroomTimeAlarmAuthorityFenceRef.current.findIndex((fence) => (
      classroomTimeTickFenceMatches(fence, fencedSceneId, elements, files)
    ));
    const alarmAuthorityPrepared = alarmAuthorityFenceIndex >= 0;
    if (alarmAuthorityPrepared) {
      classroomTimeAlarmAuthorityFenceRef.current.splice(alarmAuthorityFenceIndex, 1);
    } else if (fencedSceneId && classroomTimeAlarmAuthorityFenceRef.current.some(
      (fence) => fence.sceneId === fencedSceneId,
    )) {
      classroomTimeAlarmAuthorityFenceRef.current = classroomTimeAlarmAuthorityFenceRef.current.filter(
        (fence) => fence.sceneId !== fencedSceneId,
      );
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
        && scene.id === baseline.snapshot.sceneId
      ) {
        const normalized = normalizedHydrationChange(
          scene,
          elements,
          appState,
          files,
          transientDarkPdfFileIdsRef.current,
        );
        if (!hydrationChangeMatchesSnapshot(normalized, baseline.snapshot)) {
          // Keep only the newest callback. Synthetic hydration echoes match
          // the baseline and are ignored; a real edit is replayed after the
          // second hydration paint through queueScenePersistence().
          bufferedHydrationChangeRef.current = normalized;
        }
      }
      return;
    }
    if (
      workspaceModeRef.current === "pdf"
      && currentSceneRef.current?.pdfPage
      && currentSceneRef.current.id === activeSceneIdRef.current
    ) {
      pdfSharedZoomRef.current = normalizeSharedPdfZoom(appState.zoom.value);
      if (!presentationRef.current) {
        const retainedTool = retainedPdfActiveTool(appState.activeTool);
        const currentProject = projectRef.current;
        pdfActiveToolRef.current = retainedTool && currentProject
          ? { projectId: currentProject.id, tool: retainedTool }
          : null;
        if (retainedTool && retainedTool.locked !== appState.activeTool.locked) {
          api?.updateScene({
            appState: { activeTool: retainedTool },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          return;
        }
      }
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
    const ungroupedOwnerId = elements.reduce<string | null>((ownerId, element) => {
      if (ownerId || element.isDeleted) return ownerId;
      const classroomOwnerId = classroomTimeWidgetOwnerId(element);
      return classroomOwnerId && !element.groupIds.includes(classroomOwnerId)
        ? classroomOwnerId
        : null;
    }, null);
    const currentProject = projectRef.current;
    const persistedAlarmScene = currentProject?.scenes[sceneId];
    if (api && currentProject && persistedAlarmScene && !alarmAuthorityPrepared) {
      const now = Date.now();
      const alarmElements = ungroupedOwnerId
        ? ungroupClassroomTimeWidget(
            elements,
            ungroupedOwnerId,
            now,
            classroomTimeRenderContext(
              elements,
              currentProject.projectCalendar,
              EMPTY_DEVICE_CLASSROOM_CALENDAR,
              now,
              editorThemeRef.current,
            ),
          )
        : elements;
      const previousElements = persistedAlarmScene.elements as unknown as readonly ExcalidrawElement[];
      const previousDescriptors = activeClassroomTimeAlarmDescriptors(
        currentProject.id,
        previousElements,
      );
      const nextDescriptors = activeClassroomTimeAlarmDescriptors(
        currentProject.id,
        alarmElements,
      );
      const nextById = new Map(nextDescriptors.map((descriptor) => [descriptor.id, descriptor]));
      const cancellationByKey = new Map<string, ClassroomAlarmIdentity>();
      for (const descriptor of previousDescriptors) {
        const next = nextById.get(descriptor.id);
        if (next && classroomAlarmJobMatchesDescriptor(
          classroomAlarmJobFromDescriptor(descriptor),
          next,
        )) continue;
        const identity = {
          sourceProjectId: currentProject.id,
          ownerId: descriptor.ownerId,
          target: descriptor.target,
        } as const;
        cancellationByKey.set(`${identity.ownerId}:${identity.target}`, identity);
      }
      const previousOwners = new Set(previousElements.flatMap((element) => {
        if (element.isDeleted) return [];
        const metadata = classroomTimeWidgetMetadata(element);
        return metadata ? [metadata.ownerId] : [];
      }));
      const nextOwners = new Set(alarmElements.flatMap((element) => {
        if (element.isDeleted) return [];
        const metadata = classroomTimeWidgetMetadata(element);
        return metadata ? [metadata.ownerId] : [];
      }));
      for (const ownerId of previousOwners) {
        if (nextOwners.has(ownerId) && ownerId !== ungroupedOwnerId) continue;
        for (const target of ["timer", "pomodoro"] as const) {
          cancellationByKey.set(`${ownerId}:${target}`, {
            sourceProjectId: currentProject.id,
            ownerId,
            target,
          });
        }
      }
      const cancellationIdentities = [...cancellationByKey.values()];
      if (cancellationIdentities.length) {
        const cancellationFence: ClassroomTimeSchedulerPublicationFence = {
          project: currentProject,
          activeSceneId: sceneId,
          hydrationGeneration: sceneHydrationGenerationRef.current,
          operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
          elementFingerprint,
          fileFingerprint,
        };
        void (async () => {
          try {
            const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
              cancellationIdentities,
              now,
            );
            if (cancellation.status !== "persisted") {
              throw new Error("The canvas change could not be saved because its alarms could not be cancelled durably.");
            }
            const currentSceneId = hydratedSceneIdRef.current;
            const publicationIsCurrent = classroomTimeSchedulerPublicationFenceMatches(
              cancellationFence,
              {
                project: projectRef.current,
                activeSceneId: currentSceneId,
                hydrationGeneration: sceneHydrationGenerationRef.current,
                operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
                elementFingerprint: currentSceneId
                  ? classroomTimeElementFingerprint(api.getSceneElementsIncludingDeleted())
                  : null,
                fileFingerprint: currentSceneId
                  ? classroomTimeFileFingerprint(api.getFiles())
                  : null,
              },
              switchingSceneRef.current,
            );
            if (!publicationIsCurrent) {
              const liveSceneId = hydratedSceneIdRef.current;
              if (
                projectRef.current?.id === currentProject.id
                && liveSceneId
                && liveSceneId === projectRef.current.activeSceneId
                && !switchingSceneRef.current
              ) {
                const liveElements = api.getSceneElementsIncludingDeleted();
                const safeLiveElements = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
                  liveElements,
                  currentProject.id,
                  readClassroomAlarmRegistry(),
                  Date.now(),
                  classroomTimeStagedTransactionIdsRef.current,
                );
                if (safeLiveElements !== liveElements) {
                  classroomTimeAlarmAuthorityFenceRef.current.push({
                    sceneId: liveSceneId,
                    elementFingerprint: classroomTimeElementFingerprint(safeLiveElements),
                    fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
                  });
                  if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
                    classroomTimeAlarmAuthorityFenceRef.current.shift();
                  }
                  api.updateScene({
                    elements: safeLiveElements,
                    captureUpdate: CaptureUpdateAction.NEVER,
                  });
                }
              }
              return;
            }
            const safeElements = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
              alarmElements,
              currentProject.id,
              cancellation.registry,
              Date.now(),
              classroomTimeStagedTransactionIdsRef.current,
            );
            classroomTimeAlarmAuthorityFenceRef.current.push({
              sceneId,
              elementFingerprint: classroomTimeElementFingerprint(safeElements),
              fileFingerprint,
            });
            if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
              classroomTimeAlarmAuthorityFenceRef.current.shift();
            }
            api.updateScene({
              elements: safeElements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : String(error));
          }
        })();
        return;
      }
      const safeElements = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
        alarmElements,
        currentProject.id,
        readClassroomAlarmRegistry(),
        now,
        classroomTimeStagedTransactionIdsRef.current,
      );
      if (safeElements !== elements) {
        api.updateScene({
          elements: safeElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }
    }
    const currentProjectId = projectRef.current?.id;
    if (currentProjectId) {
      const nextSchedulerIndex = updateClassroomTimeSchedulerSceneIndex(
        classroomTimeSchedulerIndexRef.current,
        currentProjectId,
        sceneId,
        elements,
      );
      classroomTimeSchedulerIndexRef.current = nextSchedulerIndex;
    }
    const persistedScene = currentSceneRef.current?.id === sceneId
      ? currentSceneRef.current
      : null;
    const persistentBackgroundElements = persistedScene
      ? canonicalizePdfBackgroundForPersistence(
        persistedScene,
        elements as unknown as readonly Record<string, unknown>[],
      ) as unknown as readonly ExcalidrawElement[]
      : elements;
    const wrapperSafePersistentElements = detachElementsFromSlideFrames(persistentBackgroundElements);
    const wrapperSafePersistentFiles = persistedScene
      ? persistentFilesForScene(
          persistedScene,
          files,
          transientDarkPdfFileIdsRef.current,
        )
      : files;
    const persistentScene = canonicalizeClassroomTimeWidgetsForPersistence(
      wrapperSafePersistentElements,
      wrapperSafePersistentFiles,
      projectRef.current?.projectCalendar,
      Date.now(),
      createLocalId,
    );
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
      elements: persistentScene.elements,
      appState,
      files: persistentScene.files,
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

  const focusSidebarSearchInput = useCallback((
    selector: string,
    preserveFocusedControlWithin?: string,
  ) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const input = editorHostRef.current?.querySelector<HTMLInputElement>(selector);
      const focusedElement = document.activeElement;
      if (
        input
        && focusedElement instanceof HTMLElement
        && focusedElement !== input
        && preserveFocusedControlWithin
        && focusedElement.closest(preserveFocusedControlWithin)
      ) {
        return;
      }
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
    // The sidebar can take two render frames to mount. Respect a user who
    // deliberately reaches another Project Find control before that delayed
    // autofocus runs instead of pulling focus back to the query.
    focusSidebarSearchInput(".project-find-query", ".project-find-panel");
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
    if (!shortcutHelpBridge) return;
    shortcutHelpBridge.open = openShortcutHelp;
    return () => {
      if (shortcutHelpBridge.open === openShortcutHelp) {
        shortcutHelpBridge.open = null;
      }
    };
  }, [openShortcutHelp]);

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
    setClassroomTimeDialog(null);
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
    const pendingTransfer = pendingClassroomTimeLibraryTransferRef.current;
    const transfer = pendingTransfer && pendingTransfer.expiresAt >= Date.now()
      ? applyClassroomTimeLibraryTransferIntent(safeLibraryItems, pendingTransfer)
      : { items: safeLibraryItems, matchedItemId: null };
    if (!pendingTransfer || pendingTransfer.expiresAt < Date.now() || transfer.matchedItemId) {
      pendingClassroomTimeLibraryTransferRef.current = null;
    }
    const preparedLibraryItems = transfer.items;
    libraryItemIdsRef.current = new Set(preparedLibraryItems.map((item) => item.id));
    if (preparedLibraryItems !== libraryItems && api) {
      if (safeLibraryItems !== libraryItems) {
        api.setToast({ message: "Unsupported or unsafe content was removed from the library." });
      }
      const preparedById = new Map(preparedLibraryItems.map((item) => [item.id, item]));
      void api.updateLibrary({
        libraryItems: (current) => {
          const safe = sanitizeLibraryItems(current);
          return safe.map((item) => preparedById.get(item.id) ?? item) as LibraryItems;
        },
        merge: false,
      }).catch((error) => {
        setErrorMessage(`Personal library could not be cleaned: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const persistence = saveLibraryItems(preparedLibraryItems);
    libraryPersistencePromiseRef.current = persistence;
    void persistence.catch((error) => {
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
    const outgoingProject = commitLiveScenePersistence(
      hydratedSceneIdRef.current || activeSceneIdRef.current || projectRef.current?.activeSceneId || "",
    );
    flushAutosave(true);
    await autosaveQueueRef.current.catch(() => undefined);
    if (!isCurrentOperation()) return false;
    let startupProject = projectForBoardStartup(loaded.project);
    const replacedAlarmIdentities = replacedClassroomTimeAlarmIdentities(
      outgoingProject ?? null,
      startupProject,
    );
    let outgoingCancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null = null;
    const restoreOutgoingAlarmsAfterAbandon = async () => {
      const receipt = outgoingCancellationReceipt;
      outgoingCancellationReceipt = null;
      return restoreAbandonedOpenClassroomAlarms(receipt, outgoingProject ?? null);
    };
    if (replacedAlarmIdentities.length) {
      const cancelled = await cancelClassroomAlarmIdentitiesWithReceipt(
        replacedAlarmIdentities,
        Date.now(),
      );
      if (cancelled.status !== "persisted" || !cancelled.receipt) {
        if (isCurrentOperation()) {
          setErrorMessage("The project was not opened because its classroom alarms could not be reconciled durably.");
        }
        return false;
      }
      outgoingCancellationReceipt = cancelled.receipt;
      if (!isCurrentOperation()) {
        if (!await restoreOutgoingAlarmsAfterAbandon()) {
          setErrorMessage("The superseded project open was stopped, but its prior classroom timers had to be paused because their exact alarm schedule could not be restored.");
        }
        return false;
      }
    }
    let preparedAlarms: PreparedClassroomAlarmPublication;
    try {
      preparedAlarms = await prepareClassroomAlarmPublication(
        startupProject,
        Date.now(),
        { resolvePersistedTransactions: true },
      );
    } catch (error) {
      if (!await restoreOutgoingAlarmsAfterAbandon()) {
        setErrorMessage("The project was not opened, and its prior classroom timers had to be paused because their exact alarm schedule could not be restored.");
      }
      throw error;
    }
    trackPreparedClassroomAlarmReceipts(preparedAlarms.receipts);
    startupProject = preparedAlarms.project;
    if (!isCurrentOperation()) {
      if (!await rollbackPreparedClassroomAlarmReceipts(preparedAlarms.receipts)) {
        setErrorMessage("A superseded project-open alarm preparation could not be rolled back durably.");
      }
      if (!await restoreOutgoingAlarmsAfterAbandon()) {
        setErrorMessage("The superseded project open was stopped, but its prior classroom timers had to be paused because their exact alarm schedule could not be restored.");
      }
      return false;
    }
    pendingFrameIdRef.current = null;
    pendingProjectSearchTargetRef.current = null;
    pendingSlideFrameActionRef.current = null;
    pendingSlideRotationActionRef.current = null;
    setSlideRotationTargetId(null);
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
    autosaveSuspendedRef.current = true;
    autosaveSuspensionGenerationRef.current = operation?.generation ?? null;
    autosaveSavingRef.current = false;
    autosaveCoveredSnapshotRef.current = null;
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
    if (!isCurrentOperation()) {
      if (!await rollbackPreparedClassroomAlarmReceipts(preparedAlarms.receipts)) {
        setErrorMessage("A superseded project-open alarm preparation could not be rolled back durably.");
      }
      if (!await restoreOutgoingAlarmsAfterAbandon()) {
        setErrorMessage("The superseded project open was stopped, but its prior classroom timers had to be paused because their exact alarm schedule could not be restored.");
      }
      return false;
    }
    if (!replacementSaved) {
      autosaveCoveredSnapshotRef.current = null;
      autosaveNeedsUnloadWarningRef.current = true;
    } else {
      autosaveNeedsUnloadWarningRef.current = false;
    }
    pendingScenePersistenceRef.current = null;
    if (scenePersistenceTimerRef.current !== null) {
      window.clearTimeout(scenePersistenceTimerRef.current);
      scenePersistenceTimerRef.current = null;
    }
    // Do not enter the hydration-suppression window until this operation is
    // still current and ready to commit. A superseded archive must not leave
    // the previous editor stuck with switchingSceneRef=true.
    stopPresentationRef.current?.();
    beginSceneHydration();
    pdfBytesRef.current = loaded.pdfBytes;
    projectRef.current = startupProject;
    // From this point the incoming project is the synchronously published
    // source of truth. The outgoing cancellation belongs to the successful
    // replacement and must not be restored by a later async cleanup path.
    outgoingCancellationReceipt = null;
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
    setSlideRotationTargetId(null);
    setWorkspaceMode("board");
    pendingCreatedFrameIdRef.current = null;
    pendingSlideFrameActionRef.current = null;
    pendingSlideRotationActionRef.current = null;
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
    if (!await activatePublishedClassroomAlarmReceipts(preparedAlarms.receipts)) {
      setErrorMessage("The opened project was loaded, but its classroom timers were paused because alarm activation failed.");
    } else if (preparedAlarms.pausedIdentities.length) {
      setErrorMessage("The project opened with some classroom timers paused because their prior alarm authority was no longer safe to resume.");
    }
  return true;
  }, [
    activatePublishedClassroomAlarmReceipts,
    beginSceneHydration,
    commitLiveScenePersistence,
    commitPendingScenePersistence,
    finalizePendingPdfUndo,
    flushAutosave,
    isCurrentFileOpenOperation,
    pausePublishedClassroomAlarmIdentities,
    restoreAbandonedOpenClassroomAlarms,
    rollbackPreparedClassroomAlarmReceipts,
    trackPreparedClassroomAlarmReceipts,
  ]);

  const openFileAfterProtection = useCallback(async (
    file: File,
    compatibilityAttempt?: PdfCompatibilityAttempt,
  ) => {
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
        const preflightCurrentProject = commitLiveScenePersistence(
          hydratedSceneIdRef.current
            || activeSceneIdRef.current
            || projectRef.current?.activeSceneId
            || "",
        ) || createBlankProject();
        const preflightProject = projectForPdfReplacement(preflightCurrentProject);
        assertProjectCanAcceptPdfPages(preflightProject, 1);
        const maxPages = remainingProjectPdfPageCapacity(preflightProject);
        const rasterBudget = getBrowserPdfRasterBudget();
        const preflightRasterUsage = await inspectLocalProjectRasterUsage(preflightProject, {
          rasterBudget,
          signal: operation.signal,
        });
        if (!isCurrentOperation()) return;
        const remainingRaster = remainingLocalProjectRasterCapacity(
          preflightRasterUsage,
          rasterBudget,
        );
        if (remainingRaster.pixels < 1 || remainingRaster.encodedBytes < 1) {
          throw new Error("This project has no remaining image capacity for another PDF page.");
        }
        const preflightSize = assertProjectCanAcceptAdditionalBytes(
          preflightProject,
          {},
          file.size,
        );
        const maxEncodedBytesPerDocument = Math.min(
          remainingRaster.encodedBytes,
          Math.max(
            0,
            Math.floor((MAX_PROJECT_BYTES - preflightSize.totalBytes - file.size) * 3 / 4),
          ),
        );
        // Only hard-block on bytes that must exist in IndexedDB. Raster output
        // varies sharply by PDF, so treating its maximum envelope as required
        // would reject safe classroom PDFs long before the actual project
        // budget is reached.
        await assessAdditionalStorage(file.size, operation.signal);
        if (!isCurrentOperation()) return;
        const importOptions = {
          maxEncodedBytesPerDocument,
          maxPages,
          maxRasterPixelsForImport: remainingRaster.pixels,
          onProgress: (progress: Readonly<PdfOperationProgress>) => {
            if (isCurrentOperation()) setBusyMessage(pdfOperationProgressMessage(progress));
          },
          rasterBudget,
          signal: operation.signal,
        };
        const imported = await (compatibilityAttempt
          ? (await import("./lib/pdf/import-compatibility")).importPdfCompatibilityCopy(
            compatibilityAttempt.originalFile,
            file,
            {
              ...importOptions,
              confirmation: {
                accepted: true,
                flatteningAcknowledged: true,
              },
              originalFailure: compatibilityAttempt.originalFailure,
              rejectedOriginalInspection: compatibilityAttempt.rejectedOriginalInspection,
            },
          ).then((result) => result.imported)
          : (await import("./lib/pdf/import-pdf")).importPdf(file, importOptions));
        if (!isCurrentOperation()) return;
        // Capture any last live annotation before the imported PDF becomes
        // the active scene. The normal debounce may not have reached the
        // pending ref yet when a large PDF finishes parsing.
        const currentBase = commitLiveScenePersistence(
          hydratedSceneIdRef.current
            || activeSceneIdRef.current
            || projectRef.current?.activeSceneId
            || "",
        ) || createBlankProject();
        const replacementBase = projectForPdfReplacement(currentBase);
        const baseManifestHash = autosaveManifestHash(currentBase);
        const basePdfBytes = pdfBytesRef.current;
        if (!baseManifestHash) throw new Error("The current board could not be fingerprinted safely.");
        assertProjectCanAcceptPdfPages(replacementBase, imported.scenes.length);
        const baseRasterUsage = currentBase === preflightCurrentProject
          ? preflightRasterUsage
          : await inspectLocalProjectRasterUsage(replacementBase, {
            rasterBudget,
            signal: operation.signal,
          });
        if (!isCurrentOperation()) return;
        addLocalProjectRasterUsage(baseRasterUsage, imported.rasterUsage, rasterBudget);
        const nextPdfBytes = {
          [imported.source.id]: imported.bytes,
        };
        const nextProject = replaceProjectPdf(
          currentBase,
          imported.scenes,
          imported.source,
          nowIso(),
        );
        assertProjectFitsContentBudget(nextProject, nextPdfBytes);
        const storageAdmission = getPdfStorageAdmissionRequirement(
          currentBase,
          basePdfBytes,
          nextProject,
          nextPdfBytes,
          { persistedContentBytes: autosaveContentBytesRef.current },
        );
        await assessAdditionalStorage(storageAdmission.requiredBytes, operation.signal);
        if (!isCurrentOperation()) return;
        const removedAlarmIdentities = removedClassroomTimeAlarmIdentities(
          currentBase,
          nextProject,
        );
        let cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null = null;
        if (removedAlarmIdentities.length) {
          const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
            removedAlarmIdentities,
            Date.now(),
          );
          if (cancellation.status !== "persisted" || !cancellation.receipt) {
            throw new Error("The old PDF could not be replaced because its classroom alarms could not be cancelled durably.");
          }
          cancellationReceipt = cancellation.receipt;
          if (!isCurrentOperation()) {
            await restoreAbandonedOpenClassroomAlarms(cancellationReceipt, currentBase);
            return;
          }
        }
        // Rendering and validation remain cancellable. The atomic IndexedDB
        // transaction below is the explicit commit boundary: once it begins,
        // the UI no longer offers a cancellation it could not honestly
        // guarantee after transaction completion.
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(`Saving ${file.name} locally…`);
        let published = false;
        try {
          await persistPdfCandidateBeforePublication(nextProject, nextPdfBytes, {
            forceOverwrite: replaceProtectedAutosave,
            isBaseCurrent: () => (
              pdfBytesRef.current === basePdfBytes
              && autosaveManifestHash(projectRef.current ?? undefined) === baseManifestHash
            ),
            publish: () => {
              published = true;
              cancellationReceipt = null;
              finalizePendingPdfUndo();
              setErrorMessage(null);
              stopPresentationRef.current?.();
              beginSceneHydration();
              pendingFrameIdRef.current = null;
              pendingProjectSearchTargetRef.current = null;
              pendingCreatedFrameIdRef.current = null;
              pendingSlideFrameActionRef.current = null;
              pendingSlideRotationActionRef.current = null;
              setSlideRotationTargetId(null);
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
            },
            signal: operation.signal,
          });
        } catch (error) {
          if (!published && cancellationReceipt) {
            const restored = await restoreAbandonedOpenClassroomAlarms(
              cancellationReceipt,
              currentBase,
            );
            if (!restored) {
              throw new Error(
                "The PDF was not replaced, and timers on the prior PDF were paused because their exact alarm schedule could not be restored.",
                { cause: error },
              );
            }
          }
          throw error;
        }
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
        const { getPdfImportRecovery } = await import("./lib/pdf/import-compatibility");
        if (!isCurrentOperation()) return;
        if (compatibilityAttempt) {
          // Keep the original one-shot recovery decision available when a
          // teacher picks the wrong conversion (wrong page count, identical
          // bytes, or another unsafe PDF). This offers another file choice,
          // never a conversion-of-a-conversion safety bypass.
          const originalRecovery = getPdfImportRecovery(compatibilityAttempt.originalFailure);
          setErrorMessage(
            `That converted copy could not be used: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (originalRecovery?.kind === "choose-converted-copy") {
            setPendingPdfCompatibilityImport({
              context: "direct",
              failure: compatibilityAttempt.originalFailure,
              file: compatibilityAttempt.originalFile,
              processing: false,
              recovery: originalRecovery,
              rejectedOriginalInspection: compatibilityAttempt.rejectedOriginalInspection,
            });
          }
          return;
        }
        const recovery = getPdfImportRecovery(error);
        if (recovery) {
          let rejectedOriginalInspection: PendingPdfCompatibilityImport["rejectedOriginalInspection"];
          if (recovery.kind === "choose-converted-copy") {
            try {
              const { inspectPdfFile } = await import("./lib/pdf/import-pdf");
              const inspection = await inspectPdfFile(file, { signal: operation.signal });
              rejectedOriginalInspection = {
                pageCount: inspection.pageCount,
                sha256: inspection.sha256,
              };
            } catch (inspectionError) {
              if (isCurrentOperation() && !isAbortLikeError(inspectionError)) {
                setErrorMessage(inspectionError instanceof Error
                  ? inspectionError.message
                  : String(inspectionError));
              }
              return;
            }
          }
          if (isCurrentOperation()) {
            setErrorMessage(null);
            setPendingPdfCompatibilityImport({
              context: "direct",
              failure: error,
              file,
              processing: false,
              recovery,
              ...(rejectedOriginalInspection ? { rejectedOriginalInspection } : {}),
            });
          }
        } else {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
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
    assessAdditionalStorage,
    autosaveRecoveryDetail,
    autosaveRecoveryKind,
    beginFileOpenOperation,
    beginSceneHydration,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    isCurrentFileOpenOperation,
    openLoadedProject,
    persistPdfCandidateBeforePublication,
    restoreAbandonedOpenClassroomAlarms,
  ]);

  const handleFile = useCallback(async (file: File) => {
    const lowerName = file.name.toLowerCase();
    const replacesProject = lowerName.endsWith(".patterdraw")
      || lowerName.endsWith(".canvasclassroom")
      || lowerName.endsWith(".excalidraw")
      || file.type === "application/vnd.excalidraw+json";
    if (replacesProject) {
      const current = commitLiveScenePersistence(
        hydratedSceneIdRef.current
          || activeSceneIdRef.current
          || projectRef.current?.activeSceneId
          || "",
      ) ?? projectRef.current;
      if (current && projectNeedsSwitchProtection(current)) {
        setPendingProjectSwitch({ file, processing: false });
        return;
      }
    }
    await openFileAfterProtection(file);
  }, [commitLiveScenePersistence, openFileAfterProtection]);

  const saveProjectFile = useCallback(async (): Promise<boolean> => {
    const currentProject = commitCurrentLiveScenePersistence();
    if (!currentProject) return false;
    const operation = beginFileOpenOperation();
    const exportPdfBytes = clonePdfBytes(pdfBytesRef.current);
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
    };
    setBusyCanCancel(true);
    setBusyMessage("Preparing project backup…");
    try {
      await afterNextPaint();
      const bytes = await encodePreparedProjectFile(
        currentProject,
        exportPdfBytes,
        undefined,
        { signal: operation.signal },
      );
      if (!isCurrentFileOpenOperation(operation)) return false;
      downloadBlob(
        new Blob([bytesForBlob(bytes)], { type: "application/vnd.patterdraw+zip" }),
        `${safeFileStem(currentProject.title)}.patterdraw`,
      );
      return true;
    } catch (error) {
      if (!isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (fileOpenGenerationRef.current === operation.generation) {
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
      }
    }
  }, [beginFileOpenOperation, commitCurrentLiveScenePersistence, isCurrentFileOpenOperation]);

  const pauseUnauthorizedLiveClassroomTimeWidgets = useCallback((now = Date.now()) => {
    const currentProject = projectRef.current;
    const sceneId = hydratedSceneIdRef.current;
    if (
      !api
      || !currentProject
      || !sceneId
      || currentProject.activeSceneId !== sceneId
      || switchingSceneRef.current
    ) return;
    const liveElements = api.getSceneElementsIncludingDeleted();
    const pausedElements = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
      liveElements,
      currentProject.id,
      readClassroomAlarmRegistry(),
      now,
      classroomTimeStagedTransactionIdsRef.current,
    );
    if (pausedElements === liveElements) return;
    const display = materializeClassroomTimeSceneForDisplay(
      pausedElements,
      api.getFiles(),
      currentProject.projectCalendar,
      deviceClassroomCalendarRef.current,
      now,
      createLocalId,
      editorThemeRef.current,
    );
    if (display.addedFiles.length) api.addFiles([...display.addedFiles]);
    for (const fileId of display.orphanedFileIds) delete api.getFiles()[fileId];
    classroomTimeAlarmAuthorityFenceRef.current.push({
      sceneId,
      elementFingerprint: classroomTimeElementFingerprint(display.elements),
      fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
    });
    if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
      classroomTimeAlarmAuthorityFenceRef.current.shift();
    }
    api.updateScene({
      elements: display.elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    commitLiveScenePersistence(sceneId, true);
    flushAutosave(true);
  }, [api, commitLiveScenePersistence, flushAutosave]);

  const requestBoardClear = useCallback(() => {
    if (
      !api || boardClearProcessingRef.current || switchingSceneRef.current
      || sceneInputBlockedRef.current || workspaceModeRef.current !== "board"
    ) return;
    const current = commitCurrentLiveScenePersistence();
    const sceneId = hydratedSceneIdRef.current;
    if (!current || !sceneId || current.activeSceneId !== sceneId || current.scenes[sceneId]?.pdfPage) return;
    const summary = boardClearSummary(current, sceneId);
    if (!summary.objectCount) {
      api.setToast({ message: "The main board is already empty." });
      return;
    }
    setErrorMessage(null);
    setPendingBoardClear({
      projectId: current.id,
      sceneId,
      ...summary,
      fingerprint: classroomTimeDisplayTickContentFingerprint(api.getSceneElementsIncludingDeleted()),
    });
  }, [api, commitCurrentLiveScenePersistence]);

  const confirmBoardClear = useCallback(async () => {
    const pending = pendingBoardClear;
    if (!api || !pending || boardClearProcessingRef.current) return;
    boardClearProcessingRef.current = true;
    setBoardClearProcessing(true);
    const operation = beginFileOpenOperation();
    const isCurrentOperation = () => isCurrentFileOpenOperation(operation);
    let cleared = false;
    try {
      const before = commitCurrentLiveScenePersistence();
      if (
        !before || before.id !== pending.projectId || before.activeSceneId !== pending.sceneId
        || hydratedSceneIdRef.current !== pending.sceneId || switchingSceneRef.current
        || workspaceModeRef.current !== "board" || before.scenes[pending.sceneId]?.pdfPage
      ) throw new Error("The board changed. Nothing was cleared; open Clear board again.");
      const summary = boardClearSummary(before, pending.sceneId);
      const fingerprint = classroomTimeDisplayTickContentFingerprint(api.getSceneElementsIncludingDeleted());
      if (fingerprint !== pending.fingerprint || summary.slideCount !== pending.slideCount) {
        setPendingBoardClear({ ...pending, ...summary, fingerprint });
        throw new Error("The board changed while confirmation was open. Review the updated counts, then confirm again.");
      }
      if (!summary.objectCount) {
        setPendingBoardClear(null);
        return;
      }
      const fence = beginClassroomTimeAsyncOperation();
      if (!fence) throw new Error("The board is still opening. Nothing was cleared.");
      const pdfData = clonePdfBytes(pdfBytesRef.current);
      setErrorMessage(null);
      flushAutosave(true);
      await autosaveQueueRef.current.catch(() => undefined);
      if (!isCurrentOperation()) return;
      const { saveAutosaveHistorySnapshot, listAutosaveHistorySnapshots } = await import("./lib/autosave-history");
      // Never erase the only durable copy. Even a requested browser download
      // would not prove the file reached disk, so recovery failure is fatal.
      const saved = await saveAutosaveHistorySnapshot({ project: before, pdfBytes: pdfData }, {
        signal: operation.signal,
      });
      if (!isCurrentOperation()) return;
      if (!saved.retained) throw new Error("The recovery copy could not be retained. Nothing was cleared.");
      const retained = await listAutosaveHistorySnapshots();
      if (!isCurrentOperation()) return;
      if (!retained.some((entry) => entry.snapshotId === saved.summary.snapshotId)) {
        throw new Error("The recovery copy was replaced by another history update. Nothing was cleared.");
      }
      setRecoverySnapshots(retained);
      setRecoveryHistoryUnreadable(false);
      setDismissedRecoverySnapshotId(null);
      if (!isCurrentClassroomTimeAsyncOperation(fence, true) || workspaceModeRef.current !== "board") {
        throw new Error("The board changed while its recovery copy was being saved. Nothing was cleared; review the board and try again.");
      }

      const current = commitCurrentLiveScenePersistence();
      const scene = current?.scenes[pending.sceneId];
      if (!current || !scene || scene.pdfPage) throw new Error("The main board is no longer available.");
      const elements = api.getSceneElementsIncludingDeleted().map((element) => (
        element.isDeleted ? element : newElementWith(element, { isDeleted: true })
      ));
      const appState = {
        ...api.getAppState(),
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
        editingFrame: null,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 as AppState["zoom"]["value"] },
      };
      const candidate = projectWithPendingScene(current, {
        sceneId: pending.sceneId,
        elements,
        appState,
        files: persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current),
        preserveDeleted: true,
      });
      if (!candidate) throw new Error("The main board is no longer available.");
      const cancellationFence = beginClassroomTimeAsyncOperation();
      const identities = removedClassroomTimeAlarmIdentities(current, candidate);
      if (identities.length) {
        const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(identities, Date.now());
        if (cancellation.status !== "persisted") {
          throw new Error("The board could not be cleared because its classroom alarms could not be cancelled safely.");
        }
      }
      if (!isCurrentOperation() || !isCurrentClassroomTimeAsyncOperation(cancellationFence, true)) {
        if (identities.length) pauseUnauthorizedLiveClassroomTimeWidgets();
        throw new Error("The board changed before clearing finished. Nothing was cleared; try again.");
      }
      // A native Undo must restore wrapper-owned slide IDs and explicit order,
      // not recreate them from frame coordinates. Keep prior clear entries for
      // repeated Clear/Undo within this editor's scene-local history.
      const slideKey = (slide: ClassroomSlide) => JSON.stringify([slide.sceneId, slide.frameId]);
      const knownFrames = new Set(current.slideOrder.map(slideKey));
      clearedBoardSlidesRef.current = [
        ...current.slideOrder,
        ...clearedBoardSlidesRef.current.filter((slide) => !knownFrames.has(slideKey(slide))),
      ];
      classroomTimeAlarmAuthorityFenceRef.current.push({
        sceneId: pending.sceneId,
        elementFingerprint: classroomTimeElementFingerprint(elements),
        fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
      });
      if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) classroomTimeAlarmAuthorityFenceRef.current.shift();
      resetTransientPointerTools();
      pendingProjectSearchTargetRef.current = null;
      setActiveSlideId(null);
      setSelectedClassroomTime(null);
      cleared = true;
      api.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      api.setActiveTool({ type: "selection" });
      // Commit the live mutation against the latest project; PDF edits and
      // other scene state must never be overwritten by the captured snapshot.
      commitLiveScenePersistence(pending.sceneId, true);
      flushAutosave(true);
      setPendingBoardClear(null);
      api.setToast({ message: "Board cleared. Use Undo to restore it, or Settings → Recovery history after leaving the board." });
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        setErrorMessage(cleared
          ? `The board was cleared, but saving could not finish. Use Undo or Recovery history to restore it. ${detail}`
          : `Nothing was cleared. ${detail}`);
      }
    } finally {
      boardClearProcessingRef.current = false;
      setBoardClearProcessing(false);
      if (!isCurrentOperation()) setPendingBoardClear(null);
    }
  }, [
    api, pendingBoardClear, beginFileOpenOperation, isCurrentFileOpenOperation,
    beginClassroomTimeAsyncOperation, isCurrentClassroomTimeAsyncOperation,
    commitCurrentLiveScenePersistence, commitLiveScenePersistence, flushAutosave,
    pauseUnauthorizedLiveClassroomTimeWidgets, resetTransientPointerTools,
  ]);

  const cancelPendingProjectSwitch = useCallback(() => {
    if (pendingProjectSwitch?.processing) return;
    setPendingProjectSwitch(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [pendingProjectSwitch?.processing]);

  const protectCurrentBoardAndOpen = useCallback(async (downloadBackup: boolean) => {
    const pending = pendingProjectSwitch;
    if (!pending || pending.processing) return;
    const operation = beginFileOpenOperation();
    const isCurrentOperation = () => isCurrentFileOpenOperation(operation);
    setPendingProjectSwitch({ ...pending, processing: true });
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
    };
    setBusyCanCancel(true);
    setErrorMessage(null);
    let portableBackupRequested = false;
    try {
      const currentProject = commitCurrentLiveScenePersistence();
      if (!currentProject || !projectNeedsSwitchProtection(currentProject)) {
        setPendingProjectSwitch(null);
        await openFileAfterProtection(pending.file);
        return;
      }
      flushAutosave(true);
      await autosaveQueueRef.current.catch(() => undefined);
      if (!isCurrentOperation()) return;
      const currentPdfBytes = clonePdfBytes(pdfBytesRef.current);
      if (downloadBackup) {
        setBusyMessage("Preparing a portable backup before opening…");
        const bytes = await encodePreparedProjectFile(
          currentProject,
          currentPdfBytes,
          undefined,
          { signal: operation.signal },
        );
        if (!isCurrentOperation()) return;
        downloadBlob(
          new Blob([bytesForBlob(bytes)], { type: "application/vnd.patterdraw+zip" }),
          `${safeFileStem(currentProject.title)}.patterdraw`,
        );
        // Browsers expose the download request, not a durable acknowledgement
        // that the file reached disk. Local recovery must still succeed before
        // this tab is allowed to replace the only live board.
        portableBackupRequested = true;
      }

      setBusyMessage("Protecting the current board locally…");
      try {
        const {
          listAutosaveHistorySnapshots,
          saveAutosaveHistorySnapshot,
        } = await import("./lib/autosave-history");
        const saved = await saveAutosaveHistorySnapshot({
          project: currentProject,
          pdfBytes: currentPdfBytes,
        }, { signal: operation.signal });
        if (!isCurrentOperation()) return;
        if (!saved.retained) {
          throw new Error(
            "A newer recovery-history update won the local storage race, so this exact board was not retained. The current board remains open. Try opening the replacement again.",
          );
        }
        const retained = await listAutosaveHistorySnapshots();
        if (!isCurrentOperation()) return;
        setRecoverySnapshots(
          retained.length ? retained : saved.retained ? [saved.summary] : [],
        );
        setRecoveryHistoryUnreadable(false);
        setLocalReadinessDismissed(false);
        setDismissedRecoverySnapshotId(null);
      } catch (historyError) {
        if (isAbortLikeError(historyError)) throw historyError;
        const detail = historyError instanceof Error ? historyError.message : String(historyError);
        throw new Error(portableBackupRequested
          ? `PatterDraw requested the portable backup download, but cannot verify that it was saved. Local recovery history also failed: ${detail} The current board remains open. Check Downloads, repair local storage, and try again.`
          : `The current board could not be protected in local recovery history: ${detail} The current board remains open. Download a portable backup and try again.`);
      }
      if (!isCurrentOperation()) return;
      setPendingProjectSwitch(null);
      await openFileAfterProtection(pending.file);
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (fileOpenGenerationRef.current === operation.generation) {
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
        setPendingProjectSwitch((current) => current ? { ...current, processing: false } : null);
      }
    }
  }, [
    api,
    beginFileOpenOperation,
    commitCurrentLiveScenePersistence,
    flushAutosave,
    isCurrentFileOpenOperation,
    openFileAfterProtection,
    pendingProjectSwitch,
  ]);

  const cancelPdfCompatibilityImport = useCallback(() => {
    if (pendingPdfCompatibilityImport?.processing) return;
    setPendingPdfCompatibilityImport(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [pendingPdfCompatibilityImport?.processing]);

  const retryPdfCompatibilitySafetyCheck = useCallback(async () => {
    const pending = pendingPdfCompatibilityImport;
    if (!pending || pending.processing) return;
    setPendingPdfCompatibilityImport(null);
    if (pending.context === "batch") {
      await submitPdfInsertionRef.current?.(pending.submission);
      return;
    }
    await openFileAfterProtection(pending.file);
  }, [openFileAfterProtection, pendingPdfCompatibilityImport]);

  const importPdfCompatibilityCopy = useCallback(async (convertedFile: File) => {
    const pending = pendingPdfCompatibilityImport;
    if (!pending || pending.processing) return;
    if (!pending.rejectedOriginalInspection) {
      setErrorMessage("The rejected PDF could not be identified for compatibility-copy import.");
      return;
    }
    const rejectedOriginalInspection = pending.rejectedOriginalInspection;
    if (pending.context === "direct") {
      setPendingPdfCompatibilityImport(null);
      await openFileAfterProtection(convertedFile, {
        originalFailure: pending.failure,
        originalFile: pending.file,
        rejectedOriginalInspection,
      });
      return;
    }

    const insertion = pendingPdfInsert;
    const source = insertion?.files.find((file) => file.id === pending.sourceInstanceId);
    const originalFile = source?.compatibilityOriginal?.file ?? source?.file;
    if (!insertion || !source || !originalFile || originalFile !== pending.file) {
      setPendingPdfCompatibilityImport(null);
      setErrorMessage("The PDF insertion changed before its compatibility copy could be checked. Select the PDFs again.");
      return;
    }
    const operation = beginFileOpenOperation();
    const isCurrentOperation = () => isCurrentFileOpenOperation(operation);
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
    };
    setBusyCanCancel(true);
    setBusyMessage(`Checking ${convertedFile.name}…`);
    setPendingPdfCompatibilityImport({ ...pending, processing: true });
    setErrorMessage(null);
    try {
      const { inspectPdfFile } = await import("./lib/pdf/import-pdf");
      const original = await inspectPdfFile(originalFile, { signal: operation.signal });
      if (!isCurrentOperation()) return;
      if (
        original.sha256 !== rejectedOriginalInspection.sha256
        || original.pageCount !== rejectedOriginalInspection.pageCount
      ) {
        throw new Error("The original PDF changed after its rejected import attempt.");
      }
      const converted = await inspectPdfFile(convertedFile, { signal: operation.signal });
      if (!isCurrentOperation()) return;
      if (converted.sha256 === original.sha256) {
        throw new Error("The selected compatibility copy is identical to the rejected original PDF.");
      }
      if (converted.pageCount !== original.pageCount) {
        throw new Error(
          `The compatibility copy has ${converted.pageCount} pages, but the original has ${original.pageCount}. Convert the complete PDF so page order stays exact.`,
        );
      }
      const nextInsertion: PendingPdfInsert = {
        ...insertion,
        files: insertion.files.map((file) => file.id === source.id
          ? {
            ...file,
            compatibilityAttempted: true,
            compatibilityOriginal: source.compatibilityOriginal ?? {
              failure: pending.failure,
              file: originalFile,
              rejectedOriginalInspection,
            },
            file: convertedFile,
            name: `${originalFile.name.replace(/\.pdf$/i, "")} (visual compatibility copy).pdf`,
            pageCount: converted.pageCount,
            sha256: converted.sha256,
          }
          : file),
      };
      // Release the precheck operation before the atomic batch importer owns
      // cancellation and progress. The batch dialog remains in place behind
      // this one, and no project state has changed yet.
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
      setPendingPdfInsert(nextInsertion);
      setPendingPdfCompatibilityImport(null);
      await submitPdfInsertionRef.current?.(pending.submission, nextInsertion);
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setPendingPdfCompatibilityImport((current) => current
          ? { ...current, processing: false }
          : null);
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
    isCurrentFileOpenOperation,
    openFileAfterProtection,
    pendingPdfCompatibilityImport,
    pendingPdfInsert,
  ]);

  const recoverPreviousBoard = useCallback(async (snapshotId: string) => {
    const recovery = recoverySnapshots.find((entry) => entry.snapshotId === snapshotId);
    if (!recovery || localReadinessBusy) return;
    if (!window.confirm(
      `Recover “${recovery.title}”? PatterDraw will protect the current board locally before replacing it.`,
    )) return;
    const operation = beginFileOpenOperation();
    const isCurrentOperation = () => isCurrentFileOpenOperation(operation);
    busyCancelRef.current = () => {
      if (fileOpenGenerationRef.current !== operation.generation) return;
      fileOpenAbortControllerRef.current?.abort();
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage(null);
    };
    setBusyCanCancel(true);
    setLocalReadinessBusy(true);
    setErrorMessage(null);
    setRecoveryHistoryStatus(null);
    setBusyMessage(`Checking recovery copy “${recovery.title}”…`);
    try {
      const {
        listAutosaveHistorySnapshots,
        loadAutosaveHistorySnapshotWithFallback,
        saveAutosaveHistorySnapshot,
      } = await import("./lib/autosave-history");
      const fallback = await loadAutosaveHistorySnapshotWithFallback(
        recovery.snapshotId,
        { signal: operation.signal },
      );
      if (!isCurrentOperation()) return;
      if (fallback.failed.length) {
        setDamagedRecoverySnapshotIds((current) => new Set([
          ...current,
          ...fallback.failed.map((failure) => failure.snapshotId),
        ]));
      }
      const actualRecovery = fallback.summary;
      if (actualRecovery.snapshotId !== recovery.snapshotId) {
        const fallbackMessage = `“${recovery.title}” is damaged or incomplete. An older usable copy, “${actualRecovery.title}” from ${new Date(actualRecovery.capturedAt).toLocaleString()}, is available.`;
        setRecoveryHistoryStatus({ kind: "warning", message: fallbackMessage });
        if (!window.confirm(`${fallbackMessage} Recover the older copy instead?`)) return;
      }

      const currentProject = commitCurrentLiveScenePersistence();
      if (currentProject && projectNeedsSwitchProtection(currentProject)) {
        flushAutosave(true);
        await autosaveQueueRef.current.catch(() => undefined);
        if (!isCurrentOperation()) return;
        setBusyMessage("Protecting the current board before recovery…");
        const saved = await saveAutosaveHistorySnapshot({
          project: currentProject,
          pdfBytes: clonePdfBytes(pdfBytesRef.current),
        }, { signal: operation.signal });
        if (!isCurrentOperation()) return;
        if (!saved.retained) {
          throw new Error(
            "A newer recovery-history update won the local storage race, so this exact board was not retained. The current board remains open. Try recovery again.",
          );
        }
        const retained = await listAutosaveHistorySnapshots();
        if (!isCurrentOperation()) return;
        setRecoverySnapshots(
          retained.length ? retained : saved.retained ? [saved.summary] : [],
        );
        setRecoveryHistoryUnreadable(false);
        setLocalReadinessDismissed(false);
        setDismissedRecoverySnapshotId(null);
      }

      setBusyMessage(`Recovering “${actualRecovery.title}”…`);
      const opened = await openLoadedProject(fallback.loaded, operation, false);
      if (opened && isCurrentOperation()) {
        setDismissedRecoverySnapshotId(actualRecovery.snapshotId);
        setIsRecoveryHistoryOpen(false);
        setRecoveryHistoryStatus(null);
      }
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        const failed = error && typeof error === "object" && "failed" in error
          ? (error as { failed?: unknown }).failed
          : null;
        if (Array.isArray(failed)) {
          const failedIds = failed.flatMap((failure) => (
            failure
            && typeof failure === "object"
            && "snapshotId" in failure
            && typeof failure.snapshotId === "string"
              ? [failure.snapshotId]
              : []
          ));
          if (failedIds.length) {
            setDamagedRecoverySnapshotIds((current) => new Set([...current, ...failedIds]));
          }
        }
        const detail = error instanceof Error ? error.message : String(error);
        setRecoveryHistoryStatus({ kind: "error", message: detail });
        setErrorMessage(detail);
      }
    } finally {
      if (fileOpenGenerationRef.current === operation.generation) {
        busyCancelRef.current = null;
        setBusyCanCancel(false);
        setBusyMessage(null);
        setLocalReadinessBusy(false);
      }
    }
  }, [
    beginFileOpenOperation,
    commitCurrentLiveScenePersistence,
    flushAutosave,
    isCurrentFileOpenOperation,
    localReadinessBusy,
    openLoadedProject,
    recoverySnapshots,
  ]);

  const openRecoveryHistory = useCallback((returnFocusTarget?: HTMLElement | null) => {
    recoveryHistoryReturnFocusRef.current = returnFocusTarget
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setRecoveryHistoryStatus(null);
    setIsRecoveryHistoryOpen(true);
    void import("./lib/autosave-history")
      .then(({ listAutosaveHistorySnapshots }) => listAutosaveHistorySnapshots())
      .then((entries) => {
        setRecoverySnapshots(entries);
        setRecoveryHistoryUnreadable(false);
        const retainedIds = new Set(entries.map((entry) => entry.snapshotId));
        setDamagedRecoverySnapshotIds((current) => new Set(
          [...current].filter((snapshotId) => retainedIds.has(snapshotId)),
        ));
      })
      .catch((error) => {
        setRecoveryHistoryUnreadable(true);
        setRecoveryHistoryStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  const deleteRecoverySnapshot = useCallback(async (snapshotId: string) => {
    if (localReadinessBusy) return;
    setLocalReadinessBusy(true);
    setRecoveryHistoryStatus(null);
    try {
      const { deleteAutosaveHistorySnapshots } = await import("./lib/autosave-history");
      const result = await deleteAutosaveHistorySnapshots([snapshotId]);
      setRecoverySnapshots(result.entries);
      setRecoveryHistoryUnreadable(false);
      setDamagedRecoverySnapshotIds((current) => {
        const next = new Set(current);
        next.delete(snapshotId);
        return next;
      });
      setDismissedRecoverySnapshotId((current) => current === snapshotId ? null : current);
      setRecoveryHistoryStatus({
        kind: "info",
        message: `Deleted 1 recovery copy${result.orphanedPdfSha256s.length ? " and its unused source PDF data" : ""}.`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setRecoveryHistoryStatus({ kind: "error", message: detail });
      setErrorMessage(detail);
    } finally {
      setLocalReadinessBusy(false);
    }
  }, [localReadinessBusy]);

  const clearRecoveryHistory = useCallback(async () => {
    if (localReadinessBusy) return;
    const visibleCopyCount = recoverySnapshots.length;
    setLocalReadinessBusy(true);
    setRecoveryHistoryStatus(null);
    try {
      const { clearAutosaveHistorySnapshots } = await import("./lib/autosave-history");
      const result = await clearAutosaveHistorySnapshots();
      setRecoverySnapshots(result.entries);
      setRecoveryHistoryUnreadable(false);
      setDamagedRecoverySnapshotIds(new Set());
      setDismissedRecoverySnapshotId(null);
      setRecoveryHistoryStatus({
        kind: "info",
        message: recoveryHistoryUnreadable
          ? "Cleared all local recovery data and repaired the history index. Your current board was not changed."
          : `Deleted ${visibleCopyCount} recovery ${visibleCopyCount === 1 ? "copy" : "copies"}. Your current board was not changed.`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setRecoveryHistoryStatus({ kind: "error", message: detail });
      setErrorMessage(detail);
    } finally {
      setLocalReadinessBusy(false);
    }
  }, [localReadinessBusy, recoveryHistoryUnreadable, recoverySnapshots.length]);

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
      autosaveNeedsUnloadWarningRef.current = newerSnapshotPending;
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
      autosaveNeedsUnloadWarningRef.current = true;
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
    deviceCalendarSnapshot: ClassroomDeviceCalendarStoreV1,
    annotationMode: "hybrid" | "visual" = "hybrid",
    capturedAt = Date.now(),
    boardTheme: "light" | "dark" = editorThemeRef.current,
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
        capturedAt,
        signal: controller.signal,
        classroomTimeRenderContextForScene: (
          scene: Readonly<SerializedScene>,
          exportCapturedAt: number,
        ) => classroomTimeRenderContext(
          scene.elements as unknown as readonly ExcalidrawElement[],
          currentProject.projectCalendar,
          deviceCalendarSnapshot,
          exportCapturedAt,
          boardTheme,
        ),
        onProgress: (progress: PdfOperationProgress) => {
          if (!controller.signal.aborted && pdfExportAbortControllerRef.current === controller) {
            if (progress.phase === "saving") {
              // pdf-lib cannot interrupt final serialization. Remove the
              // Cancel affordance synchronously so the UI never claims that
              // this last memory-bound step stopped while it is still running.
              busyCancelRef.current = null;
              setBusyCanCancel(false);
            }
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
                deviceCalendarSnapshot,
                mode: kind,
                capturedAt,
                boardTheme,
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
    const capturedAt = Date.now();
    const boardTheme = editorThemeRef.current;
    const deviceCalendarSnapshot = createClassroomCalendarStoreV1(
      "device",
      deviceClassroomCalendarRef.current.events,
    );
    const exportProject = materializeProjectClassroomTimeWidgets(
      currentProject,
      capturedAt,
      deviceCalendarSnapshot,
      boardTheme,
    );
    await executePdfExport(
      exportProject,
      exportPdfBytes,
      kind,
      deviceCalendarSnapshot,
      "hybrid",
      capturedAt,
      boardTheme,
    );
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
      pending.deviceCalendarSnapshot,
      "visual",
      pending.capturedAt,
      pending.boardTheme,
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
      const capturedAt = Date.now();
      const exportProject = materializeProjectClassroomTimeWidgets(
        currentProject,
        capturedAt,
        deviceClassroomCalendarRef.current,
        editorThemeRef.current,
      );
      const blob = await exportSlidesPptx(exportProject);
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
      const capturedAt = Date.now();
      const renderContext = classroomTimeRenderContext(
        elements,
        project.projectCalendar,
        deviceClassroomCalendarRef.current,
        capturedAt,
        editorThemeRef.current,
      );
      const materializedElements = materializeClassroomTimeWidgetsForExport(
        elements,
        capturedAt,
        renderContext,
      );
      const files = scene
        ? cloneBinaryFiles(persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current))
        : cloneBinaryFiles(api.getFiles());
      const { blob, scale } = await exportFullBoardPng(api, { elements: materializedElements, files });
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
    const requestGeneration = ++nativeImageExportRequestGenerationRef.current;
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
      if (requestGeneration !== nativeImageExportRequestGenerationRef.current) return;
      if (api.getSceneElements().length === 0) return;
      const capturedAt = Date.now();
      const liveForExport = api.getSceneElementsIncludingDeleted();
      const exportRenderContext = classroomTimeRenderContext(
        liveForExport,
        project.projectCalendar,
        deviceClassroomCalendarRef.current,
        capturedAt,
        editorThemeRef.current,
      );
      const materialized = materializeClassroomTimeWidgetsForExport(
        liveForExport,
        capturedAt,
        exportRenderContext,
      );
      if (materialized !== liveForExport && hydratedSceneIdRef.current) {
        classroomTimeTickFenceRef.current.push({
          sceneId: hydratedSceneIdRef.current,
          elementFingerprint: classroomTimeElementFingerprint(materialized),
          fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
        });
        if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
        api.updateScene({ elements: materialized, captureUpdate: CaptureUpdateAction.NEVER });
        await afterNextPaint();
      }
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
      if (requestGeneration !== nativeImageExportRequestGenerationRef.current) {
        if (suspendedPdfPreview && suspendDarkPdfDisplayRef.current) {
          suspendDarkPdfDisplayRef.current = false;
          setDarkPdfDisplayRevision((revision) => revision + 1);
        }
        return;
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

  const updateLiveClassroomTimeWidget = useCallback((
    ownerId: string,
    metadata: ClassroomTimeWidgetMetadataV1,
    captureUpdate = CaptureUpdateAction.IMMEDIATELY,
  ): boolean => {
    if (!api || switchingSceneRef.current) return false;
    const baseProject = commitCurrentLiveScenePersistence();
    const sceneId = hydratedSceneIdRef.current;
    const scene = sceneId ? baseProject?.scenes[sceneId] : undefined;
    if (!baseProject || !sceneId || !scene) return false;
    const liveElements = api.getSceneElementsIncludingDeleted();
    let anchorFound = false;
    const withMetadata = liveElements.map((element) => {
      if (element.isDeleted || classroomTimeWidgetOwnerId(element) !== ownerId) return element;
      if (!classroomTimeWidgetMetadata(element)) return element;
      anchorFound = true;
      return replaceClassroomTimeMetadata(element, metadata);
    });
    if (!anchorFound) return false;
    const now = Date.now();
    const renderContext = classroomTimeRenderContext(
      withMetadata,
      baseProject.projectCalendar,
      deviceClassroomCalendarRef.current,
      now,
      editorThemeRef.current,
    );
    const reconciled = reconcileClassroomTimeWidgets(withMetadata, {
      now,
      files: api.getFiles(),
      createId: createLocalId,
      renderContext,
    });
    const liveFiles = mergeClassroomTimeFiles(
      api.getFiles(),
      reconciled.addedFiles,
      reconciled.orphanedFileIds,
    );
    const projected = projectWithPendingScene(baseProject, {
      sceneId,
      elements: reconciled.elements,
      appState: api.getAppState(),
      files: persistentFilesForScene(scene, liveFiles, transientDarkPdfFileIdsRef.current),
      preserveDeleted: true,
    });
    if (!projected) return false;
    assertProjectFitsContentBudget(projected, pdfBytesRef.current);
    if (reconciled.addedFiles.length) api.addFiles([...reconciled.addedFiles]);
    for (const fileId of reconciled.orphanedFileIds) delete api.getFiles()[fileId];
    const anchorId = reconciled.elements.find((element) => (
      !element.isDeleted
      && classroomTimeWidgetOwnerId(element) === ownerId
      && classroomTimeWidgetMetadata(element) !== null
    ))?.id;
    classroomTimeAlarmAuthorityFenceRef.current.push({
      sceneId,
      elementFingerprint: classroomTimeElementFingerprint(reconciled.elements),
      fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
      expectedDisplayContentFingerprint: classroomTimeDisplayTickContentFingerprint(
        reconciled.elements,
      ),
    });
    if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
      classroomTimeAlarmAuthorityFenceRef.current.shift();
    }
    api.updateScene({
      elements: reconciled.elements,
      appState: anchorId ? { selectedElementIds: { [anchorId]: true } } : undefined,
      captureUpdate,
    });
    commitLiveScenePersistence(sceneId, true);
    flushAutosave(true);
    return true;
  }, [api, commitCurrentLiveScenePersistence, commitLiveScenePersistence, flushAutosave]);

  const openClassroomTimeTool = useCallback((kind: ClassroomTimeWidgetKind) => {
    const ownerId = createLocalId();
    const metadata = createClassroomTimeMetadataFromPreferences(
      kind,
      ownerId,
      classroomTimePreferencesRef.current,
    );
    focusAfterMathToolsRef.current = null;
    setIsMathToolsOpen(false);
    setMathToolEdit(null);
    setClassroomTimeDialog({ mode: "insert", metadata });
  }, []);

  const reconcileExternalClassroomAlarmRegistry = useCallback((
    registry: ClassroomAlarmRegistryV1,
  ) => {
    try {
      classroomTimeAsyncOperationGenerationRef.current += 1;
      const now = Date.now();
      const baseProject = commitCurrentLiveScenePersistence() ?? projectRef.current;
      if (!baseProject) return;
      const safeProject = pauseUnauthorizedClassroomTimeWidgetsInProject(
        baseProject,
        registry,
        now,
        classroomTimeStagedTransactionIdsRef.current,
      );
      if (safeProject === baseProject) return;
      assertProjectFitsContentBudget(safeProject, pdfBytesRef.current);
      const sceneId = hydratedSceneIdRef.current;
      const safeScene = sceneId && safeProject.activeSceneId === sceneId
        ? safeProject.scenes[sceneId]
        : null;
      const rehydrateInterruptedSwitch = !!api && !!safeScene && switchingSceneRef.current;
      let display: ReturnType<typeof materializeClassroomTimeSceneForDisplay> | null = null;
      if (api && safeScene && !rehydrateInterruptedSwitch) {
        display = materializeClassroomTimeSceneForDisplay(
          safeScene.elements as unknown as readonly ExcalidrawElement[],
          safeScene.files as unknown as BinaryFiles,
          safeProject.projectCalendar,
          deviceClassroomCalendarRef.current,
          now,
          createLocalId,
          editorThemeRef.current,
        );
      }
      stageProjectMutationForAutosave(safeProject);
      if (rehydrateInterruptedSwitch && safeScene) {
        loadSceneIntoEditor(safeScene);
      } else if (api && display && sceneId) {
        if (display.addedFiles.length) api.addFiles([...display.addedFiles]);
        for (const fileId of display.orphanedFileIds) delete api.getFiles()[fileId];
        classroomTimeAlarmAuthorityFenceRef.current.push({
          sceneId,
          elementFingerprint: classroomTimeElementFingerprint(display.elements),
          fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
        });
        if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
          classroomTimeAlarmAuthorityFenceRef.current.shift();
        }
        api.updateScene({
          elements: display.elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      flushAutosave(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    api,
    commitCurrentLiveScenePersistence,
    flushAutosave,
    loadSceneIntoEditor,
    stageProjectMutationForAutosave,
  ]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CLASSROOM_ALARM_REGISTRY_STORAGE_KEY && event.key !== null) return;
      reconcileExternalClassroomAlarmRegistry(readClassroomAlarmRegistry());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reconcileExternalClassroomAlarmRegistry]);

  const submitClassroomTimeWidget = useCallback((metadata: ClassroomTimeWidgetMetadataV1) => {
    if (!api || !classroomTimeDialog) return;
    void (async () => {
      try {
      if (classroomTimeDialog.mode === "update") {
        const operationFence = beginClassroomTimeAsyncOperation();
        if (!operationFence) return;
        const currentProject = projectRef.current;
        const anchor = api.getSceneElements().find((element) => (
          element.id === classroomTimeDialog.anchorId
        ));
        if (!currentProject || !anchor) {
          throw new Error("That classroom time widget is no longer available.");
        }
        const oldDescriptors = activeClassroomTimeAlarmDescriptors(
          currentProject.id,
          [anchor],
        );
        let safeMetadata = metadata;
        const requestedDescriptors = activeClassroomTimeAlarmDescriptors(
          currentProject.id,
          [replaceClassroomTimeMetadata(anchor, safeMetadata)],
        );
        for (const descriptor of requestedDescriptors) {
          const existing = oldDescriptors.find((candidate) => candidate.id === descriptor.id);
          if (!existing || !classroomAlarmJobMatchesDescriptor(
            classroomAlarmJobFromDescriptor(existing),
            descriptor,
          )) {
            safeMetadata = applyClassroomTimeControl(
              safeMetadata,
              descriptor.target,
              "pause",
              Date.now(),
            );
          }
        }
        const safeDescriptors = activeClassroomTimeAlarmDescriptors(
          currentProject.id,
          [replaceClassroomTimeMetadata(anchor, safeMetadata)],
        );
        const cancelledIdentities = oldDescriptors.filter((descriptor) => {
          const retained = safeDescriptors.find((candidate) => candidate.id === descriptor.id);
          return !retained || !classroomAlarmJobMatchesDescriptor(
            classroomAlarmJobFromDescriptor(descriptor),
            retained,
          );
        }).map((descriptor) => ({
          sourceProjectId: descriptor.sourceProjectId,
          ownerId: descriptor.ownerId,
          target: descriptor.target,
        }));
        if (cancelledIdentities.length) {
          const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
            cancelledIdentities,
            Date.now(),
          );
          if (cancellation.status !== "persisted") {
            throw new Error("The widget could not be updated because its alarm changes could not be saved durably.");
          }
          if (!isCurrentClassroomTimeAsyncOperation(operationFence, true)) {
            pauseUnauthorizedLiveClassroomTimeWidgets();
            return;
          }
        }
        if (!updateLiveClassroomTimeWidget(safeMetadata.ownerId, safeMetadata)) {
          if (cancelledIdentities.length) pauseUnauthorizedLiveClassroomTimeWidgets();
          throw new Error("That classroom time widget is no longer available.");
        }
        setClassroomTimeDialog(null);
        showClassroomTimeConfirmationToast(
          cancelledIdentities.length
            ? "Classroom time widget updated. Changed alarms are paused until you press Start."
            : "Classroom time widget updated.",
        );
        return;
      }
      const baseProject = commitCurrentLiveScenePersistence();
      const sceneId = hydratedSceneIdRef.current;
      const scene = sceneId ? baseProject?.scenes[sceneId] : undefined;
      if (!baseProject || !sceneId || !scene || switchingSceneRef.current) return;
      if (countProjectClassroomTimeWidgets(baseProject) >= MAX_CLASSROOM_TIME_WIDGETS) {
        throw new Error(`A project can contain at most ${MAX_CLASSROOM_TIME_WIDGETS} classroom time widgets.`);
      }
      const appState = api.getAppState();
      const center = viewportCoordsToSceneCoords({
        clientX: appState.offsetLeft + appState.width / 2,
        clientY: appState.offsetTop + appState.height / 2,
      }, appState);
      const now = Date.now();
      const created = createClassroomTimeWidgetScene({
        metadata,
        x: center.x - 170,
        y: center.y - 125,
        now,
        createId: createLocalId,
      });
      const initialElements = [...api.getSceneElementsIncludingDeleted(), ...created.elements];
      const initialFiles = mergeClassroomTimeFiles(api.getFiles(), created.files, []);
      const renderContext = classroomTimeRenderContext(
        initialElements,
        baseProject.projectCalendar,
        deviceClassroomCalendarRef.current,
        now,
        editorThemeRef.current,
      );
      const reconciled = reconcileClassroomTimeWidgets(initialElements, {
        now,
        files: initialFiles,
        createId: createLocalId,
        renderContext,
      });
      const liveFiles = mergeClassroomTimeFiles(
        initialFiles,
        reconciled.addedFiles,
        reconciled.orphanedFileIds,
      );
      const projected = projectWithPendingScene(baseProject, {
        sceneId,
        elements: reconciled.elements,
        appState,
        files: persistentFilesForScene(scene, liveFiles, transientDarkPdfFileIdsRef.current),
        preserveDeleted: true,
      });
      if (!projected) return;
      assertProjectFitsContentBudget(projected, pdfBytesRef.current);
      api.addFiles([...created.files, ...reconciled.addedFiles]);
      for (const fileId of reconciled.orphanedFileIds) delete api.getFiles()[fileId];
      api.setActiveTool({ type: "selection" });
      api.updateScene({
        elements: reconciled.elements,
        appState: { selectedElementIds: { [created.anchorId]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      commitLiveScenePersistence(sceneId, true);
      flushAutosave(true);
      setClassroomTimeDialog(null);
      showClassroomTimeConfirmationToast(`${metadata.label || "Classroom time widget"} added.`);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [
    api,
    beginClassroomTimeAsyncOperation,
    classroomTimeDialog,
    commitCurrentLiveScenePersistence,
    commitLiveScenePersistence,
    flushAutosave,
    isCurrentClassroomTimeAsyncOperation,
    pauseUnauthorizedLiveClassroomTimeWidgets,
    showClassroomTimeConfirmationToast,
    updateLiveClassroomTimeWidget,
  ]);

  const createClassroomTimeCalendarEvent = useCallback(async (
    layer: "device" | "project",
    draft: ClassroomCalendarEventDraft,
  ): Promise<ClassroomCalendarEventCreateResult> => {
    try {
      const timestamp = new Date().toISOString();
      const event: ClassroomCalendarEventV1 = {
        schemaVersion: 1,
        id: createLocalId(),
        date: draft.date,
        title: draft.title.trim(),
        ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
        color: draft.color,
        allDay: draft.allDay,
        ...(!draft.allDay && draft.startTime ? { startTime: draft.startTime } : {}),
        ...(!draft.allDay && draft.endTime ? { endTime: draft.endTime } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (layer === "device") {
        const result = await mutateDeviceClassroomCalendar((store) => (
          upsertClassroomCalendarEvent(store, event)
        ));
        if (result.status !== "persisted") {
          throw new Error("The device calendar event could not be saved durably.");
        }
        deviceClassroomCalendarRef.current = result.store;
        setDeviceClassroomCalendar(result.store);
        return { status: "created" };
      }
      const currentProject = projectRef.current;
      if (!currentProject) return { status: "failed", message: "No project is open." };
      const projectCalendar = upsertClassroomCalendarEvent(
        currentProject.projectCalendar ?? createClassroomCalendarStoreV1("project"),
        event,
      );
      const nextProject = {
        ...currentProject,
        projectCalendar,
        updatedAt: nowIso(),
      };
      assertProjectFitsContentBudget(nextProject, pdfBytesRef.current);
      stageProjectMutationForAutosave(nextProject);
      window.requestAnimationFrame(() => flushAutosave(true));
      const dialogMetadata = classroomTimeDialog?.metadata;
      const keepsAllProjectEvents = !!dialogMetadata
        && (dialogMetadata.kind === "calendar" || dialogMetadata.kind === "dashboard")
        && dialogMetadata.calendar.projectEventIds.length === 0;
      return keepsAllProjectEvents
        ? { status: "created" }
        : { status: "created", projectEventId: event.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      return { status: "failed", message };
    }
  }, [classroomTimeDialog?.metadata, flushAutosave, stageProjectMutationForAutosave]);

  const restoreClassroomTimeWidgetDefaults = useCallback((kind: ClassroomTimeWidgetKind) => {
    const ownerId = classroomTimeDialog?.metadata.ownerId ?? createLocalId();
    return createClassroomTimeMetadataFromPreferences(
      kind,
      ownerId,
      DEFAULT_CLASSROOM_TIME_PREFERENCES as ClassroomTimePreferencesV1,
    );
  }, [classroomTimeDialog?.metadata.ownerId]);

  const saveClassroomTimeDefaults = useCallback((metadata: ClassroomTimeWidgetMetadataV1) => {
    void (async () => {
      try {
        const result = await persistClassroomTimePreferencePatch(
          classroomTimePreferencesRef.current,
          classroomTimePreferencePatchForMetadata(metadata),
        );
        classroomTimePreferencesRef.current = result.preferences;
        setClassroomTimePreferences(result.preferences);
        if (result.status !== "persisted" && result.status !== "memory-only") {
          setErrorMessage("Classroom time defaults could not be saved on this device.");
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const setClassroomAlarmPreferences = useCallback((preferences: { muted: boolean; volume: number }) => {
    void (async () => {
      try {
        const result = await persistClassroomTimePreferencePatch(
          classroomTimePreferencesRef.current,
          { muted: preferences.muted, masterVolume: preferences.volume },
        );
        classroomTimePreferencesRef.current = result.preferences;
        setClassroomTimePreferences(result.preferences);
        if (result.status !== "persisted" && result.status !== "memory-only") {
          setErrorMessage("Alarm preferences could not be saved on this device.");
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const testClassroomAlarm = useCallback((tone: ClassroomAlarmTone) => {
    void (async () => {
      try {
        const prepared = await prepareClassroomAlarmAudio();
        if (prepared.status !== "ready") {
          setErrorMessage("Your browser blocked alarm audio. Try Test alarm again after interacting with the page.");
          return;
        }
        const preferences = classroomTimePreferencesRef.current;
        const playback = await testClassroomAlarmTone(
          tone,
          preferences.masterVolume,
          preferences.muted,
        );
        if (playback.status === "blocked" || playback.status === "unavailable") {
          setErrorMessage("Alarm audio is unavailable in this browser.");
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const controlSelectedClassroomTimeWidget = useCallback((
    command: ClassroomTimeOverlayCommand,
    target: ClassroomTimeOverlayTarget,
  ) => {
    const selection = presentationRef.current
      ? presentationClassroomTimeSelection
      : selectedClassroomTime;
    if (!selection) return;
    setClassroomTimeActiveTarget(target);
    void (async () => {
      let operationFence: ClassroomTimeSchedulerPublicationFence | null = null;
      let stagedReceipt: ClassroomAlarmTransactionReceiptV1 | null = null;
      let stagedIdentity: ClassroomAlarmIdentity | null = null;
      try {
        operationFence = beginClassroomTimeAsyncOperation();
        if (!operationFence) return;
        const alarmEnabled = (
          selection.metadata.kind === "timer"
          || selection.metadata.kind === "pomodoro"
          || selection.metadata.kind === "dashboard"
        ) && selection.metadata.alarm.enabled;
        if (command === "start") {
          let preparationStatus: "blocked" | "ready" | "unavailable" = "unavailable";
          try {
            preparationStatus = (await prepareClassroomAlarmAudio()).status;
          } catch {
            // The countdown is still useful without audio. The visible warning
            // below keeps the silent-alarm risk explicit before time is up.
          }
          if (alarmEnabled) {
            const preferences = classroomTimePreferencesRef.current;
            const warning = classroomAlarmStartWarning(
              preparationStatus,
              preferences.muted,
              preferences.masterVolume,
            );
            if (warning) setErrorMessage(warning);
          }
        }
        if (!isCurrentClassroomTimeAsyncOperation(operationFence, true)) return;
        if (!api) throw new Error("The classroom time widget is unavailable.");
        const currentProject = projectRef.current;
        const anchor = api.getSceneElements().find((element) => element.id === selection.anchorId);
        const liveMetadata = anchor ? classroomTimeWidgetMetadata(anchor) : null;
        if (!currentProject || !anchor || !liveMetadata || liveMetadata.ownerId !== selection.ownerId) {
          throw new Error("That classroom time widget is no longer available.");
        }
        const identity = {
          sourceProjectId: currentProject.id,
          ownerId: selection.ownerId,
          target,
        } as const;
        stagedIdentity = identity;
        const wallNowMs = Date.now();
        const nowMs = command === "start" || command === "skip"
          ? nextClassroomAlarmGenerationStartMs(
              readClassroomAlarmRegistry(),
              identity,
              wallNowMs,
            )
          : wallNowMs;
        const metadata = applyClassroomTimeControl(
          liveMetadata,
          target,
          command,
          nowMs,
        );
        const descriptor = activeClassroomTimeAlarmDescriptors(
          currentProject.id,
          [replaceClassroomTimeMetadata(anchor, metadata)],
        ).find((candidate) => candidate.id === `${selection.ownerId}:${target}`);
        const mustCancel = command === "pause"
          || command === "reset"
          || (command === "skip" && !descriptor);
        if (mustCancel) {
          const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
            [identity],
            nowMs,
          );
          if (cancellation.status !== "persisted") {
            throw new Error("The classroom alarm cancellation could not be saved on this device.");
          }
          if (!isCurrentClassroomTimeAsyncOperation(operationFence, true)) {
            pauseUnauthorizedLiveClassroomTimeWidgets();
            return;
          }
        } else if (descriptor) {
          const reservedJob = classroomAlarmJobFromDescriptor(descriptor);
          const reservation = await stageTrustedClassroomAlarmJobs(
            [reservedJob],
            nowMs,
          );
          if (reservation.status !== "persisted" || !reservation.receipt) {
            try {
              await cancelClassroomAlarmIdentitiesWithReceipt([identity], Date.now());
            } catch {
              // The UI has not published the requested running generation.
            }
            pausePublishedClassroomAlarmIdentities([identity]);
            throw new Error("The classroom alarm could not be scheduled on this device.");
          }
          stagedReceipt = reservation.receipt;
          trackPreparedClassroomAlarmReceipts([stagedReceipt]);
          if (!isCurrentClassroomTimeAsyncOperation(operationFence, true)) {
            if (!await rollbackPreparedClassroomAlarmReceipts([stagedReceipt])) {
              pausePublishedClassroomAlarmIdentities([identity]);
              throw new Error("A superseded classroom alarm could not be rolled back durably.");
            }
            return;
          }
        }
        if (!updateLiveClassroomTimeWidget(selection.ownerId, metadata)) {
          if (stagedReceipt) {
            if (!await rollbackPreparedClassroomAlarmReceipts([stagedReceipt])) {
              pausePublishedClassroomAlarmIdentities([identity]);
              throw new Error("The superseded classroom alarm could not be rolled back durably.");
            }
          } else if (mustCancel) {
            pauseUnauthorizedLiveClassroomTimeWidgets();
          }
          throw new Error("That classroom time widget is no longer available.");
        }
        setPresentationClassroomTimeSelection((remembered) => (
          updateRememberedPresentationClassroomTimeSelection(remembered, {
            ...selection,
            metadata,
          }, {
            projectId: projectRef.current?.id || null,
            sceneId: hydratedSceneIdRef.current,
          })
        ));
        if (stagedReceipt) {
          const publishedReceipt = stagedReceipt;
          if (!await activatePublishedClassroomAlarmReceipts([publishedReceipt])) {
            throw new Error("The timer was paused because its alarm could not be activated durably.");
          }
          setClassroomTimeAlarmNotice((current) => (
            classroomTimeAlarmNoticeAfterSupersedingJob(current, publishedReceipt.stagedJobs[0].id)
          ));
        }
      } catch (error) {
        if (
          stagedReceipt
          && classroomTimeStagedTransactionIdsRef.current.has(stagedReceipt.transactionId)
        ) {
          const rolledBack = await rollbackPreparedClassroomAlarmReceipts([stagedReceipt]);
          if (!rolledBack && stagedIdentity) {
            pausePublishedClassroomAlarmIdentities([stagedIdentity]);
          }
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [
    api,
    activatePublishedClassroomAlarmReceipts,
    beginClassroomTimeAsyncOperation,
    isCurrentClassroomTimeAsyncOperation,
    pausePublishedClassroomAlarmIdentities,
    pauseUnauthorizedLiveClassroomTimeWidgets,
    presentationClassroomTimeSelection,
    rollbackPreparedClassroomAlarmReceipts,
    selectedClassroomTime,
    trackPreparedClassroomAlarmReceipts,
    updateLiveClassroomTimeWidget,
  ]);

  const customizeSelectedClassroomTimeWidget = useCallback(() => {
    if (!selectedClassroomTime) return;
    setClassroomTimeDialog({
      mode: "update",
      anchorId: selectedClassroomTime.anchorId,
      metadata: selectedClassroomTime.metadata,
    });
  }, [selectedClassroomTime]);

  const duplicateSelectedClassroomTimeWidget = useCallback(() => {
    if (!api || !selectedClassroomTime) return;
    try {
      const baseProject = commitCurrentLiveScenePersistence();
      const sceneId = hydratedSceneIdRef.current;
      const scene = sceneId ? baseProject?.scenes[sceneId] : undefined;
      if (!baseProject || !sceneId || !scene) return;
      if (countProjectClassroomTimeWidgets(baseProject) >= MAX_CLASSROOM_TIME_WIDGETS) {
        throw new Error(`A project can contain at most ${MAX_CLASSROOM_TIME_WIDGETS} classroom time widgets.`);
      }
      const liveElements = api.getSceneElements();
      const source = liveElements.filter((element) => (
        classroomTimeWidgetOwnerId(element) === selectedClassroomTime.ownerId
      ));
      if (!source.length) throw new Error("That classroom time widget is no longer available.");
      const forked = forkClassroomTimeWidgets(source, Date.now(), createLocalId);
      const duplicated = forked.elements.map((element) => ({
        ...element,
        x: element.x + 24,
        y: element.y + 24,
      })) as ExcalidrawElement[];
      const elements = [...api.getSceneElementsIncludingDeleted(), ...duplicated];
      const candidate = projectWithPendingScene(baseProject, {
        sceneId,
        elements,
        appState: api.getAppState(),
        files: persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current),
        preserveDeleted: true,
      });
      if (!candidate) return;
      assertProjectFitsContentBudget(candidate, pdfBytesRef.current);
      const anchorId = duplicated.find((element) => classroomTimeWidgetMetadata(element) !== null)?.id;
      api.updateScene({
        elements,
        appState: anchorId ? { selectedElementIds: { [anchorId]: true } } : undefined,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      commitLiveScenePersistence(sceneId, true);
      flushAutosave(true);
      showClassroomTimeConfirmationToast("Classroom time widget duplicated.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    api,
    commitCurrentLiveScenePersistence,
    commitLiveScenePersistence,
    flushAutosave,
    selectedClassroomTime,
    showClassroomTimeConfirmationToast,
  ]);

  const convertSelectedClassroomTimeWidget = useCallback(() => {
    if (!api || !selectedClassroomTime) return;
    const ownerId = selectedClassroomTime.ownerId;
    const sceneId = hydratedSceneIdRef.current;
    const operationFence = beginClassroomTimeAsyncOperation();
    if (!sceneId || !operationFence) return;
    void (async () => {
      try {
        const currentProject = projectRef.current;
        if (!currentProject) return;
        const now = Date.now();
        const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt([
          { sourceProjectId: currentProject.id, ownerId, target: "timer" },
          { sourceProjectId: currentProject.id, ownerId, target: "pomodoro" },
        ], now);
        if (cancellation.status !== "persisted") {
          throw new Error("The widget could not be converted because its alarms could not be cancelled durably.");
        }
        if (!isCurrentClassroomTimeAsyncOperation(operationFence, true)) {
          pauseUnauthorizedLiveClassroomTimeWidgets();
          return;
        }
        const baseProject = commitCurrentLiveScenePersistence();
        const liveSceneId = hydratedSceneIdRef.current;
        const scene = liveSceneId ? baseProject?.scenes[liveSceneId] : undefined;
        if (!baseProject || liveSceneId !== sceneId || !scene) return;
        const renderContext = classroomTimeRenderContext(
          api.getSceneElements(),
          baseProject.projectCalendar,
          EMPTY_DEVICE_CLASSROOM_CALENDAR,
          now,
          editorThemeRef.current,
        );
        const elements = ungroupClassroomTimeWidget(
          api.getSceneElementsIncludingDeleted(),
          ownerId,
          now,
          renderContext,
        );
        const candidate = projectWithPendingScene(baseProject, {
          sceneId,
          elements,
          appState: api.getAppState(),
          files: persistentFilesForScene(
            scene,
            api.getFiles(),
            transientDarkPdfFileIdsRef.current,
          ),
          preserveDeleted: true,
        });
        if (!candidate) return;
        assertProjectFitsContentBudget(candidate, pdfBytesRef.current);
        classroomTimeAlarmAuthorityFenceRef.current.push({
          sceneId,
          elementFingerprint: classroomTimeElementFingerprint(elements),
          fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
        });
        if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
          classroomTimeAlarmAuthorityFenceRef.current.shift();
        }
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        stageProjectMutationForAutosave(candidate);
        flushAutosave(true);
        setSelectedClassroomTime(null);
        showClassroomTimeConfirmationToast("Widget converted to ordinary editable elements.");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [
    api,
    beginClassroomTimeAsyncOperation,
    commitCurrentLiveScenePersistence,
    flushAutosave,
    isCurrentClassroomTimeAsyncOperation,
    pauseUnauthorizedLiveClassroomTimeWidgets,
    selectedClassroomTime,
    showClassroomTimeConfirmationToast,
    stageProjectMutationForAutosave,
  ]);

  const deleteSelectedClassroomTimeWidget = useCallback(() => {
    if (!api || !selectedClassroomTime) return;
    const ownerId = selectedClassroomTime.ownerId;
    const sceneId = hydratedSceneIdRef.current;
    const operationFence = beginClassroomTimeAsyncOperation();
    if (!sceneId || !operationFence) return;
    void (async () => {
      try {
        const currentProject = projectRef.current;
        if (!currentProject) return;
        const now = Date.now();
        const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt([
          { sourceProjectId: currentProject.id, ownerId, target: "timer" },
          { sourceProjectId: currentProject.id, ownerId, target: "pomodoro" },
        ], now);
        if (cancellation.status !== "persisted") {
          throw new Error("The widget could not be deleted because its alarms could not be cancelled durably.");
        }
        if (!isCurrentClassroomTimeAsyncOperation(operationFence, true)) {
          pauseUnauthorizedLiveClassroomTimeWidgets();
          return;
        }
        const baseProject = commitCurrentLiveScenePersistence();
        const liveSceneId = hydratedSceneIdRef.current;
        const scene = liveSceneId ? baseProject?.scenes[liveSceneId] : undefined;
        if (!baseProject || liveSceneId !== sceneId || !scene) return;
        const elements = api.getSceneElementsIncludingDeleted().map((element) => (
          !element.isDeleted && classroomTimeWidgetOwnerId(element) === ownerId
            ? newElementWith(element, { isDeleted: true })
            : element
        ));
        const candidate = projectWithPendingScene(baseProject, {
          sceneId,
          elements,
          appState: api.getAppState(),
          files: persistentFilesForScene(
            scene,
            api.getFiles(),
            transientDarkPdfFileIdsRef.current,
          ),
          preserveDeleted: true,
        });
        if (!candidate) return;
        assertProjectFitsContentBudget(candidate, pdfBytesRef.current);
        classroomTimeAlarmAuthorityFenceRef.current.push({
          sceneId,
          elementFingerprint: classroomTimeElementFingerprint(elements),
          fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
        });
        if (classroomTimeAlarmAuthorityFenceRef.current.length > 8) {
          classroomTimeAlarmAuthorityFenceRef.current.shift();
        }
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        stageProjectMutationForAutosave(candidate);
        flushAutosave(true);
        setSelectedClassroomTime(null);
        showClassroomTimeConfirmationToast("Classroom time widget deleted. Use Undo to restore it.");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [
    api,
    beginClassroomTimeAsyncOperation,
    commitCurrentLiveScenePersistence,
    flushAutosave,
    isCurrentClassroomTimeAsyncOperation,
    pauseUnauthorizedLiveClassroomTimeWidgets,
    selectedClassroomTime,
    showClassroomTimeConfirmationToast,
    stageProjectMutationForAutosave,
  ]);

  const reconcileClassroomTimeAlarmRegistry = useCallback(async (currentProject: ClassroomProject) => {
    if (classroomTimeStagedTransactionIdsRef.current.size > 0) return;
    if (!classroomTimeAlarmReconciliationNeeded(
      currentProject,
      readClassroomAlarmRegistry(),
    )) return;
    const nowMs = Date.now();
    const operationFence = beginClassroomTimeAsyncOperation();
    if (!operationFence || operationFence.project !== currentProject) return;
    let preparedReceipts: readonly ClassroomAlarmTransactionReceiptV1[] = [];
    let preparedProjectPublished = false;
    try {
      const prepared = await prepareClassroomAlarmPublication(currentProject, nowMs);
      preparedReceipts = prepared.receipts;
      trackPreparedClassroomAlarmReceipts(prepared.receipts);
      if (!isCurrentClassroomTimeAsyncOperation(operationFence)) {
        if (!await rollbackPreparedClassroomAlarmReceipts(prepared.receipts)) {
          pausePublishedClassroomAlarmIdentities(
            classroomAlarmIdentitiesForTransactionReceipts(prepared.receipts),
          );
          setErrorMessage("A superseded classroom alarm recovery could not be rolled back durably.");
        }
        return;
      }
      if (prepared.project !== currentProject) {
        stageProjectMutationForAutosave(prepared.project);
        preparedProjectPublished = true;
        const sceneId = hydratedSceneIdRef.current;
        const scene = sceneId && prepared.project.activeSceneId === sceneId
          ? prepared.project.scenes[sceneId]
          : null;
        if (api && scene) {
          const display = materializeClassroomTimeSceneForDisplay(
            scene.elements as unknown as readonly ExcalidrawElement[],
            scene.files as unknown as BinaryFiles,
            prepared.project.projectCalendar,
            deviceClassroomCalendarRef.current,
            nowMs,
            createLocalId,
            editorThemeRef.current,
          );
          if (display.addedFiles.length) api.addFiles([...display.addedFiles]);
          for (const fileId of display.orphanedFileIds) delete api.getFiles()[fileId];
          api.updateScene({
            elements: display.elements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
        window.requestAnimationFrame(() => flushAutosave(true));
      } else {
        // Reaffirm the already-published project/ref pair immediately before
        // making its exact recovered generation deliverable.
        projectRef.current = currentProject;
        preparedProjectPublished = true;
      }
      if (!await activatePublishedClassroomAlarmReceipts(prepared.receipts)) {
        setErrorMessage("A recovered classroom timer was paused because its alarm could not be activated durably.");
      } else if (prepared.pausedIdentities.length) {
        setErrorMessage("A classroom timer was paused because its prior alarm authority was no longer safe to resume.");
      }
      preparedReceipts = [];
    } catch (error) {
      if (preparedReceipts.length) {
        const identities = classroomAlarmIdentitiesForTransactionReceipts(preparedReceipts);
        const rolledBack = await rollbackPreparedClassroomAlarmReceipts(preparedReceipts);
        if (!rolledBack || preparedProjectPublished) {
          pausePublishedClassroomAlarmIdentities(identities);
        }
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    activatePublishedClassroomAlarmReceipts,
    api,
    beginClassroomTimeAsyncOperation,
    flushAutosave,
    isCurrentClassroomTimeAsyncOperation,
    pausePublishedClassroomAlarmIdentities,
    rollbackPreparedClassroomAlarmReceipts,
    stageProjectMutationForAutosave,
    trackPreparedClassroomAlarmReceipts,
  ]);

  useEffect(() => {
    if (project) void reconcileClassroomTimeAlarmRegistry(project);
  }, [project, reconcileClassroomTimeAlarmRegistry]);

  const deliverClassroomAlarmBatch = useCallback(async (
    jobs: readonly ClassroomAlarmJobV1[],
    publishNotice: boolean,
  ): Promise<"acknowledged" | "audio-blocked"> => {
    if (publishNotice) {
      setClassroomTimeAlarmNotice({
        jobs: [...jobs],
        jobIds: jobs.map((job) => job.id),
        message: classroomAlarmNoticeMessage(jobs),
        blocked: false,
        deliveryPending: true,
      });
    }
    const preferences = classroomTimePreferencesRef.current;
    try {
      const playback = await playClassroomAlarmTone(jobs[0]?.tone ?? "warm-chime", {
        masterVolume: preferences.masterVolume,
        muted: preferences.muted,
      });
      const acknowledged = playback.status === "played" || playback.status === "muted";
      return acknowledged ? "acknowledged" : "audio-blocked";
    } catch {
      return "audio-blocked";
    }
  }, []);

  const enableClassroomAlarmSound = useCallback(() => {
    void (async () => {
      try {
        const prepared = await prepareClassroomAlarmAudio();
        if (prepared.status !== "ready") {
          setErrorMessage("Your browser is still blocking alarm audio. Interact with the page, then try again.");
          return;
        }
        const result = await replayBlockedClassroomAlarmJobs(
          classroomTimeClaimantIdRef.current,
          Date.now(),
          (jobs) => deliverClassroomAlarmBatch(jobs, false),
        );
        if (result.deliveryResult === "acknowledged") {
          setClassroomTimeAlarmNotice((current) => current ? { ...current, blocked: false } : current);
        }
        if (result.persistenceStatus === "rolled-back" || result.persistenceStatus === "conflicted") {
          setErrorMessage("The alarm result could not be saved on this device.");
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [deliverClassroomAlarmBatch]);

  const dismissClassroomAlarmNotice = useCallback(() => {
    const notice = classroomTimeAlarmNoticeRef.current;
    if (!classroomTimeAlarmNoticeCanDismiss(notice)) return;
    void (async () => {
      try {
        if (notice.blocked) {
          const noticeIds = new Set(notice.jobIds);
          const blockedJobs = readClassroomAlarmRegistry().jobs.filter((job) => (
            noticeIds.has(job.id) && job.deliveryState === "blocked"
          ));
          if (blockedJobs.length) {
            const acknowledged = await acknowledgeBlockedClassroomAlarmJobs(
              blockedJobs,
              Date.now(),
            );
            if (acknowledged.status !== "persisted") {
              throw new Error("The dismissed alarm could not be acknowledged on this device.");
            }
          }
        }
        setClassroomTimeAlarmNotice((current) => current === notice ? null : current);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const runClassroomTimeScheduler = useCallback(async (now: number) => {
    if (classroomTimeSchedulerRunningRef.current) return;
    classroomTimeSchedulerRunningRef.current = true;
    let stagedSchedulerReceipt: ClassroomAlarmTransactionReceiptV1 | null = null;
    if (classroomTimeOverlayNeedsTicksRef.current) setClassroomTimeNowMs(now);
    try {
      const alarmResult = await claimAndMarkDueClassroomAlarmJobs(
        classroomTimeClaimantIdRef.current,
        now,
        (jobs) => deliverClassroomAlarmBatch(jobs, true),
      );
      if (
        alarmResult.persistenceStatus === "rolled-back"
        || alarmResult.persistenceStatus === "conflicted"
      ) setErrorMessage("A completed classroom alarm could not be saved on this device.");
      if (alarmResult.deliveryResult === "audio-blocked") {
        const deliveredIds = new Set(alarmResult.jobs.map((job) => job.id));
        const blockedJobs = readClassroomAlarmRegistry().jobs.filter((job) => (
          deliveredIds.has(job.id) && job.deliveryState === "blocked"
        ));
        setClassroomTimeAlarmNotice((current) => {
          if (!current || !current.jobIds.some((jobId) => deliveredIds.has(jobId))) return current;
          const currentIds = new Set(current.jobIds);
          const settledJobs = blockedJobs.filter((job) => currentIds.has(job.id));
          return {
            jobs: settledJobs.length ? settledJobs : current.jobs,
            jobIds: settledJobs.length ? settledJobs.map((job) => job.id) : current.jobIds,
            message: settledJobs.length ? classroomAlarmNoticeMessage(settledJobs) : current.message,
            blocked: true,
            deliveryPending: false,
          };
        });
      } else if (alarmResult.deliveryResult === "acknowledged") {
        const deliveredIds = new Set(alarmResult.jobs.map((job) => job.id));
        setClassroomTimeAlarmNotice((current) => (
          current?.jobIds.some((jobId) => deliveredIds.has(jobId))
            ? { ...current, blocked: false, deliveryPending: false }
            : current
        ));
      }

      const currentProject = projectRef.current;
      const schedulerIndex = classroomTimeSchedulerIndexRef.current;
      if (
        !currentProject
        || schedulerIndex.projectId !== currentProject.id
        || schedulerIndex.widgetCount === 0
      ) return;
      if (
        !api
        || switchingSceneRef.current
        || nativeImageExportOpenRef.current
        || classroomTimePointerActiveRef.current
        || classroomTimeGestureInProgress(api.getAppState())
      ) return;

      const activeSceneId = hydratedSceneIdRef.current;
      let nextProject = currentProject;
      let projectChanged = false;
      let activeUpdate: {
        elements: readonly ExcalidrawElement[];
        addedFiles: readonly BinaryFileData[];
        orphanedFileIds: readonly FileId[];
      } | null = null;
      const autoStartDescriptorsByIdentity = new Map<string, ClassroomTimeAlarmDescriptor>();

      const transitionSceneIds = [...schedulerIndex.scenes.values()]
        .filter((entry) => (
          entry.nextTransitionAtMs !== null
          && entry.nextTransitionAtMs <= now
        ))
        .map((entry) => entry.sceneId);
      for (const sceneId of transitionSceneIds) {
        const scene = currentProject.scenes[sceneId];
        if (!scene) continue;
        const isActive = scene.id === activeSceneId;
        const sourceElements = isActive
          ? api.getSceneElementsIncludingDeleted()
          : scene.elements as unknown as readonly ExcalidrawElement[];
        const previousAlarmDescriptors = activeClassroomTimeAlarmDescriptors(
          currentProject.id,
          sourceElements,
        );
        let runtimeChanged = false;
        const advancedElements = sourceElements.map((element) => {
          if (element.isDeleted) return element;
          const metadata = classroomTimeWidgetMetadata(element);
          if (!metadata) return element;
          const advanced = advanceExpiredClassroomTimeWidget(metadata, now);
          if (advanced.metadata === metadata || serializedValuesEqual(advanced.metadata, metadata)) return element;
          runtimeChanged = true;
          return replaceClassroomTimeMetadata(element, advanced.metadata);
        });
        if (!runtimeChanged) continue;
        const sourceFiles = isActive ? api.getFiles() : scene.files as unknown as BinaryFiles;
        const renderContext = classroomTimeRenderContext(
          advancedElements,
          nextProject.projectCalendar,
          isActive
            ? deviceClassroomCalendarRef.current
            : EMPTY_DEVICE_CLASSROOM_CALENDAR,
          now,
          editorThemeRef.current,
        );
        const reconciled = reconcileClassroomTimeWidgets(advancedElements, {
          now,
          files: sourceFiles,
          createId: createLocalId,
          renderContext,
        });
        const nextAlarmDescriptors = activeClassroomTimeAlarmDescriptors(
          currentProject.id,
          reconciled.elements,
        );
        for (const descriptor of classroomTimeAlarmDescriptorsNeedingTrustedStart(
          previousAlarmDescriptors,
          nextAlarmDescriptors,
        )) {
          const key = classroomAlarmIdentityKey(descriptor);
          const existing = autoStartDescriptorsByIdentity.get(key);
          if (existing && !classroomAlarmJobMatchesDescriptor(
            classroomAlarmJobFromDescriptor(existing),
            descriptor,
          )) {
            throw new Error("A classroom alarm identity was advanced inconsistently across project scenes.");
          }
          autoStartDescriptorsByIdentity.set(key, descriptor);
        }
        const files = mergeClassroomTimeFiles(
          sourceFiles,
          reconciled.addedFiles,
          reconciled.orphanedFileIds,
        );
        const pendingFiles = isActive
          ? persistentFilesForScene(scene, files, transientDarkPdfFileIdsRef.current)
          : files;
        const updatedProject = projectWithPendingScene(nextProject, {
          sceneId: scene.id,
          elements: reconciled.elements,
          appState: isActive ? api.getAppState() : scene.appState as unknown as AppState,
          files: pendingFiles,
          preserveDeleted: true,
        });
        if (!updatedProject) continue;
        nextProject = updatedProject;
        projectChanged = true;
        if (isActive) {
          activeUpdate = {
            elements: reconciled.elements,
            addedFiles: reconciled.addedFiles,
            orphanedFileIds: reconciled.orphanedFileIds,
          };
        }
      }

      if (projectChanged) {
        assertProjectFitsContentBudget(nextProject, pdfBytesRef.current);
        const autoStartDescriptors = [...autoStartDescriptorsByIdentity.values()];
        if (autoStartDescriptors.length) {
          const registryBeforeReservation = readClassroomAlarmRegistry();
          const blockedAutoStarts = autoStartDescriptors.filter((descriptor) => (
            registryBeforeReservation.jobs.some((job) => (
              classroomAlarmIdentityKey(job) === classroomAlarmIdentityKey(descriptor)
              && (job.deliveryState === "blocked" || job.deliveryState === "delivering")
            ))
          ));
          const blockedAutoStartKeys = new Set(
            blockedAutoStarts.map(classroomAlarmIdentityKey),
          );
          const reservableAutoStarts = autoStartDescriptors.filter((descriptor) => (
            !blockedAutoStartKeys.has(classroomAlarmIdentityKey(descriptor))
          ));
          const requestedJobs = reservableAutoStarts.map(classroomAlarmJobFromDescriptor);
          let reservationFailure: unknown = null;
          if (requestedJobs.length) {
            const expectedFence: ClassroomTimeSchedulerPublicationFence = {
              project: currentProject,
              activeSceneId,
              hydrationGeneration: sceneHydrationGenerationRef.current,
              operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
              elementFingerprint: activeSceneId
                ? classroomTimeElementFingerprint(api.getSceneElementsIncludingDeleted())
                : null,
              fileFingerprint: activeSceneId
                ? classroomTimeFileFingerprint(api.getFiles())
                : null,
            };
            try {
              const reservation = await stageSchedulerClassroomAlarmJobs(requestedJobs, now);
              if (reservation.status === "persisted" && reservation.receipt) {
                stagedSchedulerReceipt = reservation.receipt;
                trackPreparedClassroomAlarmReceipts([stagedSchedulerReceipt]);
              }
              else reservationFailure = new Error(`alarm storage returned ${reservation.status}`);
            } catch (error) {
              reservationFailure = error;
            }
            const currentActiveSceneId = hydratedSceneIdRef.current;
            const publicationIsCurrent = classroomTimeSchedulerPublicationFenceMatches(
              expectedFence,
              {
                project: projectRef.current,
                activeSceneId: currentActiveSceneId,
                hydrationGeneration: sceneHydrationGenerationRef.current,
                operationGeneration: classroomTimeAsyncOperationGenerationRef.current,
                elementFingerprint: currentActiveSceneId
                  ? classroomTimeElementFingerprint(api.getSceneElementsIncludingDeleted())
                  : null,
                fileFingerprint: currentActiveSceneId
                  ? classroomTimeFileFingerprint(api.getFiles())
                  : null,
              },
              switchingSceneRef.current
                || nativeImageExportOpenRef.current
                || classroomTimePointerActiveRef.current
                || classroomTimeGestureInProgress(api.getAppState()),
            );
            if (!publicationIsCurrent) {
              if (
                stagedSchedulerReceipt
                && !await rollbackPreparedClassroomAlarmReceipts([stagedSchedulerReceipt])
              ) {
                pausePublishedClassroomAlarmIdentities(
                  classroomAlarmIdentitiesForTransactionReceipts([stagedSchedulerReceipt]),
                );
                setErrorMessage("A superseded Pomodoro alarm could not be rolled back durably. Reload this board before relying on that timer.");
              }
              return;
            }
          }
          let phasePaused = false;
          if (reservableAutoStarts.length && !stagedSchedulerReceipt) {
            nextProject = finalizeClassroomTimeSchedulerAlarmReservation(
              nextProject,
              reservableAutoStarts,
              null,
              now,
            ).project;
            phasePaused = true;
            const detail = reservationFailure instanceof Error
              ? ` ${reservationFailure.message}`
              : "";
            setErrorMessage(`The next Pomodoro phase was paused because its alarm could not be reserved durably.${detail}`);
          }
          if (blockedAutoStarts.length) {
            const blocked = finalizeClassroomTimeSchedulerAlarmReservation(
              nextProject,
              blockedAutoStarts,
              registryBeforeReservation,
              now,
            );
            nextProject = blocked.project;
            phasePaused = true;
          }
          if (phasePaused) {
            assertProjectFitsContentBudget(nextProject, pdfBytesRef.current);
            if (activeUpdate && activeSceneId) {
              const activeScene = nextProject.scenes[activeSceneId];
              if (activeScene) {
                const materialized = materializeClassroomTimeSceneForDisplay(
                  activeScene.elements as unknown as readonly ExcalidrawElement[],
                  activeScene.files as unknown as BinaryFiles,
                  nextProject.projectCalendar,
                  deviceClassroomCalendarRef.current,
                  now,
                  createLocalId,
                  editorThemeRef.current,
                );
                const liveFiles = api.getFiles();
                activeUpdate = {
                  elements: materialized.elements,
                  addedFiles: Object.values(materialized.files).filter((file) => (
                    !serializedValuesEqual(liveFiles[file.id], file)
                  )),
                  orphanedFileIds: [...new Set([
                    ...activeUpdate.orphanedFileIds,
                    ...materialized.orphanedFileIds,
                  ])],
                };
              }
            }
          }
        }
        if (activeUpdate) {
          if (activeUpdate.addedFiles.length) api.addFiles([...activeUpdate.addedFiles]);
          for (const fileId of activeUpdate.orphanedFileIds) delete api.getFiles()[fileId];
          classroomTimeTickFenceRef.current.push({
            sceneId: activeSceneId ?? currentProject.activeSceneId,
            elementFingerprint: classroomTimeElementFingerprint(activeUpdate.elements),
            fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
          });
          if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
          api.updateScene({
            elements: activeUpdate.elements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
        stageProjectMutationForAutosave(nextProject);
        window.requestAnimationFrame(() => flushAutosave(true));
        if (
          stagedSchedulerReceipt
          && !await activatePublishedClassroomAlarmReceipts([stagedSchedulerReceipt])
        ) {
          setErrorMessage("The next Pomodoro phase was paused because its staged alarm could not be activated durably.");
        }
        stagedSchedulerReceipt = null;
        return;
      }

      // Keep the confirmation snapshot stable while the teacher reads it or
      // recovery storage is busy. Only cosmetic clock/countdown drawing is
      // suspended: alarm delivery and real timer/Pomodoro state transitions
      // above still run, and those genuine changes invalidate confirmation.
      if (boardClearDialogOpenRef.current || !activeSceneId || !schedulerIndex.scenes.has(activeSceneId)) return;
      const liveElements = api.getSceneElementsIncludingDeleted();
      const renderContext = classroomTimeRenderContext(
        liveElements,
        currentProject.projectCalendar,
        deviceClassroomCalendarRef.current,
        now,
        editorThemeRef.current,
      );
      const ticked = tickClassroomTimeWidgets(liveElements, now, renderContext);
      if (ticked === liveElements) return;
      const files = api.getFiles();
      classroomTimeTickFenceRef.current.push({
        sceneId: activeSceneId,
        elementFingerprint: classroomTimeElementFingerprint(ticked),
        fileFingerprint: classroomTimeFileFingerprint(files),
        expectedDisplayContentFingerprint: classroomTimeDisplayTickContentFingerprint(ticked),
      });
      if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
      api.updateScene({ elements: ticked, captureUpdate: CaptureUpdateAction.NEVER });
    } catch (error) {
      if (
        stagedSchedulerReceipt
        && classroomTimeStagedTransactionIdsRef.current.has(
          stagedSchedulerReceipt.transactionId,
        )
      ) {
        const identities = classroomAlarmIdentitiesForTransactionReceipts([
          stagedSchedulerReceipt,
        ]);
        if (!await rollbackPreparedClassroomAlarmReceipts([stagedSchedulerReceipt])) {
          pausePublishedClassroomAlarmIdentities(identities);
        }
      }
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      classroomTimeSchedulerRunningRef.current = false;
    }
  }, [
    activatePublishedClassroomAlarmReceipts,
    api,
    deliverClassroomAlarmBatch,
    flushAutosave,
    pausePublishedClassroomAlarmIdentities,
    rollbackPreparedClassroomAlarmReceipts,
    stageProjectMutationForAutosave,
    trackPreparedClassroomAlarmReceipts,
  ]);

  useEffect(() => {
    let timeoutId: number | null = null;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const delay = Math.max(20, 1_000 - Date.now() % 1_000);
      timeoutId = window.setTimeout(() => {
        void runClassroomTimeScheduler(Date.now()).finally(schedule);
      }, delay);
    };
    const catchUp = () => {
      if (document.visibilityState !== "hidden") void runClassroomTimeScheduler(Date.now());
    };
    schedule();
    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
    };
  }, [runClassroomTimeScheduler]);

  useEffect(() => {
    const releasePointer = () => { classroomTimePointerActiveRef.current = false; };
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);
    return () => {
      window.removeEventListener("pointerup", releasePointer, true);
      window.removeEventListener("pointercancel", releasePointer, true);
      if (classroomTimeClipboardRestoreTimerRef.current !== null) {
        window.clearTimeout(classroomTimeClipboardRestoreTimerRef.current);
      }
      classroomTimeTickFenceRef.current = [];
      classroomTimeAlarmAuthorityFenceRef.current = [];
    };
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
    const targetProject = projectRef.current;
    if (!targetProject?.scenes[sceneId]) {
      api?.setToast({ message: "That board page is no longer available." });
      return;
    }
    pendingProjectSearchTargetRef.current = null;
    commitPendingScenePersistence();
    const currentSceneId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || projectRef.current?.activeSceneId;
    const isSceneChange = sceneId !== currentSceneId;
    const needsHydration = switchingSceneRef.current
      || hydratedSceneIdRef.current !== sceneId;
    if (isSceneChange) commitLiveScenePersistence(currentSceneId || "");
    if (
      isSceneChange
      && pendingSlideFrameActionRef.current?.sceneId !== sceneId
    ) pendingSlideFrameActionRef.current = null;
    if (
      isSceneChange
      && pendingSlideRotationActionRef.current?.sceneId !== sceneId
    ) pendingSlideRotationActionRef.current = null;
    if (frameId) pendingFrameIdRef.current = frameId;
    else if (isSceneChange) pendingFrameIdRef.current = null;
    if (isSceneChange) pendingCreatedFrameIdRef.current = null;
    if (needsHydration) beginSceneHydration();
    setProject((current) => {
      if (!current) return current;
      if (!current.scenes[sceneId] || current.activeSceneId === sceneId) return current;
      const next = { ...current, activeSceneId: sceneId };
      projectRef.current = next;
      activeSceneIdRef.current = sceneId;
      return next;
    });
    // activeSceneId may already name a scene whose imperative editor load is
    // still in flight. A monotonic revision guarantees the layout-effect
    // loader reruns for repeated B→B clicks and batched A→B→A intent.
    if (needsHydration) setProjectHydrationRevision((revision) => revision + 1);
    if (api && sceneId === currentSceneId && frameId) {
      focusSlide(api, frameId);
      pendingFrameIdRef.current = null;
    }
  }, [api, beginSceneHydration, commitLiveScenePersistence, commitPendingScenePersistence]);

  const openSlide = useCallback((slide: ClassroomSlide) => {
    setActiveSlideId(slide.id);
    openScene(slide.sceneId, slide.frameId);
  }, [openScene]);

  const openSlideRotationDialog = useCallback((
    slide: ClassroomSlide,
    returnFocusTarget: HTMLButtonElement | null,
  ) => {
    pendingSlideRotationActionRef.current = null;
    slideRotationReturnFocusRef.current = returnFocusTarget;
    setSlideRotationTargetId(slide.id);
    openSlide(slide);
  }, [openSlide]);

  const cancelSlideRotation = useCallback(() => {
    pendingSlideRotationActionRef.current = null;
    setSlideRotationTargetId(null);
  }, []);

  const applySlideRotation = useCallback((degrees: number) => {
    const currentProject = commitPendingScenePersistence() || projectRef.current;
    const slide = currentProject?.slideOrder.find(
      (candidate) => candidate.id === slideRotationTargetId,
    );
    setSlideRotationTargetId(null);
    if (!slide) {
      api?.setToast({ message: "That slide is no longer available." });
      return;
    }

    const action: PendingSlideRotationAction = {
      degrees,
      frameId: slide.frameId,
      sceneId: slide.sceneId,
      slideId: slide.id,
      title: slide.title,
    };
    pendingSlideRotationActionRef.current = action;
    setActiveSlideId(slide.id);

    if (currentProject?.activeSceneId !== slide.sceneId) {
      openScene(slide.sceneId, slide.frameId);
      return;
    }
    if (runSlideRotationAction(action)) {
      pendingSlideRotationActionRef.current = null;
      return;
    }

    // A very fast submit can land during the two-paint scene hydration fence.
    // Keep the action pending and retry briefly even if the normal hydration
    // callback has just completed between the readiness check and this turn.
    const retryWhenStable = (remainingFrames: number) => {
      if (pendingSlideRotationActionRef.current !== action) return;
      if (runSlideRotationAction(action)) {
        pendingSlideRotationActionRef.current = null;
        return;
      }
      if (remainingFrames > 0) {
        window.requestAnimationFrame(() => retryWhenStable(remainingFrames - 1));
        return;
      }
      pendingSlideRotationActionRef.current = null;
      api?.setToast({ message: "The slide was still loading. Try Rotate slide again." });
    };
    window.requestAnimationFrame(() => retryWhenStable(4));
  }, [api, commitPendingScenePersistence, openScene, runSlideRotationAction, slideRotationTargetId]);

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
    window.requestAnimationFrame(() => {
      const focusTarget = pdfRailShowButtonRef.current
        || shellRef.current?.querySelector<HTMLButtonElement>(".pdf-rail-show");
      focusTarget?.focus();
    });
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

  const rememberCurrentPdfZoom = useCallback(() => {
    if (!api || !currentSceneRef.current?.pdfPage) return;
    pdfSharedZoomRef.current = normalizeSharedPdfZoom(api.getAppState().zoom.value);
  }, [api]);

  const openPdfPageFromRail = useCallback((sceneId: string) => {
    rememberCurrentPdfZoom();
    openScene(sceneId);
    if (window.matchMedia("(max-width: 640px)").matches) hidePdfRail();
  }, [hidePdfRail, openScene, rememberCurrentPdfZoom]);

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
    if (!currentProject.scenes[slide.sceneId]) {
      api?.setToast({ message: "That slide page is no longer available." });
      return;
    }
    const reducedMotion = prefersReducedMotion();
    pendingPresentationTransitionRef.current = {
      frameId: slide.frameId,
      animate: allowMorph && currentProject.slideMorphEnabled === true && !reducedMotion,
      durationMs: normalizeSlideMorphDurationMs(currentProject.slideMorphDurationMs),
    };
    setPresentation((current) => ({
      kind: "slides",
      index,
      tool: current?.tool || "laser",
      inkColour: current?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: current?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
    }));
    setActiveSlideId(slide.id);
    const currentSceneId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || projectRef.current?.activeSceneId;
    const isSceneChange = slide.sceneId !== currentSceneId;
    const needsHydration = switchingSceneRef.current
      || hydratedSceneIdRef.current !== slide.sceneId;
    if (isSceneChange) {
      // A delayed presentation-ink promotion (or any other Excalidraw
      // onChange) can still be pending when navigation starts. Capture the
      // live outgoing scene before hydration invalidates its RAF generation.
      commitLiveScenePersistence(currentSceneId || "");
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      if (pendingSlideFrameActionRef.current?.sceneId !== slide.sceneId) {
        pendingSlideFrameActionRef.current = null;
      }
    }
    if (needsHydration) beginSceneHydration();
    setProject((current) => {
      if (!current || current.activeSceneId === slide.sceneId) return current;
      const next = { ...current, activeSceneId: slide.sceneId };
      projectRef.current = next;
      activeSceneIdRef.current = slide.sceneId;
      return next;
    });
    if (needsHydration) setProjectHydrationRevision((revision) => revision + 1);
  }, [api, beginSceneHydration, commitLiveScenePersistence, commitPendingScenePersistence]);

  const setPdfPresentationIndex = useCallback((index: number) => {
    rememberCurrentPdfZoom();
    const currentProject = commitPendingScenePersistence();
    const page = currentProject ? orderedPdfScenes(currentProject)[index] : null;
    if (!currentProject || !page?.pdfPage) {
      api?.setToast({ message: "That PDF page is no longer available." });
      return;
    }
    pendingPresentationTransitionRef.current = null;
    setPresentation((current) => ({
      kind: "pdf",
      index,
      tool: current?.tool || "laser",
      inkColour: current?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: current?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
    }));
    setActiveSlideId(null);
    const currentSceneId = hydratedSceneIdRef.current
      || activeSceneIdRef.current
      || currentProject.activeSceneId;
    if (page.id !== currentSceneId) openScene(page.id);
  }, [api, commitPendingScenePersistence, openScene, rememberCurrentPdfZoom]);

  const startPresentation = useCallback(async (returnFocusTarget?: HTMLElement | null) => {
    if (!project || !api || (workspaceMode !== "slides" && workspaceMode !== "pdf")) return;
    const isPdfPresentation = workspaceMode === "pdf";
    const pdfPresentationPages = isPdfPresentation ? orderedPdfScenes(project) : [];
    if (!isPdfPresentation && !project.slideOrder.length) {
      api.setToast({ message: "Add a slide first; each frame becomes a slide." });
      return;
    }
    if (isPdfPresentation && !pdfPresentationPages.length) {
      api.setToast({ message: "Open a PDF first; each PDF page can be presented." });
      return;
    }
    if (presentationFocusRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationFocusRestoreFrameRef.current);
      presentationFocusRestoreFrameRef.current = null;
    }
    presentationReturnFocusRef.current = returnFocusTarget
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    presentationReturnFocusWasTriggerRef.current = (
      presentationReturnFocusRef.current === presentationTriggerRef.current
      || presentationReturnFocusRef.current?.matches(".present-button") === true
    );
    presentationInkGenerationRef.current += 1;
    presentationInkStartElementIdsRef.current = null;
    if (presentationInkFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationInkFrameRef.current);
      presentationInkFrameRef.current = null;
    }
    const index = Math.max(0, isPdfPresentation
      ? pdfPresentationPages.findIndex((page) => page.id === project.activeSceneId)
      : project.slideOrder.findIndex((slide) => slide.id === activeSlideId));
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
    api.updateFrameRendering(isPdfPresentation
      ? { enabled: false, outline: false, name: false, clip: false }
      : { enabled: true, outline: false, name: false, clip: true });
    api.setActiveTool({ type: "laser" });
    const selectedPresentationCandidate = selectedClassroomTime && hydratedSceneIdRef.current
      ? {
          ...selectedClassroomTime,
          projectId: project.id,
          sceneId: hydratedSceneIdRef.current,
        }
      : null;
    const rememberedClassroomTimeSelection = presentationClassroomTimeSelectionForLiveScene(
      selectedPresentationCandidate,
      api.getSceneElements(),
      {
        activeSceneId: project.activeSceneId,
        hydratedSceneId: hydratedSceneIdRef.current,
        projectId: project.id,
        switching: switchingSceneRef.current,
      },
    );
    try {
      if (isPdfPresentation) setPdfPresentationIndex(index);
      else setPresentationIndex(index, false);
      setPresentationClassroomTimeSelection(rememberedClassroomTimeSelection);
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
      setPresentationClassroomTimeSelection(null);
      presentationReturnFocusRef.current = null;
      presentationReturnFocusWasTriggerRef.current = false;
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
  }, [activeSlideId, api, project, selectedClassroomTime, setPdfPresentationIndex, setPresentationIndex, workspaceMode]);

  const presentationSlide = presentation?.kind === "slides" && project
    ? project.slideOrder[presentation.index]
    : null;
  const presentationPdfScene = presentation?.kind === "pdf" && project
    ? orderedPdfScenes(project)[presentation.index]
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
    const returnFocusTarget = presentationReturnFocusRef.current;
    const returnFocusWasTrigger = presentationReturnFocusWasTriggerRef.current;
    const stoppedPresentationKind = presentationRef.current?.kind;
    presentationReturnFocusRef.current = null;
    presentationReturnFocusWasTriggerRef.current = false;
    presentationRef.current = null;
    setPresentation(null);
    setPresentationClassroomTimeSelection(null);
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
    if (returnFocusTarget) {
      if (presentationFocusRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(presentationFocusRestoreFrameRef.current);
      }
      presentationFocusRestoreFrameRef.current = window.requestAnimationFrame(() => {
        presentationFocusRestoreFrameRef.current = null;
        if (presentationRef.current) return;
        const connectedReturnTarget = returnFocusTarget.isConnected
          && returnFocusTarget.getClientRects().length > 0
          ? returnFocusTarget
          : null;
        const replacementTrigger = returnFocusWasTrigger
          && stoppedPresentationKind === workspaceModeRef.current
          ? presentationTriggerRef.current?.getClientRects().length
            ? presentationTriggerRef.current
            : shellRef.current?.querySelector<HTMLButtonElement>(".present-button") || null
          : null;
        const focusTarget = connectedReturnTarget
          || replacementTrigger
          || editorHostRef.current?.querySelector<HTMLElement>(".excalidraw");
        focusTarget?.focus({ preventScroll: true });
      });
    }
  }, [api]);

  stopPresentationRef.current = stopPresentation;

  useEffect(() => () => {
    if (presentationFocusRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(presentationFocusRestoreFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!presentation) return;
    if (
      (presentation.kind === "slides" && (workspaceMode !== "slides" || !presentationSlide))
      || (presentation.kind === "pdf" && (workspaceMode !== "pdf" || !presentationPdfScene))
    ) stopPresentation();
  }, [presentation, presentationPdfScene, presentationSlide, stopPresentation, workspaceMode]);

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

  useEffect(() => {
    if (!featurePreferences.obsCaptureArea || !api || presentation) return;
    nativeImageExportRequestGenerationRef.current += 1;
    nativeImageExportOpenRef.current = false;
    pendingProjectSearchTargetRef.current = null;
    resetTransientPointerTools();
    if (slideFrameDrawingActiveRef.current) stopSlideFrameDrawing();
    setExportOpen(false);
    setPendingVisualPdfFallback(null);
    setPendingPdfAnnotationClear(null);
    pendingSlideRotationActionRef.current = null;
    setSlideRotationTargetId(null);
    setEquationEditor(null);
    setMermaidEditor(null);
    setIsMathToolsOpen(false);
    setIsGeoGonOpen(false);
    setMathToolEdit(null);
    setMathInteraction(null);
    setIsScreenshotCaptureActive(false);
    setIsProjectFindOpen(false);
    setIsSizePositionOpen(false);
    setIsLibraryOpen(false);
    libraryOpenRef.current = false;
    const appState = api.getAppState();
    api.updateScene({
      appState: {
        editingFrame: null,
        editingGroupId: null,
        openDialog: null,
        openSidebar: null,
        selectedElementIds: {},
        selectedGroupIds: {},
        stats: { ...appState.stats, open: false },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const refreshFrame = window.requestAnimationFrame(() => {
      api.refresh();
      editorHostRef.current?.querySelector<HTMLElement>(".excalidraw")?.focus();
    });
    return () => window.cancelAnimationFrame(refreshFrame);
  }, [
    api,
    featurePreferences.obsCaptureArea,
    presentation,
    resetTransientPointerTools,
    stopSlideFrameDrawing,
  ]);

  useEffect(() => {
    if (!featurePreferences.obsCaptureArea || !api) return;
    let focusFrame = 0;
    const refreshFrame = window.requestAnimationFrame(() => {
      api.refresh();
      if (workspaceMode !== "slides" || !activeSlideId) return;
      const slide = project?.slideOrder.find((candidate) => candidate.id === activeSlideId);
      if (!project || !slide || slide.sceneId !== project.activeSceneId) return;
      focusFrame = window.requestAnimationFrame(() => focusSlide(api, slide.frameId, false));
    });
    return () => {
      window.cancelAnimationFrame(refreshFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [
    activeSlideId,
    api,
    featurePreferences.obsCaptureArea,
    isFullscreen,
    project?.activeSceneId,
    project?.slideOrder,
    workspaceMode,
  ]);

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

  const exitCleanFullscreen = useCallback(async () => {
    isCleanFullscreenRef.current = false;
    setIsCleanFullscreen(false);
    if (fullscreenIntentRef.current?.kind === "clean") {
      fullscreenIntentRef.current = null;
    }
    if (document.fullscreenElement === shellRef.current) {
      try {
        await document.exitFullscreen();
      } catch {
        // The browser can finish a native Escape before this promise runs.
      }
    }
    window.requestAnimationFrame(() => api?.refresh());
  }, [api]);

  const enterCleanFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell || presentationRef.current || hasVisibleModalSurface()) return;

    isCleanFullscreenRef.current = true;
    setIsCleanFullscreen(true);
    pendingProjectSearchTargetRef.current = null;
    resetTransientPointerTools();
    setExportOpen(false);
    setIsProjectFindOpen(false);
    setIsSizePositionOpen(false);
    setIsLibraryOpen(false);
    libraryOpenRef.current = false;
    const appState = api?.getAppState();
    if (api && appState) {
      api.updateScene({
        appState: {
          editingFrame: null,
          editingGroupId: null,
          openDialog: null,
          openSidebar: null,
          selectedElementIds: {},
          selectedGroupIds: {},
          stats: { ...appState.stats, open: false },
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    window.requestAnimationFrame(() => api?.refresh());

    const intent = { kind: "clean" as const, entered: false };
    fullscreenIntentRef.current = intent;
    if (document.fullscreenElement === shell) {
      intent.entered = true;
      return;
    }
    try {
      await shell.requestFullscreen();
      intent.entered = document.fullscreenElement === shell;
      if (fullscreenIntentRef.current === null && document.fullscreenElement === shell) {
        await document.exitFullscreen();
      }
    } catch {
      if (fullscreenIntentRef.current === intent) fullscreenIntentRef.current = null;
      // Keep the chrome-free in-window mode available when native fullscreen
      // is blocked. The same shortcut or Escape still restores the workspace.
    }
  }, [api, resetTransientPointerTools]);

  const toggleCleanFullscreen = useCallback(() => {
    if (isCleanFullscreenRef.current) {
      void exitCleanFullscreen();
    } else {
      void enterCleanFullscreen();
    }
  }, [enterCleanFullscreen, exitCleanFullscreen]);

  useEffect(() => {
    if (!isCleanFullscreen) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      void exitCleanFullscreen();
    };
    window.addEventListener("keydown", exitOnEscape, true);
    return () => window.removeEventListener("keydown", exitOnEscape, true);
  }, [exitCleanFullscreen, isCleanFullscreen]);

  useLayoutEffect(() => {
    if (!api) return;
    const frame = window.requestAnimationFrame(() => api.refresh());
    return () => window.cancelAnimationFrame(frame);
  }, [api, isCleanFullscreen]);

  useEffect(() => {
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (event.repeat || (!event.ctrlKey && !event.metaKey)) return;
      const key = event.key.toLowerCase();
      const cleanFullscreenShortcut = event.shiftKey && !event.altKey && event.key === "Enter";
      const saveShortcut = !event.shiftKey && !event.altKey && key === "s";
      const openShortcut = !event.shiftKey && !event.altKey && key === "o";
      const presentationShortcut = event.altKey && !event.shiftKey && event.key === "Enter";
      if (!cleanFullscreenShortcut && !saveShortcut && !openShortcut && !presentationShortcut) return;
      if (isEditableKeyboardTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (hasVisibleModalSurface()) return;

      if (cleanFullscreenShortcut) {
        toggleCleanFullscreen();
      } else if (saveShortcut) {
        void saveProjectFile();
      } else if (openShortcut) {
        inputRef.current?.click();
      } else if (
        presentationShortcut
        && (workspaceMode === "slides" || workspaceMode === "pdf")
        && !presentationRef.current
      ) {
        if (isCleanFullscreenRef.current) {
          void exitCleanFullscreen().then(() => startPresentation());
        } else {
          void startPresentation();
        }
      }
    };
    window.addEventListener("keydown", handleAppShortcut, true);
    return () => window.removeEventListener("keydown", handleAppShortcut, true);
  }, [exitCleanFullscreen, saveProjectFile, startPresentation, toggleCleanFullscreen, workspaceMode]);

  const clickEditorControl = useCallback((selector: string) => {
    const control = editorHostRef.current?.querySelector<HTMLButtonElement>(selector);
    if (control && !control.disabled) control.click();
  }, []);

  const setPresentationTool = useCallback((tool: PresentationTool) => {
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
      api.setActiveTool({ type: tool });
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
      api.setActiveTool({ type: presentation.tool });
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
    const dataTransferTypes = Array.from(event.dataTransfer.types);
    const hasScreenshotDragType = dataTransferTypes.includes(SCREENSHOT_DRAG_MIME);
    const file = event.dataTransfer.files?.[0];
    const allowNativeLibraryDrop = shouldAllowNativePersonalLibraryCanvasDrop(
      nativePersonalLibraryDragRef.current,
      dataTransferTypes,
      !!file,
    );
    nativePersonalLibraryDragRef.current = false;
    if (allowNativeLibraryDrop) return;
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
      const libraryPayload = event.dataTransfer.getData(EXCALIDRAW_LIBRARY_MIME);
      if (!libraryPayload) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      const libraryFile = new File(
        [libraryPayload],
        "dropped-library.excalidrawlib",
        { type: EXCALIDRAW_LIBRARY_MIME },
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
      || file.type === EXCALIDRAW_LIBRARY_MIME;
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

  const handleEditorDragStartCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    nativePersonalLibraryDragRef.current = !!target?.closest(
      ".layer-ui__library .library-unit__dragger",
    );
  }, []);

  const handleEditorDragEndCapture = useCallback(() => {
    nativePersonalLibraryDragRef.current = false;
  }, []);

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
      if (isEditableKeyboardTarget(event.target)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(
        'button, [role="dialog"], [role="menu"], [role="listbox"], [role="separator"], .busy-overlay',
      )) return;
      const nextIndex = pageIndex + (event.key === "ArrowLeft" ? -1 : 1);
      const nextPage = pdfScenes[nextIndex];
      if (!nextPage) return;
      event.preventDefault();
      rememberCurrentPdfZoom();
      openScene(nextPage.id);
    };
    window.addEventListener("keydown", navigatePdfWithArrowKeys, true);
    return () => window.removeEventListener("keydown", navigatePdfWithArrowKeys, true);
  }, [openScene, pageIndex, pdfScenes, presentation, rememberCurrentPdfZoom, workspaceMode]);

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
          if (!background) return;
          const rememberedZoom = pdfSharedZoomRef.current;
          if (rememberedZoom === null) {
            api.scrollToContent(background, { animate: false });
            pdfSharedZoomRef.current = normalizeSharedPdfZoom(api.getAppState().zoom.value);
            return;
          }
          const appState = api.getAppState();
          const viewport = centeredPdfViewport(
            background,
            appState.width,
            appState.height,
            rememberedZoom,
          );
          api.updateScene({
            appState: {
              scrollX: viewport.scrollX,
              scrollY: viewport.scrollY,
              zoom: { value: viewport.zoom as AppState["zoom"]["value"] },
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        });
      });
    };
    centerPage();
    const observedHost = editorHostRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(centerPage);
    if (observedHost) resizeObserver?.observe(observedHost);
    window.addEventListener("resize", centerPage);
    return () => {
      resizeObserver?.disconnect();
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
    if (mode !== "slides") {
      pendingSlideFrameActionRef.current = null;
      pendingSlideRotationActionRef.current = null;
      setSlideRotationTargetId(null);
    }
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

  const toggleSlideQuickDraw = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    const enabled = current.slideQuickDrawEnabled !== true;
    const next = {
      ...current,
      updatedAt: nowIso(),
      slideQuickDrawEnabled: enabled,
    };
    slideQuickDrawEnabledRef.current = enabled;
    projectRef.current = next;
    setProject(next);
    if (!enabled && slideFrameDrawingActiveRef.current) stopSlideFrameDrawing();
  }, [stopSlideFrameDrawing]);

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
      if (deletingActiveSlide && nextSlide) {
        openSlide(nextSlide);
        return;
      }
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
    void (async () => {
      try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const currentProject = commitLiveScenePersistence(pending.sceneId, true);
      if (!currentProject || currentProject.id !== pending.projectId) {
        throw new Error("The PDF document changed before annotations could be cleared.");
      }
      const operationFence = beginClassroomTimeAsyncOperation();
      if (!operationFence) return;
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
      const cancelledAlarmIdentities = removedClassroomTimeAlarmIdentities(
        currentProject,
        cleared.project,
      );
      let cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null = null;
      if (cancelledAlarmIdentities.length) {
        const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
          cancelledAlarmIdentities,
          now,
        );
        if (cancellation.status !== "persisted" || !cancellation.receipt) {
          throw new Error("Annotations could not be cleared because their alarms could not be cancelled durably.");
        }
        cancellationReceipt = cancellation.receipt;
      }
      if (!isCurrentClassroomTimeAsyncOperation(operationFence)) {
        if (cancelledAlarmIdentities.length) pauseUnauthorizedLiveClassroomTimeWidgets();
        setErrorMessage("Annotations changed while alarm cancellation was pending. Nothing was cleared; review the page and try again.");
        return;
      }
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
        cancelledAlarmIdentities,
        cancellationReceipt,
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
    })();
  }, [
    abortSceneOperations,
    beginClassroomTimeAsyncOperation,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    isCurrentClassroomTimeAsyncOperation,
    loadSceneIntoEditor,
    pauseUnauthorizedLiveClassroomTimeWidgets,
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
    void (async () => {
      let undoPublished = false;
      let stagedUndoAlarmReceipt: ClassroomAlarmTransactionReceiptV1 | null = null;
      const rollbackStagedUndoAlarm = async (
        receipt: ClassroomAlarmTransactionReceiptV1,
      ) => {
        try {
          return await rollbackPreparedClassroomAlarmReceipts(
            [receipt],
            (_transactionReceipt, refreshedCancellationReceipt) => {
              if (
                pendingPdfUndoRef.current === pending
                && Date.now() < pending.transaction.expiresAt
              ) {
                pendingPdfUndoRef.current = {
                  ...pending,
                  cancellationReceipt: refreshedCancellationReceipt,
                };
              }
            },
          );
        } finally {
          if (stagedUndoAlarmReceipt?.transactionId === receipt.transactionId) {
            stagedUndoAlarmReceipt = null;
          }
        }
      };
      try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      const activeSceneId = activeSceneIdRef.current
        || projectRef.current?.activeSceneId
        || "";
      const currentProject = commitLiveScenePersistence(activeSceneId, true);
      if (!currentProject) throw new Error("The current project is unavailable.");
      const operationFence = beginClassroomTimeAsyncOperation();
      if (!operationFence) return;
      const undoIsCurrent = () => (
        pendingPdfUndoRef.current === pending
        && Date.now() < pending.transaction.expiresAt
        && isCurrentClassroomTimeAsyncOperation(operationFence)
      );
      if (pending.kind === "delete-page" || pending.kind === "delete-pages") {
        const isBatchDelete = pending.kind === "delete-pages";
        const restored = isBatchDelete
          ? undoPdfPageBatchDelete(
            currentProject,
            pdfBytesRef.current,
            pending.transaction,
            { now, updatedAt: nowIso() },
          )
          : undoPdfPageDelete(
            currentProject,
            pdfBytesRef.current,
            pending.transaction,
            { now, updatedAt: nowIso() },
          );
        if (getProjectContentSize(restored.project, restored.pdfBytes).totalBytes > MAX_PROJECT_BYTES) {
          setErrorMessage(
            `The deleted ${isBatchDelete ? "pages" : "page"} could not be restored because the project is now too large to save safely. Remove recently added content and try Undo again before it expires.`,
          );
          return;
        }
        const cancelledAlarmJobs = pending.cancellationReceipt?.cancelledJobs ?? [];
        if (cancelledAlarmJobs.length && pending.cancellationReceipt) {
          const alarmRestore = await stageCancelledClassroomAlarmReceipt(
            pending.cancellationReceipt,
            now,
          );
          if (alarmRestore.status !== "persisted" || !alarmRestore.receipt) {
            finalizePendingPdfUndo();
            setErrorMessage(`The deleted ${isBatchDelete ? "pages" : "page"} could not be restored because their alarms could not be restored durably.`);
            return;
          }
          stagedUndoAlarmReceipt = alarmRestore.receipt;
          trackPreparedClassroomAlarmReceipts([stagedUndoAlarmReceipt]);
        }
        if (!undoIsCurrent()) {
          if (stagedUndoAlarmReceipt) {
            if (!await rollbackStagedUndoAlarm(stagedUndoAlarmReceipt)) {
              finalizePendingPdfUndo();
              setErrorMessage("The deleted-page Undo expired because its staged alarm could not be rolled back durably.");
            }
          }
          return;
        }
        const restoredJobKeys = new Set(cancelledAlarmJobs.map((job) => (
          `${job.sourceProjectId}:${job.ownerId}:${job.target}`
        )));
        const restoredProject = pauseClassroomAlarmIdentitiesInProject(
          restored.project,
          pending.cancelledAlarmIdentities.filter((identity) => !restoredJobKeys.has(
            `${identity.sourceProjectId}:${identity.ownerId}:${identity.target}`,
          )),
          now,
        );
        const activeSceneWillChange = restoredProject.activeSceneId !== currentProject.activeSceneId;
        finalizePendingPdfUndo();
        setErrorMessage(null);
        pendingProjectSearchTargetRef.current = null;
        if (activeSceneWillChange) beginSceneHydration();
        pdfBytesRef.current = restored.pdfBytes;
        projectRef.current = restoredProject;
        activeSceneIdRef.current = restoredProject.activeSceneId;
        setPdfBytes(restored.pdfBytes);
        setProject(restoredProject);
        setWorkspaceMode("pdf");
        undoPublished = true;
        if (
          stagedUndoAlarmReceipt
          && !await activatePublishedClassroomAlarmReceipts([stagedUndoAlarmReceipt])
        ) {
          setErrorMessage(`The ${isBatchDelete ? "pages were" : "page was"} restored, but their classroom timers were paused because alarm activation failed.`);
        }
        stagedUndoAlarmReceipt = null;
        return;
      }
      const restored = undoPdfAnnotationClear(currentProject, pending.transaction, {
        now,
        updatedAt: nowIso(),
      });
      const activeSceneWasRestored = restored.affectedPageIds.includes(activeSceneId);

      if (!pdfAnnotationUndoFitsContentBudget(restored.project, pdfBytesRef.current)) {
        setErrorMessage(
          "Annotations could not be restored because the project is now too large to save safely. Remove recently added content and try Undo again before it expires.",
        );
        return;
      }

      const cancelledAlarmJobs = pending.cancellationReceipt?.cancelledJobs ?? [];
      if (cancelledAlarmJobs.length && pending.cancellationReceipt) {
        const alarmRestore = await stageCancelledClassroomAlarmReceipt(
          pending.cancellationReceipt,
          now,
        );
        if (alarmRestore.status !== "persisted" || !alarmRestore.receipt) {
          finalizePendingPdfUndo();
          setErrorMessage("Annotations could not be restored because their alarms could not be restored durably.");
          return;
        }
        stagedUndoAlarmReceipt = alarmRestore.receipt;
        trackPreparedClassroomAlarmReceipts([stagedUndoAlarmReceipt]);
      }
      if (!undoIsCurrent()) {
        if (stagedUndoAlarmReceipt) {
          if (!await rollbackStagedUndoAlarm(stagedUndoAlarmReceipt)) {
            finalizePendingPdfUndo();
            setErrorMessage("Annotation Undo expired because its staged alarm could not be rolled back durably.");
          }
        }
        return;
      }
      const restoredJobKeys = new Set(cancelledAlarmJobs.map((job) => (
        `${job.sourceProjectId}:${job.ownerId}:${job.target}`
      )));
      const restoredProject = pauseClassroomAlarmIdentitiesInProject(
        restored.project,
        pending.cancelledAlarmIdentities.filter((identity) => !restoredJobKeys.has(
          `${identity.sourceProjectId}:${identity.ownerId}:${identity.target}`,
        )),
        now,
      );
      const activeScene = restoredProject.scenes[activeSceneId];

      finalizePendingPdfUndo();
      setErrorMessage(null);
      pendingProjectSearchTargetRef.current = null;
      projectRef.current = restoredProject;
      activeSceneIdRef.current = restoredProject.activeSceneId;
      setProject(restoredProject);
      if (activeSceneWasRestored && activeScene) loadSceneIntoEditor(activeScene);
      undoPublished = true;
      if (
        stagedUndoAlarmReceipt
        && !await activatePublishedClassroomAlarmReceipts([stagedUndoAlarmReceipt])
      ) {
        setErrorMessage("Annotations were restored, but their classroom timers were paused because alarm activation failed.");
      }
      stagedUndoAlarmReceipt = null;
      } catch (error) {
        if (!undoPublished && stagedUndoAlarmReceipt) {
          if (!await rollbackStagedUndoAlarm(stagedUndoAlarmReceipt)) {
            finalizePendingPdfUndo();
          }
        }
        if (undoPublished && pendingPdfUndoRef.current === pending) finalizePendingPdfUndo();
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [
    abortSceneOperations,
    activatePublishedClassroomAlarmReceipts,
    beginClassroomTimeAsyncOperation,
    beginSceneHydration,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    isCurrentClassroomTimeAsyncOperation,
    loadSceneIntoEditor,
    rollbackPreparedClassroomAlarmReceipts,
    trackPreparedClassroomAlarmReceipts,
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
    void (async () => {
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
      await inspectLocalProjectRasterUsage(duplicated.project, {
        rasterBudget: getBrowserPdfRasterBudget(),
      });
      await assertPdfAdditionPreservesPendingUndoRaster(
        duplicated.project,
        duplicated.pdfBytes,
        pendingPdfUndoRef.current,
      );
      const latestProject = commitLiveScenePersistence(sceneId, true);
      if (latestProject !== currentProject) {
        throw new Error("The PDF page changed while it was being duplicated. Review the page and try again.");
      }
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
    })();
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
    void (async () => {
      try {
      abortSceneOperations(true);
      cancelFileOpenOperations(true);
      // Capture the newest live stroke and retained tombstones before the
      // scene leaves the project map and becomes the memory-only undo record.
      const currentProject = commitLiveScenePersistence(sceneId, true);
      if (!currentProject) throw new Error("The current project is unavailable.");
      const operationFence = beginClassroomTimeAsyncOperation();
      if (!operationFence) return;
      const deleted = deletePdfPageReversibly(
        currentProject,
        pdfBytesRef.current,
        sceneId,
        { updatedAt: nowIso() },
      );
      const cancelledAlarmIdentities = removedClassroomTimeAlarmIdentities(
        currentProject,
        deleted.project,
      );
      let cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null = null;
      if (cancelledAlarmIdentities.length) {
        const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
          cancelledAlarmIdentities,
          Date.now(),
        );
        if (cancellation.status !== "persisted" || !cancellation.receipt) {
          throw new Error("The page could not be deleted because its alarms could not be cancelled durably.");
        }
        cancellationReceipt = cancellation.receipt;
      }
      if (!isCurrentClassroomTimeAsyncOperation(operationFence)) {
        if (cancelledAlarmIdentities.length) pauseUnauthorizedLiveClassroomTimeWidgets();
        setErrorMessage("The page changed while alarm cancellation was pending. Nothing was deleted; review the page and try again.");
        return;
      }
      // Failed validation or a cancelled confirmation must not consume the
      // previous Undo. Replace it only after the deletion candidate exists.
      finalizePendingPdfUndo();
      const token = ++pdfUndoTokenRef.current;
      pendingPdfUndoRef.current = {
        kind: "delete-page",
        token,
        transaction: deleted.transaction,
        cancelledAlarmIdentities,
        cancellationReceipt,
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
    })();
  }, [
    abortSceneOperations,
    beginSceneHydration,
    beginClassroomTimeAsyncOperation,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    isCurrentClassroomTimeAsyncOperation,
    pauseUnauthorizedLiveClassroomTimeWidgets,
  ]);

  const deletePdfPages = useCallback((sceneIds: readonly string[]): boolean => {
    const initialProject = projectRef.current;
    const selected = new Set(sceneIds);
    if (
      !initialProject
      || selected.size === 0
      || selected.size !== sceneIds.length
      || sceneIds.some((sceneId) => !initialProject.scenes[sceneId]?.pdfPage)
    ) return false;
    const selectedInOutputOrder = reconcilePdfPageOrder(initialProject)
      .filter((sceneId) => selected.has(sceneId));
    if (selectedInOutputOrder.length !== selected.size) return false;
    if (!window.confirm(
      `Remove ${selected.size} selected PDF ${selected.size === 1 ? "page" : "pages"}? This also removes their annotations. You can undo the whole removal for ten seconds.`,
    )) return false;

    void (async () => {
      try {
        abortSceneOperations(true);
        cancelFileOpenOperations(true);
        const activeSceneId = activeSceneIdRef.current
          || projectRef.current?.activeSceneId
          || "";
        const currentProject = commitLiveScenePersistence(activeSceneId, true);
        if (!currentProject) throw new Error("The current project is unavailable.");
        const operationFence = beginClassroomTimeAsyncOperation();
        if (!operationFence) return;
        const deleted = deletePdfPagesReversibly(
          currentProject,
          pdfBytesRef.current,
          selectedInOutputOrder,
          { updatedAt: nowIso() },
        );
        const cancelledAlarmIdentities = removedClassroomTimeAlarmIdentities(
          currentProject,
          deleted.project,
        );
        let cancellationReceipt: ClassroomAlarmCancellationReceiptV1 | null = null;
        if (cancelledAlarmIdentities.length) {
          const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
            cancelledAlarmIdentities,
            Date.now(),
          );
          if (cancellation.status !== "persisted" || !cancellation.receipt) {
            throw new Error("The pages could not be removed because their alarms could not be cancelled durably.");
          }
          cancellationReceipt = cancellation.receipt;
        }
        if (!isCurrentClassroomTimeAsyncOperation(operationFence)) {
          if (cancelledAlarmIdentities.length) pauseUnauthorizedLiveClassroomTimeWidgets();
          setErrorMessage("The pages changed while alarm cancellation was pending. Nothing was removed; review the pages and try again.");
          return;
        }

        finalizePendingPdfUndo();
        const token = ++pdfUndoTokenRef.current;
        pendingPdfUndoRef.current = {
          kind: "delete-pages",
          token,
          transaction: deleted.transaction,
          cancelledAlarmIdentities,
          cancellationReceipt,
        };
        pdfUndoTimerRef.current = window.setTimeout(() => {
          if (pendingPdfUndoRef.current?.token === token) finalizePendingPdfUndo();
        }, Math.max(0, deleted.transaction.expiresAt - Date.now()));
        setPdfUndoToast({
          kind: "delete-pages",
          token,
          deletedPageNumbers: deleted.deletedPageNumbers,
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
    })();
    return true;
  }, [
    abortSceneOperations,
    beginSceneHydration,
    beginClassroomTimeAsyncOperation,
    cancelFileOpenOperations,
    commitLiveScenePersistence,
    finalizePendingPdfUndo,
    isCurrentClassroomTimeAsyncOperation,
    pauseUnauthorizedLiveClassroomTimeWidgets,
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
      const rasterBudget = getBrowserPdfRasterBudget();
      const sourceRasterUsage = await inspectLocalProjectRasterUsage(sourceProject, {
        rasterBudget,
        signal: operation.signal,
      });
      if (!isCurrentOperation()) return;
      const remainingRaster = remainingLocalProjectRasterCapacity(
        sourceRasterUsage,
        rasterBudget,
      );
      if (remainingRaster.pixels < 1 || remainingRaster.encodedBytes < 1) {
        throw new Error("This project has no remaining image capacity for another PDF page.");
      }
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
      const maxEncodedBytesPerDocument = Math.min(
        remainingRaster.encodedBytes,
        Math.max(
          0,
          Math.floor((MAX_PROJECT_BYTES - sourceSize.totalBytes - blankPdf.size) * 3 / 4),
        ),
      );
      const imported = await importPdf(blankPdf, {
        maxEncodedBytesPerDocument,
        maxPages: remainingProjectPdfPageCapacity(sourceProject),
        maxRasterPixelsForImport: remainingRaster.pixels,
        onProgress: (progress) => {
          if (isCurrentOperation()) setBusyMessage(pdfOperationProgressMessage(progress));
        },
        rasterBudget,
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
      const baseManifestHash = autosaveManifestHash(current);
      const basePdfBytes = pdfBytesRef.current;
      if (!baseManifestHash) {
        throw new Error("The current board could not be fingerprinted safely.");
      }
      assertProjectCanAcceptPdfPages(current, 1);
      const currentRasterUsage = current === sourceProject
        ? sourceRasterUsage
        : await inspectLocalProjectRasterUsage(current, {
          rasterBudget,
          signal: operation.signal,
        });
      if (!isCurrentOperation()) return;
      addLocalProjectRasterUsage(currentRasterUsage, imported.rasterUsage, rasterBudget);
      const order = reconcilePdfPageOrder(current);
      const currentIndex = order.indexOf(insertAfterId);
      const insertAt = currentIndex < 0 ? order.length : currentIndex + 1;
      const nextPdfBytes = { ...basePdfBytes, [source.id]: imported.bytes };
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
      await assertPdfAdditionPreservesPendingUndoRaster(
        nextProject,
        nextPdfBytes,
        pendingPdfUndoRef.current,
        Date.now(),
        operation.signal,
      );
      if (!isCurrentOperation()) return;
      const storageAdmission = getPdfStorageAdmissionRequirement(
        current,
        basePdfBytes,
        nextProject,
        nextPdfBytes,
        { persistedContentBytes: autosaveContentBytesRef.current },
      );
      await assessAdditionalStorage(storageAdmission.requiredBytes, operation.signal);
      if (!isCurrentOperation()) return;
      // Creating the source PDF and raster preview remains cancellable. The
      // atomic IndexedDB save below is the durable commit boundary, so do not
      // offer cancellation once it begins.
      busyCancelRef.current = null;
      setBusyCanCancel(false);
      setBusyMessage("Saving the blank PDF page locally…");
      await persistPdfCandidateBeforePublication(nextProject, nextPdfBytes, {
        isBaseCurrent: () => (
          pdfBytesRef.current === basePdfBytes
          && autosaveManifestHash(projectRef.current ?? undefined) === baseManifestHash
        ),
        publish: () => {
          setErrorMessage(null);
          beginSceneHydration();
          pendingFrameIdRef.current = null;
          pendingProjectSearchTargetRef.current = null;
          pendingCreatedFrameIdRef.current = null;
          pendingSlideFrameActionRef.current = null;
          pendingSlideRotationActionRef.current = null;
          setSlideRotationTargetId(null);
          pdfBytesRef.current = nextPdfBytes;
          projectRef.current = nextProject;
          activeSceneIdRef.current = nextProject.activeSceneId;
          setPdfBytes(nextPdfBytes);
          setProject(nextProject);
          setWorkspaceMode("pdf");
        },
        signal: operation.signal,
      });
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
    assessAdditionalStorage,
    beginFileOpenOperation,
    beginSceneHydration,
    commitLiveScenePersistence,
    currentScene?.pdfPage,
    isCurrentFileOpenOperation,
    persistPdfCandidateBeforePublication,
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
    if (remainingProjectPdfPageCapacity(currentProject) < 1) {
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
    setPdfInsertCommitStarted(false);
  }, [pdfInsertProcessing]);

  const cancelPdfInsertion = useCallback(() => {
    if (pdfInsertCommitStarted) return;
    const generation = pdfInsertOperationGenerationRef.current;
    if (generation === null || fileOpenGenerationRef.current !== generation) return;
    setPdfInsertCancelling(true);
    fileOpenAbortControllerRef.current?.abort();
  }, [pdfInsertCommitStarted]);

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
    setPdfInsertCommitStarted(false);
    setPdfInsertProgress(null);
  }, [pendingPdfInsert, project?.activeSceneId, project?.id, projectHydrationRevision]);

  const submitPdfInsertion = useCallback(async (
    submission: PdfInsertSubmission,
    pendingOverride?: PendingPdfInsert,
  ) => {
    const pending = pendingOverride ?? pendingPdfInsert;
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
    setPdfInsertCommitStarted(false);
    setPdfInsertProgress(null);
    setErrorMessage(null);
    try {
      const sourceProject = commitLiveScenePersistence(pending.selectedPageId);
      if (!sourceProject || !isCurrentOperation()) return;
      const sourceManifestHash = autosaveManifestHash(sourceProject);
      const sourcePdfBytes = pdfBytesRef.current;
      if (!sourceManifestHash) throw new Error("The current board could not be fingerprinted safely.");
      const filesById = new Map(pending.files.map((file) => [file.id, file]));
      const selections = submission.selections.map((selection) => {
        const source = filesById.get(selection.id);
        if (!source) throw new Error("A selected PDF is no longer available.");
        return {
          file: source.file,
          pageCount: source.pageCount,
          sha256: source.sha256,
          sourceName: source.name,
          sourceInstanceId: source.id,
          sourcePageIndices: selection.pageIndices,
        };
      });
      const existingSourceHashes = new Set(
        Object.values(sourceProject.pdfDocuments)
          .map((source) => source.sha256)
          .filter((sha256): sha256 is string => Boolean(sha256)),
      );
      const countedSourceHashes = new Set(existingSourceHashes);
      let requiredSourceBytes = 0;
      for (const selection of selections) {
        if (countedSourceHashes.has(selection.sha256)) continue;
        countedSourceHashes.add(selection.sha256);
        requiredSourceBytes += selection.file.size;
        if (!Number.isSafeInteger(requiredSourceBytes)) {
          throw new Error("The selected PDF files are too large to insert safely.");
        }
      }
      await assessAdditionalStorage(requiredSourceBytes, operation.signal);
      if (!isCurrentOperation()) return;
      const { importPdfBatchAtomically } = await import("./lib/pdf/batch-import");
      const imported = await importPdfBatchAtomically(
        sourceProject,
        sourcePdfBytes,
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
      await assertPdfAdditionPreservesPendingUndoRaster(
        imported.project,
        imported.pdfBytes,
        pendingPdfUndoRef.current,
        Date.now(),
        operation.signal,
      );
      if (!isCurrentOperation()) return;
      const storageAdmission = getPdfStorageAdmissionRequirement(
        sourceProject,
        sourcePdfBytes,
        imported.project,
        imported.pdfBytes,
        { persistedContentBytes: autosaveContentBytesRef.current },
      );
      await assessAdditionalStorage(storageAdmission.requiredBytes, operation.signal);
      if (!isCurrentOperation()) return;
      // Match direct import's irreversible boundary. The dialog disables its
      // cancellation action before the atomic autosave starts.
      setPdfInsertProgress({
        phase: "Saving locally",
        documentPosition: selections.length,
        documentTotal: selections.length,
        pagePosition: imported.insertedSceneIds.length,
        pageTotal: imported.insertedSceneIds.length,
        message: "Finalizing the complete batch. Cancellation is unavailable after this point.",
      });
      setPdfInsertCommitStarted(true);
      await persistPdfCandidateBeforePublication(imported.project, imported.pdfBytes, {
        isBaseCurrent: () => (
          pdfBytesRef.current === sourcePdfBytes
          && autosaveManifestHash(projectRef.current ?? undefined) === sourceManifestHash
        ),
        publish: () => {
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
        },
        signal: operation.signal,
      });
    } catch (error) {
      if (isCurrentOperation() && !isAbortLikeError(error)) {
        const [{ PdfBatchImportSelectionError }, { getPdfImportRecovery }] = await Promise.all([
          import("./lib/pdf/batch-import"),
          import("./lib/pdf/import-compatibility"),
        ]);
        if (!isCurrentOperation()) return;
        const batchFailure = error instanceof PdfBatchImportSelectionError
          ? error
          : null;
        const failedSource = batchFailure
          ? pending.files.find((file) => file.id === batchFailure.sourceInstanceId)
          : undefined;
        const compatibilityOriginal = failedSource?.compatibilityOriginal;
        const recovery = compatibilityOriginal
          ? getPdfImportRecovery(compatibilityOriginal.failure)
          : getPdfImportRecovery(batchFailure?.cause ?? error);
        if (batchFailure && failedSource && recovery) {
          setErrorMessage(compatibilityOriginal
            ? `That converted copy could not be used: ${batchFailure.message}`
            : null);
          setPendingPdfCompatibilityImport({
            context: "batch",
            failure: compatibilityOriginal?.failure ?? batchFailure.cause,
            file: compatibilityOriginal?.file ?? failedSource.file,
            processing: false,
            recovery,
            sourceInstanceId: failedSource.id,
            submission,
            ...(recovery.kind === "choose-converted-copy"
              ? {
                rejectedOriginalInspection: compatibilityOriginal?.rejectedOriginalInspection
                  ?? {
                    pageCount: failedSource.pageCount,
                    sha256: failedSource.sha256,
                  },
              }
              : {}),
          });
        } else {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      if (pdfInsertOperationGenerationRef.current === operation.generation) {
        pdfInsertOperationGenerationRef.current = null;
        setPdfInsertProcessing(false);
        setPdfInsertCancelling(false);
        setPdfInsertCommitStarted(false);
      }
    }
  }, [
    beginFileOpenOperation,
    beginSceneHydration,
    commitLiveScenePersistence,
    assessAdditionalStorage,
    isCurrentFileOpenOperation,
    pdfInsertProcessing,
    pendingPdfInsert,
    persistPdfCandidateBeforePublication,
  ]);
  submitPdfInsertionRef.current = submitPdfInsertion;

  useEffect(() => {
    const handleDocumentPasteCapture = (event: ClipboardEvent) => {
      const host = editorHostRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement;
      if (
        !host
        || (!target || (!host.contains(target) && (!activeElement || !host.contains(activeElement))))
        || isEditableKeyboardTarget(target)
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

  const handleEditorCopyCapture = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!api || switchingSceneRef.current || !projectRef.current) return;
    const target = event.target instanceof Element ? event.target : null;
    if (isEditableKeyboardTarget(target)) return;
    const appState = api.getAppState();
    const visibleElements = api.getSceneElements();
    const selectedOwners = new Set(visibleElements.flatMap((element) => {
      if (!appState.selectedElementIds[element.id]) return [];
      const ownerId = classroomTimeWidgetOwnerId(element);
      return ownerId ? [ownerId] : [];
    }));
    if (!selectedOwners.size) return;
    const prepared = attachProjectCalendarTransferCache(
      visibleElements,
      projectRef.current,
      selectedOwners,
    );
    if (prepared === visibleElements) return;
    const preparedById = new Map(prepared.map((element) => [element.id, element]));
    const liveElements = api.getSceneElementsIncludingDeleted();
    const nextElements = liveElements.map((element) => {
      const ownerId = classroomTimeWidgetOwnerId(element);
      return ownerId && selectedOwners.has(ownerId)
        ? preparedById.get(element.id) ?? element
        : element;
    });
    if (nextElements.every((element, index) => element === liveElements[index])) return;
    const sceneId = activeSceneIdRef.current;
    if (!sceneId) return;
    classroomTimeTickFenceRef.current.push({
      sceneId,
      elementFingerprint: classroomTimeElementFingerprint(nextElements),
      fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
    });
    if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
    api.updateScene({ elements: nextElements, captureUpdate: CaptureUpdateAction.NEVER });
    if (classroomTimeClipboardRestoreTimerRef.current !== null) {
      window.clearTimeout(classroomTimeClipboardRestoreTimerRef.current);
    }
    classroomTimeClipboardRestoreTimerRef.current = window.setTimeout(() => {
      classroomTimeClipboardRestoreTimerRef.current = null;
      if (!api || switchingSceneRef.current || activeSceneIdRef.current !== sceneId) return;
      const currentElements = api.getSceneElementsIncludingDeleted();
      let changed = false;
      const restored = currentElements.map((element) => {
        const metadata = classroomTimeWidgetMetadata(element);
        if (
          !metadata
          || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")
          || !selectedOwners.has(metadata.ownerId)
          || metadata.calendar.transferCache === null
        ) return element;
        changed = true;
        return replaceClassroomTimeMetadata(element, {
          ...metadata,
          calendar: { ...metadata.calendar, transferCache: null },
        });
      });
      if (!changed) return;
      classroomTimeTickFenceRef.current.push({
        sceneId,
        elementFingerprint: classroomTimeElementFingerprint(restored),
        fileFingerprint: classroomTimeFileFingerprint(api.getFiles()),
      });
      if (classroomTimeTickFenceRef.current.length > 8) classroomTimeTickFenceRef.current.shift();
      api.updateScene({ elements: restored, captureUpdate: CaptureUpdateAction.NEVER });
    }, 0);
  }, [api]);

  const handleClassroomTimeDuplicate = useCallback<NonNullable<ExcalidrawProps["onDuplicate"]>>((
    nextElements,
    previousElements,
  ) => {
    const editorApi = api;
    const currentProject = projectRef.current;
    const sceneId = activeSceneIdRef.current;
    if (!editorApi || !currentProject || !sceneId || switchingSceneRef.current) return;
    try {
      const now = Date.now();
      const forked = forkNativeClassroomTimeWidgetDuplicates(
        nextElements,
        previousElements,
        now,
        createLocalId,
      );
      if (!Object.keys(forked.ownerIdMap).length) return;
      const previousIds = new Set(previousElements.map((element) => element.id));
      let projectCalendar = currentProject.projectCalendar
        ?? createClassroomCalendarStoreV1("project");
      let calendarChanged = false;
      const importedElements = forked.elements.map((element) => {
        if (previousIds.has(element.id)) return element;
        const metadata = classroomTimeWidgetMetadata(element);
        if (
          !metadata
          || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")
          || metadata.calendar.transferCache === null
        ) return element;
        const imported = importClassroomTimeCalendarTransfer(
          metadata,
          currentProject.id,
          projectCalendar,
        );
        projectCalendar = imported.projectCalendar;
        calendarChanged = calendarChanged || imported.calendarChanged;
        return imported.metadata === metadata
          ? element
          : replaceClassroomTimeMetadata(element, imported.metadata);
      });
      const activeScene = currentProject.scenes[sceneId];
      if (!activeScene) return [...previousElements];
      const reconciled = reconcileClassroomTimeWidgets(importedElements, {
        now,
        files: editorApi.getFiles(),
        createId: createLocalId,
        renderContext: classroomTimeRenderContext(
          importedElements,
          projectCalendar,
          deviceClassroomCalendarRef.current,
          now,
          editorThemeRef.current,
        ),
      });
      const liveFiles = mergeClassroomTimeFiles(
        editorApi.getFiles(),
        reconciled.addedFiles,
        reconciled.orphanedFileIds,
      );
      const candidateProject: ClassroomProject = {
        ...currentProject,
        projectCalendar,
        scenes: {
          ...currentProject.scenes,
          [sceneId]: {
            ...activeScene,
            elements: reconciled.elements as unknown as SerializedScene["elements"],
            files: persistentFilesForScene(
              activeScene,
              liveFiles,
              transientDarkPdfFileIdsRef.current,
            ) as unknown as SerializedScene["files"],
          },
        },
      };
      if (countProjectClassroomTimeWidgets(candidateProject) > MAX_CLASSROOM_TIME_WIDGETS) {
        throw new Error(`A project can contain at most ${MAX_CLASSROOM_TIME_WIDGETS} classroom time widgets.`);
      }
      assertProjectFitsContentBudget(candidateProject, pdfBytesRef.current);
      if (calendarChanged || !currentProject.projectCalendar) {
        const updatedProject = {
          ...currentProject,
          projectCalendar,
          updatedAt: nowIso(),
        };
        projectRef.current = updatedProject;
        setProject((current) => current?.id === updatedProject.id
          ? { ...current, projectCalendar, updatedAt: updatedProject.updatedAt }
          : current);
      }
      for (const fileId of reconciled.orphanedFileIds) delete editorApi.getFiles()[fileId];
      if (reconciled.addedFiles.length) editorApi.addFiles([...reconciled.addedFiles]);
      return [...reconciled.elements];
    } catch (error) {
      editorApi.setToast({ message: error instanceof Error ? error.message : String(error) });
      return [...previousElements];
    }
  }, [api]);

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

  const addPreparedClassroomTimeLibraryItem = useCallback(async (
    prepared: PreparedClassroomTimeLibraryItem,
  ) => {
    if (!api) return;
    pendingClassroomTimeLibraryTransferRef.current = null;
    try {
      if (libraryItemIdsRef.current.has(prepared.item.id)) {
        throw new Error("The Classroom Time library item ID collides with an existing item.");
      }
      const exactLibraryItemsRef: { current: LibraryItems | null } = { current: null };
      await api.updateLibrary({
        libraryItems: (current) => {
          const next = sanitizeLibraryItems([
            prepared.item,
            ...sanitizeLibraryItems(current),
          ] as LibraryItems);
          exactLibraryItemsRef.current = next;
          return next;
        },
        merge: false,
      });
      const exactLibraryItems = exactLibraryItemsRef.current;
      if (!exactLibraryItems) {
        throw new Error("The updated personal library could not be verified.");
      }
      // Excalidraw deliberately does not await onLibraryChange. Persist the
      // exact functional-update result here so success means IndexedDB has
      // completed, independent of callback ordering.
      const persistence = saveLibraryItems(exactLibraryItems);
      libraryPersistencePromiseRef.current = persistence;
      await persistence;
      libraryItemIdsRef.current = new Set(exactLibraryItems.map((item) => item.id));
      showClassroomTimeConfirmationToast(
        `${prepared.item.name || "Classroom Time widget"} added to Personal Library.`,
      );
    } catch (error) {
      setErrorMessage(`Classroom Time widget could not be added to Personal Library: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api, showClassroomTimeConfirmationToast]);

  const handleEditorClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (sceneInputBlockedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const libraryAddTarget = target?.closest(
      '.context-menu [data-testid="addToLibrary"], .layer-ui__library .library-unit__pulse, .layer-ui__library .library-unit__adder',
    );
    if (libraryAddTarget) {
      const currentProject = projectRef.current;
      if (api && currentProject) {
        const liveElements = api.getSceneElements();
        const selectedElementIds = api.getAppState().selectedElementIds;
        let preparedLibraryItem: PreparedClassroomTimeLibraryItem | null = null;
        const contextMenuAdd = !!libraryAddTarget.closest(".context-menu");
        const cleanUpInterceptedLibraryUi = () => {
          const appState = api.getAppState();
          api.updateScene({
            appState: {
              contextMenu: null,
              selectedElementIds: contextMenuAdd ? appState.selectedElementIds : {},
              selectedGroupIds: contextMenuAdd ? appState.selectedGroupIds : {},
              activeEmbeddable: contextMenuAdd ? appState.activeEmbeddable : null,
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        };
        try {
          preparedLibraryItem = prepareClassroomTimeLibraryItemForSelection(
            liveElements,
            api.getFiles(),
            currentProject,
            selectedElementIds,
          );
        } catch (error) {
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          cleanUpInterceptedLibraryUi();
          setErrorMessage(error instanceof Error ? error.message : String(error));
          return;
        }
        if (preparedLibraryItem) {
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          cleanUpInterceptedLibraryUi();
          void addPreparedClassroomTimeLibraryItem(preparedLibraryItem);
          return;
        }
        const selectedOwners = new Set(liveElements.flatMap((element) => {
          if (!selectedElementIds[element.id]) return [];
          const ownerId = classroomTimeWidgetOwnerId(element);
          return ownerId ? [ownerId] : [];
        }));
        const prepared = attachProjectCalendarTransferCache(
          liveElements,
          currentProject,
          selectedOwners,
        );
        const preparedById = new Map(prepared.map((element) => [element.id, element]));
        const cacheByAnchorId = new Map<
          string,
          ClassroomTimeLibraryTransferIntent["cacheByAnchorId"] extends ReadonlyMap<string, infer Value>
            ? Value
            : never
        >();
        for (const element of liveElements) {
          const metadata = classroomTimeWidgetMetadata(element);
          if (
            !metadata
            || (metadata.kind !== "calendar" && metadata.kind !== "dashboard")
            || !selectedOwners.has(metadata.ownerId)
          ) continue;
          const preparedMetadata = classroomTimeWidgetMetadata(preparedById.get(element.id) ?? element);
          if (
            !preparedMetadata
            || (preparedMetadata.kind !== "calendar" && preparedMetadata.kind !== "dashboard")
            || preparedMetadata.calendar.transferCache === null
          ) continue;
          cacheByAnchorId.set(element.id, {
            ownerId: metadata.ownerId,
            kind: metadata.kind,
            transferCache: preparedMetadata.calendar.transferCache,
          });
        }
        pendingClassroomTimeLibraryTransferRef.current = cacheByAnchorId.size
          ? {
              baselineItemIds: new Set(libraryItemIdsRef.current),
              cacheByAnchorId,
              expiresAt: Date.now() + 5_000,
            }
          : null;
      }
    }
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
  }, [addPreparedClassroomTimeLibraryItem, api]);

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
    if (sceneInputBlockedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      return;
    }
    if (isEditableKeyboardTarget(event.target)) return;
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
      && !target?.closest("[role='dialog']")
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
    if (sceneInputBlockedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      return;
    }
    classroomTimePointerActiveRef.current = true;
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
    if (slideQuickDrawEnabledRef.current) {
      slideFrameGestureRef.current = null;
      hideConstrainedFramePreview();
      activateSlideFrameTool(api, slideFrameAspectRatioRef.current);
      return;
    }
    stopSlideFrameDrawing();
  }, [api, hideConstrainedFramePreview, project?.slideOrder.length, slideBoundsForGesture, stopSlideFrameDrawing]);

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && slideFrameDrawingActiveRef.current) {
        if (isEditableKeyboardTarget(event.target)) return;
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

  const showClassroomTimeOverlay = Boolean(
    api
    && selectedClassroomTime
    && !presentation
    && !isCleanFullscreen
    && !featurePreferences.obsCaptureArea
    && !classroomTimeDialog
    && !isMathToolsOpen
    && !isGeoGonOpen
    && !mathInteraction
    && !isScreenshotCaptureActive
    && !busyMessage
    && !nativeImageExportOpenRef.current
  );
  const livePresentationClassroomTimeSelection = presentation && api
    ? presentationClassroomTimeSelectionForLiveScene(
        presentationClassroomTimeSelection,
        api.getSceneElements(),
        {
          activeSceneId: project?.activeSceneId || null,
          hydratedSceneId: hydratedSceneIdRef.current,
          projectId: project?.id || null,
          switching: switchingSceneRef.current,
        },
      )
    : null;
  const showPresentationClassroomTimeControls = Boolean(
    livePresentationClassroomTimeSelection
    && !featurePreferences.obsCaptureArea
  );
  classroomTimeOverlayNeedsTicksRef.current = showClassroomTimeOverlay
    || showPresentationClassroomTimeControls;

  if (!project || !currentScene) return <div className="loading-screen">Opening PatterDraw…</div>;

  const slideRotationTarget = slideRotationTargetId
    ? project.slideOrder.find((slide) => slide.id === slideRotationTargetId) || null
    : null;

  const renderWorkspaceStatusControls = (variant: "footer" | "bottom") => (
    <WorkspaceStatusControls
      variant={variant}
      workspaceMode={workspaceMode}
      zoom={zoom}
      pdfPageIndex={pageIndex}
      pdfPageCount={pdfScenes.length}
      onOpenPdfPage={(index) => {
        const scene = pdfScenes[index];
        if (scene) {
          rememberCurrentPdfZoom();
          openScene(scene.id);
        }
      }}
      isPdfRailVisible={isPdfRailVisible}
      onShowPdfRail={showPdfRail}
      activeSlideIndex={activeSlideIndex}
      slideCount={project.slideOrder.length}
      onOpenSlide={(index) => {
        const slideId = project.slideOrder[index];
        if (slideId) openSlide(slideId);
      }}
      isSlideRailVisible={isSlideRailVisible}
      slideRailShowButtonRef={slideRailShowButtonRef}
      onShowSlideRail={showSlideRail}
      onHideFooter={() => setFeaturePreference("footer", false)}
      onEditorControl={clickEditorControl}
      onPresent={() => void startPresentation()}
      isPdfToolbarVisible={isPdfToolbarVisible}
      onTogglePdfToolbar={() => setIsPdfToolbarVisible((visible) => !visible)}
      obsCaptureArea={featurePreferences.obsCaptureArea}
      isFullscreen={isFullscreen}
      onToggleFullscreen={() => void toggleFullscreen()}
    />
  );

  const latestRecoverySnapshot = recoverySnapshots[0] ?? null;
  const visibleRecoverySnapshot = latestRecoverySnapshot
    && latestRecoverySnapshot.snapshotId !== dismissedRecoverySnapshotId
    ? latestRecoverySnapshot
    : null;
  const archiveReadinessWarning = archiveWorkerReadiness?.available === false
    ? archiveWorkerReadiness
    : null;
  const storageReadinessWarning = storageReadiness
    && storageReadiness.durableStorage !== "persisted"
    && storageReadiness.durableStorage !== "granted"
    ? storageReadiness
    : null;
  const showLocalReadinessBanner = Boolean(
    !presentation
    && !autosaveRecoveryDetail
    && (
      visibleRecoverySnapshot
      || (!localReadinessDismissed && (archiveReadinessWarning || storageReadinessWarning))
    ),
  );

  return (
    <div
      ref={shellRef}
      className={`app-shell ${workspaceModeClassName(workspaceMode)} ${workspaceMode === "slides" && !isSlideRailVisible ? "is-slide-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfRailVisible ? "is-pdf-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfToolbarVisible ? "is-pdf-toolbar-hidden" : ""} ${!isNavigationVisible ? "is-nav-hidden" : ""} ${!isFooterVisible ? "is-footer-hidden" : ""} ${!featurePreferences.projectFind ? "is-project-find-disabled" : ""} ${!featurePreferences.library ? "is-library-disabled" : ""} ${isProjectFindOpen ? "is-project-find-open" : ""} ${isLibraryOpen ? "is-library-open" : ""} ${featurePreferences.iconOnlyControls ? "is-icon-only-controls" : ""} ${featurePreferences.bottomInterface ? "is-bottom-interface" : ""} ${featurePreferences.obsCaptureArea ? "is-obs-capture-enabled" : ""} ${featurePreferences.obsCaptureArea && featurePreferences.obsShowCursor ? "is-obs-cursor-visible" : ""} ${isCleanFullscreen ? "is-clean-fullscreen" : ""} ${presentation && (presentationSlide || presentationPdfScene) ? "is-presenting" : ""}`}
      data-theme={editorTheme}
      style={{ "--pdf-rail-width": `${pdfRailWidth}px` } as CSSProperties}
    >
      {!presentation && isNavigationVisible && (
        <TopBar
          placement={featurePreferences.bottomInterface ? "bottom" : "top"}
          statusControls={featurePreferences.bottomInterface && isFooterVisible
            ? renderWorkspaceStatusControls("bottom")
            : undefined}
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
          onOpenShortcutHelp={openShortcutHelp}
          onOpenRecoveryHistory={openRecoveryHistory}
          recoveryHistoryCount={recoverySnapshots.length}
          onRestoreFeaturePreferences={restoreFeaturePreferences}
          onRestorePdfPreferences={restorePdfPreferences}
          onOpen={() => inputRef.current?.click()}
          onSave={saveProjectFile}
          onClearBoard={requestBoardClear}
          clearBoardDisabled={!api || isSceneInputBlocked || boardClearProcessing || !!busyMessage}
          clearBoardButtonRef={clearBoardButtonRef}
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
          onHideStatusControls={featurePreferences.bottomInterface && isFooterVisible
            ? () => setFeaturePreference("footer", false)
            : undefined}
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
      {showLocalReadinessBanner && (
        <section
          className="autosave-recovery-banner local-readiness-banner"
          role={archiveReadinessWarning ? "alert" : "status"}
          aria-labelledby="local-readiness-title"
        >
          <div className="autosave-recovery-copy">
            <strong id="local-readiness-title">Protect your classroom work</strong>
            {archiveReadinessWarning && !localReadinessDismissed ? (
              <span>
                Portable project backup is not ready: {archiveReadinessWarning.message}
              </span>
            ) : null}
            {storageReadinessWarning && !localReadinessDismissed ? (
              <span>
                {storageReadinessWarning.durableStorage === "denied"
                  ? "This browser may remove local autosaves under storage pressure. You can ask it to protect PatterDraw data, and downloaded .patterdraw backups remain the safest copy."
                  : "This browser cannot guarantee durable local autosaves. Download .patterdraw backups often."}
              </span>
            ) : null}
            {visibleRecoverySnapshot ? (
              <span>
                A protected previous board is available: <strong>{visibleRecoverySnapshot.title}</strong>, saved {new Date(visibleRecoverySnapshot.capturedAt).toLocaleString()}.
              </span>
            ) : null}
          </div>
          <div className="autosave-recovery-actions">
            {archiveReadinessWarning && !localReadinessDismissed ? (
              <button
                type="button"
                disabled={localReadinessBusy}
                onClick={() => void retryArchiveWorkerReadiness()}
              >
                Retry backup check
              </button>
            ) : null}
            {storageReadinessWarning
              && !localReadinessDismissed
              && storageReadinessWarning.durableStorage !== "unsupported" ? (
                <button
                  type="button"
                  disabled={localReadinessBusy}
                  onClick={() => void requestLocalStorageProtection()}
                >
                  Protect local work
                </button>
              ) : null}
            {visibleRecoverySnapshot ? (
              <button
                type="button"
                disabled={localReadinessBusy}
                onClick={(event) => openRecoveryHistory(event.currentTarget)}
              >
                Recovery history ({recoverySnapshots.length})
              </button>
            ) : null}
            {visibleRecoverySnapshot ? (
              <button
                className="is-primary"
                type="button"
                disabled={localReadinessBusy}
                onClick={() => void recoverPreviousBoard(visibleRecoverySnapshot.snapshotId)}
              >
                Recover previous board
              </button>
            ) : null}
            <button
              type="button"
              disabled={localReadinessBusy}
              onClick={() => {
                setLocalReadinessDismissed(true);
                if (visibleRecoverySnapshot) {
                  setDismissedRecoverySnapshotId(visibleRecoverySnapshot.snapshotId);
                }
              }}
            >
              Dismiss
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
          quickDrawEnabled={project.slideQuickDrawEnabled === true}
          onToggleQuickDraw={toggleSlideQuickDraw}
          onOpenSlide={openSlideFromRail}
          onMoveSlide={reorderSlides}
          onRotateSlide={openSlideRotationDialog}
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
          onOpenPdf={() => pdfOpenInputRef.current?.click()}
          onAddBlankPage={() => void addPdfPage()}
          onInsertPdfPages={openPdfInsertFilePicker}
          addPageTriggerRef={pdfInsertTriggerRef}
          pageActionsTriggerRef={pdfPageActionsTriggerRef}
          onDuplicatePage={duplicatePdfPageAction}
          onRotatePage={rotatePdfPageAction}
          onRequestClearAnnotations={requestPdfAnnotationClear}
          onDeletePage={deletePdfPage}
          onDeletePages={deletePdfPages}
          width={pdfRailWidth}
          onWidthChange={setPdfRailWidth}
          onHide={hidePdfRail}
        />
      )}
      <main
        className="editor-region"
        data-presentation-zoom={presentation ? zoom : undefined}
        data-slide-transition={presentation?.kind === "slides" ? (project.slideMorphEnabled === true ? "morph" : "none") : undefined}
        data-morph-duration-ms={presentation?.kind === "slides" ? normalizeSlideMorphDurationMs(project.slideMorphDurationMs) : undefined}
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
            {featurePreferences.bottomInterface ? <ShowBottomBarIcon /> : <ShowTopBarIcon />}
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
          className={`editor-host ${isNativeZenMode ? "is-native-zen-mode" : ""} ${isScreenshotCaptureActive ? "is-screenshot-capture-active" : ""} ${isSlideFrameDrawingActive ? "is-slide-frame-drawing-active" : ""}`}
          aria-busy={isSceneInputBlocked || undefined}
          onClickCapture={handleEditorClickCapture}
          onKeyDownCapture={handleEditorKeyDownCapture}
          onPointerDownCapture={handleEditorPointerDownCapture}
          onDragStartCapture={handleEditorDragStartCapture}
          onDragEndCapture={handleEditorDragEndCapture}
          onDropCapture={handleEditorDropCapture}
          onCopyCapture={handleEditorCopyCapture}
          onDragOver={handleScreenshotDragOver}
          onDrop={handleScreenshotDrop}
        >
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={initialExcalidrawData}
            onChange={handleChange}
            onDuplicate={handleClassroomTimeDuplicate}
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
          {isSceneInputBlocked ? (
            <div
              className="scene-hydration-input-guard"
              data-testid="scene-hydration-input-guard"
              role="status"
              aria-label="Opening canvas"
              aria-live="polite"
            >
              <span>Opening canvas…</span>
            </div>
          ) : null}
          {featurePreferences.obsCaptureArea && !presentation ? (
            <ObsCaptureGuide
              layout={workspaceMode === "pdf"
                ? "viewport"
                : featurePreferences.obsRecordVisibleCanvas
                  ? "visible"
                  : "widescreen"}
            />
          ) : null}
          {showClassroomTimeOverlay && selectedClassroomTime ? (
              <ClassroomTimeOverlay
                metadata={selectedClassroomTime.metadata}
                nowMs={classroomTimeNowMs}
                activeTarget={classroomTimeActiveTarget}
                completionNotice={null}
                onCommand={controlSelectedClassroomTimeWidget}
                onConvertToOrdinaryElements={convertSelectedClassroomTimeWidget}
                onCustomize={customizeSelectedClassroomTimeWidget}
                onDeleteWidget={deleteSelectedClassroomTimeWidget}
                onDismissCompletion={dismissClassroomAlarmNotice}
                onDuplicate={duplicateSelectedClassroomTimeWidget}
              />
            ) : null}
          {!featurePreferences.obsCaptureArea && isSlideFrameDrawingActive && workspaceMode === "slides" && (
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
          {!featurePreferences.obsCaptureArea && isScreenshotCaptureActive && (
            <ScreenshotCaptureOverlay
              onCancel={cancelScreenshotCapture}
              onCapture={finishScreenshotCapture}
            />
          )}
          {!featurePreferences.obsCaptureArea && spinnerPointerAnimations.length > 0 && (
            <SpinnerPointerOverlay durationMs={SPINNER_ANIMATION_DURATION_MS} spinners={spinnerPointerAnimations} />
          )}
          {api && !featurePreferences.obsCaptureArea && (
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
          {api && !featurePreferences.obsCaptureArea && isLassoActive && lassoGeometryFactory && lassoInitialSelection && editorHostRef.current ? (
            <LassoOverlay
              api={api}
              createGeometrySnapshot={lassoGeometryFactory}
              editorHost={editorHostRef.current}
              initialSelection={lassoInitialSelection}
              onExit={finishLasso}
            />
          ) : null}
          {api && !featurePreferences.obsCaptureArea && isBucketFillActive && editorHostRef.current ? (
            <BucketFillOverlay
              api={api}
              editorHost={editorHostRef.current}
              onExit={finishBucketFill}
              onFill={fillBucketRegion}
            />
          ) : null}
          {!featurePreferences.obsCaptureArea && mathInteraction && (
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
        {!presentation && !featurePreferences.bottomInterface && isFooterVisible
          ? renderWorkspaceStatusControls("footer")
          : null}
      </main>
      {presentation && (presentationSlide || presentationPdfScene) && (
        <PresentationOverlay
          itemCount={presentation.kind === "pdf" ? pdfScenes.length : project.slideOrder.length}
          itemLabel={presentation.kind === "pdf" ? "Page" : "Slide"}
          index={presentation.index}
          tool={presentation.tool}
          inkColour={presentation.inkColour}
          inkWidth={presentation.inkWidth}
          classroomTime={showPresentationClassroomTimeControls && livePresentationClassroomTimeSelection ? {
            metadata: livePresentationClassroomTimeSelection.metadata,
            nowMs: classroomTimeNowMs,
            activeTarget: classroomTimeActiveTarget,
          } : null}
          onIndexChange={presentation.kind === "pdf" ? setPdfPresentationIndex : setPresentationIndex}
          onToolChange={setPresentationTool}
          onClassroomTimeCommand={controlSelectedClassroomTimeWidget}
          onClassroomTimeTargetChange={setClassroomTimeActiveTarget}
          onInkColourChange={setPresentationInkColour}
          onInkWidthChange={setPresentationInkWidth}
          onExit={stopPresentation}
          shortcutsPaused={isShortcutHelpOpen}
        />
      )}
      {isShortcutHelpOpen ? (
        <KeyboardShortcutsDialog
          onClose={() => setIsShortcutHelpOpen(false)}
          returnFocusRef={shortcutHelpReturnFocusRef}
        />
      ) : null}
      {isRecoveryHistoryOpen ? (
        <RecoveryHistoryDialog
          busy={localReadinessBusy}
          damagedSnapshotIds={damagedRecoverySnapshotIds}
          entries={recoverySnapshots}
          onClearAll={() => void clearRecoveryHistory()}
          onClose={() => setIsRecoveryHistoryOpen(false)}
          onDelete={(snapshotId) => void deleteRecoverySnapshot(snapshotId)}
          onRecover={(snapshotId) => void recoverPreviousBoard(snapshotId)}
          returnFocusRef={recoveryHistoryReturnFocusRef}
          status={recoveryHistoryStatus}
          unreadableHistory={recoveryHistoryUnreadable}
        />
      ) : null}
      <input
        ref={pdfOpenInputRef}
        className="visually-hidden"
        type="file"
        aria-label="Open PDF"
        accept=".pdf,application/pdf,application/octet-stream"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void handleFile(file);
        }}
      />
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
      {pendingPdfInsert && pendingPdfCompatibilityImport?.context !== "batch" ? (
        <PdfInsertDialog
          files={pendingPdfInsert.files}
          remainingPageCapacity={project ? remainingProjectPdfPageCapacity(project) : 0}
          processing={pdfInsertProcessing}
          cancelling={pdfInsertCancelling}
          progress={pdfInsertProgress}
          onCancel={closePdfInsertDialog}
          onCancelProcessing={pdfInsertCommitStarted ? undefined : cancelPdfInsertion}
          onSubmit={(submission) => void submitPdfInsertion(submission)}
          returnFocusRef={pdfInsertTriggerRef}
        />
      ) : null}
      {pendingBoardClear ? (
        <ClearBoardDialog
          objectCount={pendingBoardClear.objectCount}
          slideCount={pendingBoardClear.slideCount}
          processing={boardClearProcessing}
          onCancel={() => { if (!boardClearProcessingRef.current) setPendingBoardClear(null); }}
          onConfirm={() => void confirmBoardClear()}
          returnFocusRef={clearBoardButtonRef}
        />
      ) : null}
      {pendingProjectSwitch ? (
        <ProjectSwitchDialog
          currentProjectTitle={project.title}
          nextFileName={pendingProjectSwitch.file.name}
          processing={pendingProjectSwitch.processing}
          onCancel={cancelPendingProjectSwitch}
          onOpenWithoutBackup={() => void protectCurrentBoardAndOpen(false)}
          onBackupAndOpen={() => void protectCurrentBoardAndOpen(true)}
        />
      ) : null}
      {pendingPdfCompatibilityImport ? (
        <PdfCompatibilityImportDialog
          fileNames={[pendingPdfCompatibilityImport.file.name]}
          processing={pendingPdfCompatibilityImport.processing}
          recovery={pendingPdfCompatibilityImport.recovery}
          onCancel={cancelPdfCompatibilityImport}
          onRetrySafetyCheck={() => void retryPdfCompatibilitySafetyCheck()}
          onSelectConvertedCopy={(file) => void importPdfCompatibilityCopy(file)}
          returnFocusRef={pendingPdfCompatibilityImport.context === "batch"
            ? pdfInsertTriggerRef
            : undefined}
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
      {slideRotationTarget && !presentation ? (
        <SlideRotationDialog
          slideTitle={slideRotationTarget.title}
          onCancel={cancelSlideRotation}
          onSubmit={applySlideRotation}
          returnFocusRef={slideRotationReturnFocusRef}
        />
      ) : null}
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
          onOpenClassroomTimeTool={openClassroomTimeTool}
          onInsert={insertMathTool}
          onStartInteraction={startMathInteraction}
        />
      ) : null}
      {classroomTimeDialog && !presentation && !featurePreferences.obsCaptureArea ? (
        <ClassroomTimeDialog
          metadata={classroomTimeDialog.metadata}
          mode={classroomTimeDialog.mode}
          boardTheme={editorTheme}
          alarmMuted={classroomTimePreferences.muted}
          alarmVolume={classroomTimePreferences.masterVolume}
          projectEventCount={project.projectCalendar?.events.length ?? 0}
          deviceEventCount={deviceClassroomCalendar.events.length}
          onAlarmPreferencesChange={setClassroomAlarmPreferences}
          onCancel={() => setClassroomTimeDialog(null)}
          onCreateCalendarEvent={createClassroomTimeCalendarEvent}
          onRestoreDefaults={restoreClassroomTimeWidgetDefaults}
          onSubmit={submitClassroomTimeWidget}
          onTestAlarm={testClassroomAlarm}
          onUseAsDefault={saveClassroomTimeDefaults}
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
      {(classroomTimeConfirmationToast || pdfUndoToast || classroomTimeAlarmNotice) && (
        <div className="app-toast-stack" style={{ pointerEvents: "none" }}>
          {classroomTimeConfirmationToast && (
            <div className="pdf-annotation-clear-toast app-toast" role="status">
              <span>{classroomTimeConfirmationToast.message}</span>
            </div>
          )}
          {pdfUndoToast && (
            <div className="pdf-annotation-clear-toast app-toast app-toast--pdf-undo" role="status" style={{ pointerEvents: "auto" }}>
              <span>
                {pdfUndoToast.kind === "clear-annotations" ? (
                  <>
                    Cleared {pdfUndoToast.annotationCount} {pdfUndoToast.annotationCount === 1 ? "annotation" : "annotations"}
                    {" from "}{pdfUndoToast.affectedPageCount} {pdfUndoToast.affectedPageCount === 1 ? "page" : "pages"}
                  </>
                ) : pdfUndoToast.kind === "delete-pages" ? (
                  <>
                    Removed {pdfUndoToast.deletedPageNumbers.length} selected {pdfUndoToast.deletedPageNumbers.length === 1 ? "page" : "pages"}
                  </>
                ) : (
                  <>Deleted output page {pdfUndoToast.deletedPageNumber}</>
                )}
              </span>
              <span aria-hidden="true">—</span>
              <button type="button" onClick={undoPendingPdfAction}>Undo</button>
            </div>
          )}
          {classroomTimeAlarmNotice && (
            <div className="pdf-annotation-clear-toast app-toast app-toast--classroom-alarm" role="alert" style={{ pointerEvents: "auto" }}>
              <strong>Time is up</strong>
              <span>{classroomTimeAlarmNotice.message}</span>
              {classroomTimeAlarmNotice.blocked
                && !classroomTimeAlarmNotice.deliveryPending
                && !featurePreferences.obsCaptureArea ? (
                <button type="button" onClick={enableClassroomAlarmSound}>Enable sound</button>
              ) : null}
              {classroomTimeAlarmNoticeCanDismiss(classroomTimeAlarmNotice)
                && !featurePreferences.obsCaptureArea ? (
                <button type="button" onClick={dismissClassroomAlarmNotice}>Dismiss</button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
