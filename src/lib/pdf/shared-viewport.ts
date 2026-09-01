export const MIN_SHARED_PDF_ZOOM = 0.1;
export const MAX_SHARED_PDF_ZOOM = 30;

export interface PdfViewportTarget {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CenteredPdfViewport {
  readonly zoom: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export function normalizeSharedPdfZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SHARED_PDF_ZOOM, Math.max(MIN_SHARED_PDF_ZOOM, value));
}

/**
 * Centers a PDF background at an exact scale. Excalidraw projects scene
 * coordinates as `(scene + scroll) * zoom + offset`; targeting the viewport
 * midpoint cancels the offset and leaves this small, deterministic transform.
 */
export function centeredPdfViewport(
  target: PdfViewportTarget,
  viewportWidth: number,
  viewportHeight: number,
  requestedZoom: number,
): CenteredPdfViewport {
  const zoom = normalizeSharedPdfZoom(requestedZoom);
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  return {
    zoom,
    scrollX: width / (2 * zoom) - (target.x + target.width / 2),
    scrollY: height / (2 * zoom) - (target.y + target.height / 2),
  };
}
