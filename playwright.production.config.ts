import { defineConfig } from "@playwright/test";

const productionPort = Number(process.env.PW_PRODUCTION_PORT || 4174);
if (!Number.isInteger(productionPort) || productionPort < 1024 || productionPort > 65_535) {
  throw new Error(`PW_PRODUCTION_PORT must be an integer between 1024 and 65535 (received ${productionPort}).`);
}

const productionRoute = "/classroom/math/unit-01/patterdraw/";
const productionOrigin = `http://127.0.0.1:${productionPort}`;
const reuseExistingProductionServer = process.env.PW_PRODUCTION_REUSE_SERVER === "1";
const productionDistSpec = "**/production-dist.spec.ts";
const productionUxSpec = "**/production-ux.spec.ts";
const imageEmbedSafetySpec = "**/image-embed-safety.spec.ts";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: [
    productionDistSpec,
    productionUxSpec,
    imageEmbedSafetySpec,
  ],
  // Packaged PDF/MathJax flows and cross-engine page setup are intentionally
  // serial. Allow constrained CI hosts time to finish without accepting a
  // flaky retry as green.
  timeout: 180_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: true,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // Production assertions often observe worker-backed rasterization and
  // IndexedDB commits. Keep Playwright's 5-second default from turning a
  // completed UI action into a false persistence failure on constrained hosts.
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report/production", open: "never" }]]
    : "list",
  outputDir: "test-results/production",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "firefox-dist",
      // The adversarial file/clipboard tests synthesize browser-native
      // DataTransfer FileLists, whose constructors are not interoperable in
      // Playwright's Firefox/WebKit environments. Run those packaged-boundary
      // probes once in Chromium. Dist and UX get separate browser workers so
      // a stressed engine cannot carry a degraded context across file scopes.
      testMatch: productionDistSpec,
      use: { browserName: "firefox" },
    },
    {
      name: "firefox-ux",
      testMatch: productionUxSpec,
      use: { browserName: "firefox" },
    },
    {
      name: "webkit-dist",
      testMatch: productionDistSpec,
      use: { browserName: "webkit" },
    },
    {
      name: "webkit-ux",
      testMatch: productionUxSpec,
      use: { browserName: "webkit" },
    },
    {
      name: "chromium-mobile-320",
      testMatch: [productionDistSpec, productionUxSpec],
      use: { browserName: "chromium", viewport: { width: 320, height: 568 } },
    },
  ],
  use: {
    baseURL: `${productionOrigin}${productionRoute}`,
    viewport: { width: 1440, height: 900 },
    // Avoid recording every production action up front. A failing first pass
    // is still a hard failure via failOnFlakyTests, while its retry captures a
    // complete diagnostic trace without starving Firefox/WebKit page setup.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: {
    // Build in the exact command Playwright starts. A dedicated port plus
    // reuseExistingServer=false (the default) prevents a stale Vite/preview
    // process from satisfying this gate with unrelated or old output. CI may
    // set PW_PRODUCTION_REUSE_SERVER=1 after recording the independently
    // built dist and starting this same harness with captured logs.
    command: `npm run release:package -- --allow-dirty && npm run release:verify -- --allow-dirty && node scripts/serve-production-dist.mjs --dist dist/release --port ${productionPort}`,
    url: `${productionOrigin}${productionRoute}`,
    reuseExistingServer: reuseExistingProductionServer,
    // A clean package performs a full production build plus deterministic
    // release hashing before the server starts. Constrained classroom/CI
    // hosts can legitimately need more than two minutes for that work.
    timeout: 300_000,
  },
});
