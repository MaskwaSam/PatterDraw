import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

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

async function openTestPdf(page: import("@playwright/test").Page) {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  const bytes = await document.save();
  await page.locator('input[type="file"]').setInputFiles({
    name: "toolbar-position.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: 15_000 });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1, { timeout: 15_000 });
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
