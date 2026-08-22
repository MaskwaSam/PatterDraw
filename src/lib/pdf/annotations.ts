import type {
  ClassroomProject,
  SceneId,
  SerializedScene,
} from "../../types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  classroomTimeWidgetOwnerId,
  expandClassroomTimeWidgetElementIds,
} from "../classroom-time/scene";
import { canonicalizePdfBackground } from "./background";
import { orderedPdfScenes } from "./page-order";

export type PdfAnnotationClearScope = "page" | "source-document" | "all-pdf-pages";

export const PDF_ANNOTATION_CLEAR_UNDO_MS = 10_000;

export interface PdfAnnotationPageCount {
  sceneId: SceneId;
  annotationCount: number;
}

export interface PdfAnnotationScopeSummary {
  scope: PdfAnnotationClearScope;
  anchorPageId: SceneId;
  annotationCount: number;
  affectedPageCount: number;
  affectedPageIds: readonly SceneId[];
  /** Includes zero-count pages so confirmation UIs can describe the full scope. */
  pages: readonly PdfAnnotationPageCount[];
  /** Logical selected-file occurrence, falling back to the document id for v1 projects. */
  sourceIdentity?: string;
}

interface PdfAnnotationPageSnapshot {
  sceneId: SceneId;
  pageFingerprint: string;
  /** Stable protected background fields; volatile Excalidraw revision fields are omitted. */
  backgroundElement: Readonly<Record<string, unknown>>;
  originalElements: readonly Readonly<Record<string, unknown>>[];
  retainedElements: readonly {
    id: string;
    element: Readonly<Record<string, unknown>>;
  }[];
  removedElementIds: readonly string[];
  /** Logical count: every Classroom Time widget contributes one annotation. */
  removedAnnotationCount: number;
  removedFiles: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  retainedFiles: readonly {
    id: string;
    fingerprint: string;
  }[];
}

/**
 * A wrapper-owned, memory-only undo record. It deliberately is not part of
 * `ClassroomProject`, so temporary snapshots can never enter project files or
 * autosave records.
 */
export interface PdfAnnotationClearTransaction {
  kind: "patterdraw-pdf-annotation-clear";
  version: 1;
  scope: PdfAnnotationClearScope;
  anchorPageId: SceneId;
  annotationCount: number;
  affectedPageCount: number;
  affectedPageIds: readonly SceneId[];
  createdAt: number;
  expiresAt: number;
  projectFingerprint: string;
  pages: readonly PdfAnnotationPageSnapshot[];
}

export interface PdfAnnotationClearResult {
  project: ClassroomProject;
  summary: PdfAnnotationScopeSummary;
  transaction: PdfAnnotationClearTransaction;
}

export interface PdfAnnotationUndoResult {
  project: ClassroomProject;
  restoredAnnotationCount: number;
  affectedPageCount: number;
  affectedPageIds: readonly SceneId[];
}

export interface PdfAnnotationTransactionOptions {
  /** Injectable wall-clock value for expiry checks and tests. */
  now?: number;
  /** Project timestamp. Defaults to an ISO string derived from `now`. */
  updatedAt?: string;
}

export interface PdfAnnotationElementIdentity {
  readonly id?: unknown;
  readonly isDeleted?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function cloneValue<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function freezeValue<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeValue(nested);
  return value;
}

function snapshotValue<T>(value: T): Readonly<T> {
  return freezeValue(cloneValue(value));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !valuesEqual(left[key], right[key])) return false;
  }
  return true;
}

/** A compact deterministic fingerprint for project/page identity metadata. */
function fingerprint(value: unknown): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let units = 0;
  const feedCharacter = (code: number) => {
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + units), 0x85ebca6b) >>> 0;
    units += 1;
  };
  const feed = (text: string) => {
    for (let index = 0; index < text.length; index += 1) feedCharacter(text.charCodeAt(index));
  };
  const visit = (candidate: unknown): void => {
    if (candidate === null) {
      feed("null;");
      return;
    }
    if (Array.isArray(candidate)) {
      feed("[");
      for (const item of candidate) visit(item);
      feed("]");
      return;
    }
    if (isRecord(candidate)) {
      feed("{");
      for (const key of Object.keys(candidate).sort()) {
        feed(key);
        feed(":");
        visit(candidate[key]);
      }
      feed("}");
      return;
    }
    feed(`${typeof candidate}:${String(candidate)};`);
  };
  visit(value);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}:${units}`;
}

function projectPdfFingerprint(project: ClassroomProject): string {
  // Page order, active page, titles, and unrelated pages may legitimately
  // change while the undo affordance is visible. Page/source integrity is
  // validated independently for every affected scene below.
  return fingerprint({
    schemaVersion: project.schemaVersion,
    id: project.id,
    createdAt: project.createdAt,
  });
}

function backgroundIdentity(background: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Excalidraw may advance revision bookkeeping when a locked image is
  // rehydrated even though its protected payload is unchanged. Everything
  // else, including file identity, geometry, z-index, styling, and wrapper
  // metadata, is part of the page-integrity check.
  const stable = { ...background };
  delete stable.version;
  delete stable.versionNonce;
  delete stable.updated;
  return stable;
}

function fileIdentity(file: Readonly<Record<string, unknown>> | undefined): unknown {
  if (!file) return file;
  // Excalidraw refreshes this cache timestamp when an image is decoded. It is
  // not part of the local file's identity or payload and must not invalidate
  // a wrapper undo while the active page is simply being displayed.
  const stable = { ...file };
  delete stable.lastRetrieved;
  return stable;
}

function pageFingerprint(
  project: ClassroomProject,
  scene: SerializedScene,
  background: Record<string, unknown>,
): string {
  const workspace = scene.pdfPage;
  return fingerprint({
    sceneId: scene.id,
    pdfPage: workspace,
    source: workspace ? project.pdfDocuments[workspace.documentId] : undefined,
    background: backgroundIdentity(background),
  });
}

function effectiveSourceIdentity(scene: SerializedScene): string {
  const workspace = scene.pdfPage;
  if (!workspace) throw new Error("The selected scene is not a PDF page.");
  return workspace.sourceInstanceId ?? workspace.documentId;
}

/**
 * The one canonical definition used for counts, clearing, badges, and export
 * policy: every live user element except the exact wrapper-owned background.
 */
export function isPatterDrawPdfAnnotation(
  scene: SerializedScene,
  element: PdfAnnotationElementIdentity,
): boolean {
  return !!scene.pdfPage
    && element.isDeleted !== true
    && element.id !== scene.pdfPage.backgroundElementId;
}

export function countPdfPageAnnotations(scene: SerializedScene): number {
  if (!scene.pdfPage) return 0;
  const widgetOwners = new Set<string>();
  let ordinaryElementCount = 0;
  for (const element of scene.elements) {
    if (!isPatterDrawPdfAnnotation(scene, element)) continue;
    const ownerId = classroomTimeWidgetOwnerId(element as unknown as ExcalidrawElement);
    if (ownerId) widgetOwners.add(ownerId);
    else ordinaryElementCount += 1;
  }
  return ordinaryElementCount + widgetOwners.size;
}

function countLogicalAnnotationElements(
  elements: readonly Readonly<Record<string, unknown>>[],
): number {
  const widgetOwners = new Set<string>();
  let ordinaryElementCount = 0;
  for (const element of elements) {
    const ownerId = classroomTimeWidgetOwnerId(element as unknown as ExcalidrawElement);
    if (ownerId) widgetOwners.add(ownerId);
    else ordinaryElementCount += 1;
  }
  return ordinaryElementCount + widgetOwners.size;
}

function pagesForScope(
  project: ClassroomProject,
  anchorPageId: SceneId,
  scope: PdfAnnotationClearScope,
): { pages: SerializedScene[]; sourceIdentity?: string } {
  if (scope !== "page" && scope !== "source-document" && scope !== "all-pdf-pages") {
    throw new Error("The PDF annotation clear scope is invalid.");
  }
  const anchor = hasOwn(project.scenes, anchorPageId) ? project.scenes[anchorPageId] : undefined;
  if (!anchor?.pdfPage) throw new Error("The selected PDF page no longer exists.");
  if (scope === "page") return { pages: [anchor] };
  const ordered = orderedPdfScenes(project);
  if (scope === "all-pdf-pages") return { pages: ordered };
  const sourceIdentity = effectiveSourceIdentity(anchor);
  return {
    pages: ordered.filter((scene) => effectiveSourceIdentity(scene) === sourceIdentity),
    sourceIdentity,
  };
}

export function getPdfAnnotationScopeSummary(
  project: ClassroomProject,
  anchorPageId: SceneId,
  scope: PdfAnnotationClearScope,
): PdfAnnotationScopeSummary {
  const selected = pagesForScope(project, anchorPageId, scope);
  const pages = selected.pages.map((scene) => Object.freeze({
    sceneId: scene.id,
    annotationCount: countPdfPageAnnotations(scene),
  }));
  const affected = pages.filter((page) => page.annotationCount > 0);
  return Object.freeze({
    scope,
    anchorPageId,
    annotationCount: affected.reduce((sum, page) => sum + page.annotationCount, 0),
    affectedPageCount: affected.length,
    affectedPageIds: Object.freeze(affected.map((page) => page.sceneId)),
    pages: Object.freeze(pages),
    ...(selected.sourceIdentity ? { sourceIdentity: selected.sourceIdentity } : {}),
  });
}

function assertFiniteNow(options: PdfAnnotationTransactionOptions): number {
  const now = options.now ?? Date.now();
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || now > 8_640_000_000_000_000 - PDF_ANNOTATION_CLEAR_UNDO_MS
  ) {
    throw new Error("The PDF annotation transaction time is invalid.");
  }
  return now;
}

function updatedAtFor(options: PdfAnnotationTransactionOptions, now: number): string {
  const updatedAt = options.updatedAt ?? new Date(now).toISOString();
  if (typeof updatedAt !== "string" || !updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("The PDF annotation project timestamp is invalid.");
  }
  return updatedAt;
}

function validateElementIdentities(scene: SerializedScene): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const element of scene.elements) {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id) {
      throw new Error(`PDF page “${scene.name}” contains an invalid element identity.`);
    }
    if (byId.has(element.id)) {
      throw new Error(`PDF page “${scene.name}” contains a duplicate element identity.`);
    }
    byId.set(element.id, element);
  }
  return byId;
}

function validateFileRegistry(scene: SerializedScene): void {
  if (!isRecord(scene.files)) throw new Error(`PDF page “${scene.name}” has an invalid file registry.`);
  for (const [fileId, file] of Object.entries(scene.files)) {
    if (!isRecord(file) || file.id !== fileId) {
      throw new Error(`PDF page “${scene.name}” contains an invalid local file.`);
    }
  }
  for (const element of scene.elements) {
    if (typeof element.fileId === "string" && !hasOwn(scene.files, element.fileId)) {
      throw new Error(`PDF page “${scene.name}” contains an element with missing local data.`);
    }
  }
}

function canonicalScene(scene: SerializedScene): SerializedScene {
  if (!scene.pdfPage) throw new Error("The selected scene is not a PDF page.");
  validateElementIdentities(scene);
  validateFileRegistry(scene);
  const elements = canonicalizePdfBackground(scene, scene.elements);
  const backgrounds = elements.filter((element) => element.id === scene.pdfPage?.backgroundElementId);
  const background = backgrounds[0];
  if (
    backgrounds.length !== 1
    || background.type !== "image"
    || background.locked !== true
    || background.isDeleted !== false
    || typeof background.fileId !== "string"
    || !hasOwn(scene.files, background.fileId)
  ) {
    throw new Error(`PDF page “${scene.name}” does not have a canonical locked background.`);
  }
  return elements === scene.elements ? scene : { ...scene, elements };
}

function referencedFileIds(elements: readonly Readonly<Record<string, unknown>>[]): Set<string> {
  const result = new Set<string>();
  for (const element of elements) {
    if (typeof element.fileId === "string") result.add(element.fileId);
  }
  return result;
}

function clearOnePage(project: ClassroomProject, scene: SerializedScene): {
  scene: SerializedScene;
  snapshot: PdfAnnotationPageSnapshot;
} {
  const canonical = canonicalScene(scene);
  const workspace = canonical.pdfPage!;
  const originalElements = canonical.elements;
  const selectedElementIds = new Set(
    originalElements
      .filter((element) => isPatterDrawPdfAnnotation(canonical, element))
      .map((element) => element.id as string),
  );
  // Expand by the wrapper-owned identity before removing. This keeps the
  // operation atomic if a future clear entry point begins from one widget
  // part. Deleted members remain below as tombstones.
  const expandedElementIds = expandClassroomTimeWidgetElementIds(
    originalElements as unknown as readonly ExcalidrawElement[],
    selectedElementIds,
  );
  const removedElements = originalElements.filter((element) => (
    element.isDeleted !== true
    && expandedElementIds.has(element.id as string)
    && element.id !== workspace.backgroundElementId
  ));
  if (!removedElements.length) throw new Error(`PDF page “${scene.name}” has no annotations to clear.`);
  const retainedElements = originalElements.filter((element) => !isPatterDrawPdfAnnotation(canonical, element));
  const clearedFileIds = referencedFileIds(removedElements);
  const retainedFileIds = referencedFileIds(retainedElements);
  const files: Record<string, Record<string, unknown>> = { ...canonical.files };
  const removedFiles: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const fileId of clearedFileIds) {
    if (retainedFileIds.has(fileId) || !hasOwn(files, fileId)) continue;
    removedFiles[fileId] = snapshotValue(files[fileId]);
    delete files[fileId];
  }

  const background = retainedElements.find((element) => element.id === workspace.backgroundElementId)!;
  const retainedElementSnapshots = retainedElements.map((element) => Object.freeze({
    id: element.id as string,
    element: snapshotValue(element),
  }));
  const retainedFileSnapshots = Object.entries(files).map(([id, file]) => Object.freeze({
    id,
    fingerprint: fingerprint(fileIdentity(file)),
  }));
  const nextScene: SerializedScene = {
    ...canonical,
    elements: retainedElements,
    files,
  };
  return {
    scene: nextScene,
    snapshot: freezeValue({
      sceneId: canonical.id,
      pageFingerprint: pageFingerprint(project, canonical, background),
      backgroundElement: snapshotValue(backgroundIdentity(background)),
      originalElements: snapshotValue(originalElements),
      retainedElements: Object.freeze(retainedElementSnapshots),
      removedElementIds: Object.freeze(removedElements.map((element) => element.id as string)),
      removedAnnotationCount: countLogicalAnnotationElements(removedElements),
      removedFiles: freezeValue(removedFiles),
      retainedFiles: Object.freeze(retainedFileSnapshots),
    }),
  };
}

export function clearPdfAnnotations(
  project: ClassroomProject,
  anchorPageId: SceneId,
  scope: PdfAnnotationClearScope,
  options: PdfAnnotationTransactionOptions = {},
): PdfAnnotationClearResult {
  const now = assertFiniteNow(options);
  const updatedAt = updatedAtFor(options, now);
  const summary = getPdfAnnotationScopeSummary(project, anchorPageId, scope);
  if (!summary.annotationCount) throw new Error("There are no PatterDraw annotations in this scope.");

  // Finish every validation and build every replacement before returning a
  // new project. A failure cannot partially clear one page in the caller.
  const replacements = new Map<SceneId, SerializedScene>();
  const snapshots: PdfAnnotationPageSnapshot[] = [];
  for (const sceneId of summary.affectedPageIds) {
    const scene = project.scenes[sceneId];
    if (!scene?.pdfPage) throw new Error("A PDF page changed before annotations could be cleared.");
    const cleared = clearOnePage(project, scene);
    replacements.set(sceneId, cleared.scene);
    snapshots.push(cleared.snapshot);
  }

  const scenes = { ...project.scenes };
  for (const [sceneId, scene] of replacements) scenes[sceneId] = scene;
  const nextProject: ClassroomProject = { ...project, updatedAt, scenes };
  const transaction = freezeValue<PdfAnnotationClearTransaction>({
    kind: "patterdraw-pdf-annotation-clear",
    version: 1,
    scope,
    anchorPageId,
    annotationCount: summary.annotationCount,
    affectedPageCount: summary.affectedPageCount,
    affectedPageIds: Object.freeze([...summary.affectedPageIds]),
    createdAt: now,
    expiresAt: now + PDF_ANNOTATION_CLEAR_UNDO_MS,
    projectFingerprint: projectPdfFingerprint(project),
    pages: Object.freeze(snapshots),
  });
  return Object.freeze({ project: nextProject, summary, transaction });
}

function assertValidTransaction(transaction: PdfAnnotationClearTransaction): void {
  if (
    !transaction
    || transaction.kind !== "patterdraw-pdf-annotation-clear"
    || transaction.version !== 1
    || !["page", "source-document", "all-pdf-pages"].includes(transaction.scope)
    || typeof transaction.anchorPageId !== "string"
    || !transaction.anchorPageId
    || typeof transaction.projectFingerprint !== "string"
    || !transaction.projectFingerprint
    || !Array.isArray(transaction.pages)
    || transaction.pages.length !== transaction.affectedPageCount
    || !Array.isArray(transaction.affectedPageIds)
    || transaction.affectedPageIds.length !== transaction.affectedPageCount
    || !Number.isSafeInteger(transaction.affectedPageCount)
    || transaction.affectedPageCount < 1
    || !Number.isSafeInteger(transaction.annotationCount)
    || transaction.annotationCount < 1
    || !Number.isSafeInteger(transaction.createdAt)
    || !Number.isSafeInteger(transaction.expiresAt)
    || transaction.expiresAt - transaction.createdAt !== PDF_ANNOTATION_CLEAR_UNDO_MS
  ) {
    throw new Error("The PDF annotation undo transaction is invalid.");
  }
  let removedAnnotationCount = 0;
  const pageIds = new Set<string>();
  for (let index = 0; index < transaction.pages.length; index += 1) {
    const snapshot = transaction.pages[index];
    if (
      !snapshot
      || typeof snapshot.sceneId !== "string"
      || snapshot.sceneId !== transaction.affectedPageIds[index]
      || pageIds.has(snapshot.sceneId)
      || !Array.isArray(snapshot.originalElements)
      || !Array.isArray(snapshot.retainedElements)
      || !Array.isArray(snapshot.removedElementIds)
      || !Number.isSafeInteger(snapshot.removedAnnotationCount)
      || snapshot.removedAnnotationCount < 1
      || !Array.isArray(snapshot.retainedFiles)
      || !isRecord(snapshot.removedFiles)
      || typeof snapshot.pageFingerprint !== "string"
      || !snapshot.pageFingerprint
      || !isRecord(snapshot.backgroundElement)
    ) {
      throw new Error("The PDF annotation undo transaction contains an invalid page snapshot.");
    }
    const removedIds = new Set(snapshot.removedElementIds);
    const removedElements = snapshot.originalElements.filter((
      element: Readonly<Record<string, unknown>>,
    ) => (
      isRecord(element)
      && typeof element.id === "string"
      && removedIds.has(element.id)
    ));
    if (
      removedIds.size !== snapshot.removedElementIds.length
      || snapshot.removedElementIds.some((id: unknown) => typeof id !== "string" || !id)
      || removedElements.length !== removedIds.size
      || countLogicalAnnotationElements(removedElements) !== snapshot.removedAnnotationCount
    ) {
      throw new Error("The PDF annotation undo transaction has an invalid logical annotation count.");
    }
    removedAnnotationCount += snapshot.removedAnnotationCount;
    pageIds.add(snapshot.sceneId);
  }
  if (removedAnnotationCount !== transaction.annotationCount) {
    throw new Error("The PDF annotation undo transaction has an invalid annotation count.");
  }
}

function restoreOnePage(
  project: ClassroomProject,
  current: SerializedScene,
  snapshot: PdfAnnotationPageSnapshot,
): SerializedScene {
  const canonical = canonicalScene(current);
  const workspace = canonical.pdfPage!;
  const background = canonical.elements.find((element) => element.id === workspace.backgroundElementId)!;
  if (
    pageFingerprint(project, canonical, background) !== snapshot.pageFingerprint
    || !valuesEqual(backgroundIdentity(background), snapshot.backgroundElement)
  ) {
    throw new Error(`PDF page “${current.name}” changed and its annotations cannot be restored safely.`);
  }

  const currentElements = validateElementIdentities(canonical);
  validateFileRegistry(canonical);
  const retainedIds = new Set<string>();
  for (const retained of snapshot.retainedElements) {
    if (!retained || typeof retained.id !== "string" || retainedIds.has(retained.id)) {
      throw new Error("The PDF annotation undo snapshot contains an element collision.");
    }
    retainedIds.add(retained.id);
    const element = currentElements.get(retained.id);
    const sameElement = retained.id === workspace.backgroundElementId
      ? !!element && valuesEqual(backgroundIdentity(element), snapshot.backgroundElement)
      : !!element && valuesEqual(element, retained.element);
    if (!sameElement) {
      throw new Error(`PDF page “${current.name}” changed and its annotations cannot be restored safely.`);
    }
  }

  const removedIds = new Set<string>();
  for (const id of snapshot.removedElementIds) {
    if (typeof id !== "string" || !id || retainedIds.has(id) || removedIds.has(id)) {
      throw new Error("The PDF annotation undo snapshot contains an element collision.");
    }
    if (currentElements.has(id)) {
      throw new Error(`PDF page “${current.name}” contains a new element that collides with cleared work.`);
    }
    removedIds.add(id);
  }
  if (snapshot.originalElements.length !== retainedIds.size + removedIds.size) {
    throw new Error("The PDF annotation undo snapshot has an invalid element order.");
  }
  const originalIds = new Set<string>();
  for (const element of snapshot.originalElements) {
    if (!isRecord(element) || typeof element.id !== "string" || originalIds.has(element.id)) {
      throw new Error("The PDF annotation undo snapshot has an invalid element order.");
    }
    if (!retainedIds.has(element.id) && !removedIds.has(element.id)) {
      throw new Error("The PDF annotation undo snapshot has an invalid element order.");
    }
    originalIds.add(element.id);
  }

  for (const retained of snapshot.retainedFiles) {
    if (
      !retained
      || typeof retained.id !== "string"
      || typeof retained.fingerprint !== "string"
      || !retained.fingerprint
    ) {
      throw new Error("The PDF annotation undo snapshot contains an invalid file identity.");
    }
    const currentFile = hasOwn(canonical.files, retained.id) ? canonical.files[retained.id] : undefined;
    if (!currentFile || fingerprint(fileIdentity(currentFile)) !== retained.fingerprint) {
      throw new Error(`PDF page “${current.name}” changed and its files cannot be restored safely.`);
    }
  }
  for (const [fileId, file] of Object.entries(snapshot.removedFiles)) {
    if (!isRecord(file) || file.id !== fileId) {
      throw new Error("The PDF annotation undo snapshot contains an invalid local file.");
    }
    const collision = hasOwn(canonical.files, fileId) ? canonical.files[fileId] : undefined;
    if (collision) {
      throw new Error(`PDF page “${current.name}” contains a local-file collision.`);
    }
  }

  const newElements = canonical.elements.filter((element) => !retainedIds.has(element.id as string));
  const restoredElements = snapshot.originalElements.map((element) => {
    const id = element.id as string;
    return retainedIds.has(id) ? currentElements.get(id)! : cloneValue(element);
  });
  const files: Record<string, Record<string, unknown>> = { ...canonical.files };
  for (const [fileId, file] of Object.entries(snapshot.removedFiles)) {
    if (!hasOwn(files, fileId)) files[fileId] = cloneValue(file);
  }
  return {
    ...canonical,
    // Newly drawn post-clear elements stay above the exact prior z-order.
    elements: [...restoredElements, ...newElements],
    files,
  };
}

export function undoPdfAnnotationClear(
  project: ClassroomProject,
  transaction: PdfAnnotationClearTransaction,
  options: PdfAnnotationTransactionOptions = {},
): PdfAnnotationUndoResult {
  const now = assertFiniteNow(options);
  const updatedAt = updatedAtFor(options, now);
  assertValidTransaction(transaction);
  if (now >= transaction.expiresAt) throw new Error("The PDF annotation undo period has expired.");
  if (projectPdfFingerprint(project) !== transaction.projectFingerprint) {
    throw new Error("The PDF document changed and annotations cannot be restored safely.");
  }

  // Prebuild every restored scene before publishing the replacement project.
  const replacements = new Map<SceneId, SerializedScene>();
  for (const snapshot of transaction.pages) {
    const scene = hasOwn(project.scenes, snapshot.sceneId) ? project.scenes[snapshot.sceneId] : undefined;
    if (!scene?.pdfPage) throw new Error("A cleared PDF page no longer exists.");
    replacements.set(snapshot.sceneId, restoreOnePage(project, scene, snapshot));
  }
  const scenes = { ...project.scenes };
  for (const [sceneId, scene] of replacements) scenes[sceneId] = scene;
  return Object.freeze({
    project: { ...project, updatedAt, scenes },
    restoredAnnotationCount: transaction.annotationCount,
    affectedPageCount: transaction.affectedPageCount,
    affectedPageIds: transaction.affectedPageIds,
  });
}
