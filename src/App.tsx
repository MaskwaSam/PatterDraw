import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  DefaultSidebar,
  Excalidraw,
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
import { PresentationOverlay } from "./components/PresentationOverlay";
import { StrokeWidthExtensions } from "./components/StrokeWidthExtensions";
import { MathToolsMenuExtension } from "./components/MathToolsMenuExtension";
import { MathToolsDialog } from "./components/MathToolsDialog";
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
import { loadAutosave, saveAutosave } from "./lib/persistence";
import {
  AUTOSAVE_BASE_INTERVAL_MS,
  getAutosaveCooldownMs,
  getAutosaveFollowupDelayMs,
} from "./lib/autosave-policy";
import { loadLibraryItems, saveLibraryItems } from "./lib/library-persistence";
import { decodeProjectFile, encodePreparedProjectFile } from "./lib/project-file";
import { bytesForBlob } from "./lib/blob-bytes";
import { downloadBlob, safeFileStem } from "./lib/download";
import { exportFullBoardPng } from "./lib/export-board";
import { createLocalId } from "./lib/id";
import {
  beginPngClipboardWrite,
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
import {
  getPdfRasterDimensions,
  renderDarkPdfPreview,
} from "./lib/pdf/dark-preview";
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
import type { PdfExportMode } from "./lib/pdf/export-pdf";
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
  canonicalizePersistedWrapperTool,
  isPersistedWrapperTool,
  MAX_PROJECT_BYTES,
  sanitizeProject,
  sanitizeScene,
} from "./lib/safety";
import {
  assertProjectCanAcceptAdditionalBytes,
  assertProjectFitsContentBudget,
} from "./lib/project-budget";
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
type PendingScenePersistence = {
  sceneId: string;
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};
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
      '.math-interaction-panel[role="dialog"]',
      '.topbar-menu-popover[role="menu"]',
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
const PERSONAL_LIBRARY_SIDEBAR_TAB = "library";
const PROJECT_FIND_SIDEBAR_TAB = "project-find";
type LibrarySidebarTab = typeof PERSONAL_LIBRARY_SIDEBAR_TAB | typeof SCREENSHOT_SIDEBAR_TAB;

const renderNoEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]> = () => null;

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

function serializedSceneFromChange(
  previous: SerializedScene,
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
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
  return sanitizeScene({
    ...previous,
    elements: exported.elements,
    appState: exported.appState,
    files: exported.files || {},
  });
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

function darkPdfSceneCacheKey(
  projectId: string | undefined,
  scene: SerializedScene,
): string | null {
  const workspace = scene.pdfPage;
  const background = workspace
    ? scene.elements.find((element) => element.id === workspace.backgroundElementId)
    : undefined;
  const lightFileId = typeof background?.fileId === "string" ? background.fileId : null;
  if (!workspace || !lightFileId) return null;
  return JSON.stringify([
    projectId || "project",
    scene.id,
    workspace.documentId,
    workspace.pageIndex,
    lightFileId,
  ]);
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
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("The Excalidraw file is not valid JSON.");
  }
  if (!Array.isArray(data.elements)) throw new Error("The Excalidraw file has no scene elements.");
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [autosaveRecoveryDetail, setAutosaveRecoveryDetail] = useState<string | null>(null);
  const [initialExcalidrawData] = useState<Promise<{ libraryItems: LibraryItems } | null>>(() => (
    loadLibraryItems()
      .then((libraryItems) => ({ libraryItems }))
      .catch((error) => {
        setErrorMessage(`Personal library could not be opened: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
  ));
  const [exportOpen, setExportOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isProjectFindOpen, setIsProjectFindOpen] = useState(false);
  const [isSizePositionOpen, setIsSizePositionOpen] = useState(false);
  const [screenshots, setScreenshots] = useState<StoredScreenshot[]>([]);
  const [isScreenshotLibraryLoading, setIsScreenshotLibraryLoading] = useState(true);
  const [isScreenshotCaptureActive, setIsScreenshotCaptureActive] = useState(false);
  const [isScreenshotBusy, setIsScreenshotBusy] = useState(false);
  const [presentation, setPresentation] = useState<PresentationState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("board");
  const [pdfRailWidth, setPdfRailWidth] = useState(PDF_RAIL_DEFAULT_WIDTH);
  const [isPdfRailVisible, setIsPdfRailVisible] = useState(true);
  const [isPdfToolbarVisible, setIsPdfToolbarVisible] = useState(true);
  const [areSlideFramesVisible, setAreSlideFramesVisible] = useState(true);
  const [isSlideFrameDrawingActive, setIsSlideFrameDrawingActive] = useState(false);
  const [isNavigationVisible, setIsNavigationVisible] = useState(true);
  const [featurePreferences, setFeaturePreferences] = useState(readFeaturePreferences);
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
  const insertTriggerRef = useRef<HTMLButtonElement>(null);
  const exportOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<ClassroomProject | null>(project);
  const pdfBytesRef = useRef<Record<PdfDocumentId, Uint8Array>>(pdfBytes);
  const currentSceneRef = useRef<SerializedScene | null>(null);
  const activeSceneIdRef = useRef<string | null>(null);
  // A per-mount ID prevents imported user files from colliding with the one
  // transient full-page dark raster that is removed from saves and exports.
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
  const getDarkPdfDisplayFile = useCallback(async (
    scene: SerializedScene,
    signal?: AbortSignal,
  ): Promise<BinaryFileData> => {
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
    if (!workspace || !lightFileId || !lightDataUrl || !sourceBytes) {
      return Promise.reject(new Error("The original PDF page is unavailable."));
    }
    const cacheKey = darkPdfSceneCacheKey(projectRef.current?.id, scene);
    if (!cacheKey) throw new Error("The original PDF page is unavailable.");
    const cached = darkPdfPreviewCacheRef.current.get(cacheKey);
    if (cached) return cached;

    // Retain at most the active full-resolution raster. Rail previews have a
    // separate bounded cache, while scene navigation replaces this entry.
    darkPdfPreviewCacheRef.current.clear();
    const { width, height } = await getPdfRasterDimensions(lightDataUrl);
    const dataURL = await renderDarkPdfPreview({
      bytes: sourceBytes,
      pageIndex: workspace.pageIndex,
      width,
      height,
      signal,
    });
    const file: BinaryFileData = {
      id: darkPdfActiveFileIdRef.current,
      // Excalidraw applies an additional image-preservation filter to PNGs
      // before its dark canvas filter. This display-only raster already
      // compensates its picture regions, so opt out via the SVG MIME path;
      // the browser still decodes the PNG data URL itself.
      mimeType: "image/svg+xml",
      dataURL,
      created: Date.now(),
    };
    if (!signal?.aborted) darkPdfPreviewCacheRef.current.set(cacheKey, file);
    return file;
  }, []);
  const getDarkPdfThumbnailUrl = useCallback((
    scene: SerializedScene,
    signal?: AbortSignal,
  ): Promise<DataURL> => {
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
    if (!workspace || !lightFileId || !lightDataUrl || !sourceBytes) {
      return Promise.reject(new Error("The original PDF page is unavailable."));
    }
    const cacheKey = darkPdfSceneCacheKey(projectRef.current?.id, scene);
    if (!cacheKey) return Promise.reject(new Error("The original PDF page is unavailable."));
    const cached = darkPdfThumbnailCacheRef.current.get(cacheKey);
    if (cached) {
      // Refresh insertion order so recently revisited pages survive the cap.
      darkPdfThumbnailCacheRef.current.delete(cacheKey);
      darkPdfThumbnailCacheRef.current.set(cacheKey, cached);
      return Promise.resolve(cached.dataURL);
    }

    return getPdfRasterDimensions(lightDataUrl).then(async ({ width, height }) => {
      const scale = Math.min(1, 256 / Math.max(width, height));
      const dataURL = await renderDarkPdfPreview({
        bytes: sourceBytes,
        pageIndex: workspace.pageIndex,
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
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
    });
  }, []);
  // Excalidraw can emit its initial blank scene after the API is ready but
  // before the asynchronously loaded classroom project reaches the editor.
  // Treat that window as a scene switch so the blank scene cannot overwrite
  // the stored project during startup.
  const switchingSceneRef = useRef(true);
  const sceneHydrationGenerationRef = useRef(0);
  const sceneHydrationOuterFrameRef = useRef<number | null>(null);
  const sceneHydrationInnerFrameRef = useRef<number | null>(null);
  const pendingFrameIdRef = useRef<string | null>(null);
  const pendingProjectSearchTargetRef = useRef<PendingProjectSearchTarget | null>(null);
  const pendingPresentationTransitionRef = useRef<PendingPresentationTransition | null>(null);
  const pendingCreatedFrameIdRef = useRef<string | null>(null);
  const slideFramesVisibleRef = useRef(true);
  const slideFrameDrawingActiveRef = useRef(false);
  const slideFrameAspectRatioRef = useRef<SlideFrameAspectRatio>("freeform");
  const slideFrameGestureRef = useRef<SlideFrameGesture | null>(null);
  const slideDetachmentFrameRef = useRef(0);
  const frameDragPreviewRef = useRef<HTMLDivElement>(null);
  const presentationInkStartElementIdsRef = useRef<ReadonlySet<string> | null>(null);
  const activeToolTypeRef = useRef<string | null>(null);
  const roughnessBeforeLineRef = useRef<number | null>(null);
  const focusAfterMathToolsRef = useRef<"editor" | "trigger" | null>(null);
  const nativeImageExportOpenRef = useRef(false);
  const libraryOpenRef = useRef(false);
  const nativeCanvasSearchOpenRef = useRef(false);
  const lastLibraryTabRef = useRef<LibrarySidebarTab>(PERSONAL_LIBRARY_SIDEBAR_TAB);
  const screenshotsRef = useRef<StoredScreenshot[]>([]);
  const restoreExportOptionsFocusRef = useRef(false);
  const probabilityRandomizingRef = useRef(false);
  const lassoActiveRef = useRef(false);
  const bucketFillActiveRef = useRef(false);
  const preparedLassoSelectionRef = useRef<LassoInitialSelection | null>(null);
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
  const beginSceneHydration = useCallback(() => {
    // Wrapper pointer overlays belong to the currently hydrated editor scene.
    // Unmount them before replacing Excalidraw state so their visible controls
    // and any armed pointer gesture cannot leak into the incoming scene/page.
    resetTransientPointerTools();
    cancelSceneHydrationFrames();
    switchingSceneRef.current = true;
    sceneHydrationGenerationRef.current += 1;
    darkPdfPreviewGenerationRef.current += 1;
    for (const controller of darkPdfRenderControllersRef.current) controller.abort();
    darkPdfRenderControllersRef.current.clear();
    return sceneHydrationGenerationRef.current;
  }, [cancelSceneHydrationFrames, resetTransientPointerTools]);
  useEffect(() => () => {
    sceneHydrationGenerationRef.current += 1;
    darkPdfPreviewGenerationRef.current += 1;
    for (const controller of darkPdfRenderControllersRef.current) controller.abort();
    darkPdfRenderControllersRef.current.clear();
    cancelSceneHydrationFrames();
  }, [cancelSceneHydrationFrames]);
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
    autosaveSnapshotRef.current = {
      project: nextProject,
      pdfBytes: pdfBytesRef.current,
    };
    autosaveDirtyRef.current = true;
    if (autosaveSavingRef.current) autosaveUrgentRef.current = true;
    setProject((current) => {
      if (current === baseProject) return nextProject;
      const mergedProject = projectWithPendingScene(current, pending);
      if (!mergedProject) return current;
      projectRef.current = mergedProject;
      autosaveSnapshotRef.current = {
        project: mergedProject,
        pdfBytes: pdfBytesRef.current,
      };
      return mergedProject;
    });
    return nextProject;
  }, []);
  const commitLiveScenePersistence = useCallback((sceneId: string) => {
    const committed = commitPendingScenePersistence();
    if (!api || !committed || activeSceneIdRef.current !== sceneId) return committed;
    const scene = committed.scenes[sceneId];
    if (!scene) return committed;
    // Destructive controls can run before Excalidraw's debounced onChange
    // reaches pendingScenePersistenceRef. Capture the editor synchronously,
    // but send it through the same canonicalization, slide detachment,
    // serialization, and file filtering pipeline as an ordinary scene edit.
    pendingScenePersistenceRef.current = {
      sceneId,
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: persistentFilesForScene(
        scene,
        api.getFiles(),
        transientDarkPdfFileIdsRef.current,
      ),
    };
    return commitPendingScenePersistence();
  }, [api, commitPendingScenePersistence]);
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
        autosaveUrgentRef.current = false;
        // Keep the newest snapshot eligible for a later interaction/page-exit
        // flush. Retrying here would create a tight loop while storage remains
        // unavailable; flushAutosave always reads autosaveSnapshotRef so a
        // newer edit is retried instead of this captured snapshot.
        autosaveDirtyRef.current = true;
        setSaveStatus("error");
        setErrorMessage(autosaveFailureMessage(error));
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
    if (isMathToolsOpen || !focusAfterMathToolsRef.current) return;
    const focusTarget = focusAfterMathToolsRef.current;
    focusAfterMathToolsRef.current = null;
    const selector = focusTarget === "editor"
      ? ".excalidraw"
      : ".App-toolbar__extra-tools-trigger";
    editorHostRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [isMathToolsOpen]);

  useEffect(() => {
    let cancelled = false;
    loadAutosave()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) {
          const framesVisible = loaded.project.slideFramesVisible !== false;
          const startupProject = projectForBoardStartup(loaded.project);
          slideFramesVisibleRef.current = framesVisible;
          projectRef.current = startupProject;
          pdfBytesRef.current = loaded.pdfBytes;
          autosaveSnapshotRef.current = {
            project: startupProject,
            pdfBytes: loaded.pdfBytes,
          };
          autosaveDirtyRef.current = false;
          skipNextAutosaveEffectRef.current = true;
          setAreSlideFramesVisible(framesVisible);
          setProject(startupProject);
          setPdfBytes(loaded.pdfBytes);
        } else {
          setProject(createBlankProject());
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAutosaveRecoveryDetail(error instanceof Error ? error.message : String(error));
          // Keep the unread autosave untouched. Showing a temporary blank
          // board must not turn a transient IndexedDB/PDF-integrity failure
          // into permanent data loss before the teacher can recover storage.
          const fallbackProject = createBlankProject();
          projectRef.current = fallbackProject;
          pdfBytesRef.current = {};
          autosaveSnapshotRef.current = {
            project: fallbackProject,
            pdfBytes: {},
          };
          autosaveDirtyRef.current = false;
          autosaveSuspendedRef.current = true;
          skipNextAutosaveEffectRef.current = true;
          setSaveStatus("error");
          setProject(fallbackProject);
        }
      });
    return () => { cancelled = true; };
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
      setIsFullscreen(Boolean(shellRef.current && document.fullscreenElement === shellRef.current));
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
    autosaveSnapshotRef.current = { project, pdfBytes };
    if (skipNextAutosaveEffectRef.current) {
      skipNextAutosaveEffectRef.current = false;
      return;
    }
    if (autosaveSuspendedRef.current) return;
    autosaveDirtyRef.current = true;
    setSaveStatus("saving");
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);

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
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        commitPendingScenePersistence();
        flushAutosave(true, true);
      }
    };
    const flushBeforePageExit = (event: BeforeUnloadEvent) => {
      autosavePageExitRef.current = true;
      // A dismissed beforeunload prompt leaves this document alive and does
      // not reliably emit pageshow. Let the guard reopen on the next task in
      // that case; during a real navigation the document is torn down before
      // this callback can run.
      window.setTimeout(() => {
        autosavePageExitRef.current = false;
      }, 0);
      if (
        !pendingScenePersistenceRef.current
        && !autosaveDirtyRef.current
        && !autosaveSavingRef.current
      ) return;
      commitPendingScenePersistence();
      flushAutosave(true, true);
      event.preventDefault();
      event.returnValue = "";
    };
    const flushOnPageHide = () => {
      autosavePageExitRef.current = true;
      commitPendingScenePersistence();
      flushAutosave(true, true);
    };
    const resetPageExit = () => {
      autosavePageExitRef.current = false;
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
  }, [commitPendingScenePersistence, flushAutosave]);

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
    api.addFiles(Object.values(files));
    api.updateFrameRendering({ enabled: slideFramesVisibleRef.current, clip: false });
    api.history.clear();
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
  }, [api, beginSceneHydration, focusProjectSearchTarget, runSlideFrameAction]);

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
    if (switchingSceneRef.current) return;
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
    const containsBlockedContent = elements.some(
      (element) =>
        element.type === "embeddable" ||
        element.type === "iframe" ||
        element.type === "magicframe" ||
        !!element.link,
    );
    if (containsBlockedContent) {
      const safeElements = elements
        .filter(
          (element) =>
            element.type !== "embeddable" &&
            element.type !== "iframe" &&
            element.type !== "magicframe",
        )
        .map((element) => element.link
          ? { ...element, link: null }
          : element) as readonly ExcalidrawElement[];
      const suppressionGeneration = sceneHydrationGenerationRef.current;
      switchingSceneRef.current = true;
      api?.updateScene({ elements: safeElements, captureUpdate: CaptureUpdateAction.NEVER });
      api?.setToast({ message: "External links and web embeds are disabled in PatterDraw." });
      window.requestAnimationFrame(() => {
        if (sceneHydrationGenerationRef.current === suppressionGeneration) {
          switchingSceneRef.current = false;
        }
      });
      return;
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
      && editorThemeRef.current === "dark"
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
          && editorThemeRef.current === "dark"
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
    if (!isSizePositionOpen) return;
    const host = editorHostRef.current;
    if (!host) return;
    const applyAccessibleLabel = () => {
      const panel = host.querySelector<HTMLElement>(".exc-stats");
      if (!panel) return;
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Size & Position");
      panel.querySelector(".title h2")?.setAttribute("aria-label", "Size & Position");
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
    void saveLibraryItems(libraryItems).catch((error) => {
      setErrorMessage(`Personal library could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, []);

  const openLoadedProject = useCallback(async (loaded: LoadedClassroomProject) => {
    beginSceneHydration();
    pendingFrameIdRef.current = null;
    pendingProjectSearchTargetRef.current = null;
    pendingSlideFrameActionRef.current = null;
    autosaveStartupReadyRef.current = false;
    autosaveSuspendedRef.current = true;
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
    autosaveSavingRef.current = false;
    const startupProject = projectForBoardStartup(loaded.project);
    let replacementSaved = false;
    autosaveSavingRef.current = true;
    const replacementSave = saveAutosave(
      startupProject,
      loaded.pdfBytes,
      { prepared: true, replacePdfBlobs: true },
    ).then((contentSize) => {
      autosaveContentBytesRef.current = contentSize.totalBytes;
    });
    autosaveQueueRef.current = replacementSave;
    try {
      await replacementSave;
      replacementSaved = true;
    } catch (error) {
      setErrorMessage(autosaveFailureMessage(error));
    }
    autosaveSavingRef.current = false;
    pendingScenePersistenceRef.current = null;
    if (scenePersistenceTimerRef.current !== null) {
      window.clearTimeout(scenePersistenceTimerRef.current);
      scenePersistenceTimerRef.current = null;
    }
    pdfBytesRef.current = loaded.pdfBytes;
    projectRef.current = startupProject;
    autosaveSnapshotRef.current = {
      project: startupProject,
      pdfBytes: loaded.pdfBytes,
    };
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
    autosaveSuspendedRef.current = false;
    setAutosaveRecoveryDetail(null);
  }, [beginSceneHydration]);

  const handleFile = useCallback(async (file: File) => {
    setErrorMessage(null);
    setBusyMessage(`Opening ${file.name}…`);
    try {
      const isPdfFile = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (
        autosaveRecoveryDetail
        && !window.confirm(
          `Open ${file.name} and replace the protected unreadable autosave? Download the temporary board first if you want a separate backup.`,
        )
      ) return;
      if (!isPdfFile && file.size > MAX_PROJECT_BYTES) {
        throw new Error("The selected project is too large to open safely.");
      }
      if (isPdfFile) {
        const preflightProject = commitPendingScenePersistence() || createBlankProject();
        assertProjectCanAcceptAdditionalBytes(
          preflightProject,
          pdfBytesRef.current,
          file.size,
        );
        const { importPdf } = await import("./lib/pdf/import-pdf");
        const imported = await importPdf(file);
        const scenes = Object.fromEntries(imported.scenes.map((scene) => [scene.id, scene]));
        const importedPageIds = imported.scenes.map((scene) => scene.id);
        const base = commitPendingScenePersistence() || createBlankProject();
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
        beginSceneHydration();
        pendingFrameIdRef.current = null;
        pendingProjectSearchTargetRef.current = null;
        pendingCreatedFrameIdRef.current = null;
        pendingSlideFrameActionRef.current = null;
        autosaveSuspendedRef.current = false;
        setAutosaveRecoveryDetail(null);
        pdfBytesRef.current = nextPdfBytes;
        projectRef.current = nextProject;
        setPdfBytes(nextPdfBytes);
        setProject(nextProject);
        setWorkspaceMode("pdf");
        setEquationEditor(null);
        setMermaidEditor(null);
      } else if (
        file.name.toLowerCase().endsWith(".patterdraw")
        || file.name.toLowerCase().endsWith(".canvasclassroom")
      ) {
        const loaded = await decodeProjectFile(new Uint8Array(await file.arrayBuffer()));
        setBusyMessage(`Saving ${file.name} locally…`);
        await openLoadedProject(loaded);
      } else if (file.name.toLowerCase().endsWith(".excalidraw")) {
        const loaded = {
          project: nativeExcalidrawProject(await file.text()),
          pdfBytes: {},
        };
        setBusyMessage(`Saving ${file.name} locally…`);
        await openLoadedProject(loaded);
      } else {
        throw new Error("Open a .patterdraw, legacy .canvasclassroom, .excalidraw, or PDF file.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [autosaveRecoveryDetail, beginSceneHydration, commitPendingScenePersistence, openLoadedProject]);

  const saveProjectFile = useCallback(async () => {
    const currentProject = commitPendingScenePersistence();
    if (!currentProject) return;
    setBusyMessage("Preparing project backup…");
    try {
      await afterNextPaint();
      const bytes = await encodePreparedProjectFile(currentProject, pdfBytesRef.current);
      downloadBlob(
        new Blob([bytesForBlob(bytes)], { type: "application/vnd.patterdraw+zip" }),
        `${safeFileStem(currentProject.title)}.patterdraw`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [commitPendingScenePersistence]);

  const resumeAutosaveWithCurrentBoard = useCallback(async () => {
    const currentProject = commitPendingScenePersistence();
    if (!currentProject || !autosaveRecoveryDetail) return;
    if (!window.confirm(
      "Replace the unreadable stored autosave with this temporary board and resume autosave? Download this board first if you want a separate backup.",
    )) return;

    const snapshot = {
      project: currentProject,
      pdfBytes: pdfBytesRef.current,
    };
    autosaveSnapshotRef.current = snapshot;
    setBusyMessage("Replacing the unreadable autosave…");
    setSaveStatus("saving");
    let followupNeeded = false;
    try {
      await autosaveQueueRef.current.catch(() => undefined);
      autosaveSavingRef.current = true;
      const replacementSave = saveAutosave(
        snapshot.project,
        snapshot.pdfBytes,
        { prepared: true, replacePdfBlobs: true },
      ).then((contentSize) => {
        autosaveContentBytesRef.current = contentSize.totalBytes;
      });
      autosaveQueueRef.current = replacementSave;
      await replacementSave;
      const latestSnapshot = autosaveSnapshotRef.current;
      const newerSnapshotPending = latestSnapshot?.project !== snapshot.project
        || latestSnapshot?.pdfBytes !== snapshot.pdfBytes;
      autosaveDirtyRef.current = newerSnapshotPending;
      followupNeeded = newerSnapshotPending;
      autosaveUrgentRef.current = false;
      autosaveLastQueuedAtRef.current = Date.now();
      autosaveSuspendedRef.current = false;
      setAutosaveRecoveryDetail(null);
      setErrorMessage(null);
      setSaveStatus(newerSnapshotPending ? "saving" : "saved");
    } catch (error) {
      // Keep recovery mode active if the explicit replacement cannot be
      // committed atomically. The unreadable stored copy remains untouched.
      autosaveDirtyRef.current = true;
      setSaveStatus("error");
      setErrorMessage(autosaveFailureMessage(error));
    } finally {
      autosaveSavingRef.current = false;
      setBusyMessage(null);
    }
    if (followupNeeded) flushAutosave(true);
  }, [autosaveRecoveryDetail, commitPendingScenePersistence, flushAutosave]);

  const runPdfExport = useCallback(async (kind: "slides" | PdfExportMode) => {
    const currentProject = commitPendingScenePersistence();
    if (!currentProject) return;
    setExportOpen(false);
    setBusyMessage(kind === "slides" ? "Exporting slides…" : "Exporting annotated PDF…");
    try {
      await afterNextPaint();
      const { exportAnnotatedPdf, exportSlidesPdf } = await import("./lib/pdf/export-pdf");
      const blob = kind === "slides"
        ? await exportSlidesPdf(currentProject)
        : await exportAnnotatedPdf(currentProject, pdfBytesRef.current, kind);
      const suffix = kind === "slides" ? "slides" : kind === "expand" ? "annotated-expanded" : "annotated-openboard-fit";
      downloadBlob(blob, `${safeFileStem(currentProject.title)}-${suffix}.pdf`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [commitPendingScenePersistence]);

  const runPptxExport = useCallback(async () => {
    const currentProject = commitPendingScenePersistence();
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
  }, [commitPendingScenePersistence]);

  const runFullBoardExport = useCallback(async () => {
    if (!api || !project) return;
    setExportOpen(false);
    setBusyMessage("Exporting the full board…");
    try {
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
        ? persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current)
        : api.getFiles();
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

  const openNativeImageExport = useCallback(() => {
    if (!api || !project || api.getSceneElements().length === 0) return;
    setExportOpen(false);
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
    const scene = currentSceneRef.current;
    const displayFileId = scene
      ? darkPdfDisplayFileIdsRef.current.get(scene.id)
      : undefined;
    if (scene?.pdfPage && editorThemeRef.current === "dark" && displayFileId) {
      suspendDarkPdfDisplayRef.current = true;
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
      void afterNextPaint().then(showDialog);
      return;
    }
    showDialog();
  }, [api, project]);

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
        || switchingSceneRef.current
        || operation.projectId !== currentProject.id
        || operation.sceneId !== currentProject.activeSceneId
        || operation.hydrationGeneration !== sceneHydrationGenerationRef.current
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
    let generatedTool = requestedTool;
    let renderingUnitCircle = false;
    try {
      if (!("pieces" in generatedTool) && generatedTool.metadata.kind === "unit-circle") {
        renderingUnitCircle = true;
        setBusyMessage("Rendering unit-circle notation…");
        const rendered = await createUnitCircleMathJaxAsset(
          generatedTool.metadata.labelMode,
          generatedTool.metadata.showCoordinates,
        );
        generatedTool = { ...generatedTool, asset: rendered.asset };
      }
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
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (renderingUnitCircle) setBusyMessage(null);
    }
  }, [api, mathToolEdit]);

  const randomizeSelectedProbabilityPieces = useCallback(async () => {
    if (!api || probabilityRandomizingRef.current) return;
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
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (spinners.length && !prefersReducedMotion) {
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
        await new Promise<void>((resolve) => window.setTimeout(resolve, SPINNER_ANIMATION_DURATION_MS));
      }

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
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      probabilityRandomizingRef.current = false;
      setIsProbabilitySpinning(false);
      setSpinnerPointerAnimations([]);
    }
  }, [api]);

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
    const isSceneChange = sceneId !== activeSceneIdRef.current;
    if (
      isSceneChange
      && pendingSlideFrameActionRef.current?.sceneId !== sceneId
    ) pendingSlideFrameActionRef.current = null;
    if (frameId) pendingFrameIdRef.current = frameId;
    else if (isSceneChange) pendingFrameIdRef.current = null;
    if (isSceneChange) pendingCreatedFrameIdRef.current = null;
    if (isSceneChange) beginSceneHydration();
    setProject((current) => current ? { ...current, activeSceneId: sceneId } : current);
    if (api && sceneId === activeSceneIdRef.current && frameId) {
      focusSlide(api, frameId);
      pendingFrameIdRef.current = null;
    }
  }, [api, beginSceneHydration, commitPendingScenePersistence]);

  const openSlide = useCallback((slide: ClassroomSlide) => {
    setActiveSlideId(slide.id);
    openScene(slide.sceneId, slide.frameId);
  }, [openScene]);

  const activateProjectSearchResult = useCallback((result: ProjectSearchResult) => {
    if (!api) return;
    const latestProject = commitPendingScenePersistence();
    if (!latestProject?.scenes[result.sceneId]) {
      api.setToast({ message: "That search result is no longer in this project." });
      return;
    }
    if (result.scope === "slide" && featurePreferencesRef.current.slides) {
      setWorkspaceMode("slides");
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
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pendingPresentationTransitionRef.current = {
      frameId: slide.frameId,
      animate: allowMorph && currentProject.slideMorphEnabled === true && !prefersReducedMotion,
      durationMs: normalizeSlideMorphDurationMs(currentProject.slideMorphDurationMs),
    };
    setPresentation((current) => ({
      index,
      tool: current?.tool || "laser",
      inkColour: current?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: current?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
    }));
    setActiveSlideId(slide.id);
    if (slide.sceneId !== activeSceneIdRef.current) {
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      if (pendingSlideFrameActionRef.current?.sceneId !== slide.sceneId) {
        pendingSlideFrameActionRef.current = null;
      }
      beginSceneHydration();
    }
    setProject((current) => current && current.activeSceneId !== slide.sceneId
      ? { ...current, activeSceneId: slide.sceneId }
      : current);
  }, [beginSceneHydration, commitPendingScenePersistence]);

  const startPresentation = useCallback(async () => {
    if (!project || !api || workspaceMode !== "slides") return;
    if (!project.slideOrder.length) {
      api.setToast({ message: "Add a slide first; each frame becomes a slide." });
      return;
    }
    const index = Math.max(0, project.slideOrder.findIndex((slide) => slide.id === activeSlideId));
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
    setPresentationIndex(index, false);
    try { await shellRef.current?.requestFullscreen(); } catch { /* Fullscreen can be browser-blocked. */ }
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
    pendingPresentationTransitionRef.current = null;
    setPresentation(null);
    api?.updateFrameRendering({
      enabled: slideFramesVisibleRef.current,
      outline: true,
      name: true,
      clip: false,
    });
    setAreSlideFramesVisible(slideFramesVisibleRef.current);
    api?.setActiveTool({ type: "selection" });
    if (document.fullscreenElement) void document.exitFullscreen();
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
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (shellRef.current) {
        await shellRef.current.requestFullscreen();
      }
    } catch {
      api?.setToast({ message: "Fullscreen mode is unavailable in this browser." });
    }
  }, [api]);

  const clickEditorControl = useCallback((selector: string) => {
    const control = editorHostRef.current?.querySelector<HTMLButtonElement>(selector);
    if (control && !control.disabled) control.click();
  }, []);

  const setPresentationTool = useCallback((tool: "laser" | "freedraw") => {
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
    presentationInkStartElementIdsRef.current = new Set(api.getSceneElements().map((element) => element.id));
    activatePresentationInk(api, presentation.inkColour, presentation.inkWidth);
  }, [api, presentation?.inkColour, presentation?.inkWidth, presentation?.tool]);

  const finishPresentationInkStroke = useCallback(() => {
    const elementIdsBeforeStroke = presentationInkStartElementIdsRef.current;
    presentationInkStartElementIdsRef.current = null;
    if (!api || !elementIdsBeforeStroke || presentation?.tool !== "freedraw") return;
    window.requestAnimationFrame(() => {
      const elements = api.getSceneElements();
      const promoted = promoteNewPresentationInk(elements, elementIdsBeforeStroke);
      if (promoted === elements) return;
      api.updateScene({
        elements: promoted,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  }, [api, presentation?.tool]);

  const currentScene = project ? project.scenes[project.activeSceneId] : null;
  currentSceneRef.current = currentScene;
  useEffect(() => {
    darkPdfPreviewGenerationRef.current += 1;
    darkPdfPreviewCacheRef.current.clear();
    darkPdfThumbnailCacheRef.current.clear();
    darkPdfDisplayFileIdsRef.current.clear();
    darkPdfPreviewErrorsRef.current.clear();
    // The editor retains one stable display-only file for this mounted
    // session. It is excluded from persistence and replaced in place below.
    suspendDarkPdfDisplayRef.current = false;
    setDarkPdfPreviewUrls({});
  }, [project?.id, projectHydrationRevision]);

  useEffect(() => {
    const scene = currentScene;
    if (!scene?.pdfPage) {
      darkPdfDisplayFileIdsRef.current.clear();
      darkPdfPreviewCacheRef.current.clear();
      return;
    }
    if (!api) return;
    const generation = ++darkPdfPreviewGenerationRef.current;
    const hydrationGeneration = sceneHydrationGenerationRef.current;
    const liveElements = api.getSceneElements();
    if (editorTheme !== "dark" || suspendDarkPdfDisplayRef.current) {
      darkPdfDisplayFileIdsRef.current.clear();
      darkPdfPreviewCacheRef.current.clear();
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
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    darkPdfRenderControllersRef.current.add(controller);
    void getDarkPdfDisplayFile(scene, controller.signal).then((file) => {
      if (
        cancelled
        || generation !== darkPdfPreviewGenerationRef.current
        || hydrationGeneration !== sceneHydrationGenerationRef.current
        || editorThemeRef.current !== "dark"
        || suspendDarkPdfDisplayRef.current
        || activeSceneIdRef.current !== scene.id
      ) return;
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
        || darkPdfPreviewErrorsRef.current.has(scene.id)
      ) return;
      darkPdfPreviewErrorsRef.current.add(scene.id);
      api.setToast({ message: "This PDF page could not be shown in dark mode." });
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
    currentScene?.pdfPage?.pageIndex,
    darkPdfDisplayRevision,
    editorTheme,
    getDarkPdfDisplayFile,
    projectHydrationRevision,
  ]);
  const pdfScenes = useMemo(() => project
    ? orderedPdfScenes(project)
    : [], [project]);
  const pdfThumbnailIdentity = useMemo(() => JSON.stringify(
    pdfScenes.map((scene) => darkPdfSceneCacheKey(project?.id, scene)),
  ), [pdfScenes, project?.id]);
  const darkPdfThumbnailSceneIds = useMemo(() => darkPdfThumbnailRenderSceneIds(
    pdfScenes.map((scene) => scene.id),
    project?.activeSceneId,
    MAX_DARK_PDF_THUMBNAILS,
  ), [pdfScenes, project?.activeSceneId]);
  const darkPdfThumbnailTargetIdentity = darkPdfThumbnailSceneIds.join("\u0000");
  useEffect(() => {
    const validSceneIds = new Set(pdfScenes.map((scene) => scene.id));
    const validCacheKeys = new Set(
      pdfScenes
        .map((scene) => darkPdfSceneCacheKey(project?.id, scene))
        .filter((key): key is string => !!key),
    );
    pruneDarkPdfThumbnails(darkPdfThumbnailCacheRef.current, validCacheKeys);
    setDarkPdfPreviewUrls((current) => {
      const entries = Object.entries(current).filter(([sceneId]) => validSceneIds.has(sceneId));
      if (entries.length === Object.keys(current).length) return current;
      return Object.fromEntries(entries);
    });
    if (editorTheme !== "dark" || pdfScenes.length === 0) {
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
    darkPdfThumbnailTargetIdentity,
    getDarkPdfThumbnailUrl,
    pdfThumbnailIdentity,
    project?.activeSceneId,
    project?.id,
    projectHydrationRevision,
  ]);
  const pageIndex = currentScene?.pdfPage
    ? pdfScenes.findIndex((scene) => scene.id === currentScene.id)
    : -1;

  const persistScreenshots = useCallback(async (items: StoredScreenshot[]) => {
    await saveScreenshotLibrary(items);
    screenshotsRef.current = items;
    setScreenshots(items);
  }, []);

  const startScreenshotCapture = useCallback(() => {
    if (!api || isScreenshotBusy) return;
    lastLibraryTabRef.current = SCREENSHOT_SIDEBAR_TAB;
    setMathInteraction(null);
    lassoActiveRef.current = false;
    setIsLassoActive(false);
    api.toggleSidebar({ name: "default", force: false });
    libraryOpenRef.current = false;
    setIsLibraryOpen(false);
    setExportOpen(false);
    setIsScreenshotCaptureActive(true);
  }, [api, isScreenshotBusy]);

  const cancelScreenshotCapture = useCallback(() => {
    setIsScreenshotCaptureActive(false);
    api?.setToast({ message: "Area capture cancelled." });
  }, [api]);

  const finishScreenshotCapture = useCallback((rect: ViewportCaptureRect) => {
    const editorBounds = editorHostRef.current?.getBoundingClientRect();
    if (!api || !editorBounds) return cancelScreenshotCapture();
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
      ? persistentFilesForScene(scene, api.getFiles(), transientDarkPdfFileIdsRef.current)
      : api.getFiles();
    const rendered = exportScreenshotArea(api, sceneBounds, { elements, files });
    // ClipboardItem accepts a promised Blob, so the privileged write begins
    // synchronously inside the pointer-up gesture while rendering continues.
    const clipboardWrite = beginPngClipboardWrite(rendered.then((capture) => capture.blob));

    void (async () => {
      try {
        const capture = await rendered;
        const item: StoredScreenshot = {
          id: createLocalId(),
          createdAt: Date.now(),
          blob: capture.blob,
          width: capture.width,
          height: capture.height,
          sceneWidth: capture.sceneWidth,
          sceneHeight: capture.sceneHeight,
        };
        const nextItems = addScreenshotToLibrary(screenshotsRef.current, item);
        await persistScreenshots(nextItems);
        api.setToast({ message: clipboardCaptureToast(await clipboardWrite) });
      } catch (error) {
        setErrorMessage(`Area screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusyMessage(null);
        setIsScreenshotBusy(false);
      }
    })();
  }, [api, cancelScreenshotCapture, persistScreenshots]);

  const insertScreenshot = useCallback(async (
    item: StoredScreenshot,
    viewportPoint?: { clientX: number; clientY: number },
  ) => {
    if (!api) return;
    try {
      const dataURL = await pngBlobToDataUrl(item.blob);
      const appState = api.getAppState();
      const activeScene = currentSceneRef.current;
      let center: { x: number; y: number };
      if (viewportPoint) {
        center = viewportCoordsToSceneCoords(viewportPoint, appState);
      } else if (activeScene?.pdfPage) {
        const background = api.getSceneElements().find(
          (element) => element.id === activeScene.pdfPage?.backgroundElementId,
        );
        center = background
          ? { x: background.x + background.width / 2, y: background.y + background.height / 2 }
          : { x: activeScene.pdfPage.width / 2, y: activeScene.pdfPage.height / 2 };
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
      api.addFiles([file]);
      api.setActiveTool({ type: "selection" });
      api.updateScene({
        elements: [...api.getSceneElements(), image],
        appState: { selectedElementIds: { [image.id]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      api.setToast({ message: viewportPoint ? "Screenshot placed on the canvas." : "Screenshot inserted at the center." });
    } catch (error) {
      setErrorMessage(`Screenshot could not be inserted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [api]);

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
    const nextItems = screenshotsRef.current.filter((candidate) => candidate.id !== item.id);
    setIsScreenshotBusy(true);
    void persistScreenshots(nextItems)
      .then(() => api?.setToast({ message: "Screenshot deleted." }))
      .catch((error) => {
        setErrorMessage(`Screenshot could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setIsScreenshotBusy(false));
  }, [api, persistScreenshots]);

  const handleScreenshotDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(SCREENSHOT_DRAG_MIME)) return;
    if (event.target instanceof Element && event.target.closest(".default-sidebar")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleScreenshotDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(SCREENSHOT_DRAG_MIME)) return;
    if (event.target instanceof Element && event.target.closest(".default-sidebar")) return;
    event.preventDefault();
    event.stopPropagation();
    const screenshotId = event.dataTransfer.getData(SCREENSHOT_DRAG_MIME);
    const item = screenshotsRef.current.find((candidate) => candidate.id === screenshotId);
    if (item) void insertScreenshot(item, { clientX: event.clientX, clientY: event.clientY });
  }, [insertScreenshot]);

  useEffect(() => {
    if (workspaceMode !== "pdf" || presentation || pageIndex < 0) return;
    const navigatePdfWithArrowKeys = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      ) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(
        'input, textarea, select, button, [contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], [role="separator"]',
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
    isNavigationVisible,
    isPdfRailVisible,
    pdfRailWidth,
    workspaceMode,
  ]);

  const changeWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    pendingProjectSearchTargetRef.current = null;
    if (mode !== "slides") pendingSlideFrameActionRef.current = null;
    if (mode !== "pdf") {
      if (mode === "board") api?.setActiveTool({ type: "selection" });
      setWorkspaceMode(mode);
      if (!project) return;
      const targetSceneId = boardSceneId(project);
      if (targetSceneId === project.activeSceneId) return;
      if (targetSceneId) {
        openScene(targetSceneId);
        return;
      }
      const blank = createBlankProject();
      const scene = blank.scenes[blank.activeSceneId];
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      beginSceneHydration();
      setProject((current) => current ? {
        ...current,
        updatedAt: nowIso(),
        activeSceneId: scene.id,
        scenes: { ...current.scenes, [scene.id]: scene },
      } : current);
      return;
    }
    if (!project || !pdfScenes.length) return;
    setWorkspaceMode("pdf");
    if (!currentScene?.pdfPage) openScene(pdfScenes[0].id);
  }, [api, beginSceneHydration, currentScene?.pdfPage, openScene, pdfScenes, project]);

  useEffect(() => {
    const hiddenActiveMode = (workspaceMode === "slides" && !featurePreferences.slides)
      || (workspaceMode === "pdf" && !featurePreferences.pdf);
    if (hiddenActiveMode) changeWorkspaceMode("board");
  }, [
    changeWorkspaceMode,
    featurePreferences.pdf,
    featurePreferences.slides,
    workspaceMode,
  ]);

  const beginSlideFrameAction = useCallback((action: SlideFrameAction) => {
    if (!api || !project) return;
    setWorkspaceMode("slides");
    const targetSceneId = boardSceneId(project);

    if (!targetSceneId) {
      const blank = createBlankProject();
      const scene = blank.scenes[blank.activeSceneId];
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = { action, sceneId: scene.id };
      beginSceneHydration();
      setProject((current) => current ? {
        ...current,
        updatedAt: nowIso(),
        activeSceneId: scene.id,
        scenes: { ...current.scenes, [scene.id]: scene },
      } : current);
      return;
    }
    if (targetSceneId !== project.activeSceneId) {
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
  }, [api, beginSceneHydration, openScene, project, runSlideFrameAction]);

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
        appState: {
          selectedElementIds: {},
          selectedGroupIds: {},
          editingFrame: null,
        },
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
    setActiveSlideId(nextSlide?.id || null);
    api.setToast({ message: "Slide deleted. Its content is still on the board." });
    window.requestAnimationFrame(() => {
      if (ownsSuppression) {
        if (sceneHydrationGenerationRef.current !== suppressionGeneration) return;
        switchingSceneRef.current = false;
      }
      if (nextSlide) openSlide(nextSlide);
    });
  }, [api, commitLiveScenePersistence, openSlide, project]);

  const reorderSlides = useCallback((slideId: string, targetId: string) => {
    if (!project) return;
    const slideOrder = moveSlide(project.slideOrder, slideId, targetId);
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
      const scenes = Object.fromEntries(Object.entries(current.scenes).map(([sceneId, scene]) => {
        const elements = syncSlideFrameNames(
          scene.elements as unknown as readonly ExcalidrawElement[],
          slideOrder,
        );
        return [sceneId, { ...scene, elements: elements as unknown as readonly Record<string, unknown>[] }];
      }));
      return { ...current, updatedAt: nowIso(), scenes, slideOrder };
    });
  }, [api, project]);

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

  const deletePdfPage = useCallback((sceneId: string) => {
    if (!project) return;
    const initialScene = project.scenes[sceneId];
    if (!initialScene?.pdfPage) return;
    const initialOrder = reconcilePdfPageOrder(project);
    const initialPageIndex = initialOrder.indexOf(sceneId);
    if (initialPageIndex < 0) return;
    if (!window.confirm(`Delete output page ${initialPageIndex + 1}? This removes the page and its annotations from the project.`)) return;

    // Keep deletion as an explicit scene-persistence boundary, matching page
    // addition and every other scene switch. This also prevents an unrelated
    // pending update from being merged after the scene map has changed.
    const currentProject = commitLiveScenePersistence(sceneId);
    if (!currentProject) return;
    const scene = currentProject.scenes[sceneId];
    if (!scene?.pdfPage) return;
    const order = reconcilePdfPageOrder(currentProject);
    const pageIndex = order.indexOf(sceneId);
    if (pageIndex < 0) return;

    const remainingOrder = order.filter((candidate) => candidate !== sceneId);
    let nextSceneId = remainingOrder[Math.min(pageIndex, remainingOrder.length - 1)] || boardSceneId(currentProject);
    let replacementScene: SerializedScene | null = null;
    if (!nextSceneId) {
      const blank = createBlankProject();
      nextSceneId = blank.activeSceneId;
      replacementScene = blank.scenes[blank.activeSceneId];
    }
    const documentId = scene.pdfPage.documentId;
    const documentStillUsed = Object.values(currentProject.scenes).some(
      (candidate) => candidate.id !== sceneId && candidate.pdfPage?.documentId === documentId,
    );

    const activeSceneWillChange = nextSceneId !== currentProject.activeSceneId;
    if (activeSceneWillChange) {
      beginSceneHydration();
      pendingFrameIdRef.current = null;
      pendingProjectSearchTargetRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = null;
    }
    setProject((current) => {
      if (!current?.scenes[sceneId]) return current;
      const scenes = { ...current.scenes };
      delete scenes[sceneId];
      if (replacementScene) scenes[replacementScene.id] = replacementScene;
      const pdfDocuments = { ...current.pdfDocuments };
      if (!documentStillUsed) delete pdfDocuments[documentId];
      return {
        ...current,
        updatedAt: nowIso(),
        activeSceneId: nextSceneId,
        scenes,
        slideOrder: current.slideOrder.filter((slide) => slide.sceneId !== sceneId),
        pdfPageOrder: remainingOrder,
        pdfDocuments,
      };
    });
    if (!documentStillUsed) {
      setPdfBytes((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
    }
    if (!remainingOrder.length) setWorkspaceMode("board");
  }, [beginSceneHydration, commitLiveScenePersistence, project]);

  const addPdfPage = useCallback(async () => {
    const workspace = currentScene?.pdfPage;
    if (!workspace || !project) return;
    const insertAfterId = project.activeSceneId;
    setErrorMessage(null);
    setBusyMessage("Adding a blank PDF page…");
    try {
      const [{ importPdf }, { createBlankPdfFile }] = await Promise.all([
        import("./lib/pdf/import-pdf"),
        import("./lib/pdf/create-blank-page"),
      ]);
      const imported = await importPdf(await createBlankPdfFile(workspace.width, workspace.height));
      const importedScene = imported.scenes[0];
      const scene = { ...importedScene, name: "Blank page" };
      const source = { ...imported.source, name: "Blank page" };
      const current = commitPendingScenePersistence();
      if (!current) return;
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
      beginSceneHydration();
      pendingFrameIdRef.current = null;
      pendingCreatedFrameIdRef.current = null;
      pendingSlideFrameActionRef.current = null;
      pdfBytesRef.current = nextPdfBytes;
      projectRef.current = nextProject;
      setPdfBytes(nextPdfBytes);
      setProject(nextProject);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [beginSceneHydration, commitPendingScenePersistence, currentScene?.pdfPage, project]);

  const handlePaste = useCallback<NonNullable<ExcalidrawProps["onPaste"]>>((_data, event) => {
    const html = event?.clipboardData?.getData("text/html");
    if (html && /<(?:iframe|script|object|embed)\b/i.test(html)) {
      api?.setToast({ message: "Embedded web content is disabled." });
      return false;
    }
    return true;
  }, [api]);

  const handleEditorKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      !presentation
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
  }, [api, presentation, startBucketFill]);

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
  ]);

  if (!project || !currentScene) return <div className="loading-screen">Opening PatterDraw…</div>;

  return (
    <div
      ref={shellRef}
      className={`app-shell ${workspaceModeClassName(workspaceMode)} ${workspaceMode === "pdf" && !isPdfRailVisible ? "is-pdf-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfToolbarVisible ? "is-pdf-toolbar-hidden" : ""} ${!isNavigationVisible ? "is-nav-hidden" : ""} ${!isFooterVisible ? "is-footer-hidden" : ""} ${!featurePreferences.projectFind ? "is-project-find-disabled" : ""} ${!featurePreferences.library ? "is-library-disabled" : ""} ${featurePreferences.iconOnlyControls ? "is-icon-only-controls" : ""} ${presentation ? "is-presenting" : ""}`}
      data-theme={editorTheme}
      style={{ "--pdf-rail-width": `${pdfRailWidth}px` } as CSSProperties}
    >
      {!presentation && isNavigationVisible && (
        <TopBar
          title={project.title}
          status={saveStatus}
          featurePreferences={featurePreferences}
          themePreference={themePreference}
          onTitleChange={(title) => setProject((current) => current ? {
            ...current,
            title,
            titleMode: "custom",
            updatedAt: nowIso(),
          } : current)}
          onFeaturePreferenceChange={setFeaturePreference}
          onThemePreferenceChange={setThemePreference}
          onRestoreFeaturePreferences={restoreFeaturePreferences}
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
              Autosave could not be opened: {autosaveRecoveryDetail}. PatterDraw has not
              replaced that stored copy, and this temporary board is not saving automatically.
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
      {!presentation && workspaceMode === "slides" && (
        <SlideRail
          project={project}
          activeSlideId={activeSlideId}
          onAddSlide={addSlide}
          frameDrawingActive={isSlideFrameDrawingActive}
          onToggleFrameDrawing={toggleSlideFrameDrawing}
          onOpenSlide={openSlide}
          onMoveSlide={reorderSlides}
          onDeleteSlide={deleteSlide}
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
          thumbnailDataUrls={editorTheme === "dark" ? darkPdfPreviewUrls : undefined}
          onOpenPage={openScene}
          onMovePage={reorderPdfPage}
          onShiftPage={shiftPdfPagePosition}
          onAddPage={() => void addPdfPage()}
          onDeletePage={deletePdfPage}
          width={pdfRailWidth}
          onWidthChange={setPdfRailWidth}
          onHide={() => setIsPdfRailVisible(false)}
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
        <div
          ref={editorHostRef}
          className={`editor-host ${isScreenshotCaptureActive ? "is-screenshot-capture-active" : ""} ${isSlideFrameDrawingActive ? "is-slide-frame-drawing-active" : ""}`}
          onKeyDownCapture={handleEditorKeyDownCapture}
          onPointerDownCapture={handleEditorPointerDownCapture}
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
            aiEnabled={false}
            validateEmbeddable={false}
            renderEmbeddable={renderNoEmbeddable}
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
                  className="pdf-rail-show"
                  type="button"
                  onClick={() => setIsPdfRailVisible(true)}
                  aria-label="Show PDF pages"
                  title="Show PDF pages"
                >
                  <ShowPanelIcon />
                  <span className="icon-label">Pages</span>
                </button>
              )}
              {pageIndex >= 0 ? (
                <>
                  <button type="button" disabled={pageIndex === 0} onClick={() => openScene(pdfScenes[pageIndex - 1].id)} aria-label="Previous PDF page"><PreviousIcon /></button>
                  <span>Page {pageIndex + 1} of {pdfScenes.length}</span>
                  <button type="button" disabled={pageIndex >= pdfScenes.length - 1} onClick={() => openScene(pdfScenes[pageIndex + 1].id)} aria-label="Next PDF page"><NextIcon /></button>
                </>
              ) : workspaceMode === "slides"
                ? <span>{project.slideOrder.length} slide{project.slideOrder.length === 1 ? "" : "s"}</span>
                : <span>Board</span>}
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
        accept=".patterdraw,.canvasclassroom,.excalidraw,.pdf,application/pdf"
        onChange={(event) => event.target.files?.[0] && void handleFile(event.target.files[0])}
      />
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
          onInsert={insertMathTool}
          onStartInteraction={startMathInteraction}
        />
      ) : null}
      {busyMessage && <div className="busy-overlay" role="status"><span className="spinner" />{busyMessage}</div>}
      {errorMessage && (
        <div className="error-toast" role="alert"><span>{errorMessage}</span><button type="button" onClick={() => setErrorMessage(null)}>Dismiss</button></div>
      )}
    </div>
  );
}
