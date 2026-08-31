import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const PRODUCTION_EDITOR_MOUNT_TIMEOUT = 90_000;
const productionRoute = "/classroom/math/unit-01/patterdraw/";

async function pdfBytes(pageSizes: Array<[number, number]>): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (const size of pageSizes) document.addPage(size);
  return Buffer.from(await document.save());
}

async function downloadBytes(download: import("@playwright/test").Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright download stream was unavailable.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function selectPdfPage(
  page: import("@playwright/test").Page,
  outputPage: number,
): Promise<void> {
  const item = page.locator("#pdf-page-rail .pdf-page-item").nth(outputPage - 1);
  await item.locator(".pdf-page-open").click();
  await expect(item).toHaveClass(/is-selected/);
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0, {
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
}

async function drawPdfRectangle(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0, {
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
  await page.getByTestId("toolbar-rectangle").check({ force: true });
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("Editor host has no visible bounds.");
  const startX = editor.x + editor.width * 0.57;
  const startY = editor.y + editor.height * 0.42;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 64, startY + 46, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId("toolbar-selection").check({ force: true });
}

async function openClearDialog(
  page: import("@playwright/test").Page,
  outputPage: number,
): Promise<import("@playwright/test").Locator> {
  const trigger = page.getByRole("button", {
    name: `More actions for output page ${outputPage}`,
    exact: true,
  });
  const menu = page.getByRole("menu", {
    name: `Actions for output page ${outputPage}`,
    exact: true,
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  for (let attempt = 0; attempt < 3 && !await menu.isVisible(); attempt += 1) {
    await trigger.click();
    await page.waitForTimeout(150);
  }
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Clear annotations…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clear annotations", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("inserts multiple PDF sources, clears and restores one source, then saves and exports", async ({ page }) => {
  test.setTimeout(150_000);
  const runtimeProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeProblems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => runtimeProblems.push(`page: ${error.stack || error.message}`));
  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });

  await page.getByLabel("Open project file").setInputFiles({
    name: "cross-engine-main.pdf",
    mimeType: "application/pdf",
    buffer: await pdfBytes([[612, 792]]),
  });
  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(1, { timeout: 30_000 });
  await drawPdfRectangle(page);
  await expect(pages.nth(0).locator(".pdf-annotation-count")).toHaveText("1");

  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("menuitem", { name: /Insert PDF pages/ }).click();
  await page.getByLabel("Select PDFs to insert").setInputFiles([
    {
      name: "cross-engine-supplement.pdf",
      mimeType: "application/pdf",
      buffer: await pdfBytes([[400, 500], [410, 510]]),
    },
    {
      name: "cross-engine-appendix.pdf",
      mimeType: "application/pdf",
      buffer: await pdfBytes([[300, 360]]),
    },
  ]);
  const insert = page.getByRole("dialog", { name: "Insert PDF pages", exact: true });
  await expect(insert).toBeVisible({ timeout: 30_000 });
  await expect(insert.getByText("3 pages selected from 2 PDFs.", { exact: true })).toBeVisible();
  await insert.getByRole("button", { name: "Insert 3 pages", exact: true }).click();
  await expect(insert).toHaveCount(0, { timeout: 45_000 });
  await expect(pages).toHaveCount(4, { timeout: 45_000 });
  await expect(pages.nth(1)).toContainText("cross-engine-supplement.pdf");
  await expect(pages.nth(2)).toContainText("cross-engine-supplement.pdf");
  await expect(pages.nth(3)).toContainText("cross-engine-appendix.pdf");

  await selectPdfPage(page, 2);
  await drawPdfRectangle(page);
  await expect(pages.nth(1).locator(".pdf-annotation-count")).toHaveText("1");
  await selectPdfPage(page, 3);
  await drawPdfRectangle(page);
  await expect(pages.nth(2).locator(".pdf-annotation-count")).toHaveText("1");

  const clear = await openClearDialog(page, 3);
  await clear.getByRole("radio", { name: /Pages from this source PDF/ }).check();
  await expect(clear.getByRole("button", { name: "Clear 2 annotations", exact: true })).toBeEnabled();
  await clear.getByRole("button", { name: "Clear 2 annotations", exact: true }).click();
  const toast = page.locator(".pdf-annotation-clear-toast");
  await expect(toast).toContainText("Cleared 2 annotations from 2 pages");
  await expect(pages.nth(0).locator(".pdf-annotation-count")).toHaveText("1");
  await expect(pages.nth(1).locator(".pdf-annotation-count")).toHaveCount(0);
  await expect(pages.nth(2).locator(".pdf-annotation-count")).toHaveCount(0);
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(pages.nth(1).locator(".pdf-annotation-count")).toHaveText("1");
  await expect(pages.nth(2).locator(".pdf-annotation-count")).toHaveText("1");

  const saveEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const archiveBytes = await downloadBytes(await saveEvent);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
  await page.getByLabel("Open project file").setInputFiles({
    name: "cross-engine-roundtrip.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: archiveBytes,
  });
  const switchDialog = page.getByRole("dialog", { name: "Open another project?", exact: true });
  await expect(switchDialog).toBeVisible();
  await switchDialog.getByRole("button", { name: "Open without downloading", exact: true }).click();
  await expect(switchDialog).toHaveCount(0, { timeout: 45_000 });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(pages).toHaveCount(4, { timeout: 45_000 });
  await expect(pages.nth(0).locator(".pdf-annotation-count")).toHaveText("1");
  await expect(pages.nth(1).locator(".pdf-annotation-count")).toHaveText("1");
  await expect(pages.nth(2).locator(".pdf-annotation-count")).toHaveText("1");

  const exportEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exported = await PDFDocument.load(await downloadBytes(await exportEvent));
  expect(exported.getPages().map((outputPage) => outputPage.getSize())).toEqual([
    { width: 612, height: 792 },
    { width: 400, height: 500 },
    { width: 410, height: 510 },
    { width: 300, height: 360 },
  ]);
  expect(runtimeProblems, runtimeProblems.join("\n")).toEqual([]);
});
