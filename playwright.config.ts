import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  // The production-dist smoke is intentionally run with its own config so
  // the normal Vite development suite remains the fast, full browser gate.
  testIgnore: [
    "**/production-dist.spec.ts",
    "**/production-performance.spec.ts",
    "**/production-pdf-lifecycle.spec.ts",
  ],
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: true,
  retries: 1,
  timeout: 180_000,
  fullyParallel: false,
  workers: 3,
  // Dev-mode module evaluation competes with worker-backed PDF rendering and
  // IndexedDB on constrained hosts. Give those observable boundaries enough
  // time without weakening the per-test 180-second hard ceiling.
  expect: {
    timeout: 60_000,
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      // Route every HTTP(S)/WebSocket origin through a closed local proxy,
      // except the exact Vite origin. `<-loopback>` removes Chromium's broad
      // implicit loopback bypass so literal-IP and alternate-port requests are
      // denied too. Unlike Playwright routing, this preserves the module cache.
      args: [
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=<-loopback>;127.0.0.1:5173",
      ],
    },
    // Recording every cold-development action materially delays Vite's large
    // module graph. Keep the first attempt representative, then collect a full
    // trace on the diagnostic retry without allowing flaky tests to pass.
    trace: "on-first-retry",
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
