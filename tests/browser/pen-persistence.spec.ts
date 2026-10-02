import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";

interface Ink {
  id: string;
  type: string;
  isDeleted: boolean;
  points: number[][];
  pressures: number[];
  simulatePressure: boolean;
}
interface InkProject {
  activeSceneId: string;
  scenes: Record<string, { elements: Ink[] }>;
}

async function savedInk(page: Page): Promise<Ink[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const project = await new Promise<InkProject | undefined>((resolve, reject) => {
        const request = database.transaction("keyval").objectStore("keyval")
          .get("patterdraw:autosave:project:v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return project?.scenes[project.activeSceneId].elements
        .filter(element => element.type === "freedraw" && !element.isDeleted) ?? [];
    } finally {
      database.close();
    }
  });
}

async function ready(page: Page) {
  await page.goto("./");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0);
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByTestId("toolbar-freedraw").check({ force: true });
}

test("defers active pen serialization and preserves pressure through undo, zoom and project round trip", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Pressure injection uses Chromium's native pointer API.");
  await ready(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", pointerType: "pen", x: 350, y: 400,
    button: "left", buttons: 1, clickCount: 1, force: 0.2,
  });
  for (let index = 1; index <= 20; index++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", pointerType: "pen", x: 350 + index * 5,
      y: 400 + Math.sin(index / 5) * 15, buttons: 1, force: 0.2 + index / 100,
    });
  }
  // Give both the debounce and any earlier save completion time to run while
  // the native stroke is still active. Neither may serialize partial new ink.
  await page.waitForTimeout(700);
  expect(await savedInk(page)).toHaveLength(0);
  await expect(page.getByText("Saving locally", { exact: true })).toBeVisible();
  for (let index = 21; index <= 60; index++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", pointerType: "pen", x: 350 + index * 5,
      y: 400 + Math.sin(index / 5) * 15, buttons: 1, force: 0.2 + index / 100,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", pointerType: "pen", x: 650,
    y: 400 + Math.sin(12) * 15, button: "left", buttons: 0, clickCount: 1,
  });
  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  const [stroke] = await savedInk(page);
  expect(stroke.points.length).toBeGreaterThanOrEqual(60);
  expect(stroke.pressures).toHaveLength(stroke.points.length);
  expect(stroke.simulatePressure).toBe(false);
  expect(Math.max(...stroke.pressures)).toBeGreaterThan(0.7);
  expect(Math.min(...stroke.pressures)).toBeLessThan(0.3);
  const content = (ink: Ink) => ({ points: ink.points, pressures: ink.pressures, simulatePressure: ink.simulatePressure });

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedInk(page)).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  expect(content((await savedInk(page))[0])).toEqual(content(stroke));
  await page.getByTestId("toolbar-selection").check({ force: true });
  await page.mouse.click(650, 400 + Math.sin(12) * 15);
  await page.keyboard.press("Backspace");
  await expect.poll(async () => (await savedInk(page)).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  expect(content((await savedInk(page))[0])).toEqual(content(stroke));
  await page.locator(".footer-zoom-controls").getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(content((await savedInk(page))[0])).toEqual(content(stroke));

  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.patterdraw$/);
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error("Project download has no local bytes.");
  const bytes = await readFile(downloadedPath);
  const project = JSON.parse(strFromU8(unzipSync(bytes)["project.json"])) as InkProject;
  const archivedInk = project.scenes[project.activeSceneId].elements.find(element => element.type === "freedraw");
  expect(archivedInk && content(archivedInk)).toEqual(content(stroke));
  await page.getByLabel("Open project file").setInputFiles({
    name: "pen-round-trip.patterdraw", mimeType: "application/vnd.patterdraw+zip", buffer: bytes,
  });
  const confirmation = page.getByRole("dialog", { name: "Open another project?", exact: true });
  if (await confirmation.isVisible()) {
    await confirmation.getByRole("button", { name: "Open without downloading", exact: true }).click();
  }
  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  await page.reload();
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
  expect(content((await savedInk(page))[0])).toEqual(content(stroke));
});

test("captures active freehand ink when the page becomes hidden", async ({ page }) => {
  await ready(page);
  await page.mouse.move(350, 400);
  await page.mouse.down();
  await page.mouse.move(550, 430, { steps: 20 });
  await page.waitForTimeout(700);
  expect(await savedInk(page)).toHaveLength(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  expect((await savedInk(page))[0].points.length).toBeGreaterThanOrEqual(20);
  await page.mouse.up();
});

for (const loseCapture of [false, true]) {
  test(`retains a fast complete pen circle during a pause at zoom and through undo and reload${loseCapture ? " after capture loss" : ""}`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Rapid input uses Chromium's native pointer API.");
    await ready(page);
    await page.locator(".footer-zoom-controls").getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByTestId("toolbar-freedraw").check({ force: true });
    const cdp = await page.context().newCDPSession(page);
    if (loseCapture) await page.evaluate(() => {
      const state = window as Window & { __penPointerId?: number; __penCaptureLosses?: number };
      state.__penCaptureLosses = 0;
      window.addEventListener("pointerdown", event => {
        state.__penPointerId = event.pointerId;
      }, { once: true });
      window.addEventListener("lostpointercapture", event => {
        if (event.isTrusted && event.pointerId === state.__penPointerId) state.__penCaptureLosses! += 1;
      });
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", pointerType: "pen", x: 895, y: 450,
      button: "left", buttons: 1, clickCount: 1, force: 0.2,
    });
    if (loseCapture) {
      // Process native capture first; otherwise releasing pending capture can
      // suppress the very lostpointercapture event this regression must cover.
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", pointerType: "pen", x: 895, y: 450, buttons: 1, force: 0.2,
      });
      await page.evaluate(() => {
        const id = (window as Window & { __penPointerId?: number }).__penPointerId;
        if (id === undefined) throw new Error("Native pen pointerdown was not observed.");
        const canvas = document.querySelector<HTMLCanvasElement>(".excalidraw__canvas.interactive")!;
        if (!canvas.hasPointerCapture(id)) throw new Error("Native pen capture was not held.");
        canvas.releasePointerCapture(id);
      });
    }
    const sends: Promise<unknown>[] = [];
    for (let index = 1; index <= 120; index++) {
      const angle = index / 120 * Math.PI * 2;
      if (index === 60) sends.push(cdp.send("Runtime.evaluate", {
        expression: "{ const end = performance.now() + 350; while (performance.now() < end) {} }",
      }));
      sends.push(cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", pointerType: "pen",
        x: 800 + 95 * Math.cos(angle), y: 450 + 95 * Math.sin(angle),
        buttons: 1, force: 0.2 + 0.6 * index / 120,
      }));
      // Input arrives while the main thread is busy; don't serialize this test
      // by waiting for the drawing to acknowledge every individual move.
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await Promise.all(sends);
    if (loseCapture) {
      expect(await page.evaluate(() => (window as Window & { __penCaptureLosses?: number }).__penCaptureLosses)).toBe(1);
      await page.waitForTimeout(700);
      expect(await savedInk(page)).toHaveLength(0);
      await expect(page.getByText("Saving locally", { exact: true })).toBeVisible();
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", pointerType: "pen", x: 895, y: 450,
      button: "left", buttons: 0, clickCount: 1,
    });
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    const [circle] = await savedInk(page);
    // Native finalization may contribute an extra point. Verify every injected
    // move and its pressure in order, rather than relying on a fixed total or
    // closed endpoints that could hide an arc joined by a chord.
    expect(circle.points.length).toBeGreaterThanOrEqual(122);
    expect(circle.pressures).toHaveLength(circle.points.length);
    expect(circle.points.at(-1)).toEqual(circle.points[0]);
    const radius = (Math.max(...circle.points.map(p => p[0])) - Math.min(...circle.points.map(p => p[0]))) / 2;
    let cursor = 1;
    for (let index = 1; index <= 120; index++) {
      const angle = index / 120 * Math.PI * 2;
      const expected = [radius * (Math.cos(angle) - 1), radius * Math.sin(angle)];
      const pressure = 0.2 + 0.6 * index / 120;
      while (cursor < circle.points.length && (
        Math.hypot(circle.points[cursor][0] - expected[0], circle.points[cursor][1] - expected[1]) > 0.002
        || Math.abs(circle.pressures[cursor] - pressure) > 0.001
      )) cursor += 1;
      expect(cursor, `Measured move ${index} and its pressure must survive in order`).toBeLessThan(circle.points.length);
      cursor += 1;
    }
    expect(circle.points.some(p => p[1] < -radius * 0.95)).toBe(true);
    expect(circle.points.some(p => p[1] > radius * 0.95)).toBe(true);
    expect(Math.max(...circle.pressures)).toBeGreaterThan(0.79);

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await savedInk(page)).length).toBe(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await savedInk(page)).length).toBe(1);
    expect((await savedInk(page))[0].points).toEqual(circle.points);
    expect((await savedInk(page))[0].pressures).toEqual(circle.pressures);
    await page.reload();
    await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
    expect((await savedInk(page))[0].points).toEqual(circle.points);
    expect((await savedInk(page))[0].pressures).toEqual(circle.pressures);
  });
}

test.describe("cancelled native ink", () => {
  test.use({ hasTouch: true });

  async function touchStroke(page: Page, moves: number, end: "touchCancel" | "touchEnd", y = 400) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ id: 1, x: 350, y, force: 0.6 }],
    });
    for (let index = 1; index <= moves; index++) await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ id: 1, x: 350 + index * 10, y: y + index * 2, force: 0.6 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: end, touchPoints: [] });
    await cdp.detach();
  }

  for (const moves of [0, 30]) {
    test(`saves trusted touch cancellation without another interaction (${moves} moves)`, async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "Trusted touch cancellation uses Chromium's native input API.");
      await ready(page);
      await touchStroke(page, moves, "touchCancel");
      await expect.poll(async () => (await savedInk(page)).length).toBe(1);
      await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
      const [cancelled] = await savedInk(page);
      expect(cancelled.points).toHaveLength(moves + 1);
      expect(cancelled.pressures).toHaveLength(cancelled.points.length);
      await page.reload();
      await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
      expect((await savedInk(page))[0].points).toEqual(cancelled.points);
      expect((await savedInk(page))[0].pressures).toEqual(cancelled.pressures);
    });
  }

  test("saves cancellation behind an older blocked autosave", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Trusted touch cancellation uses Chromium's native input API.");
    await ready(page);
    // Hold the real autosave Web Lock. The first finished stroke then waits
    // inside the existing save pipeline while the second one is cancelled.
    await page.evaluate(async () => {
      const state = window as Window & { __releaseInkAutosave?: () => void };
      await new Promise<void>(resolve => {
        void navigator.locks.request("patterdraw:autosave:mutation:v1", () => new Promise<void>(release => {
          state.__releaseInkAutosave = release;
          resolve();
        }));
      });
    });
    await touchStroke(page, 15, "touchEnd", 350);
    await expect.poll(() => page.evaluate(async () => (
      (await navigator.locks.query()).pending?.filter(lock => lock.name === "patterdraw:autosave:mutation:v1").length
    ))).toBe(1);
    await touchStroke(page, 30, "touchCancel", 500);
    expect(await savedInk(page)).toHaveLength(0);
    await page.evaluate(() => {
      (window as Window & { __releaseInkAutosave?: () => void }).__releaseInkAutosave?.();
    });
    await expect.poll(async () => (await savedInk(page)).length).toBe(2);
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    const strokes = await savedInk(page);
    expect(strokes[1].points).toHaveLength(31);
    await page.reload();
    await expect(page.locator(".editor-host .excalidraw")).toBeVisible();
    expect(await savedInk(page)).toEqual(strokes);
  });

  test("keeps the next stroke deferred and its history separate after native cancellation cleanup", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Trusted touch cancellation uses Chromium's native input API.");
    await ready(page);
    await touchStroke(page, 30, "touchCancel");
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    const [cancelled] = await savedInk(page);
    // Pinned Excalidraw consumes the first touch after cancellation while
    // finalizing the prior stroke, adding its endpoint at this touch origin.
    // The unchanged baseline does the same; keep this native behavior explicit.
    await touchStroke(page, 0, "touchEnd", 550);
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    expect(await savedInk(page)).toHaveLength(1);
    expect((await savedInk(page))[0].points.slice(0, cancelled.points.length)).toEqual(cancelled.points);
    expect((await savedInk(page))[0].pressures.slice(0, cancelled.pressures.length)).toEqual(cancelled.pressures);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ id: 2, x: 350, y: 650, force: 0.7 }],
    });
    for (let index = 1; index <= 20; index++) await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ id: 2, x: 350 + index * 10, y: 650 + index, force: 0.7 }],
    });
    await page.waitForTimeout(700);
    expect(await savedInk(page)).toHaveLength(1);
    await expect(page.getByText("Saving locally", { exact: true })).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    const strokes = await savedInk(page);
    expect(strokes).toHaveLength(2);
    expect(strokes[0].id).toBe(cancelled.id);
    // Native missing-pointerup cleanup may add its own final point. All
    // cancelled samples must remain intact, independently of the next stroke.
    expect(strokes[0].points.slice(0, cancelled.points.length)).toEqual(cancelled.points);
    expect(strokes[1].points).toHaveLength(22);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await savedInk(page)).length).toBe(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await savedInk(page)).length).toBe(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await savedInk(page)).length).toBe(1);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await savedInk(page)).length).toBe(2);
    const content = (items: Ink[]) => items.map(({ id, points, pressures }) => ({ id, points, pressures }));
    expect(content(await savedInk(page))).toEqual(content(strokes));
  });
});
