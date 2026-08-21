import type { ClassroomProject } from "../../types";
import { MAX_PROJECT_SCENES } from "../structural-limits";

export function remainingProjectSceneCapacity(project: ClassroomProject): number {
  return Math.max(0, MAX_PROJECT_SCENES - Object.keys(project.scenes).length);
}

export function assertProjectCanAcceptPdfPages(
  project: ClassroomProject,
  additionalPages: number,
): number {
  if (!Number.isSafeInteger(additionalPages) || additionalPages < 0) {
    throw new Error("The PDF page capacity request is invalid.");
  }
  const remaining = remainingProjectSceneCapacity(project);
  if (additionalPages > remaining) {
    throw new Error(
      remaining === 0
        ? "This project has reached its page and scene limit. Delete a page or scene before adding another PDF page."
        : `This project can add at most ${remaining} more PDF ${remaining === 1 ? "page" : "pages"}.`,
    );
  }
  return remaining - additionalPages;
}
