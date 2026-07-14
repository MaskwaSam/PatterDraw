import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  getCommonBounds,
  newElementWith,
  serializeAsJSON,
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
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import { TopBar } from "./components/TopBar";
import { SlideRail } from "./components/SlideRail";
import { PDF_RAIL_DEFAULT_WIDTH, PdfPageRail } from "./components/PdfPageRail";
import { PresentationOverlay } from "./components/PresentationOverlay";
import { StrokeWidthExtensions } from "./components/StrokeWidthExtensions";
import { EquationDialog } from "./components/EquationDialog";
import { MermaidDialog } from "./components/MermaidDialog";
import {
  EnterFullscreenIcon,
  ExitFullscreenIcon,
  InkIcon,
  MinusIcon,
  NextIcon,
  PlusIcon,
  PresentIcon,
  PreviousIcon,
  RedoIcon,
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
} from "./types";
import { createBlankProject } from "./types";
import { clearAutosave, loadAutosave, saveAutosave } from "./lib/persistence";
import { decodeProjectFile, encodeProjectFile } from "./lib/project-file";
import { downloadBlob, safeFileStem } from "./lib/download";
import { exportFullBoardPng } from "./lib/export-board";
import { createLocalId } from "./lib/id";
import type { RenderedLatex } from "./lib/latex/render-latex";
import type { RenderedMermaid } from "./lib/mermaid/safe-mermaid";
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
  focusSlide,
  moveSlide,
  reconcileSlides,
} from "./lib/slides";
import { isRemoteUrl, sanitizeProject, sanitizeScene } from "./lib/safety";
import { activateSlideFrameTool, addBlankSlideFrame } from "./lib/slide-frame-tool";
import {
  activatePresentationInk,
  DEFAULT_PRESENTATION_INK_COLOUR,
  DEFAULT_PRESENTATION_INK_WIDTH,
  type PresentationInkColour,
  type PresentationInkWidth,
} from "./lib/presentation-ink";
import { boardSceneId, workspaceModeClassName, type WorkspaceMode } from "./lib/workspace-mode";
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
type SlideFrameAction =
  | { kind: "add"; frameId: string; title: string }
  | { kind: "draw" };

const CLASSROOM_UI_OPTIONS: ExcalidrawProps["UIOptions"] = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    toggleTheme: false,
  },
  tools: { image: true },
};

const renderNoEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]> = () => null;

function nowIso(): string {
  return new Date().toISOString();
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
  const [exportOpen, setExportOpen] = useState(false);
  const [presentation, setPresentation] = useState<PresentationState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("board");
  const [pdfRailWidth, setPdfRailWidth] = useState(PDF_RAIL_DEFAULT_WIDTH);
  const [isPdfRailVisible, setIsPdfRailVisible] = useState(true);
  const [isPdfToolbarVisible, setIsPdfToolbarVisible] = useState(true);
  const [areSlideFramesVisible, setAreSlideFramesVisible] = useState(true);
  const [isNavigationVisible, setIsNavigationVisible] = useState(true);
  const [equationEditor, setEquationEditor] = useState<EquationEditorState | null>(null);
  const [mermaidEditor, setMermaidEditor] = useState<MermaidEditorState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const activeSceneIdRef = useRef<string | null>(null);
  const switchingSceneRef = useRef(false);
  const pendingFrameIdRef = useRef<string | null>(null);
  const pendingCreatedFrameIdRef = useRef<string | null>(null);
  const pendingSlideFrameActionRef = useRef<SlideFrameAction | null>(null);
  const slideFramesVisibleRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    loadAutosave()
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) {
          const framesVisible = loaded.project.slideFramesVisible !== false;
          slideFramesVisibleRef.current = framesVisible;
          setAreSlideFramesVisible(framesVisible);
          setProject(loaded.project);
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
    if (!project) return;
    activeSceneIdRef.current = project.activeSceneId;
  }, [project?.activeSceneId]);

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
    const toggleNavigation = (event: KeyboardEvent) => {
      if (event.repeat || !event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "h") return;
      event.preventDefault();
      setIsNavigationVisible((visible) => !visible);
    };
    window.addEventListener("keydown", toggleNavigation, true);
    return () => window.removeEventListener("keydown", toggleNavigation, true);
  }, [presentation]);

  useEffect(() => {
    if (!project) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      saveAutosave(project, pdfBytes)
        .then(() => setSaveStatus("saved"))
        .catch(() => setSaveStatus("error"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [project, pdfBytes]);

  const runSlideFrameAction = useCallback((action: SlideFrameAction) => {
    if (!api) return;
    slideFramesVisibleRef.current = true;
    api.updateFrameRendering({ enabled: true });
    setAreSlideFramesVisible(true);
    setProject((current) => current && current.slideFramesVisible === false ? {
      ...current,
      updatedAt: nowIso(),
      slideFramesVisible: true,
    } : current);
    if (action.kind === "draw") {
      activateSlideFrameTool(api);
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
    api.updateFrameRendering({ enabled: slideFramesVisibleRef.current });
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
    setZoom(Math.round(appState.zoom.value * 100));
    setStrokeWidth(appState.currentItemStrokeWidth);
    setAreSlideFramesVisible(appState.frameRendering.enabled);
    if (switchingSceneRef.current) return;
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
        .map((element) => element.link ? { ...element, link: null } : element) as readonly ExcalidrawElement[];
      switchingSceneRef.current = true;
      api?.updateScene({ elements: safeElements, captureUpdate: CaptureUpdateAction.NEVER });
      api?.setToast({ message: "Web links, embeds, and generated frames are disabled." });
      window.requestAnimationFrame(() => { switchingSceneRef.current = false; });
      return;
    }
    const sceneId = activeSceneIdRef.current;
    if (!sceneId) return;
    setProject((current) => {
      if (!current || !current.scenes[sceneId]) return current;
      const scene = serializedSceneFromChange(current.scenes[sceneId], elements, appState, files);
      const slideOrder = reconcileSlides(sceneId, elements, current.slideOrder);
      return {
        ...current,
        updatedAt: nowIso(),
        scenes: { ...current.scenes, [sceneId]: scene },
        slideOrder,
      };
    });
  }, [api]);

  const openLoadedProject = useCallback(async (loaded: LoadedClassroomProject) => {
    await clearAutosave(project || undefined);
    setPdfBytes(loaded.pdfBytes);
    const framesVisible = loaded.project.slideFramesVisible !== false;
    slideFramesVisibleRef.current = framesVisible;
    setAreSlideFramesVisible(framesVisible);
    setProject(loaded.project);
    setActiveSlideId(null);
    setWorkspaceMode("board");
    pendingCreatedFrameIdRef.current = null;
    pendingSlideFrameActionRef.current = null;
    setEquationEditor(null);
    setMermaidEditor(null);
  }, [project]);

  const handleFile = useCallback(async (file: File) => {
    setErrorMessage(null);
    setBusyMessage(`Opening ${file.name}…`);
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
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
      } else if (file.name.toLowerCase().endsWith(".canvasclassroom")) {
        await openLoadedProject(decodeProjectFile(new Uint8Array(await file.arrayBuffer())));
      } else if (file.name.toLowerCase().endsWith(".excalidraw")) {
        await openLoadedProject({ project: nativeExcalidrawProject(await file.text()), pdfBytes: {} });
      } else {
        throw new Error("Open a .canvasclassroom, .excalidraw, or PDF file.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyMessage(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [openLoadedProject]);

  const saveProjectFile = useCallback(() => {
    if (!project) return;
    try {
      const bytes = encodeProjectFile(project, pdfBytes);
      downloadBlob(
        new Blob([Uint8Array.from(bytes).buffer], { type: "application/vnd.canvas-classroom+zip" }),
        `${safeFileStem(project.title)}.canvasclassroom`,
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

  const setPresentationIndex = useCallback((index: number) => {
    if (!project?.slideOrder[index]) return;
    const slide = project.slideOrder[index];
    setPresentation((current) => ({
      index,
      tool: current?.tool || "laser",
      inkColour: current?.inkColour || DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: current?.inkWidth || DEFAULT_PRESENTATION_INK_WIDTH,
    }));
    openSlide(slide);
  }, [openSlide, project]);

  const startPresentation = useCallback(async () => {
    if (!project || !api || workspaceMode !== "slides") return;
    if (!project.slideOrder.length) {
      api.setToast({ message: "Add a slide first; each frame becomes a slide." });
      return;
    }
    const index = Math.max(0, project.slideOrder.findIndex((slide) => slide.id === activeSlideId));
    setPresentation({
      index,
      tool: "laser",
      inkColour: DEFAULT_PRESENTATION_INK_COLOUR,
      inkWidth: DEFAULT_PRESENTATION_INK_WIDTH,
    });
    api.setToast(null);
    api.updateFrameRendering({ outline: false, name: false, clip: true });
    api.setActiveTool({ type: "laser" });
    setPresentationIndex(index);
    try { await shellRef.current?.requestFullscreen(); } catch { /* Fullscreen can be browser-blocked. */ }
  }, [activeSlideId, api, project, setPresentationIndex, workspaceMode]);

  const stopPresentation = useCallback(() => {
    setPresentation(null);
    api?.updateFrameRendering({ outline: true, name: true, clip: true });
    api?.setActiveTool({ type: "selection" });
    if (document.fullscreenElement) void document.exitFullscreen();
  }, [api]);

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
    activatePresentationInk(api, presentation.inkColour, presentation.inkWidth);
  }, [api, presentation?.inkColour, presentation?.inkWidth, presentation?.tool]);

  const currentScene = project ? project.scenes[project.activeSceneId] : null;
  const pdfScenes = useMemo(() => project
    ? orderedPdfScenes(project)
    : [], [project]);
  const pageIndex = currentScene?.pdfPage
    ? pdfScenes.findIndex((scene) => scene.id === currentScene.id)
    : -1;

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

  const drawSlideFrame = useCallback(() => {
    beginSlideFrameAction({ kind: "draw" });
  }, [beginSlideFrameAction]);

  const toggleSlideFrames = useCallback(() => {
    if (!api) return;
    const visible = !api.getAppState().frameRendering.enabled;
    slideFramesVisibleRef.current = visible;
    api.updateFrameRendering({ enabled: visible });
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
    const text = event?.clipboardData?.getData("text/plain")?.trim();
    if (text && isRemoteUrl(text)) {
      api?.setToast({ message: "Web links and remote embeds are disabled in the classroom build." });
      return false;
    }
    const html = event?.clipboardData?.getData("text/html");
    if (html && /<(?:iframe|script|object|embed)\b/i.test(html)) {
      api?.setToast({ message: "Embedded web content is disabled." });
      return false;
    }
    return true;
  }, [api]);

  const handleLinkOpen = useCallback<NonNullable<ExcalidrawProps["onLinkOpen"]>>((_element, event) => {
    event.preventDefault();
    api?.setToast({ message: "Web links are disabled in the classroom build." });
  }, [api]);

  if (!project || !currentScene) return <div className="loading-screen">Opening Canvas Classroom…</div>;

  return (
    <div
      ref={shellRef}
      className={`app-shell ${workspaceModeClassName(workspaceMode)} ${workspaceMode === "pdf" && !isPdfRailVisible ? "is-pdf-rail-hidden" : ""} ${workspaceMode === "pdf" && !isPdfToolbarVisible ? "is-pdf-toolbar-hidden" : ""} ${!isNavigationVisible ? "is-nav-hidden" : ""} ${presentation ? "is-presenting" : ""}`}
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
          mode={workspaceMode}
          onModeChange={changeWorkspaceMode}
          pdfAvailable={pdfScenes.length > 0}
          onHide={() => setIsNavigationVisible(false)}
        />
      )}
      {!presentation && workspaceMode === "slides" && (
        <SlideRail
          project={project}
          activeSlideId={activeSlideId}
          onAddSlide={addSlide}
          onDrawFrame={drawSlideFrame}
          onOpenSlide={openSlide}
          onMoveSlide={(slideId, targetId) => setProject((current) => current ? { ...current, slideOrder: moveSlide(current.slideOrder, slideId, targetId) } : current)}
          framesVisible={areSlideFramesVisible}
          onToggleFrames={toggleSlideFrames}
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
          width={pdfRailWidth}
          onWidthChange={setPdfRailWidth}
          onHide={() => setIsPdfRailVisible(false)}
        />
      )}
      <main
        className="editor-region"
        data-presentation-zoom={presentation ? zoom : undefined}
        onPointerDownCapture={syncPresentationInkOnPointerDown}
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
        <div ref={editorHostRef} className="editor-host">
          <Excalidraw
            excalidrawAPI={setApi}
            onChange={handleChange}
            onPaste={handlePaste}
            onLinkOpen={handleLinkOpen}
            aiEnabled={false}
            validateEmbeddable={false}
            renderEmbeddable={renderNoEmbeddable}
            isCollaborating={false}
            theme="light"
            UIOptions={CLASSROOM_UI_OPTIONS}
          />
          {api && (
            <StrokeWidthExtensions
              api={api}
              editorHost={editorHostRef.current}
              strokeWidth={strokeWidth}
            />
          )}
        </div>
        {!presentation && (
          <footer className="statusbar">
            <div className="page-status">
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
            {workspaceMode !== "slides" ? (
              <div className="footer-zoom-controls" aria-label={`${workspaceMode === "pdf" ? "PDF" : "Board"} zoom controls`}>
                <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => clickEditorControl(".zoom-out-button")}><MinusIcon /></button>
                <button className="footer-reset-zoom" type="button" aria-label="Reset zoom" title="Reset zoom" onClick={() => clickEditorControl(".reset-zoom-button")}>{zoom}%</button>
                <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => clickEditorControl(".zoom-in-button")}><PlusIcon /></button>
              </div>
            ) : <span className="zoom-status">{zoom}%</span>}
            <div className="statusbar-actions">
              {workspaceMode === "slides" && (
                <button className="present-button" type="button" onClick={startPresentation} title="Start presentation">
                  <PresentIcon /><span>Present</span>
                </button>
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
        accept=".canvasclassroom,.excalidraw,.pdf,application/pdf"
        onChange={(event) => event.target.files?.[0] && void handleFile(event.target.files[0])}
      />
      {exportOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setExportOpen(false)}>
          <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="export-title">More exports</h2>
            <p>Export the current board, presentation frames, or imported PDF pages.</p>
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
            <button className="dialog-cancel" type="button" onClick={() => setExportOpen(false)}>Cancel</button>
          </section>
        </div>
      )}
      {equationEditor && (
        <EquationDialog
          initialSource={equationEditor.initialSource}
          editing={!!equationEditor.targetId}
          onCancel={() => setEquationEditor(null)}
          onSubmit={insertEquation}
        />
      )}
      {mermaidEditor && (
        <MermaidDialog
          initialSource={mermaidEditor.initialSource}
          editing={!!mermaidEditor.targetDiagramId}
          onCancel={() => setMermaidEditor(null)}
          onSubmit={insertMermaid}
        />
      )}
      {busyMessage && <div className="busy-overlay" role="status"><span className="spinner" />{busyMessage}</div>}
      {errorMessage && (
        <div className="error-toast" role="alert"><span>{errorMessage}</span><button type="button" onClick={() => setErrorMessage(null)}>Dismiss</button></div>
      )}
    </div>
  );
}
