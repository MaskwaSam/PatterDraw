import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const PRODUCTION_EDITOR_MOUNT_TIMEOUT = 90_000;

type StoredElement = Record<string, unknown> & {
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
    pdfPage?: {
      documentId: string;
      pageIndex: number;
      viewRotation?: number;
      backgroundElementId?: string;
    };
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

async function setAutosavedProject(
  page: import("@playwright/test").Page,
  project: StoredProject,
): Promise<void> {
  await page.evaluate(async (storedProject) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").put(
        storedProject,
        "patterdraw:autosave:project:v1",
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, project);
}

function liveElements(project: StoredProject | undefined): Array<Pick<StoredElement, "id" | "type" | "text">> {
  const scene = project?.scenes[project.activeSceneId];
  return (scene?.elements || [])
    .filter((element) => !element.isDeleted)
    .map(({ id, type, text }) => ({ id, type, text }));
}

type ProductionClassroomTimeMetadata = {
  kind: "timer";
  ownerId: string;
  label: string;
  runtime: {
    status: "completed" | "idle" | "paused" | "running";
    remainingMs: number;
    deadlineMs: number | null;
  };
};

function classroomTimeAnchors(project: StoredProject | undefined): ProductionClassroomTimeMetadata[] {
  const scene = project?.scenes[project.activeSceneId];
  return (scene?.elements || []).flatMap((element) => {
    if (element.isDeleted) return [];
    const customData = element.customData as {
      classroomTimeWidget?: Partial<ProductionClassroomTimeMetadata>;
    } | undefined;
    const metadata = customData?.classroomTimeWidget;
    return metadata?.kind === "timer"
      && typeof metadata.ownerId === "string"
      && typeof metadata.label === "string"
      && !!metadata.runtime
      ? [metadata as ProductionClassroomTimeMetadata]
      : [];
  });
}

async function acknowledgeLocalReadinessAdvisory(
  page: import("@playwright/test").Page,
): Promise<void> {
  const banner = page.locator(".local-readiness-banner");
  const storageIsDurable = await page.evaluate(async () => {
    try {
      return typeof navigator.storage?.persisted === "function"
        && await navigator.storage.persisted();
    } catch {
      return false;
    }
  });
  if (!storageIsDurable) {
    await expect(banner).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  }
  if (!await banner.isVisible()) return;
  await banner.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(banner).toHaveCount(0);
}

async function addText(page: import("@playwright/test").Page, text: string): Promise<void> {
  const textTool = page.getByTestId("toolbar-text");
  await textTool.click({ force: true });
  if (!await textTool.isChecked()) {
    // The compact mobile toolbar can close in the same turn as a synthetic
    // tool click. The documented keyboard shortcut reaches the same editor
    // command without bypassing application state.
    await page.keyboard.press("t");
  }
  await expect(textTool).toBeChecked();
  const canvas = page.locator(".editor-host canvas.excalidraw__canvas.interactive");
  await expect(canvas).toBeVisible();
  const position = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const candidates = [
      { x: 0.5, y: 0.65 },
      { x: 0.25, y: 0.65 },
      { x: 0.75, y: 0.65 },
      { x: 0.5, y: 0.45 },
    ];
    for (const candidate of candidates) {
      const x = bounds.width * candidate.x;
      const y = bounds.height * candidate.y;
      if (document.elementFromPoint(bounds.left + x, bounds.top + y) === element) {
        return { x, y };
      }
    }
    return null;
  });
  if (!position) throw new Error("The interactive canvas has no unobstructed text insertion point.");
  await canvas.click({ position });
  const textEditor = page.locator("textarea.excalidraw-wysiwyg");
  await expect(textEditor).toBeVisible();
  await textEditor.fill(text);
  // Escape is Excalidraw's documented finish-editing action and works across
  // Chromium, Firefox, and WebKit without relying on platform-modifier mapping.
  await textEditor.press("Escape");
  await expect(textEditor).toHaveCount(0);
  await expect.poll(async () => (
    liveElements(await autosavedProject(page))
      .some((element) => element.type === "text" && element.text === text)
  )).toBe(true);
}

async function addRectangle(
  page: import("@playwright/test").Page,
  xOffset: number,
): Promise<void> {
  const rectangleTool = page.getByTestId("toolbar-rectangle");
  await rectangleTool.click({ force: true });
  if (!await rectangleTool.isChecked()) await page.keyboard.press("r");
  await expect(rectangleTool).toBeChecked();
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("Editor host has no visible bounds.");
  const startX = editor.x + editor.width / 2 + xOffset;
  const startY = editor.y + editor.height / 2 - 55;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 50, startY + 40, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId("toolbar-selection").click({ force: true });
}

async function installSeparatedBoundLabelFallbackFixture(
  page: import("@playwright/test").Page,
): Promise<void> {
  await expect.poll(async () => {
    const project = await autosavedProject(page);
    const elements = project?.scenes[project.activeSceneId]?.elements || [];
    return {
      rectangles: elements.filter((element) => (
        element.type === "rectangle" && element.isDeleted !== true
      )).length,
      text: elements.filter((element) => (
        element.type === "text" && element.isDeleted !== true
      )).length,
    };
  }).toEqual({ rectangles: 2, text: 1 });

  const saved = await autosavedProject(page);
  if (!saved) throw new Error("The production fallback fixture was not autosaved.");
  const scene = saved.scenes[saved.activeSceneId];
  if (!scene?.pdfPage?.backgroundElementId) {
    throw new Error("The production fallback fixture has no PDF background.");
  }
  const rectangles = scene.elements.filter((element) => (
    element.type === "rectangle" && element.isDeleted !== true
  ));
  const label = scene.elements.find((element) => (
    element.type === "text" && element.isDeleted !== true
  ));
  const container = rectangles[0];
  const separator = rectangles[1];
  if (!container?.id || !separator?.id || !label?.id) {
    throw new Error("The production fallback annotations are incomplete.");
  }
  const boundContainer: StoredElement = {
    ...container,
    boundElements: [{ id: label.id, type: "text" }],
  };
  const vectorSeparator: StoredElement = {
    ...separator,
    boundElements: null,
    roughness: 0,
    strokeStyle: "solid",
    fillStyle: "solid",
    roundness: null,
    strokeColor: "#008000",
    backgroundColor: "#00ff00",
    opacity: 100,
  };
  const boundLabel: StoredElement = { ...label, containerId: container.id };
  const targetIds = new Set([container.id, separator.id, label.id]);
  const reordered = scene.elements.filter((element) => (
    !element.id || !targetIds.has(element.id)
  ));
  const backgroundIndex = reordered.findIndex(
    (element) => element.id === scene.pdfPage?.backgroundElementId,
  );
  reordered.splice(
    backgroundIndex + 1,
    0,
    boundContainer,
    vectorSeparator,
    boundLabel,
  );
  await setAutosavedProject(page, {
    ...saved,
    scenes: {
      ...saved.scenes,
      [saved.activeSceneId]: { ...scene, elements: reordered },
    },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect(page.locator(".pdf-annotation-count")).toHaveText("3");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(async () => Boolean(await autosavedProject(page))).toBe(true);
  // Production UX scenarios exercise the working editor, not the startup
  // storage advisory. Acknowledge it explicitly instead of force-clicking
  // controls behind a visible mobile banner.
  await acknowledgeLocalReadinessAdvisory(page);
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
    await acknowledgeLocalReadinessAdvisory(page);
    await expect(page.locator(".local-readiness-banner")).toHaveCount(0);
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

  // Opening Project Find schedules a second-frame focus fallback for browsers
  // whose sidebar mounts late. A user can still move to another panel control
  // in the opening task; that delayed fallback must not steal focus back.
  await query.press("Escape");
  await expect(query).toHaveCount(0);
  await page.evaluate(() => {
    type NestedRafState = {
      callbacks: Map<number, FrameRequestCallback>;
      insideFrame: boolean;
      nextId: number;
      request: typeof window.requestAnimationFrame;
      cancel: typeof window.cancelAnimationFrame;
    };
    const host = window as Window & { __patterdrawNestedRaf?: NestedRafState };
    const state: NestedRafState = {
      callbacks: new Map(),
      insideFrame: false,
      nextId: -1,
      request: window.requestAnimationFrame.bind(window),
      cancel: window.cancelAnimationFrame.bind(window),
    };
    host.__patterdrawNestedRaf = state;
    window.requestAnimationFrame = (callback) => {
      if (state.insideFrame) {
        const id = state.nextId--;
        state.callbacks.set(id, callback);
        return id;
      }
      return state.request((timestamp) => {
        state.insideFrame = true;
        try {
          callback(timestamp);
        } finally {
          state.insideFrame = false;
        }
      });
    };
    window.cancelAnimationFrame = (id) => {
      if (!state.callbacks.delete(id)) state.cancel(id);
    };
  });
  await page.getByRole("button", { name: "Find in project", exact: true }).click();
  await expect(query).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    const state = (window as Window & {
      __patterdrawNestedRaf?: { request: typeof window.requestAnimationFrame };
    }).__patterdrawNestedRaf;
    if (!state) throw new Error("Nested animation-frame gate is unavailable.");
    state.request(() => resolve());
  }));
  await canvasSearch.focus();
  await page.evaluate(() => new Promise<void>((resolve) => {
    type NestedRafState = {
      callbacks: Map<number, FrameRequestCallback>;
      request: typeof window.requestAnimationFrame;
      cancel: typeof window.cancelAnimationFrame;
    };
    const host = window as Window & { __patterdrawNestedRaf?: NestedRafState };
    const state = host.__patterdrawNestedRaf;
    if (!state) throw new Error("Nested animation-frame gate is unavailable.");
    window.requestAnimationFrame = state.request;
    window.cancelAnimationFrame = state.cancel;
    delete host.__patterdrawNestedRaf;
    for (const callback of state.callbacks.values()) state.request(callback);
    state.request(() => state.request(() => resolve()));
  }));
  await expect(canvasSearch).toBeFocused();

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

test("confirms a visual PDF fallback without bypassing the hybrid default", async ({ page }) => {
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([400, 240]);
  await page.getByLabel("Open project file").setInputFiles({
    name: "production-hybrid-fallback.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await sourceDocument.save()),
  });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1, {
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
  // On the 320px project the PDF rail is an intentional modal drawer; close
  // it before interacting with the editor toolbar, then restore it after ink.
  await page.getByRole("button", { name: "Hide PDF pages", exact: true }).click();
  await addRectangle(page, -95);
  await addRectangle(page, -20);
  await addText(page, "PRODUCTION_VISUAL_FALLBACK");
  await page.getByRole("button", { name: "Show PDF pages", exact: true }).click();
  await installSeparatedBoundLabelFallbackFixture(page);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const fallback = page.getByRole("dialog", {
    name: "Use visual PDF fallback?",
    exact: true,
  });
  await expect(fallback).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect(fallback).toContainText("confirmation applies only to this export");
  const dialogBounds = await fallback.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds?.x || 0).toBeGreaterThanOrEqual(-1);
  expect((dialogBounds?.x || 0) + (dialogBounds?.width || 0)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth + 1),
  );

  const downloadEvent = page.waitForEvent("download");
  await fallback.getByRole("button", {
    name: "Continue with visual PDF",
    exact: true,
  }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("The visual fallback download has no bytes.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect((await PDFDocument.load(Buffer.concat(chunks))).getPageCount()).toBe(1);
  await expect(fallback).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })
    .getByRole("switch", { name: "Offer visual PDF fallback", exact: true }))
    .toBeChecked();
});

test("starts and persists a Classroom Timer across packaged engines and a 320px viewport", async ({ page }) => {
  const openClassroomTools = async () => {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
    const tools = page.getByRole("dialog", { name: "Math tools", exact: true });
    await expect(tools).toBeVisible();
    const experimental = tools.getByRole("switch", { name: "Experimental features", exact: true });
    if (!await experimental.isChecked()) await experimental.check();
    await tools.getByTestId("math-tool-classroom-tab").click();
    await expect(tools.getByTestId("math-tool-classroom-tab")).toHaveAttribute("aria-selected", "true");
    return tools;
  };

  const tools = await openClassroomTools();
  for (const id of ["clock", "timer", "pomodoro", "calendar", "dashboard"]) {
    await expect(tools.getByTestId(`math-tool-classroom-${id}`)).toBeVisible();
  }
  await tools.getByTestId("math-tool-classroom-timer").click();
  const dialog = page.getByRole("dialog", { name: "Add Timer", exact: true });
  await expect(dialog).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds?.x || 0).toBeGreaterThanOrEqual(-1);
  expect(dialogBounds?.y || 0).toBeGreaterThanOrEqual(-1);
  expect((dialogBounds?.x || 0) + (dialogBounds?.width || 0)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth + 1),
  );
  expect((dialogBounds?.y || 0) + (dialogBounds?.height || 0)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerHeight + 1),
  );
  await dialog.getByLabel("Widget label", { exact: true }).fill("Production Timer");
  await dialog.getByRole("button", { name: "Add Timer", exact: true }).click();

  const overlay = page.getByTestId("classroom-time-overlay");
  await expect(overlay).toBeVisible();
  const overlayBounds = await overlay.boundingBox();
  expect(overlayBounds).not.toBeNull();
  expect(overlayBounds?.x || 0).toBeGreaterThanOrEqual(-1);
  expect((overlayBounds?.x || 0) + (overlayBounds?.width || 0)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth + 1),
  );
  await page.evaluate(() => {
    class PendingAudioContext {
      readonly state = "suspended";

      resume(): Promise<void> {
        return new Promise<void>(() => undefined);
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: PendingAudioContext,
      writable: true,
    });
  });
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => classroomTimeAnchors(await autosavedProject(page)))
    .toMatchObject([{ label: "Production Timer", runtime: { status: "running" } }]);
  await expect(page.getByText(
    "Countdown started, but your browser blocked alarm sound. Test the alarm before relying on it.",
    { exact: true },
  )).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("patterdraw:classroom-alarm-registry:v1") || "null") as {
      jobs?: unknown[];
    } | null;
    return stored?.jobs?.length ?? 0;
  })).toBe(1);
  await page.waitForTimeout(1_100);
  await expect(page.getByText("Classroom alarm job is invalid", { exact: false })).toHaveCount(0);
  const audioWarning = page.locator(".error-toast");
  await expect(audioWarning).toHaveCount(1);
  const dismissAudioWarning = audioWarning.getByRole("button", { name: "Dismiss", exact: true });
  await expect(dismissAudioWarning).toBeVisible();
  await expect(dismissAudioWarning).toBeEnabled();
  await dismissAudioWarning.click();
  await expect(audioWarning).toHaveCount(0);

  await overlay.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => classroomTimeAnchors(await autosavedProject(page))[0]?.runtime.status)
    .toBe("paused");
  await page.getByRole("button", { name: "More classroom time actions", exact: true }).click();
  const actions = page.getByRole("menu", { name: "Classroom time widget actions", exact: true });
  await expect(actions).toBeVisible();
  await actions.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect.poll(async () => classroomTimeAnchors(await autosavedProject(page)).length).toBe(2);
  const duplicated = classroomTimeAnchors(await autosavedProject(page));
  expect(new Set(duplicated.map((metadata) => metadata.ownerId)).size).toBe(2);
  expect(duplicated.every((metadata) => metadata.runtime.status === "paused")).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect.poll(async () => classroomTimeAnchors(await autosavedProject(page)).length).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
