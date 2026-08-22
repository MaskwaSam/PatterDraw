import { duplicateElements } from "@excalidraw/element";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawElement as ClassroomTimeExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  ClassroomProject,
  ClassroomSlide,
  LoadedClassroomProject,
  PdfDocumentId,
  PdfDocumentSource,
  SceneId,
  SerializedScene,
} from "../../types";
import { createLocalId } from "../id";
import { forkDuplicatedClassroomTimeWidgets } from "../classroom-time/scene";
import {
  assertProjectFitsContentBudget,
  getProjectContentSize,
} from "../project-budget";
import { MAX_PROJECT_BYTES } from "../safety";
import { assertProjectStructure } from "../structural-limits";
import { boardSceneId } from "../workspace-mode";
import { canonicalizePdfBackground } from "./background";
import { assertProjectCanAcceptPdfPages } from "./capacity";
import { reconcilePdfPageOrder } from "./page-order";

export const PDF_PAGE_DELETE_UNDO_MS = 10_000;

export interface PdfPageActionOptions {
  /** Injectable wall-clock value for expiry checks and deterministic tests. */
  now?: number;
  /** Project timestamp. Defaults to an ISO string derived from `now`. */
  updatedAt?: string;
  /** Injectable wrapper-id generator. Excalidraw continues to own element IDs. */
  createId?: () => string;
}

export interface DuplicatePdfPageOptions extends PdfPageActionOptions {
  /** Allows a caller to use the same bounded candidate limit as another transaction. */
  maxProjectBytes?: number;
  /** Optional user-facing name override for the duplicated scene. */
  name?: string;
  /** Final caller-owned preflight, run before the atomic candidate is returned. */
  validateCandidate?: (
    project: ClassroomProject,
    pdfBytes: Record<PdfDocumentId, Uint8Array>,
  ) => void;
}

export interface DuplicatePdfPageResult extends LoadedClassroomProject {
  originalSceneId: SceneId;
  duplicatedSceneId: SceneId;
  elementIdMap: Readonly<Record<string, string>>;
  fileIdMap: Readonly<Record<string, string>>;
  slideIdMap: Readonly<Record<string, string>>;
  /** Exact change in the persisted JSON payload; source PDF bytes are shared. */
  additionalManifestBytes: number;
}

interface RemovedSlideSnapshot {
  readonly index: number;
  readonly previousSlideId?: string;
  readonly nextSlideId?: string;
  readonly slide: Readonly<ClassroomSlide>;
}

/**
 * Wrapper-owned and memory-only. The immutable source-byte reference is held
 * in a private WeakMap so those bytes cannot be serialized into a
 * `.patterdraw` project by accidentally spreading this transaction.
 */
export interface PdfPageDeleteTransaction {
  readonly kind: "patterdraw-pdf-page-delete";
  readonly version: 1;
  readonly sceneId: SceneId;
  readonly documentId: PdfDocumentId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly projectFingerprint: string;
  readonly pageOrderIndex: number;
  readonly previousPageId?: SceneId;
  readonly nextPageId?: SceneId;
  readonly wasActiveScene: boolean;
  readonly scene: Readonly<SerializedScene>;
  readonly source: Readonly<PdfDocumentSource>;
  readonly sourceWasRemoved: boolean;
  readonly removedSlides: readonly RemovedSlideSnapshot[];
  /** A defensive blank scene created only when deletion would leave no scene. */
  readonly replacementScene?: Readonly<SerializedScene>;
}

export interface DeletePdfPageResult extends LoadedClassroomProject {
  deletedSceneId: SceneId;
  deletedPageNumber: number;
  transaction: PdfPageDeleteTransaction;
}

export interface UndoPdfPageDeleteResult extends LoadedClassroomProject {
  restoredSceneId: SceneId;
  restoredPageNumber: number;
}

export interface PdfPageDeleteUndoReservationOptions {
  now?: number;
  maxBytes?: number;
}

interface PdfPageDeleteIntegrity {
  readonly bytes: Uint8Array;
  readonly byteFingerprint: string;
  readonly sceneFingerprint: string;
  readonly sourceFingerprint: string;
}

const deleteIntegrity = new WeakMap<PdfPageDeleteTransaction, PdfPageDeleteIntegrity>();

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
  // A non-empty TypedArray cannot be frozen. Source bytes live only in the
  // private WeakMap, but leave this guard in place for future binary fields.
  if (ArrayBuffer.isView(value)) return value;
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
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && valuesEqual(left[key], right[key])
    ));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Full-content, allocation-free checksum for an immutable source byte view. */
function byteFingerprint(bytes: Uint8Array): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const value = bytes[index];
    first = Math.imul(first ^ value, 0x01000193) >>> 0;
    second = Math.imul(second ^ (value + index), 0x85ebca6b) >>> 0;
  }
  return `${bytes.byteLength}:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function fingerprint(value: unknown): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let units = 0;
  const feed = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ (code + units), 0x85ebca6b) >>> 0;
      units += 1;
    }
  };
  const visit = (candidate: unknown): void => {
    if (candidate === null) return feed("null;");
    if (Array.isArray(candidate)) {
      feed("[");
      for (const item of candidate) visit(item);
      return feed("]");
    }
    if (isRecord(candidate)) {
      feed("{");
      for (const key of Object.keys(candidate).sort()) {
        feed(key);
        feed(":");
        visit(candidate[key]);
      }
      return feed("}");
    }
    feed(`${typeof candidate}:${String(candidate)};`);
  };
  visit(value);
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}:${units}`;
}

function projectFingerprint(project: ClassroomProject): string {
  // Page order, active scene, and unrelated scenes may legitimately change
  // during the ten-second undo window. Their integrity is checked narrowly.
  return fingerprint({
    schemaVersion: project.schemaVersion,
    id: project.id,
    createdAt: project.createdAt,
  });
}

function nowFor(options: PdfPageActionOptions): number {
  const now = options.now ?? Date.now();
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || now > 8_640_000_000_000_000 - PDF_PAGE_DELETE_UNDO_MS
  ) {
    throw new Error("The PDF page action time is invalid.");
  }
  return now;
}

function updatedAtFor(options: PdfPageActionOptions, now: number): string {
  const updatedAt = options.updatedAt ?? new Date(now).toISOString();
  if (typeof updatedAt !== "string" || !updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("The PDF page action timestamp is invalid.");
  }
  return updatedAt;
}

function uniqueId(
  createId: () => string,
  reserved: Set<string>,
  label: string,
): string {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = createId();
    if (typeof id !== "string" || !id) throw new Error(`The ${label} identity is invalid.`);
    if (reserved.has(id)) continue;
    reserved.add(id);
    return id;
  }
  throw new Error(`A unique ${label} identity could not be created.`);
}

function allWrapperIds(project: ClassroomProject): Set<string> {
  const ids = new Set<string>([
    project.id,
    project.activeSceneId,
    ...Object.keys(project.scenes),
    ...Object.keys(project.pdfDocuments),
  ]);
  for (const scene of Object.values(project.scenes)) {
    for (const element of scene.elements) {
      if (typeof element.id === "string") ids.add(element.id);
      if (typeof element.fileId === "string") ids.add(element.fileId);
      if (Array.isArray(element.groupIds)) {
        for (const groupId of element.groupIds) {
          if (typeof groupId === "string") ids.add(groupId);
        }
      }
    }
    for (const fileId of Object.keys(scene.files)) ids.add(fileId);
  }
  for (const slide of project.slideOrder) {
    ids.add(slide.id);
    ids.add(slide.frameId);
  }
  return ids;
}

function canonicalLivePdfScene(scene: SerializedScene): SerializedScene {
  if (!scene.pdfPage) throw new Error("The selected scene is not a PDF page.");
  const seen = new Set<string>();
  const liveElements: Record<string, unknown>[] = [];
  for (const element of scene.elements) {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id) {
      throw new Error(`PDF page “${scene.name}” contains an invalid element identity.`);
    }
    if (seen.has(element.id)) {
      throw new Error(`PDF page “${scene.name}” contains a duplicate element identity.`);
    }
    seen.add(element.id);
    if (element.isDeleted !== true) liveElements.push(element);
  }
  const elements = canonicalizePdfBackground(scene, liveElements);
  const background = elements.filter((element) => element.id === scene.pdfPage?.backgroundElementId);
  if (
    background.length !== 1
    || background[0].type !== "image"
    || background[0].locked !== true
    || background[0].isDeleted !== false
    || typeof background[0].fileId !== "string"
  ) {
    throw new Error(`PDF page “${scene.name}” does not have a canonical locked background.`);
  }
  for (const element of elements) {
    if (!Array.isArray(element.groupIds)) {
      throw new Error(`PDF page “${scene.name}” contains an invalid Excalidraw element.`);
    }
    if (typeof element.fileId !== "string") continue;
    const file = hasOwn(scene.files, element.fileId) ? scene.files[element.fileId] : undefined;
    if (!isRecord(file) || file.id !== element.fileId) {
      throw new Error(`PDF page “${scene.name}” contains an element with missing local data.`);
    }
  }
  return { ...scene, elements };
}

function referencedFileIds(elements: readonly Record<string, unknown>[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    if (typeof element.fileId !== "string" || seen.has(element.fileId)) continue;
    seen.add(element.fileId);
    result.push(element.fileId);
  }
  return result;
}

function duplicateName(project: ClassroomProject, scene: SerializedScene): string {
  const base = `${scene.name} — copy`;
  const names = new Set(Object.values(project.scenes).map((candidate) => candidate.name));
  if (!names.has(base)) return base;
  for (let copy = 2; copy < 10_000; copy += 1) {
    const candidate = `${scene.name} — copy ${copy}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("A unique PDF page name could not be created.");
}

function remapIdMap(
  value: unknown,
  ids: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [id, selected] of Object.entries(value)) {
    const mapped = ids.get(id);
    if (mapped) result[mapped] = selected;
  }
  return result;
}

function duplicateAppState(
  appState: Record<string, unknown>,
  elementIds: ReadonlyMap<string, string>,
  groupIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const duplicate = cloneValue(appState);
  if (hasOwn(duplicate, "selectedElementIds")) {
    duplicate.selectedElementIds = remapIdMap(duplicate.selectedElementIds, elementIds);
  }
  if (hasOwn(duplicate, "selectedGroupIds")) {
    duplicate.selectedGroupIds = remapIdMap(duplicate.selectedGroupIds, groupIds);
  }
  if (typeof duplicate.editingGroupId === "string") {
    duplicate.editingGroupId = groupIds.get(duplicate.editingGroupId) ?? null;
  }
  // These are editor-session objects rather than durable page content. A
  // duplicated page opens as a clean scene and cannot retain stale IDs.
  for (const key of [
    "editingElement",
    "editingLinearElement",
    "selectedLinearElement",
    "croppingElementId",
    "frameToHighlight",
    "pendingImageElementId",
  ]) {
    if (hasOwn(duplicate, key)) delete duplicate[key];
  }
  return duplicate;
}

function assertFreshDuplicatedReferences(
  original: readonly Record<string, unknown>[],
  duplicated: readonly ExcalidrawElement[],
  idMap: ReadonlyMap<string, string>,
  reserved: Set<string>,
): Map<string, string> {
  if (duplicated.length !== original.length || idMap.size !== original.length) {
    throw new Error("The PDF page elements could not all be duplicated safely.");
  }
  const oldIds = new Set(original.map((element) => element.id as string));
  const newIds = new Set<string>();
  const byOldId = new Map(original.map((element) => [element.id as string, element]));
  const byNewId = new Map(duplicated.map((element) => [element.id, element]));
  const groupIdMap = new Map<string, string>();

  for (const [oldId, newId] of idMap) {
    if (
      !oldId
      || !newId
      || oldId === newId
      || oldIds.has(newId)
      || newIds.has(newId)
      || reserved.has(newId)
    ) {
      throw new Error("The duplicated PDF page contains an element identity collision.");
    }
    newIds.add(newId);
    reserved.add(newId);
    const originalElement = byOldId.get(oldId);
    const duplicate = byNewId.get(newId);
    if (!originalElement || !duplicate) {
      throw new Error("The duplicated PDF page contains an invalid element mapping.");
    }
    const originalGroups = originalElement.groupIds as readonly unknown[];
    const duplicateGroups = duplicate.groupIds;
    if (originalGroups.length !== duplicateGroups.length) {
      throw new Error("The duplicated PDF page contains an invalid group mapping.");
    }
    for (let index = 0; index < originalGroups.length; index += 1) {
      const oldGroupId = originalGroups[index];
      const newGroupId = duplicateGroups[index];
      if (typeof oldGroupId !== "string" || !newGroupId || oldGroupId === newGroupId) {
        throw new Error("The duplicated PDF page contains a group identity collision.");
      }
      const known = groupIdMap.get(oldGroupId);
      if (known && known !== newGroupId) {
        throw new Error("The duplicated PDF page contains an inconsistent group mapping.");
      }
      if (!known) {
        if (reserved.has(newGroupId)) {
          throw new Error("The duplicated PDF page contains a group identity collision.");
        }
        reserved.add(newGroupId);
      }
      groupIdMap.set(oldGroupId, newGroupId);
    }
  }
  return groupIdMap;
}

function duplicateSlides(
  project: ClassroomProject,
  sceneId: SceneId,
  duplicatedSceneId: SceneId,
  elementIdMap: ReadonlyMap<string, string>,
  createId: () => string,
  reserved: Set<string>,
): { slides: ClassroomSlide[]; slideIdMap: Record<string, string> } {
  const slides: ClassroomSlide[] = [];
  const slideIdMap: Record<string, string> = {};
  for (const slide of project.slideOrder) {
    slides.push(slide);
    if (slide.sceneId !== sceneId) continue;
    const frameId = elementIdMap.get(slide.frameId);
    if (!frameId) {
      throw new Error(`PDF page “${project.scenes[sceneId].name}” contains invalid slide metadata.`);
    }
    const id = uniqueId(createId, reserved, "slide");
    slideIdMap[slide.id] = id;
    slides.push({ ...slide, id, sceneId: duplicatedSceneId, frameId });
  }
  return { slides, slideIdMap };
}

/**
 * Duplicate a committed PDF page as one atomic candidate. Project-level PDF
 * metadata and source bytes are retained by reference; only the scene-local
 * page raster and annotation files receive new local file IDs.
 */
export function duplicatePdfPage(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  sceneId: SceneId,
  options: DuplicatePdfPageOptions = {},
): DuplicatePdfPageResult {
  const now = nowFor(options);
  const updatedAt = updatedAtFor(options, now);
  const sourceScene = hasOwn(project.scenes, sceneId) ? project.scenes[sceneId] : undefined;
  if (!sourceScene?.pdfPage) throw new Error("The selected PDF page no longer exists.");
  const source = project.pdfDocuments[sourceScene.pdfPage.documentId];
  const sourceBytes = pdfBytes[sourceScene.pdfPage.documentId];
  if (!source || !sourceBytes || sourceBytes.byteLength !== source.byteLength) {
    throw new Error(`PDF data does not match project metadata for ${source?.name ?? sourceScene.name}.`);
  }
  assertProjectCanAcceptPdfPages(project, 1);
  const beforeSize = getProjectContentSize(project, pdfBytes);
  const canonical = canonicalLivePdfScene(sourceScene);
  const originalElements = canonical.elements;
  const createId = options.createId ?? createLocalId;
  const reserved = allWrapperIds(project);
  const duplicatedSceneId = uniqueId(createId, reserved, "scene");

  const fileIdMap = new Map<string, string>();
  for (const fileId of referencedFileIds(originalElements)) {
    fileIdMap.set(fileId, uniqueId(createId, reserved, "local file"));
  }
  const duplicated = duplicateElements({
    type: "everything",
    elements: originalElements as readonly unknown[] as readonly ExcalidrawElement[],
    randomizeSeed: false,
    preserveFrameChildrenOrder: true,
    overrides: ({ origElement }) => {
      const originalFileId = "fileId" in origElement ? origElement.fileId : null;
      const fileId = originalFileId ? fileIdMap.get(originalFileId) : undefined;
      return fileId ? ({ fileId } as Partial<ExcalidrawElement>) : {};
    },
  });
  const groupIdMap = assertFreshDuplicatedReferences(
    originalElements,
    duplicated.duplicatedElements,
    duplicated.origIdToDuplicateId,
    reserved,
  );
  const forkedWidgets = forkDuplicatedClassroomTimeWidgets(
    duplicated.duplicatedElements as unknown as readonly ClassroomTimeExcalidrawElement[],
    {
      sourceToDuplicateGroupIds: groupIdMap,
      now,
      createId: () => uniqueId(createId, reserved, "classroom widget owner"),
    },
  );
  for (const [sourceOwnerId, duplicatedOwnerId] of Object.entries(forkedWidgets.ownerIdMap)) {
    // App-state selection follows the final atomic widget group, not the
    // transient group identity created by Excalidraw's duplicate helper.
    groupIdMap.set(sourceOwnerId, duplicatedOwnerId);
  }
  const backgroundElementId = duplicated.origIdToDuplicateId.get(
    canonical.pdfPage!.backgroundElementId,
  );
  if (!backgroundElementId) {
    throw new Error("The locked PDF page background could not be duplicated safely.");
  }

  const files: Record<string, Record<string, unknown>> = {};
  for (const [oldFileId, newFileId] of fileIdMap) {
    const file = canonical.files[oldFileId];
    if (!isRecord(file) || file.id !== oldFileId) {
      throw new Error(`PDF page “${canonical.name}” contains an invalid local file.`);
    }
    files[newFileId] = { ...cloneValue(file), id: newFileId };
  }
  const scene: SerializedScene = {
    ...canonical,
    id: duplicatedSceneId,
    name: options.name?.trim() || duplicateName(project, canonical),
    elements: cloneValue(forkedWidgets.elements) as unknown as readonly Record<string, unknown>[],
    appState: duplicateAppState(
      canonical.appState,
      duplicated.origIdToDuplicateId,
      groupIdMap,
    ),
    files,
    pdfPage: {
      ...canonical.pdfPage!,
      backgroundElementId,
    },
  };
  const currentOrder = reconcilePdfPageOrder(project);
  const selectedIndex = currentOrder.indexOf(sceneId);
  if (selectedIndex < 0) throw new Error("The selected PDF page is not in the page order.");
  const pdfPageOrder = [...currentOrder];
  pdfPageOrder.splice(selectedIndex + 1, 0, duplicatedSceneId);
  const duplicatedSlides = duplicateSlides(
    project,
    sceneId,
    duplicatedSceneId,
    duplicated.origIdToDuplicateId,
    createId,
    reserved,
  );
  const nextProject: ClassroomProject = {
    ...project,
    updatedAt,
    activeSceneId: duplicatedSceneId,
    scenes: { ...project.scenes, [duplicatedSceneId]: scene },
    slideOrder: duplicatedSlides.slides,
    pdfPageOrder,
  };
  assertProjectStructure(nextProject, { label: "Duplicated PDF page" });
  const afterSize = assertProjectFitsContentBudget(
    nextProject,
    pdfBytes,
    options.maxProjectBytes ?? MAX_PROJECT_BYTES,
  );
  options.validateCandidate?.(nextProject, pdfBytes);

  return Object.freeze({
    project: nextProject,
    pdfBytes,
    originalSceneId: sceneId,
    duplicatedSceneId,
    elementIdMap: freezeValue(Object.fromEntries(duplicated.origIdToDuplicateId)),
    fileIdMap: freezeValue(Object.fromEntries(fileIdMap)),
    slideIdMap: freezeValue(duplicatedSlides.slideIdMap),
    additionalManifestBytes: afterSize.manifestBytes - beforeSize.manifestBytes,
  });
}

function removedSlideSnapshots(
  slides: readonly ClassroomSlide[],
  sceneId: SceneId,
): RemovedSlideSnapshot[] {
  const result: RemovedSlideSnapshot[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index];
    if (slide.sceneId !== sceneId) continue;
    result.push({
      index,
      ...(index > 0 ? { previousSlideId: slides[index - 1].id } : {}),
      ...(index + 1 < slides.length ? { nextSlideId: slides[index + 1].id } : {}),
      slide: snapshotValue(slide),
    });
  }
  return result;
}

function replacementScene(
  project: ClassroomProject,
  createId: () => string,
): SerializedScene {
  const id = uniqueId(createId, allWrapperIds(project), "replacement scene");
  return { id, name: "Canvas", elements: [], appState: {}, files: {} };
}

/** Delete one PDF page while producing a ten-second, memory-only undo record. */
export function deletePdfPageReversibly(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  sceneId: SceneId,
  options: PdfPageActionOptions = {},
): DeletePdfPageResult {
  const now = nowFor(options);
  const updatedAt = updatedAtFor(options, now);
  const scene = hasOwn(project.scenes, sceneId) ? project.scenes[sceneId] : undefined;
  if (!scene?.pdfPage) throw new Error("The selected PDF page no longer exists.");
  const order = reconcilePdfPageOrder(project);
  const pageOrderIndex = order.indexOf(sceneId);
  if (pageOrderIndex < 0) throw new Error("The selected PDF page is not in the page order.");
  const documentId = scene.pdfPage.documentId;
  const source = project.pdfDocuments[documentId];
  const bytes = pdfBytes[documentId];
  if (!source || !bytes || bytes.byteLength !== source.byteLength) {
    throw new Error(`PDF data does not match project metadata for ${source?.name ?? scene.name}.`);
  }

  const remainingOrder = order.filter((id) => id !== sceneId);
  const documentStillUsed = Object.values(project.scenes).some(
    (candidate) => candidate.id !== sceneId && candidate.pdfPage?.documentId === documentId,
  );
  const scenes = { ...project.scenes };
  delete scenes[sceneId];
  let generatedReplacement: SerializedScene | undefined;
  if (!Object.keys(scenes).length) {
    generatedReplacement = replacementScene(project, options.createId ?? createLocalId);
    scenes[generatedReplacement.id] = generatedReplacement;
  }
  let activeSceneId = project.activeSceneId;
  if (activeSceneId === sceneId || !hasOwn(scenes, activeSceneId)) {
    activeSceneId = remainingOrder[Math.min(pageOrderIndex, remainingOrder.length - 1)]
      || boardSceneId({ ...project, scenes, activeSceneId: generatedReplacement?.id ?? activeSceneId })
      || generatedReplacement!.id;
  }
  const pdfDocuments = documentStillUsed
    ? project.pdfDocuments
    : { ...project.pdfDocuments };
  const nextPdfBytes = documentStillUsed ? pdfBytes : { ...pdfBytes };
  if (!documentStillUsed) {
    delete pdfDocuments[documentId];
    delete nextPdfBytes[documentId];
  }
  const removedSlides = removedSlideSnapshots(project.slideOrder, sceneId);
  const nextProject: ClassroomProject = {
    ...project,
    updatedAt,
    activeSceneId,
    scenes,
    slideOrder: project.slideOrder.filter((slide) => slide.sceneId !== sceneId),
    pdfPageOrder: remainingOrder,
    pdfDocuments,
  };
  assertProjectStructure(nextProject, { label: "Deleted PDF page" });
  const transaction = Object.freeze<PdfPageDeleteTransaction>({
    kind: "patterdraw-pdf-page-delete",
    version: 1,
    sceneId,
    documentId,
    createdAt: now,
    expiresAt: now + PDF_PAGE_DELETE_UNDO_MS,
    projectFingerprint: projectFingerprint(project),
    pageOrderIndex,
    ...(pageOrderIndex > 0 ? { previousPageId: order[pageOrderIndex - 1] } : {}),
    ...(pageOrderIndex + 1 < order.length ? { nextPageId: order[pageOrderIndex + 1] } : {}),
    wasActiveScene: project.activeSceneId === sceneId,
    // Committed project records are immutable. Retaining their exact objects
    // avoids cloning full-page raster data into the ten-second undo slot.
    scene,
    source,
    sourceWasRemoved: !documentStillUsed,
    removedSlides: snapshotValue(removedSlides),
    ...(generatedReplacement ? { replacementScene: snapshotValue(generatedReplacement) } : {}),
  });
  // Source arrays are immutable wrapper-owned values. Retain the exact object
  // for both last-use and shared-source deletions: it avoids a large copy and
  // lets Undo detect a same-length byte replacement synchronously.
  deleteIntegrity.set(transaction, {
    bytes,
    byteFingerprint: byteFingerprint(bytes),
    sceneFingerprint: fingerprint(scene),
    sourceFingerprint: fingerprint(source),
  });
  return Object.freeze({
    project: nextProject,
    pdfBytes: nextPdfBytes,
    deletedSceneId: sceneId,
    deletedPageNumber: pageOrderIndex + 1,
    transaction,
  });
}

function assertValidDeleteTransaction(transaction: PdfPageDeleteTransaction): void {
  if (
    !transaction
    || transaction.kind !== "patterdraw-pdf-page-delete"
    || transaction.version !== 1
    || typeof transaction.sceneId !== "string"
    || !transaction.sceneId
    || typeof transaction.documentId !== "string"
    || !transaction.documentId
    || !Number.isSafeInteger(transaction.createdAt)
    || !Number.isSafeInteger(transaction.expiresAt)
    || transaction.expiresAt - transaction.createdAt !== PDF_PAGE_DELETE_UNDO_MS
    || !Number.isSafeInteger(transaction.pageOrderIndex)
    || transaction.pageOrderIndex < 0
    || !isRecord(transaction.scene)
    || transaction.scene.id !== transaction.sceneId
    || transaction.scene.pdfPage?.documentId !== transaction.documentId
    || !isRecord(transaction.source)
    || transaction.source.id !== transaction.documentId
    || !Array.isArray(transaction.removedSlides)
  ) {
    throw new Error("The PDF page deletion undo transaction is invalid.");
  }
  const slideIds = new Set<string>();
  for (const snapshot of transaction.removedSlides) {
    if (
      !snapshot
      || !Number.isSafeInteger(snapshot.index)
      || snapshot.index < 0
      || !isRecord(snapshot.slide)
      || typeof snapshot.slide.id !== "string"
      || !snapshot.slide.id
      || snapshot.slide.sceneId !== transaction.sceneId
      || slideIds.has(snapshot.slide.id)
    ) {
      throw new Error("The PDF page deletion undo transaction contains invalid slide data.");
    }
    slideIds.add(snapshot.slide.id);
  }
  const integrity = deleteIntegrity.get(transaction);
  if (!integrity || integrity.bytes.byteLength !== transaction.source.byteLength) {
    throw new Error("The PDF page deletion undo source is unavailable.");
  }
  if (
    fingerprint(transaction.scene) !== integrity.sceneFingerprint
    || fingerprint(transaction.source) !== integrity.sourceFingerprint
    || byteFingerprint(integrity.bytes) !== integrity.byteFingerprint
  ) {
    throw new Error("The PDF page deletion undo snapshot changed and cannot be restored safely.");
  }
}

function insertionIndex(
  currentIds: readonly string[],
  originalIndex: number,
  previousId?: string,
  nextId?: string,
): number {
  if (previousId) {
    const previousIndex = currentIds.indexOf(previousId);
    if (previousIndex >= 0) return previousIndex + 1;
  }
  if (nextId) {
    const nextIndex = currentIds.indexOf(nextId);
    if (nextIndex >= 0) return nextIndex;
  }
  return Math.min(originalIndex, currentIds.length);
}

function restoreSlides(
  current: readonly ClassroomSlide[],
  removed: readonly RemovedSlideSnapshot[],
): ClassroomSlide[] {
  const result = [...current];
  for (const snapshot of [...removed].sort((left, right) => left.index - right.index)) {
    const ids = result.map((slide) => slide.id);
    const index = insertionIndex(
      ids,
      snapshot.index,
      snapshot.previousSlideId,
      snapshot.nextSlideId,
    );
    result.splice(index, 0, cloneValue(snapshot.slide) as ClassroomSlide);
  }
  return result;
}

function canRemoveGeneratedReplacement(
  project: ClassroomProject,
  transaction: PdfPageDeleteTransaction,
): boolean {
  const replacement = transaction.replacementScene;
  if (!replacement) return false;
  const current = project.scenes[replacement.id];
  return !!current
    && valuesEqual(current, replacement)
    && !project.slideOrder.some((slide) => slide.sceneId === replacement.id)
    && !(project.pdfPageOrder || []).includes(replacement.id);
}

/** Restore the deleted page into the current project without replacing later work. */
export function undoPdfPageDelete(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  transaction: PdfPageDeleteTransaction,
  options: PdfPageActionOptions = {},
): UndoPdfPageDeleteResult {
  const now = nowFor(options);
  const updatedAt = updatedAtFor(options, now);
  assertValidDeleteTransaction(transaction);
  if (now >= transaction.expiresAt) throw new Error("The PDF page deletion undo period has expired.");
  if (projectFingerprint(project) !== transaction.projectFingerprint) {
    throw new Error("The PDF project changed and the deleted page cannot be restored safely.");
  }
  if (
    hasOwn(project.scenes, transaction.sceneId)
    || (project.pdfPageOrder || []).includes(transaction.sceneId)
    || project.slideOrder.some((slide) => slide.sceneId === transaction.sceneId)
  ) {
    throw new Error("The PDF page deletion undo contains a scene collision.");
  }
  const currentSlideIds = new Set(project.slideOrder.map((slide) => slide.id));
  if (transaction.removedSlides.some((snapshot) => currentSlideIds.has(snapshot.slide.id))) {
    throw new Error("The PDF page deletion undo contains a slide collision.");
  }

  const retainedSourceBytes = deleteIntegrity.get(transaction)!.bytes;
  let nextPdfBytes = pdfBytes;
  let pdfDocuments = project.pdfDocuments;
  if (transaction.sourceWasRemoved) {
    const sourceBytes = retainedSourceBytes;
    const currentSource = project.pdfDocuments[transaction.documentId];
    const currentBytes = pdfBytes[transaction.documentId];
    const hasSource = hasOwn(project.pdfDocuments, transaction.documentId);
    const hasBytes = hasOwn(pdfBytes, transaction.documentId);
    if (hasSource || hasBytes) {
      if (
        !hasSource
        || !hasBytes
        || !currentSource
        || !currentBytes
        || !valuesEqual(currentSource, transaction.source)
        || !bytesEqual(currentBytes, sourceBytes)
      ) {
        throw new Error("The PDF page deletion undo contains a source collision.");
      }
      // A subsequent import may have legitimately reintroduced the exact
      // immutable source while Undo was visible. Preserve its current
      // metadata/byte objects and only restore this page occurrence.
    } else {
      pdfDocuments = {
        ...project.pdfDocuments,
        [transaction.documentId]: transaction.source as PdfDocumentSource,
      };
      nextPdfBytes = { ...pdfBytes, [transaction.documentId]: sourceBytes };
    }
  } else {
    const currentSource = project.pdfDocuments[transaction.documentId];
    const currentBytes = pdfBytes[transaction.documentId];
    if (
      !currentSource
      || !valuesEqual(currentSource, transaction.source)
      || !currentBytes
      || (currentBytes !== retainedSourceBytes && !bytesEqual(currentBytes, retainedSourceBytes))
    ) {
      throw new Error("The PDF source changed and the deleted page cannot be restored safely.");
    }
  }

  const scenes = { ...project.scenes };
  if (canRemoveGeneratedReplacement(project, transaction)) {
    delete scenes[transaction.replacementScene!.id];
  }
  scenes[transaction.sceneId] = transaction.scene as SerializedScene;
  const currentOrder = reconcilePdfPageOrder(project);
  const pageIndex = insertionIndex(
    currentOrder,
    transaction.pageOrderIndex,
    transaction.previousPageId,
    transaction.nextPageId,
  );
  const pdfPageOrder = [...currentOrder];
  pdfPageOrder.splice(pageIndex, 0, transaction.sceneId);
  const nextProject: ClassroomProject = {
    ...project,
    updatedAt,
    activeSceneId: transaction.wasActiveScene ? transaction.sceneId : project.activeSceneId,
    scenes,
    slideOrder: restoreSlides(project.slideOrder, transaction.removedSlides),
    pdfPageOrder,
    pdfDocuments,
  };
  assertProjectStructure(nextProject, { label: "Restored PDF page" });
  return Object.freeze({
    project: nextProject,
    pdfBytes: nextPdfBytes,
    restoredSceneId: transaction.sceneId,
    restoredPageNumber: pageIndex + 1,
  });
}

/**
 * Checks an additive PDF candidate against the exact state a still-visible
 * page-delete Undo would restore. This keeps the ten-second Undo actionable
 * instead of letting new source bytes consume the space it needs.
 */
export function pdfAdditionPreservesPageDeleteUndo(
  project: ClassroomProject,
  pdfBytes: Record<PdfDocumentId, Uint8Array>,
  transaction: PdfPageDeleteTransaction | undefined,
  options: PdfPageDeleteUndoReservationOptions = {},
): boolean {
  if (!transaction) return true;
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? MAX_PROJECT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("The project size limit is invalid.");
  }
  if (now >= transaction.expiresAt) return true;
  const restored = undoPdfPageDelete(project, pdfBytes, transaction, {
    now,
    updatedAt: project.updatedAt,
  });
  return getProjectContentSize(restored.project, restored.pdfBytes).totalBytes <= maxBytes;
}
