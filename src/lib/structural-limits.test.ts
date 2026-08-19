import { describe, expect, it } from "vitest";
import {
  MAX_LIBRARY_ITEMS,
  MAX_PROJECT_ELEMENTS_PER_SCENE,
  MAX_PROJECT_TOTAL_ELEMENTS,
  MAX_STRUCTURAL_DEPTH,
  MAX_STRUCTURAL_POINTS_PER_ELEMENT,
  assertImportBlobBytes,
  assertImportTextBytes,
  assertLibraryStructure,
  assertProjectStructure,
  assertSceneStructure,
  assertStructuredData,
  parseBoundedImportJson,
} from "./structural-limits";
import { createBlankProject } from "../types";

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { next: value };
  return value;
}

describe("untrusted structured import limits", () => {
  it("accepts a near-limit JSON-like graph and reports bounded counters", () => {
    const value = {
      title: "near-valid",
      points: [[0, 0], [1, 1], [2, 2]],
      nested: { enabled: true },
    };
    expect(assertStructuredData(value, {
      maxObjectKeys: 4,
      maxPointsPerElement: 3,
      maxTotalPoints: 3,
    })).toMatchObject({ points: 3, objects: 2, arrays: 4 });
  });

  it("rejects a wide object before a sanitizer can clone it", () => {
    expect(() => assertStructuredData({ first: 1, second: 2 }, {
      maxObjectKeys: 1,
      label: "Scene import",
    })).toThrow(/Scene import contains more than 1 object keys/);
  });

  it("rejects deep graphs at the configured depth", () => {
    expect(() => assertStructuredData(nestedObject(MAX_STRUCTURAL_DEPTH + 1), {
      label: "Project import",
    })).toThrow(/maximum structural depth/);
    expect(() => assertStructuredData(nestedObject(3), {
      maxDepth: 2,
    })).toThrow(/maximum structural depth/);
  });

  it("rejects oversized point arrays and pathological totals", () => {
    const points = Array.from({ length: MAX_STRUCTURAL_POINTS_PER_ELEMENT + 1 }, () => [0, 0]);
    expect(() => assertStructuredData({ points })).toThrow(/points/);
    expect(() => assertStructuredData({ points: [[0, 0], [1, 1]] }, {
      maxTotalPoints: 1,
    })).toThrow(/total point count/);
  });

  it("rejects oversized strings, cycles, sparse arrays, and non-plain values", () => {
    expect(() => assertStructuredData({ text: "12345" }, { maxStringBytes: 4 }))
      .toThrow(/string larger/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertStructuredData(circular)).toThrow(/circular reference/);
    const sparse = new Array(2);
    expect(() => assertStructuredData(sparse)).toThrow(/sparse/);
    expect(() => assertStructuredData({ date: new Date() })).toThrow(/plain objects and arrays/);
  });

  it("enforces project scene and element counts while retaining valid projects", () => {
    const project = createBlankProject();
    expect(() => assertProjectStructure(project)).not.toThrow();
    project.scenes[project.activeSceneId].elements = Array.from(
      { length: MAX_PROJECT_ELEMENTS_PER_SCENE + 1 },
      (_, index) => ({ id: `element-${index}`, type: "rectangle" }),
    );
    expect(() => assertProjectStructure(project)).toThrow(/elements/);
  });

  it("accepts file maps beyond the generic object width and enforces the scene file ceiling", () => {
    const project = createBlankProject();
    const scene = project.scenes[project.activeSceneId];
    scene.files = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => [`file-${index}`, {}]),
    );
    expect(() => assertProjectStructure(project)).not.toThrow();

    scene.files = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`file-${index}`, {}]),
    );
    expect(() => assertProjectStructure(project)).toThrow(/more than 10000 files/);
  });

  it("aligns the project array envelope with the slide-order ceiling", () => {
    const project = createBlankProject();
    const slide = {
      id: "slide",
      sceneId: project.activeSceneId,
      frameId: "frame",
      title: "Slide",
    };
    project.slideOrder = Array(100_001).fill(slide);
    expect(() => assertProjectStructure(project)).not.toThrow();

    project.slideOrder = Array(MAX_PROJECT_TOTAL_ELEMENTS + 1).fill(slide);
    expect(() => assertProjectStructure(project)).toThrow(/array longer than 250000/);
  });

  it("accepts legacy library arrays but rejects oversized stored collections", () => {
    expect(() => assertLibraryStructure([[{ id: "legacy" }]])).not.toThrow();
    expect(() => assertLibraryStructure([{ id: "missing-elements" }])).toThrow(/elements array/);
    const oversized = Array.from({ length: MAX_LIBRARY_ITEMS + 1 }, () => []);
    expect(() => assertLibraryStructure(oversized)).toThrow(/items/);
  });

  it("validates native scene JSON after bounded text parsing", () => {
    const scene = parseBoundedImportJson<{ elements: unknown[] }>(
      JSON.stringify({ elements: [], appState: {}, files: {} }),
      "scene",
      1_024,
    );
    expect(scene.elements).toEqual([]);
    expect(() => assertSceneStructure({ elements: Array.from({ length: MAX_PROJECT_ELEMENTS_PER_SCENE + 1 }, () => ({})) }))
      .toThrow(/elements/);
  });

  it("checks Blob and UTF-8 text bytes before dependency parsing", () => {
    expect(assertImportTextBytes("😀", 4, "Native scene")).toBe(4);
    expect(() => assertImportTextBytes("😀", 3, "Native scene")).toThrow(/larger/);
    expect(assertImportBlobBytes(new Blob(["1234"]), 4, "Native library")).toBe(4);
    expect(() => assertImportBlobBytes(new Blob(["12345"]), 4, "Native library")).toThrow(/larger/);
  });
});
