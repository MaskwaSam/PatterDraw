export const PDF_WORKER_CACHE_REVISION = "mjs-mime-v1";

/** Force a fresh worker fetch when a deployment changes worker response metadata. */
export function withPdfWorkerCacheRevision(workerUrl: string): string {
  const separator = workerUrl.includes("?") ? "&" : "?";
  return `${workerUrl}${separator}patterdraw-worker=${PDF_WORKER_CACHE_REVISION}`;
}
