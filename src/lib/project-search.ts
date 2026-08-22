import type { ClassroomProject, SerializedScene } from "../types";
import {
  parseClassroomTimeChildData,
  parseClassroomTimeWidgetMetadata,
} from "./classroom-time/types";
import { reconcilePdfPageOrder } from "./pdf/page-order";
import { getSlideRenderData } from "./slide-render";

/** The three places in a classroom project that can contain searchable text. */
export type ProjectSearchScope = "board" | "slide" | "pdf";

/**
 * A small, navigation-friendly description of one matching text element.
 *
 * `text` is always the original Excalidraw text. Matching uses a normalized
 * copy, but the original is intentionally retained for the result label and
 * for any follow-up selection in the editor.
 */
export interface ProjectSearchResult {
  key: string;
  sceneId: string;
  elementId: string;
  text: string;
  scope: ProjectSearchScope;
  contextLabel: string;
  sceneName: string;
  slideId?: string;
  slideTitle?: string;
  /** Zero-based position in the authoritative slideOrder array. */
  slideIndex?: number;
  /** Zero-based position in the reconciled PDF output order. */
  pdfOutputIndex?: number;
  /** Immutable source page index from the imported PDF document. */
  pdfSourcePageIndex?: number;
  pdfDocumentName?: string;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

interface SceneEntry {
  readonly sceneId: string;
  readonly scene: SerializedScene;
  readonly sceneName: string;
  readonly sourceOrder: number;
}

interface TextEntry {
  readonly sceneId: string;
  readonly scene: SerializedScene;
  readonly sceneName: string;
  readonly elementId: string;
  readonly text: string;
  readonly sourceOrder: number;
  readonly elementOrder: number;
  readonly key: string;
}

interface OrderedSlide {
  readonly id: string;
  readonly sceneId: string;
  readonly frameId: string;
  readonly title: string;
  readonly index: number;
}

interface PdfPageInfo {
  readonly documentId?: string;
  readonly sourcePageIndex?: number;
  readonly sourceName?: string;
}

interface PdfOrderEntry {
  readonly sceneId: string;
  readonly outputIndex: number;
}

interface SlideMatch {
  readonly slide: OrderedSlide;
}

const EMPTY_PROJECT_SCENES: Record<string, unknown> = {};

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Normalizes the user query and text for matching. NFKD makes compatibility
 * forms and accented characters comparable; combining marks are then removed
 * while original display text remains untouched in the result.
 */
export function normalizeProjectSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function safeScene(
  value: unknown,
  sceneId: string,
): SerializedScene | null {
  if (!isRecord(value)) return null;
  const rawElements = Array.isArray(value.elements) ? value.elements : [];
  const elements = rawElements.filter(isRecord) as readonly Record<string, unknown>[];
  const files = isRecord(value.files) ? value.files as Record<string, Record<string, unknown>> : {};
  const appState = isRecord(value.appState) ? value.appState as Record<string, unknown> : {};
  return {
    ...(value as unknown as SerializedScene),
    id: sceneId,
    name: typeof value.name === "string" ? value.name : sceneId,
    elements,
    appState,
    files,
  };
}

function sceneEntries(project: unknown): SceneEntry[] {
  const rawScenes = isRecord(project) && isRecord(project.scenes)
    ? project.scenes
    : EMPTY_PROJECT_SCENES;
  return Object.entries(rawScenes)
    .map(([sceneId, rawScene], sourceOrder) => {
      if (!sceneId.trim()) return null;
      const scene = safeScene(rawScene, sceneId);
      if (!scene) return null;
      const sceneName = typeof scene.name === "string" && scene.name.trim()
        ? scene.name.trim()
        : sceneId;
      return { sceneId, scene, sceneName, sourceOrder } satisfies SceneEntry;
    })
    .filter((entry): entry is SceneEntry => entry !== null);
}

function textEntries(scenes: readonly SceneEntry[]): TextEntry[] {
  const entries: TextEntry[] = [];
  const seen = new Set<string>();
  for (const sceneEntry of scenes) {
    for (const [elementOrder, rawElement] of sceneEntry.scene.elements.entries()) {
      if (!isRecord(rawElement)) continue;
      if (rawElement.isDeleted) continue;
      const elementId = nonEmptyString(rawElement.id);
      const customData = isRecord(rawElement.customData) ? rawElement.customData : null;
      const classroomTimeValue = customData?.classroomTimeWidget;
      const classroomTimeMetadata = rawElement.type === "image"
        ? parseClassroomTimeWidgetMetadata(classroomTimeValue)
        : null;
      const classroomTimeChild = classroomTimeMetadata
        ? null
        : parseClassroomTimeChildData(classroomTimeValue);
      // Generated clock/timer/calendar text changes every second and would
      // swamp Project Find with implementation details. Index the stable
      // anchor label once and omit every generated child instead.
      if (classroomTimeChild) continue;
      const text = classroomTimeMetadata
        ? classroomTimeMetadata.label
        : rawElement.type === "text" && typeof rawElement.text === "string"
          ? rawElement.text
          : null;
      if (!elementId || text === null) continue;
      const key = `${sceneEntry.sceneId}:${elementId}`;
      // A malformed scene can contain duplicate IDs. Keep the first source
      // element so every returned key remains unique and deterministic.
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        sceneId: sceneEntry.sceneId,
        scene: sceneEntry.scene,
        sceneName: sceneEntry.sceneName,
        elementId,
        text,
        sourceOrder: sceneEntry.sourceOrder,
        elementOrder,
        key,
      });
    }
  }
  return entries;
}

function readSlideOrder(project: unknown): OrderedSlide[] {
  const rawSlides = isRecord(project) && Array.isArray(project.slideOrder)
    ? project.slideOrder
    : [];
  const slides: OrderedSlide[] = [];
  for (const [index, rawSlide] of rawSlides.entries()) {
    if (!isRecord(rawSlide)) continue;
    const id = nonEmptyString(rawSlide.id);
    const sceneId = nonEmptyString(rawSlide.sceneId);
    const frameId = nonEmptyString(rawSlide.frameId);
    if (!id || !sceneId || !frameId) continue;
    const title = typeof rawSlide.title === "string" && rawSlide.title.trim()
      ? rawSlide.title.trim()
      : `Slide ${index + 1}`;
    slides.push({ id, sceneId, frameId, title, index });
  }
  return slides;
}

function slideSceneForRender(scene: SerializedScene): SerializedScene {
  // getSlideRenderData expects a well-shaped scene. The search itself accepts
  // legacy/malformed data, so provide safe empty defaults without changing the
  // project object or the source scene.
  return {
    ...scene,
    elements: Array.isArray(scene.elements)
      ? scene.elements.filter(isRecord) as readonly Record<string, unknown>[]
      : [],
    files: isRecord(scene.files) ? scene.files : {},
  };
}

function readSlideMatches(
  scenes: ReadonlyMap<string, SceneEntry>,
  slides: readonly OrderedSlide[],
): ReadonlyMap<string, SlideMatch> {
  const matches = new Map<string, SlideMatch>();
  for (const slide of slides) {
    const sceneEntry = scenes.get(slide.sceneId);
    if (!sceneEntry) continue;
    let rendered: ReturnType<typeof getSlideRenderData> = null;
    try {
      rendered = getSlideRenderData(slideSceneForRender(sceneEntry.scene), slide.frameId);
    } catch {
      // Old or partially written scene data must not make project Find fail.
      rendered = null;
    }
    if (!rendered) continue;
    for (const element of rendered.elements) {
      if (element.isDeleted) continue;
      const customData = isRecord(element.customData) ? element.customData : null;
      const isClassroomTimeAnchor = element.type === "image"
        && !!parseClassroomTimeWidgetMetadata(customData?.classroomTimeWidget);
      if (element.type !== "text" && !isClassroomTimeAnchor) continue;
      const elementId = nonEmptyString(element.id);
      if (!elementId) continue;
      const key = `${slide.sceneId}:${elementId}`;
      // Explicit slideOrder is authoritative. Overlapping slides therefore
      // resolve to the first matching slide and never duplicate the result.
      if (!matches.has(key)) matches.set(key, { slide });
    }
  }
  return matches;
}

function pageInfo(scene: SerializedScene): PdfPageInfo | null {
  if (!isRecord(scene.pdfPage)) return null;
  const documentId = nonEmptyString(scene.pdfPage.documentId) || undefined;
  const sourcePageIndex = typeof scene.pdfPage.pageIndex === "number"
    && Number.isFinite(scene.pdfPage.pageIndex)
    ? scene.pdfPage.pageIndex
    : undefined;
  const sourceName = nonEmptyString(scene.pdfPage.sourceName) || undefined;
  return { documentId, sourceName, sourcePageIndex };
}

function pdfDocumentName(project: unknown, documentId: string | undefined): string | undefined {
  if (!documentId || !isRecord(project) || !isRecord(project.pdfDocuments)) return undefined;
  const source = project.pdfDocuments[documentId];
  return isRecord(source) && typeof source.name === "string" && source.name.trim()
    ? source.name.trim()
    : undefined;
}

function fallbackPdfOrder(
  project: unknown,
  scenes: readonly SceneEntry[],
): string[] {
  const documentOrder = new Map<string, number>();
  if (isRecord(project) && isRecord(project.pdfDocuments)) {
    Object.keys(project.pdfDocuments).forEach((id, index) => documentOrder.set(id, index));
  }
  return scenes
    .filter((entry) => pageInfo(entry.scene) !== null)
    .sort((left, right) => {
      const leftPage = pageInfo(left.scene);
      const rightPage = pageInfo(right.scene);
      const leftDocument = documentOrder.get(leftPage?.documentId || "") ?? Number.MAX_SAFE_INTEGER;
      const rightDocument = documentOrder.get(rightPage?.documentId || "") ?? Number.MAX_SAFE_INTEGER;
      const leftIndex = leftPage?.sourcePageIndex ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = rightPage?.sourcePageIndex ?? Number.MAX_SAFE_INTEGER;
      return leftDocument - rightDocument
        || leftIndex - rightIndex
        || left.sceneId.localeCompare(right.sceneId);
    })
    .map((entry) => entry.sceneId);
}

function readPdfOrder(project: unknown, scenes: readonly SceneEntry[]): PdfOrderEntry[] {
  const sceneIds = new Set(
    scenes.filter((entry) => pageInfo(entry.scene) !== null).map((entry) => entry.sceneId),
  );
  if (!sceneIds.size) return [];

  let reconciled: string[] = [];
  if (isRecord(project) && isRecord(project.scenes) && isRecord(project.pdfDocuments)) {
    try {
      reconciled = reconcilePdfPageOrder(project as unknown as ClassroomProject);
    } catch {
      reconciled = [];
    }
  }
  const explicitOrder = isRecord(project) && Array.isArray(project.pdfPageOrder)
    ? project.pdfPageOrder.filter((id): id is string => typeof id === "string")
    : [];
  const candidates = [...reconciled, ...explicitOrder, ...fallbackPdfOrder(project, scenes)];
  const seen = new Set<string>();
  const order: PdfOrderEntry[] = [];
  for (const sceneId of candidates) {
    if (!sceneIds.has(sceneId) || seen.has(sceneId)) continue;
    seen.add(sceneId);
    order.push({ sceneId, outputIndex: order.length });
  }
  return order;
}

function baseResult(
  entry: TextEntry,
  scope: ProjectSearchScope,
  contextLabel: string,
): ProjectSearchResult {
  return {
    key: entry.key,
    sceneId: entry.sceneId,
    elementId: entry.elementId,
    text: entry.text,
    scope,
    contextLabel,
    sceneName: entry.sceneName,
  };
}

/**
 * Finds visible text across every scene in a classroom project.
 *
 * Ordering is deterministic and intentionally mirrors the navigation model:
 * board scenes first, then explicit slideOrder, then reconciled PDF output
 * order. A text element that geometrically belongs to multiple slides is
 * assigned to the first matching slide only.
 */
export function searchProjectText(
  project: ClassroomProject,
  query: string,
): ProjectSearchResult[] {
  if (typeof query !== "string") return [];
  const normalizedQuery = normalizeProjectSearchText(query);
  if (!normalizedQuery) return [];

  const scenes = sceneEntries(project);
  if (!scenes.length) return [];
  const sceneById = new Map(scenes.map((entry) => [entry.sceneId, entry]));
  const entries = textEntries(scenes).filter((entry) => (
    normalizeProjectSearchText(entry.text).includes(normalizedQuery)
  ));
  if (!entries.length) return [];

  const slides = readSlideOrder(project);
  const slideMatches = readSlideMatches(sceneById, slides);
  const pdfOrder = readPdfOrder(project, scenes);
  const pdfByScene = new Map(pdfOrder.map((entry) => [entry.sceneId, entry]));

  const boardResults: Array<{ result: ProjectSearchResult; sourceOrder: number; elementOrder: number; key: string }> = [];
  const slideResults: Array<{ result: ProjectSearchResult; order: number; sourceOrder: number; elementOrder: number; key: string }> = [];
  const pdfResults: Array<{ result: ProjectSearchResult; order: number; sourceOrder: number; elementOrder: number; key: string }> = [];

  for (const entry of entries) {
    const page = pdfByScene.get(entry.sceneId);
    // PDF classification is explicit and wins over an accidental slide record
    // referencing the same scene.
    if (page) {
      const info = pageInfo(entry.scene);
      const documentName = info?.sourceName || pdfDocumentName(project, info?.documentId);
      const result = baseResult(entry, "pdf", documentName || entry.sceneName);
      if (documentName) result.pdfDocumentName = documentName;
      result.pdfOutputIndex = page.outputIndex;
      if (info?.sourcePageIndex !== undefined) result.pdfSourcePageIndex = info.sourcePageIndex;
      pdfResults.push({
        result,
        order: page.outputIndex,
        sourceOrder: entry.sourceOrder,
        elementOrder: entry.elementOrder,
        key: entry.key,
      });
      continue;
    }

    const match = slideMatches.get(entry.key);
    if (match) {
      const slide = match.slide;
      const result = baseResult(entry, "slide", slide.title);
      result.slideId = slide.id;
      result.slideTitle = slide.title;
      result.slideIndex = slide.index;
      slideResults.push({
        result,
        order: slide.index,
        sourceOrder: entry.sourceOrder,
        elementOrder: entry.elementOrder,
        key: entry.key,
      });
      continue;
    }

    boardResults.push({
      result: baseResult(entry, "board", entry.sceneName),
      sourceOrder: entry.sourceOrder,
      elementOrder: entry.elementOrder,
      key: entry.key,
    });
  }

  boardResults.sort((left, right) => {
    return left.sourceOrder - right.sourceOrder
      || left.elementOrder - right.elementOrder
      || left.key.localeCompare(right.key);
  });
  slideResults.sort((left, right) => (
    left.order - right.order
      || left.sourceOrder - right.sourceOrder
      || left.elementOrder - right.elementOrder
      || left.key.localeCompare(right.key)
  ));
  pdfResults.sort((left, right) => (
    left.order - right.order
      || left.sourceOrder - right.sourceOrder
      || left.elementOrder - right.elementOrder
      || left.key.localeCompare(right.key)
  ));

  return [
    ...boardResults.map((entry) => entry.result),
    ...slideResults.map((entry) => entry.result),
    ...pdfResults.map((entry) => entry.result),
  ];
}

// A concise alias is useful to callers that describe this operation as a
// generic project search while the explicit name remains the public contract.
export const searchProject = searchProjectText;
