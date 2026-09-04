import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, degrees } from "pdf-lib";

async function linkedPdf() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 2; i += 1) {
    const page = pdf.addPage([612, 792]);
    if (i === 1) page.setRotation(degrees(90));
    page.drawText(`Page ${i + 1}: open model`, { x: 100, y: 400, size: 16 });
    const links = ["https://example.test/model#state=retained", "javascript:alert(1)", "file:///etc/passwd"];
    page.node.set(PDFName.of("Annots"), pdf.context.obj(links.map((url, j) => pdf.context.register(pdf.context.obj({
      Type: "Annot", Subtype: "Link", Rect: [100, 395 - j * 40, 330, 420 - j * 40],
      A: { S: "URI", URI: PDFString.of(url) },
    })))));
  }
  return Buffer.from(await pdf.save());
}

async function linkCenter(page: Page) {
  const link = page.locator(".pdf-page-link");
  await expect(link).toHaveCount(1);
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0);
  await expect(page.getByTestId("pdf-link-overlay")).toBeVisible();
  const rect = await link.boundingBox();
  if (!rect) throw new Error("No link bounds");
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function fixturePoint(page: Page, x: number, y: number) {
  return page.evaluate(async ({ x, y }) => {
    const live = (window as unknown as { h?: { app?: { state?: Record<string, any> } } }).h?.app?.state;
    const state = live ?? await new Promise<Record<string, any>>((resolve, reject) => {
      const open = indexedDB.open("keyval-store");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction("keyval").objectStore("keyval").get("patterdraw:autosave:project:v1");
        read.onsuccess = () => { const p = read.result; db.close(); resolve(p.scenes[p.activeSceneId].appState); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
    const host = document.querySelector(".editor-host")!.getBoundingClientRect();
    const zoom = state.zoom?.value ?? 1;
    return { x: (x + (state.scrollX ?? 0)) * zoom + (state.offsetLeft ?? host.x), y: (y + (state.scrollY ?? 0)) * zoom + (state.offsetTop ?? host.y) };
  }, { x, y });
}

test("PDF web links require selection clicks and survive zoom, rotation, reorder and project round trips", async ({ page, context }) => {
  const unexpected: string[] = [];
  page.on("request", (request) => { if (request.url().startsWith("https://example.test")) unexpected.push(request.url()); });
  await context.route("https://example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>PDF model</title>Model" }));
  await page.goto("./");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
  await page.getByLabel("Open project file").setInputFiles({ name: "linked.pdf", mimeType: "application/pdf", buffer: await linkedPdf() });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(2);
  await page.getByTestId("toolbar-selection").check({ force: true });
  const point = await linkCenter(page);
  let fixtureCenter = { x: 215, y: 384.5 };
  const openLink = async () => {
    const target = await linkCenter(page);
    await expect.poll(async () => {
      const expected = await fixturePoint(page, fixtureCenter.x, fixtureCenter.y);
      return Math.hypot(expected.x - target.x, expected.y - target.y);
    }).toBeLessThan(2);
    const expected = await fixturePoint(page, fixtureCenter.x, fixtureCenter.y);
    const popupPromise = context.waitForEvent("page", { timeout: 15_000 });
    await page.mouse.click(expected.x, expected.y);
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://example.test/model#state=retained");
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => ({ opener: window.opener, referrer: document.referrer }))).toEqual({ opener: null, referrer: "" });
    await popup.close();
  };
  await openLink();

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 80, point.y + 20, { steps: 6 });
  await page.mouse.up();
  expect(context.pages()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-freedraw").check({ force: true });
  await expect(page.getByTestId("pdf-link-overlay")).toBeHidden();
  await page.mouse.move(point.x - 20, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y, { steps: 5 });
  await page.mouse.up();
  expect(context.pages()).toHaveLength(1);
  await expect(page.locator("#pdf-page-rail .pdf-page-item").first().locator(".pdf-annotation-count")).toHaveText("1");
  await page.getByTestId("toolbar-selection").check({ force: true });
  await page.mouse.click(point.x, point.y);
  expect(context.pages()).toHaveLength(1); // the ink takes selection priority
  await page.keyboard.press("Delete");
  await expect(page.locator("#pdf-page-rail .pdf-page-item").first().locator(".pdf-annotation-count")).toHaveCount(0);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 50);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await openLink();

  // Existing network restrictions still apply to arbitrary popups and fetches.
  expect(await page.evaluate(async () => ({
    popup: window.open("https://example.test/unrequested") === null,
    fetchBlocked: await fetch("https://example.test/unrequested").then(() => false, () => true),
  }))).toEqual({ popup: true, fetchBlocked: true });
  await page.locator(".pdf-page-link").evaluate((button: HTMLButtonElement) => button.click());
  expect(context.pages()).toHaveLength(1);
  expect(unexpected).toEqual([]);

  await page.locator("#pdf-page-rail .pdf-page-item").nth(1).locator(".pdf-page-open").click();
  fixtureCenter = { x: 407.5, y: 215 };
  await openLink(); // source /Rotate = 90
  await page.getByRole("button", { name: "More actions for output page 2", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rotate clockwise 90 degrees", exact: true }).click();
  fixtureCenter = { x: 397, y: 407.5 };
  await openLink(); // additional wrapper rotation
  await page.getByRole("button", { name: "Move output page 2 earlier", exact: true }).click();
  await openLink();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  await page.reload();
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await openLink(); // autosaved PDF source
  await page.getByLabel("Open project file").setInputFiles({ name: "linked.patterdraw", mimeType: "application/vnd.patterdraw+zip", buffer: archive });
  const switchDialog = page.getByRole("dialog", { name: "Open another project?", exact: true });
  await expect(switchDialog).toBeVisible();
  await switchDialog.getByRole("button", { name: "Open without downloading", exact: true }).click();
  await expect(switchDialog).toHaveCount(0);
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await openLink();
  expect(unexpected).toEqual([]);
});
