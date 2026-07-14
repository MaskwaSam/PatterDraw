import type { ClassroomProject, SerializedScene } from "../types";
import { reconcilePdfPageOrder } from "./pdf/page-order";

export const MAX_PROJECT_BYTES = 150 * 1024 * 1024;
export const MAX_PDF_BYTES = 75 * 1024 * 1024;
export const MAX_PDF_PAGES = 250;

const safeDataUrl = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;[^,]*)?,/i;

export function isRemoteUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  return (
    candidate.startsWith("//") ||
    candidate.startsWith("\\\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(candidate)
  );
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
      if ("link" in next) next.link = null;
      if ("customData" in next && next.customData && typeof next.customData === "object") {
        const customData = { ...(next.customData as Record<string, unknown>) };
        delete customData.url;
        delete customData.href;
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
  safe.scenes = Object.fromEntries(
    Object.entries(safe.scenes).map(([id, scene]) => [id, sanitizeScene(scene)]),
  );
  safe.pdfPageOrder = reconcilePdfPageOrder(safe);
  safe.slideFramesVisible = safe.slideFramesVisible !== false;
  return safe;
}

export function assertSafeProject(project: ClassroomProject): void {
  if (!project || typeof project !== "object") throw new Error("Project must be an object.");
  if (project.schemaVersion !== 1) throw new Error("Unsupported classroom project version.");
  if (!project.id || !project.activeSceneId) throw new Error("Project identity is missing.");
  if (!project.scenes[project.activeSceneId]) throw new Error("The active scene is missing.");
  if (!Array.isArray(project.slideOrder)) throw new Error("Slide order must be a list.");
  if (project.slideFramesVisible !== undefined && typeof project.slideFramesVisible !== "boolean") {
    throw new Error("Slide frame visibility must be a boolean.");
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
