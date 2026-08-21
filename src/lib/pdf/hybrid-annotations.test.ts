import { createCanvas } from "@napi-rs/canvas";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  classifyHybridAnnotationElement,
  countSvgPathOperations,
  drawHybridVectorRun,
  HybridAnnotationPlanError,
  planHybridAnnotationRuns,
} from "./hybrid-annotations";

function annotation(
  overrides: Record<string, unknown> = {},
): NonDeletedExcalidrawElement {
  return {
    id: "element",
    type: "rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roundness: null,
    roughness: 0,
    opacity: 100,
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
    ...overrides,
  } as unknown as NonDeletedExcalidrawElement;
}

function plan(elements: readonly NonDeletedExcalidrawElement[]) {
  return planHybridAnnotationRuns(elements, {
    maxRuns: 32,
    maxVectorElements: 1_000,
    maxVectorPathOperations: 10_000,
  });
}

describe("hybrid annotation planning", () => {
  it("emits ordinary free-draw ink as an exact filled vector outline", () => {
    const freeDraw = annotation({
      id: "ink",
      type: "freedraw",
      roughness: 1,
      points: [[0, 0], [20, 10], [40, 0]],
      pressures: [0.5, 0.7, 0.4],
      simulatePressure: false,
      lastCommittedPoint: [40, 0],
      width: 40,
      height: 10,
      strokeColor: "#ff000080",
    });
    const classification = classifyHybridAnnotationElement(freeDraw);
    expect(classification.reason).toBeUndefined();
    expect(classification.instruction).toMatchObject({
      elementId: "ink",
      stroke: null,
      fill: { red: 1, green: 0, blue: 0, alpha: 128 / 255 },
    });
    expect(classification.instruction?.path).toMatch(/^M/);
    expect(classification.instruction?.path).toMatch(/Q/);
    expect(classification.instruction?.path).toMatch(/Z$/);
  });

  it("vectorizes conservative rectangles, diamonds, ellipses, and straight lines", () => {
    const elements = [
      annotation({ id: "rectangle" }),
      annotation({ id: "diamond", type: "diamond" }),
      annotation({ id: "ellipse", type: "ellipse" }),
      annotation({
        id: "line",
        type: "line",
        points: [[0, 0], [100, 60]],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      }),
    ];
    const result = plan(elements);
    expect(result.runs.map((run) => run.kind)).toEqual(["vector"]);
    expect(result.vectorElementCount).toBe(4);
    expect(result.rasterElementCount).toBe(0);
    const ellipse = classifyHybridAnnotationElement(elements[2]).instruction!;
    expect(ellipse.path).toMatch(/^M 50 0 C /);
    expect(countSvgPathOperations(ellipse.path)).toBe(13);
  });

  it("keeps rough shapes on Excalidraw's visual renderer", () => {
    const rough = annotation({ id: "rough", roughness: 1 });
    expect(classifyHybridAnnotationElement(rough)).toEqual({
      reason: "visual-style",
    });
    const result = plan([rough]);
    expect(result.runs[0]).toMatchObject({ kind: "raster" });
    expect(result.rasterReasons["visual-style"]).toBe(1);
  });

  it("preserves exact scene z-order with contiguous vector/raster runs", () => {
    const elements = [
      annotation({ id: "back-vector" }),
      annotation({
        id: "text",
        type: "text",
        text: "middle",
        originalText: "middle",
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
      }),
      annotation({ id: "front-vector", type: "ellipse" }),
      annotation({ id: "image", type: "image", fileId: "file", status: "saved", scale: [1, 1], crop: null }),
    ];
    const result = plan(elements);
    expect(result.runs.map((run) => ({
      kind: run.kind,
      ids: run.elements.map((element) => element.id),
    }))).toEqual([
      { kind: "vector", ids: ["back-vector"] },
      { kind: "raster", ids: ["text"] },
      { kind: "vector", ids: ["front-vector"] },
      { kind: "raster", ids: ["image"] },
    ]);
    expect(result.rasterizedTypes).toEqual(["image", "text"]);
  });

  it("never drops an unknown future element and rasterizes it in place", () => {
    const future = annotation({ id: "future", type: "future-widget" });
    const result = plan([future]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      kind: "raster",
      elements: [expect.objectContaining({ id: "future" })],
      rasterReasons: ["unsupported-type"],
    });
  });

  it("turns vector budget overflow into visible raster work", () => {
    const result = planHybridAnnotationRuns([
      annotation({ id: "first" }),
      annotation({ id: "second" }),
    ], {
      maxRuns: 8,
      maxVectorElements: 1,
      maxVectorPathOperations: 1_000,
    });
    expect(result.runs.map((run) => run.kind)).toEqual(["vector", "raster"]);
    expect(result.rasterReasons["vector-budget"]).toBe(1);
  });

  it("requires the explicit visual fallback when alternating runs exceed the guard", () => {
    const elements = [
      annotation({ id: "vector-1" }),
      annotation({ id: "text", type: "text" }),
      annotation({ id: "vector-2" }),
    ];
    expect(() => planHybridAnnotationRuns(elements, {
      maxRuns: 2,
      maxVectorElements: 10,
      maxVectorPathOperations: 1_000,
    })).toThrow(HybridAnnotationPlanError);
  });
});

describe("hybrid vector drawing", () => {
  it("rotates a zero-roughness ellipse around its scene center", async () => {
    const ellipse = annotation({
      id: "rotated-ellipse",
      type: "ellipse",
      x: 20,
      y: 30,
      width: 80,
      height: 40,
      angle: Math.PI / 2,
      strokeColor: "transparent",
      backgroundColor: "#0000ff",
    });
    const result = plan([ellipse]);
    const document = await PDFDocument.create();
    const page = document.addPage([200, 160]);
    drawHybridVectorRun(page, result.runs[0], {
      originX: 0,
      originFromTop: 0,
      targetHeight: 160,
      scale: 1,
    });
    const bytes = await document.save();
    const loadingTask = getDocument({
      data: bytes,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
    });
    const pdf = await loadingTask.promise;
    try {
      const renderedPage = await pdf.getPage(1);
      try {
        const viewport = renderedPage.getViewport({ scale: 1 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext("2d");
        await renderedPage.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
          background: "#ffffff",
        }).promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let minX = canvas.width;
        let minY = canvas.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            if (pixels[offset] < 60 && pixels[offset + 1] < 60 && pixels[offset + 2] > 190) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
          }
        }
        // Original center is (60,50); a quarter turn swaps the 80x40 bounds.
        expect([minX, minY, maxX, maxY]).toEqual([40, 10, 79, 89]);
      } finally {
        renderedPage.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }
  });
});
