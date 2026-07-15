import { describe, expect, it, vi } from "vitest";
import {
  activatePresentationInk,
  DEFAULT_PRESENTATION_INK_WIDTH,
  PRESENTATION_INK_COLOURS,
  PRESENTATION_INK_WIDTHS,
  presentationInkSceneWidth,
  promoteNewPresentationInk,
} from "./presentation-ink";

describe("presentation ink", () => {
  it("offers at least five distinct, labelled colours", () => {
    expect(PRESENTATION_INK_COLOURS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(PRESENTATION_INK_COLOURS.map(({ value }) => value)).size).toBe(PRESENTATION_INK_COLOURS.length);
    expect(new Set(PRESENTATION_INK_COLOURS.map(({ label }) => label)).size).toBe(PRESENTATION_INK_COLOURS.length);
  });

  it("sets the chosen stroke colour before activating freehand ink", () => {
    const api = {
      getAppState: () => ({ zoom: { value: 0.5 } }),
      updateScene: vi.fn(),
      updateFrameRendering: vi.fn(),
      setActiveTool: vi.fn(),
    };

    activatePresentationInk(api as never, "#1971c2", DEFAULT_PRESENTATION_INK_WIDTH);

    expect(api.updateFrameRendering).toHaveBeenCalledWith({ clip: false });
    expect(api.updateScene).toHaveBeenCalledWith({
      appState: {
        currentItemStrokeColor: "#1971c2",
        currentItemStrokeWidth: 6,
      },
      captureUpdate: "NEVER",
    });
    expect(api.setActiveTool).toHaveBeenCalledWith({ type: "freedraw" });
    expect(api.updateScene.mock.invocationCallOrder[0]).toBeLessThan(api.setActiveTool.mock.invocationCallOrder[0]);
  });

  it("offers two finer widths and compensates scene width for presentation zoom", () => {
    expect(PRESENTATION_INK_WIDTHS.map(({ value }) => value)).toEqual([1, 2, 3]);
    expect(presentationInkSceneWidth(1, 0.5)).toBe(2);
    expect(presentationInkSceneWidth(1, 2)).toBe(0.5);
    expect(presentationInkSceneWidth(3, 0)).toBe(300);
  });

  it("moves newly completed ink above slide content and older ink", () => {
    const element = (id: string, type: string, frameId: string | null = null) => ({
      id,
      type,
      frameId,
      version: 1,
      versionNonce: 1,
      updated: 1,
      isDeleted: false,
    });
    const frame = element("frame", "frame");
    const olderInk = element("older-ink", "freedraw", null);
    const slideContent = element("content", "rectangle", "frame");
    const newestInk = element("newest-ink", "freedraw", "frame");

    const promoted = promoteNewPresentationInk(
      [frame, olderInk, newestInk, slideContent] as never,
      new Set([frame.id, olderInk.id, slideContent.id]),
    );

    expect(promoted.map(({ id }) => id)).toEqual(["frame", "older-ink", "content", "newest-ink"]);
    expect(promoted.at(-1)?.frameId).toBeNull();
  });
});
