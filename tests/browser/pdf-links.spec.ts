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

async function fixturePoint(page: Page, x: number, y: number, width: number, height: number) {
  // Find the paper in the rendered bitmap, independently of the link overlay
  // and viewport metadata (which Excalidraw omits from portable archives).
  return page.evaluate(({ x, y, width, height }) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.excalidraw__canvas.static")!;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let widest = 0, left = 0, top = 0, bottom = 0;
    for (let row = 0; row < canvas.height; row += 1) {
      let start = -1;
      for (let col = 0; col <= canvas.width; col += 1) {
        const i = (row * canvas.width + col) * 4;
        const white = col < canvas.width && pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255 && pixels[i + 3] === 255;
        if (white && start < 0) start = col;
        if (!white && start >= 0) {
          const span = col - start;
          if (span > widest) { widest = span; left = start; top = row; bottom = row; }
          else if (span === widest && start === left) bottom = row;
          start = -1;
        }
      }
    }
    if (widest < 200 || bottom - top < 200) throw new Error("Rendered fixture paper is not ready");
    const box = canvas.getBoundingClientRect();
    return { x: box.x + (left + x / width * widest) * box.width / canvas.width,
      y: box.y + (top + y / height * (bottom - top + 1)) * box.height / canvas.height };
  }, { x, y, width, height });
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
  let fixtureCenter = { x: 215, y: 384.5, width: 612, height: 792 };
  const openLink = async () => {
    const target = await linkCenter(page);
    await expect.poll(async () => {
      const expected = await fixturePoint(page, fixtureCenter.x, fixtureCenter.y, fixtureCenter.width, fixtureCenter.height);
      return Math.hypot(expected.x - target.x, expected.y - target.y);
    }).toBeLessThan(2);
    const expected = await fixturePoint(page, fixtureCenter.x, fixtureCenter.y, fixtureCenter.width, fixtureCenter.height);
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
  // Keep the full paper visible so its bitmap bounds remain an independent oracle.
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 20);
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
  fixtureCenter = { x: 407.5, y: 215, width: 792, height: 612 };
  await openLink(); // source /Rotate = 90
  await page.getByRole("button", { name: "More actions for output page 2", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rotate clockwise 90 degrees", exact: true }).click();
  fixtureCenter = { x: 397, y: 407.5, width: 612, height: 792 };
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
