import { convertToExcalidrawElements } from "@excalidraw/element";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import {
  MAX_SLIDE_ROTATION_DEGREES,
  rotateSlideContent,
} from "./slide-content-rotation";

const SLIDE_METADATA = {
  classroomSlide: { kind: "slide", version: 1 },
};

function makeElements(
  skeletons: NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>,
): readonly ExcalidrawElement[] {
  const converted = convertToExcalidrawElements(
    skeletons,
    { regenerateIds: false },
  ) as unknown as readonly ExcalidrawElement[];
  const skeletonsById = new Map(skeletons.flatMap((skeleton) => {
    const value = skeleton as unknown as Record<string, unknown>;
    return typeof value.id === "string" ? [[value.id, value] as const] : [];
  }));
  // The converter treats zero-valued frame coordinates as omitted when it
  // derives a box from children. Restore explicit fixture geometry so tests
  // exercise the frame positions they declare.
  return converted.map((element) => {
    if (element.type !== "frame") return element;
    const skeleton = skeletonsById.get(element.id);
    if (!skeleton) return element;
    return {
      ...element,
      x: typeof skeleton.x === "number" ? skeleton.x : element.x,
      y: typeof skeleton.y === "number" ? skeleton.y : element.y,
      width: typeof skeleton.width === "number" ? skeleton.width : element.width,
      height: typeof skeleton.height === "number" ? skeleton.height : element.height,
    } as ExcalidrawElement;
  });
}

function byId(
  elements: readonly ExcalidrawElement[],
  id: string,
): ExcalidrawElement {
  const element = elements.find((candidate) => candidate.id === id);
  if (!element) throw new Error(`Missing test element ${id}`);
  return element;
}

function center(element: ExcalidrawElement): readonly [number, number] {
  return [element.x + element.width / 2, element.y + element.height / 2];
}

function normalizedRadians(degrees: number): number {
  const radians = degrees * Math.PI / 180;
  return (radians % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
}

describe("slide content rotation", () => {
  it("rotates rendered slide content clockwise by an arbitrary 33 degrees", () => {
    const elements = makeElements([
      { id: "content", type: "rectangle", x: 600, y: 300, width: 100, height: 50 },
      {
        id: "slide",
        type: "frame",
        children: ["content"],
        x: 0,
        y: 0,
        width: 1_000,
        height: 600,
        customData: SLIDE_METADATA,
      },
    ]);
    const originalContent = byId(elements, "content");
    const originalFrame = byId(elements, "slide");
    const originalCenter = center(originalContent);
    const frameCenter = center(originalFrame);

    const result = rotateSlideContent(elements, "slide", 33);
    const rotated = byId(result.elements, "content");
    const radians = 33 * Math.PI / 180;
    const deltaX = originalCenter[0] - frameCenter[0];
    const deltaY = originalCenter[1] - frameCenter[1];

    expect(result.status).toBe("rotated");
    expect(result.rotatedElementCount).toBe(1);
    expect(center(rotated)[0]).toBeCloseTo(
      frameCenter[0] + deltaX * Math.cos(radians) - deltaY * Math.sin(radians),
      8,
    );
    expect(center(rotated)[1]).toBeCloseTo(
      frameCenter[1] + deltaX * Math.sin(radians) + deltaY * Math.cos(radians),
      8,
    );
    expect(rotated.angle).toBeCloseTo(normalizedRadians(33), 10);
    expect(rotated.version).toBe(originalContent.version + 1);
    expect(rotated.versionNonce).not.toBe(originalContent.versionNonce);
    expect(byId(result.elements, "slide")).toBe(originalFrame);
    expect(result.elements.map((element) => element.id))
      .toEqual(elements.map((element) => element.id));
  });

  it("supports negative fractional angles and keeps source objects immutable", () => {
    const elements = makeElements([
      {
        id: "content",
        type: "diamond",
        x: 120,
        y: 80,
        width: 80,
        height: 60,
        angle: Math.PI / 9 as never,
      },
      {
        id: "slide",
        type: "frame",
        children: ["content"],
        x: 0,
        y: 0,
        width: 500,
        height: 300,
        customData: SLIDE_METADATA,
      },
    ]);
    const before = JSON.stringify(elements);
    const original = byId(elements, "content");

    const result = rotateSlideContent(elements, "slide", -12.5);
    const rotated = byId(result.elements, "content");

    expect(rotated.angle).toBeCloseTo(
      normalizedRadians(20 - 12.5),
      10,
    );
    expect(rotated).not.toBe(original);
    expect(JSON.stringify(elements)).toBe(before);
    expect(original.angle).toBeCloseTo(Math.PI / 9, 10);
  });

  it("does not drift a pre-rotated asymmetric multi-segment line across a round trip", () => {
    const elements = makeElements([
      {
        id: "content",
        type: "line",
        x: 180,
        y: 120,
        width: 180,
        height: 120,
        points: [[0, 0], [160, 10], [40, 120], [180, 80]] as never,
        angle: 0.47 as never,
      },
      {
        id: "slide",
        type: "frame",
        children: ["content"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    const original = byId(elements, "content");

    const clockwise = rotateSlideContent(elements, "slide", 33);
    const roundTrip = rotateSlideContent(clockwise.elements, "slide", -33);
    const restored = byId(roundTrip.elements, "content");

    expect(restored.x).toBeCloseTo(original.x, 8);
    expect(restored.y).toBeCloseTo(original.y, 8);
    expect(restored.angle).toBeCloseTo(original.angle, 10);
  });

  it("rotates partially overlapping writing but leaves outside and frame-like elements unchanged", () => {
    const elements = makeElements([
      { id: "partial", type: "line", x: -10, y: 250, width: 20, height: 20 },
      { id: "outside", type: "ellipse", x: -300, y: 100, width: 50, height: 50 },
      { id: "nested-content", type: "rectangle", x: 200, y: 100, width: 40, height: 40 },
      {
        id: "ordinary-frame",
        type: "frame",
        children: [],
        x: 180,
        y: 80,
        width: 100,
        height: 100,
      },
      {
        id: "other-slide",
        type: "frame",
        children: [],
        x: 1_000,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
      {
        id: "slide",
        type: "frame",
        children: ["partial", "nested-content", "ordinary-frame"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    const partial = byId(elements, "partial");
    const outside = byId(elements, "outside");
    const ordinaryFrame = byId(elements, "ordinary-frame");
    const otherSlide = byId(elements, "other-slide");
    const slide = byId(elements, "slide");

    const result = rotateSlideContent(elements, "slide", 33);

    expect(result.rotatedElementCount).toBe(2);
    expect(byId(result.elements, "partial")).not.toBe(partial);
    expect(byId(result.elements, "nested-content")).not.toBe(byId(elements, "nested-content"));
    expect(byId(result.elements, "outside")).toBe(outside);
    expect(byId(result.elements, "ordinary-frame")).toBe(ordinaryFrame);
    expect(byId(result.elements, "other-slide")).toBe(otherSlide);
    expect(byId(result.elements, "slide")).toBe(slide);
  });

  it("atomically rejects a near-corner rotation that would lose rendered content", () => {
    const elements = makeElements([
      { id: "corner-content", type: "rectangle", x: 0, y: 0, width: 20, height: 20 },
      {
        id: "slide",
        type: "frame",
        children: ["corner-content"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    const sourceSnapshot = JSON.stringify(elements);
    const sourceContent = byId(elements, "corner-content");

    expect(() => rotateSlideContent(elements, "slide", 45))
      .toThrow("completely outside the slide");
    expect(JSON.stringify(elements)).toBe(sourceSnapshot);
    expect(byId(elements, "corner-content")).toBe(sourceContent);
  });

  it("preserves internal arrow bindings and repositions bound text with its container", () => {
    const converted = makeElements([
      { id: "left", type: "rectangle", x: 100, y: 120, width: 100, height: 80 },
      { id: "right", type: "rectangle", x: 500, y: 120, width: 100, height: 80 },
      {
        id: "arrow",
        type: "arrow",
        x: 200,
        y: 160,
        width: 300,
        height: 0,
        start: { id: "left" },
        end: { id: "right" },
      },
      {
        id: "slide",
        type: "frame",
        children: ["left", "right", "arrow"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    const boundTextFixture = {
      id: "bound-text",
      type: "text",
      // Deliberately outside the frame's geometric render selection. The
      // container pulls it into the rotation closure, but membership safety
      // must still be based on content rendered before rotation.
      x: 900,
      y: 900,
      width: 100,
      height: 30,
      angle: 0,
      strokeColor: "#1b1b1f",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: "slide",
      index: "az",
      roundness: null,
      seed: 4,
      version: 1,
      versionNonce: 5,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      customData: null,
      text: "Bound label",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: "right",
      originalText: "Bound label",
      autoResize: true,
      lineHeight: 1.25,
    } as unknown as ExcalidrawElement;
    const elements = converted.flatMap((element) => {
      if (element.id !== "right") return [element];
      return [{
        ...element,
        boundElements: [
          ...(element.boundElements || []),
          { id: "bound-text", type: "text" as const },
        ],
      }, boundTextFixture];
    });
    const sourceArrow = byId(elements, "arrow");
    if (sourceArrow.type !== "arrow") throw new Error("Expected arrow fixture");
    const sourceBoundText = elements.find(
      (element) => element.type === "text" && element.containerId === "right",
    );
    if (!sourceBoundText) throw new Error("Expected bound-text fixture");

    const result = rotateSlideContent(elements, "slide", 33);
    const arrow = byId(result.elements, "arrow");
    const rotatedBoundText = byId(result.elements, sourceBoundText.id);
    if (arrow.type !== "arrow" || rotatedBoundText.type !== "text") {
      throw new Error("Unexpected rotated fixture types");
    }

    expect(arrow.startBinding?.elementId).toBe("left");
    expect(arrow.endBinding?.elementId).toBe("right");
    expect(rotatedBoundText.containerId).toBe("right");
    expect(rotatedBoundText).not.toBe(sourceBoundText);
    expect(rotatedBoundText.angle).toBeCloseTo(normalizedRadians(33), 10);
  });

  it("returns explicit no-op and no-content results without allocating a new array", () => {
    const emptySlide = makeElements([{
      id: "slide",
      type: "frame",
      children: [],
      x: 0,
      y: 0,
      width: 800,
      height: 450,
      customData: SLIDE_METADATA,
    }]);

    expect(rotateSlideContent(emptySlide, "slide", 0)).toEqual({
      elements: emptySlide,
      rotatedElementCount: 0,
      status: "no-op",
    });
    expect(rotateSlideContent(emptySlide, "slide", 360)).toEqual({
      elements: emptySlide,
      rotatedElementCount: 0,
      status: "no-op",
    });
    expect(rotateSlideContent(emptySlide, "slide", 33)).toEqual({
      elements: emptySlide,
      rotatedElementCount: 0,
      status: "no-content",
    });
  });

  it("rejects arrows, groups, and nested-frame ownership that cross the slide boundary", () => {
    const crossBoundaryArrow = makeElements([
      { id: "inside", type: "rectangle", x: 100, y: 100, width: 100, height: 80 },
      { id: "outside", type: "rectangle", x: 900, y: 100, width: 100, height: 80 },
      {
        id: "arrow",
        type: "arrow",
        x: 200,
        y: 140,
        width: 700,
        height: 0,
        start: { id: "inside" },
        end: { id: "outside" },
      },
      {
        id: "slide",
        type: "frame",
        children: ["inside", "arrow"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    const arrowSnapshot = JSON.stringify(crossBoundaryArrow);
    expect(() => rotateSlideContent(crossBoundaryArrow, "slide", 33))
      .toThrow("arrow connected to content outside");
    expect(JSON.stringify(crossBoundaryArrow)).toBe(arrowSnapshot);

    const crossBoundaryGroup = makeElements([
      {
        id: "inside",
        type: "rectangle",
        x: 100,
        y: 100,
        width: 100,
        height: 80,
        groupIds: ["shared-group"],
      },
      {
        id: "outside",
        type: "ellipse",
        x: 900,
        y: 100,
        width: 100,
        height: 80,
        groupIds: ["shared-group"],
      },
      {
        id: "slide",
        type: "frame",
        children: ["inside"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    expect(() => rotateSlideContent(crossBoundaryGroup, "slide", 33))
      .toThrow("shares a group with content outside");

    const nestedFrame = makeElements([
      { id: "nested-content", type: "rectangle", x: 120, y: 120, width: 80, height: 60 },
      {
        id: "nested-frame",
        type: "frame",
        children: ["nested-content"],
        x: 100,
        y: 100,
        width: 200,
        height: 150,
      },
      {
        id: "slide",
        type: "frame",
        children: ["nested-frame"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);
    expect(() => rotateSlideContent(nestedFrame, "slide", 33))
      .toThrow("owned by a nested frame");
  });

  it("rejects elbow arrows rather than changing their routing metadata", () => {
    const elements = makeElements([
      {
        id: "arrow",
        type: "arrow",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        points: [[0, 0], [100, 0], [100, 100], [200, 100]],
        elbowed: true,
        fixedSegments: [],
      } as never,
      {
        id: "slide",
        type: "frame",
        children: ["arrow"],
        x: 0,
        y: 0,
        width: 800,
        height: 450,
        customData: SLIDE_METADATA,
      },
    ]);

    expect(() => rotateSlideContent(elements, "slide", -33))
      .toThrow("elbow arrow");
  });

  it("rejects missing slides and malformed or out-of-range angles", () => {
    const elements = makeElements([{
      id: "slide",
      type: "frame",
      children: [],
      x: 0,
      y: 0,
      width: 800,
      height: 450,
      customData: SLIDE_METADATA,
    }]);

    expect(() => rotateSlideContent(elements, "missing", 33))
      .toThrow("slide could not be found");
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity, MAX_SLIDE_ROTATION_DEGREES + 0.1]) {
      expect(() => rotateSlideContent(elements, "slide", invalid))
        .toThrow("from -360° to 360°");
    }
  });
});
