import { PDFDocument } from "pdf-lib";

export async function createBlankPdfFile(width: number, height: number): Promise<File> {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Blank PDF pages need valid dimensions.");
  }
  const document = await PDFDocument.create();
  document.addPage([width, height]);
  const bytes = Uint8Array.from(await document.save());
  return new File([bytes.buffer], "Blank page.pdf", { type: "application/pdf" });
}
