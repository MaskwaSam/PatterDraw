import type { AppState } from "@excalidraw/excalidraw/types";

export type PdfActiveTool = AppState["activeTool"];

const STICKY_PDF_ANNOTATION_TOOLS = new Set<PdfActiveTool["type"]>([
  "arrow",
  "diamond",
  "ellipse",
  "eraser",
  "freedraw",
  "line",
  "rectangle",
  "text",
]);

/**
 * PDF annotation is a repeat workflow: once a native mark-up tool is chosen,
 * keep it armed until the teacher or student explicitly chooses another tool.
 * Wrapper-owned custom tools are excluded because their React pointer overlay
 * is intentionally torn down whenever the active PDF page changes.
 */
export function retainedPdfActiveTool(tool: unknown): PdfActiveTool | null {
  if (!tool || typeof tool !== "object") return null;
  const activeTool = tool as PdfActiveTool;
  if (typeof activeTool.type !== "string" || activeTool.type === "custom") return null;
  return {
    ...activeTool,
    locked: STICKY_PDF_ANNOTATION_TOOLS.has(activeTool.type),
  };
}
