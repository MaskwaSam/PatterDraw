import { expect, test } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { strFromU8, unzipSync } from "fflate";

const DEVELOPMENT_EDITOR_MOUNT_TIMEOUT = 60_000;

async function downloadBytes(download: import("@playwright/test").Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright download stream was unavailable.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function rasterBytes(
  mimeType: "image/jpeg" | "image/png",
  width = 48,
  height = 32,
  transparent = false,
): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = mimeType === "image/png" ? "#2f6fed" : "#ef7d32";
  if (transparent && mimeType === "image/png") {
    context.fillRect(
      Math.floor(canvas.width / 4),
      Math.floor(canvas.height / 4),
      Math.ceil(canvas.width / 2),
      Math.ceil(canvas.height / 2),
    );
  } else {
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  return mimeType === "image/png"
    ? canvas.toBuffer("image/png")
    : canvas.toBuffer("image/jpeg");
}

function gifBytes(): Buffer {
  return Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function addPngTextChunk(png: Buffer, keyword: string, text: string): Buffer {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IEND") {
      const chunkType = Buffer.from("tEXt", "ascii");
      const chunkData = Buffer.from(`${keyword}\0${text}`, "latin1");
      const chunk = Buffer.alloc(12 + chunkData.length);
      chunk.writeUInt32BE(chunkData.length, 0);
      chunkType.copy(chunk, 4);
      chunkData.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(Buffer.concat([chunkType, chunkData])), 8 + chunkData.length);
      return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset)]);
    }
    offset += 12 + length;
  }
  throw new Error("PNG did not contain an IEND chunk.");
}

function rectangleElement(id: string, index = "a0") {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 120,
    height: 80,
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
    index,
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
}

function imageElement(id: string, fileId: string, width: number, height: number) {
  return {
    ...rectangleElement(id),
    type: "image",
    width,
    height,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
  };
}

async function pasteExcalidrawClipboardImage(
  page: import("@playwright/test").Page,
  file: { bytes: Buffer; height: number; mimeType: "image/jpeg" | "image/png"; width: number },
  id: string,
): Promise<void> {
  await page.locator("canvas.excalidraw__canvas.interactive").click({ position: { x: 480, y: 300 } });
  await page.locator("canvas.excalidraw__canvas.interactive").evaluate((target, payload) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [payload.element],
      files: {
        [payload.fileId]: {
          id: payload.fileId,
          mimeType: payload.mimeType,
          dataURL: `data:${payload.mimeType};base64,${payload.base64}`,
          created: Date.now(),
          lastRetrieved: Date.now(),
        },
      },
    }));
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, {
    base64: file.bytes.toString("base64"),
    element: imageElement(`${id}-element`, `${id}-file`, file.width, file.height),
    fileId: `${id}-file`,
    mimeType: file.mimeType,
  });
}

async function dropFile(
  page: import("@playwright/test").Page,
  file: { bytes: Buffer; mimeType: string; name: string },
  offset: { x: number; y: number },
  targetSelector = "canvas.excalidraw__canvas.interactive",
  extraData?: { mimeType: string; value: string },
): Promise<void> {
  await page.locator(targetSelector).evaluate((target, payload) => {
    const binary = atob(payload.base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    if (payload.extraData) transfer.setData(payload.extraData.mimeType, payload.extraData.value);
    transfer.items.add(new File([bytes], payload.name, { type: payload.mimeType }));
    const bounds = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + payload.offset.x,
      clientY: bounds.top + payload.offset.y,
      dataTransfer: transfer,
    };
    target.dispatchEvent(new DragEvent("dragenter", eventInit));
    target.dispatchEvent(new DragEvent("dragover", eventInit));
    target.dispatchEvent(new DragEvent("drop", eventInit));
  }, {
    base64: file.bytes.toString("base64"),
    mimeType: file.mimeType,
    name: file.name,
    offset,
    extraData,
  });
}

async function dropTransfer(
  page: import("@playwright/test").Page,
  data: { mimeType: string; value: string } | Array<{ mimeType: string; value: string }>,
  offset: { x: number; y: number },
): Promise<void> {
  await page.locator("canvas.excalidraw__canvas.interactive").evaluate((target, payload) => {
    const transfer = new DataTransfer();
    const entries = Array.isArray(payload.data) ? payload.data : [payload.data];
    for (const entry of entries) transfer.setData(entry.mimeType, entry.value);
    const bounds = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + payload.offset.x,
      clientY: bounds.top + payload.offset.y,
      dataTransfer: transfer,
    };
    target.dispatchEvent(new DragEvent("dragenter", eventInit));
    target.dispatchEvent(new DragEvent("dragover", eventInit));
    target.dispatchEvent(new DragEvent("drop", eventInit));
  }, { data, offset });
}

async function autosavedImageSummary(page: import("@playwright/test").Page): Promise<{
  count: number;
  embeddedSceneMetadataCount: number;
  mimeTypes: string[];
  naturalSizes: string[];
  transparentCount: number;
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
        elements: Array<{ fileId?: string; type: string }>;
        files: Record<string, { dataURL?: string; mimeType?: string }>;
      }>;
    } | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly")
        .objectStore("keyval")
        .get("patterdraw:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const scene = project?.scenes[project.activeSceneId];
    const images = scene?.elements.filter((element) => element.type === "image") || [];
    const decodedImages = await Promise.all(images.flatMap((element) => {
      const dataURL = element.fileId ? scene?.files[element.fileId]?.dataURL : undefined;
      if (!dataURL) return [];
      return [new Promise<{ naturalSize: string; transparent: boolean }>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext("2d");
          if (!context) return reject(new Error("Stored image could not be sampled."));
          context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
          resolve({
            naturalSize: `${image.naturalWidth}x${image.naturalHeight}`,
            transparent: context.getImageData(0, 0, 1, 1).data[3] === 0,
          });
        };
        image.onerror = () => reject(new Error("Stored image could not be decoded."));
        image.src = dataURL;
      })];
    }));
    const persistedDataUrls = images.flatMap((element) => {
      const dataURL = element.fileId ? scene?.files[element.fileId]?.dataURL : undefined;
      return dataURL ? [dataURL] : [];
    });
    return {
      count: images.length,
      embeddedSceneMetadataCount: persistedDataUrls.filter((dataURL) => {
        const payload = dataURL.slice(dataURL.indexOf(",") + 1);
        return atob(payload).includes("application/vnd.excalidraw+json");
      }).length,
      mimeTypes: images.flatMap((element) => (
        element.fileId && scene?.files[element.fileId]?.mimeType
          ? [scene.files[element.fileId].mimeType || ""]
          : []
      )).sort(),
      naturalSizes: decodedImages.map(({ naturalSize }) => naturalSize).sort(),
      transparentCount: decodedImages.filter(({ transparent }) => transparent).length,
    };
  });
}

async function autosavedSceneElements(
  page: import("@playwright/test").Page,
): Promise<Array<{
  customData?: { classroomGeoGon?: { transfer?: string; version?: number } };
  id?: string;
  text?: string;
  type?: string;
}>> {
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
          customData?: { classroomGeoGon?: { transfer?: string; version?: number } };
          id?: string;
          text?: string;
          type?: string;
        }>;
      }>;
    } | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly")
        .objectStore("keyval")
        .get("patterdraw:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return project?.scenes[project.activeSceneId]?.elements || [];
  });
}

test("preflights native images and persists PNG/JPEG without unsafe MIME loss", async ({ page }) => {
  const externalRequests: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "blob:" && url.protocol !== "data:" && url.hostname !== "127.0.0.1") {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.evaluate(() => {
    const host = window as typeof window & {
      __patterdrawIframeMutationCount?: number;
      __patterdrawIframeObserver?: MutationObserver;
    };
    host.__patterdrawIframeMutationCount = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && (node.matches("iframe") || node.querySelector("iframe"))) {
            host.__patterdrawIframeMutationCount = (host.__patterdrawIframeMutationCount || 0) + 1;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    host.__patterdrawIframeObserver = observer;
  });
  const embeddedScenePng = addPngTextChunk(
    rasterBytes("image/png"),
    "application/vnd.excalidraw+json",
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [{ ...rectangleElement("blocked-png-frame"), type: "iframe" }],
      appState: {},
      files: {},
    }),
  );
  await page.evaluate(() => {
    const host = window as typeof window & {
      __patterdrawCreateImageBitmap?: typeof createImageBitmap;
    };
    host.__patterdrawCreateImageBitmap = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
      writable: true,
    });
  });
  try {
    await dropFile(page, {
      bytes: embeddedScenePng,
      mimeType: "IMAGE/PNG; charset=binary",
      name: "lesson-with-scene.png",
    }, { x: 460, y: 260 });
    await expect.poll(() => autosavedImageSummary(page)).toEqual({
      count: 1,
      embeddedSceneMetadataCount: 0,
      mimeTypes: ["image/png"],
      naturalSizes: ["48x32"],
      transparentCount: 0,
    });
  } finally {
    await page.evaluate(() => {
      const host = window as typeof window & {
        __patterdrawCreateImageBitmap?: typeof createImageBitmap;
      };
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: host.__patterdrawCreateImageBitmap,
        writable: true,
      });
      delete host.__patterdrawCreateImageBitmap;
    });
  }
  await expect(page.locator("iframe")).toHaveCount(0);
  await dropFile(page, {
    bytes: embeddedScenePng,
    mimeType: "",
    name: "scene-pixels-without-a-type.bin",
  }, { x: 560, y: 300 });
  await dropFile(page, {
    bytes: embeddedScenePng,
    mimeType: "application/octet-stream",
    name: "scene-pixels-with-a-png-name.png",
  }, { x: 660, y: 320 });
  await dropFile(page, {
    bytes: embeddedScenePng,
    mimeType: "application/x-patterdraw-screenshot",
    name: "scene-pixels-with-screenshot-metadata.bin",
  }, { x: 760, y: 340 }, "canvas.excalidraw__canvas.interactive", {
    mimeType: "application/x-patterdraw-screenshot",
    value: "not-a-real-screenshot-id",
  });
  await dropFile(page, {
    bytes: rasterBytes("image/jpeg", 1_800, 900),
    mimeType: "image/jpeg",
    name: "large-lesson.jpg",
  }, { x: 820, y: 420 });
  await dropFile(page, {
    bytes: gifBytes(),
    mimeType: "image/gif",
    name: "lesson.gif",
  }, { x: 860, y: 440 });

  await expect.poll(() => autosavedImageSummary(page)).toEqual({
    count: 6,
    embeddedSceneMetadataCount: 0,
    mimeTypes: ["image/jpeg", "image/png", "image/png", "image/png", "image/png", "image/png"],
    naturalSizes: ["1440x720", "1x1", "48x32", "48x32", "48x32", "48x32"],
    transparentCount: 0,
  });

  await dropFile(page, {
    bytes: rasterBytes("image/png", 1_800, 900, true),
    mimeType: "image/png",
    name: "large-lesson.png",
  }, { x: 640, y: 340 });
  await expect.poll(() => autosavedImageSummary(page)).toEqual({
    count: 7,
    embeddedSceneMetadataCount: 0,
    mimeTypes: ["image/jpeg", "image/png", "image/png", "image/png", "image/png", "image/png", "image/png"],
    naturalSizes: ["1440x720", "1440x720", "1x1", "48x32", "48x32", "48x32", "48x32"],
    transparentCount: 1,
  });

  await dropFile(page, {
    bytes: Buffer.from([0x42, 0x4d, 0, 0, 0, 0]),
    mimeType: "image/bmp",
    name: "unsupported.bmp",
  }, { x: 640, y: 340 });
  await expect(page.getByText(/supports PNG, JPEG, GIF, WebP, and safe SVG images/i)).toBeVisible();
  await expect.poll(() => autosavedImageSummary(page)).toEqual({
    count: 7,
    embeddedSceneMetadataCount: 0,
    mimeTypes: ["image/jpeg", "image/png", "image/png", "image/png", "image/png", "image/png", "image/png"],
    naturalSizes: ["1440x720", "1440x720", "1x1", "48x32", "48x32", "48x32", "48x32"],
    transparentCount: 1,
  });

  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __patterdrawIframeMutationCount?: number }).__patterdrawIframeMutationCount || 0
  ))).toBe(0);

  // Wrapper-owned image insertion leaves the newest accepted image selected;
  // exercise the public UI instead of Excalidraw's development-only `window.h`.
  await page.getByRole("button", { name: "Size & Position", exact: true }).click();
  const sizePosition = page.locator(".exc-stats");
  await expect(sizePosition).toBeVisible();
  for (const [testId, label] of [["X", "X position"], ["Y", "Y position"], ["W", "Width"], ["H", "Height"], ["A", "Angle"]] as const) {
    await expect(sizePosition.getByTestId(testId).locator("input")).toHaveAttribute("aria-label", label);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 7,
    mimeTypes: ["image/jpeg", "image/png", "image/png", "image/png", "image/png", "image/png", "image/png"],
  });
  expect(externalRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("pastes and restores a local 3DGeoGon vector export", async ({ page }) => {
  const externalRequests: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "blob:" && url.protocol !== "data:" && url.hostname !== "127.0.0.1") {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  const projectTitle = page.getByRole("textbox", { name: "Project title", exact: true });
  await projectTitle.fill("3DGeoGon save verification");
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  await canvas.click({ position: { x: 500, y: 340 } });
  await canvas.evaluate((target, source) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", source);
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, `
    <svg width="640" height="480" viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg">
      <!-- Created with 3DGeoGon true vector SVG export -->
      <polygon points="20,20 180,40 120,180" fill="#7db3e8" stroke="#1e1e1e"/>
      <line x1="20" y1="20" x2="120" y2="180" stroke="#1e1e1e"/>
      <text x="20" y="18">A</text>
    </svg>
  `);

  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    mimeTypes: ["image/svg+xml"],
    naturalSizes: ["640x480"],
  });
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).find((element) => element.type === "image")
      ?.customData?.classroomGeoGon
  )).toEqual({ transfer: "svg", version: 1 });
  await expect(page.locator("iframe")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    mimeTypes: ["image/svg+xml"],
    naturalSizes: ["640x480"],
  });
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).find((element) => element.type === "image")
      ?.customData?.classroomGeoGon
  )).toEqual({ transfer: "svg", version: 1 });

  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedBytes = await downloadBytes(await saveDownload);
  const savedProject = JSON.parse(strFromU8(unzipSync(savedBytes)["project.json"])) as {
    activeSceneId: string;
    scenes: Record<string, {
      elements: Array<{
        customData?: { classroomGeoGon?: { transfer?: string; version?: number } };
        fileId?: string;
        type?: string;
      }>;
      files: Record<string, { dataURL?: string; mimeType?: string }>;
    }>;
  };
  const savedScene = savedProject.scenes[savedProject.activeSceneId];
  const savedGeoGonImage = savedScene.elements.find((element) => (
    element.type === "image" && element.customData?.classroomGeoGon?.version === 1
  ));
  expect(savedGeoGonImage?.customData?.classroomGeoGon).toEqual({
    transfer: "svg",
    version: 1,
  });
  const savedGeoGonFile = savedGeoGonImage?.fileId
    ? savedScene.files[savedGeoGonImage.fileId]
    : undefined;
  expect(savedGeoGonFile?.mimeType).toBe("image/svg+xml");
  expect(Buffer.from(
    savedGeoGonFile?.dataURL?.slice(savedGeoGonFile.dataURL.indexOf(",") + 1) || "",
    "base64",
  ).toString("utf8")).toContain("Created with 3DGeoGon true vector SVG export");

  await projectTitle.fill("Temporary project title");
  await expect(projectTitle).toHaveValue("Temporary project title");
  await page.getByLabel("Open project file").setInputFiles({
    name: "3DGeoGon-round-trip.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: savedBytes,
  });
  const projectSwitch = page.getByRole("dialog", {
    name: "Open another project?",
    exact: true,
  });
  await expect(projectSwitch).toBeVisible();
  await projectSwitch.getByRole("button", {
    name: "Open without downloading",
    exact: true,
  }).click();
  await expect(projectTitle).toHaveValue("3DGeoGon save verification");
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    mimeTypes: ["image/svg+xml"],
    naturalSizes: ["640x480"],
  });
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).find((element) => element.type === "image")
      ?.customData?.classroomGeoGon
  )).toEqual({ transfer: "svg", version: 1 });
  expect(externalRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("builds in the bundled GeoGon dialog and persists only its local vector handoff", async ({ page }) => {
  test.setTimeout(180_000);
  const externalRequests: string[] = [];
  const geoGonRequests: string[] = [];
  const httpRequests: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/geogon/")) geoGonRequests.push(url.pathname);
    if (url.protocol === "http:" || url.protocol === "https:") httpRequests.push(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname !== "127.0.0.1"
    ) externalRequests.push(request.url());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-math-tools").click();
  const mathTools = page.getByRole("dialog", { name: "Math tools", exact: true });
  const geoGonCard = page.getByTestId("math-tool-geogon");
  await expect(geoGonCard).toHaveCount(0);
  await mathTools.getByRole("switch", { name: "Experimental features", exact: true }).check();
  await expect(geoGonCard).toContainText("Build a 3D geometry view");
  await geoGonCard.click();

  const dialog = page.getByRole("dialog", { name: "3D GeoGon", exact: true });
  const frameElement = dialog.locator("iframe.geogon-frame");
  const frame = page.frameLocator("iframe.geogon-frame");
  const insert = dialog.getByTestId("geogon-insert");
  await expect(dialog).toBeVisible();
  await expect(frameElement).toHaveAttribute(
    "src",
    /\/geogon\/index\.html\?host=patterdraw&patterdraw-geogon=386e47223740ed9955ae1fe8a022516fea98d57f$/,
  );
  await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads");
  await expect(frameElement).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(insert).toBeEnabled({ timeout: 75_000 });
  await expect(frame.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await frame.getByRole("button", { name: "Add", exact: true }).click();
  await frame.getByRole("button", { name: "+ Right Rectangular Prism", exact: true }).click();
  await expect(frame.getByRole("button", { name: "Remove Right Rectangular Prism", exact: true })).toBeVisible();

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    const dialogBounds = await dialog.boundingBox();
    const insertBounds = await insert.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(insertBounds).not.toBeNull();
    expect(dialogBounds?.x || 0).toBeGreaterThanOrEqual(0);
    expect(dialogBounds?.y || 0).toBeGreaterThanOrEqual(0);
    expect((dialogBounds?.x || 0) + (dialogBounds?.width || 0)).toBeLessThanOrEqual(viewport.width);
    expect((dialogBounds?.y || 0) + (dialogBounds?.height || 0)).toBeLessThanOrEqual(viewport.height);
    expect((insertBounds?.y || 0) + (insertBounds?.height || 0)).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await frame.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }

  await insert.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    mimeTypes: ["image/svg+xml"],
  });
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).find((element) => element.type === "image")
      ?.customData?.classroomGeoGon
  )).toEqual({ transfer: "svg", version: 1 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    mimeTypes: ["image/svg+xml"],
  });
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).find((element) => element.type === "image")
      ?.customData?.classroomGeoGon
  )).toEqual({ transfer: "svg", version: 1 });
  expect(geoGonRequests.some((pathname) => pathname.endsWith("/geogon/index.html"))).toBe(true);
  expect(geoGonRequests.some((pathname) => pathname.endsWith("/geogon/app.js"))).toBe(true);
  expect(httpRequests.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  expect(externalRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("surfaces a slow GeoGon startup failure and retries with a fresh local frame", async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.install({ time: new Date("2026-08-31T12:00:00Z") });

  let frameRequestCount = 0;
  await page.route(/\/geogon\/index\.html(?:\?.*)?$/, async (route) => {
    frameRequestCount += 1;
    const generation = frameRequestCount;
    const readyScript = generation > 1
      ? `<script>
          window.threeDGeoGonApp = {
            localStateReady: true,
            buildObjectSvgMarkup: () => '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24"/></svg>',
          };
        </script>`
      : "";
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>
        <html data-geogon-fixture-generation="${generation}">
          <body><button id="start-btn" type="button">Start fixture</button>${readyScript}</body>
        </html>`,
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-math-tools").click();
  const mathTools = page.getByRole("dialog", { name: "Math tools", exact: true });
  await mathTools.getByRole("switch", { name: "Experimental features", exact: true }).check();
  await page.getByTestId("math-tool-geogon").click();

  const dialog = page.getByRole("dialog", { name: "3D GeoGon", exact: true });
  const frameElement = dialog.locator("iframe.geogon-frame");
  const frame = page.frameLocator("iframe.geogon-frame");
  const insert = dialog.getByTestId("geogon-insert");
  await expect(frame.locator("html")).toHaveAttribute("data-geogon-fixture-generation", "1");
  const firstFrameElement = await frameElement.elementHandle();
  expect(firstFrameElement).not.toBeNull();
  await expect(insert).toBeDisabled();

  await page.clock.fastForward(15_100);
  await expect(dialog).toContainText("GeoGon is taking longer than usual to start on this device…");
  await frame.locator("html").evaluate((root) => {
    root.classList.add("startup-failed");
    const message = document.createElement("p");
    message.id = "startup-error-message";
    message.textContent = "Fixture renderer could not create a local WebGL context.";
    document.body.append(message);
  });

  await page.clock.runFor(100);
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("Fixture renderer could not create a local WebGL context.", { timeout: 2_000 });

  await alert.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => frameRequestCount).toBe(2);
  await expect(frame.locator("html")).toHaveAttribute("data-geogon-fixture-generation", "2");
  await expect.poll(async () => firstFrameElement?.evaluate((element) => element.isConnected)).toBe(false);
  await expect(alert).toBeHidden();
  await expect(dialog).toContainText("GeoGon is ready. Build a diagram, then insert its vector view.");
  await expect(insert).toBeEnabled();
});

test("preflights native and JSON clipboard images before insertion", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.evaluate(() => {
    const host = window as typeof window & {
      __patterdrawIframeMutationCount?: number;
    };
    host.__patterdrawIframeMutationCount = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && (node.matches("iframe") || node.querySelector("iframe"))) {
            host.__patterdrawIframeMutationCount = (host.__patterdrawIframeMutationCount || 0) + 1;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
  const sceneBearingPng = addPngTextChunk(
    rasterBytes("image/png"),
    "application/vnd.excalidraw+json",
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "clipboard",
      elements: [{ ...rectangleElement("blocked-clipboard-frame"), type: "iframe" }],
      appState: {},
      files: {},
    }),
  );
  const pasteImage = async (bytes: Buffer, name: string, mimeType = "image/png") => {
    await page.locator("canvas.excalidraw__canvas.interactive").click({ position: { x: 480, y: 300 } });
    await page.locator("canvas.excalidraw__canvas.interactive").evaluate((target, payload) => {
      const binary = atob(payload.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], payload.name, { type: payload.mimeType }));
      target.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
    }, { base64: bytes.toString("base64"), mimeType, name });
  };

  await pasteImage(sceneBearingPng, "clipboard-scene.png");
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 0 });
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __patterdrawIframeMutationCount?: number }).__patterdrawIframeMutationCount || 0
  ))).toBe(0);

  // Excalidraw reports a rejected native image through its modal error surface;
  // reload before proving that an ordinary clipboard PNG still works.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await pasteImage(rasterBytes("image/png"), "clipboard-ordinary.png");
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    embeddedSceneMetadataCount: 0,
    mimeTypes: ["image/png"],
  });
  await pasteImage(gifBytes(), "clipboard-lesson.gif", "image/gif");
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 2,
    mimeTypes: ["image/png", "image/png"],
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 2,
    mimeTypes: ["image/png", "image/png"],
  });

  await pasteExcalidrawClipboardImage(page, {
    bytes: sceneBearingPng,
    height: 32,
    mimeType: "image/png",
    width: 48,
  }, "json-scene");
  await expect(page.getByText(/unsupported embedded scene data/i)).toBeVisible();
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 2 });

  await pasteExcalidrawClipboardImage(page, {
    bytes: rasterBytes("image/jpeg", 1_800, 900),
    height: 900,
    mimeType: "image/jpeg",
    width: 1_800,
  }, "json-oversized");
  await expect(page.getByText(/use the Image tool so PatterDraw can resize it safely/i)).toBeVisible();
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 2 });

  await pasteExcalidrawClipboardImage(page, {
    bytes: rasterBytes("image/png"),
    height: 32,
    mimeType: "image/png",
    width: 48,
  }, "json-safe");
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 3,
    embeddedSceneMetadataCount: 0,
    mimeTypes: ["image/png", "image/png", "image/png"],
  });

  await page.locator("canvas.excalidraw__canvas.interactive").evaluate((target, base64) => {
    const files = Object.fromEntries(Array.from({ length: 33 }, (_, index) => {
      const id = `many-json-file-${index}`;
      return [id, {
        id,
        mimeType: "image/png",
        dataURL: `data:image/png;base64,${base64}`,
        created: Date.now(),
        lastRetrieved: Date.now(),
      }];
    }));
    const transfer = new DataTransfer();
    transfer.setData("text/plain", JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [],
      files,
    }));
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, rasterBytes("image/png").toString("base64"));
  await expect(page.getByText(/too many images to paste safely/i)).toBeVisible();
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 3 });
});

test("accepts only existing Screenshot Library IDs from custom or portable text drags", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.evaluate(async (base64) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").put({
        version: 1,
        items: [{
          id: "portable-screenshot",
          createdAt: Date.now(),
          blob: new Blob([bytes], { type: "image/png" }),
          width: 12,
          height: 8,
          sceneWidth: 12,
          sceneHeight: 8,
        }],
      }, "patterdraw:screenshot-library:v1");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, rasterBytes("image/png", 12, 8).toString("base64"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });

  await page.getByRole("button", { name: "Library", exact: true }).click();
  const screenshotTab = page.locator('.default-sidebar .sidebar-tab-trigger[aria-label="Screenshot Library"]');
  await expect(screenshotTab).toBeVisible();
  await screenshotTab.click();
  const screenshotPanel = page.getByRole("region", { name: "Screenshot Library", exact: true });
  await expect(screenshotPanel).toBeVisible();
  await expect(screenshotPanel.locator('[data-screenshot-id="portable-screenshot"]')).toBeVisible();

  // A valid screenshot ID remains authoritative even if a browser also adds
  // a File to the drag payload. The file must not be inserted as a duplicate.
  await dropFile(page, {
    bytes: rasterBytes("image/jpeg"),
    mimeType: "image/jpeg",
    name: "browser-provided-drag-preview.jpg",
  }, { x: 480, y: 300 }, "canvas.excalidraw__canvas.interactive", {
    mimeType: "application/x-patterdraw-screenshot",
    value: "portable-screenshot",
  });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({
    count: 1,
    mimeTypes: ["image/png"],
    naturalSizes: ["12x8"],
  });

  // ScreenshotLibrary emits its custom ID first and also text/plain for
  // desktop/browser portability. A valid custom ID wins over arbitrary text.
  await dropTransfer(page, [
    { mimeType: "application/x-patterdraw-screenshot", value: "portable-screenshot" },
    { mimeType: "text/plain", value: "not-a-screenshot-id" },
  ], { x: 520, y: 320 });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 2 });

  // Never fall back to text/plain when a custom screenshot type is present,
  // even if that custom value is stale or attacker-controlled.
  await dropTransfer(page, [
    { mimeType: "application/x-patterdraw-screenshot", value: "stale-screenshot-id" },
    { mimeType: "text/plain", value: "portable-screenshot" },
  ], { x: 620, y: 320 });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 2 });

  // A browser that preserves only text/plain can still place a known local
  // screenshot. Unknown text remains inert and is never treated as an image.
  await dropTransfer(page, { mimeType: "text/plain", value: "portable-screenshot" }, { x: 720, y: 320 });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 3 });
  await dropTransfer(page, { mimeType: "text/plain", value: "https://example.invalid/not-an-id" }, { x: 820, y: 320 });
  await expect.poll(() => autosavedImageSummary(page)).toMatchObject({ count: 3 });
});

test("strips public-library URL import tokens before the editor mounts", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "blob:" && url.protocol !== "data:" && url.hostname !== "127.0.0.1") {
      externalRequests.push(request.url());
    }
  });
  await page.goto(
    "/?addLibrary=https%3A%2F%2Fexample.invalid%2Fpublic.excalidrawlib&token=query-secret#addLibrary=https%3A%2F%2Fexample.invalid%2Fhash.excalidrawlib&token=hash-secret",
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(() => page.evaluate(() => `${location.search}${location.hash}`)).toBe("");
  expect(externalRequests).toEqual([]);
});

test("blocks mixed HTML and sanitizes stored iframe library items", async ({ page }) => {
  const externalRequests: string[] = [];
  await page.addInitScript(() => {
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
    const remote = ["https", "://example.invalid/context.png"].join("");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: async () => [{
          types: ["text/html", "text/plain"],
          getType: async (type: string) => new Blob([
            type === "text/html" ? `<${"img"} src="${remote}">` : "Safe classroom note",
          ], { type }),
          presentationStyle: "unspecified",
        }],
        readText: async () => "Safe classroom note",
        write: async () => undefined,
        writeText: async () => undefined,
      },
    });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "blob:" && url.protocol !== "data:" && url.hostname !== "127.0.0.1") {
      externalRequests.push(request.url());
    }
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  await canvas.click({ position: { x: 500, y: 350 } });
  await canvas.evaluate((host) => {
    const remote = ["https", "://example.invalid/classroom.png"].join("");
    const transfer = new DataTransfer();
    transfer.setData("text/html", `<${"img"} src="${remote}">`);
    host.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(page.getByText("Embedded web content and URL-backed images are disabled.", { exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);

  await canvas.evaluate((canvas) => {
    let customData: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 70; index += 1) customData = { next: customData };
    const transfer = new DataTransfer();
    transfer.setData("text/plain", JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [{
        ...({
          id: "deep-clipboard-element",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        }),
        customData,
      }],
      files: {},
    }));
    canvas.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  });
  await expect(page.getByText(/Clipboard drawing exceeds the maximum structural depth/i)).toBeVisible();
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).some((element) => element.id === "deep-clipboard-element")
  )).toBe(false);

  const blockedFrame = {
    ...rectangleElement("blocked-clipboard-frame"),
    type: "iframe",
    customData: { generationData: { html: "<p>Blocked classroom frame</p>" } },
  };
  await canvas.evaluate((canvas, frame) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [frame],
      files: {},
    }));
    canvas.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, blockedFrame);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).filter((element) => element.type === "iframe").length
  )).toBe(0);

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".layer-ui__library")).toBeVisible();
  let nestedSceneData: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 70; index += 1) nestedSceneData = { next: nestedSceneData };
  await dropFile(page, {
    bytes: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [{ ...rectangleElement("deep-native-scene"), customData: nestedSceneData }],
      appState: {},
      files: {},
    })),
    mimeType: "application/vnd.excalidraw+json",
    name: "pathological-native-scene",
  }, { x: 20, y: 20 }, ".layer-ui__library");
  await expect(page.getByText(/maximum structural depth/i)).toBeVisible();
  await expect.poll(async () => (
    (await autosavedSceneElements(page)).some((element) => element.id === "deep-native-scene")
  )).toBe(false);

  await dropFile(page, {
    bytes: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      elements: [
        rectangleElement("safe-extensionless-project-rectangle"),
        blockedFrame,
      ],
      appState: {},
      files: {},
    })),
    mimeType: "application/vnd.excalidraw+json",
    name: "extensionless-classroom-project",
  }, { x: 20, y: 20 }, ".layer-ui__library");
  await expect.poll(async () => {
    const elements = await autosavedSceneElements(page);
    return {
      hasSafeRectangle: elements.some((element) => element.id === "safe-extensionless-project-rectangle"),
      iframeCount: elements.filter((element) => element.type === "iframe").length,
    };
  }).toEqual({ hasSafeRectangle: true, iframeCount: 0 });
  await expect(page.locator("iframe")).toHaveCount(0);

  await page.locator(".editor-host").click({ button: "right", position: { x: 500, y: 350 } });
  await page.getByTestId("paste").click();
  await expect.poll(async () => (
    (await autosavedSceneElements(page))
      .some((element) => element.type === "text" && element.text === "Safe classroom note")
  )).toBe(true);

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").put([{
        id: "blocked-library-item",
        status: "unpublished",
        created: 1,
        elements: [{ id: "blocked-frame", type: "iframe", link: "local-review" }],
      }], "patterdraw:library:v1");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: DEVELOPMENT_EDITOR_MOUNT_TIMEOUT });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".layer-ui__library")).toBeVisible();
  await expect(page.locator(".library-unit__active")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly")
        .objectStore("keyval")
        .get("patterdraw:library:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return stored;
  })).toEqual([]);

  const panel = page.locator(".layer-ui__library");
  await panel.getByTestId("dropdown-menu-button").click();
  const rejectedChooserEvent = page.waitForEvent("filechooser");
  await page.getByTestId("lib-dropdown--load").click();
  let nestedLibraryData: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 70; index += 1) nestedLibraryData = { next: nestedLibraryData };
  await (await rejectedChooserEvent).setFiles({
    name: "pathological-library.excalidrawlib",
    mimeType: "application/vnd.excalidrawlib+json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      source: "local",
      libraryItems: [{
        id: "pathological-library-item",
        status: "unpublished",
        created: 1,
        customData: nestedLibraryData,
        elements: [rectangleElement("pathological-library-rectangle")],
      }],
    })),
  });
  await expect(page.getByText(/maximum structural depth/i)).toBeVisible();
  await expect(panel.locator(".library-unit__active")).toHaveCount(0);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(panel).toBeVisible();

  await panel.getByTestId("dropdown-menu-button").click();
  const chooserEvent = page.waitForEvent("filechooser");
  await page.getByTestId("lib-dropdown--load").click();
  const safeRectangle = rectangleElement("safe-library-rectangle");
  await (await chooserEvent).setFiles({
    name: "reviewed-library.excalidrawlib",
    mimeType: "application/vnd.excalidrawlib+json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      source: "local",
      libraryItems: [{
        id: "mixed-library-item",
        status: "unpublished",
        created: 1,
        elements: [
          safeRectangle,
          { ...safeRectangle, id: "blocked-library-frame", type: "iframe", index: "a1", link: "local-review" },
        ],
      }],
    })),
  });
  await expect(panel.locator(".library-unit__active")).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<Array<{ elements?: Array<{ link?: unknown; type?: string }> }> | undefined>((resolve, reject) => {
      const request = database.transaction("keyval", "readonly")
        .objectStore("keyval")
        .get("patterdraw:library:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return stored?.map((item) => item.elements?.map((element) => ({
      link: element.link,
      type: element.type,
    })));
  })).toEqual([[{ link: null, type: "rectangle" }]]);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
