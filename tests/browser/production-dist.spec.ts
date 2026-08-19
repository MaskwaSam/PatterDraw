import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";

const productionPort = Number(process.env.PW_PRODUCTION_PORT || 4174);
const productionOrigin = `http://127.0.0.1:${productionPort}`;
const productionRoute = "/classroom/math/unit-01/patterdraw/";
const PRODUCTION_EDITOR_MOUNT_TIMEOUT = 90_000;
const productionServerScript = fileURLToPath(new URL("../../scripts/serve-production-dist.mjs", import.meta.url));

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a production fixture port.");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function startProductionFixture(dist: string): Promise<{
  origin: string;
  stop: () => Promise<void>;
}> {
  const port = await availableLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    productionServerScript,
    "--dist",
    dist,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk: Buffer | string) => { output += String(chunk); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  };
  try {
    const readyDeadline = Date.now() + 15_000;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null) throw new Error(output || `Fixture server exited with ${child.exitCode}.`);
      try {
        const response = await fetch(`${origin}${productionRoute}`);
        if (response.ok) return { origin, stop };
      } catch {
        // The child has not bound its loopback listener yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Fixture server did not become ready. ${output}`.trim());
  } catch (error) {
    await stop();
    throw error;
  }
}

function sameOriginRequests(page: import("@playwright/test").Page, requests: string[]) {
  const origin = new URL(page.url()).origin;
  return requests.filter((requestUrl) => new URL(requestUrl).origin === origin);
}

function expectSecurityHeaders(headers: Record<string, string>) {
  expect(headers["content-security-policy"]).toContain("default-src 'self' blob: data:");
  expect(headers["content-security-policy"]).toContain("worker-src 'self' blob:");
  expect(headers["content-security-policy"]).toContain("connect-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["permissions-policy"]).toContain("microphone=()");
  expect(headers["x-frame-options"]).toBe("DENY");
  // The harness is deliberately plain HTTP on localhost; emitting HSTS here
  // would pin an origin that is not serving TLS and can break local reruns.
  expect(headers["strict-transport-security"]).toBeUndefined();
}

async function settleBrowserProblems(page: import("@playwright/test").Page) {
  // Worker/bootstrap failures can arrive a few turns after the first visible
  // editor paint. Keep this delay bounded but long enough to catch those late
  // errors before asserting the diagnostics.
  await page.waitForTimeout(300);
}

async function tinyPdfBytes(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  return Buffer.from(await document.save());
}

async function downloadBytes(download: import("@playwright/test").Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright download stream was unavailable.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function captureBrowserProblems(page: import("@playwright/test").Page) {
  const requests: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const unhandledRejections: string[] = [];
  const unhandledPrefix = "[patterdraw-production-runtime:unhandledrejection] ";
  page.on("request", (request) => requests.push(request.url()));
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} (${request.failure()?.errorText || "unknown"})`));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "debug" && message.text().startsWith(unhandledPrefix)) {
      unhandledRejections.push(message.text().slice(unhandledPrefix.length));
    }
  });
  await page.addInitScript((prefix) => {
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      if (
        reason
        && typeof reason === "object"
        && "name" in reason
        && (reason as { name?: unknown }).name === "AbortError"
      ) return;
      const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
      console.debug(prefix + detail);
    });
  }, unhandledPrefix);
  return {
    badResponses,
    consoleErrors,
    failedRequests,
    pageErrors,
    requests,
    unhandledRejections,
  };
}

test("redirects the nested route without silently changing the requested path", async ({ request }) => {
  const response = await request.get(
    `${productionOrigin}${productionRoute.slice(0, -1)}?source=smoke`,
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(308);
  expectSecurityHeaders(response.headers());
  expect(response.headers().location).toBe(`${productionRoute}?source=smoke`);
  expect(await response.body()).toHaveLength(0);
});

test("applies offline security headers without pinning plain localhost to HSTS", async ({ request }) => {
  const entry = await request.get(`${productionOrigin}${productionRoute}`);
  expect(entry.status()).toBe(200);
  expectSecurityHeaders(entry.headers());

  const missing = await request.get(`${productionOrigin}${productionRoute}assets/missing-security-probe.js`);
  expect(missing.status()).toBe(404);
  expectSecurityHeaders(missing.headers());
});

test("returns 404 for an unknown static asset instead of the application HTML", async ({ request }) => {
  const response = await request.get(`${productionOrigin}${productionRoute}assets/does-not-exist.js`);
  expect(response.status()).toBe(404);
  expectSecurityHeaders(response.headers());
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(await response.text()).toBe("Not found");
});

test("serves a bodyless HEAD response for the nested production entry point", async ({ request }) => {
  const getResponse = await request.get(`${productionOrigin}${productionRoute}`);
  const headResponse = await request.head(`${productionOrigin}${productionRoute}`);
  expect(getResponse.status()).toBe(200);
  expect(headResponse.status()).toBe(200);
  expectSecurityHeaders(getResponse.headers());
  expectSecurityHeaders(headResponse.headers());
  expect(headResponse.headers()["x-patterdraw-production-dist"]).toBe("1");
  expect(await headResponse.body()).toHaveLength(0);
});

test("allows only GET and HEAD for static production resources", async ({ request }) => {
  const response = await request.post(`${productionOrigin}${productionRoute}`);
  expect(response.status()).toBe(405);
  expect(response.headers().allow).toBe("GET, HEAD");
  expectSecurityHeaders(response.headers());
  expect(await response.text()).toBe("Method not allowed");
});

test("fails closed for encoded traversal and malformed asset paths", async ({ request }) => {
  const paths = [
    `${productionRoute}%2e%2e/index.html`,
    `${productionRoute}assets/%2e%2e/%2e%2e/package.json`,
    `${productionRoute}missing%2Ejs`,
    `${productionRoute}missing%2Ecss`,
    `${productionRoute}missing%2Ewoff2`,
    `${productionRoute}assets/%ZZ.js`,
    `/%2e%2e/package.json`,
  ];
  for (const path of paths) {
    const response = await request.get(`${productionOrigin}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
    expectSecurityHeaders(response.headers());
  }

  // A malformed request must be isolated to that response; the production
  // server should still serve the entry point immediately afterward.
  const healthyResponse = await request.get(`${productionOrigin}${productionRoute}`);
  expect(healthyResponse.status()).toBe(200);
});

test("does not serve a symlink that resolves outside the built dist root", async ({ request }, testInfo) => {
  test.skip(process.platform === "win32", "Creating symlinks requires elevated Windows privileges in CI.");
  test.skip(testInfo.project.name !== "chromium", "The server containment check is browser-neutral and runs once.");
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "patterdraw-production-fixture-"));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "patterdraw-production-"));
  const targetPath = path.join(targetDir, "outside.js");
  const assetsDir = path.join(fixtureRoot, "assets");
  const linkPath = path.join(assetsDir, "outside.js");
  await mkdir(assetsDir);
  await writeFile(path.join(fixtureRoot, "index.html"), "<!doctype html><title>PatterDraw</title>", "utf8");
  await writeFile(targetPath, "window.__patterdrawOutside = true;\n", "utf8");
  await symlink(targetPath, linkPath);
  let fixtureServer: Awaited<ReturnType<typeof startProductionFixture>> | undefined;
  try {
    fixtureServer = await startProductionFixture(fixtureRoot);
    const response = await request.get(
      `${fixtureServer.origin}${productionRoute}assets/${path.basename(linkPath)}`,
    );
    expect(response.status()).toBe(404);
    expectSecurityHeaders(response.headers());
    const healthy = await request.get(`${fixtureServer.origin}${productionRoute}`);
    expect(healthy.status()).toBe(200);
  } finally {
    await fixtureServer?.stop();
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("keeps the entry point revalidating while hashed bundles stay immutable", async ({ request, browserName }) => {
  test.skip(browserName !== "chromium", "Cache policy is covered once; request semantics are engine-neutral.");
  const indexResponse = await request.get(`${productionOrigin}${productionRoute}`);
  expect(indexResponse.status()).toBe(200);
  expectSecurityHeaders(indexResponse.headers());
  expect(indexResponse.headers()["cache-control"]).toBe("no-store");
  const indexHtml = await indexResponse.text();
  const hashedAsset = indexHtml.match(/(?:src|href)="(\.\/assets\/[^"]+\.(?:js|css))"/)?.[1];
  expect(hashedAsset).toBeTruthy();
  const hashedResponse = await request.get(`${productionOrigin}${productionRoute}${hashedAsset?.slice(2)}`);
  expect(hashedResponse.status()).toBe(200);
  expectSecurityHeaders(hashedResponse.headers());
  expect(hashedResponse.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  for (const [assetPath, mimeType] of [
    ["pdfjs/standard_fonts/LiberationSans-Regular.ttf", "font/ttf"],
    ["pdfjs/standard_fonts/FoxitFixed.pfb", "application/x-font-type1"],
  ] as const) {
    const response = await request.get(`${productionOrigin}${productionRoute}${assetPath}`);
    expect(response.status(), assetPath).toBe(200);
    expectSecurityHeaders(response.headers());
    expect(response.headers()["content-type"], assetPath).toBe(mimeType);
    expect(response.headers()["cache-control"], assetPath).toBe("public, max-age=0, must-revalidate");
  }
});

test("loads the production bundle and working board from the root static path", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);

  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  expect(response?.headers()["x-patterdraw-production-dist"]).toBe("1");
  await expect(page).toHaveTitle("PatterDraw");
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Project title", exact: true })).toHaveValue("Untitled PatterDraw canvas");

  await settleBrowserProblems(page);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
  expect(sameOriginRequests(page, requests).some((requestUrl) => new URL(requestUrl).pathname.includes("/assets/"))).toBe(true);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("loads lazy equation rendering from local production assets", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);

  await page.goto("/classroom/math/unit-01/patterdraw/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.getByRole("menuitem", { name: "Equation", exact: true }).click();
  await page.locator("#latex-source").fill("x^2 + 1");

  const preview = page.locator('.equation-preview img[alt^="Preview of"]');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect.poll(
    () => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    { timeout: 30_000 },
  ).toBe(true);

  await settleBrowserProblems(page);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
  expect(requests.some((requestUrl) => new URL(requestUrl).pathname.includes("/mathjax/tex-svg.js"))).toBe(true);
  expect(requests.some((requestUrl) => new URL(requestUrl).pathname.includes("/mathjax/sre/speech-worker.js"))).toBe(true);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/classroom/math/unit-01/patterdraw/");
});

test("opens Slides and adds a slide without remounting the production editor", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);

  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  const editorToken = await page.locator(".editor-host").evaluate((element) => {
    const token = "production-editor-root";
    element.setAttribute("data-production-editor-token", token);
    return token;
  });

  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator("#slide-rail")).toBeVisible();
  await page.getByRole("button", { name: "Add slide", exact: true }).click();
  await expect(page.locator(".slide-thumbnail")).toHaveCount(1);
  await expect(page.locator(".editor-host")).toHaveAttribute("data-production-editor-token", editorToken);
  await expect(page.getByRole("button", { name: "Slides", exact: true })).toHaveAttribute("aria-pressed", "true");

  await settleBrowserProblems(page);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
});

test.describe("desktop Chromium production worker flows", () => {
  test.skip(
    ({ browserName, viewport }) => browserName !== "chromium" || viewport?.width !== 1440,
    "Worker/export flows run once on desktop Chromium; other projects cover loading and navigation.",
  );

test("imports a PDF through the local worker, draws an annotation, and exports it", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);

  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  const workerResponse = page.waitForResponse(
    (response) => /\/assets\/pdf\.worker(?:\.min)?[-A-Za-z0-9_]*\.(?:mjs|js)(?:\?.*)?$/.test(new URL(response.url()).pathname)
      && response.status() === 200,
    { timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT },
  );
  await page.getByLabel("Open project file").setInputFiles({
    name: "production-worker-smoke.pdf",
    mimeType: "application/pdf",
    buffer: await tinyPdfBytes(),
  });
  await expect(page.locator(".app-shell")).toHaveClass(/is-pdf-mode/, { timeout: 30_000 });
  await expect(page.locator("#pdf-page-rail .pdf-page-item")).toHaveCount(1, { timeout: 30_000 });
  expect((await workerResponse).status()).toBe(200);

  await page.getByTestId("toolbar-rectangle").check({ force: true });
  const editorBounds = await page.locator(".editor-host").boundingBox();
  expect(editorBounds).not.toBeNull();
  const left = (editorBounds?.x || 0) + (editorBounds?.width || 0) * 0.45;
  const top = (editorBounds?.y || 0) + (editorBounds?.height || 0) * 0.4;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + 40, top + 30, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId("toolbar-selection").check({ force: true });

  await page.getByRole("button", { name: "More export options", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
  const exported = await PDFDocument.load(await downloadBytes(await download));
  expect(exported.getPageCount()).toBe(1);

  await settleBrowserProblems(page);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
  expect(requests.some((requestUrl) => /\/assets\/pdf\.worker/.test(new URL(requestUrl).pathname))).toBe(true);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
});

test("round-trips a local image project through the archive worker without remote image requests", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);
  const imageDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await page.getByLabel("Open project file").setInputFiles({
    name: "production-image.excalidraw",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "local",
      name: "Production image round-trip",
      elements: [{
        id: "production-image",
        type: "image",
        x: 100,
        y: 100,
        width: 48,
        height: 48,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        status: "saved",
        fileId: "production-image-file",
        scale: [1, 1],
      }],
      appState: {},
      files: {
        "production-image-file": {
          id: "production-image-file",
          mimeType: "image/png",
          dataURL: imageDataURL,
          created: 1,
        },
      },
    })),
  });
  await expect(page.getByRole("textbox", { name: "Project title", exact: true }))
    .toHaveValue("Production image round-trip");

  const saveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const savedBytes = await downloadBytes(await saveDownload);
  const archive = unzipSync(new Uint8Array(savedBytes));
  expect(Object.keys(archive)).toContain("project.json");
  const savedProject = JSON.parse(strFromU8(archive["project.json"])) as {
    title?: string;
    scenes?: Record<string, { files?: Record<string, { dataURL?: string }> }>;
  };
  expect(savedProject.title).toBe("Production image round-trip");
  expect(Object.values(savedProject.scenes || {}).some((scene) => (
    Object.values(scene.files || {}).some((file) => file.dataURL === imageDataURL)
  ))).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await page.getByLabel("Open project file").setInputFiles({
    name: "production-image-round-trip.patterdraw",
    mimeType: "application/vnd.patterdraw+zip",
    buffer: savedBytes,
  });
  await expect(page.getByRole("textbox", { name: "Project title", exact: true }))
    .toHaveValue("Production image round-trip");

  await settleBrowserProblems(page);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
  expect(requests.some((requestUrl) => new URL(requestUrl).pathname.includes("project-archive.worker"))).toBe(true);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
  expect(requests.some((requestUrl) => /(?:https?:\/\/|file:)/i.test(requestUrl) && !requestUrl.startsWith(productionOrigin))).toBe(false);
});

});

test.describe("320px production layout", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 320,
    "The mobile layout project runs this bounded check.",
  );

test("keeps the 320px production layout inside the viewport", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);
  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect(page.getByRole("textbox", { name: "Project title", exact: true })).toBeVisible();
  const viewport = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(viewport.bodyWidth).toBeLessThanOrEqual(viewport.viewportWidth + 1);
  expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.viewportWidth + 1);
  await page.getByRole("button", { name: "Slides", exact: true }).click();
  await expect(page.locator("#slide-rail")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close slide navigator", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close slide navigator", exact: true }).click();
  await expect(page.locator("#slide-rail")).toHaveCount(0);

  await page.getByLabel("Open project file").setInputFiles({
    name: "mobile-pdf-drawer.pdf",
    mimeType: "application/pdf",
    buffer: await tinyPdfBytes(),
  });
  const pdfRail = page.locator("#pdf-page-rail");
  const closePdfNavigator = page.getByRole("button", { name: "Close PDF page navigator", exact: true });
  await expect(pdfRail).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect(closePdfNavigator).toBeVisible();
  const openFirstPage = page.getByRole("button", { name: /Open output page 1:/ });
  const showPdfPages = page.getByRole("button", { name: "Show PDF pages", exact: true });
  await closePdfNavigator.click();
  await expect(pdfRail).toHaveCount(0);
  await expect(showPdfPages).toBeFocused();
  await showPdfPages.click();
  await expect(pdfRail).toBeVisible();
  await expect(openFirstPage).toBeFocused();
  await openFirstPage.click();
  await expect(pdfRail).toHaveCount(0);
  await expect(closePdfNavigator).toHaveCount(0);
  await expect(showPdfPages).toBeVisible();
  await page.getByRole("button", { name: "Hide footer", exact: true }).click();
  await expect(page.locator(".statusbar")).toHaveCount(0);
  await expect(showPdfPages).toBeVisible();
  await showPdfPages.click();
  await expect(pdfRail).toBeVisible();
  await expect(openFirstPage).toBeFocused();
  await openFirstPage.click();
  await expect(pdfRail).toHaveCount(0);
  await expect(showPdfPages).toBeFocused();

  await showPdfPages.click();
  await expect(pdfRail).toBeVisible();
  await page.locator(".app-shell").evaluate((shell) => {
    shell.style.setProperty("--safe-area-top", "31px");
    shell.style.setProperty("--safe-area-right", "17px");
    shell.style.setProperty("--safe-area-bottom", "23px");
    shell.style.setProperty("--safe-area-left", "13px");
  });
  await page.getByRole("button", { name: "Hide navigation", exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-nav-hidden/);
  const safeAreaGeometry = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".editor-host");
    const rail = document.querySelector<HTMLElement>("#pdf-page-rail");
    const heading = rail?.querySelector<HTMLElement>(".rail-heading");
    const backdrop = document.querySelector<HTMLElement>(".slide-rail-backdrop");
    if (!editor || !rail || !heading || !backdrop) throw new Error("Mobile PDF drawer geometry is unavailable.");
    return {
      editorTop: editor.getBoundingClientRect().top,
      railTop: rail.getBoundingClientRect().top,
      headingTop: heading.getBoundingClientRect().top,
      backdropTop: backdrop.getBoundingClientRect().top,
    };
  });
  expect(safeAreaGeometry.editorTop).toBe(0);
  expect(safeAreaGeometry.railTop).toBe(0);
  expect(safeAreaGeometry.backdropTop).toBe(0);
  expect(safeAreaGeometry.headingTop).toBeGreaterThanOrEqual(31);
  await closePdfNavigator.click();
  await expect(pdfRail).toHaveCount(0);
  await expect(showPdfPages).toBeFocused();
  const floatingPdfButtonBounds = await showPdfPages.boundingBox();
  expect(floatingPdfButtonBounds).not.toBeNull();
  expect(floatingPdfButtonBounds!.x).toBeGreaterThanOrEqual(13);
  expect(floatingPdfButtonBounds!.y).toBeGreaterThanOrEqual(31);
  const showFooter = page.getByRole("button", { name: "Show footer", exact: true });
  const showFooterBounds = await showFooter.boundingBox();
  expect(showFooterBounds).not.toBeNull();
  expect(320 - showFooterBounds!.x - showFooterBounds!.width).toBeGreaterThanOrEqual(17);
  expect(568 - showFooterBounds!.y - showFooterBounds!.height).toBeGreaterThanOrEqual(23);
  await settleBrowserProblems(page);
  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
});

});
