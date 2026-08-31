import { beforeEach, describe, expect, it, vi } from "vitest";

const { importPdfMock, inspectPdfFileMock } = vi.hoisted(() => ({
  importPdfMock: vi.fn(),
  inspectPdfFileMock: vi.fn(),
}));

vi.mock("./import-pdf", () => ({
  importPdf: importPdfMock,
  inspectPdfFile: inspectPdfFileMock,
}));

import { PdfEmbeddedImageSafetyError } from "./embedded-image-limits";
import {
  getPdfImportRecovery,
  importPdfCompatibilityCopy,
} from "./import-compatibility";

const rejected = () => new PdfEmbeddedImageSafetyError(
  "content-uninspectable",
  "The source could not be inspected.",
);
const rejectedInspection = {
  sha256: "a".repeat(64),
  pageCount: 2,
};

describe("PDF converted-copy compatibility import", () => {
  beforeEach(() => {
    inspectPdfFileMock.mockReset();
    importPdfMock.mockReset().mockResolvedValue({
      source: { name: "compatibility.pdf" },
      bytes: new Uint8Array([1]),
      scenes: [],
      rasterUsage: { encodedBytes: 0, pixels: 0 },
    });
  });

  it("offers a converted copy only for typed content/image safety failures", () => {
    expect(getPdfImportRecovery(rejected())).toMatchObject({
      kind: "choose-converted-copy",
      code: "content-uninspectable",
    });
    expect(getPdfImportRecovery(new PdfEmbeddedImageSafetyError(
      "source-image-over-budget",
      "too large",
    ))).toMatchObject({ kind: "choose-converted-copy" });
    expect(getPdfImportRecovery(new Error(
      "This PDF's page content could not be checked for safe embedded-image sizes.",
    ))).toBeNull();
  });

  it("keeps worker/timeout failures fail-closed instead of offering a bypass", () => {
    expect(getPdfImportRecovery(new PdfEmbeddedImageSafetyError(
      "safety-worker-unavailable",
      "worker blocked",
    ))).toMatchObject({ kind: "retry-safety-check" });
    expect(getPdfImportRecovery(new PdfEmbeddedImageSafetyError(
      "safety-inspection-timeout",
      "timed out",
    ))).toMatchObject({ kind: "retry-safety-check" });
  });

  it("requires explicit acknowledgement before reading either file", async () => {
    const original = new File(["original"], "lesson.pdf", { type: "application/pdf" });
    const converted = new File(["converted"], "lesson-flat.pdf", { type: "application/pdf" });

    await expect(importPdfCompatibilityCopy(original, converted, {
      originalFailure: rejected(),
      rejectedOriginalInspection: rejectedInspection,
      confirmation: { accepted: true, flatteningAcknowledged: false as true },
    })).rejects.toThrow(/Confirm/i);
    expect(inspectPdfFileMock).not.toHaveBeenCalled();
  });

  it("requires exact page-count mapping and distinct content", async () => {
    const original = new File(["original"], "lesson.pdf", { type: "application/pdf" });
    const converted = new File(["converted"], "lesson-flat.pdf", { type: "application/pdf" });
    inspectPdfFileMock
      .mockResolvedValueOnce({ sha256: "a".repeat(64), pageCount: 5 })
      .mockResolvedValueOnce({ sha256: "b".repeat(64), pageCount: 4 });

    await expect(importPdfCompatibilityCopy(original, converted, {
      originalFailure: rejected(),
      rejectedOriginalInspection: { sha256: "a".repeat(64), pageCount: 5 },
      confirmation: { accepted: true, flatteningAcknowledged: true },
    })).rejects.toThrow(/has 4 pages.*original has 5/i);
    expect(importPdfMock).not.toHaveBeenCalled();
  });

  it("binds recovery to the exact original identity that was rejected", async () => {
    const original = new File(["changed"], "lesson.pdf", { type: "application/pdf" });
    const converted = new File(["converted"], "lesson-flat.pdf", { type: "application/pdf" });
    inspectPdfFileMock.mockResolvedValueOnce({
      sha256: "c".repeat(64),
      pageCount: 2,
    });

    await expect(importPdfCompatibilityCopy(original, converted, {
      originalFailure: rejected(),
      rejectedOriginalInspection: rejectedInspection,
      confirmation: { accepted: true, flatteningAcknowledged: true },
    })).rejects.toThrow(/changed after its rejected import/i);
    expect(inspectPdfFileMock).toHaveBeenCalledOnce();
    expect(importPdfMock).not.toHaveBeenCalled();
  });

  it("runs the converted copy through the complete normal importer", async () => {
    const original = new File(["original"], "Periodic Table.pdf", { type: "application/pdf" });
    const converted = new File(["converted"], "printed.pdf", { type: "application/pdf" });
    const originalInspection = { sha256: "a".repeat(64), pageCount: 2 };
    const convertedInspection = { sha256: "b".repeat(64), pageCount: 2 };
    inspectPdfFileMock
      .mockResolvedValueOnce(originalInspection)
      .mockResolvedValueOnce(convertedInspection);

    const result = await importPdfCompatibilityCopy(original, converted, {
      originalFailure: rejected(),
      rejectedOriginalInspection: originalInspection,
      confirmation: { accepted: true, flatteningAcknowledged: true },
      sourcePageIndices: [1],
      maxPages: 1,
      maxRasterPixelsForImport: 100_000,
    });

    expect(importPdfMock).toHaveBeenCalledWith(converted, expect.objectContaining({
      inspection: convertedInspection,
      sourceName: "Periodic Table (visual compatibility copy).pdf",
      sourcePageIndices: [1],
      maxPages: 1,
      maxRasterPixelsForImport: 100_000,
    }));
    expect(result.original).toEqual({
      name: "Periodic Table.pdf",
      ...originalInspection,
    });
    expect(result.losses).toEqual(expect.arrayContaining([
      expect.stringMatching(/not the rejected original/i),
    ]));
  });

  it("propagates cancellation and normal-import rejection without any fallback", async () => {
    const original = new File(["original"], "lesson.pdf", { type: "application/pdf" });
    const converted = new File(["converted"], "lesson-flat.pdf", { type: "application/pdf" });
    const abort = new DOMException("cancelled", "AbortError");
    inspectPdfFileMock.mockRejectedValueOnce(abort);

    await expect(importPdfCompatibilityCopy(original, converted, {
      originalFailure: rejected(),
      rejectedOriginalInspection: rejectedInspection,
      confirmation: { accepted: true, flatteningAcknowledged: true },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(importPdfMock).not.toHaveBeenCalled();
  });
});
