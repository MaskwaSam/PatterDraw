import { expect, test, type Download } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

async function enableExperimentalMathTools(page: import("@playwright/test").Page) {
  const toggle = page.getByRole("switch", { name: "Experimental features" });
  if (!await toggle.isChecked()) await toggle.check();
  await expect(page.getByTestId("math-tool-instruments-tab")).toBeVisible();
}

async function dragOnBoard(page: import("@playwright/test").Page, startOffset: { x: number; y: number }, endOffset: { x: number; y: number }) {
  const bounds = await page.locator(".editor-host").boundingBox();
  if (!bounds) throw new Error("Editor host has no visible bounds.");
  await page.mouse.move(bounds.x + startOffset.x, bounds.y + startOffset.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + endOffset.x, bounds.y + endOffset.y, { steps: 8 });
  await page.mouse.up();
}

async function dragNearBoardCenter(page: import("@playwright/test").Page) {
  const bounds = await page.locator(".editor-host").boundingBox();
  if (!bounds) throw new Error("Editor host has no visible bounds.");
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX - 90, centerY - 55);
  await page.mouse.down();
  await page.mouse.move(centerX + 90, centerY + 55, { steps: 8 });
  await page.mouse.up();
}

async function expectLoadedPreview(preview: import("@playwright/test").Locator) {
  await expect(preview).toBeVisible();
  await expect.poll(
    () => preview.evaluate((image: HTMLImageElement) => image.complete ? image.naturalWidth : 0),
    { timeout: 10_000, message: "Expected the slide preview image to finish rendering." },
  ).toBeGreaterThan(0);
}

async function pdfPageHorizontalCenterError(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    let smallestError = Number.POSITIVE_INFINITY;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(".editor-host canvas")) {
      if (canvas.width < 200 || canvas.height < 200) continue;
      const context = canvas.getContext("2d");
      if (!context) continue;
      for (const rowRatio of [0.2, 0.5, 0.8]) {
        const row = context.getImageData(0, Math.floor(canvas.height * rowRatio), canvas.width, 1).data;
        let runStart = -1;
        let bestStart = -1;
        let bestEnd = -1;
        for (let x = 0; x <= canvas.width; x += 1) {
          const offset = x * 4;
          const isPageWhite = x < canvas.width
            && row[offset] > 250
            && row[offset + 1] > 250
            && row[offset + 2] > 250
            && row[offset + 3] > 250;
          if (isPageWhite && runStart < 0) runStart = x;
          if ((!isPageWhite || x === canvas.width) && runStart >= 0) {
            if (x - runStart > bestEnd - bestStart) {
              bestStart = runStart;
              bestEnd = x - 1;
            }
            runStart = -1;
          }
        }
        if (bestEnd - bestStart < 100) continue;
        smallestError = Math.min(
          smallestError,
          Math.abs((bestStart + bestEnd) / 2 - canvas.width / 2) / canvas.width,
        );
      }
    }
    return smallestError;
  });
}

async function renderedRightEdgeDarkPixels(page: import("@playwright/test").Page): Promise<number> {
  const screenshot = await page.screenshot({ type: "png" });
  const screenshotDataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  return page.evaluate(async (imageUrl) => {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    let darkPixels = 0;
    const startX = Math.floor(canvas.width * 0.96);
    const startY = Math.floor(canvas.height * 0.35);
    const width = canvas.width - startX;
    const height = Math.floor(canvas.height * 0.35);
    const pixels = context.getImageData(startX, startY, width, height).data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (
        pixels[offset + 3] > 100
        && pixels[offset] < 100
        && pixels[offset + 1] < 100
        && pixels[offset + 2] < 100
      ) darkPixels += 1;
    }
    return darkPixels;
  }, screenshotDataUrl);
}

async function renderedRedPixelsNear(
  page: import("@playwright/test").Page,
  xRatio: number,
  yRatio: number,
): Promise<number> {
  const screenshot = await page.screenshot({ type: "png" });
  const screenshotDataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  return page.evaluate(async ({ imageUrl, xRatio, yRatio }) => {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const size = 12;
    const pixels = context.getImageData(
      Math.floor(canvas.width * xRatio) - size / 2,
      Math.floor(canvas.height * yRatio) - size / 2,
      size,
      size,
    ).data;
    let redPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (
        pixels[offset + 3] > 100
        && pixels[offset] > 180
        && pixels[offset + 1] < 100
        && pixels[offset + 2] < 100
      ) redPixels += 1;
    }
    return redPixels;
  }, { imageUrl: screenshotDataUrl, xRatio, yRatio });
}

async function openTestPdf(page: import("@playwright/test").Page, pageCount = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([612, 792]);
  const bytes = await document.save();
  await page.locator('input[type="file"]').setInputFiles({
    name: "toolbar-position.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: 15_000 });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(pageCount, { timeout: 15_000 });
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function useDownloadBasedImageExport(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function exportTestRectangle(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  index: string,
  frameId: string | null = null,
) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId,
    roundness: { type: 3 },
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index,
  };
}

async function autosavedFreedrawStroke(page: import("@playwright/test").Page): Promise<{
  strokeColor: string | null;
  strokeWidth: number | null;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ type?: string; strokeColor?: string; strokeWidth?: number }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const scene = project.scenes[project.activeSceneId];
    const stroke = [...(scene?.elements || [])].reverse().find((element) => element.type === "freedraw");
    if (!stroke) return null;
    return {
      strokeColor: stroke.strokeColor || null,
      strokeWidth: stroke.strokeWidth ?? null,
    };
  });
}

async function autosavedElementRoughness(
  page: import("@playwright/test").Page,
  type: string,
): Promise<number | null> {
  return page.evaluate(async (elementType) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ type?: string; roughness?: number }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const scene = project.scenes[project.activeSceneId];
    const element = [...(scene?.elements || [])].reverse().find((candidate) => candidate.type === elementType);
    return element?.roughness ?? null;
  }, type);
}

async function autosavedWebLink(page: import("@playwright/test").Page): Promise<{
  link: string | null;
  blockedElementCount: number;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ type?: string; link?: string | null }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const elements = project.scenes[project.activeSceneId]?.elements || [];
    const linkedElement = [...elements].reverse().find((element) => Boolean(element.link));
    return {
      link: linkedElement?.link || null,
      blockedElementCount: elements.filter(
        (element) => element.type === "embeddable" || element.type === "iframe" || element.type === "magicframe",
      ).length,
    };
  });
}

async function autosavedWorkspaceSummary(page: import("@playwright/test").Page): Promise<{
  activeIsPdf: boolean;
  boardSceneCount: number;
  pdfPageCount: number;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, { pdfPage?: unknown }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const scenes = Object.values(project.scenes);
    return {
      activeIsPdf: Boolean(project.scenes[project.activeSceneId]?.pdfPage),
      boardSceneCount: scenes.filter((scene) => !scene.pdfPage).length,
      pdfPageCount: scenes.filter((scene) => Boolean(scene.pdfPage)).length,
    };
  });
}

async function autosavedMathToolSnapshot(
  page: import("@playwright/test").Page,
  kind: "angle-measurement" | "cartesian-plane" | "compass" | "function-plot" | "geometry-stencil" | "grid" | "number-line" | "protractor" | "ruler" | "set-square" | "unit-circle",
): Promise<{
  backgroundLocked: boolean;
  backgroundWidth: number;
  captionFontSize: string | null;
  degreeLabelFontSize: string | null;
  fileMimeType: string | null;
  height: number;
  id: string;
  localSafeSvg: boolean;
  locked: boolean;
  mathJaxAngleLabelCount: number;
  mathJaxCoordinateLabelCount: number;
  mathJaxPathCount: number;
  measurementLabelFontSize: string | null;
  metadata: Record<string, unknown>;
  pageWidth: number;
  sceneId: string;
  scaleCaptionFontSize: string | null;
  width: number;
  x: number;
  y: number;
} | null> {
  return page.evaluate(async (toolKind) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      scenes: Record<string, {
        elements: Array<{
          customData?: { classroomMathTool?: Record<string, unknown> };
          fileId?: string | null;
          height?: number;
          id: string;
          isDeleted?: boolean;
          locked?: boolean;
          type?: string;
          width?: number;
          x?: number;
          y?: number;
        }>;
        files: Record<string, { dataURL?: string; mimeType?: string }>;
        pdfPage?: { backgroundElementId: string; width: number };
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;

    for (const [sceneId, scene] of Object.entries(project.scenes)) {
      const tool = scene.elements.find((element) =>
        !element.isDeleted
        && element.type === "image"
        && element.customData?.classroomMathTool?.kind === toolKind,
      );
      if (!tool) continue;
      const metadata = tool.customData?.classroomMathTool || {};
      const file = tool.fileId ? scene.files[tool.fileId] : undefined;
      const dataUrl = file?.dataURL || "";
      let svg = "";
      let captionFontSize: string | null = null;
      let degreeLabelFontSize: string | null = null;
      let measurementLabelFontSize: string | null = null;
      let scaleCaptionFontSize: string | null = null;
      let mathJaxAngleLabelCount = 0;
      let mathJaxCoordinateLabelCount = 0;
      let mathJaxPathCount = 0;
      if (dataUrl.startsWith("data:image/svg+xml;base64,")) {
        try {
          svg = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
          const svgDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
          captionFontSize = svgDocument.querySelector('[data-part="caption"]')?.getAttribute("font-size") || null;
          degreeLabelFontSize = svgDocument.querySelector('[data-part="degree-labels"]')?.getAttribute("font-size") || null;
          measurementLabelFontSize = svgDocument.querySelector('[data-part="measurement-labels"]')?.getAttribute("font-size") || null;
          scaleCaptionFontSize = svgDocument.querySelector('[data-part="scale-captions"]')?.getAttribute("font-size") || null;
          mathJaxAngleLabelCount = svgDocument.querySelectorAll('svg[data-angle-label][data-label-renderer="mathjax"]').length;
          mathJaxCoordinateLabelCount = svgDocument.querySelectorAll('svg[data-coordinate-label][data-label-renderer="mathjax"]').length;
          mathJaxPathCount = svgDocument.querySelectorAll('svg[data-label-renderer="mathjax"] path').length;
        } catch {
          svg = "";
        }
      }
      const background = scene.pdfPage
        ? scene.elements.find((element) => element.id === scene.pdfPage?.backgroundElementId)
        : undefined;
      return {
        backgroundLocked: Boolean(background?.locked),
        backgroundWidth: background?.width || 0,
        captionFontSize,
        degreeLabelFontSize,
        fileMimeType: file?.mimeType || null,
        height: tool.height || 0,
        id: tool.id,
        localSafeSvg: Boolean(svg)
          && !/<(?:script|iframe|foreignObject)\b/i.test(svg)
          && !/\b(?:href|src)\s*=/i.test(svg),
        locked: Boolean(tool.locked),
        mathJaxAngleLabelCount,
        mathJaxCoordinateLabelCount,
        mathJaxPathCount,
        measurementLabelFontSize,
        metadata,
        pageWidth: scene.pdfPage?.width || 0,
        sceneId,
        scaleCaptionFontSize,
        width: tool.width || 0,
        x: tool.x || 0,
        y: tool.y || 0,
      };
    }
    return null;
  }, kind);
}

async function autosavedFrameVisibility(page: import("@playwright/test").Page): Promise<boolean | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      slideFramesVisible?: boolean;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    return project.slideFramesVisible ?? null;
  });
}

async function autosavedMorphSettings(page: import("@playwright/test").Page): Promise<{
  durationMs: number | null;
  enabled: boolean | null;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      slideMorphDurationMs?: number;
      slideMorphEnabled?: boolean;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    return {
      durationMs: project.slideMorphDurationMs ?? null,
      enabled: project.slideMorphEnabled ?? null,
    };
  });
}

async function autosavedMathToolSetSnapshot(
  page: import("@playwright/test").Page,
  kind: "algebra-tile" | "fraction-piece" | "integer-chip" | "probability-piece",
): Promise<{
  angles: number[];
  count: number;
  fileCount: number;
  fileIds: string[];
  independent: boolean;
  lockedCount: number;
  localSafe: boolean;
  metadata: Record<string, unknown>[];
  pieceIndexes: number[];
  positions: Array<{ id: string; x: number; y: number }>;
  setIds: string[];
} | null> {
  return page.evaluate(async (toolKind) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{
          angle?: number;
          customData?: { classroomMathTool?: Record<string, unknown> };
          fileId?: string;
          groupIds?: string[];
          id: string;
          isDeleted?: boolean;
          locked?: boolean;
          type?: string;
          x?: number;
          y?: number;
        }>;
        files: Record<string, { dataURL?: string; mimeType?: string }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const scene = project.scenes[project.activeSceneId];
    if (!scene) return null;
    const elements = scene.elements.filter((element) =>
      !element.isDeleted && element.type === "image" && element.customData?.classroomMathTool?.kind === toolKind,
    );
    const metadata = elements.map((element) => element.customData?.classroomMathTool || {});
    const referencedFiles = new Set(elements.map((element) => element.fileId).filter(Boolean));
    return {
      angles: elements.map((element) => element.angle || 0),
      count: elements.length,
      fileCount: referencedFiles.size,
      fileIds: elements.map((element) => element.fileId || ""),
      independent: new Set(elements.map((element) => element.id)).size === elements.length && elements.every((element) => !element.groupIds?.length),
      lockedCount: elements.filter((element) => element.locked).length,
      localSafe: elements.every((element) => {
        const file = element.fileId ? scene.files[element.fileId] : undefined;
        const dataUrl = file?.dataURL || "";
        if (file?.mimeType !== "image/svg+xml" || !dataUrl.startsWith("data:image/svg+xml;base64,")) return false;
        const svg = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
        return !/<(?:script|iframe|foreignObject)\b/i.test(svg) && !/\b(?:href|src)\s*=/i.test(svg);
      }),
      metadata,
      pieceIndexes: metadata.map((item) => Number(item.pieceIndex)),
      positions: elements.map((element) => ({ id: element.id, x: element.x || 0, y: element.y || 0 })),
      setIds: [...new Set(metadata.map((item) => String(item.setId)))],
    };
  }, kind);
}

async function autosavedTransformationSnapshot(page: import("@playwright/test").Page): Promise<{
  count: number;
  finiteGeometry: boolean;
  originalSourcesRemain: boolean;
  rectangleCount: number;
  transformationTypes: string[];
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ customData?: { classroomMathTool?: Record<string, unknown> }; height?: number; id: string; isDeleted?: boolean; type?: string; width?: number; x?: number; y?: number }> }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const elements = project.scenes[project.activeSceneId]?.elements.filter((element) => !element.isDeleted) || [];
    const transformed = elements.filter((element) => element.customData?.classroomMathTool?.kind === "transformation");
    const ids = new Set(elements.map((element) => element.id));
    return {
      count: transformed.length,
      finiteGeometry: transformed.every((element) => [element.x, element.y, element.width, element.height].every((value) => typeof value === "number" && Number.isFinite(value) && (value === element.x || value === element.y || value > 0))),
      originalSourcesRemain: transformed.every((element) => ids.has(String(element.customData?.classroomMathTool?.sourceElementId))),
      rectangleCount: elements.filter((element) => element.type === "rectangle").length,
      transformationTypes: transformed.map((element) => String(element.customData?.classroomMathTool?.transformationType)),
    };
  });
}

async function autosavedMathToolElementSummary(
  page: import("@playwright/test").Page,
  kind: string,
): Promise<{ imageCount: number; nativeMinX: number; nativeEllipseCount: number; parts: string[] } | null> {
  return page.evaluate(async (toolKind) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ customData?: { classroomMathTool?: { kind?: string }; classroomMathToolPart?: string }; isDeleted?: boolean; type?: string; x?: number }> }>;
    } | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly").objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const elements = project.scenes[project.activeSceneId]?.elements.filter((element) => !element.isDeleted && element.customData?.classroomMathTool?.kind === toolKind) || [];
    return {
      imageCount: elements.filter((element) => element.type === "image").length,
      nativeMinX: Math.min(...elements.filter((element) => element.type === "ellipse").map((element) => element.x || 0)),
      nativeEllipseCount: elements.filter((element) => element.type === "ellipse").length,
      parts: elements.map((element) => element.customData?.classroomMathToolPart || "image"),
    };
  }, kind);
}

async function autosavedSlideOverflow(page: import("@playwright/test").Page): Promise<{
  ownsFrame: boolean;
  crossesFrameEdge: boolean;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{
          id: string;
          type?: string;
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          frameId?: string | null;
        }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const scene = project.scenes[project.activeSceneId];
    const frame = scene?.elements.find((element) => element.type === "frame");
    const stroke = [...(scene?.elements || [])].reverse().find((element) => element.type === "freedraw");
    if (!frame || !stroke) return null;
    const frameLeft = frame.x || 0;
    const frameTop = frame.y || 0;
    const frameRight = frameLeft + (frame.width || 0);
    const frameBottom = frameTop + (frame.height || 0);
    const strokeLeft = stroke.x || 0;
    const strokeTop = stroke.y || 0;
    const strokeRight = strokeLeft + (stroke.width || 0);
    const strokeBottom = strokeTop + (stroke.height || 0);
    return {
      ownsFrame: stroke.frameId === frame.id,
      crossesFrameEdge: strokeLeft < frameLeft
        || strokeTop < frameTop
        || strokeRight > frameRight
        || strokeBottom > frameBottom,
    };
  });
}

async function autosavedPresentationInkStack(page: import("@playwright/test").Page): Promise<{
  colours: string[];
  frameIds: Array<string | null>;
  latestIsTop: boolean;
  allInkIsAboveSlideContent: boolean;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{
          id: string;
          type?: string;
          strokeColor?: string;
          frameId?: string | null;
          isDeleted?: boolean;
        }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const elements = (project.scenes[project.activeSceneId]?.elements || [])
      .filter((element) => !element.isDeleted);
    const ink = elements.filter((element) => element.type === "freedraw");
    const firstInkIndex = elements.findIndex((element) => element.type === "freedraw");
    return {
      colours: ink.map((element) => element.strokeColor || ""),
      frameIds: ink.map((element) => element.frameId || null),
      latestIsTop: Boolean(ink.length) && elements.at(-1)?.id === ink.at(-1)?.id,
      allInkIsAboveSlideContent: firstInkIndex >= 0
        && elements.slice(firstInkIndex).every((element) => element.type === "freedraw"),
    };
  });
}

async function autosavedSlideDeletion(page: import("@playwright/test").Page): Promise<{
  slideCount: number;
  frameCount: number;
  rectangleCount: number;
  framedRectangleCount: number;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      slideOrder: unknown[];
      scenes: Record<string, {
        elements: Array<{ type?: string; frameId?: string | null }>;
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    const elements = project.scenes[project.activeSceneId]?.elements || [];
    const rectangles = elements.filter((element) => element.type === "rectangle");
    return {
      slideCount: project.slideOrder.length,
      frameCount: elements.filter((element) => element.type === "frame").length,
      rectangleCount: rectangles.length,
      framedRectangleCount: rectangles.filter((element) => Boolean(element.frameId)).length,
    };
  });
}

async function autosavedRectanglePositions(page: import("@playwright/test").Page): Promise<Array<{
  id: string;
  x: number;
  y: number;
}>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ id: string; isDeleted?: boolean; type?: string; x?: number; y?: number }> }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return (project?.scenes[project.activeSceneId]?.elements || [])
      .filter((element) => element.type === "rectangle" && !element.isDeleted)
      .map((element) => ({ id: element.id, x: element.x || 0, y: element.y || 0 }))
      .sort((left, right) => left.x - right.x);
  });
}

async function autosavedPdfBackgroundPosition(page: import("@playwright/test").Page): Promise<{
  locked: boolean;
  x: number;
  y: number;
} | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ id: string; locked?: boolean; x?: number; y?: number }>;
        pdfPage?: { backgroundElementId: string };
      }>;
    } | undefined>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("excalidraw-classroom:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const scene = project?.scenes[project.activeSceneId];
    const background = scene?.elements.find((element) => element.id === scene.pdfPage?.backgroundElementId);
    return background ? { locked: Boolean(background.locked), x: background.x || 0, y: background.y || 0 } : null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
});

test("exposes native stroke colour and drawing weight controls", async ({ page }) => {
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 300, y: 190 }, { x: 560, y: 390 });

  const strokeColour = page.getByRole("button", { name: "Stroke", exact: true });
  await expect(strokeColour).toBeVisible();
  const originalColour = await strokeColour.getAttribute("style");
  await strokeColour.click();
  await page.locator('[data-testid^="color-top-pick-"]').nth(1).click();
  await expect(strokeColour).not.toHaveAttribute("style", originalColour || "");

  const boldStroke = page.getByTestId("strokeWidth-bold");
  await boldStroke.check({ force: true });
  await expect(boldStroke).toBeChecked();

  const widths = page.locator('input[name="stroke-width"]');
  await expect(widths).toHaveCount(5);
  const widthRows = await widths.evaluateAll((inputs) => inputs.map((input) =>
    Math.round(input.closest("label")?.getBoundingClientRect().y || 0),
  ));
  expect(new Set(widthRows).size).toBe(1);
  const extraFineStroke = page.getByTestId("strokeWidth-extraFine");
  await extraFineStroke.check({ force: true });
  await expect(extraFineStroke).toBeChecked();
  await page.getByTestId("toolbar-freedraw").check({ force: true });
  await dragOnBoard(page, { x: 320, y: 230 }, { x: 500, y: 320 });
  await expect.poll(() => autosavedFreedrawStroke(page)).toMatchObject({ strokeWidth: 0.5 });

  const heavyStroke = page.getByTestId("strokeWidth-heavy");
  await heavyStroke.check({ force: true });
  await expect(heavyStroke).toBeChecked();
  await dragOnBoard(page, { x: 340, y: 250 }, { x: 520, y: 340 });
  await expect.poll(() => autosavedFreedrawStroke(page)).toMatchObject({ strokeWidth: 3 });
});

test("defaults line drawings to no sloppiness without changing other shape tools", async ({ page }) => {
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  const sloppinessOptions = page.locator('input[name="sloppiness"]');
  await expect(sloppinessOptions).toHaveCount(3);
  await sloppinessOptions.nth(2).check({ force: true });

  await page.getByTestId("toolbar-line").check({ force: true });
  await expect(sloppinessOptions.nth(0)).toBeChecked();

  await dragOnBoard(page, { x: 300, y: 210 }, { x: 560, y: 350 });
  await expect.poll(() => autosavedElementRoughness(page, "line")).toBe(0);

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await expect(sloppinessOptions.nth(2)).toBeChecked();
  await dragOnBoard(page, { x: 340, y: 250 }, { x: 520, y: 390 });
  await expect.poll(() => autosavedElementRoughness(page, "rectangle")).toBe(2);
});

test("adds and explicitly opens safe web links without enabling embeds", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.context().route("https://example.test/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "Linked classroom resource" });
  });

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 320, y: 230 }, { x: 560, y: 390 });
  await page.keyboard.press("ControlOrMeta+k");
  const linkInput = page.locator(".excalidraw-hyperlinkContainer-input");
  await expect(linkInput).toBeVisible();
  await linkInput.fill("https://example.test/class-resource");
  await linkInput.press("Enter");

  const link = page.locator(".excalidraw-hyperlinkContainer-link");
  await expect(link).toHaveText("https://example.test/class-resource");
  await expect.poll(() => autosavedWebLink(page)).toEqual({
    link: "https://example.test/class-resource",
    blockedElementCount: 0,
  });
  await expect.poll(() => page.evaluate(async () => {
    try {
      await fetch("https://example.test/background-request");
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })).toContain("blocks external network access");

  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://example.test/class-resource");
  await popup.close();

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => autosavedWebLink(page)).toEqual({
    link: "https://example.test/class-resource",
    blockedElementCount: 0,
  });
  expect(consoleErrors).toEqual([]);
});

test("toggles fullscreen from the bottom-right status bar", async ({ page }) => {
  const fullscreenButton = page.getByRole("button", { name: "Enter fullscreen", exact: true });
  await expect(fullscreenButton).toBeVisible();
  await expect(fullscreenButton).toHaveAttribute("aria-pressed", "false");
  await expect(fullscreenButton.locator("span")).toHaveCount(0);
  const iconOnlySize = await fullscreenButton.boundingBox();
  expect(iconOnlySize).not.toBeNull();
  expect(Math.abs((iconOnlySize?.width || 0) - (iconOnlySize?.height || 0))).toBeLessThanOrEqual(1);

  const statusbar = await page.locator(".statusbar").boundingBox();
  const button = await fullscreenButton.boundingBox();
  expect(statusbar).not.toBeNull();
  expect(button).not.toBeNull();
  expect(Math.abs((statusbar?.x || 0) + (statusbar?.width || 0) - ((button?.x || 0) + (button?.width || 0))))
    .toBeLessThanOrEqual(18);

  await fullscreenButton.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("app-shell")))
    .toBe(true);
  const exitFullscreen = page.getByRole("button", { name: "Exit fullscreen", exact: true });
  await expect(exitFullscreen).toHaveAttribute("aria-pressed", "true");

  await exitFullscreen.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.getByRole("button", { name: "Enter fullscreen", exact: true }))
    .toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : Promise.resolve());
  await expect(page.getByRole("button", { name: "Enter fullscreen", exact: true }))
    .toHaveAttribute("aria-pressed", "false");
});

test("moves board zoom and history controls into the footer", async ({ page }) => {
  const nativeFooterControls = page.locator(".editor-host .layer-ui__wrapper__footer-left");
  await expect(nativeFooterControls).toBeHidden();

  const footerZoom = page.locator(".footer-zoom-controls");
  await expect(footerZoom).toHaveAccessibleName("Board zoom controls");
  const resetZoom = footerZoom.getByRole("button", { name: "Reset zoom", exact: true });
  await expect(resetZoom).toHaveText("100%");
  await footerZoom.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(resetZoom).not.toHaveText("100%");
  await resetZoom.click();
  await expect(resetZoom).toHaveText("100%");

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 300, y: 190 }, { x: 560, y: 390 });
  const nativeUndo = page.getByTestId("button-undo");
  const nativeRedo = page.getByTestId("button-redo");
  await expect(nativeUndo).toBeEnabled();
  await page.locator('.statusbar .footer-history-button[aria-label="Undo"]').click();
  await expect(nativeUndo).toBeDisabled();
  await expect(nativeRedo).toBeEnabled();
  await page.locator('.statusbar .footer-history-button[aria-label="Redo"]').click();
  await expect(nativeRedo).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 844 });
  const footerBox = await page.locator(".statusbar").boundingBox();
  const zoomBox = await footerZoom.boundingBox();
  const actionsBox = await page.locator(".statusbar-actions").boundingBox();
  expect(footerBox).not.toBeNull();
  expect(zoomBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(zoomBox?.y || 0).toBeGreaterThanOrEqual(footerBox?.y || 0);
  expect((zoomBox?.y || 0) + (zoomBox?.height || 0))
    .toBeLessThanOrEqual((footerBox?.y || 0) + (footerBox?.height || 0));
  expect((zoomBox?.x || 0) + (zoomBox?.width || 0)).toBeLessThanOrEqual(actionsBox?.x || 0);
});

test("moves slide zoom and history controls into the footer", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  const nativeFooterControls = page.locator(".editor-host .layer-ui__wrapper__footer-left");
  await expect(nativeFooterControls).toBeHidden();

  const zoomControls = page.getByRole("group", { name: "Slides zoom controls" });
  await expect(zoomControls).toBeVisible();
  await expect(page.locator('.statusbar .footer-history-button[aria-label="Undo"]')).toBeVisible();
  await expect(page.locator('.statusbar .footer-history-button[aria-label="Redo"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Present", exact: true })).toBeVisible();

  const resetZoom = page.locator(".statusbar .footer-reset-zoom");
  const initialZoom = await resetZoom.textContent();
  await page.locator('.statusbar button[aria-label="Zoom in"]').click();
  await expect(resetZoom).not.toHaveText(initialZoom || "");

  const footerBox = await page.locator(".statusbar").boundingBox();
  const zoomBox = await zoomControls.boundingBox();
  expect(footerBox).not.toBeNull();
  expect(zoomBox).not.toBeNull();
  expect(Math.abs(
    (zoomBox?.x || 0) + (zoomBox?.width || 0) / 2
      - ((footerBox?.x || 0) + (footerBox?.width || 0) / 2),
  )).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneFooter = await page.locator(".statusbar").boundingBox();
  const phoneZoom = await zoomControls.boundingBox();
  const phoneActions = await page.locator(".statusbar-actions").boundingBox();
  expect(phoneFooter).not.toBeNull();
  expect(phoneZoom).not.toBeNull();
  expect(phoneActions).not.toBeNull();
  expect((phoneZoom?.x || 0) + (phoneZoom?.width || 0)).toBeLessThanOrEqual(phoneActions?.x || 0);
  expect((phoneActions?.x || 0) + (phoneActions?.width || 0))
    .toBeLessThanOrEqual((phoneFooter?.x || 0) + (phoneFooter?.width || 0));
});

test("hides and restores the navigation by button or keyboard shortcut", async ({ page }) => {
  const shell = page.locator(".app-shell");
  const navigation = page.locator(".topbar");
  const editorHost = page.locator(".editor-host");
  const initialEditor = await editorHost.boundingBox();
  expect(initialEditor).not.toBeNull();

  await page.getByRole("button", { name: "Hide navigation", exact: true }).click();
  await expect(navigation).toHaveCount(0);
  await expect(shell).toHaveClass(/is-nav-hidden/);
  await expect(page.getByRole("button", { name: "Show navigation", exact: true })).toBeVisible();
  const expandedEditor = await editorHost.boundingBox();
  expect(expandedEditor).not.toBeNull();
  expect(expandedEditor?.height || 0).toBeGreaterThan((initialEditor?.height || 0) + 40);

  await page.keyboard.press("Control+Shift+H");
  await expect(navigation).toBeVisible();
  await expect(shell).not.toHaveClass(/is-nav-hidden/);

  await page.keyboard.press("Control+Shift+H");
  await expect(navigation).toHaveCount(0);
  await page.getByRole("button", { name: "Show navigation", exact: true }).click();
  await expect(navigation).toBeVisible();
});

test("hides and restores the footer by button or keyboard shortcut", async ({ page }) => {
  const shell = page.locator(".app-shell");
  const footer = page.locator(".statusbar");
  const editorHost = page.locator(".editor-host");
  const initialEditor = await editorHost.boundingBox();
  expect(initialEditor).not.toBeNull();

  await page.getByRole("button", { name: "Hide footer", exact: true }).click();
  await expect(footer).toHaveCount(0);
  await expect(shell).toHaveClass(/is-footer-hidden/);
  await expect(page.getByRole("button", { name: "Show footer", exact: true })).toBeVisible();
  const expandedEditor = await editorHost.boundingBox();
  expect(expandedEditor).not.toBeNull();
  expect(expandedEditor?.height || 0).toBeGreaterThan((initialEditor?.height || 0) + 35);

  await page.keyboard.press("Control+Shift+F");
  await expect(footer).toBeVisible();
  await expect(shell).not.toHaveClass(/is-footer-hidden/);

  await page.keyboard.press("Control+Shift+F");
  await expect(footer).toHaveCount(0);
  await page.getByRole("button", { name: "Show footer", exact: true }).click();
  await expect(footer).toBeVisible();
});

test("keeps the Slides Present control contained at desktop and phone widths", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  const present = page.locator(".present-button");
  await expect(present).toBeVisible();
  const desktopBox = await present.boundingBox();
  expect(desktopBox).not.toBeNull();
  expect(desktopBox?.width || 0).toBeGreaterThan(60);
  const desktopOverflow = await present.evaluate((button) => ({
    clientWidth: button.clientWidth,
    scrollWidth: button.scrollWidth,
  }));
  expect(desktopOverflow.scrollWidth).toBeLessThanOrEqual(desktopOverflow.clientWidth);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(present.locator("span")).toBeHidden();
  const phoneBox = await present.boundingBox();
  expect(phoneBox).not.toBeNull();
  expect(phoneBox?.width || 0).toBeCloseTo(34, 0);
});

test("toggles and persists the Morph slide transition", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  const morph = page.getByRole("button", { name: "Morph", exact: true });
  await expect(morph).toBeVisible();
  await expect(morph).toHaveAttribute("aria-pressed", "false");

  await morph.click();
  await expect(morph).toHaveAttribute("aria-pressed", "true");
  const duration = page.getByRole("slider", { name: "Morph duration", exact: true });
  await expect(duration).toHaveValue("650");
  await expect(duration).toHaveAttribute("max", "5000");
  await duration.fill("5000");
  await expect(page.locator(".morph-duration-control output")).toHaveText("5 s");
  await expect.poll(() => autosavedMorphSettings(page)).toEqual({ durationMs: 5_000, enabled: true });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.getByRole("button", { name: "Morph", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Morph duration", exact: true })).toHaveValue("5000");
});

test("toggles slide frames for a cleaner board without removing slides", async ({ page }) => {
  const editor = page.locator(".editor-host .excalidraw");
  await editor.evaluate((element) => element.setAttribute("data-frame-toggle-instance", "original"));
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);

  const hideFrames = page.getByRole("button", { name: "Hide slide frames", exact: true });
  await expect(hideFrames).toHaveAttribute("aria-pressed", "true");
  await hideFrames.click();
  const showFrames = page.getByRole("button", { name: "Show slide frames", exact: true });
  await expect(showFrames).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Opacity", { exact: true })).toBeHidden();
  await expect.poll(() => autosavedFrameVisibility(page)).toBe(false);
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(showFrames).toHaveCount(0);
  await expect(editor).toHaveAttribute("data-frame-toggle-instance", "original");
  await expect.poll(() => autosavedFrameVisibility(page)).toBe(false);

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Show slide frames", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide slide frames", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => autosavedFrameVisibility(page)).toBe(true);
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
});

test("deletes the selected slide frame while preserving its board content", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.getByRole("button", { name: "Delete selected slide", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  const selectedSlideWrap = page.locator(".slide-thumbnail-wrap").filter({
    has: page.locator(".slide-thumbnail.is-selected"),
  });
  const slideDelete = selectedSlideWrap.getByRole("button", { name: "Delete selected slide", exact: true });
  await expect(slideDelete).toBeVisible();
  await expect(slideDelete).toHaveText("");
  await expect(slideDelete.locator("svg")).toHaveCount(1);

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragNearBoardCenter(page);
  await expect.poll(() => autosavedSlideDeletion(page)).toMatchObject({
    slideCount: 1,
    frameCount: 1,
    rectangleCount: 1,
    framedRectangleCount: 1,
  });

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("The frame will be removed, but its board content will stay.");
    await dialog.accept();
  });
  await slideDelete.click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete selected slide", exact: true })).toHaveCount(0);
  await expect.poll(() => autosavedSlideDeletion(page), { timeout: 8_000 }).toEqual({
    slideCount: 0,
    frameCount: 0,
    rectangleCount: 1,
    framedRectangleCount: 0,
  });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(0);
  await expect.poll(() => autosavedSlideDeletion(page)).toEqual({
    slideCount: 0,
    frameCount: 0,
    rectangleCount: 1,
    framedRectangleCount: 0,
  });
});

test("keeps presentation ink visible beyond its frame when the stroke starts inside", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  await page.waitForTimeout(350);

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");
  await page.getByRole("button", { name: "Ink", exact: true }).click();
  const bounds = await page.locator(".editor-host").boundingBox();
  if (!bounds) throw new Error("Editor host has no visible bounds.");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 16 });
  await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height * 0.65, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => autosavedSlideOverflow(page), { timeout: 8_000 }).toMatchObject({
    ownsFrame: false,
    crossesFrameEdge: true,
  });
  await expect.poll(() => renderedRightEdgeDarkPixels(page), { timeout: 5_000 }).toBeGreaterThan(40);

  await page.getByRole("button", { name: "Red ink", exact: true }).click();
  await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.58, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => autosavedPresentationInkStack(page), { timeout: 8_000 }).toEqual({
    colours: ["#1b1b1f", "#e03131"],
    frameIds: [null, null],
    latestIsTop: true,
    allInkIsAboveSlideContent: true,
  });
  await expect.poll(
    () => renderedRedPixelsNear(page, 0.75, 0.5),
    { timeout: 5_000 },
  ).toBeGreaterThan(3);
});

test("previews existing content geometrically enclosed by a frame", async ({ page }) => {
  const common = {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: "slide-1-frame",
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
  const rectangle = {
    ...common,
    id: "existing-content",
    type: "rectangle",
    x: 240,
    y: 180,
    width: 300,
    height: 180,
    backgroundColor: "#a5d8ff",
    roundness: { type: 3 },
    index: "a0",
  };
  const firstFrame = {
    ...common,
    frameId: null,
    id: "slide-1-frame",
    type: "frame",
    x: 760,
    y: 0,
    width: 420,
    height: 300,
    name: "Slide 1",
    index: "a1",
  };
  const frame = {
    ...common,
    frameId: null,
    id: "slide-2-frame",
    type: "frame",
    x: 180,
    y: 120,
    width: 420,
    height: 300,
    name: "Slide 2",
    index: "a2",
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "frame-around-existing-content.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [rectangle, firstFrame, frame],
      appState: {},
      files: {},
    })),
  });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  const slide2 = page.locator(".slide-thumbnail").filter({ hasText: "Slide 2" });
  const preview = slide2.locator(".slide-preview img");
  await expectLoadedPreview(preview);
  const colouredPixels = await preview.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 230 && pixels[offset + 1] < 240 && pixels[offset + 2] > 230) count += 1;
    }
    return count;
  });
  expect(colouredPixels).toBeGreaterThan(1_000);
  await expect(slide2.locator(".slide-caption")).toHaveText("Slide 2");
});

test("fits the first slide after presentation layout opens", async ({ page }) => {
  const common = {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
  const frame = (id: string, name: string, x: number, index: string, width = 960, height = 540) => ({
    ...common,
    id,
    type: "frame",
    x,
    y: 100,
    width,
    height,
    name,
    index,
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "presentation-first-fit.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [
        frame("first-frame", "Slide 1", 0, "a0"),
        frame("second-frame", "Slide 2", 1200, "a1", 480, 270),
      ],
      appState: {},
      files: {},
    })),
  });

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Morph", exact: true }).click();
  await page.getByRole("slider", { name: "Morph duration", exact: true }).fill("1200");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 2");
  await expect(page.locator(".editor-region")).toHaveAttribute("data-slide-transition", "morph");
  await expect(page.locator(".editor-region")).toHaveAttribute("data-morph-duration-ms", "1200");
  await expect.poll(() => page.locator(".editor-region").getAttribute("data-presentation-zoom"))
    .not.toBeNull();
  await page.waitForTimeout(450);
  const firstEntryZoom = Number(await page.locator(".editor-region").getAttribute("data-presentation-zoom"));

  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("2 / 2");
  await page.waitForTimeout(600);
  const midMorphZoom = Number(await page.locator(".editor-region").getAttribute("data-presentation-zoom"));
  await page.waitForTimeout(800);
  const secondEntryZoom = Number(await page.locator(".editor-region").getAttribute("data-presentation-zoom"));
  expect(secondEntryZoom).toBeGreaterThan(firstEntryZoom + 20);
  expect(midMorphZoom).toBeGreaterThan(firstEntryZoom);
  expect(midMorphZoom).toBeLessThan(secondEntryZoom);
  await page.getByRole("button", { name: "Previous slide", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 2");
  await page.waitForTimeout(1_300);
  const returnZoom = Number(await page.locator(".editor-region").getAttribute("data-presentation-zoom"));

  expect(firstEntryZoom).toBeCloseTo(returnZoom, 0);
});

test("refreshes a PDF-active autosave back to the board without losing the PDF", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await openTestPdf(page);
  await expect.poll(() => autosavedWorkspaceSummary(page)).toEqual({
    activeIsPdf: true,
    boardSceneCount: 1,
    pdfPageCount: 1,
  });

  await page.reload();
  await expect(page).toHaveTitle("Canvas Classroom");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator(".page-status")).toContainText("Board");

  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").first()).toHaveClass(/is-selected/);
  expect(consoleErrors).toEqual([]);
});

test("docks the drawing toolbar and resizes or hides the PDF page rail", async ({ page }) => {
  test.setTimeout(60_000);
  const toolbar = page.locator(".shapes-section");
  const editorHost = page.locator(".editor-host");
  const boardToolbar = await toolbar.boundingBox();
  const boardHost = await editorHost.boundingBox();
  expect(boardToolbar).not.toBeNull();
  expect(boardHost).not.toBeNull();
  expect((boardToolbar?.y || 0) - (boardHost?.y || 0)).toBeLessThan(100);

  await openTestPdf(page);

  await expect.poll(() => pdfPageHorizontalCenterError(page)).toBeLessThan(0.02);
  const nativeFooterControls = page.locator(".editor-host .layer-ui__wrapper__footer-left");
  await expect(nativeFooterControls).toBeHidden();
  const footerZoom = page.locator(".footer-zoom-controls");
  await expect(footerZoom).toBeVisible();
  const resetZoom = footerZoom.getByRole("button", { name: "Reset zoom", exact: true });
  const initialZoom = await resetZoom.textContent();
  await footerZoom.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(resetZoom).not.toHaveText(initialZoom || "");
  await resetZoom.click();
  await expect(resetZoom).toHaveText("100%");

  const pdfToolbar = await toolbar.boundingBox();
  const pdfHost = await editorHost.boundingBox();
  const statusbar = await page.locator(".statusbar").boundingBox();
  expect(pdfToolbar).not.toBeNull();
  expect(pdfHost).not.toBeNull();
  expect(statusbar).not.toBeNull();
  expect((pdfHost?.y || 0) + (pdfHost?.height || 0) - ((pdfToolbar?.y || 0) + (pdfToolbar?.height || 0)))
    .toBeLessThanOrEqual(20);
  expect((pdfToolbar?.y || 0) + (pdfToolbar?.height || 0)).toBeLessThan(statusbar?.y || 0);

  const toolbarToggle = page.getByRole("button", { name: "Hide drawing tools", exact: true });
  await expect(toolbarToggle).toBeVisible();
  await expect(toolbarToggle).toHaveAttribute("aria-pressed", "true");
  await toolbarToggle.click();
  await expect(toolbar).toBeHidden();
  const showToolbar = page.getByRole("button", { name: "Show drawing tools", exact: true });
  await expect(showToolbar).toHaveAttribute("aria-pressed", "false");
  await showToolbar.click();
  await expect(toolbar).toBeVisible();

  const extraToolsTrigger = page.locator(".App-toolbar__extra-tools-trigger");
  await extraToolsTrigger.click();
  const extraToolsMenu = page.locator(".App-toolbar__extra-tools-dropdown");
  await expect(extraToolsMenu).toBeVisible();
  const extraToolsTriggerBox = await extraToolsTrigger.boundingBox();
  const extraToolsMenuBox = await extraToolsMenu.boundingBox();
  expect(extraToolsTriggerBox).not.toBeNull();
  expect(extraToolsMenuBox).not.toBeNull();
  expect((extraToolsMenuBox?.y || 0) + (extraToolsMenuBox?.height || 0))
    .toBeLessThanOrEqual(extraToolsTriggerBox?.y || 0);
  await extraToolsTrigger.click();
  await expect(extraToolsMenu).toBeHidden();

  await page.getByTestId("toolbar-freedraw").check({ force: true });
  await expect(page.getByTestId("toolbar-freedraw")).toBeChecked();
  await dragNearBoardCenter(page);
  const nativeUndo = page.getByTestId("button-undo");
  const nativeRedo = page.getByTestId("button-redo");
  await expect(nativeUndo).toBeEnabled();
  await page.locator('.statusbar .footer-history-button[aria-label="Undo"]').click();
  await expect(nativeUndo).toBeDisabled();
  await expect(nativeRedo).toBeEnabled();
  await page.locator('.statusbar .footer-history-button[aria-label="Redo"]').click();
  await expect(nativeRedo).toBeDisabled();

  const rail = page.locator("#pdf-page-rail");
  const resizeHandle = page.getByRole("separator", { name: "Resize PDF pages" });
  const initialRail = await rail.boundingBox();
  expect(initialRail).not.toBeNull();
  await resizeHandle.focus();
  await resizeHandle.press("ArrowRight");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "240");

  const handle = await resizeHandle.boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move((handle?.x || 0) + (handle?.width || 0) / 2, (handle?.y || 0) + 100);
  await page.mouse.down();
  await page.mouse.move((handle?.x || 0) + 90, (handle?.y || 0) + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await rail.boundingBox())?.width || 0).toBeGreaterThan(300);

  const resizedWidth = (await rail.boundingBox())?.width || 0;
  await page.getByRole("button", { name: "Hide PDF pages", exact: true }).click();
  await expect(rail).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-rail-hidden/);
  await expect.poll(() => pdfPageHorizontalCenterError(page)).toBeLessThan(0.02);
  const showPages = page.getByRole("button", { name: "Show PDF pages", exact: true });
  await expect(showPages).toBeVisible();
  await expect(page.locator(".page-status")).toContainText("Pages");
  const showPagesBox = await showPages.boundingBox();
  const previousPageBox = await page.getByRole("button", { name: "Previous PDF page", exact: true }).boundingBox();
  expect(showPagesBox).not.toBeNull();
  expect(previousPageBox).not.toBeNull();
  expect((showPagesBox?.x || 0) + (showPagesBox?.width || 0)).toBeLessThan(previousPageBox?.x || 0);
  await showPages.click();
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())?.width || 0).toBeCloseTo(resizedWidth, 0);
});

test("inserts and persists a Letter-calibrated ruler from Math tools", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") {
      externalRequests.push(request.url());
    }
  });

  await openTestPdf(page);
  const extraToolsTrigger = page.locator(".App-toolbar__extra-tools-trigger");
  await extraToolsTrigger.click();
  const extraToolsMenu = page.locator(".App-toolbar__extra-tools-dropdown");
  const mathTools = page.getByTestId("toolbar-math-tools");
  await expect(extraToolsMenu).toBeVisible();
  await expect(mathTools).toBeVisible();
  await expect(page.getByTestId("toolbar-lasso")).toHaveCount(0);
  await expect(mathTools).not.toHaveAttribute("role", "menuitem");
  await expect(mathTools.locator("xpath=ancestor::*[contains(@class, 'dropdown-menu-container')]")).toHaveCount(1);

  const triggerBox = await extraToolsTrigger.boundingBox();
  const menuBox = await extraToolsMenu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect((menuBox?.y || 0) + (menuBox?.height || 0)).toBeLessThanOrEqual(triggerBox?.y || 0);

  await mathTools.click();
  await expect(extraToolsMenu).toBeHidden();
  const dialog = page.getByRole("dialog", { name: "Math tools", exact: true });
  await expect(dialog).toBeVisible();
  const rulerButton = page.getByTestId("math-tool-ruler");
  const protractorButton = page.getByTestId("math-tool-protractor");
  const experimentalToggle = page.getByRole("switch", { name: "Experimental features" });
  await expect(experimentalToggle).not.toBeChecked();
  await expect(page.getByTestId("math-tool-instruments-tab")).toHaveCount(0);
  await expect(page.getByTestId("math-tool-set-square")).toHaveCount(0);
  await expect(dialog).not.toContainText("Dual-scale ruler for calibrated PDF measurement");
  await expect(dialog).not.toContainText("Inserted at 72 points per inch");
  await expect(rulerButton).toBeFocused();
  await expect(rulerButton.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  await expect(protractorButton.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);

  const desktopRulerBox = await rulerButton.boundingBox();
  const desktopProtractorBox = await protractorButton.boundingBox();
  expect(desktopRulerBox).not.toBeNull();
  expect(desktopProtractorBox).not.toBeNull();
  expect(desktopProtractorBox?.y).toBeCloseTo(desktopRulerBox?.y || 0, 0);
  expect(desktopProtractorBox?.width).toBeCloseTo(desktopRulerBox?.width || 0, 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDialogBox = await dialog.boundingBox();
  const mobileRulerBox = await rulerButton.boundingBox();
  const mobileProtractorBox = await protractorButton.boundingBox();
  expect(mobileDialogBox).not.toBeNull();
  expect((mobileDialogBox?.x || 0) + (mobileDialogBox?.width || 0)).toBeLessThanOrEqual(390);
  expect((mobileDialogBox?.y || 0) + (mobileDialogBox?.height || 0)).toBeLessThanOrEqual(844);
  expect(mobileProtractorBox?.x).toBeCloseTo(mobileRulerBox?.x || 0, 0);
  expect(mobileProtractorBox?.y || 0).toBeGreaterThan((mobileRulerBox?.y || 0) + (mobileRulerBox?.height || 0));
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  const closeMathTools = page.getByRole("button", { name: "Close math tools" });
  await page.keyboard.press("Tab");
  await expect(protractorButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeMathTools).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(extraToolsTrigger).toBeFocused();

  await extraToolsTrigger.click();
  await mathTools.click();
  await expect(dialog).toBeVisible();
  await expect(rulerButton).toBeFocused();
  await rulerButton.click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => autosavedMathToolSnapshot(page, "ruler")).toMatchObject({
    backgroundLocked: true,
    backgroundWidth: 612,
    fileMimeType: "image/svg+xml",
    height: 90,
    localSafeSvg: true,
    locked: false,
    measurementLabelFontSize: "12",
    metadata: {
      schemaVersion: 1,
      kind: "ruler",
      calibration: "pdf-points",
      naturalWidth: 864,
      naturalHeight: 90,
      sceneUnitsPerInch: 72,
      imperialLengthInches: 12,
      metricLengthCentimetres: 30,
    },
    pageWidth: 612,
    scaleCaptionFontSize: "12",
    width: 864,
  });
  const inserted = await autosavedMathToolSnapshot(page, "ruler");
  expect(inserted).not.toBeNull();
  expect((inserted?.width || 0) / (inserted?.pageWidth || 1)).toBeCloseTo(24 / 17, 10);

  await expect(page.locator(".editor-host .excalidraw")).toBeFocused();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => {
    const moved = await autosavedMathToolSnapshot(page, "ruler");
    return Boolean(
      moved
      && moved.id === inserted?.id
      && moved.x > (inserted?.x || 0)
      && moved.y > (inserted?.y || 0)
      && moved.width === 864
      && moved.height === 90,
    );
  }).toBe(true);
  const moved = await autosavedMathToolSnapshot(page, "ruler");

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect.poll(() => autosavedMathToolSnapshot(page, "ruler")).toMatchObject({
    id: moved?.id,
    sceneId: moved?.sceneId,
    width: 864,
    height: 90,
    x: moved?.x,
    y: moved?.y,
    localSafeSvg: true,
    measurementLabelFontSize: "12",
    scaleCaptionFontSize: "12",
  });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("uses the experimental one-shot lasso for live, additive, and cancellable selection", async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") {
      externalRequests.push(request.url());
    }
  });

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 300, y: 220 }, { x: 420, y: 320 });
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 650, y: 220 }, { x: 770, y: 320 });
  await expect.poll(() => autosavedRectanglePositions(page)).toHaveLength(2);
  const initial = await autosavedRectanglePositions(page);

  const openExtraTools = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await expect(page.locator(".App-toolbar__extra-tools-dropdown")).toBeVisible();
  };
  await openExtraTools();
  await expect(page.getByTestId("toolbar-lasso")).toHaveCount(0);
  await page.getByTestId("toolbar-math-tools").click();
  const experimentalToggle = page.getByRole("switch", { name: "Experimental features" });
  await experimentalToggle.check();
  await page.getByRole("button", { name: "Close math tools" }).click();

  await openExtraTools();
  const lasso = page.getByTestId("toolbar-lasso");
  await expect(lasso).toBeVisible();
  await lasso.click();
  const overlay = page.getByTestId("lasso-overlay");
  await expect(overlay).toBeVisible();
  const host = await page.locator(".editor-host").boundingBox();
  if (!host) throw new Error("Editor host has no visible bounds.");
  await page.mouse.move(host.x + 270, host.y + 190);
  await page.mouse.down();
  await page.mouse.move(host.x + 450, host.y + 190, { steps: 4 });
  await expect(overlay.locator("path")).not.toHaveAttribute("d", "");
  await page.mouse.move(host.x + 450, host.y + 350, { steps: 4 });
  await page.mouse.move(host.x + 270, host.y + 350, { steps: 4 });
  await page.mouse.up();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();

  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    return positions[0].x - initial[0].x;
  }).toBe(5);
  let moved = await autosavedRectanglePositions(page);
  expect(moved[1]).toMatchObject(initial[1]);

  await openExtraTools();
  await page.getByTestId("toolbar-lasso").click();
  await expect(page.getByTestId("lasso-overlay")).toHaveAttribute("data-initial-selection-count", "1");
  await page.mouse.click(host.x + 520, host.y + 500);
  await expect(page.getByTestId("lasso-overlay")).toHaveCount(0);
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    return positions[0].y - initial[0].y;
  }).toBe(5);

  moved = await autosavedRectanglePositions(page);
  await openExtraTools();
  await page.getByTestId("toolbar-lasso").click();
  await page.keyboard.down("Shift");
  await page.mouse.move(host.x + 620, host.y + 190);
  await page.mouse.down();
  await page.mouse.move(host.x + 800, host.y + 190, { steps: 4 });
  await page.mouse.move(host.x + 800, host.y + 350, { steps: 4 });
  await page.mouse.move(host.x + 620, host.y + 350, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    return positions.map((position, index) => position.y - moved[index].y);
  }).toEqual([5, 5]);

  await page.reload();
  await openExtraTools();
  await expect(page.getByTestId("toolbar-lasso")).toBeVisible();
  const beforeTouch = await autosavedRectanglePositions(page);
  await page.getByTestId("toolbar-lasso").click();
  await expect(page.getByTestId("lasso-overlay")).toBeVisible();
  const touchHost = await page.locator(".editor-host").boundingBox();
  if (!touchHost) throw new Error("Editor host has no visible bounds after reload.");
  await page.evaluate(({ left, top }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".editor-host canvas.interactive");
    if (!canvas) throw new Error("Interactive drawing canvas is unavailable.");
    const dispatch = (type: string, x: number, y: number, buttons: number) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: left + x,
      clientY: top + y,
      pointerId: 73,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons,
    }));
    dispatch("pointerdown", 270, 190, 1);
    dispatch("pointermove", 450, 190, 1);
    dispatch("pointermove", 450, 360, 1);
    dispatch("pointermove", 270, 360, 1);
    dispatch("pointerup", 270, 190, 0);
  }, { left: touchHost.x, top: touchHost.y });
  await expect(page.getByTestId("lasso-overlay")).toHaveCount(0);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    return positions.map((position, index) => position.x - beforeTouch[index].x);
  }).toEqual([5, 0]);

  const beforeEscape = await autosavedRectanglePositions(page);
  await openExtraTools();
  await page.getByTestId("toolbar-lasso").click();
  const escapeOverlay = page.getByTestId("lasso-overlay");
  await expect(escapeOverlay).toHaveAttribute("data-initial-selection-count", "1");
  await page.evaluate(({ left, top }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".editor-host canvas.interactive");
    if (!canvas) throw new Error("Interactive drawing canvas is unavailable.");
    for (const [type, x, y] of [["pointerdown", 600, 180], ["pointermove", 810, 180], ["pointermove", 810, 370]] as const) {
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: left + x,
        clientY: top + y,
        pointerId: 81,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
      }));
    }
  }, { left: touchHost.x, top: touchHost.y });
  await expect(escapeOverlay.locator("path")).not.toHaveAttribute("d", "");
  await page.keyboard.press("Escape");
  await expect(escapeOverlay).toHaveCount(0);
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    return positions.map((position, index) => position.y - beforeEscape[index].y);
  }).toEqual([5, 0]);

  await page.setViewportSize({ width: 390, height: 844 });
  await openExtraTools();
  const mobileLassoBox = await page.getByTestId("toolbar-lasso").boundingBox();
  expect(mobileLassoBox).not.toBeNull();
  expect((mobileLassoBox?.x || 0) + (mobileLassoBox?.width || 0)).toBeLessThanOrEqual(390);
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.setViewportSize({ width: 1440, height: 900 });

  await openTestPdf(page);
  await expect.poll(() => autosavedPdfBackgroundPosition(page)).toMatchObject({ locked: true });
  const pdfBackground = await autosavedPdfBackgroundPosition(page);
  if (!pdfBackground) throw new Error("The imported PDF background was not autosaved.");
  await openExtraTools();
  await page.getByTestId("toolbar-lasso").click();
  const pdfHost = await page.locator(".editor-host").boundingBox();
  if (!pdfHost) throw new Error("PDF editor host has no visible bounds.");
  await page.mouse.move(pdfHost.x + 40, pdfHost.y + 100);
  await page.mouse.down();
  await page.mouse.move(pdfHost.x + pdfHost.width - 40, pdfHost.y + 100, { steps: 4 });
  await page.mouse.move(pdfHost.x + pdfHost.width - 40, pdfHost.y + pdfHost.height - 100, { steps: 4 });
  await page.mouse.move(pdfHost.x + 40, pdfHost.y + pdfHost.height - 100, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => autosavedPdfBackgroundPosition(page)).toEqual(pdfBackground);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("inserts and persists a Letter-calibrated protractor from Math tools", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") {
      externalRequests.push(request.url());
    }
  });

  await openTestPdf(page);
  const extraToolsTrigger = page.locator(".App-toolbar__extra-tools-trigger");
  await extraToolsTrigger.click();
  await page.getByTestId("toolbar-math-tools").click();
  const dialog = page.getByRole("dialog", { name: "Math tools", exact: true });
  const protractorButton = page.getByTestId("math-tool-protractor");
  await expect(dialog).toBeVisible();
  await expect(protractorButton).toBeVisible();
  await protractorButton.click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => autosavedMathToolSnapshot(page, "protractor")).toMatchObject({
    backgroundLocked: true,
    backgroundWidth: 612,
    captionFontSize: "14",
    degreeLabelFontSize: "14",
    fileMimeType: "image/svg+xml",
    height: 216,
    localSafeSvg: true,
    locked: false,
    metadata: {
      schemaVersion: 1,
      kind: "protractor",
      calibration: "pdf-points",
      naturalWidth: 432,
      naturalHeight: 216,
      sceneUnitsPerInch: 72,
      diameterInches: 6,
      angleRangeDegrees: 180,
      smallestDivisionDegrees: 1,
      dualScale: true,
    },
    pageWidth: 612,
    width: 432,
  });
  const inserted = await autosavedMathToolSnapshot(page, "protractor");
  expect(inserted).not.toBeNull();
  expect((inserted?.width || 0) / (inserted?.pageWidth || 1)).toBeCloseTo(12 / 17, 10);

  await expect(page.locator(".editor-host .excalidraw")).toBeFocused();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => {
    const moved = await autosavedMathToolSnapshot(page, "protractor");
    return Boolean(
      moved
      && moved.id === inserted?.id
      && moved.x > (inserted?.x || 0)
      && moved.y > (inserted?.y || 0)
      && moved.width === 432
      && moved.height === 216,
    );
  }).toBe(true);
  const moved = await autosavedMathToolSnapshot(page, "protractor");

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect.poll(() => autosavedMathToolSnapshot(page, "protractor")).toMatchObject({
    captionFontSize: "14",
    degreeLabelFontSize: "14",
    id: moved?.id,
    sceneId: moved?.sceneId,
    width: 432,
    height: 216,
    x: moved?.x,
    y: moved?.y,
    localSafeSvg: true,
  });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("configures, inserts, and persists the static advanced math-tool release", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });

  const openMathTools = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
    await expect(page.getByRole("dialog", { name: "Math tools", exact: true })).toBeVisible();
  };

  await openMathTools();
  const dialog = page.getByRole("dialog", { name: "Math tools", exact: true });
  const experimentalToggle = page.getByRole("switch", { name: "Experimental features" });
  await expect(experimentalToggle).not.toBeChecked();
  await expect(page.getByTestId("math-tool-ruler")).toBeVisible();
  await expect(page.getByTestId("math-tool-protractor")).toBeVisible();
  await expect(page.getByTestId("math-tool-set-square")).toHaveCount(0);
  await expect(page.getByTestId("math-tool-graphs-tab")).toHaveCount(0);
  await experimentalToggle.check();
  await expect(page.getByTestId("math-tool-set-square")).toBeVisible();
  await page.getByRole("button", { name: "Close math tools" }).click();
  await openMathTools();
  await expect(experimentalToggle).toBeChecked();
  await expect(page.getByTestId("math-tool-instruments-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("math-tool-graphs-tab")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("math-tool-manipulatives-tab")).toHaveAttribute("aria-selected", "false");
  await page.getByTestId("math-tool-instruments-tab").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("math-tool-graphs-tab")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("math-tool-manipulatives-tab")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("math-tool-instruments-tab")).toHaveAttribute("aria-selected", "true");
  await experimentalToggle.uncheck();
  await expect(page.getByTestId("math-tool-set-square")).toHaveCount(0);
  await expect(page.getByTestId("math-tool-graphs-tab")).toHaveCount(0);
  await experimentalToggle.check();
  await page.getByTestId("math-tool-set-square").click();
  const setSquareForm = page.getByTestId("math-tool-config-set-square");
  await expect(setSquareForm).toBeVisible();
  await setSquareForm.getByLabel("Triangle").selectOption("30-60-90");
  await expect(setSquareForm.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  await setSquareForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "set-square")).toMatchObject({
    fileMimeType: "image/svg+xml",
    localSafeSvg: true,
    metadata: { kind: "set-square", category: "instruments", variant: "30-60-90", calibration: "pdf-points", sceneUnitsPerInch: 72 },
  });

  await openMathTools();
  await page.getByTestId("math-tool-geometry-stencil").click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "geometry-stencil")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "geometry-stencil", category: "instruments", stencilVersion: 1, calibration: "pdf-points" },
  });

  await openMathTools();
  await page.getByTestId("math-tool-graphs-tab").click();
  await expect(page.getByTestId("math-tool-graphs-tab")).toHaveAttribute("aria-selected", "true");
  for (const id of ["cartesian-plane", "number-line", "unit-circle", "function-plotter", "grid", "transformation-tool"]) {
    await expect(page.getByTestId(`math-tool-${id}`).locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  }
  await page.getByTestId("math-tool-cartesian-plane").click();
  const planeForm = page.getByTestId("math-tool-config-cartesian-plane");
  await planeForm.getByLabel("x maximum").fill("-10");
  await expect(planeForm.getByRole("alert")).toContainText("minimum must be less");
  await expect(planeForm.getByRole("button", { name: "Insert", exact: true })).toBeDisabled();
  await planeForm.getByLabel("x maximum").fill("6");
  await planeForm.getByLabel("x minimum").fill("0");
  await planeForm.getByLabel("y minimum").fill("0");
  await planeForm.getByLabel("y maximum").fill("8");
  await planeForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "cartesian-plane")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "cartesian-plane", category: "graphs", xMin: 0, xMax: 6, yMin: 0, yMax: 8, showQuadrantLabels: true, calibration: "logical-units" },
  });

  await openMathTools();
  await page.getByTestId("math-tool-graphs-tab").click();
  await page.getByTestId("math-tool-number-line").click();
  const numberLineForm = page.getByTestId("math-tool-config-number-line");
  await numberLineForm.getByLabel("Minimum").fill("-2");
  await numberLineForm.getByLabel("Maximum").fill("2");
  await numberLineForm.getByLabel("Major step").fill("0.5");
  await numberLineForm.getByLabel("Label format").selectOption("fraction");
  await numberLineForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "number-line")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "number-line", category: "graphs", minimum: -2, maximum: 2, majorStep: 0.5, labelFormat: "fraction" },
  });

  await openMathTools();
  await page.getByTestId("math-tool-graphs-tab").click();
  await page.getByTestId("math-tool-unit-circle").click();
  const unitCircleForm = page.getByTestId("math-tool-config-unit-circle");
  await unitCircleForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "unit-circle")).toMatchObject({
    localSafeSvg: true,
    mathJaxAngleLabelCount: 16,
    mathJaxCoordinateLabelCount: 16,
    metadata: { kind: "unit-circle", category: "graphs", labelMode: "both", showCoordinates: true },
  });
  expect((await autosavedMathToolSnapshot(page, "unit-circle"))?.mathJaxPathCount).toBeGreaterThan(0);

  await openMathTools();
  await page.getByTestId("math-tool-graphs-tab").click();
  await page.getByTestId("math-tool-function-plotter").click();
  const functionForm = page.getByTestId("math-tool-config-function-plot");
  await functionForm.getByLabel("Function y =").fill("window.alert(1)");
  await expect(functionForm.getByRole("alert")).toContainText("Assignments");
  await expect(functionForm.getByRole("button", { name: "Insert", exact: true })).toBeDisabled();
  await functionForm.getByLabel("Function y =").fill("sin(x) + x/4");
  await functionForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "function-plot")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "function-plot", category: "graphs", expression: "sin(x)+x/4", parserVersion: 1, sampleCount: 401 },
  });
  const originalFunctionPlot = await autosavedMathToolSnapshot(page, "function-plot");

  await openMathTools();
  const functionEditForm = page.getByTestId("math-tool-config-function-plot");
  await expect(functionEditForm.getByLabel("Function y =")).toHaveValue("sin(x)+x/4");
  await functionEditForm.getByLabel("Function y =").fill("cos(x)");
  await functionEditForm.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "function-plot")).toMatchObject({
    id: originalFunctionPlot?.id,
    localSafeSvg: true,
    metadata: { kind: "function-plot", expression: "cos(x)", parserVersion: 1, sampleCount: 401 },
  });

  await openMathTools();
  await page.getByRole("button", { name: "All tools", exact: false }).click();
  await page.getByTestId("math-tool-graphs-tab").click();
  await page.getByTestId("math-tool-grid").click();
  const gridForm = page.getByTestId("math-tool-config-grid");
  await gridForm.getByLabel("Grid type").selectOption("polar");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDialogBox = await dialog.boundingBox();
  expect(mobileDialogBox).not.toBeNull();
  expect((mobileDialogBox?.x || 0) + (mobileDialogBox?.width || 0)).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await gridForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "grid")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "grid", category: "graphs", variant: "polar", rings: 8, rays: 24 },
  });

  await page.reload();
  for (const kind of ["set-square", "geometry-stencil", "cartesian-plane", "number-line", "unit-circle", "function-plot", "grid"] as const) {
    await expect.poll(() => autosavedMathToolSnapshot(page, kind)).not.toBeNull();
  }

  const saveDownload = page.waitForEvent("download");
  await page.getByTitle("Download a complete classroom project").click();
  const savedProjectStream = await (await saveDownload).createReadStream();
  const savedProjectChunks: Buffer[] = [];
  for await (const chunk of savedProjectStream) savedProjectChunks.push(Buffer.from(chunk));
  const savedProject = Buffer.concat(savedProjectChunks);
  expect(savedProject.byteLength).toBeGreaterThan(1_000);

  await page.reload();
  await page.locator('input[type="file"]').setInputFiles({
    name: "advanced-static-math-tools.canvasclassroom",
    mimeType: "application/vnd.canvas-classroom+zip",
    buffer: savedProject,
  });
  for (const kind of ["set-square", "geometry-stencil", "cartesian-plane", "number-line", "unit-circle", "function-plot", "grid"] as const) {
    await expect.poll(() => autosavedMathToolSnapshot(page, kind)).not.toBeNull();
  }

  const boardDownload = page.waitForEvent("download");
  await page.locator(".export-split > button").first().click();
  const boardExport = await boardDownload;
  expect(boardExport.suggestedFilename()).toMatch(/full-board\.png$/);
  const boardStream = await boardExport.createReadStream();
  const boardChunks: Buffer[] = [];
  for await (const chunk of boardStream) boardChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(boardChunks).byteLength).toBeGreaterThan(1_000);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("batch-inserts independent fraction, algebra, integer, and probability manipulatives", async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });

  const openManipulatives = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
    await enableExperimentalMathTools(page);
    await page.getByTestId("math-tool-manipulatives-tab").click();
  };

  await openManipulatives();
  for (const id of ["fraction-kit", "algebra-tiles", "integer-chips", "probability-kit"]) {
    await expect(page.getByTestId(`math-tool-${id}`).locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
  }
  await page.getByTestId("math-tool-fraction-kit").click();
  const fractionForm = page.getByTestId("math-tool-config-fraction-piece");
  await fractionForm.getByLabel("Representation").selectOption("circle");
  await fractionForm.getByLabel("Maximum denominator").fill("4");
  await fractionForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSetSnapshot(page, "fraction-piece")).toMatchObject({
    count: 10,
    independent: true,
    localSafe: true,
    pieceIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  });
  expect((await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.setIds).toHaveLength(1);

  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.count || 0).toBe(0);
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.count || 0).toBe(10);

  const beforeIndividualEdit = await autosavedMathToolSetSnapshot(page, "fraction-piece");
  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("Escape");
  const editorBox = await page.locator(".editor-host").boundingBox();
  if (!editorBox) throw new Error("Editor host has no visible bounds.");
  await page.mouse.click(
    editorBox.x + editorBox.width / 2 - (3 * 122 + 108) / 2 + 54,
    editorBox.y + editorBox.height / 2 - (2 * 122 + 108) / 2 + 54,
  );
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => {
    const after = await autosavedMathToolSetSnapshot(page, "fraction-piece");
    return after?.positions.filter((position, index) => position.x !== beforeIndividualEdit?.positions[index]?.x || position.y !== beforeIndividualEdit?.positions[index]?.y).length || 0;
  }).toBe(1);
  await page.keyboard.press("Meta+Shift+l");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.lockedCount || 0).toBe(1);
  await page.keyboard.press("Meta+Shift+l");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.lockedCount || 0).toBe(0);

  await openManipulatives();
  await page.getByTestId("math-tool-algebra-tiles").click();
  const algebraForm = page.getByTestId("math-tool-config-algebra-tile");
  await algebraForm.getByLabel("Positive units").fill("2");
  await algebraForm.getByLabel("Negative units").fill("1");
  await algebraForm.getByLabel("Positive x tiles").fill("1");
  await algebraForm.getByLabel("Negative x tiles").fill("1");
  await algebraForm.getByLabel("Positive x² tiles").fill("1");
  await algebraForm.getByLabel("Negative x² tiles").fill("0");
  await algebraForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSetSnapshot(page, "algebra-tile")).toMatchObject({ count: 6, independent: true, localSafe: true });

  await openManipulatives();
  await page.getByTestId("math-tool-integer-chips").click();
  const chipForm = page.getByTestId("math-tool-config-integer-chip");
  await chipForm.getByLabel("Positive chips").fill("4");
  await chipForm.getByLabel("Negative chips").fill("3");
  await chipForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSetSnapshot(page, "integer-chip")).toMatchObject({ count: 7, independent: true, localSafe: true });

  await openManipulatives();
  await page.getByTestId("math-tool-probability-kit").click();
  const probabilityForm = page.getByTestId("math-tool-config-probability-piece");
  await probabilityForm.getByLabel("Cards 1–10").check();
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole("dialog", { name: "Math tools", exact: true });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await probabilityForm.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSetSnapshot(page, "probability-piece")).toMatchObject({ count: 19, independent: true, localSafe: true });

  await page.reload();
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.count || 0).toBe(10);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "algebra-tile"))?.count || 0).toBe(6);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "integer-chip"))?.count || 0).toBe(7);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.count || 0).toBe(19);

  const saveDownload = page.waitForEvent("download");
  await page.getByTitle("Download a complete classroom project").click();
  const savedProjectStream = await (await saveDownload).createReadStream();
  const savedProjectChunks: Buffer[] = [];
  for await (const chunk of savedProjectStream) savedProjectChunks.push(Buffer.from(chunk));
  const savedProject = Buffer.concat(savedProjectChunks);
  expect(savedProject.byteLength).toBeGreaterThan(1_000);

  await page.reload();
  await page.locator('input[type="file"]').setInputFiles({
    name: "advanced-manipulatives.canvasclassroom",
    mimeType: "application/vnd.canvas-classroom+zip",
    buffer: savedProject,
  });
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.count || 0).toBe(10);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "algebra-tile"))?.count || 0).toBe(6);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "integer-chip"))?.count || 0).toBe(7);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.count || 0).toBe(19);

  const boardDownload = page.waitForEvent("download");
  await page.locator(".export-split > button").first().click();
  const boardExport = await boardDownload;
  expect(boardExport.suggestedFilename()).toMatch(/full-board\.png$/);
  const boardStream = await boardExport.createReadStream();
  const boardChunks: Buffer[] = [];
  for await (const chunk of boardStream) boardChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(boardChunks).byteLength).toBeGreaterThan(1_000);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("rolls selected dice and flips selected coins locally in one undoable update", async ({ page }) => {
  test.setTimeout(75_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });

  const openProbabilityKit = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
    await enableExperimentalMathTools(page);
    await page.getByTestId("math-tool-manipulatives-tab").click();
    await page.getByTestId("math-tool-probability-kit").click();
    return page.getByTestId("math-tool-config-probability-piece");
  };

  let form = await openProbabilityKit();
  await form.getByLabel("Heads and tails").uncheck();
  await form.getByLabel("Eight-sector spinner").uncheck();
  await form.getByRole("button", { name: "Insert", exact: true }).click();

  const randomize = page.getByTestId("probability-randomize-selected");
  await expect(randomize).toHaveText(/Roll selected/);
  await expect(page.getByRole("toolbar", { name: "Selected probability pieces" })).toContainText("6 dice selected");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.count || 0).toBe(6);
  const beforeRoll = await autosavedMathToolSetSnapshot(page, "probability-piece");
  await randomize.click();
  await expect(page.getByText(/Rolled 6 dice:/)).toBeVisible();
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    return snapshot?.metadata.every((metadata) => metadata.componentType !== "die" || /^[1-6]$/.test(String(metadata.faceOrValue))) && snapshot.fileIds.every((fileId, index) => fileId !== beforeRoll?.fileIds[index]);
  }).toBe(true);
  const afterRoll = await autosavedMathToolSetSnapshot(page, "probability-piece");

  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds).toEqual(beforeRoll?.fileIds);
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds).toEqual(afterRoll?.fileIds);

  form = await openProbabilityKit();
  await form.getByLabel("Six die faces").uncheck();
  await form.getByLabel("Eight-sector spinner").uncheck();
  await form.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(randomize).toHaveText(/Flip selected/);
  await expect(page.getByRole("toolbar", { name: "Selected probability pieces" })).toContainText("2 coins selected");
  await randomize.click();
  await expect(page.getByText(/Flipped 2 coins:/)).toBeVisible();
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    return snapshot?.metadata.filter((metadata) => metadata.componentType === "coin").every((metadata) => ["Heads", "Tails"].includes(String(metadata.faceOrValue)));
  }).toBe(true);

  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("Meta+a");
  await expect(randomize).toHaveText(/Randomize selected/);
  await expect(page.getByRole("toolbar", { name: "Selected probability pieces" })).toContainText("6 dice and 2 coins selected");
  await page.setViewportSize({ width: 390, height: 844 });
  const toolbarBox = await page.getByRole("toolbar", { name: "Selected probability pieces" }).boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect((toolbarBox?.x || 0) + (toolbarBox?.width || 0)).toBeLessThanOrEqual(390);
  const beforeMixedRandomize = await autosavedMathToolSetSnapshot(page, "probability-piece");
  await randomize.click();
  await expect(page.getByText(/Randomized 6 dice and 2 coins:/)).toBeVisible();
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    return snapshot?.fileIds.every((fileId, index) => fileId !== beforeMixedRandomize?.fileIds[index]);
  }).toBe(true);

  await page.reload();
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    const diceValid = snapshot?.metadata.filter((metadata) => metadata.componentType === "die").every((metadata) => /^[1-6]$/.test(String(metadata.faceOrValue)));
    const coinsValid = snapshot?.metadata.filter((metadata) => metadata.componentType === "coin").every((metadata) => ["Heads", "Tails"].includes(String(metadata.faceOrValue)));
    return snapshot?.count === 8 && snapshot.localSafe && diceValid && coinsValid;
  }).toBe(true);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("animates a selected spinner and persists its numbered result", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });

  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-math-tools").click();
  await enableExperimentalMathTools(page);
  await page.getByTestId("math-tool-manipulatives-tab").click();
  await page.getByTestId("math-tool-probability-kit").click();
  const form = page.getByTestId("math-tool-config-probability-piece");
  await form.getByLabel("Six die faces").uncheck();
  await form.getByLabel("Heads and tails").uncheck();
  await form.getByRole("button", { name: "Insert", exact: true }).click();

  const toolbar = page.getByRole("toolbar", { name: "Selected probability pieces" });
  const spin = page.getByTestId("probability-randomize-selected");
  await expect(toolbar).toContainText("1 spinner selected");
  await expect(spin).toHaveText(/Spin selected/);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.count || 0).toBe(1);
  const beforeSpin = await autosavedMathToolSetSnapshot(page, "probability-piece");
  expect(beforeSpin?.metadata[0]).toMatchObject({ componentType: "spinner", faceOrValue: "1-8", spinnerSectorCount: 8 });

  await spin.click();
  await expect(spin).toBeDisabled();
  await expect(spin).toHaveText(/Spinning/);
  await expect(toolbar).toHaveAttribute("aria-busy", "true");
  const pointerOverlay = page.getByTestId("spinner-pointer-animation");
  const pointerLayer = pointerOverlay.locator(".spinner-pointer-overlay__pointer");
  await expect(pointerOverlay).toBeVisible();
  await expect(pointerOverlay.locator(".spinner-pointer-overlay__wheel")).toHaveCSS("transform", "none");
  const initialPointerTransform = await pointerLayer.evaluate((element) => getComputedStyle(element).transform);
  await page.waitForTimeout(250);
  await expect(spin).toBeDisabled();
  const movingPointerTransform = await pointerLayer.evaluate((element) => getComputedStyle(element).transform);
  expect(movingPointerTransform).not.toBe(initialPointerTransform);
  await expect(page.getByText(/Spun 1 spinner: [1-8]\./)).toBeVisible();
  await expect(pointerOverlay).toHaveCount(0);
  await expect(spin).toBeEnabled();
  await expect(spin).toHaveText(/Spin selected/);
  await expect(toolbar).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    return snapshot?.fileIds[0] !== beforeSpin?.fileIds[0]
      && /^[1-8]$/.test(String(snapshot?.metadata[0]?.faceOrValue))
      && snapshot.localSafe;
  }).toBe(true);
  const afterSpin = await autosavedMathToolSetSnapshot(page, "probability-piece");
  expect(afterSpin?.angles).toEqual(beforeSpin?.angles);

  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds).toEqual(beforeSpin?.fileIds);
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds).toEqual(afterSpin?.fileIds);

  await page.setViewportSize({ width: 390, height: 844 });
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect((toolbarBox?.x || 0) + (toolbarBox?.width || 0)).toBeLessThanOrEqual(390);
  await page.reload();
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    return snapshot?.count === 1
      && snapshot.localSafe
      && snapshot.fileIds[0] === afterSpin?.fileIds[0]
      && /^[1-8]$/.test(String(snapshot.metadata[0]?.faceOrValue));
  }).toBe(true);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("constructs compass arcs and measures angles in wrapper-owned board interaction mode", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });

  const openInstruments = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
    await enableExperimentalMathTools(page);
    await expect(page.getByTestId("math-tool-instruments-tab")).toHaveAttribute("aria-selected", "true");
  };
  const editor = page.locator(".editor-host");
  const bounds = await editor.boundingBox();
  if (!bounds) throw new Error("Editor host has no visible bounds.");

  await openInstruments();
  await page.getByTestId("math-tool-compass").click();
  const compass = page.getByTestId("math-interaction-compass");
  await expect(compass).toBeVisible();
  await page.mouse.click(bounds.x + 260, bounds.y + 300);
  await page.mouse.click(bounds.x + 380, bounds.y + 300);
  await expect(compass).toContainText("2 of 2 points selected");
  await compass.getByLabel("Full circle").uncheck();
  await compass.getByLabel("Arc extent").fill("120");
  await compass.getByLabel("Direction").selectOption("counterclockwise");
  await compass.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(compass).toBeHidden();
  await expect.poll(() => autosavedMathToolSnapshot(page, "compass")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "compass", category: "instruments", calibration: "scene-geometry", fullCircle: false, direction: "counterclockwise", centerMark: true },
  });
  const compassSnapshot = await autosavedMathToolSnapshot(page, "compass");
  expect(Number(compassSnapshot?.metadata.radiusSceneUnits)).toBeCloseTo(120, 0);
  expect(Number(compassSnapshot?.metadata.endAngleDegrees) - Number(compassSnapshot?.metadata.startAngleDegrees)).toBeCloseTo(-120, 6);

  await openInstruments();
  await page.getByTestId("math-tool-angle-measurer").click();
  const angle = page.getByTestId("math-interaction-angle-measurement");
  await page.mouse.click(bounds.x + 300, bounds.y + 360);
  await page.mouse.click(bounds.x + 420, bounds.y + 360);
  await page.mouse.click(bounds.x + 300, bounds.y + 240);
  await expect(angle).toContainText("3 of 3 points selected");
  await angle.getByLabel("Decimal places").selectOption("0");
  await angle.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolSnapshot(page, "angle-measurement")).toMatchObject({
    localSafeSvg: true,
    metadata: { kind: "angle-measurement", category: "instruments", measuredDegrees: 90, precision: 0, reflex: false, commitAnnotation: true },
  });

  await openInstruments();
  await page.getByTestId("math-tool-compass").click();
  await page.mouse.click(bounds.x + 480, bounds.y + 300);
  await page.mouse.click(bounds.x + 570, bounds.y + 300);
  await page.getByTestId("math-interaction-compass").getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedMathToolElementSummary(page, "compass")).toMatchObject({
    imageCount: 1,
    nativeEllipseCount: 2,
    parts: ["image", "construction", "center-mark"],
  });
  const beforeMove = await autosavedMathToolElementSummary(page, "compass");
  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await autosavedMathToolElementSummary(page, "compass"))?.nativeMinX || 0).toBeGreaterThan(beforeMove?.nativeMinX || 0);

  await openInstruments();
  await page.getByTestId("math-tool-compass").click();
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.getByTestId("math-interaction-compass")).toBeHidden();
  await page.getByRole("button", { name: "Board", exact: true }).click();

  await openInstruments();
  await page.getByTestId("math-tool-compass").click();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePanel = page.getByRole("dialog", { name: "Compass construction" });
  const panelBox = await mobilePanel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect((panelBox?.x || 0) + (panelBox?.width || 0)).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(mobilePanel).toBeHidden();

  await page.reload();
  await expect.poll(() => autosavedMathToolSnapshot(page, "compass")).not.toBeNull();
  await expect.poll(() => autosavedMathToolSnapshot(page, "angle-measurement")).not.toBeNull();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("constructs compass and angle annotations with touch input on mobile", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:5173", hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });
  await page.goto("/");
  await page.locator(".editor-host .excalidraw").waitFor({ state: "visible" });
  const editorBounds = await page.locator(".editor-host").boundingBox();
  if (!editorBounds) throw new Error("Editor host has no visible mobile bounds.");

  const openInstruments = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").tap();
    await page.getByTestId("toolbar-math-tools").tap();
    await enableExperimentalMathTools(page);
  };

  await openInstruments();
  await page.getByTestId("math-tool-compass").tap();
  await page.touchscreen.tap(editorBounds.x + 110, editorBounds.y + 480);
  await page.touchscreen.tap(editorBounds.x + 180, editorBounds.y + 480);
  await page.getByTestId("math-interaction-compass").getByRole("button", { name: "Insert", exact: true }).tap();
  await expect.poll(() => autosavedMathToolElementSummary(page, "compass")).toMatchObject({ nativeEllipseCount: 2 });

  await openInstruments();
  await page.getByTestId("math-tool-angle-measurer").tap();
  await page.touchscreen.tap(editorBounds.x + 120, editorBounds.y + 520);
  await page.touchscreen.tap(editorBounds.x + 200, editorBounds.y + 520);
  await page.touchscreen.tap(editorBounds.x + 120, editorBounds.y + 420);
  const anglePanel = page.getByTestId("math-interaction-angle-measurement");
  await expect(anglePanel).toContainText("3 of 3 points selected");
  await anglePanel.getByRole("button", { name: "Insert", exact: true }).tap();
  await expect.poll(() => autosavedMathToolSnapshot(page, "angle-measurement")).toMatchObject({ metadata: { measuredDegrees: 90, unit: "degrees" } });
  expect(externalRequests).toEqual([]);
  await context.close();
});

test("copies selected objects through every supported transformation", async ({ page }) => {
  test.setTimeout(75_000);
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") externalRequests.push(request.url());
  });

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 280, y: 220 }, { x: 400, y: 300 });

  const openTransformation = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
    await enableExperimentalMathTools(page);
    await page.getByTestId("math-tool-graphs-tab").click();
    await page.getByTestId("math-tool-transformation-tool").click();
    const panel = page.getByTestId("math-interaction-transformation");
    await expect(panel).toContainText("1 supported source object selected");
    return panel;
  };

  let panel = await openTransformation();
  await panel.getByLabel("Horizontal change").fill("150");
  await panel.getByLabel("Vertical change").fill("40");
  await panel.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedTransformationSnapshot(page)).toMatchObject({ count: 1, rectangleCount: 2, finiteGeometry: true, originalSourcesRemain: true, transformationTypes: ["translate"] });

  panel = await openTransformation();
  await panel.getByRole("combobox", { name: "Transformation", exact: true }).selectOption("rotate");
  await panel.getByLabel("Angle in degrees").fill("90");
  await panel.getByRole("button", { name: "Insert", exact: true }).click();

  panel = await openTransformation();
  await panel.getByRole("combobox", { name: "Transformation", exact: true }).selectOption("reflect-vertical");
  await panel.getByRole("button", { name: "Insert", exact: true }).click();

  panel = await openTransformation();
  await panel.getByRole("combobox", { name: "Transformation", exact: true }).selectOption("reflect-horizontal");
  await panel.getByRole("button", { name: "Insert", exact: true }).click();

  panel = await openTransformation();
  await panel.getByRole("combobox", { name: "Transformation", exact: true }).selectOption("reflect-line");
  await panel.getByLabel("Mirror line angle").fill("30");
  await panel.getByRole("button", { name: "Insert", exact: true }).click();

  panel = await openTransformation();
  await panel.getByRole("combobox", { name: "Transformation", exact: true }).selectOption("dilate");
  await panel.getByLabel("Scale factor").fill("1.5");
  await panel.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => autosavedTransformationSnapshot(page)).toMatchObject({
    count: 6,
    rectangleCount: 7,
    finiteGeometry: true,
    originalSourcesRemain: true,
    transformationTypes: ["translate", "rotate", "reflect-vertical", "reflect-horizontal", "reflect-line", "dilate"],
  });

  panel = await openTransformation();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await autosavedTransformationSnapshot(page))?.count || 0).toBe(6);

  await page.reload();
  await expect.poll(() => autosavedTransformationSnapshot(page)).toMatchObject({ count: 6, rectangleCount: 7, finiteGeometry: true, originalSourcesRemain: true });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("navigates PDF pages with the left and right arrow keys", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await expect(page).toHaveTitle("Canvas Classroom");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await openTestPdf(page, 3);
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  const pageStatus = page.locator(".page-status");
  await expect(pages.nth(0)).toHaveClass(/is-selected/);
  await expect(pageStatus).toContainText("Page 1 of 3");

  await page.locator(".editor-host").click({ position: { x: 600, y: 400 } });
  await page.keyboard.press("ArrowRight");
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect(pageStatus).toContainText("Page 2 of 3");

  await page.keyboard.press("ArrowRight");
  await expect(pages.nth(2)).toHaveClass(/is-selected/);
  await expect(pageStatus).toContainText("Page 3 of 3");

  await page.keyboard.press("ArrowLeft");
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect(pageStatus).toContainText("Page 2 of 3");

  const resizeHandle = page.getByRole("separator", { name: "Resize PDF pages" });
  await resizeHandle.focus();
  await resizeHandle.press("ArrowRight");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "240");
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  expect(consoleErrors).toEqual([]);
});

test("opens the official image export dialog with native controls and export semantics", async ({ page }) => {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== "http://127.0.0.1:5173") {
      externalRequests.push(request.url());
    }
  });
  await useDownloadBasedImageExport(page);

  const moreExports = page.getByRole("button", { name: "More export options", exact: true });
  await moreExports.click();
  const wrapperDialog = page.getByRole("dialog", { name: "More exports", exact: true });
  const imageExportEntry = wrapperDialog.getByRole("button", { name: /Export image…/ });
  await expect(imageExportEntry).toBeDisabled();

  const left = exportTestRectangle("left-object", 100, 120, 100, 80, "a0");
  const right = exportTestRectangle("right-object", 600, 120, 150, 100, "a1");
  await wrapperDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "native-image-export.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Native Image Export",
      elements: [left, right],
      appState: { selectedElementIds: { "left-object": true } },
      files: {},
    })),
  });

  await moreExports.click();
  await expect(wrapperDialog.getByRole("button").first()).toContainText("Export image…");
  await wrapperDialog.getByRole("button", { name: /Export image…/ }).click();
  await expect(wrapperDialog).toHaveCount(0);

  const nativeDialog = page.locator(".Modal").filter({ has: page.locator(".ImageExportModal") });
  await expect(nativeDialog).toBeVisible();
  await expect(nativeDialog.getByRole("heading", { name: "Export image", exact: true }).last()).toBeVisible();
  const selectedOnly = nativeDialog.getByLabel("Only selected", { exact: true });
  const background = nativeDialog.getByLabel("Background", { exact: true });
  const darkMode = nativeDialog.getByLabel("Dark mode", { exact: true });
  const embedScene = nativeDialog.getByLabel("Embed scene", { exact: true });
  await expect(selectedOnly).toBeChecked();
  await expect(background).toBeVisible();
  await expect(darkMode).toBeVisible();
  await expect(embedScene).toBeVisible();
  const exportScales = nativeDialog.locator('input[name="exportScale"]');
  await expect(exportScales).toHaveCount(3);
  await expect(exportScales.first()).toBeChecked();
  await expect(nativeDialog.locator(".ImageExportModal__preview__filename input")).toHaveValue("Native Image Export");
  await expect(nativeDialog.getByRole("button", { name: "Export to PNG", exact: true })).toBeVisible();
  await expect(nativeDialog.getByRole("button", { name: "Export to SVG", exact: true })).toBeVisible();

  const selectedPngDownload = page.waitForEvent("download");
  await nativeDialog.getByRole("button", { name: "Export to PNG", exact: true }).click();
  const selectedPng = await selectedPngDownload;
  expect(selectedPng.suggestedFilename()).toBe("Native Image Export.png");
  expect(pngDimensions(await downloadBytes(selectedPng))).toEqual({ width: 120, height: 100 });

  const preview = nativeDialog.locator(".ImageExportModal__preview__canvas");
  await expect(preview.locator("canvas")).toBeVisible();
  await preview.evaluate((node) => {
    const target = node as HTMLElement;
    target.dataset.renderCount = "0";
    new MutationObserver(() => {
      target.dataset.renderCount = String(Number(target.dataset.renderCount || 0) + 1);
    }).observe(target, { childList: true });
  });
  const expectPreviewRefresh = async (control: import("@playwright/test").Locator) => {
    const before = Number(await preview.getAttribute("data-render-count") || 0);
    await control.click();
    await expect.poll(async () => Number(await preview.getAttribute("data-render-count") || 0)).toBeGreaterThan(before);
  };
  await expectPreviewRefresh(selectedOnly);
  await expect(selectedOnly).not.toBeChecked();
  await expectPreviewRefresh(background);
  await expectPreviewRefresh(darkMode);
  await expectPreviewRefresh(embedScene);
  await expect(embedScene).toBeChecked();
  await expectPreviewRefresh(exportScales.nth(1));

  const wholePngDownload = page.waitForEvent("download");
  await nativeDialog.getByRole("button", { name: "Export to PNG", exact: true }).click();
  const wholePng = await wholePngDownload;
  expect(wholePng.suggestedFilename()).toBe("Native Image Export.excalidraw.png");
  expect(pngDimensions(await downloadBytes(wholePng))).toEqual({ width: 1_340, height: 240 });

  const svgDownloadEvent = page.waitForEvent("download");
  await nativeDialog.getByRole("button", { name: "Export to SVG", exact: true }).click();
  const svgDownload = await svgDownloadEvent;
  expect(svgDownload.suggestedFilename()).toBe("Native Image Export.excalidraw.svg");
  const svg = (await downloadBytes(svgDownload)).toString("utf8");
  expect(svg).toContain('width="1340"');
  expect(svg).toContain('height="240"');
  expect(svg).toContain("payload-type:application/vnd.excalidraw+json");

  const clipboard = nativeDialog.getByRole("button", { name: "Copy PNG to clipboard", exact: true });
  if (await clipboard.isVisible()) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5173" });
    await clipboard.click();
    await expect(clipboard).toHaveClass(/ExcButton--status-success/);
  }

  await nativeDialog.locator(".Modal__content").focus();
  await page.keyboard.press("Escape");
  await expect(nativeDialog).toHaveCount(0);
  await expect(moreExports).toBeFocused();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("uses native frame export behavior for a selected slide frame", async ({ page }) => {
  await useDownloadBasedImageExport(page);
  const frame = {
    ...exportTestRectangle("export-frame", 100, 100, 300, 200, "a1"),
    type: "frame",
    backgroundColor: "transparent",
    frameId: null,
    name: "Export frame",
  };
  const inside = exportTestRectangle("inside-frame", 150, 140, 100, 80, "a0", "export-frame");
  const outside = exportTestRectangle("outside-frame", 700, 100, 200, 150, "a2");
  await page.locator('input[type="file"]').setInputFiles({
    name: "selected-frame-export.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Selected Frame Export",
      elements: [inside, frame, outside],
      appState: { selectedElementIds: { "export-frame": true } },
      files: {},
    })),
  });

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("button", { name: /Export image…/ }).click();
  const nativeDialog = page.locator(".ImageExportModal");
  await expect(nativeDialog.getByLabel("Only selected", { exact: true })).toBeChecked();
  const pngDownloadEvent = page.waitForEvent("download");
  await nativeDialog.getByRole("button", { name: "Export to PNG", exact: true }).click();
  expect(pngDimensions(await downloadBytes(await pngDownloadEvent))).toEqual({ width: 300, height: 200 });
});

test("exports a locked PDF background with annotations and fits the native dialog on mobile", async ({ page }) => {
  test.setTimeout(60_000);
  await useDownloadBasedImageExport(page);
  await openTestPdf(page);
  await expect.poll(() => autosavedPdfBackgroundPosition(page)).toMatchObject({ locked: true });
  await page.getByTestId("toolbar-freedraw").check({ force: true });
  await dragOnBoard(page, { x: 470, y: 260 }, { x: 610, y: 350 });
  await page.getByTestId("toolbar-selection").check({ force: true });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("button", { name: /Export image…/ }).click();
  const nativeDialog = page.locator(".Modal").filter({ has: page.locator(".ImageExportModal") });
  await expect(nativeDialog).toBeVisible();
  const bounds = await nativeDialog.locator(".Modal__content").boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(390);
  expect((bounds?.y || 0) + (bounds?.height || 0)).toBeLessThanOrEqual(844);
  expect(await nativeDialog.locator(".Modal__content").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(nativeDialog.locator(".ImageExportModal__preview__canvas canvas")).toBeVisible();

  const pngDownloadEvent = page.waitForEvent("download");
  await nativeDialog.getByRole("button", { name: "Export to PNG", exact: true }).click();
  const png = await pngDownloadEvent;
  expect(png.suggestedFilename()).toBe("Untitled classroom canvas.png");
  const bytes = await downloadBytes(png);
  expect(pngDimensions(bytes)).toEqual({ width: 632, height: 812 });
  expect(bytes.byteLength).toBeGreaterThan(2_000);
});

test("adds a blank PDF page, preserves it in the project, and exports it", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page);

  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(1);
  const addPage = page.getByRole("button", { name: "Add page", exact: true });
  const railBounds = await page.locator("#pdf-page-rail").boundingBox();
  const addPageBounds = await addPage.boundingBox();
  expect(railBounds).not.toBeNull();
  expect(addPageBounds).not.toBeNull();
  expect((railBounds?.y || 0) + (railBounds?.height || 0) - ((addPageBounds?.y || 0) + (addPageBounds?.height || 0)))
    .toBeLessThanOrEqual(16);
  await addPage.click();
  await expect(pages).toHaveCount(2);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toHaveClass(/is-selected/);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toContainText("Blank page");
  await expect(page.locator(".page-status")).toContainText("Page 2 of 2");

  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedProject = await (await saveDownload).createReadStream();
  const savedChunks: Buffer[] = [];
  for await (const chunk of savedProject) savedChunks.push(Buffer.from(chunk));
  const savedBytes = Buffer.concat(savedChunks);

  await page.reload();
  await page.locator('input[type="file"]').setInputFiles({
    name: "blank-page-roundtrip.canvasclassroom",
    mimeType: "application/vnd.canvas-classroom+zip",
    buffer: savedBytes,
  });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toContainText("Blank page");

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exportedPdf = await (await pdfDownload).createReadStream();
  const pdfChunks: Buffer[] = [];
  for await (const chunk of exportedPdf) pdfChunks.push(Buffer.from(chunk));
  const exported = await PDFDocument.load(Buffer.concat(pdfChunks));
  expect(exported.getPageCount()).toBe(2);
});

test("deletes the selected PDF page without renumbering its source page", async ({ page }) => {
  test.setTimeout(60_000);
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  document.addPage([612, 792]);
  const bytes = await document.save();
  await page.locator('input[type="file"]').setInputFiles({
    name: "delete-pages.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });

  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(2, { timeout: 15_000 });
  await expect(pages.first()).toHaveClass(/is-selected/);
  const pageDelete = pages.first().getByRole("button", { name: "Delete selected page", exact: true });
  await expect(pageDelete).toBeVisible();
  await expect(pageDelete).toHaveText("");
  await expect(pageDelete.locator("svg")).toHaveCount(1);
  await expect(pages.nth(1).getByRole("button", { name: "Delete selected page", exact: true })).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete output page 1?");
    await dialog.accept();
  });
  await pageDelete.click();

  await expect(pages).toHaveCount(1);
  await expect(pages.first()).toHaveClass(/is-selected/);
  await expect(pages.first()).toContainText("Original page 2");
  await expect(page.locator(".page-status")).toContainText("Page 1 of 1");

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exportedPdf = await (await pdfDownload).createReadStream();
  const pdfChunks: Buffer[] = [];
  for await (const chunk of exportedPdf) pdfChunks.push(Buffer.from(chunk));
  const exported = await PDFDocument.load(Buffer.concat(pdfChunks));
  expect(exported.getPageCount()).toBe(1);

  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedProject = await (await saveDownload).createReadStream();
  const savedChunks: Buffer[] = [];
  for await (const chunk of savedProject) savedChunks.push(Buffer.from(chunk));
  const savedBytes = Buffer.concat(savedChunks);

  await page.reload();
  await page.locator('input[type="file"]').setInputFiles({
    name: "deleted-page-roundtrip.canvasclassroom",
    mimeType: "application/vnd.canvas-classroom+zip",
    buffer: savedBytes,
  });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(pages).toHaveCount(1, { timeout: 15_000 });
  await expect(pages.first()).toContainText("Original page 2");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete output page 1?");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Delete selected page", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator("#pdf-page-rail")).toHaveCount(0);
});

test("adds a blank slide with a live preview without remounting or covering the editor", async ({ page }) => {
  const editor = page.locator(".editor-host .excalidraw");
  await editor.evaluate((node) => node.setAttribute("data-browser-instance", "original"));

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-slide-mode/);
  const addSlide = page.getByRole("button", { name: "Add slide", exact: true });
  const drawAroundContent = page.getByRole("button", { name: "Draw around content", exact: true });
  await expect(addSlide).toBeVisible();
  await expect(drawAroundContent).toBeVisible();

  const railBounds = await page.locator("#slide-rail").boundingBox();
  const editorBounds = await page.locator(".editor-region").boundingBox();
  expect(railBounds).not.toBeNull();
  expect(editorBounds).not.toBeNull();
  expect((railBounds?.x || 0) + (railBounds?.width || 0)).toBeLessThanOrEqual(editorBounds?.x || 0);

  await addSlide.click();
  const slideCards = page.locator("#slide-rail .slide-thumbnail");
  await expect(slideCards).toHaveCount(1);
  const activeSlide = slideCards.first();
  await expect(activeSlide).toHaveAttribute("aria-current", "page");
  await expect(drawAroundContent).toBeVisible();

  const preview = activeSlide.locator(".slide-preview img");
  await expectLoadedPreview(preview);
  const blankPreviewSource = await preview.getAttribute("src");
  expect(blankPreviewSource).toBeTruthy();

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragNearBoardCenter(page);
  await expect.poll(
    () => preview.evaluate(
      (image: HTMLImageElement, previousSource) =>
        image.complete
        && image.naturalWidth > 0
        && image.getAttribute("src") !== previousSource,
      blankPreviewSource,
    ),
    { timeout: 10_000, message: "Expected the slide preview to update after drawing in its frame." },
  ).toBe(true);
  await expectLoadedPreview(preview);

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator("#slide-rail")).toHaveCount(0);
  await expect(editor).toHaveAttribute("data-browser-instance", "original");

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  await expect(editor).toHaveAttribute("data-browser-instance", "original");

  await page.getByRole("button", { name: "Present", exact: true }).click();
  const inkColours = page.locator(".presentation-colour-swatch");
  await expect(inkColours).toHaveCount(6);
  await expect(page.getByRole("group", { name: "Ink colours" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Ink widths" })).toBeVisible();
  await expect(page.locator(".presentation-width-button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Regular ink width", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Blue ink", exact: true }).focus();
  await page.getByRole("button", { name: "Blue ink", exact: true }).press("Space");
  await expect(page.getByRole("button", { name: "Blue ink", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Ink", exact: true })).toHaveClass(/is-active/);
  await page.getByRole("button", { name: "Purple ink", exact: true }).click();
  await expect(page.getByRole("button", { name: "Blue ink", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Purple ink", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Extra fine ink width", exact: true }).click();
  await expect(page.getByRole("button", { name: "Extra fine ink width", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dragOnBoard(page, { x: 420, y: 260 }, { x: 620, y: 360 });
  await expect.poll(async () => (await autosavedFreedrawStroke(page))?.strokeColor, { timeout: 5_000 }).toBe("#7048e8");
  const extraFineStroke = await autosavedFreedrawStroke(page);
  const extraFineZoom = Number(await page.locator(".editor-region").getAttribute("data-presentation-zoom")) / 100;
  expect(extraFineStroke?.strokeWidth).not.toBeNull();
  expect((extraFineStroke?.strokeWidth || 0) * extraFineZoom).toBeCloseTo(1, 1);
  await page.getByRole("button", { name: "Fine ink width", exact: true }).click();
  await dragOnBoard(page, { x: 450, y: 300 }, { x: 650, y: 400 });
  await expect.poll(async () => {
    const stroke = await autosavedFreedrawStroke(page);
    const currentZoom = Number(await page.locator(".editor-region").getAttribute("data-presentation-zoom")) / 100;
    return (stroke?.strokeWidth || 0) * currentZoom;
  }, { timeout: 5_000 }).toBeCloseTo(2, 1);
  if (await page.evaluate(() => Boolean(document.fullscreenElement))) {
    await page.evaluate(() => document.exitFullscreen());
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".presentation-controls")).toHaveCSS("flex-direction", "column");
  await expect(page.getByRole("group", { name: "Ink colours" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Ink widths" })).toBeVisible();
  await expect(page.locator(".App-top-bar")).toBeHidden();
  await expect(page.locator(".App-bottom-bar")).toBeHidden();
  await expect(page.locator(".mobile-misc-tools-container")).toBeHidden();
  await expect(page.locator(".HintViewer")).toBeHidden();
  await page.getByRole("button", { name: "Exit", exact: true }).click();
});
