import {
  inspectPdfEmbeddedImageLimitsInCurrentThread,
  pdfEmbeddedImageFailureCode,
  type PdfEmbeddedImageFailureCode,
} from "./embedded-image-limits";

interface EmbeddedImageWorkerRequest {
  bytes: Uint8Array;
  maxPixels: number;
  maxEdge?: number;
  maxTotalPixels?: number;
  maxTotalEncodedBytes?: number;
}

interface EmbeddedImageWorkerResponse {
  code?: PdfEmbeddedImageFailureCode;
  message?: string;
  name?: string;
  ok: boolean;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<EmbeddedImageWorkerRequest>) => void) | null;
  postMessage(message: EmbeddedImageWorkerResponse): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const {
    bytes,
    maxPixels,
    maxEdge,
    maxTotalPixels,
    maxTotalEncodedBytes,
  } = event.data;
  void inspectPdfEmbeddedImageLimitsInCurrentThread(
    bytes,
    maxPixels,
    maxEdge,
    maxTotalPixels,
    maxTotalEncodedBytes,
  ).then(
    () => workerScope.postMessage({ ok: true }),
    (error) => workerScope.postMessage({
      ok: false,
      ...(pdfEmbeddedImageFailureCode(error)
        ? { code: pdfEmbeddedImageFailureCode(error)! }
        : {}),
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    }),
  );
};
