import { describe, expect, it } from "vitest";
import { createAngleMeasurement, createCompassConstruction, measuredAngleDegrees, regenerateAngleMeasurement, regenerateCompassConstruction, transformElementGeometry, transformationMetadata } from "./interactive";

describe("wrapper-owned math interactions", () => {
  it("constructs full circles and directed arcs from two scene points", () => {
    const circle = createCompassConstruction({ x: 100, y: 200 }, { x: 220, y: 200 }, { fullCircle: true, arcExtentDegrees: 180, direction: "clockwise", centerMark: true });
    expect(circle.metadata.kind).toBe("compass");
    if (circle.metadata.kind !== "compass") throw new Error("Expected compass metadata.");
    expect(circle.metadata.radiusSceneUnits).toBe(120);
    expect(circle.metadata.startAngleDegrees).toBe(0);
    expect(circle.scenePosition).toEqual({ x: -36, y: 64 });
    expect(circle.asset.svg).toContain('<circle data-part="construction"');
    expect(circle.asset.svg).toContain('data-part="center-mark"');
    expect(circle.metadata).toMatchObject({ strokeColor: "#2859c5", strokeWidth: 2.5, strokeStyle: "solid" });

    const arc = createCompassConstruction({ x: 0, y: 0 }, { x: 0, y: 100 }, { fullCircle: false, arcExtentDegrees: 270, direction: "counterclockwise", centerMark: false });
    expect(arc.asset.svg).toContain('<path data-part="construction"');
    if (arc.metadata.kind !== "compass") throw new Error("Expected compass metadata.");
    expect(arc.metadata.startAngleDegrees).toBe(90);
    expect(arc.metadata.endAngleDegrees).toBe(-180);
    expect(arc.asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(regenerateCompassConstruction(arc.metadata).asset.svg).toBe(arc.asset.svg);
  });

  it("rejects coincident, excessive, and invalid compass constructions", () => {
    expect(() => createCompassConstruction({ x: 0, y: 0 }, { x: 1, y: 1 }, { fullCircle: true, arcExtentDegrees: 180, direction: "clockwise", centerMark: true })).toThrow(/radius/);
    expect(() => createCompassConstruction({ x: 0, y: 0 }, { x: 2_001, y: 0 }, { fullCircle: true, arcExtentDegrees: 180, direction: "clockwise", centerMark: true })).toThrow(/radius/);
    expect(() => createCompassConstruction({ x: 0, y: 0 }, { x: 100, y: 0 }, { fullCircle: false, arcExtentDegrees: 360, direction: "clockwise", centerMark: true })).toThrow(/extent/);
  });

  it("measures acute, right, obtuse, straight, and reflex angles", () => {
    const vertex = { x: 0, y: 0 };
    const ray = { x: 100, y: 0 };
    expect(measuredAngleDegrees(vertex, ray, { x: 100, y: -100 })).toBeCloseTo(45, 10);
    expect(measuredAngleDegrees(vertex, ray, { x: 0, y: 100 })).toBeCloseTo(90, 10);
    expect(measuredAngleDegrees(vertex, ray, { x: -100, y: 100 })).toBeCloseTo(135, 10);
    expect(measuredAngleDegrees(vertex, ray, { x: -100, y: 0 })).toBeCloseTo(180, 10);
    expect(measuredAngleDegrees(vertex, ray, { x: 0, y: 100 }, true)).toBeCloseTo(270, 10);
  });

  it("commits a local angle annotation with rounded typed source metadata", () => {
    const annotation = createAngleMeasurement({ x: 50, y: 60 }, { x: 150, y: 60 }, { x: 110, y: 160 }, { reflex: false, precision: 1 });
    expect(annotation.metadata.kind).toBe("angle-measurement");
    if (annotation.metadata.kind !== "angle-measurement") throw new Error("Expected angle metadata.");
    expect(annotation.metadata.measuredDegrees).toBe(59);
    expect(annotation.metadata.commitAnnotation).toBe(true);
    expect(annotation.scenePosition).toEqual({ x: 8, y: 18 });
    expect(annotation.asset.svg).toContain('data-part="angle-arc"');
    expect(annotation.asset.svg).toContain('data-part="angle-label"');
    expect(annotation.metadata).toMatchObject({ unit: "degrees", annotationStrokeColor: "#7a3db8", annotationStrokeWidth: 2.2 });
    expect(annotation.asset.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(regenerateAngleMeasurement(annotation.metadata).asset.svg).toBe(annotation.asset.svg);
  });

  it("rejects coincident rays and invalid precision", () => {
    expect(() => measuredAngleDegrees({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 10, y: 10 })).toThrow(/extend/);
    expect(() => createAngleMeasurement({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { reflex: false, precision: 3 })).toThrow(/precision/);
  });

  it("translates, rotates, reflects, and dilates geometry around a common centre", () => {
    const geometry = { x: 10, y: 20, width: 40, height: 20, angle: 0 };
    const centre = { x: 100, y: 100 };
    expect(transformElementGeometry(geometry, centre, { transformationType: "translate", translateX: 30, translateY: -10, angleDegrees: 90, scaleFactor: 2, mirrorLineAngleDegrees: 45 })).toEqual({ ...geometry, x: 40, y: 10 });
    const rotated = transformElementGeometry(geometry, centre, { transformationType: "rotate", translateX: 0, translateY: 0, angleDegrees: 90, scaleFactor: 2, mirrorLineAngleDegrees: 45 });
    expect(rotated.x).toBeCloseTo(150, 10);
    expect(rotated.y).toBeCloseTo(20, 10);
    expect(rotated.angle).toBeCloseTo(Math.PI / 2, 10);
    const vertical = transformElementGeometry(geometry, centre, { transformationType: "reflect-vertical", translateX: 0, translateY: 0, angleDegrees: 0, scaleFactor: 2, mirrorLineAngleDegrees: 45 });
    expect(vertical.x).toBe(150);
    expect(vertical.angle).toBe(Math.PI);
    const horizontal = transformElementGeometry(geometry, centre, { transformationType: "reflect-horizontal", translateX: 0, translateY: 0, angleDegrees: 0, scaleFactor: 2, mirrorLineAngleDegrees: 45 });
    expect(horizontal.y).toBe(160);
    const oblique = transformElementGeometry({ ...geometry, y: 30 }, centre, { transformationType: "reflect-line", translateX: 0, translateY: 0, angleDegrees: 0, scaleFactor: 2, mirrorLineAngleDegrees: 45 });
    expect(oblique).toMatchObject({ x: 20, y: 20 });
    expect(oblique.angle).toBeCloseTo(Math.PI / 2, 10);
    const dilated = transformElementGeometry(geometry, centre, { transformationType: "dilate", translateX: 0, translateY: 0, angleDegrees: 0, scaleFactor: 2, mirrorLineAngleDegrees: 45 });
    expect(dilated).toMatchObject({ x: -80, y: -60, width: 80, height: 40 });
  });

  it("records copy-only transformation metadata and rejects unsafe parameters", () => {
    const options = { transformationType: "rotate" as const, translateX: 0, translateY: 0, angleDegrees: 45, scaleFactor: 1, mirrorLineAngleDegrees: 45 };
    expect(transformationMetadata("source-1", 40, 20, { x: 100, y: 100 }, options)).toMatchObject({ kind: "transformation", sourceElementId: "source-1", copyPolicy: "copy", angleDegrees: 45, mirrorLineStartX: expect.any(Number), mirrorLineEndX: expect.any(Number) });
    expect(() => transformElementGeometry({ x: 0, y: 0, width: 10, height: 10, angle: 0 }, { x: 0, y: 0 }, { ...options, scaleFactor: 0 })).toThrow(/0.05 to 20/);
    expect(() => transformElementGeometry({ x: 0, y: 0, width: 10, height: 10, angle: 0 }, { x: 0, y: 0 }, { ...options, translateX: 20_000 })).toThrow(/10,000/);
  });
});
