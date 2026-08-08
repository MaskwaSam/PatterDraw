import { describe, expect, it, vi } from "vitest";
import { newElement, newImageElement, newLinearElement } from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import { pointFrom } from "@excalidraw/math";
import type { GlobalPoint, LocalPoint } from "@excalidraw/math";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { applyBucketFill } from "./apply";
import {
  computeBucketFillPolygon,
  isRestylableFill,
} from "./geometry";
import {
  DEFAULT_BUCKET_FILL_COLOR,
  effectiveBucketFillColor,
  effectiveBucketFillOpacity,
  effectiveBucketFillStyle,
} from "./settings";

function rectangle(x = 0, y = 0, width = 100, height = 80) {
  return newElement({
    type: "rectangle",
    x,
    y,
    width,
    height,
    strokeColor: "#1b1b1f",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    roughness: 0,
  });
}

function elementMap(elements: readonly ExcalidrawElement[]): ElementsMap {
  return new Map(elements.map((element) => [element.id, element]));
}

function bounds(points: readonly GlobalPoint[]) {
  return points.reduce(
    (value, [x, y]) => ({
      minX: Math.min(value.minX, x),
      minY: Math.min(value.minY, y),
      maxX: Math.max(value.maxX, x),
      maxY: Math.max(value.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

describe("bucket fill geometry", () => {
  it("derives the closed region inside a rectangle", () => {
    const owner = rectangle(20, 30, 120, 90);
    const elements = [owner] as readonly NonDeletedExcalidrawElement[];
    const result = computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(70, 70),
      elements,
      elementsMap: elementMap(elements),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ownerId).toBe(owner.id);
    const regionBounds = bounds(result.scenePoints);
    expect(regionBounds.minX).toBeCloseTo(20, 1);
    expect(regionBounds.minY).toBeCloseTo(30, 1);
    expect(regionBounds.maxX).toBeCloseTo(140, 1);
    expect(regionBounds.maxY).toBeCloseTo(120, 1);
    expect(result.insertion).toEqual({ placement: "below", elementId: owner.id });
  });

  it("keeps bucket paint above a wrapper-owned PDF page background", () => {
    const background = newImageElement({
      type: "image",
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      locked: true,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      customData: { classroomRole: "pdf-background" },
    });
    const owner = rectangle(100, 100, 300, 300);
    const elements = [background, owner] as readonly NonDeletedExcalidrawElement[];
    const result = computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(250, 250),
      elements,
      elementsMap: elementMap(elements),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insertion).toEqual({ placement: "below", elementId: owner.id });
  });

  it("keeps a partially overlapping image above new bucket paint", () => {
    const image = newImageElement({
      type: "image",
      x: -100,
      y: 20,
      width: 150,
      height: 20,
      strokeColor: "transparent",
      backgroundColor: "transparent",
    });
    const owner = rectangle(0, 0, 100, 80);
    const elements = [image, owner] as readonly NonDeletedExcalidrawElement[];
    const result = computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(75, 60),
      elements,
      elementsMap: elementMap(elements),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insertion).toEqual({ placement: "below", elementId: image.id });
  });

  it("fills a region formed entirely by open line boundaries", () => {
    const line = (x: number, y: number, dx: number, dy: number) => newLinearElement({
      type: "line",
      x,
      y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(dx, dy)],
      strokeColor: "#1b1b1f",
      backgroundColor: "transparent",
      roughness: 0,
    });
    const elements = [
      line(0, 0, 100, 0),
      line(100, 0, 0, 100),
      line(100, 100, -100, 0),
      line(0, 100, 0, -100),
    ] as readonly NonDeletedExcalidrawElement[];
    const result = computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(50, 50),
      elements,
      elementsMap: elementMap(elements),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ownerId).toBeNull();
    expect(bounds(result.scenePoints)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(new Set(result.boundaryElementIds)).toEqual(new Set(elements.map((element) => element.id)));
  });

  it("stays silent on empty canvas", () => {
    expect(computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(10, 10),
      elements: [],
      elementsMap: new Map(),
    })).toEqual({ ok: false, reason: "no_owner" });
  });

  it("stops dense intersection work at the configured topology budget", () => {
    const owner = rectangle();
    const elements = [owner] as readonly NonDeletedExcalidrawElement[];

    expect(computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(50, 50),
      elements,
      elementsMap: elementMap(elements),
      options: { maxTopologyChecks: 1 },
    })).toEqual({ ok: false, reason: "too_complex" });
  });

  it("bounds visibility clipping work before building the face graph", () => {
    const owner = rectangle();
    const coverer = (x: number) => newElement({
      type: "rectangle",
      x,
      y: -4,
      width: 8,
      height: 8,
      strokeColor: "transparent",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
    });
    const elements = [owner, coverer(10), coverer(30)] as readonly NonDeletedExcalidrawElement[];

    expect(computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(50, 50),
      elements,
      elementsMap: elementMap(elements),
      options: { maxTopologyChecks: 1 },
    })).toEqual({ ok: false, reason: "too_complex" });
  });

  it("rejects an oversized imported path before expanding its full geometry", () => {
    const points = Array.from({ length: 100 }, (_, index) => {
      const angle = 2 * Math.PI * index / 100;
      return pointFrom<LocalPoint>(50 + Math.cos(angle) * 50, 50 + Math.sin(angle) * 50);
    });
    points.push(points[0]);
    const path = newLinearElement({
      type: "line",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points,
      polygon: true,
      strokeColor: "#1b1b1f",
      backgroundColor: "transparent",
      roughness: 0,
    });
    const elements = [path] as readonly NonDeletedExcalidrawElement[];

    expect(computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(50, 50),
      elements,
      elementsMap: elementMap(elements),
      options: { maxBoundarySegments: 16 },
    })).toEqual({ ok: false, reason: "too_complex" });
  });

  it("skips malformed imported records instead of throwing", () => {
    const malformedColor = {
      ...rectangle(),
      id: "malformed-color",
      backgroundColor: undefined,
    } as unknown as NonDeletedExcalidrawElement;
    const malformedLine = {
      ...newLinearElement({
        type: "line",
        x: 0,
        y: 0,
        points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(10, 10)],
      }),
      id: "malformed-line",
      points: undefined,
    } as unknown as NonDeletedExcalidrawElement;
    const elements = [malformedColor, malformedLine];

    expect(() => computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(10, 10),
      elements,
      elementsMap: elementMap(elements),
    })).not.toThrow();
    expect(computeBucketFillPolygon({
      point: pointFrom<GlobalPoint>(10, 10),
      elements,
      elementsMap: elementMap(elements),
    })).toEqual({ ok: false, reason: "no_owner" });
  });

  it("recognizes an existing generated polygon as the same restylable region", () => {
    const fill = newLinearElement({
      type: "line",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: [
        pointFrom<LocalPoint>(0, 0),
        pointFrom<LocalPoint>(100, 0),
        pointFrom<LocalPoint>(100, 100),
        pointFrom<LocalPoint>(0, 100),
        pointFrom<LocalPoint>(0, 0),
      ],
      polygon: true,
      strokeColor: "transparent",
      backgroundColor: "#ffec99",
      fillStyle: "solid",
      roughness: 0,
    });
    expect(isRestylableFill({
      hitElement: fill,
      scenePoints: [
        pointFrom<GlobalPoint>(0, 0),
        pointFrom<GlobalPoint>(100, 0),
        pointFrom<GlobalPoint>(100, 100),
        pointFrom<GlobalPoint>(0, 100),
        pointFrom<GlobalPoint>(0, 0),
      ],
      elementsMap: elementMap([fill]),
    })).toBe(true);
  });
});

describe("bucket fill application", () => {
  it("adds one vector polygon and uses the visible green fallback", () => {
    const owner = rectangle();
    const updateScene = vi.fn();
    const api = {
      getSceneElements: () => [owner],
      getSceneElementsIncludingDeleted: () => [owner],
      getAppState: () => ({
        currentItemBackgroundColor: "transparent",
        currentItemFillStyle: "solid",
        currentItemOpacity: 100,
      }),
      updateScene,
    } as unknown as ExcalidrawImperativeAPI;

    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "filled" });
    expect(updateScene).toHaveBeenCalledOnce();
    const elements = updateScene.mock.calls[0][0].elements as ExcalidrawElement[];
    expect(elements).toHaveLength(2);
    const fill = elements.find((element) => element.id !== owner.id);
    expect(fill).toMatchObject({
      type: "line",
      polygon: true,
      strokeColor: "transparent",
      backgroundColor: DEFAULT_BUCKET_FILL_COLOR,
      roughness: 0,
    });
  });

  it("restyles an existing matching fill instead of stacking a duplicate", () => {
    const owner = rectangle();
    let elements: ExcalidrawElement[] = [owner];
    let color = "#ffec99";
    const api = {
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({
        currentItemBackgroundColor: color,
        currentItemFillStyle: "solid",
        currentItemOpacity: 100,
      }),
      updateScene: ({ elements: next }: { elements?: readonly ExcalidrawElement[] }) => {
        if (next) elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "filled" });
    const originalFill = elements.find((element) => element.type === "line");
    expect(originalFill).toBeTruthy();
    expect(originalFill?.customData?.classroomBucketFill).toMatchObject({
      version: 1,
      ownerId: owner.id,
      boundaryElementIds: [],
    });

    color = "#ffc9c9";
    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "restyled" });
    const fills = elements.filter((element) => element.type === "line" && !element.isDeleted);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ id: originalFill?.id, backgroundColor: "#ffc9c9" });
  });

  it("fills a same-bounds top shape instead of recoloring an older underlying fill", () => {
    const owner = rectangle();
    let elements: ExcalidrawElement[] = [owner];
    let color = "#ffec99";
    const api = {
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({
        currentItemBackgroundColor: color,
        currentItemFillStyle: "solid",
        currentItemOpacity: 100,
      }),
      updateScene: ({ elements: next }: { elements?: readonly ExcalidrawElement[] }) => {
        if (next) elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "filled" });
    const underlyingFill = elements.find((element) => element.type === "line");
    expect(underlyingFill).toBeTruthy();

    const topOwner = rectangle();
    elements.push(topOwner);
    color = "#ffc9c9";
    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "filled" });

    let fills = elements.filter((element) => element.type === "line" && !element.isDeleted);
    expect(fills).toHaveLength(2);
    expect(fills.find((element) => element.id === underlyingFill?.id)?.backgroundColor).toBe("#ffec99");
    const topFill = fills.find((element) => element.id !== underlyingFill?.id);
    expect(topFill?.backgroundColor).toBe("#ffc9c9");
    expect(topFill?.customData?.classroomBucketFill).toMatchObject({
      version: 1,
      ownerId: topOwner.id,
    });

    color = "#a5d8ff";
    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "restyled" });
    fills = elements.filter((element) => element.type === "line" && !element.isDeleted);
    expect(fills).toHaveLength(2);
    expect(fills.find((element) => element.id === topFill?.id)?.backgroundColor).toBe("#a5d8ff");
    expect(fills.find((element) => element.id === underlyingFill?.id)?.backgroundColor).toBe("#ffec99");
  });

  it("preserves deleted tombstones when filling and restyling", () => {
    const deleted = {
      ...rectangle(-200, 0, 20, 20),
      isDeleted: true,
    } as ExcalidrawElement;
    const owner = rectangle();
    let elements: ExcalidrawElement[] = [deleted, owner];
    let color = "#ffec99";
    const api = {
      getSceneElements: () => elements.filter((element) => !element.isDeleted),
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({
        currentItemBackgroundColor: color,
        currentItemFillStyle: "solid",
        currentItemOpacity: 100,
      }),
      updateScene: ({ elements: next }: { elements?: readonly ExcalidrawElement[] }) => {
        if (next) elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "filled" });
    expect(elements.find((element) => element.id === deleted.id)?.isDeleted).toBe(true);

    color = "#ffc9c9";
    expect(applyBucketFill(api, { x: 50, y: 40 })).toEqual({ status: "restyled" });
    expect(elements.find((element) => element.id === deleted.id)?.isDeleted).toBe(true);
  });

  it("preserves malformed records while filling around valid geometry", () => {
    const owner = rectangle();
    const malformedColor = {
      ...rectangle(-200, 0, 20, 20),
      id: "malformed-color",
      backgroundColor: undefined,
    } as unknown as ExcalidrawElement;
    const malformedLine = {
      ...newLinearElement({
        type: "line",
        x: -200,
        y: 40,
        points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(10, 10)],
      }),
      id: "malformed-line",
      points: undefined,
    } as unknown as ExcalidrawElement;
    let elements: ExcalidrawElement[] = [malformedColor, malformedLine, owner];
    const api = {
      getSceneElements: () => elements,
      getSceneElementsIncludingDeleted: () => elements,
      getAppState: () => ({
        currentItemBackgroundColor: "#ffec99",
        currentItemFillStyle: "solid",
        currentItemOpacity: 100,
      }),
      updateScene: ({ elements: next }: { elements?: readonly ExcalidrawElement[] }) => {
        if (next) elements = [...next];
      },
    } as unknown as ExcalidrawImperativeAPI;

    expect(() => applyBucketFill(api, { x: 50, y: 40 })).not.toThrow();
    expect(elements.some((element) => element.id === malformedColor.id)).toBe(true);
    expect(elements.some((element) => element.id === malformedLine.id)).toBe(true);
    expect(elements).toHaveLength(4);
  });

  it("normalizes transparent colors without changing opaque colors", () => {
    expect(effectiveBucketFillColor("transparent")).toBe(DEFAULT_BUCKET_FILL_COLOR);
    expect(effectiveBucketFillColor("#00000000")).toBe(DEFAULT_BUCKET_FILL_COLOR);
    expect(effectiveBucketFillColor("#ff0000")).toBe("#ff0000");
  });

  it("normalizes malformed persisted bucket settings", () => {
    expect(effectiveBucketFillColor(null)).toBe(DEFAULT_BUCKET_FILL_COLOR);
    expect(effectiveBucketFillColor("   ")).toBe(DEFAULT_BUCKET_FILL_COLOR);
    expect(effectiveBucketFillStyle(null)).toBe("solid");
    expect(effectiveBucketFillStyle("invalid")).toBe("solid");
    expect(effectiveBucketFillOpacity(null)).toBe(100);
    expect(effectiveBucketFillOpacity(Number.NaN)).toBe(100);
    expect(effectiveBucketFillOpacity(140)).toBe(100);
    expect(effectiveBucketFillOpacity(-20)).toBe(0);
  });
});
