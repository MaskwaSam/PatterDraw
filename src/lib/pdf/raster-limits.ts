export const MAX_PDF_RASTER_EDGE = 8_192;
export const MAX_PDF_RASTER_PIXELS_PER_PAGE = 16_000_000;
export const MAX_PDF_RASTER_PIXELS_PER_DOCUMENT = 64_000_000;
export const MAX_PDF_PAGE_EDGE_POINTS = 14_400;

export interface PdfPageRasterSize {
  width: number;
  height: number;
}

export function getPdfImportRasterScale(
  pages: readonly PdfPageRasterSize[],
  devicePixelRatio = 1,
): number {
  if (!pages.length) throw new Error("The PDF has no pages.");
  const preferredScale = Math.min(Math.max(devicePixelRatio, 1), 2) * 1.5;
  let scale = preferredScale;
  let totalArea = 0;

  for (const page of pages) {
    if (
      !Number.isFinite(page.width)
      || !Number.isFinite(page.height)
      || page.width <= 0
      || page.height <= 0
      || page.width > MAX_PDF_PAGE_EDGE_POINTS
      || page.height > MAX_PDF_PAGE_EDGE_POINTS
    ) {
      throw new Error("A PDF page has unsupported dimensions.");
    }
    totalArea += page.width * page.height;
    scale = Math.min(
      scale,
      MAX_PDF_RASTER_EDGE / page.width,
      MAX_PDF_RASTER_EDGE / page.height,
      Math.sqrt(MAX_PDF_RASTER_PIXELS_PER_PAGE) / Math.sqrt(page.width) / Math.sqrt(page.height),
    );
  }

  scale = Math.min(
    scale,
    Math.sqrt(MAX_PDF_RASTER_PIXELS_PER_DOCUMENT) / Math.sqrt(totalArea),
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("The PDF is too large to rasterize safely.");
  }
  return scale;
}
