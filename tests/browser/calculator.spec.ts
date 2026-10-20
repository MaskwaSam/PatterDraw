import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";

const panel = (page: Page) => page.getByTestId("calculator-panel");
const calc = (page: Page) => panel(page).locator("#calc");
const screen = (page: Page) => panel(page).locator(".screen");

async function openMathTools(page: Page) {
  const banner = page.locator(".local-readiness-banner");
  if (await banner.isVisible()) await banner.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await page.getByTestId("toolbar-math-tools").click();
  await expect(page.getByTestId("math-tool-calculator")).toBeVisible();
}

async function showCalculator(page: Page) {
  await openMathTools(page);
  await expect(page.getByTestId("math-tool-calculator")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("math-tool-calculator").click();
  await expect(panel(page)).toBeVisible();
  await expect(calc(page).locator('[data-k="enter"]')).toBeVisible();
}

async function savedElements(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const project = await new Promise<{
        activeSceneId: string;
        scenes: Record<string, { elements: Array<{ id: string; type: string; isDeleted?: boolean; x: number; y: number; width: number; height: number; fileId?: string }> }>;
      }>((resolve, reject) => {
        const request = db.transaction("keyval", "readonly").objectStore("keyval").get("patterdraw:autosave:project:v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return project?.scenes[project.activeSceneId]?.elements.filter((element) => !element.isDeleted) ?? [];
    } finally {
      db.close();
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0);
});

test("calculator toggles without losing input or remounting the usable board", async ({ page }) => {
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = new URL(page.url()).origin;
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) remoteRequests.push(request.url());
  });
  const canvas = await page.locator("canvas.excalidraw__canvas.interactive").elementHandle();
  await expect(panel(page)).toHaveCount(0);
  await showCalculator(page);
  await calc(page).focus();
  await page.keyboard.type("12+30");
  await page.keyboard.press("Enter");
  await expect(screen(page)).toContainText("42");
  await page.keyboard.type("+8");
  await panel(page).getByRole("button", { name: "Hide calculator", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await showCalculator(page);
  await calc(page).focus();
  await page.keyboard.press("Enter");
  await expect(screen(page)).toContainText("50");
  await expect.poll(() => savedElements(page)).toEqual([]);
  expect(await canvas?.evaluate((node) => node.isConnected)).toBe(true);

  // Real board pointer input must remain available outside the floating panel.
  await page.mouse.click(440, 390);
  await page.keyboard.press("r");
  await page.mouse.move(420, 360);
  await page.mouse.down();
  await page.mouse.move(560, 460, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await savedElements(page)).map((element) => element.type)).toEqual(["rectangle"]);
  const boardBefore = await savedElements(page);
  await calc(page).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await page.keyboard.type("7*6");
  await page.keyboard.press("Enter");
  await expect(screen(page)).toContainText("42");
  expect(await savedElements(page)).toEqual(boardBefore);

  await openMathTools(page);
  await expect(page.getByTestId("math-tool-calculator")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("math-tool-calculator").click();
  await expect(panel(page)).toBeHidden();
  await showCalculator(page);
  await expect(screen(page)).toContainText("42");
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test("calculator can be moved with pointer and keyboard and fits a small screen", async ({ page }) => {
  await showCalculator(page);
  const move = panel(page).getByRole("button", { name: "Move calculator", exact: true });
  const initial = await panel(page).boundingBox();
  if (!initial) throw new Error("Calculator has no bounds");
  expect(initial.y + initial.height).toBeLessThanOrEqual(901);
  await move.hover();
  const handle = await move.boundingBox();
  if (!handle) throw new Error("Move handle has no bounds");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 180, handle.y + handle.height / 2 + 45, { steps: 8 });
  await page.mouse.up();
  const moved = await panel(page).boundingBox();
  expect(moved?.x).toBeLessThan(initial.x - 100);
  await move.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await panel(page).boundingBox())?.x).toBeLessThan(moved!.x);

  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(async () => {
    const box = await panel(page).boundingBox();
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 321 && box.y + box.height <= 569);
  }).toBe(true);
  await calc(page).locator('[data-k="7"]').click();
  await calc(page).locator('[data-k="add"]').click();
  await calc(page).locator('[data-k="8"]').click();
  await calc(page).locator('[data-k="enter"]').click();
  await expect(screen(page)).toContainText("15");
  await panel(page).getByRole("button", { name: "Hide calculator", exact: true }).click();
  await expect(panel(page)).toBeHidden();
});

test("calculator keeps scientific functions and recorder while respecting live feature settings", async ({ page }) => {
  await showCalculator(page);
  await calc(page).focus();
  await page.keyboard.type("1f2");
  await page.keyboard.press("Enter");
  await calc(page).locator('[data-k="toggle"]').click();
  await expect(screen(page)).toContainText("0.5");
  await calc(page).locator('[data-k="clear"]').click();
  await calc(page).getByRole("button", { name: "Show button presses", exact: true }).click();
  await calc(page).focus();
  await page.keyboard.type("s30");
  await page.keyboard.press("Enter");
  await calc(page).locator('[data-k="toggle"]').click();
  await expect(screen(page)).toContainText("0.5");
  await expect(panel(page).locator("#keypress-recorder")).toBeVisible();
  await expect(panel(page).locator("#keypress-recorder")).toContainText("Copy image");
  const copyText = panel(page).locator('[data-recorder="text"]');
  await copyText.focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).locator(".recorder-status")).not.toBeEmpty();
  // Clipboard permission is browser-dependent; successful copies preserve focus.
  if ((await panel(page).locator(".recorder-status").textContent())?.includes("Button presses copied")) {
    await expect(copyText).toBeFocused();
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("switch", { name: "Math tools", exact: true }).uncheck();
  await expect(panel(page)).toBeHidden();
  await settings.getByRole("switch", { name: "Math tools", exact: true }).check();
  await page.keyboard.press("Escape");
  if (!await panel(page).isVisible()) await showCalculator(page);
  await expect(screen(page)).toContainText("0.5");

  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 90_000 });
  await showCalculator(page);
  // Like the standalone calculator, a new page has an empty entry but keeps Ans.
  for (const key of ["second", "neg", "enter", "toggle"]) await calc(page).locator(`[data-k="${key}"]`).click();
  await expect(screen(page)).toContainText("0.5");
  await expect.poll(() => savedElements(page)).toEqual([]);
});

test("calculator opens inside a narrow viewport and remains usable after OBS mode", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await showCalculator(page);
  await expect.poll(async () => {
    const box = await panel(page).boundingBox();
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 321 && box.y + box.height <= 569);
  }).toBe(true);
  await panel(page).getByRole("button", { name: "Hide calculator", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await showCalculator(page);
  await calc(page).focus();
  await page.keyboard.type("9+1");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("switch", { name: "OBS capture area", exact: true }).check();
  await expect(panel(page)).toBeHidden();
  await settings.getByRole("switch", { name: "OBS capture area", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await expect(screen(page)).toContainText("10");
});


async function calculatorScene(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const project = await new Promise<{ activeSceneId: string; scenes: Record<string, {
        appState: { scrollX?: number; scrollY?: number; zoom?: { value: number }; offsetLeft?: number; offsetTop?: number };
        files: Record<string, { dataURL: string; mimeType: string }>;
      }> }>((resolve, reject) => {
        const request = db.transaction("keyval", "readonly").objectStore("keyval").get("patterdraw:autosave:project:v1");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return project.scenes[project.activeSceneId];
    } finally { db.close(); }
  });
}

async function dragScreen(page: Page, point: { x: number; y: number }) {
  const lcd = await panel(page).locator(".lcd").boundingBox();
  if (!lcd) throw new Error("Calculator display has no bounds");
  await page.mouse.move(lcd.x + lcd.width / 2, lcd.y + lcd.height / 2);
  await page.mouse.down();
  await page.mouse.move(lcd.x - 30, lcd.y + lcd.height / 2, { steps: 4 });
  await expect(page.getByTestId("calculator-screen-drag-preview")).toBeVisible();
  await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
}

test("calculator resizes its real keys and screen without losing entry or hide/show size", async ({ page }) => {
  await showCalculator(page);
  await calc(page).focus(); await page.keyboard.type("12+30");
  const handle = panel(page).getByRole("button", { name: "Resize calculator", exact: true });
  const before = await calc(page).locator(".calc").boundingBox();
  const handleBox = await handle.boundingBox();
  if (!before || !handleBox) throw new Error("Calculator resize bounds unavailable");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 45, handleBox.y - 100, { steps: 8 }); await page.mouse.up();
  const smaller = await calc(page).locator(".calc").boundingBox();
  expect(smaller!.width).toBeLessThan(before.width - 30);
  expect(smaller!.width / smaller!.height).toBeCloseTo(before.width / before.height, 2);
  await handle.focus(); await page.keyboard.press("Shift+ArrowRight");
  expect((await calc(page).locator(".calc").boundingBox())!.width).toBeGreaterThan(smaller!.width + 20);
  const width = (await panel(page).boundingBox())!.width;
  await panel(page).getByRole("button", { name: "Hide calculator", exact: true }).click();
  await showCalculator(page);
  expect((await panel(page).boundingBox())!.width).toBeCloseTo(width, 1);
  await calc(page).focus(); await page.keyboard.press("Enter"); await expect(screen(page)).toContainText("42");
  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(async () => {
    const box = await panel(page).boundingBox();
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 321 && box.y + box.height <= 569);
  }).toBe(true);
  await calc(page).locator('[data-k="add"]').click(); await calc(page).locator('[data-k="8"]').click();
  await calc(page).locator('[data-k="enter"]').click(); await expect(screen(page)).toContainText("50");
});

test("screen drag inserts one PNG at zoomed/panned canvas coordinates with undo and project persistence", async ({ page }) => {
  await showCalculator(page);
  await calc(page).focus(); await page.keyboard.type("1f2+3"); await page.keyboard.press("Enter");
  const resize = panel(page).getByRole("button", { name: "Resize calculator", exact: true });
  await resize.focus(); await page.keyboard.press("Shift+ArrowLeft");
  const lcd = await panel(page).locator(".lcd").boundingBox();
  if (!lcd) throw new Error("Calculator display has no bounds");
  const zoomOut = page.locator(".footer-zoom-controls").getByRole("button", { name: "Zoom out", exact: true });
  await zoomOut.click(); await zoomOut.click();
  await page.locator(".editor-host .excalidraw").focus();
  await page.mouse.move(370, 360); await page.keyboard.down("Space");
  await page.mouse.down(); await page.mouse.move(440, 410, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Space");
  const point = { x: 510, y: 430 };
  await dragScreen(page, point);
  await expect.poll(async () => (await savedElements(page)).map((element) => element.type)).toEqual(["image"]);
  const image = (await savedElements(page))[0];
  const saved = await calculatorScene(page);
  const zoomLabel = await page.locator(".footer-zoom-controls").getByRole("button", { name: "Reset zoom", exact: true }).textContent();
  const zoom = Number(zoomLabel?.replace("%", "")) / 100;
  expect(zoom).not.toBe(1);
  // View-only pan/zoom are intentionally omitted from project files. Read the
  // actual drawn LCD pixels instead, so this check also works in production
  // without Excalidraw's development-only window.h diagnostic hook.
  const renderedCenter = async () => page.locator("canvas.excalidraw__canvas.static").evaluate((canvas: HTMLCanvasElement) => {
    const rgba = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = Infinity, right = -1, top = Infinity, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (rgba[i] > 130 && rgba[i] < 230 && rgba[i + 1] > rgba[i] + 10 && rgba[i + 1] > rgba[i + 2] + 10) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    const box = canvas.getBoundingClientRect();
    return { x: box.x + (left + right) / 2 * box.width / canvas.width,
      y: box.y + (top + bottom) / 2 * box.height / canvas.height };
  });
  await expect.poll(async () => {
    const center = await renderedCenter();
    return Math.max(Math.abs(center.x - point.x), Math.abs(center.y - point.y));
  }).toBeLessThan(2);
  expect(image.width * zoom).toBeCloseTo(lcd.width, 0);
  expect(image.height * zoom).toBeCloseTo(lcd.height, 0);
  expect(saved.files[image.fileId!].mimeType).toBe("image/png");
  expect(saved.files[image.fileId!].dataURL).toMatch(/^data:image\/png;base64,/);
  const pixels = await page.evaluate(async (dataURL) => {
    const img = new Image(); img.src = dataURL; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
    let dark = 0; for (let i = 0; i < rgba.length; i += 4) if (rgba[i] < 80 && rgba[i + 1] < 80 && rgba[i + 2] < 80) dark++;
    return { width: img.width, height: img.height, dark };
  }, saved.files[image.fileId!].dataURL);
  expect(pixels.width / pixels.height).toBeCloseTo(lcd.width / lcd.height, 1);
  expect(pixels.dark).toBeGreaterThan(50); // rendered expression, not a blank LCD
  await page.locator(".editor-host .excalidraw").focus(); await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => savedElements(page)).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await savedElements(page)).length).toBe(1);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadEvent; const path = await download.path();
  if (!path) throw new Error("Project archive missing");
  const archived = JSON.parse(strFromU8(unzipSync(await readFile(path))["project.json"]));
  const scene = archived.scenes[archived.activeSceneId];
  expect(scene.elements.filter((element: { type: string; isDeleted?: boolean }) => element.type === "image" && !element.isDeleted)).toHaveLength(1);
  expect(scene.files[image.fileId!].mimeType).toBe("image/png");
  await page.reload(); await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
  await expect.poll(async () => (await savedElements(page)).map((element) => element.id)).toEqual([image.id]);
});

test("screen click still copies and invalid or Escape-cancelled drags insert nothing", async ({ page }) => {
  await showCalculator(page);
  await panel(page).locator(".lcd").click();
  await expect(panel(page).locator("#display-copy-status")).not.toBeEmpty();
  const lcd = await panel(page).locator(".lcd").boundingBox();
  if (!lcd) throw new Error("Calculator display has no bounds");
  const close = await panel(page).getByRole("button", { name: "Hide calculator", exact: true }).boundingBox();
  if (!close) throw new Error("Calculator header missing");
  await dragScreen(page, { x: close.x + 2, y: close.y + 2 });
  await expect(page.getByTestId("calculator-screen-drag-preview")).toHaveCount(0);
  await expect.poll(() => savedElements(page)).toEqual([]);
  await page.mouse.move(lcd.x + 20, lcd.y + 20); await page.mouse.down();
  await page.mouse.move(510, 430, { steps: 8 });
  await expect(page.getByTestId("calculator-screen-drag-preview")).toBeVisible();
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.getByTestId("calculator-screen-drag-preview")).toHaveCount(0);
  await expect.poll(() => savedElements(page)).toEqual([]);
  await expect(panel(page)).toBeVisible();
});

test("touch resizes and drags a captured screen without clipboard access", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Native touch injection uses Chromium's input protocol; mouse/keyboard run in both engines.");
  await showCalculator(page);
  const session = await page.context().newCDPSession(page);
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => session.send("Input.dispatchTouchEvent", {
    type, touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  const resize = await panel(page).getByRole("button", { name: "Resize calculator", exact: true }).boundingBox();
  const before = (await panel(page).boundingBox())!.width;
  if (!resize) throw new Error("Resize handle missing");
  await touch("touchStart", resize.x + 10, resize.y + 10);
  await touch("touchMove", resize.x - 40, resize.y - 100); await touch("touchEnd");
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeLessThan(before - 30);
  const lcd = (await panel(page).locator(".lcd").boundingBox())!;
  await touch("touchStart", lcd.x + 30, lcd.y + 20);
  await touch("touchMove", lcd.x - 30, lcd.y + 20);
  await expect(page.getByTestId("calculator-screen-drag-preview")).toBeVisible();
  await touch("touchMove", 510, 430); await touch("touchEnd");
  await expect.poll(async () => (await savedElements(page)).map((element) => element.type)).toEqual(["image"]);
  await session.detach();
});
