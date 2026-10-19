import { defineConfig } from "@playwright/test";

// Run after npm run build to exercise the lazy calculator under production CSP
// and a nested portable base path, independent of Vite's development server.
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "calculator.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results/calculator-production",
  use: {
    baseURL: "http://127.0.0.1:4178/classroom/math/unit-01/patterdraw/",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "node scripts/serve-production-dist.mjs --dist dist --port 4178",
    url: "http://127.0.0.1:4178/classroom/math/unit-01/patterdraw/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
