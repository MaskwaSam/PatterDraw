import { expect, test, type Locator } from "@playwright/test";

async function expectLoadedSlidePreview(preview: Locator): Promise<void> {
  await expect(preview).toBeVisible();
  await expect.poll(
    () => preview.evaluate((image: HTMLImageElement) => image.complete ? image.naturalWidth : 0),
    { timeout: 10_000, message: "Expected the slide preview image to finish rendering." },
  ).toBeGreaterThan(0);
}

test("themes Slides chrome without recoloring slide previews", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();

  const selectedSlide = page.locator(".slide-thumbnail.is-selected");
  const previewFrame = selectedSlide.locator(".slide-preview");
  const previewImage = previewFrame.locator("img");
  await expectLoadedSlidePreview(previewImage);
  const lightPreviewSource = await previewImage.getAttribute("src");
  expect(lightPreviewSource).toBeTruthy();
  await expect(page.locator("#slide-rail")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(previewImage).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(previewImage).toHaveCSS("filter", "none");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsDialog.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");

  await expect(page.locator("#slide-rail")).toHaveCSS("background-color", "rgb(24, 33, 49)");
  await expect(selectedSlide).toHaveCSS("background-color", "rgb(28, 49, 88)");
  await expect(previewFrame).toHaveCSS("border-color", "rgb(127, 167, 255)");
  expect(await previewFrame.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain("rgba(127, 167, 255, 0.3)");
  await expect(previewImage).toHaveAttribute("src", lightPreviewSource || "");
  await expect(previewImage).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(previewImage).toHaveCSS("filter", "none");

  const slideSettingsButton = page.getByRole("button", { name: "Slide settings", exact: true });
  await slideSettingsButton.click();
  const slideSettingsDialog = page.getByRole("dialog", { name: "Slide settings", exact: true });
  await expect(slideSettingsDialog).toHaveCSS("background-color", "rgb(24, 33, 49)");
  await expect(slideSettingsButton).toHaveCSS("background-color", "rgb(41, 68, 111)");
  await expect(slideSettingsButton).toHaveCSS("color", "rgb(199, 214, 255)");
  await expect(slideSettingsDialog.getByRole("button", { name: "Draw slide", exact: true }))
    .toHaveCSS("background-color", "rgb(32, 43, 62)");
  await page.keyboard.press("Tab");
  const focusedSettingsControl = slideSettingsDialog.locator(":focus-visible");
  await expect(focusedSettingsControl).toHaveCount(1);
  await expect(focusedSettingsControl).toHaveCSS("outline-style", "solid");
  await expect(focusedSettingsControl).toHaveCSS("outline-color", "rgb(127, 167, 255)");
  await page.keyboard.press("Escape");

  const slideActionsButton = page.locator(".slide-thumbnail-menu-button").first();
  await slideActionsButton.click();
  const slideActionsMenu = page.locator(".slide-thumbnail-menu");
  await expect(slideActionsMenu).toHaveCSS("background-color", "rgb(32, 43, 62)");
  await expect(slideActionsMenu.getByRole("menuitem", { name: "Delete slide", exact: true }))
    .toHaveCSS("color", "rgb(255, 180, 191)");
  await page.keyboard.press("Tab");
  const focusedMenuItem = slideActionsMenu.locator(":focus-visible");
  await expect(focusedMenuItem).toHaveCount(1);
  await expect(focusedMenuItem).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Hide slide navigator", exact: true }).click();
  const footerShow = page.locator(".page-status .slide-rail-show");
  await expect(footerShow).toHaveCSS("background-color", "rgba(24, 33, 49, 0.96)");
  await footerShow.hover();
  await expect(footerShow).toHaveCSS("background-color", "rgb(42, 56, 80)");

  await page.setViewportSize({ width: 390, height: 844 });
  await footerShow.click();
  await expect(page.locator("#slide-rail")).toBeVisible();
  await expect(page.locator("#slide-rail")).toHaveCSS(
    "box-shadow",
    "rgba(0, 0, 0, 0.48) 8px 0px 28px 0px",
  );
  await expect(page.locator(".slide-rail-backdrop"))
    .toHaveCSS("background-color", "rgba(4, 9, 18, 0.56)");
  await expect(page.locator("#slide-rail .slide-preview img").first())
    .toHaveCSS("background-color", "rgb(255, 255, 255)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);

  await page.locator(".slide-rail-backdrop").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsDialog.getByRole("combobox", { name: "Theme", exact: true }).selectOption("light");
  await page.keyboard.press("Escape");
  await footerShow.click();
  await expect(page.locator("#slide-rail")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#slide-rail .slide-preview img").first()).toHaveCSS("filter", "none");
  expect(runtimeErrors).toEqual([]);
});
