import {
  convertToExcalidrawElements,
  exportToBlob,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { createLocalId } from "../id";
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
  SCREENSHOT_PREFERRED_SCALE,
} from "./limits";

export {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
  SCREENSHOT_PREFERRED_SCALE,
} from "./limits";

export interface CapturePoint {
  x: number;
  y: number;
}

export interface ViewportCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneCaptureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotExportDimensions {
  width: number;
  height: number;
  scale: number;
}

export interface RenderedScreenshot {
  blob: Blob;
  width: number;
  height: number;
  sceneWidth: number;
  sceneHeight: number;
}

export interface ScreenshotExportSource {
  elements?: readonly ExcalidrawElement[];
  files?: BinaryFiles;
}

export type ClipboardWriteResult = "success" | "unsupported" | "denied" | "failed";

type PngResizer = (source: Blob, width: number, height: number) => Promise<Blob>;

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Screenshot ${label} must be a positive finite number.`);
  }
  return value;
}

export function normalizeCaptureRect(
  start: CapturePoint,
  end: CapturePoint,
  limits: { width: number; height: number },
): ViewportCaptureRect {
  const clamp = (value: number, maximum: number) => Math.min(Math.max(value, 0), Math.max(0, maximum));
  const startX = clamp(start.x, limits.width);
  const startY = clamp(start.y, limits.height);
  const endX = clamp(end.x, limits.width);
  const endY = clamp(end.y, limits.height);
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function viewportCaptureRectToSceneBounds(
  rect: ViewportCaptureRect,
  viewportOrigin: CapturePoint,
  appState: AppState,
): SceneCaptureBounds {
  const topLeft = viewportCoordsToSceneCoords({
    clientX: viewportOrigin.x + rect.x,
    clientY: viewportOrigin.y + rect.y,
  }, appState);
  const bottomRight = viewportCoordsToSceneCoords({
    clientX: viewportOrigin.x + rect.x + rect.width,
    clientY: viewportOrigin.y + rect.y + rect.height,
  }, appState);
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };
}

export function getScreenshotExportDimensions(
  sceneWidth: number,
  sceneHeight: number,
): ScreenshotExportDimensions {
  const safeWidth = finitePositive(sceneWidth, "width");
  const safeHeight = finitePositive(sceneHeight, "height");
  const scale = Math.min(
    SCREENSHOT_PREFERRED_SCALE,
    MAX_SCREENSHOT_EDGE / safeWidth,
    MAX_SCREENSHOT_EDGE / safeHeight,
    Math.sqrt(MAX_SCREENSHOT_PIXELS / (safeWidth * safeHeight)),
  );
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
    scale,
  };
}

export function createScreenshotExportFrame(bounds: SceneCaptureBounds): ExcalidrawFrameElement {
  finitePositive(bounds.width, "frame width");
  finitePositive(bounds.height, "frame height");
  const [frame] = convertToExcalidrawElements([{
    id: createLocalId(),
    type: "frame",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    children: [],
    locked: true,
  }], { regenerateIds: false });
  return frame as ExcalidrawFrameElement;
}

function isExportableElement(element: ExcalidrawElement): element is NonDeletedExcalidrawElement {
  return !element.isDeleted && element.type !== "iframe" && element.type !== "embeddable";
}

async function resizePng(source: Blob, width: number, height: number): Promise<Blob> {
  const image = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser cannot resize screenshots.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("This browser could not create the resized screenshot."));
      }, "image/png");
    });
  } finally {
    image.close();
  }
}

export async function downsamplePngToByteLimit(
  blob: Blob,
  width: number,
  height: number,
  resizer: PngResizer = resizePng,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (blob.type !== "image/png") throw new Error("Screenshot rendering did not produce a PNG.");
  if (blob.size <= MAX_SCREENSHOT_BYTES) return { blob, width, height };

  let currentBlob = blob;
  let currentWidth = Math.max(1, Math.floor(width));
  let currentHeight = Math.max(1, Math.floor(height));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const byteRatio = Math.sqrt(MAX_SCREENSHOT_BYTES / currentBlob.size) * 0.92;
    const scale = Math.min(0.9, Math.max(0.1, byteRatio));
    const nextWidth = Math.max(1, Math.floor(currentWidth * scale));
    const nextHeight = Math.max(1, Math.floor(currentHeight * scale));
    if (nextWidth === currentWidth && nextHeight === currentHeight) break;
    currentBlob = await resizer(currentBlob, nextWidth, nextHeight);
    currentWidth = nextWidth;
    currentHeight = nextHeight;
    if (currentBlob.type !== "image/png") throw new Error("Screenshot downsampling did not produce a PNG.");
    if (currentBlob.size <= MAX_SCREENSHOT_BYTES) {
      return { blob: currentBlob, width: currentWidth, height: currentHeight };
    }
    if (currentWidth === 1 && currentHeight === 1) break;
  }
  throw new Error("The screenshot could not be reduced below the 4 MB storage limit.");
}

export async function exportScreenshotArea(
  api: ExcalidrawImperativeAPI,
  bounds: SceneCaptureBounds,
  source: ScreenshotExportSource = {},
): Promise<RenderedScreenshot> {
  const frame = createScreenshotExportFrame(bounds);
  const appState = api.getAppState();
  const elements = (source.elements || api.getSceneElements()).filter(isExportableElement);
  let renderedDimensions = getScreenshotExportDimensions(bounds.width, bounds.height);
  const blob = await exportToBlob({
    elements,
    files: source.files || api.getFiles(),
    mimeType: "image/png",
    exportPadding: 0,
    exportingFrame: frame,
    appState: {
      ...appState,
      exportBackground: true,
      exportEmbedScene: false,
      exportWithDarkMode: false,
      frameRendering: {
        ...appState.frameRendering,
        clip: false,
        name: false,
        outline: false,
      },
    },
    getDimensions: (width: number, height: number) => {
      renderedDimensions = getScreenshotExportDimensions(width, height);
      return renderedDimensions;
    },
  });
  const limited = await downsamplePngToByteLimit(
    blob,
    renderedDimensions.width,
    renderedDimensions.height,
  );
  return {
    ...limited,
    sceneWidth: bounds.width,
    sceneHeight: bounds.height,
  };
}

export function beginPngClipboardWrite(png: Promise<Blob>): Promise<ClipboardWriteResult> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return Promise.resolve("unsupported");
  }
  try {
    const write = navigator.clipboard.write([
      new ClipboardItem({ "image/png": png }),
    ]);
    return write.then(
      () => "success" as const,
      (error: unknown) => (
        error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
          ? "denied" as const
          : "failed" as const
      ),
    );
  } catch (error) {
    return Promise.resolve(
      error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
        ? "denied"
        : "failed",
    );
  }
}

export async function pngBlobToDataUrl(blob: Blob): Promise<DataURL> {
  if (blob.type !== "image/png") throw new Error("Only PNG screenshots can be inserted.");
  return await new Promise<DataURL>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("The screenshot could not be read."));
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/png")) {
        resolve(reader.result as DataURL);
      } else {
        reject(new Error("The screenshot could not be converted to a local image."));
      }
    };
    reader.readAsDataURL(blob);
  });
}
