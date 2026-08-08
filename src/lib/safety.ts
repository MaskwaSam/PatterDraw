import {
  DEFAULT_PROJECT_TITLE,
  type ClassroomProject,
  type SerializedScene,
  type SlideFrameAspectRatio,
} from "../types";
import { sanitizeClassroomMathToolMetadata } from "./math-tools/types";
import { canonicalizePdfBackground } from "./pdf/background";
import { reconcilePdfPageOrder } from "./pdf/page-order";
import { MAX_PDF_PAGE_EDGE_POINTS } from "./pdf/raster-limits";
import {
  MAX_SLIDE_MORPH_DURATION_MS,
  MIN_SLIDE_MORPH_DURATION_MS,
  normalizeSlideMorphDurationMs,
} from "./slide-transition";
import {
  CLASSROOM_SLIDE_CUSTOM_DATA_KEY,
  CLASSROOM_SLIDE_METADATA,
  reconcileSlideTitleModes,
  renumberAutomaticSlides,
  sanitizeClassroomSlideMetadata,
} from "./slides";

export const MAX_PROJECT_BYTES = 150 * 1024 * 1024;
export const MAX_PDF_BYTES = 75 * 1024 * 1024;
export const MAX_PDF_PAGES = 250;

const embeddedImageDataUrl = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,([a-z\d+/]*={0,2})$/i;
const MAX_EMBEDDED_IMAGE_SOURCE_LENGTH = Math.ceil(MAX_PROJECT_BYTES * 4 / 3) + 128;
const LEGACY_DEFAULT_PROJECT_TITLES = new Set([
  "Untitled classroom canvas",
  "Untitled PatterDraw project",
]);

export function normalizeSlideFrameAspectRatio(
  value: ClassroomProject["slideFrameAspectRatio"],
  legacyWidescreen?: boolean,
): SlideFrameAspectRatio {
  if (value === "16:9" || value === "4:3" || value === "freeform") return value;
  return legacyWidescreen === true ? "16:9" : "freeform";
}

export function isSafeLocalImageSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_EMBEDDED_IMAGE_SOURCE_LENGTH) return false;
  const match = embeddedImageDataUrl.exec(candidate);
  return !!match && match[1].length > 0 && match[1].length % 4 === 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const WRAPPER_ONLY_TOOL_TYPES = new Set([
  "classroom-bucket-fill",
  "classroom-lasso",
]);

export function isPersistedWrapperTool(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const tool = value as Record<string, unknown>;
  return (
    tool.type === "custom" &&
    typeof tool.customType === "string" &&
    WRAPPER_ONLY_TOOL_TYPES.has(tool.customType)
  );
}

/**
 * Wrapper pointer overlays are React state, not portable Excalidraw scene
 * state. Normalize their legacy custom markers whenever a project crosses a
 * persistence boundary so every load path starts with a usable native tool.
 */
export function canonicalizePersistedWrapperTool(appState: Record<string, unknown>): void {
  const activeTool = appState.activeTool;
  if (!isPersistedWrapperTool(activeTool)) return;
  const tool = activeTool as Record<string, unknown>;
  appState.activeTool = {
    ...tool,
    type: "selection",
    customType: null,
    // Wrapper-only tools may lock themselves so repeated pointer gestures stay
    // active. That transient lock must never leak into persisted native tools:
    // Excalidraw inherits the previous value when a later tool omits `locked`.
    locked: false,
    lastActiveTool: null,
  };
}

export function sanitizeScene(scene: SerializedScene): SerializedScene {
  const safe = clone(scene);
  safe.files = Object.fromEntries(
    Object.entries(safe.files).filter(([, file]) => (
      !!file
      && typeof file === "object"
      && isSafeLocalImageSource(file.dataURL)
    )),
  );
  const elements: Record<string, unknown>[] = [];
  for (const element of safe.elements) {
    if (
      element.type === "embeddable"
      || element.type === "iframe"
      || element.type === "magicframe"
      || (
        element.type === "image"
        && (
          typeof element.fileId !== "string"
          || !Object.hasOwn(safe.files, element.fileId)
        )
      )
    ) {
      continue;
    }
    const next = { ...element };
    if ("link" in next) next.link = null;
    if ("customData" in next && next.customData && typeof next.customData === "object") {
      const customData = { ...(next.customData as Record<string, unknown>) };
      delete customData.url;
      delete customData.href;
      if ("classroomMathTool" in customData) {
        const mathTool = sanitizeClassroomMathToolMetadata(customData.classroomMathTool);
        if (mathTool) customData.classroomMathTool = mathTool;
        else delete customData.classroomMathTool;
      }
      if (CLASSROOM_SLIDE_CUSTOM_DATA_KEY in customData) {
        const slide = next.type === "frame"
          ? sanitizeClassroomSlideMetadata(customData[CLASSROOM_SLIDE_CUSTOM_DATA_KEY])
          : null;
        if (slide) customData[CLASSROOM_SLIDE_CUSTOM_DATA_KEY] = slide;
        else delete customData[CLASSROOM_SLIDE_CUSTOM_DATA_KEY];
      }
      next.customData = customData;
    }
    elements.push(next);
  }
  safe.elements = elements;
  const appState = {
    ...safe.appState,
    openMenu: null,
    openSidebar: null,
  };
  canonicalizePersistedWrapperTool(appState);
  safe.appState = appState;
  return safe;
}

export function sanitizeProject(project: ClassroomProject): ClassroomProject {
  // Clone project metadata independently from the large scene collection.
  // sanitizeScene already performs a defensive deep clone, so cloning the
  // complete project first would temporarily duplicate every scene twice.
  const safe = clone({
    ...project,
    scenes: {},
    slideOrder: [],
    pdfDocuments: {},
    pdfPageOrder: project.pdfPageOrder ? [] : undefined,
  }) as ClassroomProject;
  if (
    safe.titleMode === "default"
    || (safe.titleMode === undefined && (
      safe.title === DEFAULT_PROJECT_TITLE
      || LEGACY_DEFAULT_PROJECT_TITLES.has(safe.title)
    ))
  ) {
    safe.title = DEFAULT_PROJECT_TITLE;
    safe.titleMode = "default";
  } else {
    safe.titleMode = "custom";
  }
  safe.slideOrder = reconcileSlideTitleModes(clone(project.slideOrder));
  safe.pdfDocuments = clone(project.pdfDocuments);
  safe.pdfPageOrder = project.pdfPageOrder ? clone(project.pdfPageOrder) : undefined;
  safe.scenes = Object.fromEntries(
    Object.entries(project.scenes).map(([id, scene]) => [id, sanitizeScene(scene)]),
  );
  for (const scene of Object.values(safe.scenes)) {
    scene.elements = canonicalizePdfBackground(scene, scene.elements);
  }
  // v1 projects historically used slideOrder as the only classification. Tag
  // those exact frames, detach their children in place, and keep the schema.
  for (const [sceneId, scene] of Object.entries(safe.scenes)) {
    const legacySlides = new Map(
      safe.slideOrder
        .filter((slide) => slide.sceneId === sceneId)
        .map((slide) => [slide.frameId, slide.title] as const),
    );
    if (!legacySlides.size) continue;
    const legacyFrameIds = new Set<string>();
    scene.elements = scene.elements.map((element) => {
      const elementId = String(element.id);
      const title = legacySlides.get(elementId);
      if (element.type === "frame" && legacySlides.has(elementId)) {
        const customData = element.customData && typeof element.customData === "object"
          ? element.customData as Record<string, unknown>
          : {};
        const alreadyTagged = !!sanitizeClassroomSlideMetadata(
          customData[CLASSROOM_SLIDE_CUSTOM_DATA_KEY],
        );
        legacyFrameIds.add(elementId);
        return {
          ...element,
          ...(!alreadyTagged && title ? { name: title } : {}),
          customData: {
            ...customData,
            [CLASSROOM_SLIDE_CUSTOM_DATA_KEY]: { ...CLASSROOM_SLIDE_METADATA },
          },
        };
      }
      return element;
    });
    scene.elements = scene.elements.map((element) => (
      typeof element.frameId === "string" && legacyFrameIds.has(element.frameId)
        ? { ...element, frameId: null }
        : element
    ));
  }
  safe.slideOrder = renumberAutomaticSlides(safe.slideOrder);
  safe.pdfPageOrder = reconcilePdfPageOrder(safe);
  safe.slideFramesVisible = safe.slideFramesVisible !== false;
  safe.slideFrameAspectRatio = normalizeSlideFrameAspectRatio(
    safe.slideFrameAspectRatio,
    safe.slideWidescreenFrames,
  );
  delete safe.slideWidescreenFrames;
  safe.slideMorphEnabled = safe.slideMorphEnabled === true;
  safe.slideMorphDurationMs = normalizeSlideMorphDurationMs(safe.slideMorphDurationMs);
  return safe;
}

function assertProject(project: ClassroomProject, requireSanitized: boolean): void {
  if (!project || typeof project !== "object") throw new Error("Project must be an object.");
  if (project.schemaVersion !== 1) throw new Error("Unsupported PatterDraw project version.");
  if (!project.id || !project.activeSceneId) throw new Error("Project identity is missing.");
  if (typeof project.title !== "string") throw new Error("Project title must be text.");
  if (
    project.titleMode !== undefined
    && project.titleMode !== "default"
    && project.titleMode !== "custom"
  ) {
    throw new Error("Project title mode must be default or custom.");
  }
  if (!project.scenes || typeof project.scenes !== "object" || Array.isArray(project.scenes)) {
    throw new Error("Project scenes must be an object.");
  }
  if (!project.pdfDocuments || typeof project.pdfDocuments !== "object" || Array.isArray(project.pdfDocuments)) {
    throw new Error("Project PDF metadata must be an object.");
  }
  if (!project.scenes[project.activeSceneId]) throw new Error("The active scene is missing.");
  if (!Array.isArray(project.slideOrder)) throw new Error("Slide order must be a list.");
  if (project.slideFramesVisible !== undefined && typeof project.slideFramesVisible !== "boolean") {
    throw new Error("Slide frame visibility must be a boolean.");
  }
  if (
    project.slideFrameAspectRatio !== undefined
    && project.slideFrameAspectRatio !== "freeform"
    && project.slideFrameAspectRatio !== "16:9"
    && project.slideFrameAspectRatio !== "4:3"
  ) {
    throw new Error("Slide frame aspect ratio must be freeform, 16:9, or 4:3.");
  }
  if (project.slideWidescreenFrames !== undefined && typeof project.slideWidescreenFrames !== "boolean") {
    throw new Error("Slide widescreen frame preference must be a boolean.");
  }
  if (project.slideMorphEnabled !== undefined && typeof project.slideMorphEnabled !== "boolean") {
    throw new Error("Slide Morph preference must be a boolean.");
  }
  if (
    project.slideMorphDurationMs !== undefined
    && (
      typeof project.slideMorphDurationMs !== "number"
      || !Number.isFinite(project.slideMorphDurationMs)
      || project.slideMorphDurationMs < MIN_SLIDE_MORPH_DURATION_MS
      || project.slideMorphDurationMs > MAX_SLIDE_MORPH_DURATION_MS
    )
  ) {
    throw new Error("Slide Morph duration must be between 250 and 5000 milliseconds.");
  }
  if (project.pdfPageOrder !== undefined && !Array.isArray(project.pdfPageOrder)) {
    throw new Error("PDF page order must be a list.");
  }

  if (project.pdfPageOrder) {
    const orderedIds = new Set<string>();
    for (const sceneId of project.pdfPageOrder) {
      if (typeof sceneId !== "string" || !project.scenes[sceneId]?.pdfPage) {
        throw new Error("PDF page order references an invalid page scene.");
      }
      if (orderedIds.has(sceneId)) throw new Error("PDF page order contains a duplicate page.");
      orderedIds.add(sceneId);
    }
  }

  const frameElements = new Map<string, Set<string>>();
  for (const [sceneKey, scene] of Object.entries(project.scenes)) {
    if (
      !scene
      || typeof scene !== "object"
      || !scene.id
      || scene.id !== sceneKey
      || !Array.isArray(scene.elements)
      || !scene.appState
      || typeof scene.appState !== "object"
      || Array.isArray(scene.appState)
      || !scene.files
      || typeof scene.files !== "object"
      || Array.isArray(scene.files)
    ) {
      throw new Error("A scene is malformed.");
    }
    if (requireSanitized) {
      for (const file of Object.values(scene.files)) {
        if (!file || typeof file !== "object" || !isSafeLocalImageSource(file.dataURL)) {
          throw new Error("A project image has missing or unsafe local data.");
        }
      }
    }
    const elementIds = new Set<string>();
    let pdfBackground: SerializedScene["elements"][number] | undefined;
    let pdfBackgroundCount = 0;
    for (const element of scene.elements) {
      if (!element || typeof element !== "object" || Array.isArray(element)) {
        throw new Error("A scene element is malformed.");
      }
      if (
        typeof element.id !== "string"
        || !element.id
        || typeof element.type !== "string"
        || !element.type
      ) {
        throw new Error("A scene element identity is malformed.");
      }
      if (elementIds.has(element.id)) throw new Error("A scene contains a duplicate element identity.");
      elementIds.add(element.id);
      if (
        element.type === "embeddable"
        || element.type === "iframe"
        || element.type === "magicframe"
      ) {
        throw new Error("Web embeds and generated frames are not supported in PatterDraw projects.");
      }
      if (element.type === "frame") {
        const sceneFrames = frameElements.get(sceneKey) || new Set<string>();
        sceneFrames.add(element.id);
        frameElements.set(sceneKey, sceneFrames);
      }
      const customData = element.customData;
      if (customData && typeof customData === "object" && "classroomMathTool" in customData) {
        if (!sanitizeClassroomMathToolMetadata((customData as Record<string, unknown>).classroomMathTool)) {
          throw new Error("A math tool has invalid classroom metadata.");
        }
      }
      if (customData && typeof customData === "object" && CLASSROOM_SLIDE_CUSTOM_DATA_KEY in customData) {
        if (
          element.type !== "frame"
          || !sanitizeClassroomSlideMetadata(
            (customData as Record<string, unknown>)[CLASSROOM_SLIDE_CUSTOM_DATA_KEY],
          )
        ) {
          throw new Error("A slide frame has invalid classroom metadata.");
        }
      }
      if (requireSanitized) {
        if (element.link) {
          throw new Error("External links are not supported in PatterDraw projects.");
        }
        if (
          customData
          && typeof customData === "object"
          && ("url" in customData || "href" in customData)
        ) {
          throw new Error("External links are not supported in PatterDraw projects.");
        }
        if (
          element.type === "image"
          && (
            typeof element.fileId !== "string"
            || !Object.hasOwn(scene.files, element.fileId)
          )
        ) {
          throw new Error("A project image is missing its local data.");
        }
      }
      if (scene.pdfPage && element.id === scene.pdfPage.backgroundElementId) {
        pdfBackground = element;
        pdfBackgroundCount += 1;
      }
    }
    if (scene.pdfPage) {
      const source = project.pdfDocuments[scene.pdfPage.documentId];
      if (!source) throw new Error("A PDF page references a missing source document.");
      if (!Number.isInteger(scene.pdfPage.pageIndex) || scene.pdfPage.pageIndex < 0 || scene.pdfPage.pageIndex >= source.pageCount) {
        throw new Error("A PDF page has an invalid source-page index.");
      }
      if (!Number.isFinite(scene.pdfPage.width) || scene.pdfPage.width <= 0 || !Number.isFinite(scene.pdfPage.height) || scene.pdfPage.height <= 0) {
        throw new Error("A PDF page has invalid dimensions.");
      }
      if (
        scene.pdfPage.width > MAX_PDF_PAGE_EDGE_POINTS
        || scene.pdfPage.height > MAX_PDF_PAGE_EDGE_POINTS
      ) {
        throw new Error("A PDF page has unsupported dimensions.");
      }
      if (![0, 90, 180, 270].includes(scene.pdfPage.rotation) || !scene.pdfPage.backgroundElementId) {
        throw new Error("A PDF page has malformed workspace metadata.");
      }
      if (
        pdfBackgroundCount !== 1
        || pdfBackground?.type !== "image"
        || typeof pdfBackground.fileId !== "string"
      ) {
        throw new Error("A PDF page is missing its local background image.");
      }
      const backgroundFile = scene.files[pdfBackground.fileId];
      if (!backgroundFile || !isSafeLocalImageSource(backgroundFile.dataURL)) {
        throw new Error("A PDF page background has missing or unsafe local image data.");
      }
    }
  }

  const slideIds = new Set<string>();
  const slideFrames = new Map<string, Set<string>>();
  for (const slide of project.slideOrder) {
    if (
      !slide
      || typeof slide !== "object"
      || typeof slide.id !== "string"
      || !slide.id
      || typeof slide.sceneId !== "string"
      || typeof slide.frameId !== "string"
      || typeof slide.title !== "string"
    ) {
      throw new Error("A slide record is malformed.");
    }
    if (
      slide.titleMode !== undefined
      && slide.titleMode !== "automatic"
      && slide.titleMode !== "custom"
    ) {
      throw new Error("Slide title mode must be automatic or custom.");
    }
    if (!project.scenes[slide.sceneId]) throw new Error("A slide references a missing scene.");
    if (slideIds.has(slide.id)) throw new Error("Slide order contains a duplicate slide identity.");
    const orderedSceneFrames = slideFrames.get(slide.sceneId) || new Set<string>();
    if (orderedSceneFrames.has(slide.frameId)) {
      throw new Error("Slide order contains a duplicate frame.");
    }
    if (!frameElements.get(slide.sceneId)?.has(slide.frameId)) {
      throw new Error("A slide references a missing frame.");
    }
    slideIds.add(slide.id);
    orderedSceneFrames.add(slide.frameId);
    slideFrames.set(slide.sceneId, orderedSceneFrames);
  }

  const archivePaths = new Set<string>();
  for (const [documentKey, document] of Object.entries(project.pdfDocuments)) {
    if (
      !document
      || typeof document !== "object"
      || document.id !== documentKey
      || typeof document.name !== "string"
      || !document.name
      || document.mimeType !== "application/pdf"
    ) {
      throw new Error("PDF metadata is malformed.");
    }
    if (!Number.isSafeInteger(document.byteLength) || document.byteLength <= 0) {
      throw new Error("PDF byte length is malformed.");
    }
    if (document.byteLength > MAX_PDF_BYTES) throw new Error("An imported PDF is too large.");
    if (
      document.sha256 !== undefined
      && (
        typeof document.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(document.sha256)
      )
    ) {
      throw new Error("PDF content identity is malformed.");
    }
    if (!Number.isSafeInteger(document.pageCount) || document.pageCount <= 0) {
      throw new Error("PDF page count is malformed.");
    }
    if (document.pageCount > MAX_PDF_PAGES) throw new Error("An imported PDF has too many pages.");
    if (!/^documents\/[a-zA-Z0-9_-]+\.pdf$/.test(document.archivePath)) {
      throw new Error("A PDF archive path is unsafe.");
    }
    if (archivePaths.has(document.archivePath)) {
      throw new Error("PDF metadata contains a duplicate archive path.");
    }
    archivePaths.add(document.archivePath);
  }
}

export function assertSafeProject(project: ClassroomProject): void {
  assertProject(project, false);
}

/**
 * Strict validation for state that has already passed through the wrapper's
 * sanitizer. This supports low-memory persistence paths without silently
 * weakening the offline-only boundary.
 */
export function assertSanitizedProject(project: ClassroomProject): void {
  assertProject(project, true);
}
