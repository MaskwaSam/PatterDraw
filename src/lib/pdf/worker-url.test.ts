import { describe, expect, it } from "vitest";
import { withPdfWorkerMimeQuery } from "./worker-url";

describe("withPdfWorkerMimeQuery", () => {
  it("adds the MIME cache marker to a plain worker URL", () => {
    expect(withPdfWorkerMimeQuery("/assets/pdf.worker-abc123.mjs")).toBe(
      "/assets/pdf.worker-abc123.mjs?patterdraw-worker=mjs-mime-v1",
    );
  });

  it("preserves an existing worker URL query", () => {
    expect(withPdfWorkerMimeQuery("/assets/pdf.worker-abc123.mjs?asset=local")).toBe(
      "/assets/pdf.worker-abc123.mjs?asset=local&patterdraw-worker=mjs-mime-v1",
    );
  });
});
