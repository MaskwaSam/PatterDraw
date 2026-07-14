import { describe, expect, it } from "vitest";
import type { SerializedScene } from "../types";
import { getSlideRenderData } from "./slide-render";

function element(
  id: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    isDeleted: false,
    frameId: null,
    version: 1,
    versionNonce: 11,
    index: id,
    ...overrides,
  };
}

function scene(elements: readonly Record<string, unknown>[]): SerializedScene {
  return {
    id: "scene",
    name: "Board",
    elements,
    appState: {},
    files: {
      "used-file": {
        id: "used-file",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
        created: 1,
        version: 2,
      },
      "unused-file": {
        id: "unused-file",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,BB==",
        created: 1,
        version: 1,
      },
    },
  };
}

describe("slide render data", () => {
  it("keeps source order and includes safe direct or geometrically overlapping content", () => {
    const input = scene([
      element("first-child", "rectangle", { frameId: "frame" }),
      element("other", "ellipse"),
      element("overlapping", "diamond", { x: 100, y: 100, width: 80, height: 80, frameId: "other-frame" }),
      element("partial", "line", { x: -20, y: 200, width: 40, height: 20 }),
      element("outside", "rectangle", { x: 1_400, y: 100, width: 50, height: 50 }),
      element("other-frame", "frame", { x: 100, y: 100, width: 100, height: 100 }),
      element("frame", "frame", { x: 0, y: 0, width: 1_280, height: 720 }),
      element("image", "image", { frameId: "frame", fileId: "used-file" }),
      element("nested-elsewhere", "text", { frameId: "other-frame" }),
      element("deleted", "text", { frameId: "frame", isDeleted: true }),
      element("embed", "embeddable", { frameId: "frame" }),
      element("iframe", "iframe", { frameId: "frame" }),
      element("generated", "magicframe", { frameId: "frame" }),
      element("last-child", "text", { frameId: "frame" }),
    ]);

    const result = getSlideRenderData(input, "frame");

    expect(result?.frame.id).toBe("frame");
    expect(result?.elements.map((candidate) => candidate.id)).toEqual([
      "first-child",
      "overlapping",
      "partial",
      "frame",
      "image",
      "last-child",
    ]);
    expect(Object.keys(result?.files || {})).toEqual(["used-file"]);
    expect(result?.elements.find((candidate) => candidate.id === "overlapping")?.frameId).toBe("frame");
    expect(input.elements.find((candidate) => candidate.id === "overlapping")?.frameId).toBe("other-frame");
  });

  it("returns null for missing or deleted frames", () => {
    expect(getSlideRenderData(scene([]), "missing")).toBeNull();
    expect(getSlideRenderData(
      scene([element("frame", "frame", { isDeleted: true })]),
      "frame",
    )).toBeNull();
  });
});
