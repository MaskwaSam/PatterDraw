import { describe, expect, it } from "vitest";
import type { SerializedScene } from "../../types";
import {
  getPdfPageDisplayGeometry,
  getPdfPageEffectiveRotation,
  getPdfPageSourceGeometry,
  getPdfPageViewRotation,
  nextPdfPageViewRotation,
  rotatePdfPagePoint,
  rotatePdfScene,
} from "./page-rotation";

function sceneWithAnnotations(): SerializedScene {
  return {
    id: "page",
    name: "Source page",
    elements: [
      {
        id: "background",
        type: "image",
        fileId: "page-image",
        x: 0,
        y: 0,
        width: 600,
        height: 800,
        angle: 0,
        locked: true,
        isDeleted: false,
        opacity: 100,
        frameId: null,
        boundElements: null,
        groupIds: [],
        scale: [1, 1],
        crop: null,
        link: null,
        status: "saved",
        customData: {
          classroomRole: "pdf-background",
          pdfDocumentId: "pdf",
          pdfPageIndex: 0,
        },
      },
      {
        id: "container",
        type: "rectangle",
        x: 100,
        y: 120,
        width: 180,
        height: 120,
        angle: 0.25,
        boundElements: [{ id: "arrow", type: "arrow" }, { id: "text", type: "text" }],
        groupIds: ["group"],
        frameId: "frame",
      },
      {
        id: "text",
        type: "text",
        x: 130,
        y: 150,
        width: 100,
        height: 30,
        angle: 0.25,
        containerId: "container",
        groupIds: ["group"],
        frameId: "frame",
      },
      {
        id: "arrow",
        type: "arrow",
        x: 140,
        y: 160,
        width: 220,
        height: 80,
        angle: 0,
        points: [[0, 0], [100, 40], [220, 80]],
        startBinding: { elementId: "container", focus: 0.2, gap: 4, fixedPoint: [0.2, 0.5] },
        endBinding: { elementId: "container", focus: -0.4, gap: 6, fixedPoint: [0.9, 0.5] },
        fixedSegments: [{ start: [0, 0], end: [100, 40], index: 0 }],
        boundElements: null,
        groupIds: [],
        frameId: "frame",
      },
      {
        id: "ink",
        type: "freedraw",
        x: -80,
        y: 830,
        width: 160,
        height: 40,
        angle: 0,
        points: [[0, 0], [80, 20], [160, 40]],
        pressures: [0.2, 0.5, 0.8],
        lastCommittedPoint: [160, 40],
        groupIds: [],
        frameId: null,
      },
      {
        id: "deleted",
        type: "line",
        x: -50,
        y: -30,
        width: 30,
        height: 10,
        angle: 0,
        points: [[0, 0], [30, 10]],
        isDeleted: true,
        groupIds: [],
        frameId: null,
      },
      {
        id: "frame",
        type: "frame",
        x: 80,
        y: 90,
        width: 300,
        height: 300,
        angle: 0,
        groupIds: [],
        frameId: null,
      },
    ],
    appState: {},
    files: {
      "page-image": { id: "page-image", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" },
    },
    pdfPage: {
      documentId: "pdf",
      pageIndex: 0,
      width: 600,
      height: 800,
      rotation: 90,
      backgroundElementId: "background",
    },
  };
}

describe("PDF page view rotation", () => {
  it("defaults missing view rotation to zero and keeps source geometry immutable", () => {
    const scene = sceneWithAnnotations();
    expect(getPdfPageViewRotation(scene.pdfPage!)).toBe(0);
    expect(getPdfPageDisplayGeometry(scene.pdfPage!)).toEqual({ width: 600, height: 800 });
    expect(getPdfPageEffectiveRotation(scene.pdfPage!)).toBe(90);
    expect(getPdfPageSourceGeometry(scene.pdfPage!)).toEqual({ width: 800, height: 600 });
    expect(() => getPdfPageViewRotation({ viewRotation: 45 as 0 })).toThrow(/view rotation/);
  });

  it("maps quarter-turn points without trigonometric drift", () => {
    expect(rotatePdfPagePoint([10, 20], 600, 800, 90)).toEqual([780, 10]);
    expect(rotatePdfPagePoint([10, 20], 600, 800, 180)).toEqual([590, 780]);
    expect(rotatePdfPagePoint([10, 20], 600, 800, 270)).toEqual([20, 590]);
  });

  it("transforms annotations, tombstones, bindings, and off-page writing", () => {
    const original = sceneWithAnnotations();
    const rotated = rotatePdfScene(original, "clockwise");
    expect(rotated.pdfPage).toMatchObject({
      width: 600,
      height: 800,
      rotation: 90,
      viewRotation: 90,
    });
    expect(getPdfPageDisplayGeometry(rotated.pdfPage!)).toEqual({ width: 800, height: 600 });
    const elements = new Map(rotated.elements.map((element) => [String(element.id), element]));
    expect(elements.get("container")).toMatchObject({ frameId: "frame", groupIds: ["group"] });
    expect(elements.get("text")).toMatchObject({ containerId: "container", frameId: "frame", groupIds: ["group"] });
    expect(elements.get("arrow")).toMatchObject({
      startBinding: expect.objectContaining({ elementId: "container", fixedPoint: [0.2, 0.5] }),
      endBinding: expect.objectContaining({ elementId: "container", fixedPoint: [0.9, 0.5] }),
    });
    expect(elements.get("deleted")).toMatchObject({ isDeleted: true });
    expect((elements.get("ink") as Record<string, unknown>).x).toBeLessThan(0);
    expect((elements.get("ink") as Record<string, unknown>).y).toBeLessThan(0);
  });

  it("uses local point bounds for angled lines with negative coordinates", () => {
    const source = sceneWithAnnotations();
    const line = {
      id: "negative-line",
      type: "line",
      x: 200,
      y: 300,
      width: 100,
      height: 100,
      angle: Math.PI / 2,
      points: [[0, 0], [-100, 100]],
      groupIds: [],
      frameId: null,
    };
    const scene: SerializedScene = {
      ...source,
      elements: [source.elements[0], line],
    };

    const rotated = rotatePdfScene(scene, "clockwise");
    const actual = rotated.elements.find((element) => element.id === line.id) as {
      x: number;
      y: number;
      points: Array<[number, number]>;
      angle: number;
    };
    const globalPoints = actual.points.map(([x, y]) => [actual.x + x, actual.y + y]);
    expect(globalPoints).toEqual([[400, 200], [500, 100]]);
    expect(actual.angle).toBe(0);
  });

  it("restores semantic geometry after four clockwise turns", () => {
    const original = sceneWithAnnotations();
    let rotated = original;
    for (let index = 0; index < 4; index += 1) rotated = rotatePdfScene(rotated, "clockwise");
    expect(rotated.pdfPage?.viewRotation).toBe(0);
    expect(rotated.pdfPage?.width).toBe(original.pdfPage?.width);
    expect(rotated.pdfPage?.height).toBe(original.pdfPage?.height);
    for (const id of ["container", "text", "arrow", "ink", "deleted", "frame"]) {
      const actual = rotated.elements.find((element) => element.id === id) as Record<string, unknown>;
      const expected = original.elements.find((element) => element.id === id) as Record<string, unknown>;
      expect(actual.x).toBeCloseTo(Number(expected.x), 8);
      expect(actual.y).toBeCloseTo(Number(expected.y), 8);
      expect(actual.width).toBeCloseTo(Number(expected.width), 8);
      expect(actual.height).toBeCloseTo(Number(expected.height), 8);
      expect(actual.id).toBe(expected.id);
    }
    expect(rotated.elements.find((element) => element.id === "arrow")).toMatchObject({
      startBinding: expect.objectContaining({ fixedPoint: [0.2, 0.5] }),
    });
  });

  it("supports counterclockwise actions and cumulative effective rotation", () => {
    expect(nextPdfPageViewRotation(0, "clockwise")).toBe(90);
    expect(nextPdfPageViewRotation(0, "counterclockwise")).toBe(270);
    const scene = rotatePdfScene(sceneWithAnnotations(), "counterclockwise");
    expect(scene.pdfPage?.viewRotation).toBe(270);
    expect(getPdfPageEffectiveRotation(scene.pdfPage!)).toBe(0);
  });
});
