import {
  createProjectArchiveSync,
  extractProjectArchiveSync,
} from "./project-archive-engine";

interface ZipRequest {
  id: number;
  operation: "zip";
  entries: Record<string, Uint8Array>;
  maxBytes: number;
}

interface UnzipRequest {
  id: number;
  operation: "unzip";
  bytes: Uint8Array;
  maxBytes: number;
}

type ArchiveRequest = ZipRequest | UnzipRequest;

interface ArchiveSuccess {
  id: number;
  ok: true;
  archive?: Uint8Array;
  entries?: Record<string, Uint8Array>;
}

interface ArchiveFailure {
  id: number;
  ok: false;
  message: string;
}

type ArchiveResponse = ArchiveSuccess | ArchiveFailure;

interface WorkerScope {
  onmessage: ((event: MessageEvent<ArchiveRequest>) => void) | null;
  postMessage(message: ArchiveResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.operation === "zip") {
      const archive = createProjectArchiveSync(request.entries, request.maxBytes);
      workerScope.postMessage(
        { id: request.id, ok: true, archive },
        [archive.buffer as ArrayBuffer],
      );
      return;
    }
    const entries = extractProjectArchiveSync(request.bytes, request.maxBytes);
    workerScope.postMessage(
      { id: request.id, ok: true, entries },
      Object.values(entries).map((entry) => entry.buffer as ArrayBuffer),
    );
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
