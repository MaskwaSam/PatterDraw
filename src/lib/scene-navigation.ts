import type { ClassroomProject } from "../types";

/** Capture one navigation intent without replacing concurrent project edits. */
export function createSceneNavigationProjectUpdate(
  sceneId: string,
): (current: ClassroomProject | null) => ClassroomProject | null {
  const selectedProjects = new WeakMap<ClassroomProject, ClassroomProject>();
  return (current) => {
    if (!current || !current.scenes[sceneId] || current.activeSceneId === sceneId) return current;
    // React can replay this intent against the same earlier input while
    // rebasing a queued edit. Fresh results repeatedly change native editor
    // children, whose menu tunnel schedules synchronous external-store work.
    // Keep one result per input, including A/B/A rebases, for this intent only.
    if (selectedProjects.has(current)) return selectedProjects.get(current)!;
    const selected = { ...current, activeSceneId: sceneId };
    selectedProjects.set(current, selected);
    return selected;
  };
}
