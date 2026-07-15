import { createBlankProject, type ClassroomProject, type SceneId } from "../types";

export type WorkspaceMode = "board" | "slides" | "pdf";

export function workspaceModeClassName(mode: WorkspaceMode): string {
  if (mode === "slides") return "is-slide-mode";
  return `is-${mode}-mode`;
}

export function boardSceneId(project: ClassroomProject): SceneId | null {
  const activeScene = project.scenes[project.activeSceneId];
  if (activeScene && !activeScene.pdfPage) return activeScene.id;
  return Object.values(project.scenes).find((scene) => !scene.pdfPage)?.id || null;
}

export function projectForBoardStartup(project: ClassroomProject): ClassroomProject {
  const targetSceneId = boardSceneId(project);
  if (targetSceneId) {
    return targetSceneId === project.activeSceneId
      ? project
      : { ...project, activeSceneId: targetSceneId };
  }

  const blank = createBlankProject();
  const boardScene = blank.scenes[blank.activeSceneId];
  return {
    ...project,
    activeSceneId: boardScene.id,
    scenes: { ...project.scenes, [boardScene.id]: boardScene },
  };
}
