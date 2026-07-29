import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";

const MAX_EXPORT_EDGE = 8_192;
const MAX_EXPORT_PIXELS = 16_000_000;
const PREFERRED_EXPORT_SCALE = 2;

export interface FullBoardExport {
  blob: Blob;
  scale: number;
}

export function getBoardExportDimensions(width: number, height: number): {
  width: number;
  height: number;
  scale: number;
} {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Board export bounds must be finite.");
  }
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(
    PREFERRED_EXPORT_SCALE,
    MAX_EXPORT_EDGE / safeWidth,
    MAX_EXPORT_EDGE / safeHeight,
    Math.sqrt(MAX_EXPORT_PIXELS) / Math.sqrt(safeWidth) / Math.sqrt(safeHeight),
  );
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
    scale,
  };
}

function isExportableElement(
  element: ExcalidrawElement,
): element is NonDeletedExcalidrawElement {
  return !element.isDeleted && element.type !== "iframe" && element.type !== "embeddable";
}

export async function exportFullBoardPng(
  api: ExcalidrawImperativeAPI,
): Promise<FullBoardExport> {
  const elements = api.getSceneElements().filter(isExportableElement);
  if (!elements.length) throw new Error("Add something to the board before exporting it.");

  const appState = api.getAppState();
  let actualScale = 1;
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: 32,
    appState: {
      ...appState,
      exportBackground: true,
      exportEmbedScene: true,
      exportWithDarkMode: false,
      frameRendering: {
        ...appState.frameRendering,
        clip: false,
      },
    },
    getDimensions: (width: number, height: number) => {
      const dimensions = getBoardExportDimensions(width, height);
      actualScale = dimensions.scale;
      return dimensions;
    },
  });

  return { blob, scale: actualScale };
}
