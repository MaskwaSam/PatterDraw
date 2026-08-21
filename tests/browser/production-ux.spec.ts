import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const PRODUCTION_EDITOR_MOUNT_TIMEOUT = 90_000;

type StoredElement = {
  id?: string;
  type?: string;
  text?: string;
  isDeleted?: boolean;
};

type StoredProject = {
  activeSceneId: string;
  pdfDocuments?: Record<string, unknown>;
  pdfPageOrder?: string[];
  scenes: Record<string, {
    elements: StoredElement[];
    pdfPage?: { documentId: string; pageIndex: number; viewRotation?: number };
  }>;
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

test("keeps iPhone chrome compact without covering board controls", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 320, height: 700 },
    { width: 360, height: 800 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 393, height: 852 },
    { width: 430, height: 932 },
    { width: 667, height: 375 },
    { width: 736, height: 414 },
    { width: 812, height: 375 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.reload({ waitUntil: "domcontentloaded" });
    const editor = page.locator(".editor-host .excalidraw");
    await expect(editor).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
    await expect(
      editor,
      `Excalidraw should use its mobile controls at ${viewport.width}x${viewport.height}`,
    ).toHaveClass(/excalidraw--mobile/);
    await expect(page.locator(".editor-host .App-bottom-bar .Island")).toBeVisible();
    const geometry = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".topbar");
      const actions = document.querySelector<HTMLElement>(".file-actions");
      const tabs = document.querySelector<HTMLElement>(".workspace-tabs");
      const editor = document.querySelector<HTMLElement>(".editor-host");
      const statusbar = document.querySelector<HTMLElement>(".statusbar");
      const mobileBottomBar = document.querySelector<HTMLElement>(".editor-host .excalidraw--mobile .App-bottom-bar");
      const nativeTopToolbar = document.querySelector<HTMLElement>(".editor-host .App-top-bar .App-toolbar-container");
      const nativeBottomIsland = document.querySelector<HTMLElement>(".editor-host .App-bottom-bar .Island");
      if (!topbar || !actions || !tabs || !editor || !statusbar || !mobileBottomBar || !nativeTopToolbar || !nativeBottomIsland) {
        throw new Error("Responsive editor chrome is unavailable.");
      }
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
        document: rect(topbar.querySelector<HTMLElement>(".topbar-document")!),
        documentChildren: [...topbar.querySelectorAll<HTMLElement>(".topbar-document > *")]
          .filter((element) => getComputedStyle(element).display !== "none")
          .map(rect),
        editor: rect(editor),
        statusbar: rect(statusbar),
        nativeTopToolbar: rect(nativeTopToolbar),
        nativeBottomIsland: rect(nativeBottomIsland),
        mobileBottomBarDisplay: getComputedStyle(mobileBottomBar).display,
        statusbarDisplay: getComputedStyle(statusbar).display,
        wrapperDuplicateDisplays: [
          ".footer-zoom-controls",
          ".footer-history-button",
          ".fullscreen-button",
        ].flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
          .map((element) => getComputedStyle(element).display),
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
    for (const bounds of geometry.documentChildren) {
      expect(bounds.left).toBeGreaterThanOrEqual(geometry.document.left - 1);
      expect(bounds.right).toBeLessThanOrEqual(geometry.document.right + 1);
    }
    expect(geometry.buttons).toHaveLength(9);
    expect(geometry.buttons.every((button) => button.visible)).toBe(true);
    expect(geometry.buttons.every((button) => button.left >= -1 && button.right <= viewport.width + 1)).toBe(true);
    expect(geometry.topbar.height).toBe(viewport.width <= 640 ? 96 : 58);
    expect(geometry.topbar.bottom).toBeLessThanOrEqual(geometry.editor.top + 1);
    expect(geometry.editor.bottom).toBeCloseTo(viewport.height, 0);
    expect(geometry.nativeTopToolbar.top).toBeGreaterThanOrEqual(geometry.editor.top);
    expect(geometry.nativeBottomIsland.bottom).toBeLessThanOrEqual(geometry.editor.bottom);
    expect(geometry.nativeBottomIsland.top - geometry.nativeTopToolbar.bottom).toBeGreaterThan(120);
    expect(geometry.mobileBottomBarDisplay).not.toBe("none");
    expect(geometry.statusbarDisplay).toBe("none");
    expect(geometry.wrapperDuplicateDisplays.every((display) => display === "none")).toBe(true);
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

test("keeps duplicate, rotate, delete, and Undo usable across production viewports", async ({ page }) => {
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([400, 240]);
  await page.getByLabel("Open project file").setInputFiles({
    name: "production-page-tools.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await sourceDocument.save()),
  });

  const pages = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pages).toHaveCount(1, { timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await page.getByRole("button", { name: "Hide PDF pages", exact: true }).click();
  await expect(page.locator("#pdf-page-rail")).toHaveCount(0);
  await addText(page, "PRODUCTION_DUPLICATE_NOTE");
  await page.getByRole("button", { name: "Show PDF pages", exact: true }).click();
  await expect(pages.first().locator(".pdf-annotation-count")).toHaveText("1");

  const openActions = async (outputPage: number) => {
    const trigger = page.getByRole("button", {
      name: `More actions for output page ${outputPage}`,
      exact: true,
    });
    await expect(trigger).toBeVisible();
    // Let the active-scene effect finish before opening a menu. WebKit can
    // otherwise deliver this synthetic click in the same render turn that
    // intentionally closes the previous page's action menu.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const menu = page.getByRole("menu", {
      name: `Actions for output page ${outputPage}`,
      exact: true,
    });
    // A just-activated PDF scene also closes any menu associated with the
    // previous scene. If that passive effect lands in the same WebKit turn as
    // an unrealistically immediate automation click, retry once the close has
    // settled—the second click matches a normal human interaction boundary.
    for (let attempt = 0; attempt < 3 && !await menu.isVisible(); attempt += 1) {
      await trigger.click();
      await page.waitForTimeout(150);
    }
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x || 0).toBeGreaterThanOrEqual(-1);
    expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth + 1),
    );
    return menu;
  };

  let actions = await openActions(1);
  await actions.getByRole("menuitem", { name: "Duplicate page", exact: true }).click();
  await expect(pages).toHaveCount(2);
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect(pages.nth(0).locator(".pdf-annotation-count")).toHaveText("1");
  await expect(pages.nth(1).locator(".pdf-annotation-count")).toHaveText("1");
  await expect.poll(async () => {
    const project = await autosavedProject(page);
    return project?.activeSceneId === project?.pdfPageOrder?.[1];
  }).toBe(true);

  actions = await openActions(2);
  await actions.getByRole("menuitem", {
    name: "Rotate clockwise 90 degrees",
    exact: true,
  }).click();
  await expect.poll(async () => {
    const project = await autosavedProject(page);
    const sceneId = project?.pdfPageOrder?.[1] || "";
    return project?.scenes[sceneId]?.pdfPage?.viewRotation;
  }).toBe(90);
  const rotatedSheet = await pages.nth(1).locator(".page-sheet").boundingBox();
  expect(rotatedSheet).not.toBeNull();
  expect((rotatedSheet?.height || 0) / (rotatedSheet?.width || 1)).toBeGreaterThan(1.5);

  page.once("dialog", (dialog) => void dialog.accept());
  actions = await openActions(2);
  await actions.getByRole("menuitem", { name: "Delete page", exact: true }).click();
  await expect(pages).toHaveCount(1);
  const toast = page.locator(".pdf-annotation-clear-toast");
  await expect(toast).toContainText("Deleted output page 2");
  const toastBounds = await toast.boundingBox();
  expect(toastBounds).not.toBeNull();
  expect(toastBounds?.x || 0).toBeGreaterThanOrEqual(-1);
  expect((toastBounds?.x || 0) + (toastBounds?.width || 0)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth + 1),
  );
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await expect(pages).toHaveCount(2);
  await expect(pages.nth(1)).toHaveClass(/is-selected/);
  await expect.poll(async () => {
    const project = await autosavedProject(page);
    return {
      documentCount: Object.keys(project?.pdfDocuments || {}).length,
      pageIndices: (project?.pdfPageOrder || []).map(
        (sceneId) => project?.scenes[sceneId]?.pdfPage?.pageIndex,
      ),
      viewRotations: (project?.pdfPageOrder || []).map(
        (sceneId) => project?.scenes[sceneId]?.pdfPage?.viewRotation || 0,
      ),
    };
  }).toEqual({
    documentCount: 1,
    pageIndices: [0, 0],
    viewRotations: [0, 90],
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
