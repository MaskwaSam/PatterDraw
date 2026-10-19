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
        scenes: Record<string, { elements: Array<{ id: string; type: string; isDeleted?: boolean }> }>;
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
