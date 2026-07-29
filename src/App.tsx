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
import { EquationDialog } from "./components/EquationDialog";
import { MermaidDialog } from "./components/MermaidDialog";
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
import { clearAutosave, loadAutosave, saveAutosave } from "./lib/persistence";
import { loadLibraryItems, saveLibraryItems } from "./lib/library-persistence";
import { decodeProjectFile, encodeProjectFile } from "./lib/project-file";
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
import { importPdf } from "./lib/pdf/import-pdf";
import { createBlankPdfFile } from "./lib/pdf/create-blank-page";
import {
  movePdfPage,
  orderedPdfScenes,
  reconcilePdfPageOrder,
  shiftPdfPage,
  type PdfPageDropEdge,
} from "./lib/pdf/page-order";
import {
  exportAnnotatedPdf,
  exportSlidesPdf,
  type PdfExportMode,
} from "./lib/pdf/export-pdf";
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
import { MAX_PROJECT_BYTES, sanitizeProject, sanitizeScene } from "./lib/safety";
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
type SlideFrameGesture = {
  current: SlideFramePoint;
  origin: SlideFramePoint;
  pointerId: number;
};
type PendingPresentationTransition = { frameId: string; animate: boolean; durationMs: number };
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
const PERSONAL_LIBRARY_SIDEBAR_TAB = "library";
type LibrarySidebarTab = typeof PERSONAL_LIBRARY_SIDEBAR_TAB | typeof SCREENSHOT_SIDEBAR_TAB;

const renderNoEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]> = () => null;

function nowIso(): string {
  return new Date().toISOString();
}

function screenshotDownloadName(createdAt: number): string {
  const timestamp = new Date(createdAt).toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z").replaceAll(":", "-");
  return `classroom-screenshot-${timestamp}.png`;
}

function clipboardCaptureToast(result: ClipboardWriteResult): string {
  if (result === "success") return "Screenshot copied to the clipboard and saved to the Screenshot Library.";
  if (result === "denied") return "Screenshot saved. Clipboard permission was denied; use Copy in the Screenshot Library to retry.";
  if (result === "unsupported") return "Screenshot saved. Image clipboard access is unavailable in this browser.";
  return "Screenshot saved, but it could not be copied. Use Copy in the Screenshot Library to retry.";
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
  return sanitizeScene({
    ...previous,
    elements: exported.elements,
    appState: exported.appState,
    files: exported.files || {},
  });
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
  project.slideOrder = reconcileSlides(
    sceneId,
    project.scenes[sceneId].elements as unknown as ExcalidrawElement[],
    [],
  );
  return sanitizeProject(project);
}

export default function App() {
  const [project, setProject] = useState<ClassroomProject | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Record<PdfDocumentId, Uint8Array>>({});
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
  const [isFooterVisible, setIsFooterVisible] = useState(true);
  const [equationEditor, setEquationEditor] = useState<EquationEditorState | null>(null);
  const [mermaidEditor, setMermaidEditor] = useState<MermaidEditorState | null>(null);
  const [isMathToolsOpen, setIsMathToolsOpen] = useState(false);
  const [mathToolEdit, setMathToolEdit] = useState<MathToolEditState | null>(null);
  const [mathInteraction, setMathInteraction] = useState<MathInteractionState | null>(null);
  const [isLassoActive, setIsLassoActive] = useState(false);
  const [lassoGeometryFactory, setLassoGeometryFactory] = useState<
    ((elements: readonly ExcalidrawElement[]) => LassoGeometrySnapshot) | null
  >(null);
  const [lassoInitialSelection, setLassoInitialSelection] = useState<LassoInitialSelection | null>(null);
  const [probabilitySelection, setProbabilitySelection] = useState<ProbabilitySelectionSummary | null>(null);
  const [isProbabilitySpinning, setIsProbabilitySpinning] = useState(false);
  const [spinnerPointerAnimations, setSpinnerPointerAnimations] = useState<SpinnerPointerAnimation[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const insertTriggerRef = useRef<HTMLButtonElement>(null);
  const exportOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const currentSceneRef = useRef<SerializedScene | null>(null);
  const activeSceneIdRef = useRef<string | null>(null);
  const switchingSceneRef = useRef(false);
  const pendingFrameIdRef = useRef<string | null>(null);
  const pendingPresentationTransitionRef = useRef<PendingPresentationTransition | null>(null);
  const pendingCreatedFrameIdRef = useRef<string | null>(null);
  const pendingSlideFrameActionRef = useRef<SlideFrameAction | null>(null);
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
  const lastLibraryTabRef = useRef<LibrarySidebarTab>(PERSONAL_LIBRARY_SIDEBAR_TAB);
  const screenshotsRef = useRef<StoredScreenshot[]>([]);
  const restoreExportOptionsFocusRef = useRef(false);
  const probabilityRandomizingRef = useRef(false);
  const lassoActiveRef = useRef(false);
  const preparedLassoSelectionRef = useRef<LassoInitialSelection | null>(null);
  const autosaveSnapshotRef = useRef<LoadedClassroomProject | null>(null);
  const autosaveDirtyRef = useRef(false);
  const autosaveSavingRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveLastQueuedAtRef = useRef(0);
  const autosaveQueueRef = useRef<Promise<void>>(Promise.resolve());
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
  const flushAutosave = useCallback(() => {
    const snapshot = autosaveSnapshotRef.current;
    if (!snapshot || !autosaveDirtyRef.current) return;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    autosaveDirtyRef.current = false;
    autosaveSavingRef.current = true;
    autosaveLastQueuedAtRef.current = Date.now();
    setSaveStatus("saving");
    const queuedSave = autosaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveAutosave(snapshot.project, snapshot.pdfBytes));
    autosaveQueueRef.current = queuedSave;
    queuedSave.then(
      () => {
        if (autosaveQueueRef.current !== queuedSave) return;
        autosaveSavingRef.current = false;
        if (!autosaveDirtyRef.current) setSaveStatus("saved");
      },
      () => {
        if (autosaveQueueRef.current !== queuedSave) return;
        autosaveSavingRef.current = false;
        // Keep the newest snapshot eligible for a later interaction/page-exit
        // flush. Retrying here would create a tight loop while storage remains
        // unavailable; flushAutosave always reads autosaveSnapshotRef so a
        // newer edit is retried instead of this captured snapshot.
        autosaveDirtyRef.current = true;
        setSaveStatus("error");
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
          slideFramesVisibleRef.current = framesVisible;
          setAreSlideFramesVisible(framesVisible);
          setProject(projectForBoardStartup(loaded.project));
          setPdfBytes(loaded.pdfBytes);
        } else {
          setProject(createBlankProject());
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(`Autosave could not be opened: ${error instanceof Error ? error.message : String(error)}`);
          setProject(createBlankProject());
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
      event.preventDefault();
      if (key === "h") setIsNavigationVisible((visible) => !visible);
      else setIsFooterVisible((visible) => !visible);
    };
    window.addEventListener("keydown", toggleChrome, true);
    return () => window.removeEventListener("keydown", toggleChrome, true);
  }, [presentation]);

  useLayoutEffect(() => {
    if (!project) return;
    autosaveSnapshotRef.current = { project, pdfBytes };
    autosaveDirtyRef.current = true;
    setSaveStatus("saving");
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);

    const elapsed = Date.now() - autosaveLastQueuedAtRef.current;
    if (!autosaveSavingRef.current && elapsed >= 700) {
      flushAutosave();
      return;
    }
    autosaveTimerRef.current = window.setTimeout(flushAutosave, Math.max(0, 700 - elapsed));
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [project, pdfBytes, flushAutosave]);

  useEffect(() => {
    const flushAfterInteraction = () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = window.setTimeout(flushAutosave, 0);
    };
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
        flushAfterInteraction();
      }
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushAutosave();
    };
    const flushBeforePageExit = (event: BeforeUnloadEvent) => {
      if (!autosaveDirtyRef.current && !autosaveSavingRef.current) return;
      flushAutosave();
      event.preventDefault();
      event.returnValue = "";
    };
    const flushOnPageHide = () => flushAutosave();
    window.addEventListener("pointerup", flushAfterInteraction);
    window.addEventListener("click", flushAfterInteraction);
    window.addEventListener("keyup", flushAfterMutationKey);
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("beforeunload", flushBeforePageExit);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pointerup", flushAfterInteraction);
      window.removeEventListener("click", flushAfterInteraction);
      window.removeEventListener("keyup", flushAfterMutationKey);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("beforeunload", flushBeforePageExit);
      window.removeEventListener("pagehide", flushOnPageHide);
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    };
  }, [flushAutosave]);

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

  const loadSceneIntoEditor = useCallback((scene: SerializedScene) => {
    if (!api) return;
    switchingSceneRef.current = true;
    const files = scene.files as unknown as BinaryFiles;
    api.addFiles(Object.values(files));
    api.updateScene({
      elements: scene.elements as unknown as readonly ExcalidrawElement[],
      appState: scene.appState as unknown as AppState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.updateFrameRendering({ enabled: slideFramesVisibleRef.current, clip: false });
    api.history.clear();
    window.requestAnimationFrame(() => {
      switchingSceneRef.current = false;
      if (pendingFrameIdRef.current) {
        focusSlide(api, pendingFrameIdRef.current, true);
        pendingFrameIdRef.current = null;
      }
      if (pendingSlideFrameActionRef.current) {
        const action = pendingSlideFrameActionRef.current;
        pendingSlideFrameActionRef.current = null;
        runSlideFrameAction(action);
      }
    });
  }, [api, runSlideFrameAction]);

  useEffect(() => {
    if (!api || !project) return;
    const scene = project.scenes[project.activeSceneId];
    if (scene) loadSceneIntoEditor(scene);
  }, [api, project?.id, project?.activeSceneId, loadSceneIntoEditor]);

  useEffect(() => {
    const frameId = pendingCreatedFrameIdRef.current;
    if (!frameId || !project) return;
    const slide = project.slideOrder.find((candidate) => candidate.frameId === frameId);
    if (!slide) return;
    pendingCreatedFrameIdRef.current = null;
    setActiveSlideId(slide.id);
  }, [project?.slideOrder]);

  const handleChange = useCallback<NonNullable<ExcalidrawProps["onChange"]>>((elements, appState, files) => {
    const isNativeImageExportOpen = appState.openDialog?.name === "imageExport";
    if (nativeImageExportOpenRef.current && !isNativeImageExportOpen && restoreExportOptionsFocusRef.current) {
      restoreExportOptionsFocusRef.current = false;
      window.requestAnimationFrame(() => exportOptionsTriggerRef.current?.focus());
    }
    nativeImageExportOpenRef.current = isNativeImageExportOpen;
    const sidebarTab = appState.openSidebar?.name === "default" ? appState.openSidebar.tab : undefined;
    if (sidebarTab === PERSONAL_LIBRARY_SIDEBAR_TAB || sidebarTab === SCREENSHOT_SIDEBAR_TAB) {
      lastLibraryTabRef.current = sidebarTab;
    }
    const isNativeLibraryOpen = appState.openSidebar?.name === "default"
      && (sidebarTab === PERSONAL_LIBRARY_SIDEBAR_TAB || sidebarTab === SCREENSHOT_SIDEBAR_TAB);
    if (libraryOpenRef.current !== isNativeLibraryOpen) {
      libraryOpenRef.current = isNativeLibraryOpen;
      setIsLibraryOpen(isNativeLibraryOpen);
    }
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
    const activeToolType = appState.activeTool.type;
    if (
      lassoActiveRef.current
      && !(activeToolType === "custom" && appState.activeTool.customType === CLASSROOM_LASSO_TOOL)
    ) {
      lassoActiveRef.current = false;
      setIsLassoActive(false);
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
      switchingSceneRef.current = true;
      api?.updateScene({ elements: safeElements, captureUpdate: CaptureUpdateAction.NEVER });
      api?.setToast({ message: "External links and web embeds are disabled in PatterDraw." });
      window.requestAnimationFrame(() => { switchingSceneRef.current = false; });
      return;
    }
    const sceneId = activeSceneIdRef.current;
    if (!sceneId) return;
    const persistedScene = currentSceneRef.current?.id === sceneId
      ? currentSceneRef.current
      : null;
    const backgroundSafeElements = persistedScene
      ? canonicalizePdfBackground(
        persistedScene,
        elements as unknown as readonly Record<string, unknown>[],
      ) as unknown as readonly ExcalidrawElement[]
      : elements;
    const detachedElements = detachElementsFromSlideFrames(backgroundSafeElements);
    setProject((current) => {
      if (!current || !current.scenes[sceneId]) return current;
      const slideOrder = reconcileSlides(sceneId, detachedElements, current.slideOrder);
      const namedElements = syncSlideFrameNames(detachedElements, slideOrder);
      const scene = serializedSceneFromChange(current.scenes[sceneId], namedElements, appState, files);
      return {
        ...current,
        updatedAt: nowIso(),
        scenes: { ...current.scenes, [sceneId]: scene },
        slideOrder,
      };
    });
    const elementGestureInProgress = !!(
      appState.newElement
      || appState.resizingElement
      || appState.isResizing
      || appState.isRotating
      || appState.multiElement
    );
    if (api && detachedElements !== elements && !elementGestureInProgress) {
      window.cancelAnimationFrame(slideDetachmentFrameRef.current);
      slideDetachmentFrameRef.current = window.requestAnimationFrame(() => {
        if (switchingSceneRef.current || activeSceneIdRef.current !== sceneId) return;
        const liveElements = api.getSceneElements();
        const liveScene = currentSceneRef.current?.id === sceneId
          ? currentSceneRef.current
          : null;
        const liveBackgroundSafeElements = liveScene
          ? canonicalizePdfBackground(
            liveScene,
            liveElements as unknown as readonly Record<string, unknown>[],
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
  }, [api]);

  const toggleLibrary = useCallback(() => {
    if (!api) return;
    const nextOpen = api.toggleSidebar({ name: "default", tab: lastLibraryTabRef.current });
    libraryOpenRef.current = nextOpen;
    setIsLibraryOpen(nextOpen);
  }, [api]);

  const handleLibraryChange = useCallback((libraryItems: LibraryItems) => {
    void saveLibraryItems(libraryItems).catch((error) => {
      setErrorMessage(`Personal library could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, []);

  const openLoadedProject = useCallback(async (loaded: LoadedClassroomProject) => {
    autosaveDirtyRef.current = false;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await autosaveQueueRef.current.catch(() => undefined);
    autosaveSavingRef.current = false;
    await clearAutosave(project || undefined);
    setPdfBytes(loaded.pdfBytes);
    const framesVisible = loaded.project.slideFramesVisible !== false;
    slideFramesVisibleRef.current = framesVisible;
    setAreSlideFramesVisible(framesVisible);
    setProject(projectForBoardStartup(loaded.project));
    setActiveSlideId(null);
    setWorkspaceMode("board");
    pendingCreatedFrameIdRef.current = null;
    pendingSlideFrameActionRef.current = null;
    setEquationEditor(null);
    setMermaidEditor(null);
    setMathToolEdit(null);
    setIsMathToolsOpen(false);
  }, [project]);

  const handleFile = useCallback(async (file: File) => {
    setErrorMessage(null);
    setBusyMessage(`Opening ${file.name}…`);
    try {
      const isPdfFile = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (!isPdfFile && file.size > MAX_PROJECT_BYTES) {
        throw new Error("The selected project is too large to open safely.");
      }
      if (isPdfFile) {
        const imported = await importPdf(file);
        const scenes = Object.fromEntries(imported.scenes.map((scene) => [scene.id, scene]));
        const importedPageIds = imported.scenes.map((scene) => scene.id);
        setPdfBytes((current) => ({ ...current, [imported.source.id]: imported.bytes }));
        setWorkspaceMode("pdf");
        setEquationEditor(null);
        setMermaidEditor(null);
        setProject((current) => {
          const base = current || createBlankProject();
          return {
            ...base,
            updatedAt: nowIso(),
            activeSceneId: imported.scenes[0].id,
            scenes: { ...base.scenes, ...scenes },
            pdfPageOrder: [...reconcilePdfPageOrder(base), ...importedPageIds],
            pdfDocuments: { ...base.pdfDocuments, [imported.source.id]: imported.source },
          };
        });
      } else if (
        file.name.toLowerCase().endsWith(".patterdraw")
        || file.name.toLowerCase().endsWith(".canvasclassroom")
      ) {
        await openLoadedProject(await decodeProjectFile(new Uint8Array(await file.arrayBuffer())));
      } else if (file.name.toLowerCase().endsWith(".excalidraw")) {
        await openLoadedProject({ project: nativeExcalidrawProject(await file.text()), pdfBytes: {} });
      } else {
        throw new Error("Open a .patterdraw, legacy .canvasclassroom, .excalidraw, or PDF file.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [openLoadedProject]);

  const saveProjectFile = useCallback(async () => {
    if (!project) return;
    try {
      const bytes = await encodeProjectFile(project, pdfBytes);
      downloadBlob(
        new Blob([Uint8Array.from(bytes).buffer], { type: "application/vnd.patterdraw+zip" }),
        `${safeFileStem(project.title)}.patterdraw`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, [pdfBytes, project]);

  const runPdfExport = useCallback(async (kind: "slides" | PdfExportMode) => {
    if (!project) return;
    setExportOpen(false);
    setBusyMessage(kind === "slides" ? "Exporting slides…" : "Exporting annotated PDF…");
    try {
      const blob = kind === "slides"
        ? await exportSlidesPdf(project)
        : await exportAnnotatedPdf(project, pdfBytes, kind);
      const suffix = kind === "slides" ? "slides" : kind === "expand" ? "annotated-expanded" : "annotated-openboard-fit";
      downloadBlob(blob, `${safeFileStem(project.title)}-${suffix}.pdf`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [pdfBytes, project]);

  const runFullBoardExport = useCallback(async () => {
    if (!api || !project) return;
    setExportOpen(false);
    setBusyMessage("Exporting the full board…");
    try {
      const { blob, scale } = await exportFullBoardPng(api);
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
    nativeImageExportOpenRef.current = true;
    restoreExportOptionsFocusRef.current = true;
    api.updateScene({
      appState: {
        name: project.title,
        openDialog: { name: "imageExport" },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
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
    if (frameId) pendingFrameIdRef.current = frameId;
    if (sceneId !== activeSceneIdRef.current) switchingSceneRef.current = true;
    setProject((current) => current ? { ...current, activeSceneId: sceneId } : current);
    if (api && sceneId === activeSceneIdRef.current && frameId) {
      focusSlide(api, frameId);
      pendingFrameIdRef.current = null;
    }
  }, [api]);

  const openSlide = useCallback((slide: ClassroomSlide) => {
    setActiveSlideId(slide.id);
    openScene(slide.sceneId, slide.frameId);
  }, [openScene]);

  const setPresentationIndex = useCallback((index: number, allowMorph = true) => {
    if (!project?.slideOrder[index]) return;
    const slide = project.slideOrder[index];
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pendingPresentationTransitionRef.current = {
      frameId: slide.frameId,
      animate: allowMorph && project.slideMorphEnabled === true && !prefersReducedMotion,
      durationMs: normalizeSlideMorphDurationMs(project.slideMorphDurationMs),
    };
    setPresentation((current) => ({
      index,
      tool: current?.tool || "laser",
      inkColour: current?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: current?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
    }));
    setActiveSlideId(slide.id);
    if (slide.sceneId !== activeSceneIdRef.current) switchingSceneRef.current = true;
    setProject((current) => current && current.activeSceneId !== slide.sceneId
      ? { ...current, activeSceneId: slide.sceneId }
      : current);
  }, [project]);

  const startPresentation = useCallback(async () => {
    if (!project || !api || workspaceMode !== "slides") return;
    if (!project.slideOrder.length) {
      api.setToast({ message: "Add a slide first; each frame becomes a slide." });
      return;
    }
    const index = Math.max(0, project.slideOrder.findIndex((slide) => slide.id === activeSlideId));
    api.setToast(null);
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
  const pdfScenes = useMemo(() => project
    ? orderedPdfScenes(project)
    : [], [project]);
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
    const rendered = exportScreenshotArea(api, sceneBounds);
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
      switchingSceneRef.current = true;
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
  }, [api, currentScene?.pdfPage, openScene, pdfScenes, project]);

  const beginSlideFrameAction = useCallback((action: SlideFrameAction) => {
    if (!api || !project) return;
    setWorkspaceMode("slides");
    const targetSceneId = boardSceneId(project);

    if (!targetSceneId) {
      const blank = createBlankProject();
      const scene = blank.scenes[blank.activeSceneId];
      pendingSlideFrameActionRef.current = action;
      switchingSceneRef.current = true;
      setProject((current) => current ? {
        ...current,
        updatedAt: nowIso(),
        activeSceneId: scene.id,
        scenes: { ...current.scenes, [scene.id]: scene },
      } : current);
      return;
    }
    if (targetSceneId !== project.activeSceneId) {
      pendingSlideFrameActionRef.current = action;
      openScene(targetSceneId);
      return;
    }
    if (switchingSceneRef.current) {
      pendingSlideFrameActionRef.current = action;
      return;
    }
    runSlideFrameAction(action);
  }, [api, openScene, project, runSlideFrameAction]);

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

    const slideIndex = project.slideOrder.findIndex((candidate) => candidate.id === slide.id);
    const remainingSlides = removeSlide(project.slideOrder, slide.id);
    const nextSlide = remainingSlides[Math.min(slideIndex, remainingSlides.length - 1)] || null;
    const isActiveScene = slide.sceneId === activeSceneIdRef.current;

    if (isActiveScene) {
      switchingSceneRef.current = true;
      const nextElements = syncSlideFrameNames(
        deleteSlideBoundary(api.getSceneElements(), slide.frameId),
        remainingSlides,
      );
      api.updateScene({
        elements: nextElements,
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
      switchingSceneRef.current = false;
      if (nextSlide) openSlide(nextSlide);
    });
  }, [api, openSlide, project]);

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
    const scene = project.scenes[sceneId];
    if (!scene?.pdfPage) return;
    const order = reconcilePdfPageOrder(project);
    const pageIndex = order.indexOf(sceneId);
    if (pageIndex < 0) return;
    if (!window.confirm(`Delete output page ${pageIndex + 1}? This removes the page and its annotations from the project.`)) return;

    const remainingOrder = order.filter((candidate) => candidate !== sceneId);
    let nextSceneId = remainingOrder[Math.min(pageIndex, remainingOrder.length - 1)] || boardSceneId(project);
    let replacementScene: SerializedScene | null = null;
    if (!nextSceneId) {
      const blank = createBlankProject();
      nextSceneId = blank.activeSceneId;
      replacementScene = blank.scenes[blank.activeSceneId];
    }
    const documentId = scene.pdfPage.documentId;
    const documentStillUsed = Object.values(project.scenes).some(
      (candidate) => candidate.id !== sceneId && candidate.pdfPage?.documentId === documentId,
    );

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
  }, [project]);

  const addPdfPage = useCallback(async () => {
    const workspace = currentScene?.pdfPage;
    if (!workspace || !project) return;
    const insertAfterId = project.activeSceneId;
    setErrorMessage(null);
    setBusyMessage("Adding a blank PDF page…");
    try {
      const imported = await importPdf(await createBlankPdfFile(workspace.width, workspace.height));
      const importedScene = imported.scenes[0];
      const scene = { ...importedScene, name: "Blank page" };
      const source = { ...imported.source, name: "Blank page" };
      setPdfBytes((current) => ({ ...current, [source.id]: imported.bytes }));
      setProject((current) => {
        if (!current) return current;
        const order = reconcilePdfPageOrder(current);
        const currentIndex = order.indexOf(insertAfterId);
        const insertAt = currentIndex < 0 ? order.length : currentIndex + 1;
        return {
          ...current,
          updatedAt: nowIso(),
          activeSceneId: scene.id,
          scenes: { ...current.scenes, [scene.id]: scene },
          pdfPageOrder: [...order.slice(0, insertAt), scene.id, ...order.slice(insertAt)],
          pdfDocuments: { ...current.pdfDocuments, [source.id]: source },
        };
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
    }
  }, [currentScene?.pdfPage, project]);

  const handlePaste = useCallback<NonNullable<ExcalidrawProps["onPaste"]>>((_data, event) => {
    const html = event?.clipboardData?.getData("text/html");
    if (html && /<(?:iframe|script|object|embed)\b/i.test(html)) {
      api?.setToast({ message: "Embedded web content is disabled." });
      return false;
    }
    return true;
  }, [api]);

  const handleEditorKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      api?.setToast({ message: "External links are disabled in PatterDraw." });
    }
  }, [api]);

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

  const screenshotSidebar = useMemo(() => (
    <DefaultSidebar>
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
    </DefaultSidebar>
  ), [
    copyScreenshot,
    deleteScreenshot,
    downloadScreenshot,
    insertScreenshot,
    isScreenshotBusy,
    isScreenshotLibraryLoading,
    screenshots,
    startScreenshotCapture,
  ]);

  if (!project || !currentScene) return <div className="loading-screen">Opening PatterDraw…</div>;

  return (
    <div
      ref={shellRef}
      className={`app-shell ${workspaceModeClassName(workspaceMode)} ${workspaceMode === "pdf" && !isPdfRailVisible ? "is-pdf-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfToolbarVisible ? "is-pdf-toolbar-hidden" : ""} ${!isNavigationVisible ? "is-nav-hidden" : ""} ${!isFooterVisible ? "is-footer-hidden" : ""} ${presentation ? "is-presenting" : ""}`}
      style={{ "--pdf-rail-width": `${pdfRailWidth}px` } as CSSProperties}
    >
      {!presentation && isNavigationVisible && (
        <TopBar
          title={project.title}
          status={saveStatus}
          onTitleChange={(title) => setProject((current) => current ? { ...current, title, updatedAt: nowIso() } : current)}
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
          onHide={() => setIsNavigationVisible(false)}
        />
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
            onClick={() => setIsFooterVisible(true)}
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
            theme="light"
            UIOptions={CLASSROOM_UI_OPTIONS}
          >
            {screenshotSidebar}
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
              <MathToolsMenuExtension
                editorHost={editorHostRef.current}
                onOpen={openMathTools}
                onPrepareLasso={prepareLasso}
                onStartLasso={startLasso}
              />
              {!presentation && !mathInteraction && probabilitySelection && (
                <ProbabilityRandomizer
                  isSpinning={isProbabilitySpinning}
                  summary={probabilitySelection}
                  onRandomize={randomizeSelectedProbabilityPieces}
                />
              )}
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
                onClick={() => setIsFooterVisible(false)}
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
                  <span>Pages</span>
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
                    <PresentIcon /><span>Present</span>
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
              <button type="button" onClick={() => void runPdfExport("slides")} disabled={!project.slideOrder.length}>
                <strong>Presentation PDF</strong><span>One ordered frame per slide.</span>
              </button>
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
      {isMathToolsOpen && (
        <MathToolsDialog
          initialConfiguration={mathToolEdit?.initialConfiguration}
          onCancel={closeMathTools}
          onInsert={insertMathTool}
          onStartInteraction={startMathInteraction}
        />
      )}
      {busyMessage && <div className="busy-overlay" role="status"><span className="spinner" />{busyMessage}</div>}
      {errorMessage && (
        <div className="error-toast" role="alert"><span>{errorMessage}</span><button type="button" onClick={() => setErrorMessage(null)}>Dismiss</button></div>
      )}
    </div>
  );
}
