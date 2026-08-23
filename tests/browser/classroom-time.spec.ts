import {
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { strFromU8, unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const EDITOR_MOUNT_TIMEOUT = 90_000;
const AUTOSAVE_KEY = "patterdraw:autosave:project:v1";
const AUTOSAVE_REVISION_KEY = "patterdraw:autosave:revision:v1";
const DEVICE_CALENDAR_KEY = "patterdraw:classroom-calendar:v1";
const ALARM_REGISTRY_KEY = "patterdraw:classroom-alarm-registry:v1";
const pdfStandardFontDataUrl = decodeURIComponent(new URL(
  "./standard_fonts/",
  import.meta.resolve("pdfjs-dist/package.json"),
).pathname);

type ClassroomWidgetKind = "calendar" | "clock" | "dashboard" | "pomodoro" | "timer";

type StoredElement = Record<string, unknown> & {
  id: string;
  type: string;
  isDeleted?: boolean;
  text?: string;
  fileId?: string | null;
  groupIds?: string[];
  customData?: {
    classroomTimeWidget?: Record<string, unknown>;
  };
};

type StoredScene = {
  id: string;
  elements: StoredElement[];
  files: Record<string, unknown>;
  pdfPage?: {
    backgroundElementId?: string;
    documentId: string;
    pageIndex: number;
  };
};

type StoredCalendarEvent = {
  id: string;
  title: string;
  date: string;
  color?: string;
  note?: string;
};

type StoredProject = {
  id: string;
  title: string;
  updatedAt: string;
  activeSceneId: string;
  scenes: Record<string, StoredScene>;
  projectCalendar?: {
    layer: "project";
    events: StoredCalendarEvent[];
  };
  pdfPageOrder?: string[];
};

type WidgetMetadata = Record<string, unknown> & {
  version: 1;
  ownerId: string;
  kind: ClassroomWidgetKind;
  label: string;
  appearance: {
    foregroundColor: string;
    backgroundColor: string;
    accentColor: string;
    borderColor: string;
    opacity: number;
    theme: "auto" | "dark" | "light";
  };
  calendar?: {
    projectEventIds: string[];
    transferCache: unknown;
    showProjectEvents: boolean;
    showDeviceEvents: boolean;
    showWeekends: boolean;
    showWeekNumbers: boolean;
    highlightToday: boolean;
    density: "comfortable" | "compact";
    view: "agenda" | "month" | "week";
  };
  runtime?: {
    status: "completed" | "idle" | "paused" | "running";
    remainingMs: number;
    deadlineMs: number | null;
  };
  timerRuntime?: {
    status: "completed" | "idle" | "paused" | "running";
    remainingMs: number;
    deadlineMs: number | null;
  };
  pomodoroRuntime?: {
    status: "completed" | "idle" | "paused" | "running";
    phase: "focus" | "long-break" | "short-break";
    remainingMs: number;
    deadlineMs: number | null;
  };
};

type RuntimeGuardState = {
  consoleErrors: string[];
  externalRequests: string[];
  pageErrors: string[];
  requestListener: (request: Request) => void;
};

const runtimeGuardStates = new WeakMap<BrowserContext, RuntimeGuardState>();

function widgetMetadata(element: StoredElement): WidgetMetadata | null {
  const metadata = element.customData?.classroomTimeWidget;
  if (!metadata || typeof metadata.kind !== "string") return null;
  return metadata as WidgetMetadata;
}

function widgetChild(element: StoredElement): Record<string, unknown> | null {
  const marker = element.customData?.classroomTimeWidget;
  return marker && typeof marker.role === "string" ? marker : null;
}

function activeScene(project: StoredProject | undefined): StoredScene | undefined {
  return project?.scenes[project.activeSceneId];
}

function liveWidgetAnchors(project: StoredProject | undefined): Array<{
  element: StoredElement;
  metadata: WidgetMetadata;
}> {
  return (activeScene(project)?.elements ?? []).flatMap((element) => {
    if (element.isDeleted) return [];
    const metadata = widgetMetadata(element);
    return metadata ? [{ element, metadata }] : [];
  });
}

async function keyvalValue<T>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate(async (storedKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readonly");
      const request = transaction.objectStore("keyval").get(storedKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  }, key) as Promise<T | undefined>;
}

async function localStorageJson<T>(page: Page, key: string): Promise<T | null> {
  return page.evaluate((storedKey) => {
    const serialized = localStorage.getItem(storedKey);
    return serialized === null ? null : JSON.parse(serialized) as T;
  }, key);
}

async function deleteKeyvalValue(page: Page, key: string): Promise<void> {
  await page.evaluate(async (storedKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").delete(storedKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, key);
}

async function setKeyvalValue(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(async ({ storedKey, storedValue }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").put(storedValue, storedKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { storedKey: key, storedValue: value });
}

async function holdKeyvalWrites(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type HoldState = { release: boolean };
    const scopedWindow = window as typeof window & {
      __patterdrawQaKeyvalHold?: HoldState;
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const hold: HoldState = { release: false };
    scopedWindow.__patterdrawQaKeyvalHold = hold;
    const transaction = database.transaction("keyval", "readwrite");
    const store = transaction.objectStore("keyval");
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const keepAlive = () => {
        const request = store.get("__patterdraw_qa_keyval_hold__");
        request.onsuccess = () => {
          if (!ready) {
            ready = true;
            resolve();
          }
          if (!hold.release) keepAlive();
        };
        request.onerror = () => reject(request.error);
      };
      keepAlive();
    });
  });
}

async function releaseKeyvalWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __patterdrawQaKeyvalHold?: { release: boolean };
    };
    if (scopedWindow.__patterdrawQaKeyvalHold) {
      scopedWindow.__patterdrawQaKeyvalHold.release = true;
    }
  });
}

async function autosavedProject(page: Page): Promise<StoredProject | undefined> {
  return keyvalValue<StoredProject>(page, AUTOSAVE_KEY);
}

async function waitForWidgetCount(page: Page, expected: number): Promise<StoredProject> {
  let observed: StoredProject | undefined;
  await expect.poll(async () => {
    observed = await autosavedProject(page);
    return liveWidgetAnchors(observed).length;
  }, { timeout: 20_000 }).toBe(expected);
  if (!observed) throw new Error("The classroom widget project was not autosaved.");
  return observed;
}

async function waitForOnlyWidget(page: Page, kind: ClassroomWidgetKind): Promise<WidgetMetadata> {
  let metadata: WidgetMetadata | null = null;
  await expect.poll(async () => {
    const anchors = liveWidgetAnchors(await autosavedProject(page));
    metadata = anchors.length === 1 ? anchors[0].metadata : null;
    return metadata?.kind ?? null;
  }, { timeout: 20_000 }).toBe(kind);
  if (!metadata) throw new Error(`The ${kind} widget was not autosaved.`);
  return metadata;
}

async function focusEditorForClipboard(page: Page): Promise<void> {
  const editor = page.locator(".editor-host .excalidraw");
  await editor.focus();
  await expect.poll(() => page.evaluate(() => (
    document.activeElement?.closest(".editor-host .excalidraw") !== null
  ))).toBe(true);
}

async function copySelectedElements(page: Page): Promise<string> {
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("The editor has no visible bounds for clipboard selection.");
  await page.mouse.click(editor.x + editor.width / 2, editor.y + editor.height / 2);
  await expect(page.getByTestId("classroom-time-overlay")).toBeVisible();
  await focusEditorForClipboard(page);
  await page.keyboard.press("ControlOrMeta+c");
  let clipboardText = "";
  await expect.poll(async () => {
    clipboardText = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return "";
      }
    });
    try {
      return (JSON.parse(clipboardText) as { type?: string }).type === "excalidraw/clipboard";
    } catch {
      return false;
    }
  }, { timeout: 10_000 }).toBe(true);
  return clipboardText;
}

async function pasteCopiedElements(page: Page): Promise<void> {
  await focusEditorForClipboard(page);
  await page.keyboard.press("ControlOrMeta+v");
}

async function openClassroomTools(page: Page) {
  const existing = page.getByRole("dialog", { name: "Math tools", exact: true });
  if (!await existing.isVisible()) {
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByTestId("toolbar-math-tools").click();
  }
  const dialog = page.getByRole("dialog", { name: "Math tools", exact: true });
  await expect(dialog).toBeVisible();
  const experimental = dialog.getByRole("switch", { name: "Experimental features", exact: true });
  if (!await experimental.isChecked()) await experimental.check();
  await dialog.getByTestId("math-tool-classroom-tab").click();
  await expect(dialog.getByTestId("math-tool-classroom-tab")).toHaveAttribute("aria-selected", "true");
  return dialog;
}

const WIDGET_CARD_IDS: Readonly<Record<ClassroomWidgetKind, string>> = {
  calendar: "math-tool-classroom-calendar",
  clock: "math-tool-classroom-clock",
  dashboard: "math-tool-classroom-dashboard",
  pomodoro: "math-tool-classroom-pomodoro",
  timer: "math-tool-classroom-timer",
};

const WIDGET_DIALOG_NAMES: Readonly<Record<ClassroomWidgetKind, string>> = {
  calendar: "Add Class Calendar",
  clock: "Add Clock",
  dashboard: "Add Classroom Dashboard",
  pomodoro: "Add Pomodoro",
  timer: "Add Timer",
};

const WIDGET_ADD_NAMES: Readonly<Record<ClassroomWidgetKind, string>> = {
  calendar: "Add Class Calendar",
  clock: "Add Clock",
  dashboard: "Add Classroom Dashboard",
  pomodoro: "Add Pomodoro",
  timer: "Add Timer",
};

async function openWidgetDialog(page: Page, kind: ClassroomWidgetKind) {
  const tools = await openClassroomTools(page);
  await tools.getByTestId(WIDGET_CARD_IDS[kind]).click();
  const dialog = page.getByRole("dialog", { name: WIDGET_DIALOG_NAMES[kind], exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addOpenWidget(page: Page, kind: ClassroomWidgetKind): Promise<void> {
  const dialog = page.getByRole("dialog", { name: WIDGET_DIALOG_NAMES[kind], exact: true });
  await dialog.getByRole("button", { name: WIDGET_ADD_NAMES[kind], exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function setWidgetColor(dialog: ReturnType<Page["locator"]>, label: string, value: string) {
  const field = dialog.locator(".classroom-time-color-field").filter({ hasText: label }).first();
  await field.locator('input[type="color"]').fill(value);
  await expect(field.locator("code")).toHaveText(value.toUpperCase());
}

async function openLibraryPanel(page: Page) {
  const trigger = page.getByRole("button", { name: "Library", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  const panel = page.locator(".layer-ui__library");
  await expect(panel).toBeVisible();
  return { panel, trigger };
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("The browser did not expose the download stream.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type RenderedPdfPage = {
  height: number;
  pixels: Uint8ClampedArray;
  width: number;
};

async function renderedPdfPage(bytes: Uint8Array): Promise<RenderedPdfPage> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    standardFontDataUrl: pdfStandardFontDataUrl,
  });
  const document = await loadingTask.promise;
  try {
    const pdfPage = await document.getPage(1);
    try {
      const viewport = pdfPage.getViewport({ scale: 1 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      await pdfPage.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        background: "#ffffff",
      }).promise;
      return {
        width,
        height,
        pixels: Uint8ClampedArray.from(context.getImageData(0, 0, width, height).data),
      };
    } finally {
      pdfPage.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

function pdfInkPixels(page: RenderedPdfPage): number {
  let ink = 0;
  for (let offset = 0; offset < page.pixels.length; offset += 4) {
    if (page.pixels[offset + 3] > 100 && Math.min(
      page.pixels[offset],
      page.pixels[offset + 1],
      page.pixels[offset + 2],
    ) < 240) ink += 1;
  }
  return ink;
}

function changedPdfPixels(left: RenderedPdfPage, right: RenderedPdfPage): number {
  expect({ width: right.width, height: right.height }).toEqual({
    width: left.width,
    height: left.height,
  });
  let changed = 0;
  for (let offset = 0; offset < left.pixels.length; offset += 4) {
    if (
      Math.abs(left.pixels[offset] - right.pixels[offset]) > 8
      || Math.abs(left.pixels[offset + 1] - right.pixels[offset + 1]) > 8
      || Math.abs(left.pixels[offset + 2] - right.pixels[offset + 2]) > 8
      || Math.abs(left.pixels[offset + 3] - right.pixels[offset + 3]) > 8
    ) changed += 1;
  }
  return changed;
}

async function renderedPdfInkPixels(bytes: Uint8Array): Promise<number> {
  return pdfInkPixels(await renderedPdfPage(bytes));
}

async function visibleMagentaCanvasPixels(page: Page): Promise<number> {
  const screenshot = await page.locator("canvas.excalidraw__canvas.interactive").screenshot();
  const image = await loadImage(screenshot);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let magenta = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] > 190 && pixels[offset + 1] < 90 && pixels[offset + 2] > 190) magenta += 1;
  }
  return magenta;
}

async function liveWidgetRoleText(page: Page, role: string): Promise<string | null> {
  return page.evaluate((targetRole) => {
    type LiveElement = {
      customData?: { classroomTimeWidget?: { role?: string } };
      isDeleted?: boolean;
      text?: string;
    };
    const elements = (window as unknown as {
      h?: { app?: { scene?: { getNonDeletedElements?: () => LiveElement[] } } };
    }).h?.app?.scene?.getNonDeletedElements?.() ?? [];
    return elements.find((element) => (
      !element.isDeleted && element.customData?.classroomTimeWidget?.role === targetRole
    ))?.text ?? null;
  }, role);
}

async function liveWidgetShellFile(page: Page, ownerId: string): Promise<{
  dataURLIsSvg: boolean;
  fileId: string | null;
  mimeType: string | null;
}> {
  return page.evaluate((expectedOwnerId) => {
    type LiveElement = {
      customData?: { classroomTimeWidget?: { kind?: string; ownerId?: string } };
      fileId?: string | null;
      isDeleted?: boolean;
    };
    type LiveFile = { dataURL?: string; mimeType?: string };
    const app = (window as unknown as {
      h?: {
        app?: {
          files?: Record<string, LiveFile>;
          scene?: { getNonDeletedElements?: () => LiveElement[] };
        };
      };
    }).h?.app;
    const anchor = (app?.scene?.getNonDeletedElements?.() ?? []).find((element) => (
      !element.isDeleted
      && element.customData?.classroomTimeWidget?.ownerId === expectedOwnerId
      && typeof element.customData?.classroomTimeWidget?.kind === "string"
    ));
    const fileId = anchor?.fileId ?? null;
    const file = fileId ? app?.files?.[fileId] : undefined;
    return {
      dataURLIsSvg: file?.dataURL?.startsWith("data:image/svg+xml") ?? false,
      fileId,
      mimeType: file?.mimeType ?? null,
    };
  }, ownerId);
}

async function simplePdfBytes(pageCount = 1): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([612, 792]);
  return Buffer.from(await document.save());
}

async function addOrdinaryRectangle(
  page: Page,
  horizontalOffset: number,
  verticalOffset: number,
): Promise<void> {
  const rectangleTool = page.getByRole("radio", { name: "Rectangle", exact: true });
  await rectangleTool.check({ force: true });
  await expect(rectangleTool).toBeChecked();
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("The PDF editor has no visible bounds.");
  const startX = editor.x + editor.width / 2 + horizontalOffset;
  const startY = editor.y + editor.height / 2 + verticalOffset;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 54, startY + 42, { steps: 6 });
  await page.mouse.up();
  const selectionTool = page.getByRole("radio", { name: "Selection", exact: true });
  await selectionTool.check({ force: true });
  await expect(selectionTool).toBeChecked();
}

async function addOrdinaryText(page: Page, text: string): Promise<void> {
  const textTool = page.getByRole("radio", { name: "Text", exact: true });
  await textTool.check({ force: true });
  await expect(textTool).toBeChecked();
  const editor = await page.locator(".editor-host").boundingBox();
  if (!editor) throw new Error("The PDF editor has no visible bounds.");
  await page.mouse.click(editor.x + editor.width * 0.7, editor.y + editor.height * 0.7);
  const textEditor = page.locator("textarea.excalidraw-wysiwyg");
  await expect(textEditor).toBeVisible();
  await textEditor.fill(text);
  await textEditor.press("ControlOrMeta+Enter");
  await expect(textEditor).toHaveCount(0);
  const selectionTool = page.getByRole("radio", { name: "Selection", exact: true });
  await selectionTool.check({ force: true });
  await expect(selectionTool).toBeChecked();
}

async function installClassroomVisualFallbackFixture(page: Page): Promise<void> {
  const fallbackText = "CLASSROOM_DEVICE_FALLBACK_FIXTURE";
  // A success toast must release the central Excalidraw toolbar before the
  // next ordinary drawing action.
  await expect(page.locator(".Toast__message")).toHaveCount(0, { timeout: 10_000 });
  await addOrdinaryRectangle(page, 120, -100);
  await addOrdinaryRectangle(page, 210, -100);
  await addOrdinaryText(page, fallbackText);
  await expect.poll(async () => {
    const project = await autosavedProject(page);
    const elements = activeScene(project)?.elements ?? [];
    const ordinary = elements.filter((element) => (
      !element.isDeleted && !element.customData?.classroomTimeWidget
    ));
    return {
      rectangles: ordinary.filter((element) => element.type === "rectangle").length,
      sentinel: ordinary.filter((element) => (
        element.type === "text" && element.text === fallbackText
      )).length,
    };
  }).toEqual({ rectangles: 2, sentinel: 1 });

  const saved = await autosavedProject(page);
  if (!saved) throw new Error("The Classroom fallback fixture was not autosaved.");
  const scene = activeScene(saved);
  if (!scene?.pdfPage?.backgroundElementId) {
    throw new Error("The Classroom fallback fixture has no PDF background.");
  }
  const ordinary = scene.elements.filter((element) => (
    !element.isDeleted && !element.customData?.classroomTimeWidget
  ));
  const rectangles = ordinary.filter((element) => element.type === "rectangle");
  const label = ordinary.find((element) => element.type === "text" && element.text === fallbackText);
  const container = rectangles[0];
  const separator = rectangles[1];
  if (!container?.id || !separator?.id || !label?.id) {
    throw new Error("The Classroom fallback annotations are incomplete.");
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
  const fixtureIds = new Set([container.id, separator.id, label.id]);
  const reordered = scene.elements.filter((element) => !fixtureIds.has(element.id));
  const backgroundIndex = reordered.findIndex(
    (element) => element.id === scene.pdfPage?.backgroundElementId,
  );
  if (backgroundIndex < 0) throw new Error("The PDF background could not be ordered for fallback.");
  reordered.splice(backgroundIndex + 1, 0, boundContainer, vectorSeparator, boundLabel);
  await setKeyvalValue(page, AUTOSAVE_KEY, {
    ...saved,
    updatedAt: new Date().toISOString(),
    scenes: {
      ...saved.scenes,
      [saved.activeSceneId]: { ...scene, elements: reordered },
    },
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: EDITOR_MOUNT_TIMEOUT });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);
  await expect(page.locator(".pdf-annotation-count")).toHaveText("4");
}

async function replaceDeviceCalendarEvents(
  page: Page,
  events: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await page.evaluate(({ key, nextEvents }) => {
    const current = (() => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "null") as {
          revision?: number;
        } | null;
      } catch {
        return null;
      }
    })();
    const store = {
      schemaVersion: 1,
      layer: "device",
      events: nextEvents,
    };
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      revision: Math.max(0, current?.revision ?? 0) + 1,
      store,
    }));
    window.dispatchEvent(new CustomEvent("patterdraw:classroom-calendar-change", {
      detail: store,
    }));
  }, { key: DEVICE_CALENDAR_KEY, nextEvents: events });
}

async function liveSceneContainsText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((expected) => {
    type LiveText = { isDeleted?: boolean; text?: string };
    const elements = (window as unknown as {
      h?: { app?: { scene?: { getNonDeletedElements?: () => LiveText[] } } };
    }).h?.app?.scene?.getNonDeletedElements?.() ?? [];
    return elements.some((element) => !element.isDeleted && element.text?.includes(expected));
  }, text);
}

async function exportVisualFallbackPdf(
  page: Page,
  beforeConfirm?: () => Promise<void>,
): Promise<Buffer> {
  await page.getByRole("button", { name: "More export options", exact: true }).click();
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const fallback = page.getByRole("dialog", { name: "Use visual PDF fallback?", exact: true });
  await expect(fallback).toBeVisible({ timeout: 30_000 });
  await beforeConfirm?.();
  const downloadEvent = page.waitForEvent("download");
  await fallback.getByRole("button", { name: "Continue with visual PDF", exact: true }).click();
  const bytes = await downloadBytes(await downloadEvent);
  await expect(fallback).toHaveCount(0);
  return bytes;
}

async function openPdfClearDialog(page: Page, outputPage: number) {
  await page.getByRole("button", {
    name: `More actions for output page ${outputPage}`,
    exact: true,
  }).click();
  const actions = page.getByRole("menu", {
    name: `Actions for output page ${outputPage}`,
    exact: true,
  });
  await expect(actions).toBeVisible();
  await actions.getByRole("menuitem", { name: "Clear annotations…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clear annotations", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function installFakeAudio(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const probe: {
      blockResumes: boolean;
      contexts: Array<{ state: string }>;
      gainConnections: number;
      oscillatorStarts: number;
      resumes: number;
    } = {
      blockResumes: false,
      contexts: [],
      gainConnections: 0,
      oscillatorStarts: 0,
      resumes: 0,
    };
    (window as Window & { __classroomAudioProbe?: typeof probe }).__classroomAudioProbe = probe;

    class TestAudioParam {
      setValueAtTime() { return this; }
      exponentialRampToValueAtTime() { return this; }
    }
    class TestAudioNode {
      connect() {
        probe.gainConnections += 1;
        return this;
      }
      disconnect() { return undefined; }
    }
    class TestOscillatorNode extends TestAudioNode {
      type = "sine";
      frequency = new TestAudioParam();
      onended: (() => void) | null = null;
      start() { probe.oscillatorStarts += 1; }
      stop() { window.setTimeout(() => this.onended?.(), 0); }
    }
    class TestGainNode extends TestAudioNode {
      gain = new TestAudioParam();
    }
    class TestAudioContext {
      state = "running";
      currentTime = 0;
      destination = new TestAudioNode();
      constructor() {
        probe.contexts.push(this);
      }
      async resume() {
        probe.resumes += 1;
        if (probe.blockResumes) throw new Error("Audio resume blocked for test");
        this.state = "running";
      }
      createGain() { return new TestGainNode(); }
      createOscillator() { return new TestOscillatorNode(); }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: TestAudioContext as unknown as typeof AudioContext,
    });
    Object.defineProperty(window, "webkitAudioContext", {
      configurable: true,
      value: TestAudioContext as unknown as typeof AudioContext,
    });
  });
}

async function audioProbe(page: Page): Promise<{ gainConnections: number; oscillatorStarts: number; resumes: number }> {
  return page.evaluate(() => (
    window as Window & {
      __classroomAudioProbe?: { gainConnections: number; oscillatorStarts: number; resumes: number };
    }
  ).__classroomAudioProbe ?? { gainConnections: 0, oscillatorStarts: 0, resumes: 0 });
}

async function setAudioResumeBlocked(page: Page, blocked: boolean): Promise<void> {
  await page.evaluate((nextBlocked) => {
    const probe = (
      window as Window & {
        __classroomAudioProbe?: {
          blockResumes: boolean;
          contexts: Array<{ state: string }>;
        };
      }
    ).__classroomAudioProbe;
    if (!probe) throw new Error("Fake Classroom audio probe is unavailable");
    probe.blockResumes = nextBlocked;
    for (const context of probe.contexts) context.state = nextBlocked ? "suspended" : "running";
  }, blocked);
}

test.beforeEach(async ({ context, page }, testInfo) => {
  await installFakeAudio(context);
  const configuredBaseUrl = String(testInfo.project.use.baseURL ?? "http://127.0.0.1:5173");
  const allowedOrigin = new URL(configuredBaseUrl).origin;
  const state: RuntimeGuardState = {
    consoleErrors: [],
    externalRequests: [],
    pageErrors: [],
    requestListener: () => undefined,
  };
  state.requestListener = (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== allowedOrigin) {
      state.externalRequests.push(`${request.method()} ${request.url()}`);
    }
  };
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => state.pageErrors.push(error.stack || error.message));
  context.on("request", state.requestListener);
  runtimeGuardStates.set(context, state);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: EDITOR_MOUNT_TIMEOUT });
  await expect.poll(async () => Boolean(await autosavedProject(page))).toBe(true);
});

test.afterEach(async ({ context, page }, testInfo: TestInfo) => {
  const state = runtimeGuardStates.get(context);
  if (!state) return;
  context.off("request", state.requestListener);
  if (testInfo.status !== testInfo.expectedStatus) return;
  await expect(page.locator(".error-toast"), "visible wrapper errors").toHaveCount(0);
  expect(state.consoleErrors, "browser console errors").toEqual([]);
  expect(state.externalRequests, "offline guard blocked external requests").toEqual([]);
  expect(state.pageErrors, "uncaught page errors").toEqual([]);
});

test("offers all Classroom cards and saves a recoloured digital Clock", async ({ page }) => {
  const tools = await openClassroomTools(page);
  for (const kind of ["clock", "timer", "pomodoro", "calendar", "dashboard"] as const) {
    await expect(tools.getByTestId(WIDGET_CARD_IDS[kind])).toBeVisible();
  }

  await tools.getByTestId(WIDGET_CARD_IDS.clock).click();
  const dialog = page.getByRole("dialog", { name: "Add Clock", exact: true });
  await dialog.getByLabel("Widget label", { exact: true }).fill("Period 3 Clock");
  await setWidgetColor(dialog, "Foreground", "#102030");
  await setWidgetColor(dialog, "Background", "#fff4d6");
  await setWidgetColor(dialog, "Accent", "#d04a2b");
  await setWidgetColor(dialog, "Border", "#345678");
  await dialog.getByRole("combobox", { name: "Theme", exact: true }).selectOption({ label: "Dark" });
  await dialog.locator('input[type="range"]').fill("0.75");
  await expect(dialog.getByText("75%", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Clock", exact: true }).click();
  await expect(dialog.getByText("Digital display", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Analog", exact: true })).toHaveCount(0);
  await dialog.getByRole("switch", { name: "Show seconds", exact: true }).uncheck();
  await dialog.getByRole("switch", { name: "Show timezone label", exact: true }).check();
  await dialog.getByLabel("Timezone", { exact: true }).fill("America/Edmonton");
  await addOpenWidget(page, "clock");

  await expect(page.getByTestId("classroom-time-overlay")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Period 3 Clock controls", exact: true })).toBeVisible();
  const metadata = await waitForOnlyWidget(page, "clock");
  expect(metadata).toMatchObject({
    label: "Period 3 Clock",
    appearance: {
      foregroundColor: "#102030",
      backgroundColor: "#fff4d6",
      accentColor: "#d04a2b",
      borderColor: "#345678",
      opacity: 0.75,
      theme: "dark",
    },
    clock: {
      display: "digital",
      showSeconds: false,
      showTimezone: true,
      timeZone: "America/Edmonton",
    },
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: EDITOR_MOUNT_TIMEOUT });
  expect(await waitForOnlyWidget(page, "clock")).toMatchObject({ label: "Period 3 Clock" });
});

test("runs the default Timer without an error and keeps ordinary ticks out of files, autosave, and Undo", async ({ page }) => {
  test.setTimeout(120_000);
  const dialog = await openWidgetDialog(page, "timer");
  await dialog.getByLabel("Widget label", { exact: true }).fill("Quick check");
  await dialog.getByRole("button", { name: "Timer", exact: true }).click();
  await expect(dialog.getByText("Countdown shown as time remaining.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Progress style", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Timer hours", { exact: true }).fill("0");
  await dialog.getByLabel("Timer minutes", { exact: true }).fill("0");
  await dialog.getByLabel("Timer seconds", { exact: true }).fill("30");
  await dialog.getByRole("button", { name: "Alarm", exact: true }).click();
  const tone = dialog.getByRole("combobox", { name: "Tone", exact: true });
  await expect(tone).toBeVisible();
  await tone.selectOption({ label: "Bright marimba" });
  await dialog.getByRole("button", { name: "Test alarm", exact: true }).click();
  await expect.poll(async () => (await audioProbe(page)).oscillatorStarts).toBeGreaterThan(0);
  const testAlarmOscillatorStarts = (await audioProbe(page)).oscillatorStarts;
  await addOpenWidget(page, "timer");

  const overlay = page.getByTestId("classroom-time-overlay");
  const addedNotice = page.getByRole("status").filter({ hasText: "Quick check added." });
  await expect(addedNotice).toBeVisible();
  expect(await addedNotice.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  await expect(overlay.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  await expect(addedNotice).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => {
    const registry = await localStorageJson<{ jobs?: unknown[] }>(page, ALARM_REGISTRY_KEY);
    return registry?.jobs?.length ?? 0;
  }).toBe(1);

  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  // `waitForOnlyWidget(...).runtime.status === "running"` above observes the
  // committed Start snapshot, so subsequent changes would be display-tick
  // churn rather than the one legitimate Start write.
  const beforeTick = await autosavedProject(page);
  const beforeTickRevision = await keyvalValue<{ revision?: string }>(page, AUTOSAVE_REVISION_KEY);
  const beforeScene = activeScene(beforeTick);
  const beforeOutput = await overlay.getByRole("status", { name: "Timer remaining time" }).textContent().catch(() => null);
  await page.waitForTimeout(1_100);
  const afterTick = await autosavedProject(page);
  const afterTickRevision = await keyvalValue<{ revision?: string }>(page, AUTOSAVE_REVISION_KEY);
  const afterScene = activeScene(afterTick);
  expect(afterTick?.updatedAt).toBe(beforeTick?.updatedAt);
  expect(afterTickRevision?.revision).toBe(beforeTickRevision?.revision);
  expect(Object.keys(afterScene?.files ?? {})).toEqual(Object.keys(beforeScene?.files ?? {}));
  expect(await overlay.getByRole("status", { name: "Timer remaining time" }).textContent().catch(() => null)).not.toBe(beforeOutput);
  await expect(page.getByText("Classroom alarm job is invalid", { exact: false })).toHaveCount(0);
  await expect(page.locator(".error-toast")).toHaveCount(0);

  await page.locator('.statusbar [aria-label="Undo"]').click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("idle");
  await expect(overlay.getByRole("button", { name: "Start", exact: true })).toBeVisible();

  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  await expect(overlay.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("paused");
  const paused = await waitForOnlyWidget(page, "timer");
  expect(paused.runtime?.status).toBe("paused");
  const pausedRemaining = paused.runtime?.remainingMs ?? 0;
  await overlay.getByRole("button", { name: "Add one minute", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.remainingMs)
    .toBe(pausedRemaining + 60_000);
  await overlay.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime)
    .toMatchObject({ status: "idle", remainingMs: 90_000, deadlineMs: null });

  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  const updateDialog = page.getByRole("dialog", { name: "Customize Timer", exact: true });
  await updateDialog.getByRole("button", { name: "Timer", exact: true }).click();
  await updateDialog.getByLabel("Timer hours", { exact: true }).fill("0");
  await updateDialog.getByLabel("Timer minutes", { exact: true }).fill("0");
  await updateDialog.getByLabel("Timer seconds", { exact: true }).fill("3");
  await updateDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(updateDialog).toHaveCount(0);
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime)
    .toMatchObject({ status: "idle", remainingMs: 3_000, deadlineMs: null });

  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  const completion = page.getByRole("alert").filter({ hasText: "Time is up" });
  await expect(completion).toBeVisible({ timeout: 12_000 });
  await expect(completion).toContainText("Quick check");
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("completed");
  const completedScene = activeScene(await autosavedProject(page));
  expect(completedScene?.elements.some((element) => widgetChild(element)?.role === "progress-ring")).toBe(false);
  await expect.poll(async () => (await audioProbe(page)).oscillatorStarts).toBeGreaterThan(testAlarmOscillatorStarts);
  await expect.poll(async () => {
    const registry = await localStorageJson<{
      deliveredTombstones?: unknown[];
      jobs?: unknown[];
    }>(page, ALARM_REGISTRY_KEY);
    return {
      delivered: registry?.deliveredTombstones?.length ?? 0,
      jobs: registry?.jobs?.length ?? 0,
    };
  }).toEqual({ delivered: 1, jobs: 0 });
  await expect(page.getByRole("alert").filter({ hasText: "Time is up" })).toHaveCount(1);
  await completion.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(completion).toHaveCount(0);
});

test("supports Pomodoro start, pause, minute adjustment, reset, phase skip, and completion", async ({ page }) => {
  const dialog = await openWidgetDialog(page, "pomodoro");
  await dialog.getByLabel("Widget label", { exact: true }).fill("Independent work");
  await dialog.getByRole("button", { name: "Pomodoro", exact: true }).click();
  await dialog.getByLabel("Focus minutes", { exact: true }).fill("1");
  await dialog.getByLabel("Short break", { exact: true }).fill("2");
  await dialog.getByLabel("Long break", { exact: true }).fill("3");
  await dialog.getByRole("switch", { name: "Auto-start breaks", exact: true }).check();
  await addOpenWidget(page, "pomodoro");

  const overlay = page.getByTestId("classroom-time-overlay");
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "pomodoro")).runtime?.status).toBe("running");
  await overlay.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "pomodoro")).runtime?.status).toBe("paused");
  const paused = await waitForOnlyWidget(page, "pomodoro");
  const remaining = paused.runtime?.remainingMs ?? 0;
  await overlay.getByRole("button", { name: "Add one minute", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "pomodoro")).runtime?.remainingMs)
    .toBe(remaining + 60_000);
  await overlay.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "pomodoro")).runtime)
    .toMatchObject({ status: "idle", phase: "focus", remainingMs: 120_000 });
  await overlay.getByRole("button", { name: "Skip", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "pomodoro")).runtime)
    .toMatchObject({ status: "running", phase: "short-break", remainingMs: 120_000 });

  await page.evaluate((offsetMs) => {
    const scopedWindow = window as typeof window & {
      __patterdrawQaNativeDateNow?: () => number;
    };
    const nativeDateNow = scopedWindow.__patterdrawQaNativeDateNow ?? Date.now.bind(Date);
    scopedWindow.__patterdrawQaNativeDateNow = nativeDateNow;
    Date.now = () => nativeDateNow() + offsetMs;
  }, 121_000);
  try {
    const completion = page.getByRole("alert").filter({ hasText: "Time is up" });
    await expect(completion).toBeVisible({ timeout: 12_000 });
    await expect(completion).toContainText("Independent work");
    await expect.poll(async () => (await waitForOnlyWidget(page, "pomodoro")).runtime)
      .toMatchObject({
        completedFocusSessions: 1,
        phase: "focus",
        remainingMs: 120_000,
        status: "paused",
      });
    await expect.poll(async () => (
      await localStorageJson<{ jobs?: unknown[] }>(page, ALARM_REGISTRY_KEY)
    )?.jobs?.length ?? 0).toBe(0);
    await completion.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(completion).toHaveCount(0);
  } finally {
    await page.evaluate(() => {
      const scopedWindow = window as typeof window & {
        __patterdrawQaNativeDateNow?: () => number;
      };
      if (scopedWindow.__patterdrawQaNativeDateNow) {
        Date.now = scopedWindow.__patterdrawQaNativeDateNow;
        delete scopedWindow.__patterdrawQaNativeDateNow;
      }
    });
  }
});

test("keeps all project events plus device events and round-trips the Calendar archive", async ({ page }) => {
  const dialog = await openWidgetDialog(page, "calendar");
  await dialog.getByLabel("Widget label", { exact: true }).fill("Science schedule");
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  await dialog.getByRole("combobox", { name: "View", exact: true }).selectOption({ label: "Agenda" });
  await dialog.getByRole("switch", { name: "Show weekends", exact: true }).uncheck();
  await dialog.getByRole("switch", { name: "Show week numbers", exact: true }).check();
  await dialog.getByRole("switch", { name: "Compact event layout", exact: true }).check();

  const addEvent = async (
    layer: "device" | "project",
    title: string,
    date: string,
    note: string,
    color: string,
  ) => {
    await dialog.getByRole("combobox", { name: "Save to", exact: true })
      .selectOption({ label: layer === "project" ? "This project" : "This device" });
    await dialog.getByLabel("Date", { exact: true }).fill(date);
    await dialog.getByLabel("Title", { exact: true }).fill(title);
    await dialog.getByLabel("Optional note", { exact: true }).fill(note);
    await setWidgetColor(dialog, "Event colour", color);
    await dialog.getByRole("button", { name: "Add event", exact: true }).click();
  };
  await addEvent(
    "project",
    "Periodic table lab",
    "2026-09-02",
    "Bring the element-card sets.",
    "#2e7d32",
  );
  await addEvent(
    "project",
    "Atomic structure quiz",
    "2026-09-04",
    "Review isotope notation.",
    "#8e24aa",
  );
  await addEvent(
    "device",
    "School professional learning",
    "2026-09-08",
    "PRIVATE_DEVICE_CALENDAR_NOTE",
    "#c62828",
  );
  await expect(dialog.getByRole("switch", { name: "Project events (2)", exact: true })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Device events (1)", exact: true })).toBeChecked();
  await addOpenWidget(page, "calendar");

  const metadata = await waitForOnlyWidget(page, "calendar");
  expect(metadata.calendar).toMatchObject({
    view: "agenda",
    showProjectEvents: true,
    showDeviceEvents: true,
    showWeekends: false,
    showWeekNumbers: true,
    density: "compact",
    projectEventIds: [],
    transferCache: null,
  });
  const project = await autosavedProject(page);
  expect(project?.projectCalendar?.events.map((event) => event.title)).toEqual([
    "Periodic table lab",
    "Atomic structure quiz",
  ]);
  expect(project?.projectCalendar?.events).toMatchObject([
    { color: "#2e7d32", note: "Bring the element-card sets." },
    { color: "#8e24aa", note: "Review isotope notation." },
  ]);
  const deviceRecord = await localStorageJson<{
    store?: { events?: StoredCalendarEvent[] };
  }>(page, DEVICE_CALENDAR_KEY);
  expect(deviceRecord?.store?.events?.map((event) => event.title)).toEqual(["School professional learning"]);
  expect(deviceRecord?.store?.events).toMatchObject([
    { color: "#c62828", note: "PRIVATE_DEVICE_CALENDAR_NOTE" },
  ]);
  const eventTexts = (activeScene(project)?.elements ?? []).filter((element) => {
    const role = widgetChild(element)?.role;
    return typeof role === "string" && role.startsWith("calendar-event-");
  }).map((element) => element.text).filter(Boolean);
  expect(eventTexts.join(" ")).toContain("Periodic table lab");
  expect(eventTexts.join(" ")).toContain("Atomic structure quiz");

  const overlay = page.getByTestId("classroom-time-overlay");
  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  const updateDialog = page.getByRole("dialog", { name: "Customize Class Calendar", exact: true });
  await updateDialog.getByRole("button", { name: "Calendar", exact: true }).click();
  await updateDialog.getByRole("combobox", { name: "Save to", exact: true })
    .selectOption({ label: "This project" });
  await updateDialog.getByLabel("Date", { exact: true }).fill("2026-09-11");
  await updateDialog.getByLabel("Title", { exact: true }).fill("Spectroscopy demo");
  await updateDialog.getByLabel("Optional note", { exact: true }).fill("Set out the emission tubes.");
  await setWidgetColor(updateDialog, "Event colour", "#1565c0");
  await updateDialog.getByRole("button", { name: "Add event", exact: true }).click();
  await updateDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(updateDialog).toHaveCount(0);
  expect(await waitForOnlyWidget(page, "calendar")).toMatchObject({
    calendar: { projectEventIds: [] },
  });
  expect((await autosavedProject(page))?.projectCalendar?.events.map((event) => event.title)).toEqual([
    "Periodic table lab",
    "Atomic structure quiz",
    "Spectroscopy demo",
  ]);
  expect((await autosavedProject(page))?.projectCalendar?.events[2]).toMatchObject({
    color: "#1565c0",
    note: "Set out the emission tubes.",
  });

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const archive = await downloadBytes(await downloadEvent);
  expect(archive.byteLength).toBeGreaterThan(1_000);
  const archivedProjectBytes = unzipSync(new Uint8Array(archive))["project.json"];
  expect(archivedProjectBytes).toBeDefined();
  const archivedProjectJson = strFromU8(archivedProjectBytes);
  expect(archivedProjectJson).toContain("Periodic table lab");
  expect(archivedProjectJson).toContain("Atomic structure quiz");
  expect(archivedProjectJson).toContain("Spectroscopy demo");
  expect(archivedProjectJson).toContain("Bring the element-card sets.");
  expect(archivedProjectJson).toContain("Review isotope notation.");
  expect(archivedProjectJson).toContain("Set out the emission tubes.");
  expect(archivedProjectJson).not.toContain("School professional learning");
  expect(archivedProjectJson).not.toContain("PRIVATE_DEVICE_CALENDAR_NOTE");
  await deleteKeyvalValue(page, AUTOSAVE_KEY);
  await page.evaluate((key) => localStorage.removeItem(key), DEVICE_CALENDAR_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: EDITOR_MOUNT_TIMEOUT });
  await page.getByLabel("Open project file").setInputFiles({
    name: "science-schedule.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: archive,
  });
  expect(await waitForOnlyWidget(page, "calendar")).toMatchObject({
    label: "Science schedule",
    calendar: { projectEventIds: [] },
  });
  const reopenedProjectEvents = (await autosavedProject(page))?.projectCalendar?.events;
  expect(reopenedProjectEvents).toHaveLength(3);
  expect(reopenedProjectEvents).toMatchObject([
    { color: "#2e7d32", note: "Bring the element-card sets." },
    { color: "#8e24aa", note: "Review isotope notation." },
    { color: "#1565c0", note: "Set out the emission tubes." },
  ]);
  const reopenedDeviceRecord = await localStorageJson<{
    store?: { events?: unknown[] };
  }>(page, DEVICE_CALENDAR_KEY);
  expect(reopenedDeviceRecord?.store?.events ?? []).toEqual([]);
});

test("renders a device-only Calendar row in the visual PDF snapshot without archiving its title", async ({ page }) => {
  test.setTimeout(120_000);
  const deviceTitle = "PRIVATE_DEVICE_PDF_EVENT";
  const projectTitle = "PROJECT_PDF_BASELINE_EVENT";
  await page.getByLabel("Open project file").setInputFiles({
    name: "calendar-context.pdf",
    mimeType: "application/pdf",
    buffer: await simplePdfBytes(),
  });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);

  const dialog = await openWidgetDialog(page, "calendar");
  await dialog.getByLabel("Widget label", { exact: true }).fill("PDF context calendar");
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  await dialog.getByRole("combobox", { name: "View", exact: true }).selectOption({ label: "Agenda" });
  await dialog.getByRole("combobox", { name: "Save to", exact: true })
    .selectOption({ label: "This project" });
  await dialog.getByLabel("Date", { exact: true }).fill("2099-01-01");
  await dialog.getByLabel("Title", { exact: true }).fill(projectTitle);
  await dialog.getByRole("button", { name: "Add event", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Save to", exact: true })
    .selectOption({ label: "This device" });
  await dialog.getByLabel("Date", { exact: true }).fill("2099-01-02");
  await dialog.getByLabel("Title", { exact: true }).fill(deviceTitle);
  await dialog.getByRole("button", { name: "Add event", exact: true }).click();
  await addOpenWidget(page, "calendar");
  await expect(page.locator(".pdf-annotation-count")).toHaveText("1");

  let deviceEvents: Array<Record<string, unknown>> = [];
  await expect.poll(async () => {
    const record = await localStorageJson<{
      store?: { events?: Array<Record<string, unknown>> };
    }>(page, DEVICE_CALENDAR_KEY);
    deviceEvents = record?.store?.events ?? [];
    return deviceEvents.map((event) => event.title);
  }).toEqual([deviceTitle]);
  await expect.poll(async () => liveSceneContainsText(page, deviceTitle)).toBe(true);
  expect(JSON.stringify(await autosavedProject(page))).not.toContain(deviceTitle);

  await replaceDeviceCalendarEvents(page, []);
  await expect.poll(async () => liveSceneContainsText(page, deviceTitle)).toBe(false);
  await expect.poll(async () => liveSceneContainsText(page, projectTitle)).toBe(true);
  await installClassroomVisualFallbackFixture(page);
  const baselineBytes = await exportVisualFallbackPdf(page);
  expect((await PDFDocument.load(baselineBytes)).getPageCount()).toBe(1);
  const baseline = await renderedPdfPage(baselineBytes);

  await replaceDeviceCalendarEvents(page, deviceEvents);
  await expect.poll(async () => liveSceneContainsText(page, deviceTitle)).toBe(true);
  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const archive = await downloadBytes(await saveDownload);
  const archivedProjectBytes = unzipSync(new Uint8Array(archive))["project.json"];
  expect(archivedProjectBytes).toBeDefined();
  const archivedProjectJson = strFromU8(archivedProjectBytes);
  expect(archivedProjectJson).toContain(projectTitle);
  expect(archivedProjectJson).not.toContain(deviceTitle);

  const withDeviceBytes = await exportVisualFallbackPdf(page, async () => {
    // The hybrid attempt captured the device layer already. Changing the live
    // store while consent is pending must not drift the visual retry snapshot.
    await replaceDeviceCalendarEvents(page, []);
    await expect.poll(async () => liveSceneContainsText(page, deviceTitle)).toBe(false);
  });
  expect((await PDFDocument.load(withDeviceBytes)).getPageCount()).toBe(1);
  const withDevice = await renderedPdfPage(withDeviceBytes);
  expect(changedPdfPixels(baseline, withDevice)).toBeGreaterThan(75);
  expect(pdfInkPixels(withDevice)).toBeGreaterThan(pdfInkPixels(baseline) + 20);
});

test("rekeys and pauses Dashboard duplicates, paste, and library transfer while preserving calendar events", async ({ context, page }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const dialog = await openWidgetDialog(page, "dashboard");
  await dialog.getByLabel("Widget label", { exact: true }).fill("Lesson dashboard");
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  await dialog.getByLabel("Date", { exact: true }).fill("2026-09-10");
  await dialog.getByLabel("Title", { exact: true }).fill("Element stations");
  await dialog.getByRole("button", { name: "Add event", exact: true }).click();
  await addOpenWidget(page, "dashboard");

  const overlay = page.getByTestId("classroom-time-overlay");
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "dashboard")).timerRuntime?.status).toBe("running");

  await copySelectedElements(page);
  await pasteCopiedElements(page);
  let duplicated = await waitForWidgetCount(page, 2);
  let anchors = liveWidgetAnchors(duplicated);
  expect(new Set(anchors.map(({ metadata }) => metadata.ownerId)).size).toBe(2);
  expect(anchors.filter(({ metadata }) => metadata.timerRuntime?.status === "running")).toHaveLength(1);
  expect(anchors.filter(({ metadata }) => metadata.timerRuntime?.status === "paused")).toHaveLength(1);
  expect(anchors.every(({ metadata }) => metadata.calendar?.transferCache === null)).toBe(true);

  await page.getByRole("button", { name: "More classroom time actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  duplicated = await waitForWidgetCount(page, 3);
  anchors = liveWidgetAnchors(duplicated);
  expect(new Set(anchors.map(({ metadata }) => metadata.ownerId)).size).toBe(3);
  expect(anchors.filter(({ metadata }) => metadata.timerRuntime?.status === "paused")).toHaveLength(2);
  const sourceOwnerIds = new Set(anchors.map(({ metadata }) => metadata.ownerId));

  let { panel, trigger } = await openLibraryPanel(page);
  const pendingItem = panel.locator(".library-unit__active:has(.library-unit__adder)");
  await expect(pendingItem).toHaveCount(1);
  const selectedElementCountAtLibraryAdd = await page.evaluate(() => Object.keys((window as unknown as {
    h?: { app?: { state?: { selectedElementIds?: Record<string, boolean> } } };
  }).h?.app?.state?.selectedElementIds ?? {}).length);
  expect(selectedElementCountAtLibraryAdd).toBe(1);
  expect((await keyvalValue<unknown[]>(page, "patterdraw:library:v1")) ?? []).toHaveLength(0);
  await holdKeyvalWrites(page);
  // Excalidraw layers the card's drag target above its add affordance.
  await pendingItem.locator(".library-unit__adder").click({ force: true });
  await expect(page.getByRole("dialog", { name: "Error", exact: true })).toHaveCount(0);
  const libraryAddedNotice = page.getByRole("status").filter({
    hasText: "Lesson dashboard added to Personal Library.",
  });
  expect(await libraryAddedNotice.count()).toBe(0);
  await expect.poll(() => page.evaluate(() => Object.keys((window as unknown as {
    h?: { app?: { state?: { selectedElementIds?: Record<string, boolean> } } };
  }).h?.app?.state?.selectedElementIds ?? {}).length)).toBe(0);
  await expect(page.getByTestId("classroom-time-overlay")).toHaveCount(0);
  await expect(pendingItem).toHaveCount(0);
  await releaseKeyvalWrites(page);
  let storedLibrary: Array<{ elements: StoredElement[] }> | undefined;
  await expect.poll(async () => {
    storedLibrary = await keyvalValue<Array<{ elements: StoredElement[] }>>(page, "patterdraw:library:v1");
    return storedLibrary?.length ?? 0;
  }).toBe(1);
  await expect(libraryAddedNotice).toBeVisible();
  await expect(libraryAddedNotice).toHaveCSS("pointer-events", "none");
  const storedLibraryElements = storedLibrary?.[0]?.elements ?? [];
  const storedLibraryAnchors = storedLibraryElements.flatMap((element) => {
    const metadata = widgetMetadata(element);
    return metadata ? [{ element, metadata }] : [];
  });
  expect(storedLibraryAnchors).toHaveLength(1);
  expect(storedLibraryElements.length).toBeGreaterThan(2);
  expect(new Set(storedLibraryElements.map((element) => (
    element.customData?.classroomTimeWidget?.ownerId
  )))).toEqual(new Set([storedLibraryAnchors[0].metadata.ownerId]));
  expect(storedLibraryAnchors[0].metadata.calendar?.transferCache).not.toBeNull();
  if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: EDITOR_MOUNT_TIMEOUT });
  await waitForWidgetCount(page, 3);
  await expect.poll(async () => (
    await keyvalValue<unknown[]>(page, "patterdraw:library:v1")
  )?.length ?? 0).toBe(1);
  ({ panel, trigger } = await openLibraryPanel(page));
  await expect(panel.locator(".library-unit__active:not(:has(.library-unit__adder))")).toHaveCount(1);
  if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
  await copySelectedElements(page);

  await page.getByLabel("Open project file").setInputFiles({
    name: "fresh-destination.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Fresh destination",
      elements: [],
      appState: {},
      files: {},
    })),
  });
  await expect.poll(async () => liveWidgetAnchors(await autosavedProject(page)).length).toBe(0);
  await pasteCopiedElements(page);
  let destination = await waitForWidgetCount(page, 1);
  let inserted = liveWidgetAnchors(destination)[0].metadata;
  expect(sourceOwnerIds.has(inserted.ownerId)).toBe(false);
  const pastedOwnerId = inserted.ownerId;
  expect(inserted.timerRuntime?.status).toBe("paused");
  expect(inserted.calendar?.transferCache).toBeNull();
  expect(inserted.calendar?.projectEventIds).toHaveLength(1);
  expect(destination.projectCalendar?.events.map((event) => event.title)).toEqual(["Element stations"]);

  await page.getByRole("button", { name: "More classroom time actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete widget", exact: true }).click();
  await waitForWidgetCount(page, 0);
  ({ panel } = await openLibraryPanel(page));
  const storedItem = panel.locator(".library-unit__active:not(:has(.library-unit__adder))").first();
  await expect(storedItem).toBeVisible();
  // The same library drag target is the intentional insertion affordance.
  await storedItem.locator(".library-unit__dragger").click({ force: true });
  destination = await waitForWidgetCount(page, 1);
  const insertedAnchor = liveWidgetAnchors(destination)[0];
  inserted = insertedAnchor.metadata;
  expect(sourceOwnerIds.has(inserted.ownerId)).toBe(false);
  expect(inserted.ownerId).not.toBe(pastedOwnerId);
  expect(inserted.timerRuntime?.status).toBe("paused");
  expect(inserted.calendar?.transferCache).toBeNull();
  expect(inserted.calendar?.projectEventIds).toHaveLength(1);
  expect(destination.projectCalendar?.events.map((event) => event.title)).toEqual(["Element stations"]);
  expect(insertedAnchor.element.fileId).toEqual(expect.any(String));
  const persistedShell = activeScene(destination)?.files[insertedAnchor.element.fileId ?? ""] as {
    dataURL?: string;
    mimeType?: string;
  } | undefined;
  expect(persistedShell).toMatchObject({ mimeType: "image/svg+xml" });
  expect(persistedShell?.dataURL?.startsWith("data:image/svg+xml")).toBe(true);
  await expect.poll(() => liveWidgetShellFile(page, inserted.ownerId)).toEqual({
    dataURLIsSvg: true,
    fileId: insertedAnchor.element.fileId,
    mimeType: "image/svg+xml",
  });

  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible({ timeout: 30_000 });
  const beforeLibraryTick = await autosavedProject(page);
  const beforeLibraryTickRevision = await keyvalValue<{ revision?: string }>(page, AUTOSAVE_REVISION_KEY);
  const beforeLibraryTickFileIds = Object.keys(activeScene(beforeLibraryTick)?.files ?? {}).sort();
  await page.waitForTimeout(1_500);
  const afterLibraryTick = await autosavedProject(page);
  const afterLibraryTickRevision = await keyvalValue<{ revision?: string }>(page, AUTOSAVE_REVISION_KEY);
  expect(afterLibraryTick?.updatedAt).toBe(beforeLibraryTick?.updatedAt);
  expect(afterLibraryTickRevision?.revision).toBe(beforeLibraryTickRevision?.revision);
  expect(Object.keys(activeScene(afterLibraryTick)?.files ?? {}).sort()).toEqual(beforeLibraryTickFileIds);

  ({ panel } = await openLibraryPanel(page));
  const draggableStoredItem = panel.locator(".library-unit__active:not(:has(.library-unit__adder))").first();
  await expect(draggableStoredItem).toBeVisible();
  await draggableStoredItem.locator(".library-unit__dragger").dragTo(
    page.locator("canvas.excalidraw__canvas.interactive"),
    { targetPosition: { x: 520, y: 420 } },
  );
  const afterDrag = await waitForWidgetCount(page, 2);
  const draggedAnchor = liveWidgetAnchors(afterDrag).find(({ metadata }) => metadata.ownerId !== inserted.ownerId);
  expect(draggedAnchor).toBeDefined();
  expect(draggedAnchor?.metadata.timerRuntime?.status).toBe("paused");
  await expect.poll(async () => (
    await keyvalValue<unknown[]>(page, "patterdraw:library:v1")
  )?.length ?? 0).toBe(1);
  if (!draggedAnchor) throw new Error("The dragged Personal Library Dashboard was not autosaved.");
  await expect.poll(() => liveWidgetShellFile(page, draggedAnchor.metadata.ownerId)).toEqual({
    dataURLIsSvg: true,
    fileId: draggedAnchor.element.fileId,
    mimeType: "image/svg+xml",
  });
});

test("durably cancels a running Timer on delete, restores it paused with native Undo, and converts it", async ({ page }) => {
  await openWidgetDialog(page, "timer");
  await addOpenWidget(page, "timer");
  const overlay = page.getByTestId("classroom-time-overlay");
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  await expect.poll(async () => (
    await localStorageJson<{ jobs?: unknown[] }>(page, ALARM_REGISTRY_KEY)
  )?.jobs?.length ?? 0).toBe(1);
  const before = await waitForWidgetCount(page, 1);
  const beforeLiveCount = activeScene(before)?.elements.filter((element) => !element.isDeleted).length ?? 0;
  expect(beforeLiveCount).toBeGreaterThan(2);

  await page.getByRole("button", { name: "More classroom time actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete widget", exact: true }).click();
  await waitForWidgetCount(page, 0);
  await expect.poll(async () => {
    const registry = await localStorageJson<{
      cancellationTombstones?: Array<{ target?: string }>;
      jobs?: unknown[];
    }>(page, ALARM_REGISTRY_KEY);
    return {
      jobs: registry?.jobs?.length ?? 0,
      targets: (registry?.cancellationTombstones ?? [])
        .map(({ target }) => target)
        .sort(),
    };
  }).toEqual({ jobs: 0, targets: ["pomodoro", "timer"] });
  await page.locator('.statusbar [aria-label="Undo"]').click();
  await waitForWidgetCount(page, 1);
  await expect(page.getByTestId("classroom-time-overlay")).toBeVisible();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("paused");
  expect((await localStorageJson<{ jobs?: unknown[] }>(page, ALARM_REGISTRY_KEY))?.jobs ?? []).toEqual([]);

  await page.getByRole("button", { name: "More classroom time actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Convert to ordinary elements", exact: true }).click();
  const converted = await waitForWidgetCount(page, 0);
  const convertedElements = activeScene(converted)?.elements.filter((element) => !element.isDeleted) ?? [];
  expect(convertedElements.length).toBe(beforeLiveCount);
  expect(convertedElements.every((element) => element.customData?.classroomTimeWidget === undefined)).toBe(true);
  await expect(page.getByTestId("classroom-time-overlay")).toHaveCount(0);
});

test("keeps overlapping PDF Undo and alarm controls actionable, restores the exact running Timer, and exports one annotation", async ({ page }) => {
  test.setTimeout(120_000);
  await page.getByLabel("Open project file").setInputFiles({
    name: "classroom-timer.pdf",
    mimeType: "application/pdf",
    buffer: await simplePdfBytes(),
  });
  const pageItem = page.locator("#pdf-page-rail .pdf-page-item");
  await expect(pageItem).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/);

  const dialog = await openWidgetDialog(page, "timer");
  await dialog.getByLabel("Widget label", { exact: true }).fill("PDF timer");
  await dialog.getByRole("button", { name: "Timer", exact: true }).click();
  await dialog.getByLabel("Timer hours", { exact: true }).fill("0");
  await dialog.getByLabel("Timer minutes", { exact: true }).fill("0");
  await dialog.getByLabel("Timer seconds", { exact: true }).fill("30");
  await addOpenWidget(page, "timer");
  const overlay = page.getByTestId("classroom-time-overlay");
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  await expect.poll(async () => (
    await localStorageJson<{ jobs?: unknown[] }>(page, ALARM_REGISTRY_KEY)
  )?.jobs?.length ?? 0).toBe(1);
  await expect(overlay.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(pageItem.locator(".pdf-annotation-count")).toHaveText("1");
  const withWidget = await waitForWidgetCount(page, 1);
  expect(liveWidgetAnchors(withWidget)).toHaveLength(1);
  expect(activeScene(withWidget)?.elements.filter((element) => (
    !element.isDeleted && widgetChild(element)
  )).length).toBeGreaterThan(2);
  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  const shortTimerDialog = page.getByRole("dialog", { name: "Customize Timer", exact: true });
  await shortTimerDialog.getByRole("button", { name: "Timer", exact: true }).click();
  await shortTimerDialog.getByLabel("Timer hours", { exact: true }).fill("0");
  await shortTimerDialog.getByLabel("Timer minutes", { exact: true }).fill("0");
  await shortTimerDialog.getByLabel("Timer seconds", { exact: true }).fill("4");
  await shortTimerDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime)
    .toMatchObject({ status: "idle", remainingMs: 4_000 });
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  await setAudioResumeBlocked(page, true);
  const alarmNotice = page.getByRole("alert").filter({ hasText: "Time is up" });
  await expect(alarmNotice).toBeVisible({ timeout: 12_000 });
  await expect(alarmNotice).toContainText("PDF timer");
  await expect(alarmNotice.getByRole("button", { name: "Enable sound", exact: true })).toBeVisible();
  await expect(alarmNotice.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();

  const clear = await openPdfClearDialog(page, 1);
  await expect(clear.locator("#pdf-clear-annotations-page-summary"))
    .toHaveText("1 annotation on 1 affected page");
  await clear.getByRole("button", { name: "Clear 1 annotation", exact: true }).click();
  await expect(pageItem.locator(".pdf-annotation-count")).toHaveCount(0);
  const pdfUndoNotice = page.getByRole("status").filter({ hasText: "Cleared 1 annotation from 1 page" });
  await expect(pdfUndoNotice).toBeVisible();
  await expect(alarmNotice).toBeVisible();
  await pdfUndoNotice.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(pageItem.locator(".pdf-annotation-count")).toHaveText("1");
  await expect.poll(async () => liveWidgetAnchors(await autosavedProject(page)).length).toBe(1);

  await setAudioResumeBlocked(page, false);
  await alarmNotice.getByRole("button", { name: "Enable sound", exact: true }).click();
  await expect(alarmNotice).toBeVisible();
  await alarmNotice.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(alarmNotice).toHaveCount(0);

  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  const updateDialog = page.getByRole("dialog", { name: "Customize Timer", exact: true });
  await updateDialog.getByRole("button", { name: "Timer", exact: true }).click();
  await updateDialog.getByLabel("Timer hours", { exact: true }).fill("0");
  await updateDialog.getByLabel("Timer minutes", { exact: true }).fill("1");
  await updateDialog.getByLabel("Timer seconds", { exact: true }).fill("0");
  await updateDialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime)
    .toMatchObject({ status: "idle", remainingMs: 60_000 });
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  const runningBeforeClear = await waitForOnlyWidget(page, "timer");
  expect(runningBeforeClear.runtime?.status).toBe("running");
  const runningDeadlineMs = runningBeforeClear.runtime?.deadlineMs;
  expect(runningDeadlineMs).toEqual(expect.any(Number));
  let originalJob: (Record<string, unknown> & { deadlineMs?: number; id?: string }) | undefined;
  await expect.poll(async () => {
    const registry = await localStorageJson<{
      jobs?: Array<{ deadlineMs?: number; id?: string }>;
    }>(page, ALARM_REGISTRY_KEY);
    originalJob = registry?.jobs?.[0];
    return registry?.jobs?.length ?? 0;
  }).toBe(1);
  if (!originalJob) throw new Error("The running Timer alarm job was not persisted.");
  const exactOriginalJob = originalJob;
  expect(originalJob).toMatchObject({ deadlineMs: runningDeadlineMs });

  const clearRunning = await openPdfClearDialog(page, 1);
  await clearRunning.getByRole("button", { name: "Clear 1 annotation", exact: true }).click();
  await expect(pageItem.locator(".pdf-annotation-count")).toHaveCount(0);
  await expect.poll(async () => {
    const registry = await localStorageJson<{
      cancellationTombstones?: unknown[];
      jobs?: unknown[];
    }>(page, ALARM_REGISTRY_KEY);
    return {
      hasCancellation: (registry?.cancellationTombstones?.length ?? 0) > 0,
      jobs: registry?.jobs?.length ?? 0,
    };
  }).toEqual({ hasCancellation: true, jobs: 0 });
  const runningUndoNotice = page.getByRole("status").filter({ hasText: "Cleared 1 annotation from 1 page" });
  await runningUndoNotice.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(pageItem.locator(".pdf-annotation-count")).toHaveText("1");
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime)
    .toMatchObject({ status: "running", deadlineMs: runningDeadlineMs });
  await expect.poll(async () => {
    const registry = await localStorageJson<{
      jobs?: Array<{ deadlineMs?: number; id?: string }>;
    }>(page, ALARM_REGISTRY_KEY);
    return registry?.jobs ?? [];
  }).toEqual([exactOriginalJob]);

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exportedBytes = await downloadBytes(await downloadEvent);
  const exported = await PDFDocument.load(exportedBytes);
  expect(exported.getPageCount()).toBe(1);
  expect(exported.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  expect(await renderedPdfInkPixels(exportedBytes)).toBeGreaterThan(500);
});

test("keeps widgets live while Presentation and OBS hide editing controls", async ({ page }) => {
  test.setTimeout(75_000);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator("#slide-rail .slide-thumbnail")).toHaveCount(1);
  const timerDialog = await openWidgetDialog(page, "timer");
  await setWidgetColor(timerDialog, "Background", "#ff00ff");
  await timerDialog.getByRole("button", { name: "Timer", exact: true }).click();
  await timerDialog.getByLabel("Timer hours", { exact: true }).fill("0");
  await timerDialog.getByLabel("Timer minutes", { exact: true }).fill("0");
  await timerDialog.getByLabel("Timer seconds", { exact: true }).fill("60");
  await addOpenWidget(page, "timer");
  const overlay = page.getByTestId("classroom-time-overlay");
  await overlay.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.status).toBe("running");
  const deadline = (await waitForOnlyWidget(page, "timer")).runtime?.deadlineMs;
  const beforePresentationTick = await liveWidgetRoleText(page, "primary-value");
  expect(beforePresentationTick).not.toBeNull();

  await page.getByRole("button", { name: "Present", exact: true }).click();
  await expect(page.locator(".presentation-controls")).toBeVisible();
  await expect(overlay).toHaveCount(0);
  await expect(page.locator("canvas.excalidraw__canvas.interactive")).toBeVisible();
  await expect.poll(() => visibleMagentaCanvasPixels(page), { timeout: 15_000 }).toBeGreaterThan(500);
  await expect.poll(() => liveWidgetRoleText(page, "primary-value")).not.toBe(beforePresentationTick);
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.deadlineMs).toBe(deadline);
  await page.keyboard.press("Escape");
  await expect(page.locator(".presentation-controls")).toHaveCount(0);
  await expect.poll(() => visibleMagentaCanvasPixels(page), { timeout: 15_000 }).toBeGreaterThan(500);
  const beforeObsTick = await liveWidgetRoleText(page, "primary-value");
  expect(beforeObsTick).not.toBeNull();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("switch", { name: "OBS capture area", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("obs-capture-guide")).toBeVisible();
  await expect(overlay).toHaveCount(0);
  await expect(page.locator("canvas.excalidraw__canvas.interactive")).toBeVisible();
  await expect.poll(() => visibleMagentaCanvasPixels(page), { timeout: 15_000 }).toBeGreaterThan(500);
  await expect.poll(() => liveWidgetRoleText(page, "primary-value")).not.toBe(beforeObsTick);
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.deadlineMs).toBe(deadline);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("switch", { name: "OBS capture area", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("obs-capture-guide")).toHaveCount(0);
  await expect.poll(() => visibleMagentaCanvasPixels(page), { timeout: 15_000 }).toBeGreaterThan(500);
  await expect.poll(async () => (await waitForOnlyWidget(page, "timer")).runtime?.deadlineMs).toBe(deadline);
});

test("fits the Classroom cards and inspector at desktop, tablet, and phone widths", async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const tools = await openClassroomTools(page);
    const bounds = await tools.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    expect(await tools.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const kind of ["clock", "timer", "pomodoro", "calendar", "dashboard"] as const) {
      await expect(tools.getByTestId(WIDGET_CARD_IDS[kind])).toBeVisible();
    }

    await tools.getByTestId(WIDGET_CARD_IDS.dashboard).click();
    const inspector = page.getByRole("dialog", { name: "Add Classroom Dashboard", exact: true });
    const inspectorBounds = await inspector.boundingBox();
    expect(inspectorBounds).not.toBeNull();
    expect(inspectorBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(inspectorBounds?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((inspectorBounds?.x ?? 0) + (inspectorBounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    expect((inspectorBounds?.y ?? 0) + (inspectorBounds?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
    expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await inspector.getByRole("button", { name: "Close classroom time settings", exact: true }).click();
  }
});
