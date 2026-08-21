import { createCanvas } from "@napi-rs/canvas";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfStandardFontDataUrl = decodeURIComponent(new URL(
  "./standard_fonts/",
  import.meta.resolve("pdfjs-dist/package.json"),
).pathname);

type AnnotationMode = "hybrid" | "visual";
type PdfExportMode = "expand" | "openboard-fit";

interface BrowserExportResult {
  bytes: Uint8Array;
  diagnostics: {
    annotationMode: AnnotationMode;
    pageCount: number;
    vectorElementCount: number;
    rasterElementCount: number;
    rasterRunCount: number;
    pages: Array<{
      annotationCount: number;
      runCount: number;
      rasterReasons: Record<string, number>;
      rasterizedTypes: string[];
    }>;
  };
}

interface RenderedPdfPage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

interface PixelComparison {
  changedPixelRatio: number;
  inkCoverageDeltaRatio: number;
  inkIntersectionOverUnion: number;
  meanAbsoluteChannelDelta: number;
}

function baseElement(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  index: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const ordinal = Number.parseInt(index.slice(1), 10) || 0;
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1_000 + ordinal,
    version: 1,
    versionNonce: 2_000 + ordinal,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index,
    ...overrides,
  };
}

function richAnnotationFixture(
  workspaceWidth: number,
  workspaceHeight: number,
): Array<Record<string, unknown>> {
  const background = baseElement(
    "pdf-background",
    "image",
    0,
    0,
    workspaceWidth,
    workspaceHeight,
    "a0",
    {
      fileId: "unused-pdf-preview",
      status: "saved",
      scale: [1, 1],
      crop: null,
      locked: true,
      customData: {
        classroomRole: "pdf-background",
        pdfDocumentId: "source",
        pdfPageIndex: 0,
      },
    },
  );

  // These first three annotations intentionally alternate vector/raster/vector
  // while overlapping. A compositing-order regression is therefore visible in
  // the whole-page pixel comparison, not merely in PDF operator counts.
  const backVector = baseElement("back-vector", "rectangle", -46, 74, 238, 136, "a1", {
    strokeColor: "#1864ab",
    backgroundColor: "#4dabf7",
    strokeWidth: 5,
    opacity: 84,
  });
  const groupedRaster = baseElement("grouped-raster", "diamond", 54, 98, 174, 126, "a2", {
    strokeColor: "#e67700",
    backgroundColor: "#ffd43b",
    groupIds: ["parity-group"],
    roughness: 1,
    opacity: 76,
  });
  const frontVector = baseElement("front-vector", "ellipse", 124, 68, 188, 148, "a3", {
    angle: Math.PI / 9,
    strokeColor: "#c92a2a",
    backgroundColor: "#ff6b6b",
    strokeWidth: 4,
    opacity: 64,
  });

  const rotatedLine = baseElement("rotated-line", "line", 298, -34, 188, 94, "a4", {
    angle: -Math.PI / 14,
    strokeColor: "#5f3dc4",
    strokeWidth: 6,
    opacity: 82,
    points: [[0, 0], [188, 94]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  });

  // Explicit pressure values exercise the perfect-freehand vector path, while
  // the negative x coordinate also participates in expanded export bounds.
  const pressureInk = baseElement("pressure-ink", "freedraw", -24, 264, 216, 52, "a5", {
    strokeColor: "#2b8a3e",
    strokeWidth: 5,
    opacity: 91,
    points: [[0, 32], [34, 8], [76, 42], [118, 4], [164, 48], [216, 18]],
    pressures: [0.12, 0.32, 0.78, 0.48, 0.92, 0.3],
    simulatePressure: false,
    lastCommittedPoint: [216, 18],
  });

  const boundContainer = baseElement("bound-container", "rectangle", 250, 88, 164, 72, "a6", {
    strokeColor: "#0b7285",
    backgroundColor: "#99e9f2",
    boundElements: [{ id: "bound-label", type: "text" }],
  });
  const boundLabel = baseElement("bound-label", "text", 272, 109, 120, 30, "a7", {
    strokeColor: "#0b7285",
    fontSize: 24,
    fontFamily: 1,
    text: "Bound label",
    originalText: "Bound label",
    textAlign: "center",
    verticalAlign: "middle",
    containerId: "bound-container",
    autoResize: true,
    lineHeight: 1.25,
  });
  const rasterArrow = baseElement("raster-arrow", "arrow", 278, 174, 178, 72, "a8", {
    strokeColor: "#862e9c",
    strokeWidth: 5,
    points: [[0, 0], [92, 18], [178, 72]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
  });
  const frame = baseElement("parity-frame", "frame", 326, 252, 132, 92, "a9", {
    name: "Parity frame",
  });
  const framedRaster = baseElement("framed-raster", "rectangle", 350, 270, 84, 48, "aA", {
    strokeColor: "#495057",
    backgroundColor: "#ced4da",
    frameId: "parity-frame",
  });

  return [
    background,
    backVector,
    groupedRaster,
    frontVector,
    rotatedLine,
    pressureInk,
    boundContainer,
    boundLabel,
    rasterArrow,
    frame,
    framedRaster,
  ];
}

function parityProject(sourceByteLength: number, viewRotation: 0 | 90) {
  const displayWidth = viewRotation === 90 ? 360 : 480;
  const displayHeight = viewRotation === 90 ? 480 : 360;
  const sceneId = `page-${viewRotation}`;
  return {
    schemaVersion: 1,
    id: `hybrid-parity-${viewRotation}`,
    title: "Hybrid export rendered parity",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    activeSceneId: sceneId,
    scenes: {
      [sceneId]: {
        id: sceneId,
        name: "Rendered parity page",
        elements: richAnnotationFixture(displayWidth, displayHeight),
        appState: {
          exportBackground: false,
          viewBackgroundColor: "#ffffff",
        },
        files: {},
        pdfPage: {
          documentId: "source",
          pageIndex: 0,
          width: 480,
          height: 360,
          rotation: 0,
          viewRotation,
          backgroundElementId: "pdf-background",
        },
      },
    },
    slideOrder: [],
    pdfPageOrder: [sceneId],
    pdfDocuments: {
      source: {
        id: "source",
        name: "blank-parity-source.pdf",
        mimeType: "application/pdf",
        byteLength: sourceByteLength,
        pageCount: 1,
        archivePath: "documents/source.pdf",
      },
    },
  };
}

async function blankSourcePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([480, 360]);
  return document.save({ useObjectStreams: false });
}

async function exportWithRealBrowserRenderer(
  page: Page,
  project: ReturnType<typeof parityProject>,
  sourceBytes: Uint8Array,
  exportMode: PdfExportMode,
  annotationMode: AnnotationMode,
): Promise<BrowserExportResult> {
  const result = await page.evaluate(async ({
    project: serializedProject,
    source: serializedSource,
    exportMode: selectedExportMode,
    annotationMode: selectedAnnotationMode,
  }) => {
    // This is deliberately a Vite development-module import. It invokes the
    // production exporter with the real browser Excalidraw renderer and avoids
    // adding a product-owned test hook or exposing exporter state on `window`.
    const modulePath = "/src/lib/pdf/export-pdf.ts";
    const exporter = await import(/* @vite-ignore */ modulePath) as {
      exportAnnotatedPdfWithDiagnostics: (
        project: unknown,
        pdfBytes: Record<string, Uint8Array>,
        mode: "expand" | "openboard-fit",
        options: { annotationMode: "hybrid" | "visual" },
      ) => Promise<{
        blob: Blob;
        diagnostics: BrowserExportResult["diagnostics"];
      }>;
    };
    const exported = await exporter.exportAnnotatedPdfWithDiagnostics(
      serializedProject,
      { source: new Uint8Array(serializedSource) },
      selectedExportMode,
      { annotationMode: selectedAnnotationMode },
    );
    const bytes = new Uint8Array(await exported.blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return {
      base64: btoa(binary),
      diagnostics: exported.diagnostics,
    };
  }, {
    project,
    source: Array.from(sourceBytes),
    exportMode,
    annotationMode,
  });
  return {
    bytes: Uint8Array.from(Buffer.from(result.base64, "base64")),
    diagnostics: result.diagnostics,
  };
}

async function renderPdfPage(bytes: Uint8Array, scale = 2): Promise<RenderedPdfPage> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: pdfStandardFontDataUrl,
  });
  const document = await loadingTask.promise;
  try {
    expect(document.numPages).toBe(1);
    const page = await document.getPage(1);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        background: "#ffffff",
      }).promise;
      return {
        width,
        height,
        rgba: Uint8ClampedArray.from(context.getImageData(0, 0, width, height).data),
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

function compareRenderedPages(
  hybrid: RenderedPdfPage,
  visual: RenderedPdfPage,
): PixelComparison {
  expect({ width: hybrid.width, height: hybrid.height }).toEqual({
    width: visual.width,
    height: visual.height,
  });
  let changedPixels = 0;
  let hybridInk = 0;
  let visualInk = 0;
  let inkIntersection = 0;
  let inkUnion = 0;
  let absoluteChannelDelta = 0;
  const pixelCount = hybrid.width * hybrid.height;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    let maximumDelta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(hybrid.rgba[offset + channel] - visual.rgba[offset + channel]);
      absoluteChannelDelta += delta;
      maximumDelta = Math.max(maximumDelta, delta);
    }
    if (maximumDelta > 32) changedPixels += 1;
    const hybridHasInk = Math.min(
      hybrid.rgba[offset],
      hybrid.rgba[offset + 1],
      hybrid.rgba[offset + 2],
    ) < 246;
    const visualHasInk = Math.min(
      visual.rgba[offset],
      visual.rgba[offset + 1],
      visual.rgba[offset + 2],
    ) < 246;
    if (hybridHasInk) hybridInk += 1;
    if (visualHasInk) visualInk += 1;
    if (hybridHasInk && visualHasInk) inkIntersection += 1;
    if (hybridHasInk || visualHasInk) inkUnion += 1;
  }
  return {
    changedPixelRatio: changedPixels / pixelCount,
    inkCoverageDeltaRatio: Math.abs(hybridInk - visualInk) / Math.max(hybridInk, visualInk, 1),
    inkIntersectionOverUnion: inkIntersection / Math.max(inkUnion, 1),
    meanAbsoluteChannelDelta: absoluteChannelDelta / pixelCount / 3,
  };
}

function renderedPng(page: RenderedPdfPage): Buffer {
  const canvas = createCanvas(page.width, page.height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(page.width, page.height);
  image.data.set(page.rgba);
  context.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}

async function attachMismatchEvidence(
  testInfo: TestInfo,
  label: string,
  hybrid: RenderedPdfPage,
  visual: RenderedPdfPage,
  comparison: PixelComparison,
): Promise<void> {
  await Promise.all([
    testInfo.attach(`${label}-hybrid.png`, {
      body: renderedPng(hybrid),
      contentType: "image/png",
    }),
    testInfo.attach(`${label}-visual.png`, {
      body: renderedPng(visual),
      contentType: "image/png",
    }),
    testInfo.attach(`${label}-metrics.json`, {
      body: Buffer.from(JSON.stringify(comparison, null, 2)),
      contentType: "application/json",
    }),
  ]);
}

test("keeps hybrid annotations visually aligned with the explicit visual renderer", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => document.fonts.ready);

  const sourceBytes = await blankSourcePdf();
  const cases = [
    {
      label: "expanded-negative-bounds",
      mode: "expand" as const,
      project: parityProject(sourceBytes.byteLength, 0),
      expectedPage: { kind: "minimum" as const, width: 480, height: 360 },
    },
    {
      label: "openboard-fit-quarter-turn",
      mode: "openboard-fit" as const,
      project: parityProject(sourceBytes.byteLength, 90),
      expectedPage: { kind: "exact" as const, width: 360, height: 480 },
    },
  ];

  for (const parityCase of cases) {
    // Keep renderer access sequential. Concurrent exportToCanvas calls share
    // browser font/canvas resources and would make this release gate needlessly
    // scheduler-dependent on lower-memory classroom devices.
    const hybrid = await exportWithRealBrowserRenderer(
      page,
      parityCase.project,
      sourceBytes,
      parityCase.mode,
      "hybrid",
    );
    const visual = await exportWithRealBrowserRenderer(
      page,
      parityCase.project,
      sourceBytes,
      parityCase.mode,
      "visual",
    );

    expect(hybrid.diagnostics).toMatchObject({
      annotationMode: "hybrid",
      pageCount: 1,
      vectorElementCount: 4,
      rasterElementCount: 5,
      rasterRunCount: 2,
      pages: [{
        annotationCount: 9,
        runCount: 4,
        rasterReasons: {
          "frame-clipping": 1,
          "unsupported-type": 2,
          "visual-style": 2,
        },
        rasterizedTypes: ["arrow", "diamond", "rectangle", "text"],
      }],
    });
    expect(visual.diagnostics).toMatchObject({
      annotationMode: "visual",
      pageCount: 1,
      vectorElementCount: 0,
      rasterElementCount: 9,
      rasterRunCount: 1,
    });

    const [hybridStructure, visualStructure] = await Promise.all([
      PDFDocument.load(hybrid.bytes),
      PDFDocument.load(visual.bytes),
    ]);
    expect(hybridStructure.getPageCount()).toBe(1);
    expect(visualStructure.getPageCount()).toBe(1);
    const hybridSize = hybridStructure.getPage(0).getSize();
    const visualSize = visualStructure.getPage(0).getSize();
    expect(hybridSize.width).toBeCloseTo(visualSize.width, 5);
    expect(hybridSize.height).toBeCloseTo(visualSize.height, 5);
    if (parityCase.expectedPage.kind === "exact") {
      expect(hybridSize.width).toBeCloseTo(parityCase.expectedPage.width, 5);
      expect(hybridSize.height).toBeCloseTo(parityCase.expectedPage.height, 5);
    } else {
      expect(hybridSize.width).toBeGreaterThan(parityCase.expectedPage.width);
      expect(hybridSize.height).toBeGreaterThan(parityCase.expectedPage.height);
    }

    const [hybridRender, visualRender] = await Promise.all([
      renderPdfPage(hybrid.bytes),
      renderPdfPage(visual.bytes),
    ]);
    const comparison = compareRenderedPages(hybridRender, visualRender);
    const withinParityGate = comparison.meanAbsoluteChannelDelta < 2.5
      && comparison.changedPixelRatio < 0.025
      && comparison.inkCoverageDeltaRatio < 0.08
      && comparison.inkIntersectionOverUnion > 0.88;
    if (!withinParityGate) {
      await attachMismatchEvidence(
        testInfo,
        parityCase.label,
        hybridRender,
        visualRender,
        comparison,
      );
    }
    expect(comparison, parityCase.label).toMatchObject({
      meanAbsoluteChannelDelta: expect.any(Number),
      changedPixelRatio: expect.any(Number),
      inkCoverageDeltaRatio: expect.any(Number),
      inkIntersectionOverUnion: expect.any(Number),
    });
    expect(comparison.meanAbsoluteChannelDelta, parityCase.label).toBeLessThan(2.5);
    expect(comparison.changedPixelRatio, parityCase.label).toBeLessThan(0.025);
    expect(comparison.inkCoverageDeltaRatio, parityCase.label).toBeLessThan(0.08);
    expect(comparison.inkIntersectionOverUnion, parityCase.label).toBeGreaterThan(0.88);
  }

  expect(pageErrors).toEqual([]);
});
