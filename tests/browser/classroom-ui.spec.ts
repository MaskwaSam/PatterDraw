import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync, zlibSync } from "fflate";
import {
  degrees,
  PDFDocument,
  PDFName,
  PDFNumber,
  rgb,
  StandardFonts,
} from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfStandardFontDataUrl = decodeURIComponent(new URL(
  "./standard_fonts/",
  import.meta.resolve("pdfjs-dist/package.json"),
).pathname);

const DEVELOPMENT_EDITOR_MOUNT_TIMEOUT = 90_000;

interface RenderedPdfPage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  operators: number[];
  text: string;
}

async function renderPdfPage(
  bytes: Uint8Array,
  pageNumber = 1,
): Promise<RenderedPdfPage> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: pdfStandardFontDataUrl,
  });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1 });
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
      const operatorList = await page.getOperatorList();
      const textContent = await page.getTextContent();
      return {
        width,
        height,
        rgba: Uint8ClampedArray.from(context.getImageData(0, 0, width, height).data),
        operators: Array.from(operatorList.fnArray),
        text: textContent.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" "),
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

function matchingPixelBounds(
  page: RenderedPdfPage,
  matches: (red: number, green: number, blue: number) => boolean,
): readonly [number, number, number, number] | null {
  let minX = page.width;
  let minY = page.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < page.height; y += 1) {
    for (let x = 0; x < page.width; x += 1) {
      const offset = (y * page.width + x) * 4;
      if (!matches(page.rgba[offset], page.rgba[offset + 1], page.rgba[offset + 2])) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX, maxY];
}

function normalizedPixelBounds(
  page: RenderedPdfPage,
  bounds: readonly [number, number, number, number] | null,
): number[] {
  if (!bounds) return [];
  return [
    bounds[0] / page.width,
    bounds[1] / page.height,
    bounds[2] / page.width,
    bounds[3] / page.height,
  ];
}

function nonWhitePixelsAfter(page: RenderedPdfPage, minX: number): number {
  let count = 0;
  for (let y = 0; y < page.height; y += 1) {
    for (let x = Math.max(0, minX); x < page.width; x += 1) {
      const offset = (y * page.width + x) * 4;
      if (
        page.rgba[offset] < 245
        || page.rgba[offset + 1] < 245
        || page.rgba[offset + 2] < 245
      ) count += 1;
    }
  }
  return count;
}

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
  await page.getByLabel("Open project file").setInputFiles({
    name: "toolbar-position.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(pageCount, {
    timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT,
  });
  await expect.poll(
    () => autosavedPdfBackgroundPosition(page),
    { timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT },
  )
    .toMatchObject({ locked: true });
}

async function oversizedEmbeddedImagePdfBytes(painted = true): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const width = 4_097;
  const height = 4_097;
  // A valid one-bit image needs only about 2 MB before compression, while its
  // decoded pixel area crosses the 16-million-pixel PDF.js safety boundary.
  const samples = new Uint8Array(Math.ceil(width / 8) * height);
  const image = document.context.flateStream(samples, {
    Type: PDFName.of("XObject"),
    Subtype: PDFName.of("Image"),
    Width: width,
    Height: height,
    ColorSpace: PDFName.of("DeviceGray"),
    BitsPerComponent: 1,
  });
  const imageRef = document.context.register(image);
  if (painted) {
    const imageName = page.node.newXObject("Oversized", imageRef);
    const content = document.context.flateStream(new TextEncoder().encode(
      `q 612 0 0 792 0 0 cm ${imageName.asString()} Do Q`,
    ));
    page.node.addContentStream(document.context.register(content));
  }
  return document.save({ useObjectStreams: false });
}

async function oversizedInlineImagePdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const width = 4_097;
  const height = 4_097;
  const compressed = zlibSync(new Uint8Array(Math.ceil(width / 8) * height));
  const header = new TextEncoder().encode(
    `q 612 0 0 792 0 0 cm BI /W ${width} /H ${height} /CS /G /BPC 1 /F /Fl ID\n`,
  );
  const footer = new TextEncoder().encode("\nEI Q");
  const contentBytes = new Uint8Array(header.length + compressed.length + footer.length);
  contentBytes.set(header);
  contentBytes.set(compressed, header.length);
  contentBytes.set(footer, header.length + compressed.length);
  page.node.addContentStream(document.context.register(document.context.stream(contentBytes)));
  return document.save({ useObjectStreams: false });
}

async function colouredPdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (const colour of [rgb(1, 0, 0), rgb(0, 0, 1)]) {
    const page = document.addPage([612, 792]);
    page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: colour });
  }
  return document.save();
}

function oversizedPngDataUrl(width = 9_000, height = 1): string {
  // Raster safety inspects the PNG signature/IHDR dimensions before any
  // browser image decode, so a minimal header is sufficient for this probe.
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes, 8);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function deferAnimationFrames(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    type DeferredRafState = {
      callbacks: Map<number, FrameRequestCallback>;
      nextId: number;
      request: typeof window.requestAnimationFrame;
      cancel: typeof window.cancelAnimationFrame;
    };
    const host = window as Window & { __patterdrawDeferredRaf?: DeferredRafState };
    const state: DeferredRafState = {
      callbacks: new Map(),
      nextId: 1,
      request: window.requestAnimationFrame.bind(window),
      cancel: window.cancelAnimationFrame.bind(window),
    };
    host.__patterdrawDeferredRaf = state;
    window.requestAnimationFrame = (callback) => {
      const id = state.nextId++;
      state.callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      state.callbacks.delete(id);
    };
  });
}

async function releaseDeferredAnimationFrames(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    type DeferredRafState = {
      callbacks: Map<number, FrameRequestCallback>;
      request: typeof window.requestAnimationFrame;
      cancel: typeof window.cancelAnimationFrame;
    };
    const host = window as Window & { __patterdrawDeferredRaf?: DeferredRafState };
    const state = host.__patterdrawDeferredRaf;
    if (!state) return;
    window.requestAnimationFrame = state.request;
    window.cancelAnimationFrame = state.cancel;
    delete host.__patterdrawDeferredRaf;
    for (const callback of state.callbacks.values()) state.request(callback);
  });
}

async function pictureDarkModePdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const picture = createCanvas(80, 60);
  const pictureContext = picture.getContext("2d");
  pictureContext.fillStyle = "#ff00a8";
  pictureContext.fillRect(0, 0, picture.width, picture.height);
  pictureContext.fillStyle = "#00d86f";
  pictureContext.fillRect(8, 8, 18, 18);
  pictureContext.clearRect(52, 8, 18, 16);
  const embeddedPicture = await document.embedPng(picture.toBuffer("image/png"));
  const transparencyGroup = document.context.register(document.context.obj({
    S: PDFName.of("Transparency"),
    CS: PDFName.of("DeviceRGB"),
    I: true,
    K: false,
  }));

  for (let index = 0; index < 2; index += 1) {
    const page = document.addPage([320, 240]);
    page.node.set(PDFName.of("Group"), transparencyGroup);
    page.drawRectangle({ x: 20, y: 80, width: 120, height: 80, color: rgb(0, 0, 0) });
    page.drawText(`VECTOR ${index + 1}`, { x: 25, y: 190, size: 20, font, color: rgb(0, 0, 0) });
    // The underlay must remain vector-dark through the transparent picture
    // window, and the final rectangle must remain vector-dark above the photo.
    page.drawRectangle({ x: 200, y: 90, width: 80, height: 60, color: rgb(0, 0, 0) });
    page.drawImage(embeddedPicture, { x: 200, y: 90, width: 80, height: 60 });
    page.drawRectangle({ x: 250, y: 94, width: 18, height: 14, color: rgb(0, 0, 0) });
  }
  return document.save();
}

type PdfDisplaySamples = {
  background: [number, number, number];
  picture: [number, number, number];
  pictureAccent: [number, number, number];
  pictureTransparentVector: [number, number, number];
  pictureVectorOverlay: [number, number, number];
  vector: [number, number, number];
};

async function exportedPdfDisplaySamples(bytes: Buffer): Promise<PdfDisplaySamples | null> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] > 220 && pixels[offset + 1] < 55 && pixels[offset + 2] > 110) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  const pictureWidth = maxX - minX + 1;
  const pictureHeight = maxY - minY + 1;
  const pictureX = (minX + maxX) / 2;
  const pictureY = (minY + maxY) / 2;
  const sample = (x: number, y: number): [number, number, number] => {
    const offset = (
      Math.max(0, Math.min(canvas.height - 1, Math.round(y))) * canvas.width
      + Math.max(0, Math.min(canvas.width - 1, Math.round(x)))
    ) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };
  return {
    background: sample(pictureX, minY - pictureHeight * 0.55),
    picture: sample(pictureX, pictureY),
    pictureAccent: sample(minX + pictureWidth * 0.21, minY + pictureHeight * 0.28),
    pictureTransparentVector: sample(minX + pictureWidth * 0.76, minY + pictureHeight * 0.27),
    pictureVectorOverlay: sample(minX + pictureWidth * 0.76, minY + pictureHeight * 0.84),
    vector: sample(pictureX - pictureWidth * 2, pictureY),
  };
}

async function renderedPdfDisplaySamples(
  page: import("@playwright/test").Page,
): Promise<PdfDisplaySamples | null> {
  const screenshot = await page.locator(".editor-host").screenshot({ type: "png" });
  const imageUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  return page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (pixels[offset] > 160 && pixels[offset + 1] < 100 && pixels[offset + 2] > 110) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < 0 || maxY < 0) return null;
    const pictureWidth = maxX - minX + 1;
    const pictureHeight = maxY - minY + 1;
    const pictureX = (minX + maxX) / 2;
    const pictureY = (minY + maxY) / 2;
    const average = (x: number, y: number): [number, number, number] => {
      const centerX = Math.max(2, Math.min(canvas.width - 3, Math.round(x)));
      const centerY = Math.max(2, Math.min(canvas.height - 3, Math.round(y)));
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          const offset = ((centerY + offsetY) * canvas.width + centerX + offsetX) * 4;
          red += pixels[offset];
          green += pixels[offset + 1];
          blue += pixels[offset + 2];
          count += 1;
        }
      }
      return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)];
    };
    return {
      background: average(pictureX, minY - pictureHeight * 0.55),
      picture: average(pictureX, pictureY),
      pictureAccent: average(minX + pictureWidth * 0.21, minY + pictureHeight * 0.28),
      pictureTransparentVector: average(minX + pictureWidth * 0.76, minY + pictureHeight * 0.27),
      pictureVectorOverlay: average(minX + pictureWidth * 0.76, minY + pictureHeight * 0.84),
      vector: average(pictureX - pictureWidth * 2, pictureY),
    };
  }, imageUrl);
}

async function unusualPdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  page.setCropBox(72, 108, 360, 480);
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  page.setRotation(degrees(90));
  page.drawRectangle({ x: 82, y: 118, width: 36, height: 28, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 386, y: 540, width: 36, height: 28, color: rgb(0, 0, 1) });
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("VECTOR_RESUME_SENTINEL", { x: 150, y: 340, size: 18, font });
  const field = document.getForm().createTextField("fixture.resume");
  field.setText("FORM RESUMES");
  field.addToPage(page, {
    x: 130,
    y: 180,
    width: 220,
    height: 44,
    font,
    borderWidth: 2,
    borderColor: rgb(1, 0, 1),
    backgroundColor: rgb(1, 1, 0),
    textColor: rgb(0, 0, 0),
  });
  return document.save({ useObjectStreams: false });
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
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function solidPngDataUrl(colour: string): string {
  const canvas = createCanvas(12, 12);
  const context = canvas.getContext("2d");
  context.fillStyle = colour;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
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
    groupIds: [] as string[],
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

function exportTestText(
  id: string,
  text: string,
  x: number,
  y: number,
  index: string,
  frameId: string | null = null,
) {
  return {
    id,
    type: "text",
    x,
    y,
    width: Math.max(40, text.length * 14),
    height: 30,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [] as string[],
    frameId,
    roundness: null,
    seed: 2,
    version: 1,
    versionNonce: 2,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index,
    fontSize: 24,
    fontFamily: 1,
    text,
    originalText: text,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

function classroomTestFrame(
  id: string,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  index: string,
  tagged = false,
) {
  return {
    ...exportTestRectangle(id, x, y, width, height, index),
    type: "frame",
    backgroundColor: "transparent",
    roundness: null,
    name,
    ...(tagged ? { customData: { classroomSlide: { kind: "slide", version: 1 } } } : {}),
  };
}

async function openClassroomFixture(
  page: import("@playwright/test").Page,
  elements: Array<Record<string, unknown>>,
  slideOrder: Array<{ id: string; frameId: string; title: string; titleMode?: "automatic" | "custom" }>,
  fileName = "detached-slides.patterdraw",
  whileOpening?: () => Promise<void>,
  files: Record<string, Record<string, unknown>> = {},
) {
  const sceneId = "scene";
  const project = {
    schemaVersion: 1,
    id: "browser-fixture",
    title: "Detached slides fixture",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    activeSceneId: sceneId,
    scenes: {
      [sceneId]: {
        id: sceneId,
        name: "Board",
        elements,
        appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" },
        files,
      },
    },
    slideOrder: slideOrder.map((slide) => ({ ...slide, sceneId })),
    slideFramesVisible: true,
    slideFrameAspectRatio: "freeform",
    slideMorphEnabled: true,
    slideMorphDurationMs: 650,
    pdfPageOrder: [],
    pdfDocuments: {},
  };
  const bytes = zipSync({ "project.json": strToU8(JSON.stringify(project)) });
  await page.getByLabel("Open project file").setInputFiles({
    name: fileName,
    mimeType: "application/vnd.patterdraw+zip",
    buffer: Buffer.from(bytes),
  });
  await whileOpening?.();
  await expect(page.getByRole("textbox", { name: "Project title" }))
    .toHaveValue(project.title);
  await expect.poll(async () => (
    await keyvalValue<{ id: string }>(page, "patterdraw:autosave:project:v1")
  )?.id).toBe(project.id);
  await expect(page.locator(".busy-overlay")).toHaveCount(0);
}

async function openSlideSettings(page: Page) {
  const trigger = page.getByRole("button", { name: "Slide settings", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Slide settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

type AutosavedElementState = {
  customData?: { classroomSlide?: { kind?: string; version?: number } };
  frameId: string | null;
  groupIds: string[];
  height: number;
  isDeleted: boolean;
  type: string;
  width: number;
  x: number;
  y: number;
};

async function autosavedElementsById(
  page: import("@playwright/test").Page,
  ids: string[],
): Promise<Record<string, AutosavedElementState>> {
  const project = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, { elements: Array<Record<string, unknown>> }>;
  }>(page, "patterdraw:autosave:project:v1");
  const wanted = new Set(ids);
  return Object.fromEntries(
    (project?.scenes[project.activeSceneId]?.elements || [])
      .filter((element) => wanted.has(String(element.id)))
      .map((element) => [String(element.id), element]),
  ) as Record<string, AutosavedElementState>;
}

async function scenePointInViewport(
  page: import("@playwright/test").Page,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const project = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, {
      appState: {
        offsetLeft?: number;
        offsetTop?: number;
        scrollX?: number;
        scrollY?: number;
        zoom?: { value?: number };
      };
    }>;
  }>(page, "patterdraw:autosave:project:v1");
  const appState = project?.scenes[project.activeSceneId]?.appState || {};
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("Editor host has no visible bounds.");
  const zoom = appState.zoom?.value || 1;
  return {
    x: (point.x + (appState.scrollX || 0)) * zoom + (appState.offsetLeft ?? editor.x),
    y: (point.y + (appState.scrollY || 0)) * zoom + (appState.offsetTop ?? editor.y),
  };
}

async function liveScenePointInViewport(
  page: import("@playwright/test").Page,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate((scenePoint) => {
    const appState = (window as unknown as {
      h?: { app?: { state?: {
        offsetLeft?: number;
        offsetTop?: number;
        scrollX?: number;
        scrollY?: number;
        zoom?: { value?: number };
      } } };
    }).h?.app?.state;
    if (!appState) throw new Error("Live Excalidraw app state is unavailable.");
    const zoom = appState.zoom?.value || 1;
    return {
      x: (scenePoint.x + (appState.scrollX || 0)) * zoom + (appState.offsetLeft || 0),
      y: (scenePoint.y + (appState.scrollY || 0)) * zoom + (appState.offsetTop || 0),
    };
  }, point);
}

type StoredLibraryItem = {
  id: string;
  status: "published" | "unpublished";
  created: number;
  name?: string;
  elements: Array<{ id: string; type: string }>;
};

async function keyvalValue<T>(page: import("@playwright/test").Page, key: string): Promise<T | undefined> {
  return page.evaluate(async (storedKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get(storedKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  }, key) as Promise<T | undefined>;
}

async function installDeferredFullscreenProbe(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    type DeferredRequest = { element: Element; resolve: () => void };
    type ProbeWindow = Window & {
      __patterdrawFullscreenProbe?: {
        fullscreenElement: Element | null;
        requests: DeferredRequest[];
      };
    };
    const probeWindow = window as ProbeWindow;
    const probe = {
      fullscreenElement: null as Element | null,
      requests: [] as DeferredRequest[],
    };
    probeWindow.__patterdrawFullscreenProbe = probe;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => probe.fullscreenElement,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: async () => {
        probe.fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      },
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value(this: Element) {
        return new Promise<void>((resolve) => {
          probe.requests.push({ element: this, resolve });
        });
      },
    });
  });
}

async function deferredFullscreenRequestCount(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => (
    window as Window & {
      __patterdrawFullscreenProbe?: { requests: unknown[] };
    }
  ).__patterdrawFullscreenProbe?.requests.length || 0);
}

async function resolveDeferredFullscreenRequest(
  page: import("@playwright/test").Page,
  index: number,
): Promise<void> {
  await page.evaluate((requestIndex) => {
    type DeferredRequest = { element: Element; resolve: () => void };
    const probe = (
      window as Window & {
        __patterdrawFullscreenProbe?: {
          fullscreenElement: Element | null;
          requests: DeferredRequest[];
        };
      }
    ).__patterdrawFullscreenProbe;
    const request = probe?.requests[requestIndex];
    if (!probe || !request) throw new Error(`Missing deferred fullscreen request ${requestIndex}.`);
    probe.fullscreenElement = request.element;
    request.resolve();
    document.dispatchEvent(new Event("fullscreenchange"));
  }, index);
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)));
}

async function setKeyvalValue(
  page: import("@playwright/test").Page,
  key: string,
  value: unknown,
): Promise<void> {
  await page.evaluate(async ({ storedKey, storedValue }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").put(storedValue, storedKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { storedKey: key, storedValue: value });
}

async function deleteKeyvalValues(page: import("@playwright/test").Page, keys: string[]): Promise<void> {
  await page.evaluate(async (storedKeys) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      const store = transaction.objectStore("keyval");
      for (const storedKey of storedKeys) store.delete(storedKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, keys);
}

async function openLibraryPanel(page: import("@playwright/test").Page) {
  const trigger = page.getByRole("button", { name: "Library", exact: true });
  await expect(trigger).toBeEnabled();
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const panel = page.locator(".layer-ui__library");
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return { panel, trigger };
}

async function openScreenshotLibrary(page: import("@playwright/test").Page) {
  const trigger = page.getByRole("button", { name: "Library", exact: true });
  await expect(trigger).toBeEnabled();
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const tab = page.locator('.default-sidebar .sidebar-tab-trigger[aria-label="Screenshot Library"]');
  await expect(tab).toBeVisible();
  const panel = page.getByRole("region", { name: "Screenshot Library", exact: true });
  if (!await panel.isVisible()) await tab.click();
  await expect(panel).toBeVisible();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return { panel, tab, trigger };
}

async function captureScreenshotArea(
  page: import("@playwright/test").Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const { panel, trigger } = await openScreenshotLibrary(page);
  await panel.getByRole("button", { name: "Capture area", exact: true }).click();
  const overlay = page.getByTestId("screenshot-capture-overlay");
  await expect(overlay).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  const bounds = await overlay.boundingBox();
  if (!bounds) throw new Error("Screenshot capture overlay has no bounds.");
  await page.mouse.move(bounds.x + start.x, bounds.y + start.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + end.x, bounds.y + end.y, { steps: 8 });
  await page.mouse.up();
  await expect(overlay).toBeHidden();
}

interface StoredScreenshotSummary {
  count: number;
  ids: string[];
  newest?: {
    blobSize: number;
    blobType: string;
    createdAt: number;
    height: number;
    sceneHeight: number;
    sceneWidth: number;
    width: number;
  };
}

async function storedScreenshotSummary(page: import("@playwright/test").Page): Promise<StoredScreenshotSummary> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<{
      version: number;
      items: Array<{
        id: string;
        createdAt: number;
        blob: Blob;
        width: number;
        height: number;
        sceneWidth: number;
        sceneHeight: number;
      }>;
    } | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly").objectStore("keyval")
        .get("patterdraw:screenshot-library:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const items = record?.items || [];
    const newest = items[0];
    return {
      count: items.length,
      ids: items.map((item) => item.id),
      newest: newest ? {
        blobSize: newest.blob.size,
        blobType: newest.blob.type,
        createdAt: newest.createdAt,
        height: newest.height,
        sceneHeight: newest.sceneHeight,
        sceneWidth: newest.sceneWidth,
        width: newest.width,
      } : undefined,
    };
  });
}

async function storedScreenshotPixelSummary(page: import("@playwright/test").Page): Promise<{
  bluePixels: number;
  darkPixels: number;
  redPixels: number;
  whitePixels: number;
}> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<{ items: Array<{ blob: Blob }> } | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly").objectStore("keyval")
        .get("patterdraw:screenshot-library:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const blob = record?.items[0]?.blob;
    if (!blob) return { bluePixels: 0, darkPixels: 0, redPixels: 0, whitePixels: 0 };
    const image = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot pixels could not be inspected.");
    context.drawImage(image, 0, 0);
    image.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let bluePixels = 0;
    let darkPixels = 0;
    let redPixels = 0;
    let whitePixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha < 100) continue;
      if (blue > 180 && blue > red + 25 && blue > green) bluePixels += 1;
      if (red > 180 && red > green + 35 && red > blue + 35) redPixels += 1;
      if (red < 90 && green < 90 && blue < 90) darkPixels += 1;
      if (red > 248 && green > 248 && blue > 248) whitePixels += 1;
    }
    return { bluePixels, darkPixels, redPixels, whitePixels };
  });
}

async function autosavedScreenshotImageSummary(page: import("@playwright/test").Page): Promise<{
  centerError: number | null;
  imageCount: number;
  insertedImageCount: number;
  latestCenter: { x: number; y: number } | null;
  pngFileCount: number;
}> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const project = await new Promise<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ id: string; type?: string; fileId?: string | null; height?: number; isDeleted?: boolean; width?: number; x?: number; y?: number }>;
        appState: { selectedElementIds?: Record<string, boolean> };
        files: Record<string, { mimeType?: string }>;
        pdfPage?: { backgroundElementId: string; height: number; width: number };
      }>;
    } | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly").objectStore("keyval")
        .get("patterdraw:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const scene = project?.scenes[project.activeSceneId];
    const images = (scene?.elements || []).filter((element) => element.type === "image" && !element.isDeleted);
    const inserted = images.filter((image) => image.id !== scene?.pdfPage?.backgroundElementId);
    const centered = inserted.at(-1);
    return {
      centerError: centered && scene?.pdfPage
        ? Math.max(
          Math.abs((centered.x || 0) + (centered.width || 0) / 2 - scene.pdfPage.width / 2),
          Math.abs((centered.y || 0) + (centered.height || 0) / 2 - scene.pdfPage.height / 2),
        )
        : null,
      imageCount: images.length,
      insertedImageCount: inserted.length,
      latestCenter: centered ? {
        x: (centered.x || 0) + (centered.width || 0) / 2,
        y: (centered.y || 0) + (centered.height || 0) / 2,
      } : null,
      pngFileCount: images.filter((image) => image.fileId && scene?.files[image.fileId]?.mimeType === "image/png").length,
    };
  });
}

function standardLibraryBytes(): Buffer {
  return Buffer.from(JSON.stringify({
    type: "excalidrawlib",
    version: 2,
    source: "https://libraries.excalidraw.com",
    libraryItems: [{
      id: "downloaded-library-item",
      status: "published",
      created: 1,
      name: "Downloaded classroom shape",
      elements: [exportTestRectangle("downloaded-library-rectangle", 0, 0, 180, 120, "a0")],
    }],
  }));
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (!project) return null;
    return project.slideFramesVisible ?? null;
  });
}

async function autosavedFrameAspectSummary(page: import("@playwright/test").Page): Promise<{
  mode: "freeform" | "16:9" | "4:3" | null;
  frames: Array<{ height: number; ratio: number; width: number }>;
} | null> {
  const project = await keyvalValue<{
    activeSceneId: string;
    slideFrameAspectRatio?: "freeform" | "16:9" | "4:3";
    scenes: Record<string, { elements: Array<{ customData?: { classroomSlide?: { kind?: string; version?: number } }; height?: number; isDeleted?: boolean; type?: string; width?: number }> }>;
  }>(page, "patterdraw:autosave:project:v1");
  if (!project) return null;
  const frames = project.scenes[project.activeSceneId]?.elements
    .filter((element) => (
      element.type === "frame"
      && !element.isDeleted
      && element.customData?.classroomSlide?.kind === "slide"
      && element.customData.classroomSlide.version === 1
    ))
    .map((element) => ({
      height: element.height || 0,
      ratio: (element.width || 0) / (element.height || 1),
      width: element.width || 0,
    })) || [];
  return { mode: project.slideFrameAspectRatio ?? null, frames };
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = database.transaction("keyval", "readonly").objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
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

type AutosavedRectanglePosition = Awaited<ReturnType<typeof autosavedRectanglePositions>>[number];

async function waitForAutosavedRectangleSet(
  page: import("@playwright/test").Page,
  expectedIds: readonly string[],
): Promise<AutosavedRectanglePosition[]> {
  let settled: AutosavedRectanglePosition[] | undefined;
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    const ids = positions.map((position) => position.id);
    if (
      ids.length !== expectedIds.length
      || ids.some((id, index) => id !== expectedIds[index])
    ) return false;
    settled = positions;
    return true;
  }, { timeout: 15_000 }).toBe(true);
  if (!settled) throw new Error("The expected rectangle snapshot was not observed.");
  return settled;
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
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const scene = project?.scenes[project.activeSceneId];
    const background = scene?.elements.find((element) => element.id === scene.pdfPage?.backgroundElementId);
    return background ? { locked: Boolean(background.locked), x: background.x || 0, y: background.y || 0 } : null;
  });
}

const runtimeGuardAllowedOrigin = "http://127.0.0.1:5173";
const runtimeGuardUnhandledPrefix = "[patterdraw-runtime-guard:unhandledrejection] ";
const syntheticPinchConsoleErrorPrefix =
  "Warning: An update (setState, replaceState, or forceUpdate) was scheduled from inside an update function.";

type RuntimeGuardState = {
  consoleErrors: string[];
  externalRequests: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  pages: Set<Page>;
  pageListener: (page: Page) => void;
  requestListener: (request: Request) => void;
};

const runtimeGuardStates = new WeakMap<BrowserContext, RuntimeGuardState>();

function addRuntimeGuardPage(state: RuntimeGuardState, page: Page): void {
  if (state.pages.has(page)) return;
  state.pages.add(page);
  page.on("pageerror", (error) => {
    state.pageErrors.push(error.stack || error.message);
  });
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") {
      state.consoleErrors.push(text);
      return;
    }
    if (message.type() !== "debug") return;
    if (text.startsWith(runtimeGuardUnhandledPrefix)) {
      state.unhandledRejections.push(text.slice(runtimeGuardUnhandledPrefix.length));
    }
  });
}

async function installRuntimeGuard(context: BrowserContext, page: Page): Promise<void> {
  const state: RuntimeGuardState = {
    consoleErrors: [],
    externalRequests: [],
    pageErrors: [],
    unhandledRejections: [],
    pages: new Set(),
    pageListener: () => undefined,
    requestListener: () => undefined,
  };
  state.pageListener = (openedPage) => addRuntimeGuardPage(state, openedPage);
  state.requestListener = (request: Request) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url());
    } catch {
      return;
    }
    if (
      (requestUrl.protocol === "http:" || requestUrl.protocol === "https:")
      && requestUrl.origin !== runtimeGuardAllowedOrigin
    ) {
      state.externalRequests.push(`${request.method()} ${request.url()}`);
    }
  };
  runtimeGuardStates.set(context, state);
  addRuntimeGuardPage(state, page);
  context.on("page", state.pageListener);
  await context.addInitScript(() => {
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      if (
        reason
        && typeof reason === "object"
        && "name" in reason
        && (reason as { name?: unknown }).name === "AbortError"
      ) return;
      const detail = reason instanceof Error
        ? (reason.stack || reason.message)
        : String(reason);
      // A debug marker avoids turning an intentionally handled console.error
      // probe into a second failure while remaining visible to Playwright.
      console.debug("[patterdraw-runtime-guard:unhandledrejection] " + detail);
    });
  });
  // Do not use context.route() here: Playwright disables the HTTP cache for
  // every routed context, which makes each Vite reload fetch hundreds of local
  // modules again. The dev browser launch sends every non-Vite origin through
  // a closed local proxy, while this listener still records the attempted URL
  // and fails the test with a useful diagnostic.
  context.on("request", state.requestListener);
}

test.beforeEach(async ({ context, page }) => {
  await installRuntimeGuard(context, page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
});

test.afterEach(async ({ context }, testInfo: TestInfo) => {
  const state = runtimeGuardStates.get(context);
  if (!state) return;
  await Promise.all(context.pages().map((openPage) => openPage.waitForTimeout(0).catch(() => undefined)));
  context.off("request", state.requestListener);
  context.off("page", state.pageListener);

  // Preserve the primary assertion when a test is already failing; runtime
  // diagnostics are still attached to the Playwright trace/listener output.
  if (testInfo.status !== testInfo.expectedStatus) return;
  const consoleErrors = state.consoleErrors.filter((error) => {
    if (
      testInfo.title === "fills a closed region with a persistent, undoable local vector"
      && error.startsWith(syntheticPinchConsoleErrorPrefix)
    ) return false;
    if (
      testInfo.title === "restores a canonical light PDF background after a failed dark render"
      && error === "Failed to load resource: net::ERR_FAILED"
    ) return false;
    return true;
  });
  expect(consoleErrors, "browser console errors").toEqual([]);
  expect(state.externalRequests, "offline guard blocked external requests").toEqual([]);
  expect(state.pageErrors, "uncaught page errors").toEqual([]);
  expect(state.unhandledRejections, "unhandled promise rejections").toEqual([]);
});

test("uses PatterDraw branding for the app and a new canvas", async ({ page }) => {
  await expect(page).toHaveTitle("PatterDraw");
  await expect(page.getByRole("img", { name: "PatterDraw", exact: true })).toHaveText("P");
  const title = page.getByRole("textbox", { name: "Project title", exact: true });
  await expect(title).toHaveValue("Untitled PatterDraw canvas");
  await expect(page.getByTitle("Download a complete PatterDraw project")).toBeVisible();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();

  const autosaveKey = "patterdraw:autosave:project:v1";
  const current = await keyvalValue<{
    title: string;
    titleMode?: "default" | "custom";
  }>(page, autosaveKey);
  if (!current) throw new Error("The initial PatterDraw autosave was not created.");
  await setKeyvalValue(page, autosaveKey, {
    ...current,
    title: "Untitled classroom canvas",
    titleMode: undefined,
  });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(title).toHaveValue("Untitled PatterDraw canvas");
  await expect.poll(async () => (
    await keyvalValue<{ title: string; titleMode?: string }>(page, autosaveKey)
  )).toMatchObject({
    title: "Untitled PatterDraw canvas",
    titleMode: "default",
  });

  await title.fill("Untitled classroom canvas");
  await title.press("End");
  await expect.poll(async () => (
    await keyvalValue<{ title: string; titleMode?: string }>(page, autosaveKey)
  ), { timeout: 10_000 }).toMatchObject({
    title: "Untitled classroom canvas",
    titleMode: "custom",
  });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(title).toHaveValue("Untitled classroom canvas");
});

test("customizes optional features from device-local settings", async ({ page }) => {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const projectTitle = page.getByRole("textbox", { name: "Project title", exact: true });
  const settingsBounds = await settings.boundingBox();
  const titleBounds = await projectTitle.boundingBox();
  expect(settingsBounds).not.toBeNull();
  expect(titleBounds).not.toBeNull();
  expect(settingsBounds?.x || 0).toBeLessThan(titleBounds?.x || 0);

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".slide-rail")).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".default-sidebar")).toBeVisible();

  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Preferences stay on this device.");
  const slidesPreference = dialog.getByRole("switch", { name: "Slides", exact: true });
  const restoreDefaults = dialog.getByRole("button", { name: "Restore defaults", exact: true });
  await expect(slidesPreference).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  await expect(slidesPreference).toBeFocused();
  await restoreDefaults.focus();
  await page.keyboard.press("Tab");
  await expect(slidesPreference).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(restoreDefaults).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  await settings.click();
  await expect(dialog).toBeVisible();

  for (const label of ["Slides", "PDF", "Insert tools", "Math tools", "Library", "Size & Position", "Project Find", "Status bar"]) {
    await expect(dialog.getByRole("switch", { name: label, exact: true })).toBeChecked();
  }
  const pdfPreferenceLabels = ["Dark PDF preview"] as const;
  for (const label of pdfPreferenceLabels) {
    await expect(dialog.getByRole("switch", { name: label, exact: true })).toBeChecked();
  }
  for (const label of ["Pen-only mode", "Show grid", "Snap to objects", "Icon-only controls"]) {
    await expect(dialog.getByRole("switch", { name: label, exact: true })).not.toBeChecked();
  }
  await expect(dialog.getByRole("combobox", { name: "Theme", exact: true })).toHaveValue("light");
  const experimental = dialog.getByRole("switch", { name: "Experimental math tools", exact: true });
  await expect(experimental).not.toBeChecked();
  await experimental.check();
  expect(await page.evaluate(() => localStorage.getItem("patterdraw:experimental-math-tools:v1"))).toBe("enabled");

  for (const label of ["Slides", "PDF", "Insert tools", "Math tools", "Library", "Size & Position", "Project Find", "Status bar"]) {
    await dialog.getByRole("switch", { name: label, exact: true }).uncheck();
  }
  for (const label of pdfPreferenceLabels) {
    await dialog.getByRole("switch", { name: label, exact: true }).uncheck();
  }

  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".slide-rail")).toHaveCount(0);
  await expect(page.locator(".default-sidebar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Slides", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDF", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Insert", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Library", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find in project", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Size & Position", exact: true })).toHaveCount(0);
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show footer", exact: true })).toBeVisible();
  await expect(settings).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await expect(page.locator(".App-toolbar__extra-tools-dropdown")).toBeVisible();
  await expect(page.getByTestId("toolbar-math-tools")).toHaveCount(0);
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  const editorBounds = await page.locator(".editor-host .excalidraw").boundingBox();
  expect(editorBounds).not.toBeNull();
  await page.mouse.click(
    (editorBounds?.x || 0) + (editorBounds?.width || 0) / 2,
    (editorBounds?.y || 0) + (editorBounds?.height || 0) / 2,
  );
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator(".project-find-query")).toHaveCount(0);
  await expect(page.locator(".layer-ui__search input")).toHaveCount(0);

  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
  ))).toEqual({
    slides: false,
    pdf: false,
    insert: false,
    mathTools: false,
    library: false,
    footer: false,
    penOnly: false,
    showGrid: false,
    snapToObjects: false,
    sizePosition: false,
    projectFind: false,
    iconOnlyControls: false,
  });
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem("patterdraw:pdf-preferences:v1") || "null",
  ))).toEqual({
    darkPdfPreview: false,
    sharperActivePdfPage: true,
    offerVisualPdfFallback: true,
  });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(page.getByRole("button", { name: "Slides", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Insert", exact: true })).toHaveCount(0);
  await expect(page.locator(".statusbar")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await settings.click();
  await expect(dialog).toBeVisible();
  for (const label of pdfPreferenceLabels) {
    await expect(dialog.getByRole("switch", { name: label, exact: true })).not.toBeChecked();
  }
  const mobileDialogBounds = await dialog.boundingBox();
  expect(mobileDialogBounds).not.toBeNull();
  expect(mobileDialogBounds?.x || 0).toBeGreaterThanOrEqual(0);
  expect((mobileDialogBounds?.x || 0) + (mobileDialogBounds?.width || 0)).toBeLessThanOrEqual(390);
  expect((mobileDialogBounds?.y || 0) + (mobileDialogBounds?.height || 0)).toBeLessThanOrEqual(844);
  await dialog.getByRole("button", { name: "Restore defaults", exact: true }).click();

  await expect(dialog.getByRole("switch", { name: "Slides", exact: true })).toBeChecked();
  for (const label of pdfPreferenceLabels) {
    await expect(dialog.getByRole("switch", { name: label, exact: true })).toBeChecked();
  }
  await expect(dialog.getByRole("switch", { name: "Experimental math tools", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Slides", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Insert", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  // The preference is restored, but Board mode deliberately suppresses its
  // duplicate wrapper footer on phones in favour of Excalidraw's contextual
  // mobile action island.
  await expect(page.locator(".statusbar")).toBeHidden();
  await expect(page.locator(".editor-host .App-bottom-bar .Island")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
  ))).toEqual({
    slides: true,
    pdf: true,
    insert: true,
    mathTools: true,
    library: true,
    footer: true,
    penOnly: false,
    showGrid: false,
    snapToObjects: false,
    sizePosition: true,
    projectFind: true,
    iconOnlyControls: false,
  });
  expect(await page.evaluate(() => localStorage.getItem("patterdraw:experimental-math-tools:v1"))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem("patterdraw:pdf-preferences:v1") || "null",
  ))).toEqual({
    darkPdfPreview: true,
    sharperActivePdfPage: true,
    offerVisualPdfFallback: true,
  });
});

test("optionally hides redundant icon labels without removing accessible names", async ({ page }) => {
  const shell = page.locator(".app-shell");
  const board = page.getByRole("button", { name: "Board", exact: true });
  const boardLabel = board.locator(".icon-label");
  await expect(shell).not.toHaveClass(/is-icon-only-controls/);
  await expect(boardLabel).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const preference = page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("switch", { name: "Icon-only controls", exact: true });
  await expect(preference).not.toBeChecked();
  await preference.check();
  await expect(shell).toHaveClass(/is-icon-only-controls/);
  await expect(board).toBeVisible();
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  expect(await boardLabel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { clipPath: style.clipPath, height: style.height, width: style.width };
  })).toEqual({ clipPath: "inset(50%)", height: "1px", width: "1px" });
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
  )?.iconOnlyControls)).toBe(true);

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(shell).toHaveClass(/is-icon-only-controls/);
  await expect(page.getByRole("button", { name: "Board", exact: true })).toBeVisible();
});

test("applies pen-only, grid, and object-snapping preferences to the live editor", async ({ page }) => {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const penOnly = dialog.getByRole("switch", { name: "Pen-only mode", exact: true });
  const showGrid = dialog.getByRole("switch", { name: "Show grid", exact: true });
  const snapToObjects = dialog.getByRole("switch", { name: "Snap to objects", exact: true });

  await penOnly.check();
  await showGrid.check();
  await expect(showGrid).toBeChecked();
  await expect(snapToObjects).not.toBeChecked();
  await page.keyboard.press("Escape");

  const sizePosition = page.getByRole("button", { name: "Size & Position", exact: true });
  await sizePosition.click();
  const stats = page.locator(".exc-stats");
  await expect(stats).toBeVisible();
  await expect(stats.getByTestId("Grid step")).toBeVisible();
  await sizePosition.click();
  await expect(stats).toHaveCount(0);

  await settings.click();
  await snapToObjects.check();
  await expect(snapToObjects).toBeChecked();
  await expect(showGrid).not.toBeChecked();
  await page.keyboard.press("Escape");
  await sizePosition.click();
  await expect(stats).toBeVisible();
  await expect(stats.getByTestId("Grid step")).toHaveCount(0);
  await sizePosition.click();

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  const host = await page.locator(".editor-host").boundingBox();
  if (!host) throw new Error("Editor host has no visible bounds.");
  const drawWithPointer = async (pointerType: "touch" | "pen", pointerId: number, y: number) => {
    await page.evaluate(({ left, top, pointerId, pointerType, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".editor-host canvas.interactive");
      if (!canvas) throw new Error("Interactive drawing canvas is unavailable.");
      // Synthetic PointerEvents are not registered as active hardware pointers,
      // so Chromium's native setPointerCapture would throw before Excalidraw can
      // exercise its pen/touch gate. Real hardware does not need this shim.
      const setPointerCapture = canvas.setPointerCapture;
      canvas.setPointerCapture = () => {};
      const dispatch = (type: string, x: number, buttons: number) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: left + x,
        clientY: top + y,
        pointerId,
        pointerType,
        isPrimary: true,
        button: 0,
        buttons,
        pressure: buttons ? 0.5 : 0,
      }));
      try {
        dispatch("pointerdown", 420, 1);
        dispatch("pointermove", 480, 1);
        dispatch("pointermove", 540, 1);
        dispatch("pointerup", 540, 0);
      } finally {
        canvas.setPointerCapture = setPointerCapture;
      }
    }, { left: host.x, top: host.y, pointerId, pointerType, y });
  };

  await drawWithPointer("touch", 301, 270);
  await page.waitForTimeout(400);
  expect(await autosavedRectanglePositions(page)).toHaveLength(0);

  await drawWithPointer("pen", 302, 410);
  await expect.poll(() => autosavedRectanglePositions(page)).toHaveLength(1);
  const saved = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, { appState: Record<string, unknown> }>;
  }>(page, "patterdraw:autosave:project:v1");
  const savedAppState = saved?.scenes[saved.activeSceneId]?.appState || {};
  expect(savedAppState.penMode).toBeUndefined();
  expect(savedAppState.gridModeEnabled).toBeUndefined();
  expect(savedAppState.objectsSnapModeEnabled).toBeUndefined();

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await settings.click();
  await expect(penOnly).toBeChecked();
  await expect(showGrid).not.toBeChecked();
  await expect(snapToObjects).toBeChecked();
  await dialog.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await expect(penOnly).not.toBeChecked();
  await expect(showGrid).not.toBeChecked();
  await expect(snapToObjects).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(
      localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
    ) as { penOnly?: boolean; showGrid?: boolean; snapToObjects?: boolean } | null;
    return stored && {
      penOnly: stored.penOnly,
      showGrid: stored.showGrid,
      snapToObjects: stored.snapToObjects,
    };
  })).toEqual({ penOnly: false, showGrid: false, snapToObjects: false });
});

test("edits exact geometry through the optional Size & Position inspector", async ({ page }) => {
  await openClassroomFixture(page, [
    exportTestRectangle("inspected-rectangle", 200, 160, 180, 110, "a0"),
  ], []);
  const center = await scenePointInViewport(page, { x: 290, y: 215 });
  await page.getByTestId("toolbar-selection").check({ force: true });
  await page.mouse.click(center.x, center.y);

  const toggle = page.getByRole("button", { name: "Size & Position", exact: true });
  await toggle.click();
  const panel = page.locator(".exc-stats");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("aria-label", "Size & Position");
  await expect(panel.locator(".title h2")).toHaveAttribute("aria-label", "Size & Position");
  for (const label of ["X", "Y", "W", "H", "A"]) {
    await expect(panel.getByTestId(label).locator("input")).toHaveCount(1);
  }

  const xInput = panel.getByTestId("X").locator("input");
  const widthInput = panel.getByTestId("W").locator("input");
  await expect(xInput).toHaveValue("200");
  await expect(widthInput).toHaveValue("180");
  await xInput.fill("240");
  await xInput.press("Enter");
  await widthInput.fill("220");
  await widthInput.press("Enter");
  await expect.poll(async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ id: string; width: number; x: number }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    const element = project?.scenes[project.activeSceneId]?.elements
      .find((candidate) => candidate.id === "inspected-rectangle");
    return element ? { width: element.width, x: element.x } : null;
  }).toEqual({ width: 220, x: 240 });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("switch", { name: "Size & Position", exact: true })
    .uncheck();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-selection").focus();
  await page.keyboard.press("Alt+/");
  await expect(panel).toHaveCount(0);
});

test("finds and activates text across Board, Slides, and PDF pages", async ({ page }) => {
  test.setTimeout(180_000);
  const frame = classroomTestFrame("lesson-frame", "Lesson Slide", 300, 180, 520, 320, "a2", true);
  await openClassroomFixture(page, [
    exportTestText("board-lesson", "Board lesson", 60, 70, "a0"),
    exportTestText("slide-lesson", "Slide lesson", 360, 250, "a1"),
    frame,
  ], [
    { id: "lesson-slide", frameId: frame.id, title: "Lesson Slide", titleMode: "custom" },
  ]);
  await openTestPdf(page);
  await page.getByTestId("toolbar-text").check({ force: true });
  const pdfHost = await page.locator(".editor-host").boundingBox();
  if (!pdfHost) throw new Error("Editor host has no visible bounds in PDF mode.");
  await page.mouse.click(pdfHost.x + pdfHost.width / 2, pdfHost.y + pdfHost.height / 2);
  const textEditor = page.locator("textarea.excalidraw-wysiwyg");
  await expect(textEditor).toBeVisible();
  await textEditor.fill("PDF lesson");
  await textEditor.press("ControlOrMeta+Enter");
  await expect.poll(async () => {
    const current = await keyvalValue<{
      pdfPageOrder: string[];
      scenes: Record<string, { elements: Array<{ text?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    const pdfSceneId = current?.pdfPageOrder[0];
    return pdfSceneId
      ? current.scenes[pdfSceneId]?.elements.some((element) => element.text === "PDF lesson")
      : false;
  }).toBe(true);

  // Excalidraw uses non-modal role=dialog surfaces for the selected-text
  // property controls. Those must not suppress PatterDraw's project search.
  await page.keyboard.press("ControlOrMeta+f");
  const query = page.getByRole("searchbox", { name: "Find text across project", exact: true });
  await expect(query).toBeVisible();
  await expect(query).toBeFocused();
  await query.fill("lesson");
  const results = page.locator(".project-find-result");
  await expect(results).toHaveCount(3);
  await expect(page.locator(".project-find-result-scope")).toHaveText(["Board", "Slide 1", "PDF"]);
  await expect(page.locator(".project-find-result-context")).toHaveText([
    "Board",
    "Lesson Slide",
    "toolbar-position.pdf · Page 1 · Source page 1",
  ]);

  await query.press("ArrowDown");
  await query.press("Enter");
  await expect(page.locator(".app-shell")).toHaveClass(/is-slide-mode/);
  await expect(page.locator('.slide-thumbnail[aria-current="page"]')).toContainText("Lesson Slide");

  await page.locator(".project-find-result").filter({ hasText: "PDF lesson" }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect(page.locator(".page-status")).toContainText("Page 1 of 1");

  await page.locator(".project-find-result").filter({ hasText: "Board lesson" }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await page.getByRole("button", { name: "Search current canvas", exact: true }).click();
  await expect(page.locator(".layer-ui__search input")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(query).toBeVisible();
  await expect(query).toBeFocused();
});

test("does not open Project Find behind an active math interaction", async ({ page }) => {
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  const insertMenu = page.locator('.topbar-menu-popover[role="menu"]');
  await expect(insertMenu).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(insertMenu).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(insertMenu).toHaveCount(0);

  const extraToolsTrigger = page.locator(".App-toolbar__extra-tools-trigger");
  await extraToolsTrigger.click();
  const extraToolsMenu = page.locator(".App-toolbar__extra-tools-dropdown");
  await expect(extraToolsMenu).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(extraToolsMenu).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(extraToolsMenu).toHaveCount(0);

  await page.locator(".editor-host").click({
    button: "right",
    position: { x: 500, y: 350 },
  });
  const contextMenu = page.locator(".editor-host .excalidraw .context-menu");
  await expect(contextMenu).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(contextMenu).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(contextMenu).toHaveCount(0);

  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-math-tools").click();
  await enableExperimentalMathTools(page);
  await page.getByTestId("math-tool-compass").click();
  const compass = page.getByRole("dialog", { name: "Compass construction", exact: true });
  await expect(compass).toBeVisible();

  await page.keyboard.press("ControlOrMeta+f");

  await expect(compass).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(compass).toBeHidden();
});

test("switches between light, dark, and live system themes", async ({ page }) => {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const theme = dialog.getByRole("combobox", { name: "Theme", exact: true });
  await theme.selectOption("dark");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".editor-host .excalidraw")).toHaveClass(/theme--dark/);
  expect(await page.evaluate(() => localStorage.getItem("patterdraw:theme-preference:v1"))).toBe("dark");

  await page.keyboard.press("Escape");
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-math-tools").click();
  const mathToolsDialog = page.getByRole("dialog", { name: "Math tools", exact: true });
  const mathToolCard = mathToolsDialog.locator(".math-tool-card").nth(1);
  await expect(mathToolsDialog).toBeVisible();
  await expect(mathToolCard).toHaveCSS("background-color", "rgb(32, 43, 62)");
  await expect(mathToolCard).toHaveCSS("color", "rgb(224, 232, 245)");
  await expect(mathToolsDialog.locator(".math-tools-experimental-toggle"))
    .toHaveCSS("background-color", "rgb(32, 43, 62)");
  await mathToolsDialog.getByRole("switch", { name: "Experimental features", exact: true }).check();
  const inactiveMathTab = mathToolsDialog.getByRole("tab", { name: "Graphs", exact: true });
  await expect(inactiveMathTab).toHaveCSS("color", "rgb(192, 203, 219)");
  await inactiveMathTab.click();
  await mathToolsDialog.getByRole("button", { name: /Cartesian plane/ }).click();
  const xMinimum = mathToolsDialog.getByLabel("x minimum", { exact: true });
  await expect(xMinimum).toHaveCSS("background-color", "rgb(17, 26, 40)");
  await expect(xMinimum).toHaveCSS("color", "rgb(231, 237, 247)");
  await expect(xMinimum.locator("xpath=..")).toHaveCSS("color", "rgb(192, 203, 219)");
  await expect(mathToolsDialog.locator(".math-tool-config-preview"))
    .toHaveCSS("background-color", "rgb(17, 26, 40)");
  await xMinimum.fill("20");
  await expect(mathToolsDialog.getByRole("alert")).toHaveCSS("color", "rgb(255, 180, 180)");
  await mathToolsDialog.getByRole("button", { name: "Close math tools", exact: true }).click();

  const insert = page.getByRole("button", { name: "Insert", exact: true });
  await insert.click();
  await page.getByRole("menuitem", { name: /Equation/ }).click();
  const equationDialog = page.getByRole("dialog", { name: "Insert equation", exact: true });
  const equationClose = equationDialog.getByRole("button", { name: "Close equation editor", exact: true });
  await expect(equationClose).toHaveCSS("color", "rgb(224, 232, 245)");
  await equationClose.hover();
  await expect(equationClose).toHaveCSS("background-color", "rgb(38, 50, 72)");
  const equationSource = equationDialog.getByLabel("LaTeX", { exact: true });
  await expect(equationSource).toHaveCSS("background-color", "rgb(13, 21, 33)");
  await expect(equationSource).toHaveCSS("color", "rgb(231, 237, 247)");
  await expect(equationDialog.locator(".dialog-primary"))
    .toHaveCSS("background-color", "rgb(40, 89, 197)");
  await page.keyboard.press("Escape");

  await insert.click();
  await page.getByRole("menuitem", { name: /Diagram/ }).click();
  const mermaidDialog = page.getByRole("dialog", { name: "Insert Mermaid diagram", exact: true });
  const mermaidSource = mermaidDialog.getByLabel("Mermaid source", { exact: true });
  await expect(mermaidSource).toHaveCSS("background-color", "rgb(13, 21, 33)");
  await expect(mermaidSource).toHaveCSS("color", "rgb(231, 237, 247)");
  await page.keyboard.press("Escape");

  await page.emulateMedia({ colorScheme: "dark" });
  await settings.click();
  await expect(dialog).toBeVisible();
  await theme.selectOption("system");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".editor-host .excalidraw")).not.toHaveClass(/theme--dark/);
  expect(await page.evaluate(() => localStorage.getItem("patterdraw:theme-preference:v1"))).toBe("system");

  await dialog.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await expect(theme).toHaveValue("light");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("patterdraw:theme-preference:v1"))).toBeNull();
});

test("darkens PDF content while preserving embedded picture colours and canonical storage", async ({ page }) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await useDownloadBasedImageExport(page);
  const pdfBytes = await pictureDarkModePdfBytes();
  await page.getByLabel("Open project file").setInputFiles({
    name: "dark-mode-picture.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(pdfBytes),
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: 30_000 });
  const thumbnails = page.locator("#pdf-page-rail .pdf-page-item img");
  await expect(thumbnails).toHaveCount(2, { timeout: 30_000 });
  const thumbnail = thumbnails.first();
  const unvisitedThumbnail = thumbnails.nth(1);
  await expectLoadedPreview(thumbnail);
  await expectLoadedPreview(unvisitedThumbnail);
  const lightThumbnail = await thumbnail.getAttribute("src");
  const lightUnvisitedThumbnail = await unvisitedThumbnail.getAttribute("src");
  expect(lightThumbnail).toMatch(/^data:image\/png;base64,/);
  expect(lightUnvisitedThumbnail).toMatch(/^data:image\/png;base64,/);

  const storedPdfRaster = async () => {
    const saved = await keyvalValue<{
      pdfPageOrder: string[];
      scenes: Record<string, {
        appState: Record<string, unknown>;
        elements: Array<{ fileId?: string; id: string }>;
        files: Record<string, { dataURL?: string }>;
        pdfPage?: { backgroundElementId: string };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    const scene = saved?.scenes[saved.pdfPageOrder[0]];
    const background = scene?.elements.find((element) => (
      element.id === scene.pdfPage?.backgroundElementId
    ));
    const fileId = background?.fileId;
    return scene && fileId ? {
      appTheme: scene.appState.theme,
      dataURL: scene.files[fileId]?.dataURL,
      fileCount: Object.keys(scene.files).length,
      fileId,
    } : null;
  };
  await expect.poll(storedPdfRaster, { timeout: 30_000 }).not.toBeNull();
  const lightStored = await storedPdfRaster();
  expect(lightStored?.dataURL).toBe(lightThumbnail);
  expect(lightStored?.appTheme).toBeUndefined();

  await expect.poll(
    () => renderedPdfDisplaySamples(page),
    { timeout: 30_000 },
  ).not.toBeNull();
  const lightSamples = await renderedPdfDisplaySamples(page);
  expect(lightSamples?.background.every((channel) => channel > 225)).toBe(true);
  expect(lightSamples?.vector.every((channel) => channel < 40)).toBe(true);
  expect(lightSamples?.picture[0]).toBeGreaterThan(220);
  expect(lightSamples?.picture[1]).toBeLessThan(55);
  expect(lightSamples?.picture[2]).toBeGreaterThan(110);
  expect(lightSamples?.pictureAccent[1]).toBeGreaterThan(180);
  expect(lightSamples?.pictureTransparentVector.every((channel) => channel < 40)).toBe(true);
  expect(lightSamples?.pictureVectorOverlay.every((channel) => channel < 40)).toBe(true);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => thumbnail.getAttribute("src"), { timeout: 30_000 })
    .not.toBe(lightThumbnail);
  await expect.poll(() => unvisitedThumbnail.getAttribute("src"), { timeout: 30_000 })
    .not.toBe(lightUnvisitedThumbnail);
  await expect(unvisitedThumbnail).toHaveClass(/pdf-page-dark-thumbnail/);
  await expect(page.locator(".pdf-output-position").first()).toHaveCSS("color", "rgb(192, 203, 219)");
  await expect(page.locator(".pdf-page-label").first()).toHaveCSS("color", "rgb(192, 203, 219)");
  await expect(page.locator(".pdf-page-actions button").first()).toHaveCSS("color", "rgb(185, 197, 215)");
  await expect(page.getByRole("button", { name: "Add page", exact: true }))
    .toHaveCSS("background-color", "rgb(40, 89, 197)");
  await expect(page.getByRole("button", { name: "Add page", exact: true }))
    .toHaveCSS("color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Hide PDF pages", exact: true }).click();
  const showPdfPages = page.getByRole("button", { name: "Show PDF pages", exact: true });
  await expect(showPdfPages).toHaveCSS("background-color", "rgb(32, 43, 62)");
  await expect(showPdfPages).toHaveCSS("color", "rgb(231, 237, 247)");
  await showPdfPages.hover();
  await expect(showPdfPages).toHaveCSS("background-color", "rgb(42, 56, 80)");
  await expect(showPdfPages).toHaveCSS("color", "rgb(238, 243, 250)");
  await showPdfPages.click();
  await expect(page.locator("#pdf-page-rail")).toBeVisible();
  const darkThumbnailDimensions = async () => thumbnails.evaluateAll((images) => images.map((node) => {
    const image = node as HTMLImageElement;
    return { height: image.naturalHeight, width: image.naturalWidth };
  }));
  await expect.poll(async () => {
    const dimensions = await darkThumbnailDimensions();
    return dimensions.length === 2
      && dimensions.every(({ height, width }) => Math.max(height, width) <= 256);
  }, { timeout: 30_000 }).toBe(true);

  await expect.poll(async () => {
    const samples = await renderedPdfDisplaySamples(page);
    return samples?.background.every((channel) => channel < 45)
      && samples.vector.every((channel) => channel > 205)
      ? samples
      : null;
  }, { timeout: 30_000 }).not.toBeNull();
  const darkSamples = await renderedPdfDisplaySamples(page);
  expect(darkSamples?.background.every((channel) => channel < 45)).toBe(true);
  expect(darkSamples?.vector.every((channel) => channel > 205)).toBe(true);
  expect(darkSamples?.picture[0]).toBeGreaterThan(150);
  expect(darkSamples?.picture[1]).toBeLessThan(100);
  expect(darkSamples?.picture[2]).toBeGreaterThan(150);
  expect(darkSamples?.pictureAccent[1] || 0).toBeGreaterThan(150);
  expect(darkSamples?.pictureAccent[1] || 0).toBeGreaterThan((darkSamples?.pictureAccent[0] || 0) * 2);
  expect(darkSamples?.pictureAccent[1] || 0).toBeGreaterThan((darkSamples?.pictureAccent[2] || 0) * 2);
  expect(darkSamples?.pictureTransparentVector.every((channel) => channel > 205)).toBe(true);
  expect(darkSamples?.pictureVectorOverlay.every((channel) => channel > 205)).toBe(true);
  await expect.poll(storedPdfRaster, { timeout: 30_000 }).toEqual(lightStored);

  await page.getByRole("button", { name: /Open output page 2:/ }).click();
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toHaveClass(/is-selected/);
  await expect.poll(async () => {
    const samples = await renderedPdfDisplaySamples(page);
    return samples?.background.every((channel) => channel < 45)
      && samples.vector.every((channel) => channel > 205);
  }, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => {
    const dimensions = await darkThumbnailDimensions();
    return dimensions.length === 2
      && dimensions.every(({ height, width }) => Math.max(height, width) <= 256);
  }, { timeout: 30_000 }).toBe(true);
  const readTransientDarkFiles = () => page.evaluate(() => {
    const app = (window as unknown as {
      h?: {
        app?: {
          files?: Record<string, { dataURL?: string }>;
          imageCache?: Map<string, { image?: HTMLImageElement }>;
        };
      };
    }).h?.app;
    const fileIds = Object.keys(app?.files || {}).filter((id) => id.startsWith("patterdraw-dark-pdf"));
    const cachedIds = [...(app?.imageCache?.keys() || [])]
      .filter((id) => id.startsWith("patterdraw-dark-pdf"));
    const file = fileIds[0] ? app?.files?.[fileIds[0]] : undefined;
    const image = cachedIds[0] ? app?.imageCache?.get(cachedIds[0])?.image : undefined;
    return {
      cachedIds,
      dataLength: file?.dataURL?.length || 0,
      fileIds,
      height: image?.naturalHeight || image?.height || null,
      width: image?.naturalWidth || image?.width || null,
    };
  });
  await expect.poll(async () => {
    const value = await readTransientDarkFiles();
    return {
      cachedCount: value.cachedIds.length,
      fileCount: value.fileIds.length,
      sameId: value.cachedIds[0] === value.fileIds[0],
    };
  }).toEqual({ cachedCount: 1, fileCount: 1, sameId: true });
  const transientDarkFiles = await readTransientDarkFiles();
  expect(transientDarkFiles.cachedIds).toEqual(transientDarkFiles.fileIds);
  expect(transientDarkFiles.fileIds[0]).toMatch(/^patterdraw-dark-pdf-[0-9a-f-]{36}$/);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("dialog", { name: "More exports", exact: true })
    .getByRole("button", { name: /Export image…/ })
    .click();
  const nativeDialog = page.locator(".Modal").filter({ has: page.locator(".ImageExportModal") });
  await expect(nativeDialog).toBeVisible();
  await expect(nativeDialog.getByLabel("Dark mode", { exact: true })).not.toBeChecked();
  await expect.poll(async () => {
    const value = await readTransientDarkFiles();
    return {
      cachedCount: value.cachedIds.length,
      fileCount: value.fileIds.length,
      height: value.height,
      placeholderIsSmall: value.dataLength < 1_024,
      sameId: value.cachedIds[0] === value.fileIds[0],
      width: value.width,
    };
  }).toEqual({
    cachedCount: 1,
    fileCount: 1,
    height: 1,
    placeholderIsSmall: true,
    sameId: true,
    width: 1,
  });
  const pngDownloadEvent = page.waitForEvent("download");
  await nativeDialog.getByRole("button", { name: "Export to PNG", exact: true }).click();
  const exportedSamples = await exportedPdfDisplaySamples(
    await downloadBytes(await pngDownloadEvent),
  );
  expect(exportedSamples?.background.every((channel) => channel > 225)).toBe(true);
  expect(exportedSamples?.vector.every((channel) => channel < 40)).toBe(true);
  expect(exportedSamples?.picture[0]).toBeGreaterThan(220);
  expect(exportedSamples?.picture[1]).toBeLessThan(55);
  expect(exportedSamples?.picture[2]).toBeGreaterThan(110);
  expect(exportedSamples?.pictureTransparentVector.every((channel) => channel < 40)).toBe(true);
  expect(exportedSamples?.pictureVectorOverlay.every((channel) => channel < 40)).toBe(true);
  await nativeDialog.locator(".Modal__content").focus();
  await page.keyboard.press("Escape");
  await expect(nativeDialog).toHaveCount(0);
  await expect.poll(async () => {
    const samples = await renderedPdfDisplaySamples(page);
    return samples?.background.every((channel) => channel < 45)
      && samples.vector.every((channel) => channel > 205);
  }, { timeout: 30_000 }).toBe(true);
  await expect.poll(storedPdfRaster, { timeout: 30_000 }).toEqual(lightStored);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await page.keyboard.press("Escape");
  await expect(thumbnail).toHaveAttribute("src", lightThumbnail || "");
  await expect.poll(async () => {
    const samples = await renderedPdfDisplaySamples(page);
    return samples?.background.every((channel) => channel > 225)
      && samples.vector.every((channel) => channel < 40);
  }, { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const app = (window as unknown as {
      h?: {
        app?: {
          files?: Record<string, { dataURL?: string }>;
          imageCache?: Map<string, { image?: HTMLImageElement }>;
        };
      };
    }).h?.app;
    const fileIds = Object.keys(app?.files || {})
      .filter((id) => id.startsWith("patterdraw-dark-pdf"));
    const cachedIds = [...(app?.imageCache?.keys() || [])]
      .filter((id) => id.startsWith("patterdraw-dark-pdf"));
    const file = fileIds[0] ? app?.files?.[fileIds[0]] : undefined;
    const image = cachedIds[0] ? app?.imageCache?.get(cachedIds[0])?.image : undefined;
    return {
      cachedCount: cachedIds.length,
      fileCount: fileIds.length,
      height: image?.naturalHeight || image?.height || null,
      placeholderIsSmall: (file?.dataURL?.length || Number.MAX_SAFE_INTEGER) < 1_024,
      sameId: cachedIds[0] === fileIds[0],
      width: image?.naturalWidth || image?.width || null,
    };
  }), { timeout: 30_000 }).toEqual({
    cachedCount: 1,
    fileCount: 1,
    height: 1,
    placeholderIsSmall: true,
    sameId: true,
    width: 1,
  });
  expect(browserErrors).toEqual([]);
});

test("keeps native image export light when a dark PDF render is still pending", async ({ page }) => {
  test.setTimeout(60_000);
  await useDownloadBasedImageExport(page);
  await openTestPdf(page);
  const saved = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, {
      elements: Array<{ fileId?: string; id: string }>;
      pdfPage?: { backgroundElementId: string };
    }>;
  }>(page, "patterdraw:autosave:project:v1");
  const savedScene = saved?.scenes[saved.activeSceneId];
  const backgroundId = savedScene?.pdfPage?.backgroundElementId;
  const lightFileId = savedScene?.elements.find((element) => element.id === backgroundId)?.fileId;
  expect(backgroundId).toBeTruthy();
  expect(lightFileId).toBeTruthy();

  const workerRoute = "**/*pdf.worker.min*";
  let delayedWorkerRequests = 0;
  await page.route(workerRoute, async (route) => {
    delayedWorkerRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  await expect.poll(() => delayedWorkerRequests).toBeGreaterThan(0);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("dialog", { name: "More exports", exact: true })
    .getByRole("button", { name: /Export image…/ })
    .click();
  const nativeDialog = page.locator(".Modal").filter({ has: page.locator(".ImageExportModal") });
  await expect(nativeDialog).toBeVisible();
  await expect(nativeDialog.getByLabel("Dark mode", { exact: true })).not.toBeChecked();

  await page.waitForTimeout(1_800);
  const liveState = await page.evaluate(({ backgroundId, lightFileId }) => {
    const app = (window as unknown as {
      h?: {
        app?: {
          files?: Record<string, unknown>;
          scene?: { getNonDeletedElement?: (id: string) => { fileId?: string } | null };
        };
      };
    }).h?.app;
    return {
      backgroundIsLight: app?.scene?.getNonDeletedElement?.(backgroundId)?.fileId === lightFileId,
      darkFileCount: Object.keys(app?.files || {})
        .filter((id) => id.startsWith("patterdraw-dark-pdf")).length,
    };
  }, { backgroundId: backgroundId || "", lightFileId: lightFileId || "" });
  expect(liveState).toEqual({ backgroundIsLight: true, darkFileCount: 0 });

  await page.unroute(workerRoute);
  await nativeDialog.locator(".Modal__content").focus();
  await page.keyboard.press("Escape");
  await expect(nativeDialog).toHaveCount(0);
});

test("rejects an oversized embedded PDF image instead of importing a blank page", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.getByLabel("Open project file").setInputFiles({
    name: "oversized-embedded-image.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await oversizedEmbeddedImagePdfBytes()),
  });

  await expect(page.getByRole("alert")).toContainText(
    "This PDF contains an embedded image that is too large to import safely.",
  );
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator("#pdf-page-rail")).toHaveCount(0);
  expect(warnings.some((warning) => warning.includes("Image exceeded maximum allowed size"))).toBe(false);
});

test("detects PDF content when the browser reports a generic MIME type", async ({ page }) => {
  const document = await PDFDocument.create();
  document.addPage([300, 200]);
  await page.getByLabel("Open project file").setInputFiles({
    name: "generic-mime-upload",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(await document.save()),
  });

  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, {
    timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT,
  });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("rejects a spoofed PDF extension before rendering pages", async ({ page }) => {
  await page.getByLabel("Open project file").setInputFiles({
    name: "not-a-document.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("This is not a PDF.", "utf8"),
  });

  await expect(page.getByRole("alert")).toContainText("does not contain a valid PDF header");
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator("#pdf-page-rail")).toHaveCount(0);
});

test("cancels an in-progress PDF import without committing partial pages", async ({ page }) => {
  const document = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) document.addPage([612, 792]);
  const workerRoute = "**/*pdf.worker.min*";
  await page.route(workerRoute, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  await page.getByLabel("Open project file").setInputFiles({
    name: "cancelled-import.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()),
  });
  const cancel = page.locator(".busy-overlay").getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect(page.locator(".busy-overlay")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator("#pdf-page-rail")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
});

test("rejects an oversized inline PDF image instead of importing a blank page", async ({ page }) => {
  await page.getByLabel("Open project file").setInputFiles({
    name: "oversized-inline-image.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await oversizedInlineImagePdfBytes()),
  });

  await expect(page.getByRole("alert")).toContainText(
    "This PDF contains an embedded image that is too large to import safely.",
  );
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator("#pdf-page-rail")).toHaveCount(0);
});

test("allows an unpainted oversized PDF image resource", async ({ page }) => {
  await page.getByLabel("Open project file").setInputFiles({
    name: "unused-oversized-image.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await oversizedEmbeddedImagePdfBytes(false)),
  });

  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: 15_000 });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("merges and synchronizes feature preferences across open tabs", async ({ page }) => {
  const secondPage = await page.context().newPage();
  try {
    await secondPage.goto("/");
    await expect(secondPage.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    await expect(secondPage.getByText("Saved locally", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await secondPage.getByRole("button", { name: "Settings", exact: true }).click();
    const slidesPreference = page.getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("switch", { name: "Slides", exact: true });
    const pdfPreference = secondPage.getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("switch", { name: "PDF", exact: true });
    await Promise.all([
      slidesPreference.uncheck(),
      pdfPreference.uncheck(),
    ]);
    await expect(page.getByRole("button", { name: "Slides", exact: true })).toHaveCount(0);
    await expect(secondPage.getByRole("button", { name: "Slides", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "PDF", exact: true })).toHaveCount(0);
    await expect(secondPage.getByRole("button", { name: "PDF", exact: true })).toHaveCount(0);

    const expected = {
      slides: false,
      pdf: false,
      insert: true,
      mathTools: true,
      library: true,
      footer: true,
      penOnly: false,
      showGrid: false,
      snapToObjects: false,
      sizePosition: true,
      projectFind: true,
      iconOnlyControls: false,
    };
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
    ))).toEqual(expected);
    await expect.poll(() => secondPage.evaluate(() => JSON.parse(
      localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
    ))).toEqual(expected);

    const firstDialog = page.getByRole("dialog", { name: "Settings", exact: true });
    const secondDialog = secondPage.getByRole("dialog", { name: "Settings", exact: true });
    const gridPreference = firstDialog.getByRole("switch", { name: "Show grid", exact: true });
    const snapPreference = secondDialog.getByRole("switch", { name: "Snap to objects", exact: true });
    await Promise.all([
      gridPreference.click(),
      snapPreference.click(),
    ]);
    const readSnappingState = (target: import("@playwright/test").Page) => target.evaluate(() => {
      const aggregate = JSON.parse(
        localStorage.getItem("patterdraw:feature-preferences:v1") || "null",
      ) as { showGrid?: boolean; snapToObjects?: boolean } | null;
      return {
        aggregate,
        grid: localStorage.getItem("patterdraw:feature-preference:v1:showGrid"),
        snap: localStorage.getItem("patterdraw:feature-preference:v1:snapToObjects"),
      };
    });
    await expect.poll(async () => {
      const [first, second] = await Promise.all([
        readSnappingState(page),
        readSnappingState(secondPage),
      ]);
      const firstExclusive = first.aggregate
        && first.aggregate.showGrid !== first.aggregate.snapToObjects
        && first.grid === String(first.aggregate.showGrid)
        && first.snap === String(first.aggregate.snapToObjects);
      return firstExclusive && JSON.stringify(first) === JSON.stringify(second);
    }).toBe(true);
    const snapping = await readSnappingState(page);
    await expect.poll(async () => ({
      firstGrid: await gridPreference.isChecked(),
      firstSnap: await firstDialog.getByRole("switch", { name: "Snap to objects", exact: true }).isChecked(),
      secondGrid: await secondDialog.getByRole("switch", { name: "Show grid", exact: true }).isChecked(),
      secondSnap: await snapPreference.isChecked(),
    })).toEqual({
      firstGrid: snapping.aggregate?.showGrid,
      firstSnap: snapping.aggregate?.snapToObjects,
      secondGrid: snapping.aggregate?.showGrid,
      secondSnap: snapping.aggregate?.snapToObjects,
    });
  } finally {
    await secondPage.close();
  }
});

test("opens legacy .canvasclassroom project archives", async ({ page }) => {
  await openClassroomFixture(page, [], [], "legacy-project.canvasclassroom");
  await expect(page).toHaveTitle("PatterDraw");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
});

test("hydrates changed content when a replacement reuses project and scene IDs", async ({ page }) => {
  await openClassroomFixture(page, [
    exportTestRectangle("same-id-first", 100, 120, 140, 90, "a0"),
  ], [], "same-id-first.patterdraw");
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();

  await openClassroomFixture(page, [
    exportTestRectangle("same-id-replacement", 220, 160, 160, 100, "a0"),
  ], [], "same-id-replacement.patterdraw");
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 600, y: 320 }, { x: 720, y: 400 });

  await expect.poll(async () => {
    const saved = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ id?: string; isDeleted?: boolean; type?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    const elements = saved?.scenes[saved.activeSceneId]?.elements || [];
    return {
      containsFirst: elements.some((element) => element.id === "same-id-first"),
      containsReplacement: elements.some((element) => element.id === "same-id-replacement"),
      liveRectangles: elements.filter(
        (element) => element.type === "rectangle" && element.isDeleted !== true,
      ).length,
    };
  }, { timeout: 15_000 }).toEqual({
    containsFirst: false,
    containsReplacement: true,
    liveRectangles: 2,
  });
});

test("replaces live image bytes when a project reuses its scene and file IDs", async ({ page }) => {
  const fileId = "same-id-image-file";
  const image = {
    ...exportTestRectangle("same-id-image", 180, 150, 260, 180, "a0"),
    type: "image",
    fileId,
    status: "saved",
    scale: [1, 1],
  };
  const redDataURL = solidPngDataUrl("#ff0000");
  const blueDataURL = solidPngDataUrl("#0000ff");
  const importColour = (dataURL: string, name: string) => openClassroomFixture(
    page,
    [image],
    [],
    name,
    undefined,
    {
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: 1,
      },
    },
  );
  const visibleColourPixels = async () => {
    const screenshot = await page.locator(".editor-host").screenshot();
    const rendered = await loadImage(screenshot);
    const canvas = createCanvas(rendered.width, rendered.height);
    const context = canvas.getContext("2d");
    context.drawImage(rendered, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let blue = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 220 && pixels[offset + 1] < 35 && pixels[offset + 2] < 35) red += 1;
      if (pixels[offset] < 35 && pixels[offset + 1] < 35 && pixels[offset + 2] > 220) blue += 1;
    }
    return { red, blue };
  };

  await importColour(redDataURL, "same-id-red.patterdraw");
  await expect.poll(async () => (await visibleColourPixels()).red, {
    timeout: 15_000,
  }).toBeGreaterThan(5_000);

  await importColour(blueDataURL, "same-id-blue.patterdraw");
  await expect.poll(async () => {
    const colours = await visibleColourPixels();
    return colours.blue > 5_000 && colours.red < 500;
  }, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => {
    const saved = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { files: Record<string, { dataURL?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return saved?.scenes[saved.activeSceneId]?.files[fileId]?.dataURL;
  }).toBe(blueDataURL);
});

test("flushes ordinary project-title typing without the trailing autosave delay", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  const title = page.getByRole("textbox", { name: "Project title" });
  await title.fill("Immediate autosav");
  await title.focus();
  await page.keyboard.type("e");

  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title, {
    intervals: [20, 50, 100],
    timeout: 500,
  }).toBe("Immediate autosave");
});

test("retries the latest dirty title during a real page reload", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {
      __reloadAutosaveFailure?: {
        attempts: number;
        failWrites: boolean;
      };
    };
    state.__reloadAutosaveFailure = { attempts: 0, failWrites: true };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      const testState = state.__reloadAutosaveFailure;
      if (key === "patterdraw:autosave:project:v1" && testState) {
        testState.attempts += 1;
        if (testState.failWrites) {
          throw new DOMException("Reload autosave test failure", "QuotaExceededError");
        }
      }
      return originalPut.call(this, value, key);
    };
  });
  const title = page.getByRole("textbox", { name: "Project title" });
  await title.fill("Real page teardown autosav");
  await title.focus();
  await page.keyboard.type("e");
  await expect(page.getByText("Save error", { exact: true })).toBeVisible();
  expect((await keyvalValue<{ title: string }>(
    page,
    "patterdraw:autosave:project:v1",
  ))?.title).not.toBe("Real page teardown autosave");
  await page.evaluate(() => {
    window.addEventListener("beforeunload", () => {
      const state = (window as Window & {
        __reloadAutosaveFailure?: { failWrites: boolean };
      }).__reloadAutosaveFailure;
      if (state) state.failWrites = false;
    });
  });

  page.once("dialog", (dialog) => void dialog.accept());
  await page.reload();

  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(page.getByRole("textbox", { name: "Project title" }))
    .toHaveValue("Real page teardown autosave");
});

test("does not replace an unreadable autosave with a blank project", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  const stored = await keyvalValue<Record<string, unknown>>(
    page,
    "patterdraw:autosave:project:v1",
  );
  if (!stored) throw new Error("The startup autosave was not created.");
  const recoverable = {
    ...stored,
    id: "recoverable-autosave",
    title: "Recoverable classroom work",
    pdfDocuments: {
      missing: {
        id: "missing",
        name: "recoverable.pdf",
        mimeType: "application/pdf",
        byteLength: 4,
        pageCount: 1,
        archivePath: "documents/missing.pdf",
      },
    },
  };
  await setKeyvalValue(page, "patterdraw:autosave:project:v1", recoverable);
  await deleteKeyvalValues(page, ["patterdraw:autosave:pdf:v1:missing"]);

  await page.reload();

  const recoveryNotice = page.getByRole("alert").filter({ hasText: "Autosave is paused" });
  await expect(recoveryNotice).toContainText("Autosave could not be opened");
  await expect(recoveryNotice).toContainText("this temporary board is not saving automatically");
  const title = page.getByRole("textbox", { name: "Project title" });
  await title.fill("Temporary recovery board");
  await page.locator('.statusbar button[aria-label="Zoom in"]').click();
  await expect.poll(async () => (
    await keyvalValue<{ id: string; title: string }>(
      page,
      "patterdraw:autosave:project:v1",
    )
  )).toMatchObject({
    id: "recoverable-autosave",
    title: "Recoverable classroom work",
  });

  page.once("dialog", (dialog) => void dialog.dismiss());
  await recoveryNotice.getByRole("button", { name: "Use this board and resume autosave" }).click();
  await expect(recoveryNotice).toBeVisible();
  await expect.poll(async () => (
    await keyvalValue<{ id: string; title: string }>(
      page,
      "patterdraw:autosave:project:v1",
    )
  )).toMatchObject({
    id: "recoverable-autosave",
    title: "Recoverable classroom work",
  });

  page.once("dialog", (dialog) => void dialog.accept());
  await recoveryNotice.getByRole("button", { name: "Use this board and resume autosave" }).click();
  await expect(recoveryNotice).toBeHidden();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(
      page,
      "patterdraw:autosave:project:v1",
    )
  )).toMatchObject({
    title: "Temporary recovery board",
  });
});

test("coalesces edits made during a slow autosave into one latest follow-up write", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {
      __slowAutosaveTest?: {
        release: () => void;
        requests: number;
      };
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.__slowAutosaveTest = { release, requests: 0 };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, operation: () => Promise<unknown>) => {
          const testState = state.__slowAutosaveTest;
          if (!testState) return operation();
          testState.requests += 1;
          if (testState.requests === 1) await gate;
          return operation();
        },
      },
    });
  });

  const title = page.getByRole("textbox", { name: "Project title" });
  await title.fill("Slow save started");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __slowAutosaveTest?: { requests: number } }
  ).__slowAutosaveTest?.requests || 0)).toBe(1);

  await title.fill("Superseded edit one");
  await title.fill("Superseded edit two");
  await title.fill("Newest coalesced edit");
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (
    window as Window & { __slowAutosaveTest?: { requests: number } }
  ).__slowAutosaveTest?.requests || 0)).toBe(1);

  await page.evaluate(() => (
    window as Window & { __slowAutosaveTest?: { release: () => void } }
  ).__slowAutosaveTest?.release());
  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title).toBe("Newest coalesced edit");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __slowAutosaveTest?: { requests: number } }
  ).__slowAutosaveTest?.requests || 0)).toBe(2);
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (
    window as Window & { __slowAutosaveTest?: { requests: number } }
  ).__slowAutosaveTest?.requests || 0)).toBe(2);
});

test("pauses a stale tab instead of overwriting a newer cross-tab autosave", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  const secondPage = await page.context().newPage();
  try {
    await secondPage.goto(page.url());
    await expect(secondPage.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
    await expect(secondPage.getByText("Saved locally", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      const state = window as Window & {
        __crossTabAutosaveTest?: { release: () => void; requests: number };
      };
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      state.__crossTabAutosaveTest = { release, requests: 0 };
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: {
          request: async (_name: string, operation: () => Promise<unknown>) => {
            const testState = state.__crossTabAutosaveTest;
            if (!testState) return operation();
            testState.requests += 1;
            if (testState.requests === 1) await gate;
            return operation();
          },
        },
      });
    });

    const staleTabTitle = page.getByRole("textbox", { name: "Project title" });
    await staleTabTitle.fill("Unsaved work in stale tab");
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __crossTabAutosaveTest?: { requests: number } }
    ).__crossTabAutosaveTest?.requests || 0)).toBe(1);

    await secondPage.getByRole("textbox", { name: "Project title" })
      .fill("Newer work from second tab");
    await expect.poll(async () => (
      await keyvalValue<{ title: string }>(secondPage, "patterdraw:autosave:project:v1")
    )?.title).toBe("Newer work from second tab");

    await page.evaluate(() => (
      window as Window & { __crossTabAutosaveTest?: { release: () => void } }
    ).__crossTabAutosaveTest?.release());

    const recoveryNotice = page.getByRole("alert").filter({ hasText: "Autosave is paused" });
    await expect(recoveryNotice).toContainText("Another tab saved a newer autosave");
    await expect(staleTabTitle).toHaveValue("Unsaved work in stale tab");
    await staleTabTitle.fill("Still protected in stale tab");
    await page.waitForTimeout(900);
    expect((await keyvalValue<{ title: string }>(
      page,
      "patterdraw:autosave:project:v1",
    ))?.title).toBe("Newer work from second tab");

    page.once("dialog", (dialog) => void dialog.dismiss());
    await recoveryNotice.getByRole("button", { name: "Use this board and resume autosave" }).click();
    await expect(recoveryNotice).toBeVisible();
    expect((await keyvalValue<{ title: string }>(
      page,
      "patterdraw:autosave:project:v1",
    ))?.title).toBe("Newer work from second tab");

    page.once("dialog", (dialog) => void dialog.accept());
    await recoveryNotice.getByRole("button", { name: "Use this board and resume autosave" }).click();
    await expect(recoveryNotice).toBeHidden();
    await expect.poll(async () => (
      await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
    )?.title).toBe("Still protected in stale tab");
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  } finally {
    await secondPage.close();
  }
});

test("queues an urgent page-exit snapshot behind an in-flight save without a timer", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {
      __exitAutosaveTest?: {
        release: () => void;
        requests: number;
        restoreTimers?: () => void;
        zeroDelayTimers?: number;
      };
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.__exitAutosaveTest = { release, requests: 0 };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, operation: () => Promise<unknown>) => {
          const testState = state.__exitAutosaveTest;
          if (!testState) return operation();
          testState.requests += 1;
          if (testState.requests === 1) await gate;
          return operation();
        },
      },
    });
  });

  const title = page.getByRole("textbox", { name: "Project title" });
  await title.fill("Exit save still running");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __exitAutosaveTest?: { requests: number } }
  ).__exitAutosaveTest?.requests || 0)).toBe(1);
  await title.fill("Newest page-exit snapshot");

  await page.evaluate(() => {
    const state = (window as Window & {
      __exitAutosaveTest?: {
        restoreTimers?: () => void;
        zeroDelayTimers?: number;
      };
    }).__exitAutosaveTest;
    if (!state) throw new Error("Exit autosave test state is missing.");
    const originalSetTimeout = window.setTimeout;
    state.zeroDelayTimers = 0;
    state.restoreTimers = () => {
      window.setTimeout = originalSetTimeout;
    };
    window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      if ((timeout || 0) === 0) state.zeroDelayTimers = (state.zeroDelayTimers || 0) + 1;
      return originalSetTimeout(handler, timeout);
    }) as typeof window.setTimeout;
    // Browsers commonly emit several exit-related events for one navigation.
    // Repeating pagehide must not enqueue duplicate full autosave snapshots.
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
  });
  await page.evaluate(() => (
    window as Window & { __exitAutosaveTest?: { release: () => void } }
  ).__exitAutosaveTest?.release());

  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title).toBe("Newest page-exit snapshot");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __exitAutosaveTest?: { requests: number } }
  ).__exitAutosaveTest?.requests || 0)).toBe(2);
  const zeroDelayTimers = await page.evaluate(() => {
    const state = (window as Window & {
      __exitAutosaveTest?: {
        restoreTimers?: () => void;
        zeroDelayTimers?: number;
      };
    }).__exitAutosaveTest;
    state?.restoreTimers?.();
    return state?.zeroDelayTimers || 0;
  });
  expect(zeroDelayTimers).toBe(0);

  // A genuinely newer snapshot after the exit flush must still be persisted;
  // dedupe only covers the tuple already queued for the earlier pagehide.
  await title.fill("Post-exit edit");
  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title).toBe("Post-exit edit");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __exitAutosaveTest?: { requests: number } }
  ).__exitAutosaveTest?.requests || 0)).toBe(3);
});

test("keeps a newly opened project ahead of an older slow autosave", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {
      __openAutosaveRace?: {
        release: () => void;
        requests: number;
      };
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.__openAutosaveRace = { release, requests: 0 };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, operation: () => Promise<unknown>) => {
          const testState = state.__openAutosaveRace;
          if (!testState) return operation();
          testState.requests += 1;
          if (testState.requests === 1) await gate;
          return operation();
        },
      },
    });
  });

  await page.getByRole("textbox", { name: "Project title" })
    .fill("Old project save still running");
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __openAutosaveRace?: { requests: number } }
  ).__openAutosaveRace?.requests || 0)).toBe(1);
  await openClassroomFixture(
    page,
    [],
    [],
    "replacement-after-slow-save.patterdraw",
    async () => {
      await expect(page.locator(".busy-overlay")).toContainText(
        "Saving replacement-after-slow-save.patterdraw locally",
      );
      await page.keyboard.press("ControlOrMeta+f");
      await expect(page.locator(".busy-overlay")).toBeVisible();
      await expect(page.getByRole("searchbox", {
        name: "Find text across project",
        exact: true,
      })).toHaveCount(0);
      await page.evaluate(() => (
        window as Window & {
          __openAutosaveRace?: { release: () => void };
        }
      ).__openAutosaveRace?.release());
    },
  );
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __openAutosaveRace?: { requests: number } }
  ).__openAutosaveRace?.requests || 0)).toBe(2);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Project title" }))
    .toHaveValue("Detached slides fixture");
  await expect.poll(async () => (
    await keyvalValue<{ id: string }>(page, "patterdraw:autosave:project:v1")
  )?.id).toBe("browser-fixture");
});

test("retries a failed replacement autosave without restoring the old project", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Project title" }).fill("Old project");
  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title).toBe("Old project");
  await page.evaluate(() => {
    const state = window as Window & {
      __replacementFailure?: { failures: number };
    };
    state.__replacementFailure = { failures: 0 };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      const replacement = value as { title?: string };
      if (
        key === "patterdraw:autosave:project:v1"
        && replacement?.title === "Replacement retry"
        && state.__replacementFailure?.failures === 0
      ) {
        state.__replacementFailure.failures += 1;
        throw new DOMException("Replacement test failure", "QuotaExceededError");
      }
      return originalPut.call(this, value, key);
    };
  });

  await page.getByLabel("Open project file").setInputFiles({
    name: "replacement.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Replacement retry",
      elements: [],
      appState: {},
      files: {},
    })),
  });

  await expect(page.getByRole("textbox", { name: "Project title" }))
    .toHaveValue("Replacement retry");
  await expect(page.getByText("Save error", { exact: true })).toBeVisible();
  expect((await keyvalValue<{ title: string }>(
    page,
    "patterdraw:autosave:project:v1",
  ))?.title).toBe("Old project");

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title).toBe("Replacement retry");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Project title" }))
    .toHaveValue("Replacement retry");
});

test("keeps failed autosaves dirty and retries the latest snapshot on a later flush", async ({ page }) => {
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {
      __autosaveFailureTest?: {
        attempts: number;
        failWrites: boolean;
      };
    };
    state.__autosaveFailureTest = { attempts: 0, failWrites: true };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      const testState = state.__autosaveFailureTest;
      if (key === "patterdraw:autosave:project:v1" && testState) {
        testState.attempts += 1;
        if (testState.failWrites) {
          throw new DOMException("Test autosave failure", "QuotaExceededError");
        }
      }
      return originalPut.call(this, value, key);
    };
  });

  const title = page.getByRole("textbox", { name: "Project title" });
  await title.fill("Failed autosave snapshot");
  await expect(page.getByText("Save error", { exact: true })).toBeVisible();
  const attemptsAfterFailure = await page.evaluate(() => (
    window as Window & { __autosaveFailureTest?: { attempts: number } }
  ).__autosaveFailureTest?.attempts || 0);
  expect(attemptsAfterFailure).toBeGreaterThan(0);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (
    window as Window & { __autosaveFailureTest?: { attempts: number } }
  ).__autosaveFailureTest?.attempts || 0)).toBe(attemptsAfterFailure);

  const beforeUnloadResult = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const dispatchResult = window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatchResult };
  });
  expect(beforeUnloadResult).toEqual({ defaultPrevented: true, dispatchResult: false });
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __autosaveFailureTest?: { attempts: number } }
  ).__autosaveFailureTest?.attempts || 0)).toBeGreaterThan(attemptsAfterFailure);

  await title.fill("Latest retry snapshot");
  await expect(page.getByText("Save error", { exact: true })).toBeVisible();
  const attemptsBeforeRetry = await page.evaluate(() => (
    window as Window & { __autosaveFailureTest?: { attempts: number } }
  ).__autosaveFailureTest?.attempts || 0);
  await page.evaluate(() => {
    const state = window as Window & {
      __autosaveFailureTest?: {
        attempts: number;
        failWrites: boolean;
      };
    };
    if (state.__autosaveFailureTest) state.__autosaveFailureTest.failWrites = false;
    window.dispatchEvent(new Event("pagehide"));
  });

  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await expect.poll(async () => (
    await keyvalValue<{ title: string }>(page, "patterdraw:autosave:project:v1")
  )?.title).toBe("Latest retry snapshot");
  expect(await page.evaluate(() => (
    window as Window & { __autosaveFailureTest?: { attempts: number } }
  ).__autosaveFailureTest?.attempts || 0)).toBe(attemptsBeforeRetry + 1);
});

test("rejects imported relative image sources without issuing a request", async ({ page }) => {
  const probeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("offline-image-probe")) probeRequests.push(request.url());
  });
  const probeImage = {
    ...exportTestRectangle("relative-image-probe", 100, 100, 200, 120, "a0"),
    type: "image",
    fileId: "relative-image-file",
    status: "saved",
    scale: [1, 1],
  };

  await page.getByLabel("Open project file").setInputFiles({
    name: "relative-image-probe.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [probeImage],
      appState: {},
      files: {
        "relative-image-file": {
          id: "relative-image-file",
          mimeType: "image/png",
          dataURL: "design/editor-concept.png?offline-image-probe=1",
          created: 1,
        },
      },
    })),
  });

  await expect.poll(async () => {
    const autosave = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ id?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return autosave?.scenes[autosave.activeSceneId]?.elements.some(
      (element) => element.id === "relative-image-probe",
    );
  }).toBe(false);
  await page.waitForTimeout(250);
  expect(probeRequests).toEqual([]);
});

test("rejects an oversized native Excalidraw image before hydration or autosave", async ({ page }) => {
  let before: { id: string; title: string } | undefined;
  await expect.poll(async () => {
    before = await keyvalValue<{ id: string; title: string }>(
      page,
      "patterdraw:autosave:project:v1",
    );
    return before;
  }).toBeDefined();
  const image = {
    ...exportTestRectangle("oversized-native-image", 100, 100, 200, 120, "a0"),
    type: "image",
    fileId: "oversized-native-image-file",
    status: "saved",
    scale: [1, 1],
  };
  await page.getByLabel("Open project file").setInputFiles({
    name: "oversized-native-image.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Oversized native image",
      elements: [image],
      appState: {},
      files: {
        [image.fileId]: {
          id: image.fileId,
          mimeType: "image/png",
          dataURL: oversizedPngDataUrl(),
          created: 1,
        },
      },
    })),
  });

  await expect(page.getByRole("alert")).toContainText(/dimensions|decode safely/i);
  await expect.poll(async () => (
    await keyvalValue<{ id: string; title: string }>(page, "patterdraw:autosave:project:v1")
  )).toEqual(before);
  await expect(page.getByRole("textbox", { name: "Project title", exact: true }))
    .not.toHaveValue("Oversized native image");
});

test("preserves a legitimate image that uses the former dark-preview file ID", async ({ page }) => {
  const legacyFileId = "patterdraw-dark-pdf-active-v1";
  const image = {
    ...exportTestRectangle("legacy-dark-id-image", 100, 100, 80, 80, "a0"),
    type: "image",
    fileId: legacyFileId,
    status: "saved",
    scale: [1, 1],
  };
  const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  await page.getByLabel("Open project file").setInputFiles({
    name: "legacy-dark-preview-id.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [image],
      appState: {},
      files: {
        [legacyFileId]: {
          id: legacyFileId,
          mimeType: "image/png",
          dataURL,
          created: 1,
        },
      },
    })),
  });

  await expect.poll(async () => {
    const autosave = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ fileId?: string; id?: string }>;
        files: Record<string, { dataURL?: string }>;
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    const scene = autosave?.scenes[autosave.activeSceneId];
    return {
      elementFileId: scene?.elements.find((element) => element.id === image.id)?.fileId,
      storedDataURL: scene?.files[legacyFileId]?.dataURL,
    };
  }).toEqual({ elementFileId: legacyFileId, storedDataURL: dataURL });
});

test("imports and exports standard Excalidraw libraries without online controls", async ({ page }) => {
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

  const fileActions = page.getByRole("navigation", { name: "File actions" });
  const libraryButton = fileActions.getByRole("button", { name: "Library", exact: true });
  await expect(libraryButton).toBeVisible();
  await expect(page.locator(".editor-host .default-sidebar-trigger")).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Library", exact: true })).toBeHidden();

  let { panel, trigger } = await openLibraryPanel(page);
  await expect(page.locator(".default-sidebar .sidebar-triggers")).toBeVisible();
  await expect(page.locator('.default-sidebar .sidebar-tab-trigger[aria-label="Screenshot Library"]')).toBeVisible();
  await page.locator(".default-sidebar").getByTestId("sidebar-close").click();
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  ({ panel, trigger } = await openLibraryPanel(page));
  await trigger.click();
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  ({ panel, trigger } = await openLibraryPanel(page));
  const emptyLibrary = panel.locator(".library-menu-items__no-items");
  await expect(emptyLibrary.locator(".library-menu-items__no-items__hint")).toBeHidden();
  expect(await emptyLibrary.evaluate((node) => getComputedStyle(node, "::after").content)).toContain(".excalidrawlib");
  expect(await panel.innerText()).not.toContain("public repository");
  await expect(panel.locator(".library-menu-browse-button")).toBeHidden();

  await panel.getByTestId("dropdown-menu-button").click();
  const chooserEvent = page.waitForEvent("filechooser");
  await panel.getByTestId("lib-dropdown--load").click();
  await (await chooserEvent).setFiles({
    name: "downloaded-classroom-shapes.excalidrawlib",
    mimeType: "application/vnd.excalidrawlib+json",
    buffer: standardLibraryBytes(),
  });

  const item = panel.locator(".library-unit__active").first();
  await expect(item.locator(".library-unit__dragger svg")).toBeVisible();
  await expect.poll(async () => (
    await keyvalValue<StoredLibraryItem[]>(page, "patterdraw:library:v1")
  )?.length).toBe(1);

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  ({ panel } = await openLibraryPanel(page));
  const restoredItem = panel.locator(".library-unit__active").first();
  await expect(restoredItem.locator(".library-unit__dragger svg")).toBeVisible();

  await panel.getByTestId("dropdown-menu-button").click();
  const downloadEvent = page.waitForEvent("download");
  await panel.getByTestId("lib-dropdown--export").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("library.excalidrawlib");
  const exported = JSON.parse((await downloadBytes(download)).toString("utf8")) as {
    type: string;
    version: number;
    source: string;
    libraryItems: StoredLibraryItem[];
  };
  expect(exported.type).toBe("excalidrawlib");
  expect(exported.version).toBe(2);
  expect(new URL(exported.source).origin).toBe(new URL(page.url()).origin);
  expect(exported.libraryItems).toHaveLength(1);
  expect(exported.libraryItems[0]).toMatchObject({
    id: "downloaded-library-item",
    status: "published",
    name: "Downloaded classroom shape",
  });
  expect(exported.libraryItems[0].elements[0]).toMatchObject({
    id: "downloaded-library-rectangle",
    type: "rectangle",
  });

  await restoredItem.hover();
  await restoredItem.getByRole("checkbox").click();
  await panel.getByTestId("dropdown-menu-button").click();
  await expect(panel.getByTestId("lib-dropdown--remove")).toBeHidden();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  const libraryBounds = await libraryButton.boundingBox();
  const hideBounds = await page.getByRole("button", { name: "Hide navigation" }).boundingBox();
  expect(libraryBounds).not.toBeNull();
  expect(hideBounds).not.toBeNull();
  expect(libraryBounds?.x || 0).toBeLessThan(hideBounds?.x || 0);
  expect((libraryBounds?.x || 0) + (libraryBounds?.width || 0)).toBeLessThanOrEqual(390);
  const sidebar = page.locator(".default-sidebar");
  const bounds = await sidebar.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x || 0).toBeGreaterThanOrEqual(0);
  expect(bounds?.y || 0).toBeGreaterThanOrEqual(0);
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(390);
  expect((bounds?.y || 0) + (bounds?.height || 0)).toBeLessThanOrEqual(844);
  expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(panel.locator(".library-menu-browse-button")).toBeHidden();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("persists reusable items separately from PatterDraw projects", async ({ page }) => {
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
  const source = exportTestRectangle("library-source-rectangle", 260, 180, 180, 120, "a0");
  await page.getByLabel("Open project file").setInputFiles({
    name: "library-source.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Library project round trip",
      elements: [source],
      appState: { selectedElementIds: { "library-source-rectangle": true } },
      files: {},
    })),
  });

  let { panel, trigger } = await openLibraryPanel(page);
  const pendingItem = panel.locator(".library-unit__active:has(.library-unit__adder)");
  await expect(pendingItem).toHaveCount(1);
  await pendingItem.locator(".library-unit__dragger").click({ force: true });
  await expect.poll(async () => (
    await keyvalValue<StoredLibraryItem[]>(page, "patterdraw:library:v1")
  )?.length).toBe(1);
  await expect.poll(async () => {
    const autosave = await keyvalValue<{
      title: string;
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ type: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return {
      title: autosave?.title,
      rectangles: autosave?.scenes[autosave.activeSceneId]?.elements.filter((element) => element.type === "rectangle").length,
    };
  }).toEqual({ title: "Library project round trip", rectangles: 1 });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(page.getByRole("textbox", { name: "Project title" })).toHaveValue("Library project round trip");
  ({ panel, trigger } = await openLibraryPanel(page));
  const storedItem = panel.locator(".library-unit__active:not(:has(.library-unit__adder))").first();
  await expect(storedItem.locator(".library-unit__dragger svg")).toBeVisible();
  await storedItem.locator(".library-unit__dragger").click({ force: true });

  await expect.poll(async () => {
    const autosave = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ type: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return autosave?.scenes[autosave.activeSceneId]?.elements.filter((element) => element.type === "rectangle").length;
  }).toBe(2);

  if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  const projectDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const projectDownload = await projectDownloadEvent;
  expect(projectDownload.suggestedFilename()).toBe("Library-project-round-trip.patterdraw");
  const projectBytes = await downloadBytes(projectDownload);

  await deleteKeyvalValues(page, [
    "patterdraw:library:v1",
    "patterdraw:autosave:project:v1",
  ]);
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.getByLabel("Open project file").setInputFiles({
    name: projectDownload.suggestedFilename(),
    mimeType: "application/octet-stream",
    buffer: projectBytes,
  });
  await expect.poll(async () => {
    const autosave = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ type: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return autosave?.scenes[autosave.activeSceneId]?.elements.filter((element) => element.type === "rectangle").length;
  }).toBe(2);

  ({ panel } = await openLibraryPanel(page));
  await expect(panel.locator(".library-unit__active")).toHaveCount(0);
  expect(await panel.locator(".library-menu-items__no-items").evaluate(
    (node) => getComputedStyle(node, "::after").content,
  )).toContain(".excalidrawlib");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("captures areas to the clipboard and persists Screenshot Library actions", async ({ page }) => {
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
  await page.addInitScript(() => {
    const state = window as Window & { __screenshotClipboardWrites?: number; __screenshotClipboardBytes?: number };
    state.__screenshotClipboardWrites = 0;
    class ClipboardItemStub {
      readonly types: string[];
      constructor(readonly data: Record<string, Blob | Promise<Blob>>) {
        this.types = Object.keys(data);
      }
      async getType(type: string) { return await this.data[type]; }
    }
    Object.defineProperty(window, "ClipboardItem", { configurable: true, value: ClipboardItemStub });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async write(items: ClipboardItemStub[]) {
          state.__screenshotClipboardWrites = (state.__screenshotClipboardWrites || 0) + 1;
          const blobs = await Promise.all(Object.values(items[0].data));
          state.__screenshotClipboardBytes = blobs.reduce((sum, blob) => sum + blob.size, 0);
        },
      },
    });
  });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });

  let { panel, trigger } = await openScreenshotLibrary(page);
  await panel.getByRole("button", { name: "Capture area", exact: true }).click();
  await expect(page.getByTestId("screenshot-capture-overlay")).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByTestId("screenshot-capture-overlay")).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("screenshot-capture-overlay")).toBeHidden();
  await trigger.click();
  await expect(panel).toBeVisible();

  await captureScreenshotArea(page, { x: 260, y: 190 }, { x: 500, y: 350 });
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({
    count: 1,
    newest: {
      blobType: "image/png",
      sceneWidth: 240,
      sceneHeight: 160,
      width: 480,
      height: 320,
    },
  });
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __screenshotClipboardWrites?: number }
  ).__screenshotClipboardWrites)).toBe(1);
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __screenshotClipboardBytes?: number }
  ).__screenshotClipboardBytes || 0)).toBeGreaterThan(0);
  await expect(page.getByText(/copied to the clipboard and saved to the Screenshot Library/i)).toBeVisible();

  ({ panel, trigger } = await openScreenshotLibrary(page));
  const card = panel.locator(".screenshot-card").first();
  await expect(card.locator("img")).toBeVisible();
  await card.getByRole("button", { name: /^Copy screenshot captured/ }).click();
  await expect.poll(() => page.evaluate(() => (
    window as Window & { __screenshotClipboardWrites?: number }
  ).__screenshotClipboardWrites)).toBe(2);

  const downloadEvent = page.waitForEvent("download");
  await card.getByRole("button", { name: /^Download screenshot captured/ }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^patterdraw-screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z\.png$/);
  expect(pngDimensions(await downloadBytes(download))).toEqual({ width: 480, height: 320 });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  ({ panel } = await openScreenshotLibrary(page));
  await expect(panel.locator(".screenshot-card")).toHaveCount(1);
  await panel.getByRole("button", { name: /^Delete screenshot captured/ }).click();
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({ count: 0 });
  await expect(panel.locator(".screenshot-card")).toHaveCount(0);

  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("keeps denied clipboard captures and inserts them as one undoable project image", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const state = window as Window & { __screenshotClipboardWrites?: number };
    state.__screenshotClipboardWrites = 0;
    class ClipboardItemStub {
      constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
    }
    Object.defineProperty(window, "ClipboardItem", { configurable: true, value: ClipboardItemStub });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write() {
          state.__screenshotClipboardWrites = (state.__screenshotClipboardWrites || 0) + 1;
          return Promise.reject(new DOMException("Denied", "NotAllowedError"));
        },
      },
    });
  });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });

  await captureScreenshotArea(page, { x: 300, y: 220 }, { x: 520, y: 360 });
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({ count: 1 });
  await expect(page.getByText(/Screenshot saved\. Clipboard permission was denied/i)).toBeVisible();
  const stored = await storedScreenshotSummary(page);
  expect(stored.newest?.blobSize || 0).toBeGreaterThan(0);

  const { panel } = await openScreenshotLibrary(page);
  await panel.locator(".screenshot-card-thumbnail").click();
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toEqual({
    centerError: null,
    imageCount: 1,
    insertedImageCount: 1,
    latestCenter: { x: 720, y: 398.5 },
    pngFileCount: 1,
  });
  await expect(page.locator(".editor-host .App-menu__left")).toBeVisible();
  await expect(page.getByText(/Double click the image or press Enter to crop the image/)).toBeVisible();
  await page.locator('.statusbar .footer-history-button[aria-label="Undo"]').click();
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({ imageCount: 0 });
  await page.locator('.statusbar .footer-history-button[aria-label="Redo"]').click();
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({ imageCount: 1 });

  const projectDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const projectDownload = await projectDownloadEvent;
  const projectBytes = await downloadBytes(projectDownload);
  const manifest = JSON.parse(strFromU8(unzipSync(projectBytes)["project.json"])) as Record<string, unknown>;
  expect(manifest).not.toHaveProperty("screenshotLibrary");
  expect(JSON.stringify(manifest)).not.toContain(stored.ids[0]);

  await deleteKeyvalValues(page, [
    "patterdraw:screenshot-library:v1",
    "patterdraw:autosave:project:v1",
  ]);
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.getByLabel("Open project file").setInputFiles({
    name: projectDownload.suggestedFilename(),
    mimeType: "application/octet-stream",
    buffer: projectBytes,
  });
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({ imageCount: 1, pngFileCount: 1 });
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({ count: 0 });

  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("exports the exact board rectangle without separated off-selection objects and supports desktop drag placement", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const blue = exportTestRectangle("selected-blue", 300, 200, 120, 80, "a0");
  const red = {
    ...exportTestRectangle("excluded-red", 800, 200, 120, 80, "a1"),
    backgroundColor: "#ff8787",
  };
  await page.getByLabel("Open project file").setInputFiles({
    name: "separated-screenshot-objects.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [blue, red],
      appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" },
      files: {},
    })),
  });
  await expect.poll(async () => {
    const autosave = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ type?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return autosave?.scenes[autosave.activeSceneId]?.elements.filter((element) => element.type === "rectangle").length;
  }).toBe(2);

  await captureScreenshotArea(page, { x: 280, y: 180 }, { x: 460, y: 320 });
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({
    count: 1,
    newest: { width: 360, height: 280, sceneWidth: 180, sceneHeight: 140 },
  });
  const pixels = await storedScreenshotPixelSummary(page);
  expect(pixels.bluePixels).toBeGreaterThan(20_000);
  expect(pixels.redPixels).toBe(0);

  const { panel } = await openScreenshotLibrary(page);
  const thumbnail = panel.locator(".screenshot-card-thumbnail");
  const canvas = page.locator(".editor-host .excalidraw__canvas.interactive");
  await thumbnail.dragTo(canvas, { targetPosition: { x: 170, y: 410 } });
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({
    imageCount: 1,
    insertedImageCount: 1,
    pngFileCount: 1,
  });
  const placed = await autosavedScreenshotImageSummary(page);
  expect(placed.latestCenter?.x).toBeCloseTo(170, 0);
  expect(placed.latestCenter?.y).toBeCloseTo(410, 0);
  await expect(page.locator(".editor-host .App-menu__left")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("captures a locked PDF background with annotations and inserts on another page center", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await openTestPdf(page, 2);
  await expect.poll(() => autosavedPdfBackgroundPosition(page)).toEqual({ locked: true, x: 0, y: 0 });
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("PDF editor has no bounds.");
  const center = { x: editor.width / 2, y: editor.height / 2 };
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(
    page,
    { x: center.x - 55, y: center.y - 35 },
    { x: center.x + 55, y: center.y + 35 },
  );
  await captureScreenshotArea(
    page,
    { x: center.x - 80, y: center.y - 60 },
    { x: center.x + 80, y: center.y + 60 },
  );
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({ count: 1 });
  const pixels = await storedScreenshotPixelSummary(page);
  expect(pixels.whitePixels).toBeGreaterThan(1_000);
  expect(pixels.darkPixels).toBeGreaterThan(20);

  await page.getByRole("button", { name: "Next PDF page", exact: true }).click();
  await expect(page.locator(".page-status")).toContainText("Page 2 of 2");
  const { panel } = await openScreenshotLibrary(page);
  await panel.locator(".screenshot-card-thumbnail").click();
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({
    centerError: 0,
    imageCount: 2,
    insertedImageCount: 1,
    pngFileCount: 2,
  });
  await expect(page.locator(".editor-host .App-menu__left")).toBeVisible();
  await page.locator('.statusbar .footer-history-button[aria-label="Undo"]').click();
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({
    imageCount: 1,
    insertedImageCount: 0,
  });
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({ count: 1 });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("captures with touch pointer events and click-inserts at 390 by 844", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  const { panel } = await openScreenshotLibrary(page);
  await panel.getByRole("button", { name: "Capture area", exact: true }).click();
  const overlay = page.getByTestId("screenshot-capture-overlay");
  await expect(overlay).toBeVisible();
  await overlay.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const pointer = (type: string, x: number, y: number, buttons: number) => node.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 17,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: bounds.left + x,
      clientY: bounds.top + y,
    }));
    pointer("pointerdown", 55, 160, 1);
    pointer("pointermove", 260, 330, 1);
    pointer("pointerup", 260, 330, 0);
  });
  await expect(overlay).toBeHidden();
  await expect.poll(() => storedScreenshotSummary(page)).toMatchObject({ count: 1 });
  const reopened = await openScreenshotLibrary(page);
  await reopened.panel.locator(".screenshot-card-thumbnail").click();
  await expect.poll(() => autosavedScreenshotImageSummary(page)).toMatchObject({
    imageCount: 1,
    insertedImageCount: 1,
    pngFileCount: 1,
  });
  const sidebar = page.locator(".default-sidebar");
  const bounds = await sidebar.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(390);
  expect(await sidebar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
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

test("strips canvas links and blocks external navigation", async ({ page }) => {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== new URL(page.url()).origin) {
      externalRequests.push(request.url());
    }
  });

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 320, y: 230 }, { x: 560, y: 390 });
  await expect(page.getByRole("button", { name: "Add link", exact: true })).toBeHidden();
  await page.keyboard.press("ControlOrMeta+k");
  const linkInput = page.locator(".excalidraw-hyperlinkContainer-input");
  await expect(linkInput).toBeHidden();

  await expect.poll(() => autosavedWebLink(page)).toEqual({
    link: null,
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
  expect(await page.evaluate(() => window.open("https://example.test/class-resource"))).toBeNull();

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(() => autosavedWebLink(page)).toEqual({
    link: null,
    blockedElementCount: 0,
  });
  expect(externalRequests).toEqual([]);
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

test("moves board zoom and history into the desktop footer without duplicating phone controls", async ({ page }) => {
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
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(page.locator(".editor-host .excalidraw")).toHaveClass(/excalidraw--mobile/);
  await expect(page.locator(".statusbar")).toBeHidden();
  await expect(footerZoom).toBeHidden();
  await expect(page.locator(".statusbar-actions")).toBeHidden();
  const editorBox = await page.locator(".editor-host").boundingBox();
  const nativeBottomIsland = await page.locator(".editor-host .App-bottom-bar .Island").boundingBox();
  expect(editorBox).not.toBeNull();
  expect(nativeBottomIsland).not.toBeNull();
  expect(nativeBottomIsland?.y || 0).toBeGreaterThanOrEqual(editorBox?.y || 0);
  expect((nativeBottomIsland?.y || 0) + (nativeBottomIsland?.height || 0))
    .toBeLessThanOrEqual((editorBox?.y || 0) + (editorBox?.height || 0));
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
  const phoneActions = await page.locator(".statusbar-actions").boundingBox();
  expect(phoneFooter).not.toBeNull();
  await expect(zoomControls).toBeHidden();
  expect(phoneActions).not.toBeNull();
  expect((phoneActions?.x || 0) + (phoneActions?.width || 0))
    .toBeLessThanOrEqual((phoneFooter?.x || 0) + (phoneFooter?.width || 0));
});

test("collapses the Slides navigator and uses it as a dismissible phone drawer", async ({ page }) => {
  const opening = classroomTestFrame("opening-slide", "Opening", 100, 100, 500, 300, "a0", true);
  const practice = classroomTestFrame("practice-slide", "Practice", 700, 100, 500, 300, "a1", true);
  await openClassroomFixture(page, [opening, practice], [
    { id: "opening-record", frameId: opening.id, title: "Opening", titleMode: "custom" },
    { id: "practice-record", frameId: practice.id, title: "Practice", titleMode: "custom" },
  ]);
  const editor = page.locator(".editor-host .excalidraw");
  await editor.evaluate((element) => element.setAttribute("data-slide-drawer-instance", "original"));

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.getByTestId("slide-page-indicator")).toHaveText("Slide 1 of 2");
  await expect(page.getByRole("button", { name: "Previous slide", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Next slide", exact: true }).click();
  await expect(page.getByTestId("slide-page-indicator")).toHaveText("Slide 2 of 2");
  await expect(page.getByRole("button", { name: "Next slide", exact: true })).toBeDisabled();

  const expandedEditor = await page.locator(".editor-region").boundingBox();
  await page.getByRole("button", { name: "Hide slide navigator", exact: true }).click();
  await expect(page.locator("#slide-rail")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveClass(/is-slide-rail-hidden/);
  const collapsedEditor = await page.locator(".editor-region").boundingBox();
  expect((collapsedEditor?.width || 0)).toBeGreaterThan((expandedEditor?.width || 0) + 150);
  await expect(editor).toHaveAttribute("data-slide-drawer-instance", "original");

  await page.getByRole("button", { name: "Show slide navigator", exact: true }).click();
  await expect(page.locator(".slide-thumbnail[aria-current='page'] .slide-caption"))
    .toHaveText("Practice");
  await expect(page.getByRole("button", { name: "Open slide 2: Practice", exact: true }))
    .toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Close slide navigator", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Open slide 1: Opening/ }).click();
  await expect(page.locator("#slide-rail")).toHaveCount(0);
  await expect(page.getByTestId("slide-page-indicator")).toHaveText("Slide 1 of 2");
  await expect(page.locator(".slide-rail-backdrop")).toHaveCount(0);
  await page.getByRole("button", { name: "Show slide navigator", exact: true }).click();
  await page.getByRole("button", { name: "Close slide navigator", exact: true }).click();
  await expect(page.locator("#slide-rail")).toHaveCount(0);
  await expect(editor).toHaveAttribute("data-slide-drawer-instance", "original");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
  await openSlideSettings(page);
  const morph = page.getByRole("button", { name: "Morph", exact: true });
  await expect(morph).toBeVisible();
  await expect(morph).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("slider", { name: "Morph duration", exact: true })).toHaveCount(0);
  await morph.click();
  await expect(morph).toHaveAttribute("aria-pressed", "true");
  const duration = page.getByRole("slider", { name: "Morph duration", exact: true });
  await expect(duration).toHaveValue("650");
  await expect(duration).toHaveAttribute("max", "5000");
  await duration.fill("5000");
  await expect(page.locator(".morph-duration-control output")).toHaveText("5 s");
  await expect.poll(() => autosavedMorphSettings(page)).toEqual({ durationMs: 5_000, enabled: true });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await openSlideSettings(page);
  await expect(page.getByRole("button", { name: "Morph", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Morph duration", exact: true })).toHaveValue("5000");
});

test("cancels Draw slide when leaving Slides mode", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await openSlideSettings(page);
  await page.getByRole("button", { name: "Draw slide", exact: true }).click();
  await expect(page.getByTestId("slide-frame-draw-overlay")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByTestId("slide-frame-draw-overlay")).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.getByTestId("slide-frame-draw-overlay")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();

  const editor = await page.locator(".editor-host").boundingBox();
  expect(editor).not.toBeNull();
  await page.mouse.click((editor?.x || 0) + 300, (editor?.y || 0) + 240);
  await expect.poll(async () => (await autosavedFrameAspectSummary(page))?.frames.length || 0).toBe(0);
});

test("requires Draw slide for each 16:9, 4:3, freeform, and touch slide", async ({ page }) => {
  const editor = page.locator(".editor-host .excalidraw");
  await editor.evaluate((node) => node.setAttribute("data-aspect-frame-instance", "original"));
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await openSlideSettings(page);
  const drawFrame = page.getByRole("button", { name: "Draw slide", exact: true });
  const aspectOptions = page.locator("#slide-frame-aspect-options");
  await expect(aspectOptions).toHaveCount(0);
  await expect(drawFrame).toHaveAttribute("aria-expanded", "false");
  await expect(drawFrame).toHaveAttribute("aria-pressed", "false");

  await drawFrame.click();
  await expect(drawFrame).toHaveAttribute("aria-expanded", "true");
  await expect(drawFrame).toHaveAttribute("aria-pressed", "true");
  await expect(aspectOptions).toBeVisible();
  await expect(aspectOptions).toContainText("Slide shape");
  await expect(aspectOptions).toContainText("Freeform");
  const widescreen = page.getByRole("button", { name: /16:9.*1080p and 4K/ });
  const standard = page.getByRole("button", { name: /4:3.*Old TVs and smartboards/ });
  await expect(widescreen).toHaveAttribute("aria-pressed", "false");
  await expect(standard).toHaveAttribute("aria-pressed", "false");

  await widescreen.click();
  await expect(widescreen).toHaveAttribute("aria-pressed", "true");
  await expect(standard).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => autosavedFrameAspectSummary(page)).toMatchObject({ mode: "16:9" });
  await expect(page.getByText(/16:9 slide ready/i)).toBeVisible();
  const editorBounds = await page.locator(".editor-host").boundingBox();
  expect(editorBounds).not.toBeNull();
  await page.mouse.move((editorBounds?.x || 0) + 500, (editorBounds?.y || 0) + 240);
  await page.mouse.down();
  await page.mouse.move((editorBounds?.x || 0) + 800, (editorBounds?.y || 0) + 440, { steps: 8 });
  const liveWidescreen = page.getByTestId("slide-frame-drag-preview");
  await expect(liveWidescreen).toBeVisible();
  await expect(liveWidescreen).toHaveAttribute("data-aspect-ratio", "16:9");
  const liveWidescreenBounds = await liveWidescreen.boundingBox();
  expect(liveWidescreenBounds).not.toBeNull();
  expect((liveWidescreenBounds?.width || 0) / (liveWidescreenBounds?.height || 1)).toBeCloseTo(16 / 9, 2);
  expect(liveWidescreenBounds?.x || 0).toBeCloseTo((editorBounds?.x || 0) + 500, 0);
  expect(liveWidescreenBounds?.y || 0).toBeCloseTo((editorBounds?.y || 0) + 240, 0);
  await page.mouse.up();
  await expect(liveWidescreen).toBeHidden();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  await expect.poll(async () => {
    const summary = await autosavedFrameAspectSummary(page);
    return summary?.frames[0]?.ratio || 0;
  }).toBeCloseTo(16 / 9, 5);
  const constrained = await autosavedFrameAspectSummary(page);
  expect(constrained?.frames[0]?.width || 0).toBeGreaterThanOrEqual(300);
  expect(constrained?.frames[0]?.height || 0).toBeGreaterThanOrEqual(200);
  await openSlideSettings(page);
  await expect(drawFrame).toHaveAttribute("aria-pressed", "false");
  await expect(aspectOptions).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();

  // Selection gestures do not create another frame until the teacher clicks
  // Draw slide again.
  await page.mouse.move((editorBounds?.x || 0) + 500, (editorBounds?.y || 0) + 500);
  await page.mouse.down();
  await page.mouse.move((editorBounds?.x || 0) + 760, (editorBounds?.y || 0) + 640, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (
    (await autosavedFrameAspectSummary(page))?.frames.length || 0
  )).toBe(1);

  await openSlideSettings(page);
  await drawFrame.click();
  await expect(drawFrame).toHaveAttribute("aria-pressed", "true");
  await expect(widescreen).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move((editorBounds?.x || 0) + 500, (editorBounds?.y || 0) + 500);
  await page.mouse.down();
  await page.mouse.move((editorBounds?.x || 0) + 760, (editorBounds?.y || 0) + 640, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(2);
  await expect.poll(async () => (
    (await autosavedFrameAspectSummary(page))?.frames[1]?.ratio || 0
  )).toBeCloseTo(16 / 9, 5);
  await openSlideSettings(page);
  await expect(drawFrame).toHaveAttribute("aria-pressed", "false");
  await expect(editor).toHaveAttribute("data-aspect-frame-instance", "original");
  await page.locator('.statusbar .footer-history-button[aria-label="Undo"]').click();
  await expect.poll(async () => (
    (await autosavedFrameAspectSummary(page))?.frames.length || 0
  )).toBe(1);
  await page.locator('.statusbar .footer-history-button[aria-label="Redo"]').click();
  await expect.poll(async () => (
    (await autosavedFrameAspectSummary(page))?.frames[1]?.ratio || 0
  )).toBeCloseTo(16 / 9, 5);

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await openSlideSettings(page);
  await expect(page.locator("#slide-frame-aspect-options")).toHaveCount(0);
  await page.getByRole("button", { name: "Draw slide", exact: true }).click();
  const restoredWidescreen = page.getByRole("button", { name: /16:9.*1080p and 4K/ });
  const restoredStandard = page.getByRole("button", { name: /4:3.*Old TVs and smartboards/ });
  await expect(restoredWidescreen).toHaveAttribute("aria-pressed", "true");

  await restoredStandard.click();
  await expect(restoredWidescreen).toHaveAttribute("aria-pressed", "false");
  await expect(restoredStandard).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => autosavedFrameAspectSummary(page)).toMatchObject({ mode: "4:3" });
  await expect(page.getByText(/4:3 slide ready/i)).toBeVisible();
  const restoredEditorBounds = await page.locator(".editor-host").boundingBox();
  expect(restoredEditorBounds).not.toBeNull();
  await page.mouse.move((restoredEditorBounds?.x || 0) + 510, (restoredEditorBounds?.y || 0) + 260);
  await page.mouse.down();
  await page.mouse.move((restoredEditorBounds?.x || 0) + 710, (restoredEditorBounds?.y || 0) + 460, { steps: 8 });
  const liveStandard = page.getByTestId("slide-frame-drag-preview");
  await expect(liveStandard).toBeVisible();
  await expect(liveStandard).toHaveAttribute("data-aspect-ratio", "4:3");
  const liveStandardBounds = await liveStandard.boundingBox();
  expect(liveStandardBounds).not.toBeNull();
  expect((liveStandardBounds?.width || 0) / (liveStandardBounds?.height || 1)).toBeCloseTo(4 / 3, 2);
  await page.mouse.up();
  await expect(liveStandard).toBeHidden();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(3);
  await expect.poll(async () => {
    const summary = await autosavedFrameAspectSummary(page);
    return summary?.frames.length || 0;
  }).toBe(3);
  const fourByThree = await autosavedFrameAspectSummary(page);
  expect(fourByThree?.frames[2]?.ratio || 0).toBeCloseTo(4 / 3, 5);
  await openSlideSettings(page);
  await expect(drawFrame).toHaveAttribute("aria-pressed", "false");

  await drawFrame.click();
  await expect(drawFrame).toHaveAttribute("aria-pressed", "true");
  await restoredStandard.click();
  await expect(restoredStandard).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".slide-frame-aspect-heading")).toContainText("Freeform");
  await expect.poll(() => autosavedFrameAspectSummary(page)).toMatchObject({ mode: "freeform" });
  const freeformBounds = await page.locator(".editor-host").boundingBox();
  expect(freeformBounds).not.toBeNull();
  await page.mouse.move((freeformBounds?.x || 0) + 520, (freeformBounds?.y || 0) + 280);
  await page.mouse.down();
  await page.mouse.move((freeformBounds?.x || 0) + 720, (freeformBounds?.y || 0) + 580, { steps: 8 });
  await expect(page.getByTestId("slide-frame-drag-preview")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(4);
  const freeform = await autosavedFrameAspectSummary(page);
  expect(freeform?.frames[3]?.ratio || 0).not.toBeCloseTo(16 / 9, 2);
  expect(freeform?.frames[3]?.ratio || 0).not.toBeCloseTo(4 / 3, 2);
  await openSlideSettings(page);
  await expect(drawFrame).toHaveAttribute("aria-pressed", "false");

  await page.setViewportSize({ width: 390, height: 844 });
  await drawFrame.click();
  await expect(page.locator("#slide-rail")).toHaveCount(0);
  await page.getByRole("button", { name: "Show slide navigator", exact: true }).click();
  await openSlideSettings(page);
  await expect(page.locator("#slide-frame-aspect-options")).toBeVisible();
  const railBounds = await page.locator("#slide-rail").boundingBox();
  expect(railBounds).not.toBeNull();
  expect((railBounds?.x || 0) + (railBounds?.width || 0)).toBeLessThanOrEqual(390);
  expect(await page.locator("#slide-frame-aspect-options").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator(".slide-frame-aspect-buttons button").evaluateAll((buttons) => (
    buttons.every((button) => button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight)
  ))).toBe(true);

  const mobileWidescreen = page.getByRole("button", { name: /16:9.*1080p and 4K/ });
  await mobileWidescreen.click();
  await expect(mobileWidescreen).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/16:9 slide ready/i)).toBeVisible();
  await page.getByRole("button", { name: "Hide slide navigator", exact: true }).click();
  const mobileEditorBounds = await page.locator(".editor-host").boundingBox();
  expect(mobileEditorBounds).not.toBeNull();
  const drawOverlay = page.getByTestId("slide-frame-draw-overlay");
  const touchEvent = (type: string, x: number, y: number, buttons: number) => drawOverlay.dispatchEvent(type, {
    clientX: (mobileEditorBounds?.x || 0) + x,
    clientY: (mobileEditorBounds?.y || 0) + y,
    pointerId: 91,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons,
    bubbles: true,
  });
  await touchEvent("pointerdown", 370, 500, 1);
  await touchEvent("pointermove", 280, 570, 1);
  const mobilePreview = page.getByTestId("slide-frame-drag-preview");
  await expect(mobilePreview).toBeVisible();
  const mobilePreviewBounds = await mobilePreview.boundingBox();
  expect(mobilePreviewBounds).not.toBeNull();
  expect((mobilePreviewBounds?.width || 0) / (mobilePreviewBounds?.height || 1)).toBeCloseTo(16 / 9, 2);
  expect((mobilePreviewBounds?.x || 0) + (mobilePreviewBounds?.width || 0)).toBeLessThanOrEqual(390);
  await touchEvent("pointerup", 280, 570, 0);
  await expect(mobilePreview).toBeHidden();
  await expect.poll(async () => (
    (await autosavedFrameAspectSummary(page))?.frames.length || 0
  )).toBe(5);
  const mobileFrame = await autosavedFrameAspectSummary(page);
  expect(mobileFrame?.frames[4]?.ratio || 0).toBeCloseTo(16 / 9, 5);

  await page.getByRole("button", { name: "Show slide navigator", exact: true }).click();
  await openSlideSettings(page);
  await expect(drawFrame).toHaveAttribute("aria-pressed", "false");
  await expect(drawFrame).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#slide-frame-aspect-options")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
});

test("migrates detached slides, moves and resizes only the boundary, and keeps native frames native", async ({ page }) => {
  const slide = classroomTestFrame("slide", "Slide 1", 100, 100, 500, 300, "a2");
  const content = exportTestRectangle("content", 220, 180, 120, 80, "a0", "slide");
  const nativeFrame = classroomTestFrame("native-frame", "Working frame", 760, 120, 260, 220, "a4");
  const nativeChild = exportTestRectangle("native-child", 800, 170, 80, 60, "a3", "native-frame");
  await openClassroomFixture(page, [content, slide, nativeChild, nativeFrame], [
    { id: "slide-record", frameId: "slide", title: "Slide 1" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);

  await expect.poll(() => autosavedElementsById(page, ["slide", "content", "native-child"]))
    .toMatchObject({
      slide: { customData: { classroomSlide: { kind: "slide", version: 1 } } },
      content: { frameId: null, x: 220, y: 180 },
      "native-child": { frameId: "native-frame", x: 800, y: 170 },
    });

  const before = await autosavedElementsById(page, ["slide", "content"]);
  const slideBorder = await scenePointInViewport(page, {
    x: before.slide.x,
    y: before.slide.y + before.slide.height / 2,
  });
  await page.mouse.move(slideBorder.x, slideBorder.y);
  await page.mouse.down();
  await page.mouse.move(slideBorder.x + 90, slideBorder.y + 55, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await autosavedElementsById(page, ["slide"])).slide?.x)
    .toBeCloseTo(before.slide.x + 90, 0);
  const moved = await autosavedElementsById(page, ["slide", "content"]);
  expect(moved.slide.y).toBeCloseTo(before.slide.y + 55, 0);
  expect(moved.content).toMatchObject({ x: before.content.x, y: before.content.y, frameId: null });

  const resizeHandle = await scenePointInViewport(page, {
    x: moved.slide.x + moved.slide.width,
    y: moved.slide.y + moved.slide.height,
  });
  await page.mouse.move(resizeHandle.x, resizeHandle.y);
  await page.mouse.down();
  await page.mouse.move(resizeHandle.x + 80, resizeHandle.y + 45, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await autosavedElementsById(page, ["slide"])).slide?.width)
    .toBeGreaterThan(moved.slide.width + 60);
  const resized = await autosavedElementsById(page, ["slide", "content", "native-child"]);
  expect(resized.slide.height).toBeGreaterThan(moved.slide.height + 25);
  expect(resized.content).toMatchObject({ x: before.content.x, y: before.content.y, frameId: null });
  expect(resized["native-child"]).toMatchObject({ frameId: "native-frame", x: 800, y: 170 });

  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-frame").click();
  await dragOnBoard(page, { x: 760, y: 520 }, { x: 980, y: 700 });
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  await expect.poll(async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      slideOrder: unknown[];
      scenes: Record<string, { elements: Array<{ customData?: { classroomSlide?: unknown }; isDeleted?: boolean; type?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    const frames = project?.scenes[project.activeSceneId]?.elements.filter(
      (element) => element.type === "frame" && !element.isDeleted,
    ) || [];
    return {
      frameCount: frames.length,
      nativeCount: frames.filter((frame) => !frame.customData?.classroomSlide).length,
      slideCount: project?.slideOrder.length || 0,
    };
  }).toEqual({ frameCount: 3, nativeCount: 2, slideCount: 1 });
});

test("uses native grouping, movement, undo redo, ungroup, and whole-group deletion without slide ownership", async ({ page }) => {
  const slide = classroomTestFrame("slide", "Slide 1", 100, 100, 500, 300, "a1");
  const content = exportTestRectangle("content", 220, 180, 120, 80, "a0");
  await openClassroomFixture(page, [content, slide], [
    { id: "slide-record", frameId: "slide", title: "Slide 1" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect.poll(() => autosavedElementsById(page, ["slide", "content"]))
    .toMatchObject({ content: { frameId: null } });

  const initial = await autosavedElementsById(page, ["slide", "content"]);
  const slideBorder = await scenePointInViewport(page, {
    x: initial.slide.x,
    y: initial.slide.y + initial.slide.height / 2,
  });
  const contentCenter = await scenePointInViewport(page, {
    x: initial.content.x + initial.content.width / 2,
    y: initial.content.y + initial.content.height / 2,
  });
  await page.mouse.click(slideBorder.x, slideBorder.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(contentCenter.x, contentCenter.y);
  await page.keyboard.up("Shift");
  await page.keyboard.press("ControlOrMeta+g");
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "content"]);
    return {
      contentFrameId: state.content?.frameId,
      contentGroups: state.content?.groupIds.length || 0,
      sameGroup: state.slide?.groupIds[0] === state.content?.groupIds[0],
    };
  }).toEqual({ contentFrameId: null, contentGroups: 1, sameGroup: true });

  await page.mouse.move(contentCenter.x, contentCenter.y);
  await page.mouse.down();
  await page.mouse.move(contentCenter.x + 50, contentCenter.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "content"]);
    return {
      content: [state.content?.x, state.content?.y],
      slide: [state.slide?.x, state.slide?.y],
    };
  }).toEqual({
    content: [initial.content.x + 50, initial.content.y + 30],
    slide: [initial.slide.x + 50, initial.slide.y + 30],
  });

  const undo = page.locator('.statusbar .footer-history-button[aria-label="Undo"]');
  await undo.click();
  await expect.poll(async () => (await autosavedElementsById(page, ["slide"])).slide?.x).toBe(initial.slide.x);
  const redo = page.locator('.statusbar .footer-history-button[aria-label="Redo"]');
  await redo.click();
  await expect.poll(async () => (await autosavedElementsById(page, ["slide"])).slide?.x).toBe(initial.slide.x + 50);
  const ungroup = page.getByRole("button", { name: "Ungroup selection", exact: true });
  await expect(ungroup).toBeVisible();
  await ungroup.click();
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "content"]);
    return [state.slide?.groupIds.length || 0, state.content?.groupIds.length || 0];
  }).toEqual([0, 0]);

  const regroupedContent = await scenePointInViewport(page, {
    x: initial.content.x + initial.content.width / 2 + 50,
    y: initial.content.y + initial.content.height / 2 + 30,
  });
  const group = page.getByRole("button", { name: "Group selection", exact: true });
  await expect(group).toBeVisible();
  await group.click();
  await page.mouse.click(regroupedContent.x, regroupedContent.y);
  await page.keyboard.press("Delete");
  await expect(page.locator(".slide-thumbnail")).toHaveCount(0);
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "content"]);
    return [state.slide?.isDeleted ?? true, state.content?.isDeleted ?? true];
  }).toEqual([true, true]);
});

test("groups a slide with an ordinary frame while preserving the frame's child ownership", async ({ page }) => {
  const slide = classroomTestFrame("slide", "Slide 1", 100, 100, 400, 240, "a2", true);
  const nativeFrame = classroomTestFrame("native-frame", "Examples", 650, 150, 250, 180, "a1");
  const nativeChild = exportTestRectangle("native-child", 700, 200, 80, 60, "a0", "native-frame");
  await openClassroomFixture(page, [nativeChild, nativeFrame, slide], [
    { id: "slide-record", frameId: "slide", title: "Slide 1" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "native-frame", "native-child"]);
    return Object.keys(state).sort();
  }).toEqual(["native-child", "native-frame", "slide"]);

  const initial = await autosavedElementsById(page, ["slide", "native-frame", "native-child"]);
  const slideBorder = await scenePointInViewport(page, {
    x: initial.slide.x,
    y: initial.slide.y + initial.slide.height / 2,
  });
  const nativeBorder = await scenePointInViewport(page, {
    x: initial["native-frame"].x,
    y: initial["native-frame"].y + initial["native-frame"].height / 2,
  });
  await page.mouse.click(slideBorder.x, slideBorder.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(nativeBorder.x, nativeBorder.y);
  await page.keyboard.up("Shift");
  await page.keyboard.press("ControlOrMeta+g");
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "native-frame", "native-child"]);
    return {
      framesShareGroup: state.slide?.groupIds[0] === state["native-frame"]?.groupIds[0],
      childFrameId: state["native-child"]?.frameId,
      childGroups: state["native-child"]?.groupIds.length || 0,
    };
  }).toEqual({ framesShareGroup: true, childFrameId: "native-frame", childGroups: 0 });

  await page.mouse.move(nativeBorder.x, nativeBorder.y);
  await page.mouse.down();
  await page.mouse.move(nativeBorder.x + 60, nativeBorder.y + 25, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "native-frame", "native-child"]);
    return {
      slide: [state.slide?.x, state.slide?.y],
      nativeFrame: [state["native-frame"]?.x, state["native-frame"]?.y],
      nativeChild: [state["native-child"]?.x, state["native-child"]?.y, state["native-child"]?.frameId],
    };
  }).toEqual({
    slide: [initial.slide.x + 60, initial.slide.y + 25],
    nativeFrame: [initial["native-frame"].x + 60, initial["native-frame"].y + 25],
    nativeChild: [initial["native-child"].x + 60, initial["native-child"].y + 25, "native-frame"],
  });
});

test("rail deletion removes a grouped slide boundary but preserves and ungroups its content", async ({ page }) => {
  const slide = classroomTestFrame("slide", "Slide 1", 100, 100, 500, 300, "a1", true);
  const content = exportTestRectangle("content", 220, 180, 120, 80, "a0");
  slide.groupIds = ["slide-group"];
  content.groupIds = ["slide-group"];
  await openClassroomFixture(page, [content, slide], [
    { id: "slide-record", frameId: "slide", title: "Slide 1" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.locator(".slide-thumbnail").click();
  await page.getByRole("button", { name: /Slide 1 actions:/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "Delete slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(0);
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["slide", "content"]);
    return {
      contentDeleted: state.content?.isDeleted ?? true,
      contentFrameId: state.content?.frameId,
      contentGroups: state.content?.groupIds || [],
      slideExists: Boolean(state.slide),
    };
  }).toEqual({ contentDeleted: false, contentFrameId: null, contentGroups: [], slideExists: false });
});

test("deleting an unselected slide preserves the current slide and editor selection", async ({ page }) => {
  const opening = classroomTestFrame("opening-slide", "Opening", 100, 100, 500, 300, "a1", true);
  const practice = classroomTestFrame("practice-slide", "Practice", 700, 100, 500, 300, "a2", true);
  const content = exportTestRectangle("opening-content", 220, 180, 120, 80, "a0");
  await openClassroomFixture(page, [content, opening, practice], [
    { id: "opening-record", frameId: opening.id, title: "Opening", titleMode: "custom" },
    { id: "practice-record", frameId: practice.id, title: "Practice", titleMode: "custom" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Open slide 1: Opening", exact: true }).click();
  await expect(async () => {
    const contentPoint = await liveScenePointInViewport(page, {
      x: content.x + content.width / 2,
      y: content.y + content.height / 2,
    });
    await page.mouse.click(contentPoint.x, contentPoint.y);
    expect(await page.evaluate((elementId) => {
      const app = (window as unknown as {
        h?: { app?: { state?: { selectedElementIds?: Record<string, boolean> } } };
      }).h?.app;
      return Boolean(app?.state?.selectedElementIds?.[elementId]);
    }, content.id)).toBe(true);
  }).toPass({ timeout: 5_000 });

  await page.getByRole("button", { name: "Slide 2 actions: Practice", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Delete slide", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());

  await expect(page.locator(".slide-thumbnail .slide-caption")).toHaveText(["Opening"]);
  await expect(page.getByRole("button", { name: "Open slide 1: Opening", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect.poll(() => page.evaluate((elementId) => {
    const app = (window as unknown as {
      h?: { app?: { state?: { selectedElementIds?: Record<string, boolean> } } };
    }).h?.app;
    return Boolean(app?.state?.selectedElementIds?.[elementId]);
  }, content.id)).toBe(true);
});

test("commits a pending keyboard edit before deleting its slide boundary", async ({ page }) => {
  const slide = classroomTestFrame("pending-slide", "Pending slide", 100, 100, 500, 300, "a1", true);
  const content = exportTestRectangle("pending-content", 250, 200, 100, 70, "a0");
  await openClassroomFixture(page, [content, slide], [
    { id: "pending-slide-record", frameId: slide.id, title: "Pending slide" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.locator(".slide-thumbnail").click();
  // focusSlide animates the viewport. Recalculate from the live editor state
  // until the intended shape is selected instead of relying on stale IDB
  // appState while the animation is still moving.
  await expect(async () => {
    const contentPoint = await liveScenePointInViewport(page, {
      x: content.x + content.width / 2,
      y: content.y + content.height / 2,
    });
    await page.mouse.click(contentPoint.x, contentPoint.y);
    expect(await page.evaluate((elementId) => {
      const app = (window as unknown as {
        h?: {
          app?: {
            state?: { selectedElementIds?: Record<string, boolean> };
          };
        };
      }).h?.app;
      return Boolean(app?.state?.selectedElementIds?.[elementId]);
    }, content.id)).toBe(true);
  }).toPass({ timeout: 5_000 });
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => (
      nativeSetTimeout(handler, delay === 150 ? 5_000 : delay, ...args)
    )) as typeof window.setTimeout;
  });

  await page.keyboard.down("ArrowRight");
  await expect.poll(() => page.evaluate((elementId) => {
    const app = (window as unknown as {
      h?: {
        app?: {
          scene?: {
            getNonDeletedElement?: (id: string) => { x?: number } | null;
          };
        };
      };
    }).h?.app;
    return app?.scene?.getNonDeletedElement?.(elementId)?.x;
  }, content.id)).toBe(content.x + 1);
  await page.getByRole("button", { name: /Slide 1 actions:/ })
    .evaluate((button: HTMLButtonElement) => button.click());
  const slideDelete = page.getByRole("menuitem", { name: "Delete slide", exact: true });
  page.once("dialog", (dialog) => void dialog.accept());
  await slideDelete.evaluate((button: HTMLButtonElement) => button.click());
  await page.keyboard.up("ArrowRight");

  await expect(page.locator(".slide-thumbnail")).toHaveCount(0);
  await expect.poll(async () => {
    const state = await autosavedElementsById(page, ["pending-slide", "pending-content"]);
    return {
      contentX: state["pending-content"]?.x,
      slideExists: Boolean(state["pending-slide"]),
    };
  }, { timeout: 15_000 }).toEqual({
    contentX: content.x + 1,
    slideExists: false,
  });
});

test("reorders slides with visible keyboard and touch controls", async ({ page }) => {
  const opening = classroomTestFrame("opening-slide", "Opening", 100, 100, 500, 300, "a0", true);
  const practice = classroomTestFrame("practice-slide", "Practice", 700, 100, 500, 300, "a1", true);
  await openClassroomFixture(page, [opening, practice], [
    { id: "opening-record", frameId: "opening-slide", title: "Opening", titleMode: "custom" },
    { id: "practice-record", frameId: "practice-slide", title: "Practice", titleMode: "custom" },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Slides", exact: true }).click();

  const captions = page.locator(".slide-thumbnail .slide-caption");
  const liveAnnouncement = page.locator("#slide-rail [aria-live='polite']");
  await expect(captions).toHaveText(["Opening", "Practice"]);
  await page.getByRole("button", { name: "Slide 1 actions: Opening", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move earlier", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Slide 2 actions: Practice", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move later", exact: true })).toBeDisabled();

  const movePracticeEarlier = page.getByRole("menuitem", { name: "Move earlier", exact: true });
  await expect(movePracticeEarlier).toBeVisible();
  await movePracticeEarlier.focus();
  await movePracticeEarlier.press("Enter");
  await expect(captions).toHaveText(["Practice", "Opening"]);
  await expect(liveAnnouncement).toHaveText("Moved Practice to slide position 1.");
  await page.getByRole("button", { name: "Slide 1 actions: Practice", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Move earlier", exact: true })).toBeDisabled();

  const movePracticeLater = page.getByRole("menuitem", { name: "Move later", exact: true });
  await expect(movePracticeLater).toBeVisible();
  await movePracticeLater.click();
  await expect(captions).toHaveText(["Opening", "Practice"]);
  await expect(liveAnnouncement).toHaveText("Moved Practice to slide position 2.");
});

test("applies consecutive slide drops to the latest order", async ({ page }) => {
  const opening = classroomTestFrame("rapid-opening", "Opening", 100, 100, 500, 300, "a0", true);
  const practice = classroomTestFrame("rapid-practice", "Practice", 700, 100, 500, 300, "a1", true);
  const review = classroomTestFrame("rapid-review", "Review", 1_300, 100, 500, 300, "a2", true);
  await openClassroomFixture(page, [opening, practice, review], [
    { id: "rapid-opening-record", frameId: opening.id, title: "Opening", titleMode: "custom" },
    { id: "rapid-practice-record", frameId: practice.id, title: "Practice", titleMode: "custom" },
    { id: "rapid-review-record", frameId: review.id, title: "Review", titleMode: "custom" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();

  await page.locator(".slide-thumbnail").evaluateAll((cards) => {
    const dispatchDrop = (target: Element, movingId: string) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-patterdraw-slide", movingId);
      dataTransfer.setData("text/plain", movingId);
      target.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
    };
    const [openingCard, practiceCard, reviewCard] = cards;
    dispatchDrop(openingCard, "rapid-review-record");
    dispatchDrop(reviewCard, "rapid-practice-record");
  });

  await expect(page.locator(".slide-thumbnail .slide-caption"))
    .toHaveText(["Practice", "Review", "Opening"]);
  await expect.poll(async () => {
    const saved = await keyvalValue<{ slideOrder: Array<{ id: string }> }>(
      page,
      "patterdraw:autosave:project:v1",
    );
    return saved?.slideOrder.map((slide) => slide.id);
  }).toEqual(["rapid-practice-record", "rapid-review-record", "rapid-opening-record"]);
});

test("preserves custom slide names through reorder, PDF and PowerPoint export, and project round trip", async ({ page }) => {
  const automatic = classroomTestFrame("automatic-slide", "Slide 1", 100, 100, 500, 300, "a2", true);
  const custom = classroomTestFrame("custom-slide", "Slide 10", 700, 100, 500, 300, "a3", true);
  const automaticContent = exportTestRectangle("automatic-content", 220, 180, 120, 80, "a0");
  const customContent = exportTestRectangle("custom-content", 820, 180, 120, 80, "a1");
  await openClassroomFixture(page, [automaticContent, customContent, automatic, custom], [
    { id: "automatic-record", frameId: "automatic-slide", title: "Slide 1" },
    { id: "custom-record", frameId: "custom-slide", title: "Slide 10", titleMode: "custom" },
  ]);
  await page.getByRole("button", { name: "Slides", exact: true }).click();

  const captions = page.locator(".slide-thumbnail .slide-caption");
  await expect(captions).toHaveText(["Slide 1", "Slide 10"]);
  const cards = page.locator(".slide-thumbnail");
  await cards.nth(1).dragTo(cards.nth(0));
  await expect(captions).toHaveText(["Slide 10", "Slide 2"]);
  await expect.poll(async () => {
    const project = await keyvalValue<{
      slideOrder: Array<{ frameId: string; title: string }>;
    }>(page, "patterdraw:autosave:project:v1");
    return project?.slideOrder.map((slide) => [slide.frameId, slide.title]);
  }).toEqual([
    ["custom-slide", "Slide 10"],
    ["automatic-slide", "Slide 2"],
  ]);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "More exports", exact: true })
    .getByRole("button", { name: /Presentation PDF/ })
    .click();
  const exportedPdf = await PDFDocument.load(await downloadBytes(await pdfDownload));
  expect(exportedPdf.getPageCount()).toBe(2);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pptxDownloadEvent = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "More exports", exact: true })
    .getByRole("button", { name: /PowerPoint \(\.pptx\)/ })
    .click();
  const pptxDownload = await pptxDownloadEvent;
  expect(pptxDownload.suggestedFilename()).toBe("Detached-slides-fixture-slides.pptx");
  const pptxArchive = unzipSync(new Uint8Array(await downloadBytes(pptxDownload)));
  expect(Object.keys(pptxArchive).sort()).toEqual(expect.arrayContaining([
    "[Content_Types].xml",
    "ppt/presentation.xml",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
  ]));
  const contentTypesXml = strFromU8(pptxArchive["[Content_Types].xml"]);
  const presentationXml = strFromU8(pptxArchive["ppt/presentation.xml"]);
  expect(contentTypesXml).toContain("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
  expect(contentTypesXml).toContain("application/vnd.openxmlformats-officedocument.presentationml.slide+xml");
  expect(presentationXml.match(/<p:sldId\b/g)).toHaveLength(2);
  expect(presentationXml).toMatch(/<p:sldSz\b[^>]*cx="9144000"[^>]*cy="5143500"/);

  const slideEntries = Object.entries(pptxArchive)
    .filter(([path]) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  expect(slideEntries).toHaveLength(2);
  expect(strFromU8(slideEntries[0][1])).toContain('descr="Slide 10"');
  expect(strFromU8(slideEntries[1][1])).toContain('descr="Slide 2"');

  const mediaEntries = Object.entries(pptxArchive)
    .filter(([path]) => path.startsWith("ppt/media/") && path.endsWith(".png"))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  expect(mediaEntries).toHaveLength(2);
  expect(mediaEntries.map(([, bytes]) => pngDimensions(Buffer.from(bytes))))
    .toEqual([{ width: 1_000, height: 600 }, { width: 1_000, height: 600 }]);
  for (const [path, bytes] of Object.entries(pptxArchive)) {
    if (!path.endsWith(".rels")) continue;
    expect(strFromU8(bytes), `${path} must not reference external content`)
      .not.toContain('TargetMode="External"');
  }

  await openSlideSettings(page);
  const drawSlide = page.getByRole("button", { name: "Draw slide", exact: true });
  await drawSlide.click();
  await page.getByRole("button", { name: /4:3.*Old TVs and smartboards/ }).click();
  await expect.poll(() => autosavedFrameAspectSummary(page)).toMatchObject({ mode: "4:3" });
  await drawSlide.click();
  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const standardPptxDownloadEvent = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "More exports", exact: true })
    .getByRole("button", { name: /PowerPoint \(\.pptx\)/ })
    .click();
  const standardPptxArchive = unzipSync(new Uint8Array(
    await downloadBytes(await standardPptxDownloadEvent),
  ));
  const standardPresentationXml = strFromU8(standardPptxArchive["ppt/presentation.xml"]);
  expect(standardPresentationXml.match(/<p:sldId\b/g)).toHaveLength(2);
  expect(standardPresentationXml).toMatch(/<p:sldSz\b[^>]*cx="9144000"[^>]*cy="6858000"/);
  expect(Object.keys(standardPptxArchive).filter((path) => (
    path.startsWith("ppt/media/") && path.endsWith(".png")
  ))).toHaveLength(2);

  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedBytes = await downloadBytes(await projectDownload);
  const savedArchive = unzipSync(new Uint8Array(savedBytes));
  const savedProject = JSON.parse(strFromU8(savedArchive["project.json"])) as {
    activeSceneId: string;
    slideOrder: Array<{ frameId: string; title: string }>;
    scenes: Record<string, { elements: Array<{ id: string; name?: string }> }>;
  };
  expect(savedProject.slideOrder.map((slide) => [slide.frameId, slide.title])).toEqual([
    ["custom-slide", "Slide 10"],
    ["automatic-slide", "Slide 2"],
  ]);
  expect(Object.fromEntries(
    savedProject.scenes[savedProject.activeSceneId].elements
      .filter((element) => element.id === "custom-slide" || element.id === "automatic-slide")
      .map((element) => [element.id, element.name]),
  )).toEqual({
    "automatic-slide": "Slide 2",
    "custom-slide": "Slide 10",
  });

  await page.reload();
  await page.getByLabel("Open project file").setInputFiles({
    name: "reordered-slides.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: savedBytes,
  });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".slide-thumbnail .slide-caption"))
    .toHaveText(["Slide 10", "Slide 2"]);
});

test("toggles slide frames for a cleaner board without removing slides", async ({ page }) => {
  const editor = page.locator(".editor-host .excalidraw");
  await editor.evaluate((element) => element.setAttribute("data-frame-toggle-instance", "original"));
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);

  await openSlideSettings(page);
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
  await openSlideSettings(page);
  await page.getByRole("button", { name: "Show slide frames", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide slide frames", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => autosavedFrameVisibility(page)).toBe(true);
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
});

test("deletes the selected slide frame while preserving its board content", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Delete slide", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  const selectedSlideWrap = page.locator(".slide-thumbnail-wrap").filter({
    has: page.locator(".slide-thumbnail.is-selected"),
  });
  await selectedSlideWrap.getByRole("button", { name: /Slide 1 actions:/ }).click();
  const slideDelete = selectedSlideWrap.getByRole("menuitem", { name: "Delete slide", exact: true });
  await expect(slideDelete).toBeVisible();
  await expect(slideDelete).toContainText("Delete slide");
  await expect(slideDelete.locator("svg")).toHaveCount(1);

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragNearBoardCenter(page);
  await expect.poll(() => autosavedSlideDeletion(page)).toMatchObject({
    slideCount: 1,
    frameCount: 1,
    rectangleCount: 1,
    framedRectangleCount: 0,
  });

  await selectedSlideWrap.getByRole("button", { name: /Slide 1 actions:/ }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("The frame will be removed, but its board content will stay.");
    await dialog.accept();
  });
  await slideDelete.click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete slide", exact: true })).toHaveCount(0);
  await expect.poll(() => autosavedSlideDeletion(page), { timeout: 8_000 }).toEqual({
    slideCount: 0,
    frameCount: 0,
    rectangleCount: 1,
    framedRectangleCount: 0,
  });

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
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
    customData: { classroomSlide: { kind: "slide", version: 1 } },
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
    customData: { classroomSlide: { kind: "slide", version: 1 } },
    index: "a2",
  };
  await page.getByLabel("Open project file").setInputFiles({
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
    customData: { classroomSlide: { kind: "slide", version: 1 } },
    index,
  });
  await page.getByLabel("Open project file").setInputFiles({
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
  await openSlideSettings(page);
  const morph = page.getByRole("button", { name: "Morph", exact: true });
  await expect(morph).toHaveAttribute("aria-pressed", "false");
  await morph.click();
  await expect(morph).toHaveAttribute("aria-pressed", "true");
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

test("keeps presentation navigation keys active after toolbar controls receive focus", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  const addSlide = page.getByRole("button", { name: "Add slide", exact: true });
  await addSlide.click();
  await addSlide.click();
  await addSlide.click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(3);
  await page.locator(".slide-thumbnail").first().click();

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 3");

  const nextSlide = page.getByRole("button", { name: "Next slide", exact: true });
  await nextSlide.click();
  await expect(page.locator(".presentation-count")).toHaveText("2 / 3");
  await expect(nextSlide).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".presentation-count")).toHaveText("3 / 3");

  const ink = page.getByRole("button", { name: "Ink", exact: true });
  await ink.click();
  await expect(ink).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.locator(".presentation-count")).toHaveText("1 / 3");
});

test("commits pending edits before presentation switches between project scenes", async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => (
      nativeSetTimeout(handler, delay === 150 ? 5_000 : delay, ...args)
    )) as typeof window.setTimeout;
  });

  const frameA = classroomTestFrame("frame-a", "Scene A", 0, 0, 960, 540, "a0", true);
  const frameB = classroomTestFrame("frame-b", "Scene B", 0, 0, 960, 540, "a0", true);
  const scene = (id: string, name: string, frame: Record<string, unknown>) => ({
    id,
    name,
    elements: [frame],
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" },
    files: {},
  });
  const project = {
    schemaVersion: 1,
    id: "presentation-scene-boundary",
    title: "Presentation scene boundary",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    activeSceneId: "scene-a",
    scenes: {
      "scene-a": scene("scene-a", "Scene A", frameA),
      "scene-b": scene("scene-b", "Scene B", frameB),
    },
    slideOrder: [
      { id: "slide-a", frameId: "frame-a", sceneId: "scene-a", title: "Scene A", titleMode: "custom" },
      { id: "slide-b", frameId: "frame-b", sceneId: "scene-b", title: "Scene B", titleMode: "custom" },
    ],
    slideFramesVisible: true,
    slideFrameAspectRatio: "16:9",
    slideMorphEnabled: false,
    pdfPageOrder: [],
    pdfDocuments: {},
  };
  await page.getByLabel("Open project file").setInputFiles({
    name: "presentation-scene-boundary.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: Buffer.from(zipSync({ "project.json": strToU8(JSON.stringify(project)) })),
  });
  await expect.poll(async () => (
    await keyvalValue<{ id: string }>(page, "patterdraw:autosave:project:v1")
  )?.id).toBe(project.id);
  await expect(page.locator(".busy-overlay")).toHaveCount(0);

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(2);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 2");
  await page.getByRole("button", { name: "Ink", exact: true }).click();
  const bounds = await page.locator(".editor-host").boundingBox();
  if (!bounds) throw new Error("Editor host has no visible bounds.");
  const drawStroke = async (xRatio: number) => {
    await page.mouse.move(bounds.x + bounds.width * xRatio, bounds.y + bounds.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * xRatio,
      bounds.y + bounds.height * 0.58,
      { steps: 6 },
    );
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  };

  await drawStroke(0.4);
  await page.keyboard.down("ArrowRight");
  await expect(page.locator(".presentation-count")).toHaveText("2 / 2");
  await drawStroke(0.6);
  await page.keyboard.up("ArrowRight");

  await expect.poll(async () => {
    const saved = await keyvalValue<{
      scenes: Record<string, { elements: Array<{ type?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return saved ? {
      sceneAInk: saved.scenes["scene-a"].elements.filter((element) => element.type === "freedraw").length,
      sceneBInk: saved.scenes["scene-b"].elements.filter((element) => element.type === "freedraw").length,
    } : null;
  }, { timeout: 15_000 }).toEqual({ sceneAInk: 1, sceneBInk: 1 });
});

test("exits presentation when Escape ends its native fullscreen session", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  // Native browsers can consume Escape themselves and only notify the app
  // through fullscreenchange, without delivering a keydown to the overlay.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(page.locator(".presentation-controls")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-presenting/);
  await expect(page.locator("#slide-rail")).toBeVisible();

  await page.waitForTimeout(300);
  await expect(page.locator(".presentation-controls")).toHaveCount(0);

  // When the key reaches the app directly, the same single press exits.
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");
  await page.keyboard.press("Escape");
  await expect(page.locator(".presentation-controls")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-presenting/);
  await expect(page.locator("#slide-rail")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator(".presentation-controls")).toHaveCount(0);
});

test("exits presentation when an external preference update disables Slides", async ({ page }) => {
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");

  await page.evaluate(() => {
    const key = "patterdraw:feature-preferences:v1";
    const preferences = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, boolean>;
    const next = JSON.stringify({ ...preferences, slides: false });
    localStorage.setItem(key, next);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: next }));
  });

  await expect(page.locator(".presentation-controls")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-presenting/);
  await expect(page.getByRole("button", { name: "Board", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

test("keeps a rapid presentation restart ahead of a stale fullscreen request", async ({ page }) => {
  await installDeferredFullscreenProbe(page);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");
  await expect.poll(() => deferredFullscreenRequestCount(page)).toBe(1);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(page.locator(".presentation-controls")).toHaveCount(0);

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");
  await expect.poll(() => deferredFullscreenRequestCount(page)).toBe(2);

  // The first presentation's request completes after the replacement has
  // started. Its fullscreen entry now belongs to the active presentation.
  await resolveDeferredFullscreenRequest(page, 0);
  await expect(page.locator(".presentation-controls")).toHaveCount(1);
  await expect(page.locator(".app-shell")).toHaveClass(/is-presenting/);
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

  await resolveDeferredFullscreenRequest(page, 1);
  await expect(page.locator(".presentation-controls")).toHaveCount(1);
});

test("does not let a stale presentation request steal manual fullscreen", async ({ page }) => {
  await installDeferredFullscreenProbe(page);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-count")).toHaveText("1 / 1");
  await expect.poll(() => deferredFullscreenRequestCount(page)).toBe(1);
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(page.locator(".presentation-controls")).toHaveCount(0);

  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
  await expect.poll(() => deferredFullscreenRequestCount(page)).toBe(2);
  await resolveDeferredFullscreenRequest(page, 1);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await resolveDeferredFullscreenRequest(page, 0);
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".presentation-controls")).toHaveCount(0);
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
  await expect(page).toHaveTitle("PatterDraw");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator(".page-status")).toContainText("Board");

  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").first()).toHaveClass(/is-selected/);
  expect(consoleErrors).toEqual([]);
});

test("saves and resumes unusual PDF geometry with the original source intact", async ({ page }) => {
  test.setTimeout(90_000);
  const sourceBytes = await unusualPdfBytes();
  const workspaceSnapshot = async () => {
    const project = await keyvalValue<{
      pdfPageOrder: string[];
      scenes: Record<string, {
        pdfPage?: {
          documentId: string;
          pageIndex: number;
          width: number;
          height: number;
          rotation: number;
        };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    const scene = project?.scenes[project.pdfPageOrder[0]];
    return scene?.pdfPage
      ? {
          pageIndex: scene.pdfPage.pageIndex,
          width: scene.pdfPage.width,
          height: scene.pdfPage.height,
          rotation: scene.pdfPage.rotation,
        }
      : null;
  };

  await page.getByLabel("Open project file").setInputFiles({
    name: "unusual-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(sourceBytes),
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: 15_000 });
  await expect.poll(workspaceSnapshot).toEqual({
    pageIndex: 0,
    width: 960,
    height: 720,
    rotation: 90,
  });

  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedBytes = await downloadBytes(await saveDownload);
  const archive = unzipSync(new Uint8Array(savedBytes));
  const manifest = JSON.parse(strFromU8(archive["project.json"])) as {
    pdfDocuments: Record<string, { archivePath: string }>;
  };
  const [source] = Object.values(manifest.pdfDocuments);
  expect(source).toBeDefined();
  expect(archive[source.archivePath]).toEqual(sourceBytes);

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect.poll(workspaceSnapshot).toEqual({
    pageIndex: 0,
    width: 960,
    height: 720,
    rotation: 90,
  });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);

  await page.reload();
  await page.getByLabel("Open project file").setInputFiles({
    name: "unusual-resume.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: savedBytes,
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect.poll(workspaceSnapshot).toEqual({
    pageIndex: 0,
    width: 960,
    height: 720,
    rotation: 90,
  });

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exportedBytes = await downloadBytes(await pdfDownload);
  const exported = await PDFDocument.load(exportedBytes);
  expect(exported.getPage(0).getSize()).toEqual({ width: 960, height: 720 });
  expect(exported.getPage(0).node.Annots()?.size() || 0).toBe(0);

  const sourceRender = await renderPdfPage(sourceBytes);
  const exportedRender = await renderPdfPage(exportedBytes);
  expect(exportedRender.text).toContain("VECTOR_RESUME_SENTINEL");
  expect(exportedRender.text).toContain("FORM RESUMES");
  const imageOperators = new Set<number>([
    OPS.paintImageMaskXObject,
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
  ]);
  expect(exportedRender.operators.every((operator) => !imageOperators.has(operator))).toBe(true);
  const red = (r: number, g: number, b: number) => r > 220 && g < 80 && b < 80;
  const blue = (r: number, g: number, b: number) => r < 80 && g < 80 && b > 220;
  const yellow = (r: number, g: number, b: number) => r > 220 && g > 220 && b < 80;
  for (const color of [red, blue, yellow]) {
    const sourceBounds = normalizedPixelBounds(
      sourceRender,
      matchingPixelBounds(sourceRender, color),
    );
    const exportedBounds = normalizedPixelBounds(
      exportedRender,
      matchingPixelBounds(exportedRender, color),
    );
    expect(sourceBounds).toHaveLength(4);
    expect(exportedBounds).toHaveLength(4);
    for (let coordinate = 0; coordinate < 4; coordinate += 1) {
      expect(exportedBounds[coordinate]).toBeCloseTo(sourceBounds[coordinate], 2);
    }
  }
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
  await page.keyboard.press("Shift+Tab");
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

test("fills a closed region with a persistent, undoable local vector", async ({ page }) => {
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

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 320, y: 220 }, { x: 560, y: 400 });

  type BucketSceneElement = {
    id: string;
    type: string;
    isDeleted?: boolean;
    polygon?: boolean;
    backgroundColor?: string;
    strokeColor?: string;
    points?: Array<[number, number]>;
  };
  const sceneElements = async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: BucketSceneElement[] }>;
    }>(page, "patterdraw:autosave:project:v1");
    return (project?.scenes[project.activeSceneId]?.elements || [])
      .filter((element) => !element.isDeleted);
  };
  const bucketFills = async () => (await sceneElements()).filter((element) => (
    element.type === "line"
    && element.polygon === true
    && element.strokeColor === "transparent"
  ));
  const persistedActiveTool = async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, {
        appState?: { activeTool?: { type?: string; customType?: string | null; locked?: boolean } };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    return project?.scenes[project.activeSceneId]?.appState?.activeTool;
  };
  const liveActiveTool = async () => page.evaluate(() => (window as unknown as {
    h?: { app?: { state?: { activeTool?: { type?: string; customType?: string | null; locked?: boolean } } } };
  }).h?.app?.state?.activeTool);

  await expect.poll(async () => (await sceneElements()).filter((element) => element.type === "rectangle"))
    .toHaveLength(1);
  const rectangleId = (await sceneElements()).find((element) => element.type === "rectangle")?.id;
  expect(rectangleId).toBeTruthy();

  const openExtraTools = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await expect(page.locator(".App-toolbar__extra-tools-dropdown")).toBeVisible();
  };
  await openExtraTools();
  await expect(page.getByTestId("toolbar-bucket-fill")).toBeVisible();
  await expect(page.getByTestId("toolbar-lasso")).toHaveCount(0);
  await page.getByTestId("toolbar-bucket-fill").click();

  const settings = page.getByTestId("bucket-fill-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Use #ffec99" }).click();
  await expect(settings.getByRole("button", { name: "Use #ffec99" })).toHaveAttribute("aria-pressed", "true");

  const host = await page.locator(".editor-host").boundingBox();
  if (!host) throw new Error("Editor host has no visible bounds.");

  // Bucket mode must leave Excalidraw's native two-touch gesture stream
  // intact. A trusted pinch should zoom the board and must not create paint.
  const zoomBeforePinch = await page.evaluate(() => (window as unknown as {
    h?: { app?: { state?: { zoom?: { value?: number } } } };
  }).h?.app?.state?.zoom?.value || 1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 71, x: Math.round(host.x + 410), y: Math.round(host.y + 310) },
      { id: 72, x: Math.round(host.x + 470), y: Math.round(host.y + 310) },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 71, x: Math.round(host.x + 370), y: Math.round(host.y + 310) },
      { id: 72, x: Math.round(host.x + 510), y: Math.round(host.y + 310) },
    ],
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    h?: { app?: { state?: { zoom?: { value?: number } } } };
  }).h?.app?.state?.zoom?.value || 1)).not.toBe(zoomBeforePinch);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(bucketFills).toHaveLength(0);
  await expect(settings).toBeVisible();
  // Excalidraw's development build emits this React diagnostic during a
  // synthetic CDP pinch; reject every other error and keep the rest of this
  // flow's console assertion strict.
  expect(consoleErrors.filter((error) => !error.startsWith(
    syntheticPinchConsoleErrorPrefix,
  ))).toEqual([]);
  consoleErrors.length = 0;

  await page.mouse.click(host.x + 440, host.y + 310);
  await expect.poll(bucketFills).toHaveLength(1);
  const initialFill = (await bucketFills())[0];
  expect(initialFill).toMatchObject({
    backgroundColor: "#ffec99",
    polygon: true,
    strokeColor: "transparent",
  });
  expect(initialFill.points?.length || 0).toBeGreaterThan(3);

  const filledElements = await sceneElements();
  expect(filledElements.findIndex((element) => element.id === initialFill.id))
    .toBeLessThan(filledElements.findIndex((element) => element.id === rectangleId));
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();

  await page.locator('.statusbar .footer-history-button[aria-label="Undo"]').click();
  await expect.poll(bucketFills).toHaveLength(0);
  await expect.poll(async () => (await sceneElements()).some((element) => element.id === rectangleId)).toBe(true);
  await page.locator('.statusbar .footer-history-button[aria-label="Redo"]').click();
  await expect.poll(bucketFills).toHaveLength(1);

  await settings.getByRole("button", { name: "Use #ffc9c9" }).click();
  await page.mouse.click(host.x + 440, host.y + 310);
  await expect.poll(bucketFills).toHaveLength(1);
  await expect.poll(async () => (await bucketFills())[0]?.backgroundColor).toBe("#ffc9c9");
  expect((await bucketFills())[0]?.id).toBe(initialFill.id);
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const tool = await persistedActiveTool();
    return tool === undefined || (
      tool.type === "selection"
      && tool.customType === null
      && tool.locked === false
    );
  }).toBe(true);

  await page.reload();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await expect.poll(bucketFills).toHaveLength(1);
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(liveActiveTool).toMatchObject({ type: "selection", locked: false });
  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("b");
  await expect(settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(liveActiveTool).toMatchObject({ type: "selection", locked: false });

  // Leaving Bucket Fill through a native toolbar choice must also release its
  // repeat lock. The rectangle tool should return to Selection after one draw.
  await page.keyboard.press("b");
  await expect(settings).toBeVisible();
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await expect(settings).toHaveCount(0);
  await expect.poll(liveActiveTool).toMatchObject({ type: "rectangle", locked: false });
  await dragOnBoard(page, { x: 700, y: 250 }, { x: 780, y: 320 });
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();

  const legacyProject = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, { appState?: Record<string, unknown> }>;
  }>(page, "patterdraw:autosave:project:v1");
  if (!legacyProject) throw new Error("Bucket-fill project was not autosaved.");
  const legacyScene = legacyProject.scenes[legacyProject.activeSceneId];
  if (!legacyScene) throw new Error("Active bucket-fill scene was not autosaved.");
  legacyScene.appState = {
    ...legacyScene.appState,
    activeTool: {
      type: "custom",
      customType: "classroom-bucket-fill",
      locked: false,
      lastActiveTool: null,
    },
  };
  await setKeyvalValue(page, "patterdraw:autosave:project:v1", legacyProject);
  await page.reload();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(async () => {
    const tool = await persistedActiveTool();
    return `${tool?.type || ""}:${tool?.customType || ""}`;
  }).not.toBe("custom:classroom-bucket-fill");

  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("keeps bucket paint above the locked PDF background and exits on page navigation", async ({ page }) => {
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

  await openTestPdf(page, 2);
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  const start = await liveScenePointInViewport(page, { x: 150, y: 200 });
  const end = await liveScenePointInViewport(page, { x: 450, y: 500 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();

  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-bucket-fill").click();
  const settings = page.getByTestId("bucket-fill-settings");
  await settings.getByRole("button", { name: "Use #ffec99" }).click();
  const center = await liveScenePointInViewport(page, { x: 300, y: 350 });
  await page.mouse.click(center.x, center.y);

  await expect.poll(() => page.evaluate(() => {
    type LiveElement = {
      backgroundColor?: string;
      customData?: { classroomRole?: string };
      id: string;
      polygon?: boolean;
      strokeColor?: string;
      type: string;
    };
    const elements = (window as unknown as {
      h?: { app?: { scene?: { getNonDeletedElements?: () => LiveElement[] } } };
    }).h?.app?.scene?.getNonDeletedElements?.() || [];
    const backgroundIndex = elements.findIndex((element) => (
      element.customData?.classroomRole === "pdf-background"
    ));
    const fillIndex = elements.findIndex((element) => (
      element.type === "line"
      && element.polygon === true
      && element.strokeColor === "transparent"
      && element.backgroundColor === "#ffec99"
    ));
    const ownerIndex = elements.findIndex((element) => element.type === "rectangle");
    return {
      backgroundFound: backgroundIndex >= 0,
      fillFound: fillIndex >= 0,
      ownerFound: ownerIndex >= 0,
      order: backgroundIndex < fillIndex && fillIndex < ownerIndex,
    };
  })).toEqual({
    backgroundFound: true,
    fillFound: true,
    ownerFound: true,
    order: true,
  });

  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await pages.nth(1).locator(".pdf-page-open").click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    h?: { app?: { state?: { activeTool?: { type?: string; locked?: boolean } } } };
  }).h?.app?.state?.activeTool)).toMatchObject({ type: "selection", locked: false });

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
  const expectedRectangleIds = initial.map((position) => position.id);
  const expectedSelectedRectangleIds = [...expectedRectangleIds].sort();
  const liveSelectedElementIds = () => page.evaluate(() => {
    const state = (window as unknown as {
      h?: { app?: { state?: { selectedElementIds?: Record<string, boolean> } } };
    }).h?.app?.state;
    return Object.entries(state?.selectedElementIds || {})
      .filter(([, selected]) => selected)
      .map(([id]) => id)
      .sort();
  });
  const liveRectangleViewportBounds = (id: string) => page.evaluate((elementId) => {
    const app = (window as unknown as {
      h?: {
        app?: {
          scene?: { getNonDeletedElements?: () => Array<{
            id: string;
            height: number;
            width: number;
            x: number;
            y: number;
          }> };
          state?: {
            offsetLeft?: number;
            offsetTop?: number;
            scrollX?: number;
            scrollY?: number;
            zoom?: { value?: number };
          };
        };
      };
    }).h?.app;
    const element = app?.scene?.getNonDeletedElements?.().find((candidate) => candidate.id === elementId);
    const state = app?.state;
    if (!element || !state) throw new Error("The live lasso rectangle is unavailable.");
    const zoom = state.zoom?.value || 1;
    const left = (element.x + (state.scrollX || 0)) * zoom + (state.offsetLeft || 0);
    const top = (element.y + (state.scrollY || 0)) * zoom + (state.offsetTop || 0);
    return {
      bottom: top + element.height * zoom,
      left,
      right: left + element.width * zoom,
      top,
    };
  }, id);

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
  await page.keyboard.press("ControlOrMeta+f");
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("searchbox", {
    name: "Find text across project",
    exact: true,
  })).toHaveCount(0);
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
  const additiveOverlay = page.getByTestId("lasso-overlay");
  await expect(additiveOverlay).toBeVisible();
  await expect(additiveOverlay).toHaveAttribute("data-initial-selection-count", "1");
  const additiveBounds = await liveRectangleViewportBounds(expectedRectangleIds[1]);
  const additiveMargin = 30;
  await page.keyboard.down("Shift");
  await page.mouse.move(additiveBounds.left - additiveMargin, additiveBounds.top - additiveMargin);
  await page.mouse.down();
  await page.mouse.move(additiveBounds.right + additiveMargin, additiveBounds.top - additiveMargin, { steps: 4 });
  await page.mouse.move(additiveBounds.right + additiveMargin, additiveBounds.bottom + additiveMargin, { steps: 4 });
  await page.mouse.move(additiveBounds.left - additiveMargin, additiveBounds.bottom + additiveMargin, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  // Wait for the one-shot overlay to finish its synchronous selection update,
  // restore Excalidraw focus, and unmount before sending the next editor key.
  // The two earlier lasso phases already use this boundary; omitting it here
  // allowed ArrowDown to race the final additive selection on a cold run.
  await expect(page.getByTestId("lasso-overlay")).toHaveCount(0);
  await expect.poll(liveSelectedElementIds).toEqual(expectedSelectedRectangleIds);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect(page.locator(".editor-host .excalidraw")).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => {
    const positions = await autosavedRectanglePositions(page);
    return positions.map((position, index) => position.y - moved[index].y);
  }).toEqual([5, 5]);

  await page.reload();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  await openExtraTools();
  await expect(page.getByTestId("toolbar-lasso")).toBeVisible();
  const beforeTouch = await waitForAutosavedRectangleSet(page, expectedRectangleIds);
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
  // Synthetic PointerEvents are not trusted browser input and do not reliably
  // enter Excalidraw's subsequent keyboard-move path. Verify the exact element
  // selected by touch through the native inspector; mouse lasso movement and
  // autosave are exercised above with real Playwright input.
  const sizePosition = page.getByRole("button", { name: "Size & Position", exact: true });
  await sizePosition.click();
  const selectedX = page.locator(".exc-stats").getByTestId("X").locator("input");
  await expect(selectedX).toHaveValue(String(beforeTouch[0].x));
  await sizePosition.click();
  await expect(page.locator(".exc-stats")).toHaveCount(0);

  const beforeEscape = await waitForAutosavedRectangleSet(page, expectedRectangleIds);
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
  await sizePosition.click();
  await expect(page.locator(".exc-stats").getByTestId("X").locator("input"))
    .toHaveValue(String(beforeEscape[0].x));
  await sizePosition.click();
  await expect(page.locator(".exc-stats")).toHaveCount(0);
  await expect.poll(() => autosavedRectanglePositions(page)).toEqual(beforeEscape);

  await page.setViewportSize({ width: 390, height: 844 });
  await openExtraTools();
  const mobileLassoBox = await page.getByTestId("toolbar-lasso").boundingBox();
  expect(mobileLassoBox).not.toBeNull();
  expect((mobileLassoBox?.x || 0) + (mobileLassoBox?.width || 0)).toBeLessThanOrEqual(390);
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.setViewportSize({ width: 1440, height: 900 });

  await openTestPdf(page);
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
  await page.getByTitle("Download a complete PatterDraw project").click();
  const savedProjectStream = await (await saveDownload).createReadStream();
  const savedProjectChunks: Buffer[] = [];
  for await (const chunk of savedProjectStream) savedProjectChunks.push(Buffer.from(chunk));
  const savedProject = Buffer.concat(savedProjectChunks);
  expect(savedProject.byteLength).toBeGreaterThan(1_000);

  await page.reload();
  await page.getByLabel("Open project file").setInputFiles({
    name: "advanced-static-math-tools.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
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
  test.setTimeout(120_000);
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
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.count || 0).toBe(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
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
  await page.keyboard.press("ControlOrMeta+Shift+l");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.lockedCount || 0).toBe(1);
  await page.keyboard.press("ControlOrMeta+Shift+l");
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
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  const persistencePollOptions = { timeout: 15_000 };
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "fraction-piece"))?.count || 0, persistencePollOptions).toBe(10);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "algebra-tile"))?.count || 0, persistencePollOptions).toBe(6);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "integer-chip"))?.count || 0, persistencePollOptions).toBe(7);
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.count || 0, persistencePollOptions).toBe(19);

  const saveDownload = page.waitForEvent("download");
  await page.getByTitle("Download a complete PatterDraw project").click();
  const savedProjectStream = await (await saveDownload).createReadStream();
  const savedProjectChunks: Buffer[] = [];
  for await (const chunk of savedProjectStream) savedProjectChunks.push(Buffer.from(chunk));
  const savedProject = Buffer.concat(savedProjectChunks);
  expect(savedProject.byteLength).toBeGreaterThan(1_000);

  await page.reload();
  await page.getByLabel("Open project file").setInputFiles({
    name: "advanced-manipulatives.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
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
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds).toEqual(beforeRoll?.fileIds);
  await page.keyboard.press("ControlOrMeta+Shift+z");
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
  await page.keyboard.press("ControlOrMeta+a");
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
  await expect.poll(
    async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.count || 0,
    { timeout: 15_000 },
  ).toBe(1);
  const beforeSpin = await autosavedMathToolSetSnapshot(page, "probability-piece");
  expect(beforeSpin?.metadata[0]).toMatchObject({ componentType: "spinner", faceOrValue: "1-8", spinnerSectorCount: 8 });

  const pointerOverlay = page.getByTestId("spinner-pointer-animation");
  const pointerLayer = pointerOverlay.locator(".spinner-pointer-overlay__pointer");
  await Promise.all([
    expect(spin).toBeDisabled(),
    expect(spin).toHaveText(/Spinning/),
    expect(toolbar).toHaveAttribute("aria-busy", "true"),
    expect(pointerOverlay).toBeVisible(),
    expect(pointerOverlay.locator(".spinner-pointer-overlay__wheel")).toHaveCSS("transform", "none"),
    expect(pointerLayer).toHaveCSS("animation-duration", "1.1s"),
    spin.click(),
  ]);
  await expect(page.getByText(/Spun 1 spinner: [1-8]\./)).toBeVisible();
  await expect(pointerOverlay).toHaveCount(0);
  await expect(spin).toBeEnabled();
  await expect(spin).toHaveText(/Spin selected/);
  await expect(toolbar).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => {
    const snapshot = await autosavedMathToolSetSnapshot(page, "probability-piece");
    return snapshot?.fileIds[0] !== beforeSpin?.fileIds[0]
      && /^[1-8]$/.test(String(snapshot?.metadata[0]?.faceOrValue))
      && snapshot?.localSafe === true;
  }, { timeout: 15_000 }).toBe(true);
  const afterSpin = await autosavedMathToolSetSnapshot(page, "probability-piece");
  expect(afterSpin?.angles).toEqual(beforeSpin?.angles);

  await page.locator(".editor-host .excalidraw").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(
    async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds,
    { timeout: 15_000 },
  ).toEqual(beforeSpin?.fileIds);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(
    async () => (await autosavedMathToolSetSnapshot(page, "probability-piece"))?.fileIds,
    { timeout: 15_000 },
  ).toEqual(afterSpin?.fileIds);

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
  }, { timeout: 15_000 }).toBe(true);
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
  await page.locator(".editor-host .excalidraw").waitFor({
    state: "visible",
    timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT,
  });
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
  await expect(page).toHaveTitle("PatterDraw");
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

test("keeps a PDF page's annotation badge current after navigating away", async ({ page }) => {
  await openTestPdf(page, 2);
  const pages = page.locator("#pdf-page-rail .pdf-page-item");

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 280, y: 220 }, { x: 400, y: 300 });
  await expect(pages.nth(0).locator(".pdf-annotation-count")).toHaveText("1");

  await pages.nth(1).locator(".pdf-page-open").click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect(pages.nth(0).locator(".pdf-annotation-count")).toHaveText("1");
});

test("waits for PDF scene hydration before exporting the full board", async ({ page }) => {
  await page.getByLabel("Open project file").setInputFiles({
    name: "hydration-colours.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await colouredPdfBytes()),
  });
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(2, { timeout: 15_000 });
  await deferAnimationFrames(page);

  const downloadEvent = page.waitForEvent("download");
  let downloadStarted = false;
  void downloadEvent.then(() => { downloadStarted = true; });
  await pages.nth(1).locator(".pdf-page-open").click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await page.getByRole("button", { name: "Export all", exact: true }).click();
  await expect(page.getByText("Exporting the full board…", { exact: true })).toBeVisible();
  await page.waitForTimeout(50);
  expect(downloadStarted).toBe(false);

  await releaseDeferredAnimationFrames(page);
  const image = await loadImage(await downloadBytes(await downloadEvent));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixel = context.getImageData(
    Math.floor(canvas.width / 2),
    Math.floor(canvas.height / 2),
    1,
    1,
  ).data;
  expect(pixel[2]).toBeGreaterThan(180);
  expect(pixel[0]).toBeLessThan(80);
});

test("waits for PDF scene hydration before opening native image export", async ({ page }) => {
  await useDownloadBasedImageExport(page);
  await openTestPdf(page, 2);
  const saved = await keyvalValue<{
    pdfPageOrder: string[];
    scenes: Record<string, { pdfPage?: { backgroundElementId: string } }>;
  }>(page, "patterdraw:autosave:project:v1");
  const firstBackgroundId = saved?.scenes[saved.pdfPageOrder[0]]?.pdfPage?.backgroundElementId;
  const secondBackgroundId = saved?.scenes[saved.pdfPageOrder[1]]?.pdfPage?.backgroundElementId;
  expect(firstBackgroundId).toBeTruthy();
  expect(secondBackgroundId).toBeTruthy();
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await deferAnimationFrames(page);

  await pages.nth(1).locator(".pdf-page-open").click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("dialog", { name: "More exports", exact: true })
    .getByRole("button", { name: /Export image…/ })
    .click();
  const nativeDialog = page.locator(".Modal").filter({ has: page.locator(".ImageExportModal") });
  await expect(nativeDialog).toHaveCount(0);

  await releaseDeferredAnimationFrames(page);
  await expect(nativeDialog).toBeVisible();
  const liveBackgrounds = await page.evaluate(({ firstBackgroundId, secondBackgroundId }) => {
    const scene = (window as unknown as {
      h?: { app?: { scene?: { getNonDeletedElement?: (id: string) => unknown } } };
    }).h?.app?.scene;
    return {
      firstPresent: Boolean(scene?.getNonDeletedElement?.(firstBackgroundId)),
      secondPresent: Boolean(scene?.getNonDeletedElement?.(secondBackgroundId)),
    };
  }, {
    firstBackgroundId: firstBackgroundId || "",
    secondBackgroundId: secondBackgroundId || "",
  });
  expect(liveBackgrounds).toEqual({ firstPresent: false, secondPresent: true });
  await nativeDialog.locator(".Modal__content").focus();
  await page.keyboard.press("Escape");
});

test("replays a user edit made during PDF scene hydration", async ({ page }) => {
  await page.getByLabel("Open project file").setInputFiles({
    name: "hydration-edit.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await colouredPdfBytes()),
  });
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(2, { timeout: 15_000 });
  await deferAnimationFrames(page);

  await pages.nth(1).locator(".pdf-page-open").click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 260, y: 220 }, { x: 410, y: 320 });
  const zoomBefore = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, { appState?: { zoom?: { value?: number } } }>;
  }>(page, "patterdraw:autosave:project:v1");
  const baselineZoom = zoomBefore?.scenes[zoomBefore.activeSceneId]?.appState?.zoom?.value || 1;
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();

  // The deferred two-RAF hydration window must not drop the rectangle.
  await releaseDeferredAnimationFrames(page);
  await expect.poll(async () => {
    const saved = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { elements: Array<{ type?: string }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    return saved?.scenes[saved.activeSceneId]?.elements
      .filter((element) => element.type === "rectangle").length || 0;
  }, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => {
    const saved = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { appState?: { zoom?: { value?: number } } }>;
    }>(page, "patterdraw:autosave:project:v1");
    return saved?.scenes[saved.activeSceneId]?.appState?.zoom?.value || 1;
  }, { timeout: 15_000 }).toBeGreaterThan(baselineZoom);
});

test("keeps the newest PDF open when an older import resolves later", async ({ page }) => {
  test.setTimeout(60_000);
  let workerRequests = 0;
  const workerRoute = "**/*pdf.worker.min*";
  await page.route(workerRoute, async (route) => {
    workerRequests += 1;
    if (workerRequests === 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  const input = page.getByLabel("Open project file");
  const firstPdf = await PDFDocument.create();
  const firstPage = firstPdf.addPage([612, 792]);
  firstPage.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 0, 0) });
  await input.setInputFiles({
    name: "older-one-page.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await firstPdf.save()),
  });
  await expect.poll(() => workerRequests, { timeout: 15_000 }).toBeGreaterThan(0);
  // The second file has one page as well, but a distinct source name; its
  // scene title proves that the first delayed result did not win.
  const secondPdf = await PDFDocument.create();
  const secondPage = secondPdf.addPage([612, 792]);
  secondPage.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0, 1, 0) });
  await input.setInputFiles({
    name: "newer-one-page.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await secondPdf.save()),
  });

  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(async () => {
    const saved = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { name?: string }>;
    }>(page, "patterdraw:autosave:project:v1");
    return saved?.scenes[saved.activeSceneId]?.name || "";
  }, { timeout: 20_000 }).toContain("newer-one-page.pdf");
  await page.unroute(workerRoute);
});

test("keeps the latest PDF scene during rapid page switches", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page, 3);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  const pages = page.locator("#pdf-page-rail .pdf-page-item");

  // Exercise several latest-intent transitions while the first dark render is
  // still likely to be pending. The display-only raster must never re-enter
  // Excalidraw while its single live scene is being hydrated.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await pages.nth(1).click();
    await pages.nth(2).click();
    await pages.nth(0).click();
  }

  await expect(page.getByTestId("patterdraw-fatal-screen")).toHaveCount(0);
  await expect(pages.nth(0)).toHaveClass(/is-selected/);
  await expect(page.locator(".page-status")).toContainText("Page 1 of 3");
  await expect.poll(() => pages.nth(0).locator("img").getAttribute("class"), { timeout: 30_000 })
    .toContain("pdf-page-dark-thumbnail");
  await expect(page.getByText("This PDF page could not be shown in dark mode.", { exact: true }))
    .toHaveCount(0);
  await expect.poll(async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ id?: string }>;
        pdfPage?: { backgroundElementId: string; pageIndex: number };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    if (!project) return null;
    const pdfScenes = Object.values(project.scenes).filter((scene) => scene.pdfPage);
    return {
      activePageIndex: project.scenes[project.activeSceneId]?.pdfPage?.pageIndex,
      pageCount: pdfScenes.length,
      backgroundsIntact: pdfScenes.every((scene) => (
        scene.elements.some((element) => element.id === scene.pdfPage?.backgroundElementId)
      )),
    };
  }, { timeout: 15_000 }).toEqual({
    activePageIndex: 0,
    pageCount: 3,
    backgroundsIntact: true,
  });
});

test("restores a canonical light PDF background after a failed dark render", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page, 2);
  const saved = await keyvalValue<{
    activeSceneId: string;
    pdfPageOrder: string[];
    scenes: Record<string, {
      elements: Array<{ fileId?: string; id: string }>;
      pdfPage?: { backgroundElementId: string };
    }>;
  }>(page, "patterdraw:autosave:project:v1");
  const firstSceneId = saved?.pdfPageOrder[0];
  const firstScene = firstSceneId ? saved?.scenes[firstSceneId] : undefined;
  const firstBackgroundId = firstScene?.pdfPage?.backgroundElementId;
  const lightFileId = firstBackgroundId
    ? firstScene?.elements.find((element) => element.id === firstBackgroundId)?.fileId
    : undefined;
  expect(firstBackgroundId).toBeTruthy();
  expect(lightFileId).toBeTruthy();

  const readLiveBackground = () => page.evaluate(({ backgroundId }) => {
    const app = (window as unknown as {
      h?: {
        app?: {
          files?: Record<string, unknown>;
          scene?: { getNonDeletedElement?: (id: string) => { fileId?: string } | null };
        };
      };
    }).h?.app;
    const fileIds = Object.keys(app?.files || {});
    return {
      backgroundFileId: app?.scene?.getNonDeletedElement?.(backgroundId)?.fileId || null,
      fileIds,
      transientFileIds: fileIds.filter((id) => id.startsWith("patterdraw-dark-pdf")),
    };
  }, { backgroundId: firstBackgroundId || "" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await readLiveBackground()).backgroundFileId || "", { timeout: 30_000 })
    .toMatch(/^patterdraw-dark-pdf/);

  let workerRequests = 0;
  const workerRoute = "**/*pdf.worker.min*";
  await page.route(workerRoute, async (route) => {
    workerRequests += 1;
    await route.abort();
  });
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await pages.nth(1).locator(".pdf-page-open").click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect.poll(() => workerRequests, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  await pages.nth(0).locator(".pdf-page-open").click();
  await expect(pages.nth(0)).toHaveClass(/is-selected/);
  await page.waitForTimeout(100);
  await page.getByTestId("toolbar-rectangle").click({ force: true });
  await dragOnBoard(page, { x: 280, y: 220 }, { x: 400, y: 300 });

  await expect.poll(async () => {
    const state = await readLiveBackground();
    return state.backgroundFileId === lightFileId
      && state.fileIds.includes(lightFileId || "")
      && state.transientFileIds.length === 0
      ? state
      : null;
  }, { timeout: 15_000 }).not.toBeNull();
  const liveBackground = await readLiveBackground();
  expect(liveBackground.backgroundFileId).toBe(lightFileId);
  expect(liveBackground.transientFileIds).toEqual([]);

  await expect.poll(async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, {
        elements: Array<{ fileId?: string; id: string }>;
        files: Record<string, unknown>;
        pdfPage?: { backgroundElementId: string };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    const scene = project?.scenes[project.activeSceneId];
    const background = scene?.pdfPage
      ? scene.elements.find((element) => element.id === scene.pdfPage?.backgroundElementId)
      : undefined;
    const fileIds = Object.keys(scene?.files || {});
    return {
      backgroundFileId: background?.fileId || null,
      hasLightFile: fileIds.includes(lightFileId || ""),
      transientFileIds: fileIds.filter((id) => id.startsWith("patterdraw-dark-pdf")),
    };
  }, { timeout: 15_000 }).toEqual({
    backgroundFileId: lightFileId,
    hasLightFile: true,
    transientFileIds: [],
  });
  await page.unroute(workerRoute);
});

test("never applies a rapid slide action to a PDF scene", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page, 2);
  await page.evaluate(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    (window as Window & { __patterdrawNativeRaf?: typeof window.requestAnimationFrame })
      .__patterdrawNativeRaf = nativeRequestAnimationFrame;
    window.requestAnimationFrame = (callback) => nativeRequestAnimationFrame(() => {
      nativeRequestAnimationFrame(callback);
    });
  });

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  const addSlide = page.getByRole("button", { name: "Add slide", exact: true });
  await expect(addSlide).toBeVisible();
  await addSlide.click();
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await pages.nth(1).click();

  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect.poll(async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { pdfPage?: { pageIndex: number } }>;
      slideOrder: Array<{ sceneId: string }>;
    }>(page, "patterdraw:autosave:project:v1");
    return project ? {
      activePageIndex: project.scenes[project.activeSceneId]?.pdfPage?.pageIndex,
      slidesOnPdfScenes: project.slideOrder.filter(
        (slide) => project.scenes[slide.sceneId]?.pdfPage,
      ).length,
    } : null;
  }, { timeout: 15_000 }).toEqual({ activePageIndex: 1, slidesOnPdfScenes: 0 });

  await page.evaluate(() => {
    const host = window as Window & { __patterdrawNativeRaf?: typeof window.requestAnimationFrame };
    if (host.__patterdrawNativeRaf) window.requestAnimationFrame = host.__patterdrawNativeRaf;
    delete host.__patterdrawNativeRaf;
  });
});

test("commits a live PDF annotation before switching to a blank Board", async ({ page }) => {
  await openTestPdf(page);
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await dragOnBoard(page, { x: 280, y: 220 }, { x: 400, y: 300 });

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByRole("button", { name: "Board", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => {
    const project = await keyvalValue<{
      pdfPageOrder: string[];
      scenes: Record<string, { elements: Array<{ type?: string; isDeleted?: boolean }> }>;
    }>(page, "patterdraw:autosave:project:v1");
    const pdfScene = project?.scenes[project.pdfPageOrder?.[0] || ""];
    return pdfScene?.elements.filter((element) => element.type === "rectangle" && !element.isDeleted).length || 0;
  }, { timeout: 15_000 }).toBe(1);
});

test("cancels a queued slide action when leaving Slides mode", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page);
  await page.evaluate(() => {
    type DeferredRafState = {
      callbacks: Map<number, FrameRequestCallback>;
      nextId: number;
      request: typeof window.requestAnimationFrame;
      cancel: typeof window.cancelAnimationFrame;
    };
    const host = window as Window & { __patterdrawDeferredRaf?: DeferredRafState };
    const state: DeferredRafState = {
      callbacks: new Map(),
      nextId: 1,
      request: window.requestAnimationFrame.bind(window),
      cancel: window.cancelAnimationFrame.bind(window),
    };
    host.__patterdrawDeferredRaf = state;
    window.requestAnimationFrame = (callback) => {
      const id = state.nextId++;
      state.callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      state.callbacks.delete(id);
    };
  });

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();

  await page.evaluate(() => {
    type DeferredRafState = {
      callbacks: Map<number, FrameRequestCallback>;
      request: typeof window.requestAnimationFrame;
      cancel: typeof window.cancelAnimationFrame;
    };
    const host = window as Window & { __patterdrawDeferredRaf?: DeferredRafState };
    const state = host.__patterdrawDeferredRaf;
    if (!state) return;
    window.requestAnimationFrame = state.request;
    window.cancelAnimationFrame = state.cancel;
    delete host.__patterdrawDeferredRaf;
    for (const callback of state.callbacks.values()) {
      state.request(callback);
    }
  });

  await expect(page.getByRole("button", { name: "Board", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => {
    const project = await keyvalValue<{
      activeSceneId: string;
      scenes: Record<string, { pdfPage?: unknown }>;
      slideOrder: Array<unknown>;
    }>(page, "patterdraw:autosave:project:v1");
    return project ? {
      activeIsBoard: !project.scenes[project.activeSceneId]?.pdfPage,
      slideCount: project.slideOrder.length,
    } : null;
  }, { timeout: 15_000 }).toEqual({ activeIsBoard: true, slideCount: 0 });
});

test("reorders PDF output pages without changing their immutable source indexes", async ({ page }) => {
  test.setTimeout(60_000);
  const document = await PDFDocument.create();
  for (const [width, height] of [[500, 700], [600, 800], [700, 900]] as const) {
    document.addPage([width, height]);
  }
  const bytes = await document.save();
  await page.getByLabel("Open project file").setInputFiles({
    name: "reorder-pages.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });

  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(3, { timeout: 15_000 });
  await pages.nth(2).getByRole("button", { name: "Move output page 3 earlier", exact: true }).click();
  await pages.nth(1).getByRole("button", { name: "Move output page 2 earlier", exact: true }).click();
  await expect(pages.locator(".pdf-page-label span")).toHaveText([
    "Original page 3",
    "Original page 1",
    "Original page 2",
  ]);
  await expect.poll(async () => {
    const project = await keyvalValue<{
      pdfPageOrder: string[];
      scenes: Record<string, { pdfPage?: { pageIndex: number } }>;
    }>(page, "patterdraw:autosave:project:v1");
    return project?.pdfPageOrder.map((sceneId) => project.scenes[sceneId].pdfPage?.pageIndex);
  }).toEqual([2, 0, 1]);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exported = await PDFDocument.load(await downloadBytes(await pdfDownload));
  expect(exported.getPages().map((outputPage) => outputPage.getSize())).toEqual([
    { width: 700, height: 900 },
    { width: 500, height: 700 },
    { width: 600, height: 800 },
  ]);
});

test("traps focus in wrapper dialogs and restores their invoking controls", async ({ page }) => {
  await openClassroomFixture(page, [
    exportTestRectangle("dialog-focus-object", 100, 120, 160, 100, "a0"),
  ], []);

  const moreExports = page.getByRole("button", { name: "More export options", exact: true });
  await moreExports.click();
  const exportDialog = page.getByRole("dialog", { name: "More exports", exact: true });
  const firstExportControl = exportDialog.locator("button:not(:disabled)").first();
  const cancelExport = exportDialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(exportDialog).toBeVisible();
  await expect(firstExportControl).toBeFocused();
  await cancelExport.focus();
  await page.keyboard.press("Tab");
  await expect(firstExportControl).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancelExport).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(exportDialog).toBeHidden();
  await expect(moreExports).toBeFocused();

  const insert = page.getByRole("button", { name: "Insert", exact: true });
  await insert.click();
  await page.getByRole("menuitem", { name: /Equation/ }).click();
  const equationDialog = page.getByRole("dialog", { name: "Insert equation", exact: true });
  const equationSource = equationDialog.getByLabel("LaTeX", { exact: true });
  const closeEquation = equationDialog.getByRole("button", { name: "Close equation editor", exact: true });
  const cancelEquation = equationDialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(equationSource).toBeFocused();
  await closeEquation.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(cancelEquation).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeEquation).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(equationDialog).toBeHidden();
  await expect(insert).toBeFocused();

  await insert.click();
  await page.getByRole("menuitem", { name: /Diagram/ }).click();
  const mermaidDialog = page.getByRole("dialog", { name: "Insert Mermaid diagram", exact: true });
  const mermaidSource = mermaidDialog.getByLabel("Mermaid source", { exact: true });
  const closeMermaid = mermaidDialog.getByRole("button", { name: "Close Mermaid editor", exact: true });
  const previewMermaid = mermaidDialog.getByRole("button", { name: "Preview", exact: true });
  await expect(mermaidSource).toBeFocused();
  await closeMermaid.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(previewMermaid).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeMermaid).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mermaidDialog).toBeHidden();
  await expect(insert).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Insert", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export all", exact: true })).toBeVisible();
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
  await page.getByLabel("Open project file").setInputFiles({
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
  await nativeDialog.locator(".Modal__content").focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(nativeDialog).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Find text across project", exact: true }))
    .toHaveCount(0);

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
  await page.getByLabel("Open project file").setInputFiles({
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
  expect(png.suggestedFilename()).toBe("Untitled PatterDraw canvas.png");
  const bytes = await downloadBytes(png);
  expect(pngDimensions(bytes)).toEqual({ width: 632, height: 812 });
  expect(bytes.byteLength).toBeGreaterThan(2_000);
});

test("keeps off-page PDF annotations through reload and both annotated export modes", async ({ page }) => {
  test.setTimeout(90_000);
  await openTestPdf(page);
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  await expect.poll(() => pdfPageHorizontalCenterError(page)).toBeLessThan(0.02);
  const annotationStart = await liveScenePointInViewport(page, { x: 632, y: 300 });
  const annotationEnd = await liveScenePointInViewport(page, { x: 672, y: 340 });
  await page.mouse.move(annotationStart.x, annotationStart.y);
  await page.mouse.down();
  await page.mouse.move(annotationEnd.x, annotationEnd.y, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId("toolbar-selection").check({ force: true });

  const annotations = async () => {
    const project = await keyvalValue<{
      pdfPageOrder: string[];
      scenes: Record<string, {
        elements: Array<{
          id: string;
          isDeleted?: boolean;
          type?: string;
          width?: number;
          x?: number;
        }>;
        pdfPage?: { backgroundElementId: string };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    const scene = project?.scenes[project.pdfPageOrder[0]];
    return scene?.elements
      .filter((element) => !element.isDeleted && element.id !== scene.pdfPage?.backgroundElementId)
      .map((element) => ({
        type: element.type,
        width: element.width || 0,
        x: element.x || 0,
      })) || [];
  };
  await expect.poll(annotations).toHaveLength(1);
  const [initialAnnotation] = await annotations();
  expect(initialAnnotation).toMatchObject({ type: "rectangle" });
  // The rectangle is intentionally drawn 20 scene units beyond the 612-wide
  // PDF page. Assert this immediately so a centering regression (x=333) cannot
  // be hidden by a later keyboard nudge.
  expect(initialAnnotation.x).toBeCloseTo(632, 3);
  expect(initialAnnotation.width).toBeGreaterThan(20);
  expect(initialAnnotation.width).toBeLessThan(60);

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const expandedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const expandedBytes = await downloadBytes(await expandedDownload);
  const expanded = await PDFDocument.load(expandedBytes);
  expect(expanded.getPage(0).getWidth()).toBeGreaterThan(612);
  expect(expanded.getPage(0).getHeight()).toBe(792);
  const expandedRender = await renderPdfPage(expandedBytes);
  expect(nonWhitePixelsAfter(expandedRender, 620)).toBeGreaterThan(20);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const fittedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — fit like OpenBoard/ }).click();
  const fittedBytes = await downloadBytes(await fittedDownload);
  const fitted = await PDFDocument.load(fittedBytes);
  expect(fitted.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  const fittedRender = await renderPdfPage(fittedBytes);
  expect(nonWhitePixelsAfter(fittedRender, 550)).toBeGreaterThan(20);
});

test("inserts supplemental PDF pages before the selection and at the document end", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page, 2);
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  const beforePdf = await PDFDocument.create();
  beforePdf.addPage([400, 500]);
  const endPdf = await PDFDocument.create();
  endPdf.addPage([450, 550]);

  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles({
    name: "before.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await beforePdf.save()),
  });
  let dialog = page.getByRole("dialog", { name: "Insert PDF pages", exact: true });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("radio", { name: /Before selected page/ }).check();
  await dialog.getByRole("button", { name: "Insert 1 page", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(pages).toHaveCount(3);
  await expect(pages.nth(0)).toContainText("before.pdf");
  await expect(pages.nth(0)).toHaveClass(/is-selected/);

  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles({
    name: "at-end.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await endPdf.save()),
  });
  dialog = page.getByRole("dialog", { name: "Insert PDF pages", exact: true });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("radio", { name: /End of document/ }).check();
  await dialog.getByRole("button", { name: "Insert 1 page", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(pages).toHaveCount(4);
  await expect(pages.nth(3)).toContainText("at-end.pdf");
  await expect(pages.nth(3)).toHaveClass(/is-selected/);
});

test("cancels a multi-PDF insertion without committing partial pages", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page);
  await page.evaluate(() => {
    const originalArrayBuffer = File.prototype.arrayBuffer;
    const calls = new WeakMap<File, number>();
    File.prototype.arrayBuffer = function arrayBufferWithDelayedImport() {
      if (this.name !== "slow-insert.pdf") return originalArrayBuffer.call(this);
      const call = (calls.get(this) || 0) + 1;
      calls.set(this, call);
      if (call !== 2) return originalArrayBuffer.call(this);
      return new Promise<ArrayBuffer>((resolve, reject) => {
        window.setTimeout(() => originalArrayBuffer.call(this).then(resolve, reject), 3_000);
      });
    };
  });
  const slow = await PDFDocument.create();
  slow.addPage([300, 400]);
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles({
    name: "slow-insert.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await slow.save()),
  });
  const dialog = page.getByRole("dialog", { name: "Insert PDF pages", exact: true });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Insert 1 page", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel insertion", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(pages).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pages).toHaveCount(1);
});

test("keeps the project unchanged when a selected PDF changes after inspection", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page);
  await page.evaluate(() => {
    const originalArrayBuffer = File.prototype.arrayBuffer;
    const calls = new WeakMap<File, number>();
    File.prototype.arrayBuffer = async function arrayBufferWithChangedImport() {
      const buffer = await originalArrayBuffer.call(this);
      if (this.name !== "changed-after-inspection.pdf") return buffer;
      const call = (calls.get(this) || 0) + 1;
      calls.set(this, call);
      if (call !== 2) return buffer;
      const changed = new Uint8Array(buffer.slice(0));
      changed[changed.length - 1] ^= 0x01;
      return changed.buffer;
    };
  });
  const changed = await PDFDocument.create();
  changed.addPage([300, 400]);
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles({
    name: "changed-after-inspection.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await changed.save()),
  });
  const dialog = page.getByRole("dialog", { name: "Insert PDF pages", exact: true });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Insert 1 page", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed after it was selected", { timeout: 20_000 });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(pages).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(pages).toHaveCount(1);
});

test("rejects an impossible multi-file selection before opening the insertion dialog", async ({ page }) => {
  test.setTimeout(60_000);
  await openTestPdf(page);
  const saved = await keyvalValue<{
    activeSceneId: string;
    scenes: Record<string, {
      id: string;
      name: string;
      elements: unknown[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    }>;
  }>(page, "patterdraw:autosave:project:v1");
  if (!saved) throw new Error("The PDF project was not autosaved.");
  for (let index = Object.keys(saved.scenes).length; index < 511; index += 1) {
    const id = `capacity-scene-${index}`;
    saved.scenes[id] = { id, name: id, elements: [], appState: {}, files: {} };
  }
  await setKeyvalValue(page, "patterdraw:autosave:project:v1", saved);
  await page.reload();
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const one = await PDFDocument.create();
  one.addPage([200, 200]);
  const bytes = Buffer.from(await one.save());
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles([
    { name: "one.pdf", mimeType: "application/pdf", buffer: bytes },
    { name: "two.pdf", mimeType: "application/pdf", buffer: bytes },
  ]);
  await expect(page.getByRole("alert")).toContainText("at most 1 more PDF page", { timeout: 10_000 });
  await expect(page.getByRole("dialog", { name: "Insert PDF pages", exact: true })).toHaveCount(0);
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1);
});

test("inserts ordered pages from multiple PDFs atomically and deduplicates identical sources", async ({ page }) => {
  test.setTimeout(90_000);
  const main = await PDFDocument.create();
  main.addPage([600, 700]);
  main.addPage([610, 710]);
  main.addPage([620, 720]);
  const mainBytes = await main.save();
  const periodic = await PDFDocument.create();
  periodic.addPage([500, 500]);
  const periodicBytes = await periodic.save();
  const supplement = await PDFDocument.create();
  supplement.addPage([300, 400]);
  supplement.addPage([310, 410]);
  const supplementBytes = await supplement.save();

  await page.getByLabel("Open project file").setInputFiles({
    name: "main.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(mainBytes),
  });
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(3, { timeout: 20_000 });
  await pages.nth(1).getByRole("button", { name: /Open output page 2:/ }).click();
  await expect(pages.nth(1)).toHaveClass(/is-selected/);

  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles([
    {
      name: "periodic-table.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(periodicBytes),
    },
    {
      name: "supplement.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(supplementBytes),
    },
    {
      name: "periodic-copy.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(periodicBytes),
    },
  ]);

  const dialog = page.getByRole("dialog", { name: "Insert PDF pages", exact: true });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const supplementRow = dialog.locator(".pdf-insert-file-row").filter({ hasText: "supplement.pdf" });
  await supplementRow.getByRole("button", { name: "Move supplement.pdf earlier" }).click();
  await supplementRow.getByLabel("Pages").fill("2");
  await expect(dialog.getByText("3 pages selected from 3 PDFs.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Insert 3 pages", exact: true }).click();

  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Add page", exact: true })).toBeFocused();
  await expect(pages).toHaveCount(6, { timeout: 30_000 });
  await expect(pages.nth(2)).toHaveClass(/is-selected/);
  await expect(pages.nth(2)).toContainText("supplement.pdf");
  await expect(pages.nth(2)).toContainText("Original page 2");
  await expect(pages.nth(3)).toContainText("periodic-table.pdf");
  await expect(pages.nth(4)).toContainText("periodic-copy.pdf");
  await expect(pages.nth(5)).toContainText("main.pdf");
  await expect(pages.nth(5)).toContainText("Original page 3");

  await expect.poll(async () => {
    const saved = await keyvalValue<{
      activeSceneId: string;
      pdfDocuments: Record<string, unknown>;
      pdfPageOrder: string[];
      scenes: Record<string, {
        pdfPage?: { documentId: string; pageIndex: number; sourceName?: string };
      }>;
    }>(page, "patterdraw:autosave:project:v1");
    if (!saved) return null;
    return {
      activeIndex: saved.pdfPageOrder.indexOf(saved.activeSceneId),
      documentCount: Object.keys(saved.pdfDocuments).length,
      pageIndices: saved.pdfPageOrder.map((id) => saved.scenes[id]?.pdfPage?.pageIndex),
      sourceNames: saved.pdfPageOrder.map((id) => saved.scenes[id]?.pdfPage?.sourceName),
    };
  }, { timeout: 20_000 }).toEqual({
    activeIndex: 2,
    documentCount: 3,
    pageIndices: [0, 1, 1, 0, 0, 2],
    sourceNames: [
      "main.pdf",
      "main.pdf",
      "supplement.pdf",
      "periodic-table.pdf",
      "periodic-copy.pdf",
      "main.pdf",
    ],
  });

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exported = await PDFDocument.load(await downloadBytes(await downloadEvent));
  expect(exported.getPageCount()).toBe(6);
  expect(exported.getPages().map((outputPage) => outputPage.getSize())).toEqual([
    { width: 600, height: 700 },
    { width: 610, height: 710 },
    { width: 310, height: 410 },
    { width: 500, height: 500 },
    { width: 500, height: 500 },
    { width: 620, height: 720 },
  ]);

  const saveEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const archiveBytes = await downloadBytes(await saveEvent);
  await page.reload();
  await page.getByLabel("Open project file").setInputFiles({
    name: "multi-pdf-roundtrip.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: archiveBytes,
  });
  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(pages).toHaveCount(6, { timeout: 20_000 });
  await expect(pages.nth(2)).toContainText("supplement.pdf");
  await expect(pages.nth(3)).toContainText("periodic-table.pdf");
  await expect(pages.nth(4)).toContainText("periodic-copy.pdf");
  await expect.poll(async () => Object.keys((await keyvalValue<{
    pdfDocuments: Record<string, unknown>;
  }>(page, "patterdraw:autosave:project:v1"))?.pdfDocuments || {})).toHaveLength(3);
});

test("adds a blank PDF page, reopens the project on Board, and exports it", async ({ page }) => {
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
  await page.getByRole("menuitem", { name: /Blank page/ }).click();
  await expect(pages).toHaveCount(2);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toHaveClass(/is-selected/);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toContainText("Blank page");
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toContainText("Added page");
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).not.toContainText("Original page");
  await expect(page.locator(".page-status")).toContainText("Page 2 of 2");

  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedProject = await (await saveDownload).createReadStream();
  const savedChunks: Buffer[] = [];
  for await (const chunk of savedProject) savedChunks.push(Buffer.from(chunk));
  const savedBytes = Buffer.concat(savedChunks);

  await page.reload();
  await page.getByLabel("Open project file").setInputFiles({
    name: "blank-page-roundtrip.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: savedBytes,
  });
  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".app-shell")).toHaveClass(/is-board-mode/);
  await expect(page.locator(".page-status")).toContainText("Board");
  await expect.poll(() => autosavedWorkspaceSummary(page)).toEqual({
    activeIsPdf: false,
    boardSceneCount: 1,
    pdfPageCount: 2,
  });

  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toContainText("Blank page");
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).toContainText("Added page");
  await expect(page.locator("#pdf-page-rail .pdf-page-item").nth(1)).not.toContainText("Original page");

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exportedPdf = await (await pdfDownload).createReadStream();
  const pdfChunks: Buffer[] = [];
  for await (const chunk of exportedPdf) pdfChunks.push(Buffer.from(chunk));
  const exported = await PDFDocument.load(Buffer.concat(pdfChunks));
  expect(exported.getPageCount()).toBe(2);
});

test("cleans deleted PDF bytes atomically when Web Locks are unavailable", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });
  await openTestPdf(page);
  await expect.poll(async () => Object.keys((
    await keyvalValue<{ pdfDocuments: Record<string, unknown> }>(
      page,
      "patterdraw:autosave:project:v1",
    )
  )?.pdfDocuments || {})).toHaveLength(1);
  const documentId = Object.keys((
    await keyvalValue<{ pdfDocuments: Record<string, unknown> }>(
      page,
      "patterdraw:autosave:project:v1",
    )
  )?.pdfDocuments || {})[0];
  if (!documentId) throw new Error("The imported PDF document was not saved.");
  const pdfKey = `patterdraw:autosave:pdf:v1:${documentId}`;
  await expect.poll(async () => (
    await keyvalValue<Uint8Array>(page, pdfKey)
  )?.byteLength || 0).toBeGreaterThan(0);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator("#pdf-page-rail .pdf-page-item")
    .first()
    .getByRole("button", { name: "Delete selected page", exact: true })
    .click();

  await expect.poll(async () => Object.keys((
    await keyvalValue<{ pdfDocuments: Record<string, unknown> }>(
      page,
      "patterdraw:autosave:project:v1",
    )
  )?.pdfDocuments || {})).toHaveLength(0);
  await expect.poll(() => keyvalValue(page, pdfKey)).toBeUndefined();
});

test("deletes the selected PDF page without renumbering its source page", async ({ page }) => {
  test.setTimeout(60_000);
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  document.addPage([612, 792]);
  const bytes = await document.save();
  await page.getByLabel("Open project file").setInputFiles({
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
  await page.getByLabel("Open project file").setInputFiles({
    name: "deleted-page-roundtrip.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
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
  test.setTimeout(90_000);
  const editor = page.locator(".editor-host .excalidraw");
  await editor.evaluate((node) => node.setAttribute("data-browser-instance", "original"));

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-slide-mode/);
  const addSlide = page.getByRole("button", { name: "Add slide", exact: true });
  await openSlideSettings(page);
  const drawAroundContent = page.getByRole("button", { name: "Draw slide", exact: true });
  await expect(addSlide).toBeVisible();
  await expect(drawAroundContent).toBeVisible();
  await page.getByRole("button", { name: "Slide settings", exact: true }).click();

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
  await openSlideSettings(page);
  await expect(drawAroundContent).toBeVisible();
  await page.getByRole("button", { name: "Slide settings", exact: true }).click();

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

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const inkColours = page.locator(".presentation-colour-swatch");
  await expect(inkColours).toHaveCount(6);
  await expect(page.getByRole("group", { name: "Ink colours" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Ink widths" })).toBeVisible();
  await expect(page.locator(".presentation-width-button")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Regular ink width", exact: true })).toHaveAttribute("aria-pressed", "true");
  const orangeInk = page.getByRole("button", { name: "Orange ink", exact: true });
  await expect(orangeInk).toHaveCSS("background-color", "rgb(232, 89, 12)");
  await orangeInk.hover();
  await expect(orangeInk).toHaveCSS("background-color", "rgb(232, 89, 12)");
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
  await expect(page.locator(".presentation-controls")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Hide slide navigator", exact: true }).click();
  await page.locator(".present-button").click();
  await expect(page.locator(".presentation-controls")).toHaveCSS("flex-direction", "column");
  await expect(page.getByRole("group", { name: "Ink colours" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Ink widths" })).toBeVisible();
  await expect(page.locator(".App-top-bar")).toBeHidden();
  await expect(page.locator(".App-bottom-bar")).toBeHidden();
  await expect(page.locator(".mobile-misc-tools-container")).toBeHidden();
  await expect(page.locator(".HintViewer")).toBeHidden();
  await page.getByRole("button", { name: "Exit", exact: true }).click();
});
