import type { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type PresentationInkApi = Pick<ExcalidrawImperativeAPI, "getAppState" | "setActiveTool" | "updateScene">;

export const PRESENTATION_INK_COLOURS = [
  { label: "Black", value: "#1b1b1f" },
  { label: "Red", value: "#e03131" },
  { label: "Orange", value: "#e8590c" },
  { label: "Blue", value: "#1971c2" },
  { label: "Green", value: "#2f9e44" },
  { label: "Purple", value: "#7048e8" },
] as const;

export type PresentationInkColour = (typeof PRESENTATION_INK_COLOURS)[number]["value"];

export const DEFAULT_PRESENTATION_INK_COLOUR: PresentationInkColour = PRESENTATION_INK_COLOURS[0].value;

export const PRESENTATION_INK_WIDTHS = [
  { label: "Extra fine", value: 1 },
  { label: "Fine", value: 2 },
  { label: "Regular", value: 3 },
] as const;

export type PresentationInkWidth = (typeof PRESENTATION_INK_WIDTHS)[number]["value"];

export const DEFAULT_PRESENTATION_INK_WIDTH: PresentationInkWidth = PRESENTATION_INK_WIDTHS[2].value;

/** Converts a screen-space width to the scene-space width Excalidraw stores. */
export function presentationInkSceneWidth(screenWidth: PresentationInkWidth, zoom: number): number {
  return screenWidth / Math.max(zoom, 0.01);
}

export function activatePresentationInk(
  api: PresentationInkApi,
  colour: PresentationInkColour,
  screenWidth: PresentationInkWidth,
): void {
  const sceneWidth = presentationInkSceneWidth(screenWidth, api.getAppState().zoom.value);
  api.updateScene({
    appState: {
      currentItemStrokeColor: colour,
      currentItemStrokeWidth: sceneWidth,
    },
    captureUpdate: "NEVER" as (typeof CaptureUpdateAction)["NEVER"],
  });
  api.setActiveTool({ type: "freedraw" });
}
