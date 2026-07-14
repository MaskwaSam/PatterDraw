import { exportToBlob } from "@excalidraw/excalidraw";
import type { SerializedScene } from "../types";
import { getSlideRenderData } from "./slide-render";

export { slidePreviewRevision } from "./slide-render";

export const SLIDE_THUMBNAIL_MAX_EDGE = 320;

/** Renders a small, frame-clipped PNG without touching the live editor. */
export async function renderSlideThumbnail(
  scene: SerializedScene,
  frameId: string,
): Promise<Blob | null> {
  const data = getSlideRenderData(scene, frameId);
  if (!data) return null;
  return exportToBlob({
    elements: data.elements,
    files: data.files,
    exportingFrame: data.frame,
    mimeType: "image/png",
    maxWidthOrHeight: SLIDE_THUMBNAIL_MAX_EDGE,
    exportPadding: 0,
    appState: {
      exportBackground: true,
      viewBackgroundColor: "#ffffff",
    },
  });
}
