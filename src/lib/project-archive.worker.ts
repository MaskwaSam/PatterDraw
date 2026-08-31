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

interface PreflightRequest {
  id: number;
  operation: "preflight";
}

type ArchiveRequest = ZipRequest | UnzipRequest | PreflightRequest;

interface ArchiveSuccess {
  id: number;
  ok: true;
  archive?: Uint8Array;
  entries?: Record<string, Uint8Array>;
  ready?: boolean;
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
    if (request.operation === "preflight") {
      // Exercise the same engine used by Save and Open, not just worker
      // startup. This tiny local round trip proves compression, extraction,
      // transfer, and validation are all available before classroom work.
      const marker = new Uint8Array([0x50, 0x44, 0x52, 0x31]);
      const archive = createProjectArchiveSync(
        { "preflight.bin": marker },
        4_096,
      );
      const entries = extractProjectArchiveSync(archive, 4_096);
      const restored = entries["preflight.bin"];
      if (
        !restored
        || restored.byteLength !== marker.byteLength
        || restored.some((byte, index) => byte !== marker[index])
      ) {
        throw new Error("Project archive worker failed its local round-trip check.");
      }
      workerScope.postMessage({ id: request.id, ok: true, ready: true });
      return;
    }
    if (request.operation === "zip") {
      const archive = createProjectArchiveSync(request.entries, request.maxBytes);
      workerScope.postMessage(
        { id: request.id, ok: true, archive },
        [archive.buffer as ArrayBuffer],
      );
      return;
    }
    if (request.operation === "unzip") {
      const entries = extractProjectArchiveSync(request.bytes, request.maxBytes);
      workerScope.postMessage(
        { id: request.id, ok: true, entries },
        Object.values(entries).map((entry) => entry.buffer as ArrayBuffer),
      );
      return;
    }
    throw new Error("Project archive worker received an unsupported operation.");
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
