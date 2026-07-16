import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  createLassoGeometrySnapshot,
  simplifyLassoPath,
  type LassoPoint,
} from "./stable-element-adapter";
import { resolveLassoSelection } from "./selection";
import { lassoViewportToScenePoint } from "./coordinates";

type ElementOverrides = Record<string, unknown> & { id: string; type: string };

function element(overrides: ElementOverrides): ExcalidrawElement {
  const common = {
    x: 0,
    y: 0,
    width: 80,
    height: 60,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
  const additions = overrides.type === "text" ? {
    fontSize: 20,
    fontFamily: 1,
    text: "Text",
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    originalText: "Text",
    autoResize: true,
    lineHeight: 1.25,
  } : overrides.type === "image" ? {
    fileId: null,
    status: "saved",
    scale: [1, 1],
    crop: null,
  } : overrides.type === "line" ? {
    points: [[0, 0], [80, 60]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  } : overrides.type === "arrow" ? {
    points: [[0, 60], [80, 0]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
  } : overrides.type === "freedraw" ? {
    points: [[0, 30], [20, 0], [50, 60], [80, 20]],
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: null,
  } : overrides.type === "frame" ? { name: "Slide" } : {};
  return { ...common, ...additions, ...overrides } as unknown as ExcalidrawElement;
}

function enclosingPath(x: number, y: number, width = 80, height = 60): LassoPoint[] {
  return [
    [x - 10, y - 10],
    [x + width + 10, y - 10],
    [x + width + 10, y + height + 10],
    [x - 10, y + height + 10],
  ];
}

describe("lasso geometry", () => {
  it.each(["rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image"])(
    "selects enclosed %s elements using their actual geometry",
    (type) => {
      const target = element({ id: type, type, x: 100, y: 100 });
      const geometry = createLassoGeometrySnapshot([target]);
      expect(geometry.getSelectedElementIds(enclosingPath(100, 100), 5)).toEqual([type]);
    },
  );

  it("selects a shape when the lasso intersects it without enclosing it", () => {
    const target = element({ id: "ellipse", type: "ellipse", x: 100, y: 100, width: 100, height: 80 });
    const geometry = createLassoGeometrySnapshot([target]);
    expect(geometry.getSelectedElementIds([
      [70, 130], [130, 130], [130, 150], [70, 150],
    ], 0)).toEqual(["ellipse"]);
  });

  it("excludes locked elements, including locked image backgrounds", () => {
    const lockedRectangle = element({ id: "locked", type: "rectangle", x: 100, y: 100, locked: true });
    const pdfBackground = element({ id: "pdf", type: "image", x: 100, y: 100, locked: true });
    const unlocked = element({ id: "free", type: "rectangle", x: 100, y: 100 });
    const geometry = createLassoGeometrySnapshot([lockedRectangle, pdfBackground, unlocked]);
    expect(geometry.getSelectedElementIds(enclosingPath(100, 100), 5)).toEqual(["free"]);
  });

  it("simplifies dense paths at the requested scene distance", () => {
    const dense = Array.from({ length: 21 }, (_, index) => [index, index % 2 ? 0.2 : 0] as LassoPoint);
    const simplified = simplifyLassoPath(dense, 5);
    expect(simplified.length).toBeLessThan(dense.length);
    expect(simplified[0]).toEqual(dense[0]);
    expect(simplified.at(-1)).toEqual(dense.at(-1));
  });

  it("converts viewport points through pan, zoom, and editor offsets", () => {
    expect(lassoViewportToScenePoint(
      330,
      260,
      { offsetLeft: 30, offsetTop: 20, scrollX: -50, scrollY: 25, zoom: { value: 2 } },
    )).toEqual([200, 95]);
  });
});

describe("lasso selection semantics", () => {
  it("adds the lasso hits to the previous selection only while Shift is held", () => {
    const elements = [
      element({ id: "a", type: "rectangle" }),
      element({ id: "b", type: "rectangle" }),
    ];
    expect(resolveLassoSelection(elements, {
      additive: false,
      hitElementIds: ["b"],
      previousSelectedElementIds: { a: true },
    }).selectedElementIds).toEqual({ b: true });
    expect(resolveLassoSelection(elements, {
      additive: true,
      hitElementIds: ["b"],
      previousSelectedElementIds: { a: true },
    }).selectedElementIds).toEqual({ a: true, b: true });
  });

  it("expands a hit group to every member and records the selected group", () => {
    const elements = [
      element({ id: "a", type: "rectangle", groupIds: ["inner", "outer"] }),
      element({ id: "b", type: "ellipse", groupIds: ["inner", "outer"] }),
      element({ id: "c", type: "diamond" }),
    ];
    expect(resolveLassoSelection(elements, { hitElementIds: ["a"] })).toEqual({
      selectedElementIds: { a: true, b: true },
      selectedGroupIds: { outer: true },
    });
    expect(resolveLassoSelection(elements, { editingGroupId: "outer", hitElementIds: ["a"] })).toEqual({
      selectedElementIds: { a: true, b: true },
      selectedGroupIds: { inner: true },
    });
  });

  it("maps bound text hits to their container", () => {
    const container = element({ id: "box", type: "rectangle", boundElements: [{ id: "label", type: "text" }] });
    const label = element({ id: "label", type: "text", containerId: "box" });
    expect(resolveLassoSelection([container, label], { hitElementIds: ["label"] }).selectedElementIds)
      .toEqual({ box: true });
  });

  it("gives a selected frame precedence over its children", () => {
    const frame = element({ id: "frame", type: "frame" });
    const child = element({ id: "child", type: "rectangle", frameId: "frame" });
    const outside = element({ id: "outside", type: "rectangle" });
    expect(resolveLassoSelection([frame, child, outside], {
      hitElementIds: ["frame", "child", "outside"],
    }).selectedElementIds).toEqual({ frame: true, outside: true });
  });
});
