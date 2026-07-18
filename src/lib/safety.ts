import type { ClassroomProject, SerializedScene, SlideFrameAspectRatio } from "../types";
import { sanitizeClassroomMathToolMetadata } from "./math-tools/types";
import { reconcilePdfPageOrder } from "./pdf/page-order";
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

const safeDataUrl = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;[^,]*)?,/i;

export function normalizeSlideFrameAspectRatio(
  value: ClassroomProject["slideFrameAspectRatio"],
  legacyWidescreen?: boolean,
): SlideFrameAspectRatio {
  if (value === "16:9" || value === "4:3" || value === "freeform") return value;
  return legacyWidescreen === true ? "16:9" : "freeform";
}

export function isRemoteUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  return (
    candidate.startsWith("//") ||
    candidate.startsWith("\\\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(candidate)
  );
}

export function sanitizeWebLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function isSafeLocalImageSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate) return false;
  if (safeDataUrl.test(candidate) || candidate.startsWith("blob:")) return true;
  if (isRemoteUrl(candidate) || candidate.startsWith("/") || candidate.startsWith("\\")) {
    return false;
  }

  let decoded = candidate;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return false;
    }
  }

  return !decoded.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function sanitizeScene(scene: SerializedScene): SerializedScene {
  const safe = clone(scene);
  safe.elements = safe.elements
    .filter((element) => element.type !== "embeddable" && element.type !== "iframe" && element.type !== "magicframe")
    .map((element) => {
      const next = { ...element };
      if ("link" in next) next.link = sanitizeWebLink(next.link);
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
      return next;
    });

  safe.appState = {
    ...safe.appState,
    openMenu: null,
    openSidebar: null,
  };

  safe.files = Object.fromEntries(
    Object.entries(safe.files).filter(([, file]) => isSafeLocalImageSource(file.dataURL)),
  );
  return safe;
}

export function sanitizeProject(project: ClassroomProject): ClassroomProject {
  const safe = clone(project);
  safe.slideOrder = reconcileSlideTitleModes(safe.slideOrder);
  safe.scenes = Object.fromEntries(
    Object.entries(safe.scenes).map(([id, scene]) => [id, sanitizeScene(scene)]),
  );
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

export function assertSafeProject(project: ClassroomProject): void {
  if (!project || typeof project !== "object") throw new Error("Project must be an object.");
  if (project.schemaVersion !== 1) throw new Error("Unsupported classroom project version.");
  if (!project.id || !project.activeSceneId) throw new Error("Project identity is missing.");
  if (!project.scenes[project.activeSceneId]) throw new Error("The active scene is missing.");
  if (!Array.isArray(project.slideOrder)) throw new Error("Slide order must be a list.");
  if (project.slideOrder.some((slide) => (
    slide.titleMode !== undefined
    && slide.titleMode !== "automatic"
    && slide.titleMode !== "custom"
  ))) {
    throw new Error("Slide title mode must be automatic or custom.");
  }
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

  for (const scene of Object.values(project.scenes)) {
    if (!scene.id || !Array.isArray(scene.elements)) throw new Error("A scene is malformed.");
    if (scene.elements.some((element) => element.type === "embeddable" || element.type === "iframe" || element.type === "magicframe")) {
      throw new Error("Web embeds and generated frames are not supported in classroom projects.");
    }
    for (const element of scene.elements) {
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
      if (![0, 90, 180, 270].includes(scene.pdfPage.rotation) || !scene.pdfPage.backgroundElementId) {
        throw new Error("A PDF page has malformed workspace metadata.");
      }
    }
  }

  for (const document of Object.values(project.pdfDocuments)) {
    if (document.mimeType !== "application/pdf") throw new Error("PDF metadata is malformed.");
    if (document.byteLength > MAX_PDF_BYTES) throw new Error("An imported PDF is too large.");
    if (document.pageCount > MAX_PDF_PAGES) throw new Error("An imported PDF has too many pages.");
    if (!/^documents\/[a-zA-Z0-9_-]+\.pdf$/.test(document.archivePath)) {
      throw new Error("A PDF archive path is unsafe.");
    }
  }
}
