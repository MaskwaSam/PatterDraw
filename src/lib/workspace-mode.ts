import type { ClassroomProject, SceneId } from "../types";

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
