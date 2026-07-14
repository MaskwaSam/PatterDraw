import type { ClassroomProject, SceneId, SerializedScene } from "../../types";

export type PdfPageDropEdge = "before" | "after";

function fallbackPdfScenes(project: ClassroomProject): SerializedScene[] {
  const documentOrder = new Map(
    Object.keys(project.pdfDocuments).map((documentId, index) => [documentId, index]),
  );
  return Object.values(project.scenes)
    .filter((scene): scene is SerializedScene & { pdfPage: NonNullable<SerializedScene["pdfPage"]> } => !!scene.pdfPage)
    .sort((left, right) => {
      const leftDocument = documentOrder.get(left.pdfPage.documentId) ?? Number.MAX_SAFE_INTEGER;
      const rightDocument = documentOrder.get(right.pdfPage.documentId) ?? Number.MAX_SAFE_INTEGER;
      return leftDocument - rightDocument
        || left.pdfPage.pageIndex - right.pdfPage.pageIndex
        || left.id.localeCompare(right.id);
    });
}

/**
 * Keeps valid explicit order, removes duplicates/orphans, and appends legacy or
 * newly imported PDF pages in original document/page order.
 */
export function reconcilePdfPageOrder(project: ClassroomProject): SceneId[] {
  const fallback = fallbackPdfScenes(project);
  const pdfSceneIds = new Set(fallback.map((scene) => scene.id));
  const seen = new Set<SceneId>();
  const ordered: SceneId[] = [];

  for (const sceneId of project.pdfPageOrder || []) {
    if (!pdfSceneIds.has(sceneId) || seen.has(sceneId)) continue;
    seen.add(sceneId);
    ordered.push(sceneId);
  }
  for (const scene of fallback) {
    if (seen.has(scene.id)) continue;
    seen.add(scene.id);
    ordered.push(scene.id);
  }
  return ordered;
}

export function orderedPdfScenes(project: ClassroomProject): SerializedScene[] {
  return reconcilePdfPageOrder(project)
    .map((sceneId) => project.scenes[sceneId])
    .filter((scene): scene is SerializedScene => !!scene?.pdfPage);
}

export function movePdfPage(
  order: readonly SceneId[],
  movingId: SceneId,
  targetId: SceneId,
  edge: PdfPageDropEdge = "before",
): SceneId[] {
  if (movingId === targetId || !order.includes(movingId) || !order.includes(targetId)) return [...order];
  const next = order.filter((sceneId) => sceneId !== movingId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, movingId);
  return next;
}

export function shiftPdfPage(
  order: readonly SceneId[],
  sceneId: SceneId,
  direction: -1 | 1,
): SceneId[] {
  const from = order.indexOf(sceneId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
