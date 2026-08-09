import { defineConfig } from "@playwright/test";

const productionPort = Number(process.env.PW_PRODUCTION_PORT || 4174);
if (!Number.isInteger(productionPort) || productionPort < 1024 || productionPort > 65_535) {
  throw new Error(`PW_PRODUCTION_PORT must be an integer between 1024 and 65535 (received ${productionPort}).`);
}

const productionRoute = "/classroom/math/unit-01/patterdraw/";
const productionOrigin = `http://127.0.0.1:${productionPort}`;
const reuseExistingProductionServer = process.env.PW_PRODUCTION_REUSE_SERVER === "1";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: ["**/production-dist.spec.ts", "**/production-ux.spec.ts"],
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report/production", open: "never" }]]
    : "list",
  outputDir: "test-results/production",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
    {
      name: "chromium-mobile-320",
      use: { browserName: "chromium", viewport: { width: 320, height: 568 } },
    },
  ],
  use: {
    baseURL: `${productionOrigin}${productionRoute}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // Build in the exact command Playwright starts. A dedicated port plus
    // reuseExistingServer=false (the default) prevents a stale Vite/preview
    // process from satisfying this gate with unrelated or old output. CI may
    // set PW_PRODUCTION_REUSE_SERVER=1 after recording the independently
    // built dist and starting this same harness with captured logs.
    command: `npm run build && npm run release:package -- --allow-dirty && npm run release:verify -- --allow-dirty && node scripts/serve-production-dist.mjs --dist dist/release --port ${productionPort}`,
    url: `${productionOrigin}${productionRoute}`,
    reuseExistingServer: reuseExistingProductionServer,
    timeout: 120_000,
  },
});
