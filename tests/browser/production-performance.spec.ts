import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const productionRoute = "/classroom/math/unit-01/patterdraw/";
const productionServerScript = fileURLToPath(
  new URL("../../scripts/serve-production-dist.mjs", import.meta.url),
);

const COLD_START_BUDGET = {
  domContentLoadedMs: 6_000,
  firstContentfulPaintMs: 6_000,
  loadEventMs: 10_000,
  editorReadyMs: 15_000,
  // Full feature continuity is deliberately post-load and separately bounded;
  // it must never be charged against the usable editor's 15-second gate.
  continuityReadyMs: 60_000,
  continuityCacheBytes: 50 * 1024 * 1024,
  continuityEntryCount: 560,
  continuityPackBytes: 24 * 1024 * 1024,
  continuityPackResponseCount: 1,
  appShellBytes: 5 * 1024 * 1024,
  coreNetworkResponseCount: 45,
  coreNetworkBodyBytes: 5 * 1024 * 1024,
  totalBlockingMs: 4_000,
  longestTaskMs: 2_000,
  // CDP is attached to the page target. This deliberately gates the usable
  // editor's renderer, not the separate service-worker pack extraction.
  rendererHeapBytes: 128 * 1024 * 1024,
} as const;

type ColdStartMetrics = {
  appShellBytes: number;
  continuityCacheBytes: number;
  continuityEntryCount: number;
  continuityPackBodyBytes: number;
  continuityPackBytes: number;
  continuityPackResponseCount: number;
  continuityReadyMs: number;
  coreNetworkBodyBytes: number;
  coreNetworkResponseCount: number;
  domContentLoadedMs: number;
  editorReadyMs: number;
  firstContentfulPaintMs: number;
  rendererHeapBytes: number;
  loadEventMs: number;
  longTaskObserverSupported: boolean;
  longestTaskMs: number;
  totalNetworkBodyBytes: number;
  totalNetworkResponseCount: number;
  totalBlockingMs: number;
};

type PerformanceServerMetrics = {
  bodyBytes: number;
  completedResponseCount: number;
  profile: {
    downloadBytesPerSecond: number;
    latencyMs: number;
  };
  requestCount: number;
  requests: Array<{
    bodyBytes: number;
    completedResponseCount: number;
    relativePath: string;
    requestCount: number;
  }>;
  startedAt: number;
};

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a packaged performance fixture port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startPerformanceFixture(dist: string): Promise<{
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
    "--test-performance-profile",
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
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(output || `Performance fixture exited with ${child.exitCode}.`);
      }
      try {
        const response = await fetch(`${origin}${productionRoute}`);
        if (response.ok) return { origin, stop };
      } catch {
        // The dedicated server has not bound its loopback listener yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Performance fixture did not become ready. ${output}`.trim());
  } catch (error) {
    await stop();
    throw error;
  }
}

test("keeps a fresh packaged board responsive under four-times CPU throttling", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const productionDist = path.resolve("dist/release");
  const fixture = await startPerformanceFixture(productionDist);
  const fixtureRoute = `${fixture.origin}${productionRoute}`;
  const performanceToken = randomBytes(16).toString("hex");
  const browserProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserProblems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserProblems.push(`page: ${error.stack || error.message}`));
  page.on("requestfailed", (request) => {
    browserProblems.push(`request: ${request.url()} (${request.failure()?.errorText || "unknown"})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) browserProblems.push(`response: ${response.status()} ${response.url()}`);
  });

  await page.addInitScript(() => {
    const target = window as Window & { __patterdrawColdStartLongTasks?: number[] };
    target.__patterdrawColdStartLongTasks = [];
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        target.__patterdrawColdStartLongTasks?.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    // The start endpoint sets an HttpOnly, scope-bounded cookie. Every GET file
    // response carrying it is shaped and counted by the server, including
    // service-worker install fetches invisible to page-scoped timing APIs.
    const profileResponse = await page.goto(
      `${fixtureRoute}__patterdraw_test/performance/start?token=${performanceToken}`,
      { waitUntil: "load" },
    );
    expect(profileResponse?.status()).toBe(200);
    const configuredProfile = await profileResponse?.json() as {
      profile: PerformanceServerMetrics["profile"];
      started: boolean;
    };
    expect(configuredProfile).toEqual({
      profile: {
        downloadBytesPerSecond: (10 * 1024 * 1024) / 8,
        latencyMs: 40,
      },
      started: true,
    });
    // The unmeasured control endpoint precedes the cold application visit.
    // Clearing HTTP cache here retains the session cookie.
    await cdp.send("Network.clearBrowserCache");

    const response = await page.goto(fixtureRoute, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    try {
      await expect(page.locator(".editor-host .excalidraw")).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      throw new Error(
        `The packaged editor missed its 15-second readiness budget.\n${browserProblems.join("\n")}`,
        { cause: error },
      );
    }
    const editorReadyMs = await page.evaluate(() => performance.now());
    await page.waitForLoadState("load");
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (!("serviceWorker" in navigator)) throw new Error("Service workers are unavailable.");
      await navigator.serviceWorker.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const continuityReadyMs = await page.evaluate(() => performance.now());
    // Read generated metadata from the package instead of issuing an extra
    // browser fetch that would contaminate the measured request totals.
    const workerSource = await readFile(path.join(productionDist, "service-worker.js"), "utf8");
    const shellBytes = Number(/const PRECACHE_TOTAL_BYTES = (\d+);/.exec(workerSource)?.[1]);
    const shellPathsSource = /const PRECACHE = (\[[^;]+\]);/.exec(workerSource)?.[1];
    const continuityBytes = Number(/const CONTINUITY_TOTAL_BYTES = (\d+);/.exec(workerSource)?.[1]);
    const continuityPathsSource = /const CONTINUITY = (\[[^;]+\]);/.exec(workerSource)?.[1];
    const continuityPackSource = /const CONTINUITY_PACK = (\{[^;]+\});/.exec(workerSource)?.[1];
    if (
      !Number.isSafeInteger(shellBytes)
      || !shellPathsSource
      || !Number.isSafeInteger(continuityBytes)
      || !continuityPathsSource
      || !continuityPackSource
    ) {
      throw new Error("Generated worker is missing measurable shell or continuity metadata.");
    }
    const shellPaths = (JSON.parse(shellPathsSource) as Array<{ path: string }>)
      .map((entry) => entry.path);
    const continuityPaths = JSON.parse(continuityPathsSource) as Array<{ path: string }>;
    const continuityPack = JSON.parse(continuityPackSource) as { bytes: number; path: string };

    const readPerformanceServerMetrics = () => page.evaluate(async (token) => {
      const response = await fetch(`./__patterdraw_test/performance/metrics?token=${token}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Unable to read cold-start accounting (${response.status}).`);
      }
      return response.json() as Promise<PerformanceServerMetrics>;
    }, performanceToken);
    let performanceServerMetrics = await readPerformanceServerMetrics();
    await expect.poll(async () => {
      performanceServerMetrics = await readPerformanceServerMetrics();
      return performanceServerMetrics.completedResponseCount === performanceServerMetrics.requestCount;
    }, {
      message: "Every page and service-worker cold-start response must finish before byte accounting.",
      timeout: 10_000,
    }).toBe(true);
    const serverMetricsByPath = new Map(
      performanceServerMetrics.requests.map((entry) => [entry.relativePath, entry]),
    );
    const repeatedTransferredShellPaths = shellPaths
      .map((entry) => entry.slice(2))
      .filter((relativePath) => relativePath !== "index.html")
      .filter((relativePath) => (serverMetricsByPath.get(relativePath)?.requestCount || 0) > 1);
    const indexTransfers = serverMetricsByPath.get("index.html");
    const workerTransfers = serverMetricsByPath.get("service-worker.js");
    const continuityPackTransfers = serverMetricsByPath.get(continuityPack.path.slice(2));
    const coreNetworkBodyBytes = performanceServerMetrics.bodyBytes
      - (continuityPackTransfers?.bodyBytes || 0);
    const coreNetworkResponseCount = performanceServerMetrics.requestCount
      - (continuityPackTransfers?.requestCount || 0);

    const heap = await cdp.send("Runtime.getHeapUsage") as { usedSize: number };
    const metrics = await page.evaluate(([heapBytes, measuredEditorReadyMs, measuredContinuityReadyMs, appShellBytes, measuredContinuityBytes, continuityEntryCount, continuityPackBytes, continuityPackBodyBytes, continuityPackResponseCount, measuredCoreNetworkBodyBytes, measuredCoreNetworkResponseCount, totalNetworkBodyBytes, totalNetworkResponseCount]): ColdStartMetrics => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const longTasks = (
        window as Window & { __patterdrawColdStartLongTasks?: number[] }
      ).__patterdrawColdStartLongTasks || [];
      const firstContentfulPaint = performance.getEntriesByName("first-contentful-paint")[0];
      return {
        appShellBytes,
        continuityCacheBytes: appShellBytes + measuredContinuityBytes,
        continuityEntryCount,
        continuityPackBodyBytes,
        continuityPackBytes,
        continuityPackResponseCount,
        continuityReadyMs: measuredContinuityReadyMs,
        coreNetworkBodyBytes: measuredCoreNetworkBodyBytes,
        coreNetworkResponseCount: measuredCoreNetworkResponseCount,
        domContentLoadedMs: navigation.domContentLoadedEventEnd,
        editorReadyMs: measuredEditorReadyMs,
        firstContentfulPaintMs: firstContentfulPaint?.startTime ?? Number.POSITIVE_INFINITY,
        rendererHeapBytes: heapBytes,
        loadEventMs: navigation.loadEventEnd,
        longTaskObserverSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
        longestTaskMs: Math.max(0, ...longTasks),
        totalNetworkBodyBytes,
        totalNetworkResponseCount,
        totalBlockingMs: longTasks.reduce(
          (total, duration) => total + Math.max(0, duration - 50),
          0,
        ),
      };
    }, [
      heap.usedSize,
      editorReadyMs,
      continuityReadyMs,
      shellBytes,
      continuityBytes,
      continuityPaths.length,
      continuityPack.bytes,
      continuityPackTransfers?.bodyBytes || 0,
      continuityPackTransfers?.requestCount || 0,
      coreNetworkBodyBytes,
      coreNetworkResponseCount,
      performanceServerMetrics.bodyBytes,
      performanceServerMetrics.requestCount,
    ]);

    await testInfo.attach("cold-start-metrics.json", {
      body: Buffer.from(`${JSON.stringify({
        budgets: COLD_START_BUDGET,
        metrics,
        network: performanceServerMetrics,
      }, null, 2)}\n`),
      contentType: "application/json",
    });
    console.info(`[patterdraw-cold-start] ${JSON.stringify(metrics)}`);

    expect(browserProblems, browserProblems.join("\n")).toEqual([]);
    expect(metrics.domContentLoadedMs).toBeLessThanOrEqual(COLD_START_BUDGET.domContentLoadedMs);
    expect(metrics.firstContentfulPaintMs).toBeLessThanOrEqual(
      COLD_START_BUDGET.firstContentfulPaintMs,
    );
    expect(metrics.loadEventMs).toBeLessThanOrEqual(COLD_START_BUDGET.loadEventMs);
    expect(metrics.editorReadyMs).toBeLessThanOrEqual(COLD_START_BUDGET.editorReadyMs);
    expect(metrics.continuityReadyMs).toBeLessThanOrEqual(COLD_START_BUDGET.continuityReadyMs);
    expect(metrics.appShellBytes).toBeLessThanOrEqual(COLD_START_BUDGET.appShellBytes);
    expect(metrics.continuityCacheBytes).toBeLessThanOrEqual(
      COLD_START_BUDGET.continuityCacheBytes,
    );
    expect(metrics.continuityEntryCount).toBeLessThanOrEqual(
      COLD_START_BUDGET.continuityEntryCount,
    );
    expect(metrics.continuityPackBytes).toBeLessThanOrEqual(
      COLD_START_BUDGET.continuityPackBytes,
    );
    expect(metrics.continuityPackBodyBytes).toBe(metrics.continuityPackBytes);
    expect(metrics.continuityPackResponseCount).toBe(
      COLD_START_BUDGET.continuityPackResponseCount,
    );
    expect(shellPaths.some((entry) => /pdf\.worker|mathjax|mermaid|geogon/i.test(entry)))
      .toBe(false);
    expect(performanceServerMetrics.profile).toEqual({
      downloadBytesPerSecond: (10 * 1024 * 1024) / 8,
      latencyMs: 40,
    });
    expect(performanceServerMetrics.completedResponseCount).toBe(
      performanceServerMetrics.requestCount,
    );
    // One index response is the navigation; the second is the worker's
    // mandatory cache:"reload" install fetch. This proves that the worker's
    // traffic is present in the same totals as the page's cold-start traffic.
    expect(indexTransfers?.requestCount).toBe(2);
    expect(indexTransfers?.completedResponseCount).toBe(2);
    expect(workerTransfers?.requestCount).toBeGreaterThanOrEqual(1);
    expect(workerTransfers?.completedResponseCount).toBe(workerTransfers?.requestCount);
    expect(
      repeatedTransferredShellPaths,
      repeatedTransferredShellPaths.join("\n"),
    ).toEqual([]);
    expect(metrics.coreNetworkResponseCount).toBeLessThanOrEqual(
      COLD_START_BUDGET.coreNetworkResponseCount,
    );
    expect(metrics.coreNetworkBodyBytes).toBeGreaterThan(0);
    expect(metrics.coreNetworkBodyBytes).toBeLessThanOrEqual(
      COLD_START_BUDGET.coreNetworkBodyBytes,
    );
    expect(metrics.longTaskObserverSupported).toBe(true);
    expect(metrics.longestTaskMs).toBeLessThanOrEqual(COLD_START_BUDGET.longestTaskMs);
    expect(metrics.totalBlockingMs).toBeLessThanOrEqual(COLD_START_BUDGET.totalBlockingMs);
    expect(metrics.rendererHeapBytes).toBeLessThanOrEqual(
      COLD_START_BUDGET.rendererHeapBytes,
    );
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
    await cdp.detach();
    await fixture.stop();
  }
});
