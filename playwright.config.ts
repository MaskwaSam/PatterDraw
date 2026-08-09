import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  // The production-dist smoke is intentionally run with its own config so
  // the normal Vite development suite remains the fast, full browser gate.
  testIgnore: "**/production-dist.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Keep the dev harness deterministic: an already-running process must not
    // silently satisfy the suite with a different checkout or stale bundle.
    command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
