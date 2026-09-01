import {
  createBlankProject,
  type ClassroomProject,
  type PdfDocumentSource,
  type SerializedScene,
} from "../../types";

/**
 * Remove every PDF-owned scene and source while retaining the ordinary board,
 * slides, title, and other project metadata. A legacy PDF-only project gains a
 * blank board so the replacement candidate always has a non-PDF workspace.
 */
export function projectForPdfReplacement(project: ClassroomProject): ClassroomProject {
  const scenes = Object.fromEntries(
    Object.entries(project.scenes).filter(([, scene]) => !scene.pdfPage),
  );
  if (!Object.keys(scenes).length) {
    const blank = createBlankProject();
    scenes[blank.activeSceneId] = blank.scenes[blank.activeSceneId];
  }
  const activeSceneId = scenes[project.activeSceneId]
    ? project.activeSceneId
    : Object.keys(scenes)[0];
  return {
    ...project,
    activeSceneId,
    scenes,
    slideOrder: project.slideOrder.filter((slide) => Boolean(scenes[slide.sceneId])),
    pdfPageOrder: [],
    pdfDocuments: {},
  };
}

/** Build the complete candidate for a normal PDF open (replace, never append). */
export function replaceProjectPdf(
  project: ClassroomProject,
  importedScenes: readonly SerializedScene[],
  source: PdfDocumentSource,
  updatedAt: string,
): ClassroomProject {
  if (!importedScenes.length) throw new Error("The imported PDF has no pages.");
  const base = projectForPdfReplacement(project);
  const scenes = { ...base.scenes };
  for (const scene of importedScenes) {
    if (!scene.pdfPage || scene.pdfPage.documentId !== source.id) {
      throw new Error("The imported PDF page does not match its source document.");
    }
    if (scenes[scene.id]) throw new Error("The imported PDF page ID is already in use.");
    scenes[scene.id] = scene;
  }
  return {
    ...base,
    updatedAt,
    activeSceneId: importedScenes[0].id,
    scenes,
    pdfPageOrder: importedScenes.map((scene) => scene.id),
    pdfDocuments: { [source.id]: source },
  };
}
