import { expect, test } from "@playwright/test";

const PRODUCTION_EDITOR_MOUNT_TIMEOUT = 90_000;

type StoredElement = {
  id?: string;
  type?: string;
  text?: string;
  isDeleted?: boolean;
};

type StoredProject = {
  activeSceneId: string;
  scenes: Record<string, { elements: StoredElement[] }>;
};

async function autosavedProject(page: import("@playwright/test").Page): Promise<StoredProject | undefined> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get("patterdraw:autosave:project:v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value as StoredProject | undefined;
  });
}

function liveElements(project: StoredProject | undefined): Array<Pick<StoredElement, "id" | "type" | "text">> {
  const scene = project?.scenes[project.activeSceneId];
  return (scene?.elements || [])
    .filter((element) => !element.isDeleted)
    .map(({ id, type, text }) => ({ id, type, text }));
}

async function addText(page: import("@playwright/test").Page, text: string): Promise<void> {
  await page.getByTestId("toolbar-text").check({ force: true });
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("Editor host has no visible bounds.");
  await page.mouse.click(editor.x + 220, editor.y + 180);
  const textEditor = page.locator("textarea.excalidraw-wysiwyg");
  await expect(textEditor).toBeVisible();
  await textEditor.fill(text);
  await textEditor.press("ControlOrMeta+Enter");
  await expect(textEditor).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(async () => Boolean(await autosavedProject(page))).toBe(true);
});

test("keeps every top-bar action inside 320px while preserving the 390px layout", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 320, height: 700 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".topbar");
      const actions = document.querySelector<HTMLElement>(".file-actions");
      const tabs = document.querySelector<HTMLElement>(".workspace-tabs");
      if (!topbar || !actions || !tabs) throw new Error("Top-bar chrome is unavailable.");
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      };
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        topbar: rect(topbar),
        actions: rect(actions),
        tabs: rect(tabs),
        actionChildren: [...actions.children].map(rect),
        buttons: [...actions.querySelectorAll("button")].map((button) => ({
          ...rect(button),
          visible: getComputedStyle(button).display !== "none"
            && getComputedStyle(button).visibility !== "hidden",
        })),
      };
    });

    expect(geometry.viewportWidth).toBe(viewport.width);
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(viewport.width);
    expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(viewport.width);
    for (const bounds of [geometry.topbar, geometry.actions, geometry.tabs, ...geometry.actionChildren]) {
      expect(bounds.left, `left edge escaped at ${viewport.width}px`).toBeGreaterThanOrEqual(-1);
      expect(bounds.right, `right edge clipped at ${viewport.width}px`).toBeLessThanOrEqual(viewport.width + 1);
    }
    expect(geometry.buttons).toHaveLength(9);
    expect(geometry.buttons.every((button) => button.visible)).toBe(true);
    expect(geometry.buttons.every((button) => button.left >= -1 && button.right <= viewport.width + 1)).toBe(true);
    expect(geometry.topbar.height).toBe(viewport.width === 320 ? 142 : 96);
  }
});

test("keeps Project Find typing and Escape out of canvas shortcuts while navigation still activates a result", async ({ page }) => {
  await addText(page, "needle");
  await page.getByTestId("toolbar-selection").check({ force: true });
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(async () => (
    liveElements(await autosavedProject(page))
      .some((element) => element.type === "text" && element.text === "needle")
  )).toBe(true);
  const before = await autosavedProject(page);

  await page.getByRole("button", { name: "Find in project", exact: true }).click();
  const query = page.getByRole("searchbox", { name: "Find text across project", exact: true });
  await expect(query).toBeVisible();
  await expect(query).toBeFocused();

  const canvasSearch = page.getByRole("button", { name: "Search current canvas", exact: true });
  const nativeSearch = page.locator(".layer-ui__search input");
  await canvasSearch.focus();
  await canvasSearch.press("Enter");
  await expect(nativeSearch).toBeVisible();
  await page.getByRole("button", { name: "Find in project", exact: true }).click();
  await expect(query).toBeVisible();
  await canvasSearch.focus();
  await canvasSearch.press("Space");
  await expect(nativeSearch).toBeVisible();
  await page.getByRole("button", { name: "Find in project", exact: true }).click();
  await expect(query).toBeVisible();

  await query.press("b");
  await query.press("ArrowDown");
  await query.press("ArrowUp");
  await query.press("Escape");
  await expect(query).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find in project", exact: true })).toBeFocused();
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(async () => liveElements(await autosavedProject(page)))
    .toEqual(liveElements(before));

  await page.getByRole("button", { name: "Find in project", exact: true }).click();
  await expect(query).toBeVisible();
  await query.fill("");
  await query.press("n");
  await expect(page.locator(".project-find-result")).toHaveCount(1);
  const result = page.locator(".project-find-result").first();
  await result.focus();
  await result.press("b");
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await query.focus();
  await query.press("ArrowDown");
  await query.press("Enter");
  await expect(page.locator(".project-find-result")).toHaveCount(1);
  await expect(page.getByTestId("toolbar-selection")).toBeChecked();
  await expect.poll(async () => liveElements(await autosavedProject(page)))
    .toEqual(liveElements(before));
});
