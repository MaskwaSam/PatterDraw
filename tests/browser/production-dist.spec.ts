import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import {
  APP_SHELL_CACHE_POLICY_VERSION,
  renderOfflineServiceWorker,
} from "../../build/offline-service-worker.mjs";

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

async function startProductionFixture(
  dist: string,
  {
    testGzipAssets = false,
    testNavigationFaults = false,
    testPerformanceProfile = false,
  } = {},
): Promise<{
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
    ...(testGzipAssets ? ["--test-gzip-assets"] : []),
    ...(testNavigationFaults ? ["--test-navigation-faults"] : []),
    ...(testPerformanceProfile ? ["--test-performance-profile"] : []),
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
  expect(headers["content-security-policy"]).toContain("frame-src 'self'");
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

async function autosavedProjectTitle(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction("keyval", "readonly");
        const request = transaction.objectStore("keyval")
          .get("patterdraw:autosave:project:v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return value && typeof value === "object" && "title" in value
        && typeof (value as { title?: unknown }).title === "string"
        ? (value as { title: string }).title
        : null;
    } finally {
      database.close();
    }
  });
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
  expect(entry.headers()["x-patterdraw-app-shell"]).toBe("patterdraw-app-shell-v1");

  const missing = await request.get(`${productionOrigin}${productionRoute}assets/missing-security-probe.js`);
  expect(missing.status()).toBe(404);
  expectSecurityHeaders(missing.headers());
});

test("allows only the bundled GeoGon path to be framed by the same origin", async ({ request }) => {
  const entry = await request.get(`${productionOrigin}${productionRoute}geogon/index.html?host=patterdraw`);
  expect(entry.status()).toBe(200);
  const headers = entry.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
  expect(headers["content-security-policy"]).toContain("connect-src 'none'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(headers["referrer-policy"]).toBe("no-referrer");

  const missing = await request.get(`${productionOrigin}${productionRoute}geogon/missing.html`);
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
  expect(getResponse.headers()["x-patterdraw-app-shell"]).toBe("patterdraw-app-shell-v1");
  expect(headResponse.headers()["x-patterdraw-app-shell"]).toBe("patterdraw-app-shell-v1");
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

test("revalidates, survives gateway errors, and keeps rollback registration safely retired", async ({ page, request, browserName }, testInfo) => {
  test.skip(
    !["chromium", "firefox-dist", "webkit-dist"].includes(testInfo.project.name),
    "The service-worker lifecycle runs once per supported desktop engine.",
  );
  const productionDist = path.resolve("dist/release");
  const fixture = await startProductionFixture(productionDist, {
    testGzipAssets: true,
    testNavigationFaults: true,
  });
  const fixtureRoute = `${fixture.origin}${productionRoute}`;
  try {
    const workerResponse = await request.get(`${fixtureRoute}service-worker.js`);
    expect(workerResponse.status()).toBe(200);
    expectSecurityHeaders(workerResponse.headers());
    expect(workerResponse.headers()["content-type"]).toContain("text/javascript");
    expect(workerResponse.headers()["cache-control"]).toBe("no-store, no-transform");
    expect(workerResponse.headers()["content-encoding"]).toBeUndefined();
    const workerBytes = await workerResponse.body();
    expect(workerBytes.equals(await readFile(path.join(productionDist, "service-worker.js"))))
      .toBe(true);
    const workerSource = workerBytes.toString("utf8");
    expect(workerSource).toContain("patterdraw-app-shell-v2:");
    expect(workerSource).toContain("PRECACHE_TOTAL_BYTES");
    expect(workerSource).toContain("CONTINUITY_PACK");
    expect(workerSource).not.toContain("skipWaiting");
    expect(workerSource).toContain("await self.clients.claim()");
    expect(workerSource).not.toMatch(/https?:\/\//);
    const shellManifestSource = /const PRECACHE = (\[[^;]+\]);/.exec(workerSource)?.[1];
    const continuityManifestSource = /const CONTINUITY = (\[[^;]+\]);/.exec(workerSource)?.[1];
    expect(shellManifestSource).toBeTruthy();
    expect(continuityManifestSource).toBeTruthy();
    const shellManifest = JSON.parse(shellManifestSource || "[]") as Array<{ path: string }>;
    const continuityManifest = JSON.parse(continuityManifestSource || "[]") as Array<{ path: string }>;
    expect(shellManifest.some((entry) => /pdf\.worker|mathjax|mermaid|geogon/i.test(entry.path)))
      .toBe(false);
    expect(continuityManifest.some((entry) => /pdf\.worker/i.test(entry.path))).toBe(true);
    expect(continuityManifest.some((entry) => /mathjax/i.test(entry.path))).toBe(true);
    expect(continuityManifest.some((entry) => /mermaid/i.test(entry.path))).toBe(true);
    expect(continuityManifest.some((entry) => /geogon/i.test(entry.path))).toBe(true);

    const entryResponse = await page.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    expect(entryResponse?.headers()["x-patterdraw-app-shell"]).toBe("patterdraw-app-shell-v1");
    await expect(page.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await page.locator(".editor-host").evaluate((element) => {
      element.setAttribute("data-first-install-editor", "must-survive-claim");
    });
    await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) throw new Error("Service workers are unavailable.");
      await navigator.serviceWorker.ready;
    });
    await expect.poll(
      () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      { timeout: 15_000 },
    ).toBe(true);
    await expect(page.locator("#patterdraw-offline-app-shell-status")).toContainText(
      "Offline classroom tools are ready",
      { timeout: 10_000 },
    );
    await expect(page.locator(".editor-host"))
      .toHaveAttribute("data-first-install-editor", "must-survive-claim");
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
    const compressedCacheProof = await page.evaluate(async () => {
      const cacheName = (await caches.keys()).find((name) => (
        name.startsWith("patterdraw-app-shell-v2:")
      ));
      if (!cacheName) throw new Error("The generated app-shell cache was not created.");
      const cache = await caches.open(cacheName);
      const cachedRequest = (await cache.keys()).find((request) => (
        /\/assets\/[^/]+\.(?:css|js)$/.test(new URL(request.url).pathname)
      ));
      if (!cachedRequest) throw new Error("No compressed startup asset was present in the app-shell cache.");
      const cachedResponse = await cache.match(cachedRequest);
      if (!cachedResponse) throw new Error("The compressed startup asset was missing from the app-shell cache.");
      const cachedBytes = await cachedResponse.arrayBuffer();
      const digest = async (bytes: ArrayBuffer) => Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        assetUrl: cachedRequest.url,
        cachedContentEncoding: cachedResponse.headers.get("content-encoding"),
        cachedContentLength: cachedResponse.headers.get("content-length"),
        cachedDigest: await digest(cachedBytes),
        cachedLength: cachedBytes.byteLength,
        cachedOriginalLength: Number(
          cachedResponse.headers.get("x-patterdraw-test-uncompressed-length"),
        ),
      };
    });
    // A controlled page fetch is intercepted by the active service worker, so
    // cache: "reload" cannot prove the server's transport encoding. Use the
    // request context outside the worker scope for the wire-level gzip proof,
    // then compare its decoded bytes with the verified cached representation.
    const gzipResponse = await request.get(compressedCacheProof.assetUrl, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(gzipResponse.status()).toBe(200);
    expectSecurityHeaders(gzipResponse.headers());
    expect(gzipResponse.headers()["content-encoding"]).toBe("gzip");
    const gzipContentLength = Number(gzipResponse.headers()["content-length"]);
    const originalLength = Number(
      gzipResponse.headers()["x-patterdraw-test-uncompressed-length"],
    );
    expect(gzipContentLength).toBeGreaterThan(0);
    expect(gzipContentLength).toBeLessThan(originalLength);
    expect(gzipResponse.headers()["cache-control"])
      .toBe("public, max-age=31536000, immutable");
    expect(gzipResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(gzipResponse.headers().vary).toBe("Accept-Encoding");
    const gzipBytes = await gzipResponse.body();
    expect(gzipBytes.byteLength).toBe(originalLength);
    expect(createHash("sha256").update(gzipBytes).digest("hex"))
      .toBe(compressedCacheProof.cachedDigest);
    expect(compressedCacheProof.cachedLength).toBe(originalLength);
    expect(compressedCacheProof.cachedOriginalLength).toBe(originalLength);
    expect(compressedCacheProof.cachedContentEncoding).toBeNull();
    expect(compressedCacheProof.cachedContentLength).toBeNull();
    const identityResponse = await request.get(compressedCacheProof.assetUrl, {
      headers: { "Accept-Encoding": "identity" },
    });
    expect(identityResponse.status()).toBe(200);
    expectSecurityHeaders(identityResponse.headers());
    expect(identityResponse.headers()["content-encoding"]).toBeUndefined();
    expect(identityResponse.headers().vary).toBe("Accept-Encoding");
    expect(identityResponse.headers()["cache-control"])
      .toBe("public, max-age=31536000, immutable");
    expect((await identityResponse.body()).byteLength).toBe(originalLength);
    // The verified first install claims this exact lesson without navigation or
    // remount. Later releases still never skip the normal waiting lifecycle.
    const context = page.context();
    const controlledPage = page;

    if (browserName === "webkit") {
      // Context-level offline navigation currently fails inside the
      // Playwright/WebKit driver before it exposes the worker's cached
      // response. An abruptly closed network navigation deterministically
      // reaches the same worker catch/fallback branch.
      const offlineFallbackResponse = await controlledPage.goto(
        `${fixtureRoute}?__patterdraw_test_navigation_abort=1`,
        { waitUntil: "domcontentloaded" },
      );
      expect(offlineFallbackResponse?.status()).toBe(200);
    } else {
      await context.setOffline(true);
      try {
        // A direct entry-point URL is a valid app navigation even when a
        // classroom deep link leaves query/fragment state on index.html.
        // The worker must canonicalize that URL before its static-file guard
        // so the cached shell remains available while the network is down.
        await controlledPage.goto(
          `${fixtureRoute}index.html?offline-direct-index=1#board`,
          { waitUntil: "domcontentloaded" },
        );
      } finally {
        await context.setOffline(false);
      }
      expect(new URL(controlledPage.url()).pathname).toBe(`${productionRoute}index.html`);
      expect(new URL(controlledPage.url()).searchParams.get("offline-direct-index")).toBe("1");
    }
    await expect(controlledPage).toHaveTitle("PatterDraw");
    await expect(controlledPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect(controlledPage.getByRole("button", { name: "Board", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    // Rendering the recovered document can precede registration visibility in
    // WebKit. Wait for that boundary before reading its durable routing state;
    // the cache, controller, and routing assertions below still have to pass.
    await expect.poll(() => controlledPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const controller = navigator.serviceWorker.controller;
      return registration && controller
        ? { scope: registration.scope, scriptUrl: controller.scriptURL }
        : null;
    }), { timeout: 15_000 }).toEqual({
      scope: fixtureRoute,
      scriptUrl: new URL("service-worker.js", fixtureRoute).href,
    });
    const recoveredRoutingState = await controlledPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("The offline recovery page lost its worker registration.");
      const cacheName = (await caches.keys()).find((name) => (
        name.startsWith(`patterdraw-app-shell-v2:${encodeURIComponent(registration.scope)}:`)
      ));
      if (!cacheName) throw new Error("The offline recovery page lost its verified cache.");
      const response = await (await caches.open(cacheName)).match(
        new URL("./.__patterdraw_offline_routing_state__", registration.scope),
      );
      if (!response) throw new Error("The offline recovery page lost its routing state.");
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        state: await response.json() as {
          mode?: string;
          passThroughClients?: string[];
          pendingClients?: Array<{ clientId?: string; routing?: string }>;
          protectedClients?: string[];
        },
      };
    });
    expect(recoveredRoutingState.controlled).toBe(true);
    expect(recoveredRoutingState.state).toMatchObject({
      mode: "normal",
      passThroughClients: [],
      pendingClients: [],
      protectedClients: [],
    });

    for (const status of [502, 503]) {
      const response = await controlledPage.goto(
        `${fixtureRoute}?__patterdraw_test_navigation_status=${status}`,
        { waitUntil: "domcontentloaded" },
      );
      expect(response?.status(), String(status)).toBe(200);
      await expect(controlledPage.locator(".editor-host .excalidraw")).toBeVisible({
        timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
      });
    }

    await controlledPage.goto(
      `${fixtureRoute}?__patterdraw_test_rollback=1`,
      { waitUntil: "domcontentloaded" },
    );
    await expect.poll(
      () => controlledPage.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())),
      { timeout: 15_000 },
    ).toBe(true);
    const rollbackRoutingState = await controlledPage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("The retired registration was removed.");
      const cacheName = (await caches.keys()).find((name) => (
        name.startsWith(`patterdraw-app-shell-v2:${encodeURIComponent(registration.scope)}:`)
      ));
      if (!cacheName) throw new Error("The retired release cache was removed.");
      const response = await (await caches.open(cacheName)).match(
        new URL("./.__patterdraw_offline_routing_state__", registration.scope),
      );
      if (!response) throw new Error("The retired routing state is missing.");
      return response.json() as Promise<{ mode: string }>;
    });
    expect(rollbackRoutingState.mode).toBe("retired");
    const retainedRollbackCaches = await controlledPage.evaluate(async () => (
      (await caches.keys()).filter((name) => name.startsWith("patterdraw-app-shell-v2:"))
    ));
    expect(retainedRollbackCaches.length).toBeGreaterThan(0);

    // A deterministic aborted navigation avoids browser-driver differences
    // while proving the retired worker fails closed instead of resurrecting A.
    const retiredOfflineResponse = await controlledPage
      .goto(`${fixtureRoute}?__patterdraw_test_navigation_abort=1`, {
        timeout: 15_000,
        waitUntil: "domcontentloaded",
      })
      .catch(() => null);
    expect(retiredOfflineResponse?.headers()["x-patterdraw-app-shell"]).not
      .toBe("patterdraw-app-shell-v1");
    await expect(controlledPage.locator(".editor-host .excalidraw")).toHaveCount(0);
    await controlledPage.close();
  } finally {
    await fixture.stop();
  }
});

test("keeps A usable, bounds B/C/D updates, and advances after A closes", async ({ browser }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "The packaged A-to-B-to-C/D continuity lifecycle is exercised once in Chromium.",
  );
  test.setTimeout(300_000);

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "patterdraw-worker-update-"));
  const fixtureDist = path.join(fixtureRoot, "release");
  const stagedDist = path.join(fixtureRoot, "release-b");
  const stagedDistC = path.join(fixtureRoot, "release-c");
  const stagedDistD = path.join(fixtureRoot, "release-d");
  const retiredDist = path.join(fixtureRoot, "release-a-retired");
  const retiredDistB = path.join(fixtureRoot, "release-b-retired");
  const retiredDistC = path.join(fixtureRoot, "release-c-retired");
  const packagedDist = path.resolve("dist/release");
  let fixture: Awaited<ReturnType<typeof startProductionFixture>> | undefined;
  const context = await browser.newContext({ serviceWorkers: "allow" });
  try {
    await cp(packagedDist, fixtureDist, { recursive: true });
    await cp(packagedDist, stagedDist, { recursive: true });
    const workerPath = path.join(fixtureDist, "service-worker.js");
    const workerA = await readFile(workerPath, "utf8");
    const cacheVersionMatch = workerA.match(
      /const CACHE_NAME = SCOPE_CACHE_PREFIX \+ "([a-f0-9]{20})";/,
    );
    expect(cacheVersionMatch, "The packaged worker must expose its generated 20-character content version.")
      .not.toBeNull();
    if (!cacheVersionMatch) throw new Error("The packaged worker cache version was unavailable.");
    const cacheVersionA = cacheVersionMatch[1];
    const precacheMatch = workerA.match(
      /const PRECACHE = (\[[^\n]+\]);\nconst PRECACHE_TOTAL_BYTES/,
    );
    expect(precacheMatch, "The packaged worker must expose its generated precache manifest.")
      .not.toBeNull();
    if (!precacheMatch) throw new Error("The packaged worker precache manifest was unavailable.");
    const precache = JSON.parse(precacheMatch[1]) as Array<{
      mime: string;
      path: string;
      sha256: string;
    }>;
    const continuityMatch = workerA.match(
      /const CONTINUITY = (\[[^\n]+\]);\nconst CONTINUITY_TOTAL_BYTES/,
    );
    const continuityPackMatch = workerA.match(
      /const CONTINUITY_PACK = (\{[^\n]+\});\nconst PRECACHE_PATHS/,
    );
    expect(continuityMatch, "The packaged worker must expose its continuity manifest.")
      .not.toBeNull();
    expect(continuityPackMatch, "The packaged worker must expose its continuity pack.")
      .not.toBeNull();
    if (!continuityMatch || !continuityPackMatch) {
      throw new Error("The packaged worker continuity metadata was unavailable.");
    }
    const continuityEntries = JSON.parse(continuityMatch[1]) as Array<{
      bytes: number;
      mime: string;
      offset: number;
      path: string;
      sha256: string;
    }>;
    const continuityPack = JSON.parse(continuityPackMatch[1]) as {
      bytes: number;
      path: string;
      sha256: string;
      uncompressedBytes: number;
    };
    expect(continuityEntries.some((entry) => /pdf\.worker/i.test(entry.path))).toBe(true);
    expect(continuityEntries.some((entry) => /embedded-image-limits\.worker/i.test(entry.path)))
      .toBe(true);
    expect(continuityEntries.some((entry) => /mathjax/i.test(entry.path))).toBe(true);
    expect(continuityEntries.some((entry) => /mermaid/i.test(entry.path))).toBe(true);
    expect(continuityEntries.some((entry) => /geogon/i.test(entry.path))).toBe(true);
    const continuityPackBytes = await readFile(
      path.join(fixtureDist, continuityPack.path.slice(2)),
    );
    expect(continuityPackBytes.byteLength).toBe(continuityPack.bytes);
    expect(createHash("sha256").update(continuityPackBytes).digest("hex"))
      .toBe(continuityPack.sha256);
    const shellEntriesA = await Promise.all(precache.map(async (entry) => ({
      ...entry,
      bytes: (await readFile(path.join(fixtureDist, entry.path.slice(2)))).byteLength,
    })));
    const indexPath = path.join(stagedDist, "index.html");
    const indexASource = await readFile(indexPath, "utf8");
    expect(indexASource).toContain("</head>");
    const indexB = Buffer.from(indexASource.replace(
      "</head>",
      '<meta name="patterdraw-fixture-version" content="B"></head>',
    ), "utf8");
    const shellEntriesB = shellEntriesA.map((entry) => entry.path === "./index.html"
      ? {
          ...entry,
          bytes: indexB.byteLength,
          sha256: createHash("sha256").update(indexB).digest("hex"),
        }
      : entry);
    const cacheVersionB = createHash("sha256")
      .update(`${APP_SHELL_CACHE_POLICY_VERSION}\n`)
      .update([...shellEntriesB, ...continuityEntries]
        .map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""))
      .digest("hex")
      .slice(0, 20);
    expect(cacheVersionB).not.toBe(cacheVersionA);
    const workerB = renderOfflineServiceWorker({
      continuityEntries,
      continuityPack,
      entries: shellEntriesB,
      version: cacheVersionB,
    });
    expect(workerB).not.toBe(workerA);
    await writeFile(
      path.join(stagedDist, "observer.html"),
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Worker lifecycle observer</title></head><body>observer</body></html>",
      "utf8",
    );
    await writeFile(path.join(stagedDist, "index.html"), indexB);
    await writeFile(path.join(stagedDist, "service-worker.js"), workerB, "utf8");
    for (const entry of continuityEntries) {
      await rm(path.join(stagedDist, entry.path.slice(2)), { force: true });
    }

    // C and D are distinct static releases derived from B. Their individual
    // continuity files remain absent, so a blocked install cannot be mistaken
    // for a successful network fallback; only the one verified pack exists.
    const createLaterRelease = async (
      label: "C" | "D",
      target: string,
    ): Promise<{ cacheVersion: string; index: Buffer }> => {
      await cp(stagedDist, target, { recursive: true });
      const index = Buffer.from(indexASource.replace(
        "</head>",
        `<meta name="patterdraw-fixture-version" content="${label}"></head>`,
      ), "utf8");
      const shellEntries = shellEntriesA.map((entry) => entry.path === "./index.html"
        ? {
            ...entry,
            bytes: index.byteLength,
            sha256: createHash("sha256").update(index).digest("hex"),
          }
        : entry);
      const cacheVersion = createHash("sha256")
        .update(`${APP_SHELL_CACHE_POLICY_VERSION}\n`)
        .update([...shellEntries, ...continuityEntries]
          .map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""))
        .digest("hex")
        .slice(0, 20);
      await writeFile(path.join(target, "index.html"), index);
      await writeFile(path.join(target, "service-worker.js"), renderOfflineServiceWorker({
        continuityEntries,
        continuityPack,
        entries: shellEntries,
        version: cacheVersion,
      }), "utf8");
      return { cacheVersion, index };
    };
    const releaseC = await createLaterRelease("C", stagedDistC);
    const releaseD = await createLaterRelease("D", stagedDistD);
    expect(new Set([
      cacheVersionA,
      cacheVersionB,
      releaseC.cacheVersion,
      releaseD.cacheVersion,
    ]).size).toBe(4);

    fixture = await startProductionFixture(fixtureDist, {
      testNavigationFaults: true,
      testPerformanceProfile: true,
    });
    const fixtureRoute = `${fixture.origin}${productionRoute}`;
    const versionAPage = await context.newPage();
    const {
      badResponses,
      consoleErrors,
      failedRequests,
      pageErrors,
      requests,
      unhandledRejections,
    } = await captureBrowserProblems(versionAPage);
    const lazyResponses: Array<{ fromServiceWorker: boolean; path: string }> = [];
    const isClassroomLazyPath = (pathname: string) => (
      /\/(?:mathjax|geogon)\//i.test(pathname)
      || /\/assets\/(?:render-latex|safe-mermaid|mermaid-parser|mermaid-disabled|import-pdf|export-pdf|embedded-image-limits\.worker|pdf\.worker)/i.test(pathname)
    );
    versionAPage.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (isClassroomLazyPath(pathname)) {
        lazyResponses.push({ fromServiceWorker: response.fromServiceWorker(), path: pathname });
      }
    });

    await versionAPage.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    await expect(versionAPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await versionAPage.locator(".editor-host").evaluate((element) => {
      element.setAttribute("data-version-a-editor", "original");
    });
    const scope = await test.step("install and activate verified version A", async () => {
      await expect.poll(async () => versionAPage.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return null;
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.state || null;
      }), { timeout: 90_000 }).toBe("activated");
      return versionAPage.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) throw new Error("The version-A registration is unavailable.");
        return registration.scope;
      });
    });
    await expect.poll(
      () => versionAPage.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      { timeout: 15_000 },
    ).toBe(true);
    await expect(versionAPage.locator(".editor-host"))
      .toHaveAttribute("data-version-a-editor", "original");
    expect(await versionAPage.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
    expect(lazyResponses).toEqual([]);

    const cachePrefix = `patterdraw-app-shell-v2:${encodeURIComponent(scope)}:`;
    const cacheA = `${cachePrefix}${cacheVersionA}`;
    const cacheB = `${cachePrefix}${cacheVersionB}`;
    const cacheC = `${cachePrefix}${releaseC.cacheVersion}`;
    const cacheD = `${cachePrefix}${releaseD.cacheVersion}`;
    const expectedCachedPaths = [...precache, ...continuityEntries]
      .map((entry) => new URL(entry.path, scope).href)
      .concat(new URL("./.__patterdraw_offline_routing_state__", scope).href)
      .sort();
    const neighbourScope = new URL("/classroom/math/neighbour/", fixture.origin).href;
    const neighbourCache = `patterdraw-app-shell-v2:${encodeURIComponent(neighbourScope)}:sentinel`;
    const neighbourSentinelUrl = new URL("sentinel", neighbourScope).href;
    await versionAPage.evaluate(async ({ cacheName, sentinelUrl }) => {
      const cache = await caches.open(cacheName);
      await cache.put(sentinelUrl, new Response("neighbour-scope-survived"));
    }, { cacheName: neighbourCache, sentinelUrl: neighbourSentinelUrl });
    expect(await versionAPage.evaluate(() => caches.keys())).toContain(cacheA);

    // Keep two additional A-controlled tabs. Both first become rollback
    // documents; only one later re-enters the marked lineage. The other stays
    // raw/network-only until B's waiting lifecycle has been proven, so the
    // test cannot accidentally normalize routing before first-use lazy tools.
    const rollbackPage = await context.newPage();
    await rollbackPage.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    await expect(rollbackPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect.poll(
      () => rollbackPage.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      { timeout: 15_000 },
    ).toBe(true);
    const rawRollbackPage = await context.newPage();
    await rawRollbackPage.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    await expect(rawRollbackPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect.poll(
      () => rawRollbackPage.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      { timeout: 15_000 },
    ).toBe(true);
    await rollbackPage.goto(`${fixtureRoute}?__patterdraw_test_rollback=1`, {
      waitUntil: "domcontentloaded",
    });
    await expect(rollbackPage).toHaveTitle("PatterDraw rollback fixture");
    await rawRollbackPage.goto(`${fixtureRoute}?raw-rollback-client=1`, {
      waitUntil: "domcontentloaded",
    });
    await expect(rawRollbackPage).toHaveTitle("PatterDraw rollback fixture");
    expect(await rollbackPage.evaluate(async (registrationScope) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      return {
        activeState: registration?.active?.state || null,
        controllerIsActive: navigator.serviceWorker.controller === registration?.active,
      };
    }, scope)).toEqual({ activeState: "activated", controllerIsActive: true });
    expect(await rawRollbackPage.evaluate(async (registrationScope) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      return {
        activeState: registration?.active?.state || null,
        controllerIsActive: navigator.serviceWorker.controller === registration?.active,
      };
    }, scope)).toEqual({ activeState: "activated", controllerIsActive: true });

    // Replace the whole static release atomically. Version A's individual lazy
    // files are now truly absent from the server; leaving them in place would
    // mask the exact mixed-version failure this regression is meant to catch.
    await rename(fixtureDist, retiredDist);
    await rename(stagedDist, fixtureDist);

    const rollbackContinuityPaths = [
      /\/assets\/render-latex-/,
      /\/mathjax\/tex-svg\.js$/,
      /\/assets\/safe-mermaid-/,
      /\/geogon\/index\.html$/,
      /\/assets\/import-pdf-/,
      /\/assets\/embedded-image-limits\.worker-/,
      /\/assets\/pdf\.worker(?:\.min)?-/,
      /\/assets\/export-pdf-/,
    ].map((pattern) => {
      const match = continuityEntries.find((entry) => pattern.test(entry.path));
      if (!match) throw new Error(`Version A is missing rollback continuity path ${pattern}.`);
      return new URL(match.path, scope).href;
    });
    expect(await versionAPage.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      return { ok: response.ok, url: response.url };
    })), rollbackContinuityPaths)).toEqual(rollbackContinuityPaths.map((url) => ({
      ok: true,
      url,
    })));
    for (const url of rollbackContinuityPaths) {
      const matches = lazyResponses.filter((response) => response.path === new URL(url).pathname);
      expect(matches.length, `Missing retired-A continuity response for ${url}`).toBeGreaterThan(0);
      expect(matches.every((response) => response.fromServiceWorker), JSON.stringify(matches))
        .toBe(true);
    }
    const rollbackNetworkOnlyStatuses = await rawRollbackPage.evaluate(async (urls) => (
      Promise.all(urls.map(async (url) => (await fetch(url)).status))
    ), rollbackContinuityPaths.filter((url) => /\/(?:mathjax|geogon)\//.test(url)));
    expect(rollbackNetworkOnlyStatuses.length).toBeGreaterThan(0);
    expect(rollbackNetworkOnlyStatuses.every((status) => status === 404)).toBe(true);

    // Reintroduce marked B through the rollback tab. A pins cached A HTML and
    // the wrapper's explicit existing-registration update check must install B
    // without this test manually invoking registration.update().
    await rollbackPage.goto(`${fixtureRoute}?__patterdraw_test_reintroduce=1`, {
      waitUntil: "domcontentloaded",
    });
    await expect(rollbackPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect(rollbackPage.locator('meta[name="patterdraw-fixture-version"]')).toHaveCount(0);

    await test.step("install and verify waiting version B", async () => {
      await expect.poll(async () => versionAPage.evaluate(async ({ registrationScope, ownCacheA, ownCacheB }) => {
        const registration = await navigator.serviceWorker.getRegistration(registrationScope);
        const cacheNames = await caches.keys();
        return {
          activeState: registration?.active?.state || null,
          controllerIsActive: navigator.serviceWorker.controller === registration?.active,
          hasCacheA: cacheNames.includes(ownCacheA),
          hasCacheB: cacheNames.includes(ownCacheB),
          waitingState: registration?.waiting?.state || null,
        };
      }, {
        registrationScope: scope,
        ownCacheA: cacheA,
        ownCacheB: cacheB,
      }), { timeout: 90_000 }).toEqual({
        activeState: "activated",
        controllerIsActive: true,
        hasCacheA: true,
        hasCacheB: true,
        waitingState: "installed",
      });
    });

    const routingStateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
    await expect.poll(async () => versionAPage.evaluate(async ({ ownCacheA, stateUrl }) => {
      const state = await (await caches.open(ownCacheA)).match(stateUrl);
      if (!state) return null;
      const parsed = await state.json() as {
        mode?: string;
        passThroughClients?: string[];
        pendingClients?: Array<{ routing?: string }>;
      };
      return {
        hasPassThroughLineage: Boolean(
          parsed.passThroughClients?.length
          || parsed.pendingClients?.some((pending) => pending.routing === "pass-through"),
        ),
        mode: parsed.mode || null,
      };
    }, { ownCacheA: cacheA, stateUrl: routingStateUrl })).toEqual({
      hasPassThroughLineage: true,
      mode: "reintroducing",
    });

    const assertBlockedNewerRelease = async ({
      cacheName,
      label,
      nextDist,
      retiredCurrentDist,
    }: {
      cacheName: string;
      label: "C" | "D";
      nextDist: string;
      retiredCurrentDist: string;
    }): Promise<void> => {
      await rename(fixtureDist, retiredCurrentDist);
      await rename(nextDist, fixtureDist);
      const token = randomBytes(16).toString("hex");
      const profile = await versionAPage.evaluate(async ({ registrationScope, sessionToken }) => {
        const response = await fetch(new URL(
          `__patterdraw_test/performance/start?token=${sessionToken}`,
          registrationScope,
        ));
        if (!response.ok) throw new Error(`Unable to start update accounting (${response.status}).`);
        return response.json() as Promise<{ started: boolean }>;
      }, { registrationScope: scope, sessionToken: token });
      expect(profile.started).toBe(true);

      const candidateStates = await versionAPage.evaluate(async (registrationScope) => {
        const registration = await navigator.serviceWorker.getRegistration(registrationScope);
        if (!registration) throw new Error("The version-A registration is unavailable.");
        return new Promise<string[]>((resolve, reject) => {
          const states: string[] = [];
          let candidate: ServiceWorker | null = null;
          let timeout = 0;
          const cleanup = () => {
            registration.removeEventListener("updatefound", onUpdateFound);
            candidate?.removeEventListener("statechange", onStateChange);
            clearTimeout(timeout);
          };
          const finish = () => {
            cleanup();
            resolve(states);
          };
          const onStateChange = () => {
            if (!candidate) return;
            states.push(candidate.state);
            if (candidate.state === "redundant") finish();
          };
          const onUpdateFound = () => {
            candidate = registration.installing;
            if (!candidate) return;
            candidate.addEventListener("statechange", onStateChange);
            // Attach before sampling so an immediately rejected guarded
            // install cannot transition to redundant inside the race window.
            onStateChange();
          };
          registration.addEventListener("updatefound", onUpdateFound);
          timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error(`The blocked update did not become redundant: ${states.join(", ")}`));
          }, 30_000);
          void registration.update().catch((error) => {
            states.push(`update-rejected:${error instanceof Error ? error.name : String(error)}`);
          });
        });
      }, scope);
      expect(candidateStates).toContain("redundant");

      await expect.poll(async () => versionAPage.evaluate(async ({
        blockedCache,
        expectedPaths,
        neighbourCacheName,
        ownCacheB,
        registrationScope,
      }) => {
        const registration = await navigator.serviceWorker.getRegistration(registrationScope);
        const cacheNames = await caches.keys();
        const waitingCache = await caches.open(ownCacheB);
        const waitingPaths = (await waitingCache.keys()).map((request) => request.url).sort();
        return {
          activeState: registration?.active?.state || null,
          blockedCachePresent: cacheNames.includes(blockedCache),
          controllerIsActive: navigator.serviceWorker.controller === registration?.active,
          neighbourPresent: cacheNames.includes(neighbourCacheName),
          ownCaches: cacheNames.filter((name) => name.startsWith(
            `patterdraw-app-shell-v2:${encodeURIComponent(registrationScope)}:`,
          )).sort(),
          waitingCacheComplete: JSON.stringify(waitingPaths) === JSON.stringify(expectedPaths),
          waitingState: registration?.waiting?.state || null,
        };
      }, {
        blockedCache: cacheName,
        expectedPaths: expectedCachedPaths,
        neighbourCacheName: neighbourCache,
        ownCacheB: cacheB,
        registrationScope: scope,
      }), { timeout: 30_000 }).toEqual({
        activeState: "activated",
        blockedCachePresent: false,
        controllerIsActive: true,
        neighbourPresent: true,
        ownCaches: [cacheA, cacheB].sort(),
        waitingCacheComplete: true,
        waitingState: "installed",
      });

      const updateMetrics = await versionAPage.evaluate(async ({ registrationScope, sessionToken }) => {
        const response = await fetch(new URL(
          `__patterdraw_test/performance/stop?token=${sessionToken}`,
          registrationScope,
        ));
        if (!response.ok) throw new Error(`Unable to stop update accounting (${response.status}).`);
        return response.json() as Promise<{
          completedResponseCount: number;
          requestCount: number;
          requests: Array<{
            completedResponseCount: number;
            relativePath: string;
            requestCount: number;
          }>;
        }>;
      }, { registrationScope: scope, sessionToken: token });
      expect(updateMetrics.completedResponseCount).toBe(updateMetrics.requestCount);
      expect(updateMetrics.requests.map((entry) => entry.relativePath))
        .toEqual(["service-worker.js"]);
      expect(updateMetrics.requests[0]?.requestCount, label).toBeGreaterThanOrEqual(1);
      expect(updateMetrics.requests[0]?.completedResponseCount, label)
        .toBe(updateMetrics.requests[0]?.requestCount);
      expect(updateMetrics.requests.some((entry) => entry.relativePath === continuityPack.path.slice(2)))
        .toBe(false);
    };

    await test.step("reject C and D before cache work while B is waiting", async () => {
      await assertBlockedNewerRelease({
        cacheName: cacheC,
        label: "C",
        nextDist: stagedDistC,
        retiredCurrentDist: retiredDistB,
      });
      await assertBlockedNewerRelease({
        cacheName: cacheD,
        label: "D",
        nextDist: stagedDistD,
        retiredCurrentDist: retiredDistC,
      });
    });

    // The raw rollback tab is still controlled by A and network-only. C/D
    // attempts must not have normalized away that lineage while B waits.
    await expect.poll(async () => versionAPage.evaluate(async ({ ownCacheA, stateUrl }) => {
      const state = await (await caches.open(ownCacheA)).match(stateUrl);
      if (!state) return null;
      const parsed = await state.json() as {
        mode?: string;
        passThroughClients?: string[];
        pendingClients?: Array<{ routing?: string }>;
      };
      return {
        hasPassThroughLineage: Boolean(
          parsed.passThroughClients?.length
          || parsed.pendingClients?.some((pending) => pending.routing === "pass-through"),
        ),
        mode: parsed.mode || null,
      };
    }, { ownCacheA: cacheA, stateUrl: routingStateUrl })).toEqual({
      hasPassThroughLineage: true,
      mode: "reintroducing",
    });

    // A navigation that begins after B replaces the static tree must still
    // receive A's cached HTML while A is active. Returning B HTML here would
    // create a mixed B-code/A-controller client and deadlock safe activation.
    const postCutoverPage = await context.newPage();
    const postCutoverProblems = await captureBrowserProblems(postCutoverPage);
    const postCutoverLazyResponses: Array<{ fromServiceWorker: boolean; path: string }> = [];
    postCutoverPage.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (isClassroomLazyPath(pathname)) {
        postCutoverLazyResponses.push({
          fromServiceWorker: response.fromServiceWorker(),
          path: pathname,
        });
      }
    });
    await postCutoverPage.goto(`${fixtureRoute}?opened-after-b=1`, {
      waitUntil: "domcontentloaded",
    });
    await expect(postCutoverPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect(postCutoverPage.locator('meta[name="patterdraw-fixture-version"]'))
      .toHaveCount(0);
    expect(await postCutoverPage.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);
    expect(postCutoverLazyResponses).toEqual([]);

    await test.step("load every first-use feature from version A after cutover", async () => {
    // Make the new post-cutover A client the first page to invoke equations.
    await postCutoverPage.getByRole("button", { name: "Insert", exact: true }).click();
    await postCutoverPage.getByRole("menuitem", { name: "Equation", exact: true }).click();
    await postCutoverPage.locator("#latex-source").fill("x^2 + 1");
    const postCutoverEquationPreview = postCutoverPage.locator(
      '.equation-preview img[alt^="Preview of"]',
    );
    await expect.poll(async () => ({
      failedRequests: [...postCutoverProblems.failedRequests],
      pageErrors: [...postCutoverProblems.pageErrors],
      previewCount: await postCutoverEquationPreview.count(),
      unhandledRejections: [...postCutoverProblems.unhandledRejections],
    }), { timeout: 30_000 }).toEqual({
      failedRequests: [],
      pageErrors: [],
      previewCount: 1,
      unhandledRejections: [],
    });
    await expect(postCutoverEquationPreview).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      () => postCutoverEquationPreview.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
      { timeout: 30_000 },
    ).toBe(true);
    await postCutoverPage.getByRole("button", {
      name: "Close equation editor",
      exact: true,
    }).click();
    for (const pattern of [
      /\/assets\/render-latex-/,
      /\/mathjax\/tex-svg\.js$/,
      /\/mathjax\/sre\/speech-worker\.js$/,
      /\/mathjax\/sre\/mathmaps\/(?:base|en)\.json$/,
    ]) {
      const matches = postCutoverLazyResponses.filter((response) => pattern.test(response.path));
      expect(matches.length, `Missing post-cutover A response for ${pattern}`).toBeGreaterThan(0);
      expect(matches.every((response) => response.fromServiceWorker), JSON.stringify(matches))
        .toBe(true);
    }
    expect(postCutoverProblems.failedRequests, postCutoverProblems.failedRequests.join("\n"))
      .toEqual([]);
    expect(postCutoverProblems.badResponses, postCutoverProblems.badResponses.join("\n"))
      .toEqual([]);
    expect(postCutoverProblems.consoleErrors, postCutoverProblems.consoleErrors.join("\n"))
      .toEqual([]);
    expect(postCutoverProblems.pageErrors, postCutoverProblems.pageErrors.join("\n"))
      .toEqual([]);
    expect(
      postCutoverProblems.unhandledRejections,
      postCutoverProblems.unhandledRejections.join("\n"),
    ).toEqual([]);
    const postCutoverAutosaveTitle = "Post-cutover autosave authority";
    await postCutoverPage.getByRole("textbox", { name: "Project title" })
      .fill(postCutoverAutosaveTitle);
    await expect.poll(() => autosavedProjectTitle(postCutoverPage))
      .toBe(postCutoverAutosaveTitle);
    await postCutoverPage.close();

    // Two deliberately concurrent app tabs can race their ordinary blank-board
    // autosaves. Resolve that independent safety guard explicitly before the
    // PDF continuity probe, then remove the competing app tab from the test.
    const autosaveRecoveryNotice = versionAPage.getByRole("alert")
      .filter({ hasText: "Autosave is paused" });
    const versionAAutosaveTitle = "Version A continuity board";
    await versionAPage.getByRole("textbox", { name: "Project title" })
      .fill(versionAAutosaveTitle);
    await expect(autosaveRecoveryNotice).toBeVisible();
    const resumePrompt = new Promise<string>((resolve) => {
      versionAPage.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      });
    });
    await autosaveRecoveryNotice.getByRole("button", {
      name: "Use this board and resume autosave",
      exact: true,
    }).click();
    expect(await resumePrompt).toContain(
      "Replace the newer autosave saved by another tab with this tab's board",
    );
    await expect(autosaveRecoveryNotice).toBeHidden();
    await expect.poll(() => autosavedProjectTitle(versionAPage)).toBe(versionAAutosaveTitle);
    await expect(versionAPage.getByText("Saved locally", { exact: true })).toBeVisible();

    // First-use equation rendering after cutover must load both the compiled
    // renderer and fixed MathJax runtime from version A's verified cache.
    await versionAPage.getByRole("button", { name: "Insert", exact: true }).click();
    await versionAPage.getByRole("menuitem", { name: "Equation", exact: true }).click();
    await versionAPage.locator("#latex-source").fill("x^2 + 1");
    const equationPreview = versionAPage.locator('.equation-preview img[alt^="Preview of"]');
    await expect(equationPreview).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      () => equationPreview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      { timeout: 30_000 },
    ).toBe(true);
    await versionAPage.getByRole("button", { name: "Close equation editor", exact: true }).click();

    // Mermaid's converter/parser chunks are also first invoked only after B
    // has removed their version-A URLs from the static tree.
    await versionAPage.getByRole("button", { name: "Insert", exact: true }).click();
    await versionAPage.getByRole("menuitem", { name: "Diagram", exact: true }).click();
    const mermaidDialog = versionAPage.getByRole("dialog", {
      name: "Insert Mermaid diagram",
      exact: true,
    });
    await mermaidDialog.getByLabel("Mermaid source", { exact: true })
      .fill("flowchart LR\nA-->B");
    await mermaidDialog.getByRole("button", { name: "Preview", exact: true }).click();
    const mermaidPreview = mermaidDialog.getByRole("img", {
      name: "Preview of the Mermaid diagram",
      exact: true,
    });
    await expect(mermaidPreview).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      () => mermaidPreview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      { timeout: 30_000 },
    ).toBe(true);
    await mermaidDialog.getByRole("button", { name: "Close Mermaid editor", exact: true }).click();

    // GeoGon is a fixed local runtime rather than a Rollup chunk. Exercise its
    // iframe entry and scripts through the old client's cache as well.
    await versionAPage.locator(".App-toolbar__extra-tools-trigger").click();
    await versionAPage.getByTestId("toolbar-math-tools").click();
    const mathTools = versionAPage.getByRole("dialog", { name: "Math tools", exact: true });
    await mathTools.getByRole("switch", { name: "Experimental features", exact: true }).check();
    await versionAPage.getByTestId("math-tool-geogon").click();
    const geoGonDialog = versionAPage.getByRole("dialog", { name: "3D GeoGon", exact: true });
    const geoGonAddButton = versionAPage.frameLocator("iframe.geogon-frame")
      .getByRole("button", { name: "Add", exact: true });
    await expect(
      geoGonAddButton,
      "The pinned local GeoGon iframe should remain usable from version A after cutover",
    ).toBeVisible({ timeout: 30_000 });
    await geoGonDialog.getByRole("button", { name: "Close 3D GeoGon", exact: true }).click();

    // PDF import, pdf.js worker startup, and annotated export are distinct lazy
    // paths. Run the complete flow only after B has replaced the source tree.
    await versionAPage.getByLabel("Open project file").setInputFiles({
      name: "version-a-after-b.pdf",
      mimeType: "application/pdf",
      buffer: await tinyPdfBytes(),
    });
    await expect.poll(async () => ({
      badResponses: [...badResponses],
      consoleErrors: [...consoleErrors],
      errorToasts: await versionAPage.locator(".error-toast").allTextContents(),
      failedRequests: [...failedRequests],
      lazyRequests: requests.filter((url) => isClassroomLazyPath(new URL(url).pathname)),
      pageErrors: [...pageErrors],
      pdfMode: (await versionAPage.locator(".app-shell").getAttribute("class"))
        ?.includes("is-pdf-mode") || false,
      unhandledRejections: [...unhandledRejections],
    }), { timeout: 30_000 }).toMatchObject({
      badResponses: [],
      consoleErrors: [],
      errorToasts: [],
      failedRequests: [],
      pageErrors: [],
      pdfMode: true,
      unhandledRejections: [],
    });
    await expect(versionAPage.locator("#pdf-page-rail .pdf-page-item"))
      .toHaveCount(1, { timeout: 30_000 });
    await versionAPage.getByRole("button", { name: "More export options", exact: true }).click();
    const pdfDownload = versionAPage.waitForEvent("download", { timeout: 90_000 });
    await versionAPage.getByRole("button", { name: /Annotated PDF — expand pages/ }).click();
    const exportedPdf = await PDFDocument.load(await downloadBytes(await pdfDownload));
    expect(exportedPdf.getPageCount()).toBe(1);

    await settleBrowserProblems(versionAPage);
    expect(failedRequests, failedRequests.join("\n")).toEqual([]);
    expect(badResponses, badResponses.join("\n")).toEqual([]);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
    expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
    for (const pattern of [
      /\/assets\/render-latex-/,
      /\/mathjax\/tex-svg\.js$/,
      /\/assets\/safe-mermaid-/,
      /\/geogon\/index\.html$/,
      /\/assets\/import-pdf-/,
      /\/assets\/pdf\.worker(?:\.min)?-/,
      /\/assets\/export-pdf-/,
    ]) {
      const matches = lazyResponses.filter((response) => pattern.test(response.path));
      expect(matches.length, `Missing first-use response for ${pattern}`).toBeGreaterThan(0);
      expect(matches.every((response) => response.fromServiceWorker), JSON.stringify(matches))
        .toBe(true);
    }
    await expect(versionAPage.locator(".editor-host"))
      .toHaveAttribute("data-version-a-editor", "original");
    });

    // This observer shares CacheStorage and can inspect the registration, but
    // it is outside the PatterDraw worker scope and therefore cannot keep
    // version A alive as a controlled client.
    const observerPage = await context.newPage();
    await observerPage.goto(`${fixture.origin}/observer.html`, { waitUntil: "domcontentloaded" });
    expect(await observerPage.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
    await versionAPage.close();

    await expect.poll(async () => observerPage.evaluate(async ({
      registrationScope,
      ownCacheA,
      ownCacheB,
    }) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      const cacheNames = await caches.keys();
      return {
        activeState: registration?.active?.state || null,
        hasCacheA: cacheNames.includes(ownCacheA),
        hasCacheB: cacheNames.includes(ownCacheB),
        waitingState: registration?.waiting?.state || null,
      };
    }, {
      registrationScope: scope,
      ownCacheA: cacheA,
      ownCacheB: cacheB,
    }), { timeout: 15_000 }).toEqual({
      activeState: "activated",
      hasCacheA: true,
      hasCacheB: true,
      waitingState: "installed",
    });

    await test.step("activate B, then install and activate latest version D", async () => {
    // B must remain waiting until both the reintroduced lineage and the still
    // raw rollback lineage close; retaining the registration makes this
    // lifecycle boundary exact.
    await expect.poll(async () => observerPage.evaluate(async (registrationScope) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      return registration?.waiting?.state || null;
    }, scope)).toBe("installed");
    await rollbackPage.close();
    await expect.poll(async () => observerPage.evaluate(async (registrationScope) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      return registration?.waiting?.state || null;
    }, scope)).toBe("installed");
    await rawRollbackPage.close();

    await expect.poll(async () => observerPage.evaluate(async ({
      registrationScope,
      ownCachePrefix,
      neighbourCacheName,
      sentinelUrl,
    }) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      const cacheNames = await caches.keys();
      const sentinel = await (await caches.open(neighbourCacheName)).match(sentinelUrl);
      return {
        activeState: registration?.active?.state || null,
        neighbourBody: sentinel ? await sentinel.text() : null,
        neighbourPresent: cacheNames.includes(neighbourCacheName),
        ownCaches: cacheNames.filter((name) => name.startsWith(ownCachePrefix)).sort(),
        waitingState: registration?.waiting?.state || null,
      };
    }, {
      registrationScope: scope,
      ownCachePrefix: cachePrefix,
      neighbourCacheName: neighbourCache,
      sentinelUrl: neighbourSentinelUrl,
    }), { timeout: 30_000 }).toEqual({
      activeState: "activated",
      neighbourBody: "neighbour-scope-survived",
      neighbourPresent: true,
      ownCaches: [cacheB],
      waitingState: null,
    });

    const versionBPage = await context.newPage();
    await versionBPage.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    await expect(versionBPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect.poll(
      () => versionBPage.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      { timeout: 15_000 },
    ).toBe(true);
    expect(await versionBPage.evaluate(() => caches.keys())).toEqual(
      expect.arrayContaining([cacheB, neighbourCache]),
    );
    await versionBPage.evaluate(async (registrationScope) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      if (!registration) throw new Error("Version B is not registered.");
      await registration.update();
    }, scope);
    await expect.poll(async () => versionBPage.evaluate(async ({
      expectedPaths,
      latestCache,
      obsoleteBlockedCache,
      ownCachePrefix,
      registrationScope,
    }) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      const cacheNames = await caches.keys();
      let latestCacheComplete = false;
      if (cacheNames.includes(latestCache)) {
        const cache = await caches.open(latestCache);
        const cachedPaths = (await cache.keys()).map((request) => request.url).sort();
        latestCacheComplete = JSON.stringify(cachedPaths) === JSON.stringify(expectedPaths);
      }
      return {
        activeState: registration?.active?.state || null,
        hasBlockedC: cacheNames.includes(obsoleteBlockedCache),
        latestCacheComplete,
        ownCaches: cacheNames.filter((name) => name.startsWith(ownCachePrefix)).sort(),
        waitingState: registration?.waiting?.state || null,
      };
    }, {
      expectedPaths: expectedCachedPaths,
      latestCache: cacheD,
      obsoleteBlockedCache: cacheC,
      ownCachePrefix: cachePrefix,
      registrationScope: scope,
    }), { timeout: 90_000 }).toEqual({
      activeState: "activated",
      hasBlockedC: false,
      latestCacheComplete: true,
      ownCaches: [cacheB, cacheD].sort(),
      waitingState: "installed",
    });
    await versionBPage.close();

    await expect.poll(async () => observerPage.evaluate(async ({
      latestCache,
      neighbourCacheName,
      ownCachePrefix,
      registrationScope,
    }) => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope);
      const cacheNames = await caches.keys();
      return {
        activeState: registration?.active?.state || null,
        latestCachePresent: cacheNames.includes(latestCache),
        neighbourPresent: cacheNames.includes(neighbourCacheName),
        ownCaches: cacheNames.filter((name) => name.startsWith(ownCachePrefix)).sort(),
        waitingState: registration?.waiting?.state || null,
      };
    }, {
      latestCache: cacheD,
      neighbourCacheName: neighbourCache,
      ownCachePrefix: cachePrefix,
      registrationScope: scope,
    }), { timeout: 30_000 }).toEqual({
      activeState: "activated",
      latestCachePresent: true,
      neighbourPresent: true,
      ownCaches: [cacheD],
      waitingState: null,
    });

    const versionDPage = await context.newPage();
    await versionDPage.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    await expect(versionDPage.locator(".editor-host .excalidraw")).toBeVisible({
      timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
    });
    await expect(versionDPage.locator('meta[name="patterdraw-fixture-version"]'))
      .toHaveAttribute("content", "D");
    expect(await versionDPage.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);
    await versionDPage.close();
    });
    await observerPage.close();
  } finally {
    await context.close();
    await fixture?.stop();
    await rm(fixtureRoot, { recursive: true, force: true });
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

test("keeps the board usable when the advisory storage-readiness chunk is unavailable", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "The optional-chunk failure boundary is engine-independent and is exercised once against the packaged Chromium build.",
  );

  const { pageErrors, unhandledRejections } = await captureBrowserProblems(page);
  let blockedRequests = 0;
  await page.route(/\/assets\/storage-readiness-[^/]+\.js(?:\?.*)?$/, async (route) => {
    blockedRequests += 1;
    await route.abort("failed");
  });

  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
  await expect(page.locator(".local-readiness-banner")).toContainText(
    "This browser cannot guarantee durable local autosaves",
  );
  await expect(page.getByRole("button", { name: "Protect local work", exact: true }))
    .toBeVisible();
  await settleBrowserProblems(page);

  expect(blockedRequests).toBe(1);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(unhandledRejections, unhandledRejections.join("\n")).toEqual([]);
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
  const speechWorkerRequests = requests.filter(
    (requestUrl) => new URL(requestUrl).pathname.includes("/mathjax/sre/speech-worker.js"),
  );
  expect(speechWorkerRequests.length).toBeGreaterThan(0);
  const speechWorkerSha256 = createHash("sha256").update(await readFile(
    path.resolve("dist/release/mathjax/sre/speech-worker.js"),
  )).digest("hex");
  expect(speechWorkerRequests.every(
    (requestUrl) => new URL(requestUrl).searchParams.get("patterdraw-asset-sha256")
      === speechWorkerSha256,
  )).toBe(true);
  expect(requests.every((requestUrl) => new URL(requestUrl).origin === new URL(page.url()).origin)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/classroom/math/unit-01/patterdraw/");
});

test("opens Slides and adds a slide without remounting the production editor", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);

  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await expect(page.getByRole("checkbox", { name: "Pen mode - prevent touch", exact: true })).toBeHidden();
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

test("uses a Settings-only OBS crop guide around the mounted production editor", async ({ page }) => {
  const { badResponses, consoleErrors, failedRequests, pageErrors, requests, unhandledRejections } = await captureBrowserProblems(page);

  await page.goto(productionRoute, { waitUntil: "domcontentloaded" });
  const editorHost = page.locator(".editor-host");
  const editor = editorHost.locator(".excalidraw");
  await expect(editor).toBeVisible({ timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT });
  await editorHost.evaluate((element) => element.setAttribute("data-production-obs-token", "live-editor"));
  const pageCount = page.context().pages().length;

  await expect(page.locator(".statusbar").getByText("OBS", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("switch", { name: "OBS capture area", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveClass(/is-obs-capture-enabled/);
  expect(page.context().pages()).toHaveLength(pageCount);
  await expect(editorHost).toHaveAttribute("data-production-obs-token", "live-editor");
  await expect(page.locator(".topbar")).toBeVisible();
  const responsiveStatusbarIsHidden = await page.evaluate(() => window.matchMedia(
    "(max-width: 640px), (max-width: 1000px) and (max-height: 500px)",
  ).matches);
  if (responsiveStatusbarIsHidden) {
    await expect(page.locator(".statusbar")).toBeHidden();
  } else {
    await expect(page.locator(".statusbar")).toBeVisible();
  }
  const drawingTools = page.getByRole("region", { name: "Shapes", exact: true });
  await expect(drawingTools).toBeVisible();
  const guide = page.getByRole("region", { name: "OBS 16:9 capture area", exact: true });
  await expect(guide).toHaveAttribute("data-layout", "widescreen");
  const guideFrame = await guide.locator(".obs-capture-guide-frame").boundingBox();
  const toolsFrame = await drawingTools.boundingBox();
  expect(guideFrame).not.toBeNull();
  expect(toolsFrame).not.toBeNull();
  expect((guideFrame?.width || 0) / (guideFrame?.height || 1)).toBeCloseTo(16 / 9, 2);
  expect((toolsFrame?.y || 0) + (toolsFrame?.height || 0)).toBeLessThanOrEqual((guideFrame?.y || 0) - 2);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("switch", { name: "OBS capture area", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-obs-capture-enabled/);
  await expect(guide).toHaveCount(0);
  await expect(drawingTools).toBeVisible();
  await expect(editorHost).toHaveAttribute("data-production-obs-token", "live-editor");

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
  const loadedWorkerResponse = await workerResponse;
  expect(loadedWorkerResponse.status()).toBe(200);
  expect(loadedWorkerResponse.headers()["content-type"]).toMatch(
    /^(?:application|text)\/javascript(?:;|$)/i,
  );
  expect(new URL(loadedWorkerResponse.url()).searchParams.get("patterdraw-worker")).toBe(
    "mjs-mime-v1",
  );

  await expect(page.getByTestId("scene-hydration-input-guard")).toHaveCount(0, {
    timeout: PRODUCTION_EDITOR_MOUNT_TIMEOUT,
  });
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
  const download = page.waitForEvent("download", { timeout: 90_000 });
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

  const saveDownload = page.waitForEvent("download", { timeout: 90_000 });
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
