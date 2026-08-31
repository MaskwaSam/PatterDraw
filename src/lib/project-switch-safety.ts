import { DEFAULT_PROJECT_TITLE, type ClassroomProject } from "../types";

function hasLiveSceneElement(project: ClassroomProject): boolean {
  return Object.values(project.scenes).some((scene) => (
    scene.elements.some((element) => element.isDeleted !== true)
  ));
}

const DEFAULT_CANVAS_BACKGROUND = "#ffffff";
const DEFAULT_GRID_SIZE = 20;
const DEFAULT_GRID_STEP = 5;

/**
 * These values affect the saved classroom surface even when it has no drawn
 * elements. Deliberately do not compare the complete Excalidraw app state:
 * scroll, zoom, selection, active tool, native Zen mode, and similar browser
 * state must not turn an untouched startup board into protected content.
 */
function hasContentBearingSceneAppearance(project: ClassroomProject): boolean {
  return Object.values(project.scenes).some((scene) => {
    const background = scene.appState.viewBackgroundColor;
    if (
      typeof background === "string"
      && background.toLowerCase() !== DEFAULT_CANVAS_BACKGROUND
    ) return true;

    const gridSize = scene.appState.gridSize;
    if (typeof gridSize === "number" && gridSize !== DEFAULT_GRID_SIZE) return true;

    const gridStep = scene.appState.gridStep;
    return typeof gridStep === "number" && gridStep !== DEFAULT_GRID_STEP;
  });
}

/**
 * Decide whether replacing the active board needs the explicit backup gate.
 * View-only state such as zoom is ignored, while any user-created structure,
 * content, title, PDF, slide, or project calendar event is protected.
 */
export function projectNeedsSwitchProtection(project: ClassroomProject): boolean {
  if (project.titleMode === "custom" || project.title !== DEFAULT_PROJECT_TITLE) return true;
  if (Object.keys(project.scenes).length > 1) return true;
  if (hasLiveSceneElement(project)) return true;
  if (hasContentBearingSceneAppearance(project)) return true;
  if (project.slideOrder.length > 0) return true;
  if ((project.pdfPageOrder?.length ?? 0) > 0) return true;
  if (Object.keys(project.pdfDocuments).length > 0) return true;
  if ((project.projectCalendar?.events.length ?? 0) > 0) return true;
  return false;
}
