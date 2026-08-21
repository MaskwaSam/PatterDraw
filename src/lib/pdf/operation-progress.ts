export type PdfOperationKind = "import" | "export";

export type PdfOperationPhase =
  | "reading"
  | "validating"
  | "preflighting"
  | "loading"
  | "measuring"
  | "rendering"
  | "embedding"
  | "saving";

/**
 * Structured, display-ready progress for a local PDF operation.
 *
 * Document and page positions are one-based while work is operating on a
 * specific item. A zero page position denotes document-level work.
 */
export interface PdfOperationProgress {
  operation: PdfOperationKind;
  phase: PdfOperationPhase;
  documentPosition: number;
  documentTotal: number;
  pagePosition: number;
  pageTotal: number;
  documentName?: string;
}

export type PdfOperationProgressCallback = (
  progress: Readonly<PdfOperationProgress>,
) => void;

export function pdfAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The PDF operation was cancelled.", "AbortError");
  }
  const error = new Error("The PDF operation was cancelled.");
  error.name = "AbortError";
  return error;
}

export function throwIfPdfOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : pdfAbortError();
}

export async function awaitPdfOperation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  throwIfPdfOperationAborted(signal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(
      signal.reason instanceof Error ? signal.reason : pdfAbortError(),
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function reportPdfOperationProgress(
  callback: PdfOperationProgressCallback | undefined,
  progress: PdfOperationProgress,
  signal?: AbortSignal,
): void {
  throwIfPdfOperationAborted(signal);
  callback?.(Object.freeze({ ...progress }));
  // A progress callback is permitted to cancel its own operation.
  throwIfPdfOperationAborted(signal);
}
