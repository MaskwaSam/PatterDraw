import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createBlankPdfFile } from "./create-blank-page";

describe("createBlankPdfFile", () => {
  it("creates a one-page PDF with the requested dimensions", async () => {
    const file = await createBlankPdfFile(612, 792);
    const document = await PDFDocument.load(await file.arrayBuffer());
    expect(file.name).toBe("Blank page.pdf");
    expect(file.type).toBe("application/pdf");
    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  });

  it("rejects invalid dimensions", async () => {
    await expect(createBlankPdfFile(0, 792)).rejects.toThrow(/valid dimensions/);
  });
});
