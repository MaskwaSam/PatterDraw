const PDF_WORKER_MIME_QUERY = "patterdraw-worker=mjs-mime-v1";

/**
 * Keeps the PDF worker request cache-distinct from older deployments whose
 * NGINX configuration may have cached .mjs with a non-JavaScript MIME type.
 */
export function withPdfWorkerMimeQuery(workerUrl: string): string {
  return `${workerUrl}${workerUrl.includes("?") ? "&" : "?"}${PDF_WORKER_MIME_QUERY}`;
}
