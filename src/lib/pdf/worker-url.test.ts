import { describe, expect, it } from "vitest";
import {
  PDF_WORKER_CACHE_REVISION,
  withPdfWorkerCacheRevision,
} from "./worker-url";

describe("withPdfWorkerCacheRevision", () => {
  it("adds a stable cache revision to the built worker URL", () => {
    expect(withPdfWorkerCacheRevision("./assets/pdf.worker.mjs"))
      .toBe(`./assets/pdf.worker.mjs?patterdraw-worker=${PDF_WORKER_CACHE_REVISION}`);
  });

  it("preserves Vite development query parameters", () => {
    expect(withPdfWorkerCacheRevision("/@fs/pdf.worker.mjs?v=abc123"))
      .toBe(`/@fs/pdf.worker.mjs?v=abc123&patterdraw-worker=${PDF_WORKER_CACHE_REVISION}`);
  });
});
