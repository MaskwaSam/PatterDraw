type ArchiveOperation =
  | { operation: "zip"; entries: Record<string, Uint8Array>; maxBytes: number }
  | { operation: "unzip"; bytes: Uint8Array; maxBytes: number };

interface ArchiveWorkerResponse {
  id: number;
  ok: boolean;
  message?: string;
  archive?: Uint8Array;
  entries?: Record<string, Uint8Array>;
}

let nextRequestId = 1;

function canUseArchiveWorker(): boolean {
  return typeof window !== "undefined" && typeof Worker === "function";
}

function runArchiveWorker(operation: ArchiveOperation): Promise<ArchiveWorkerResponse> {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId;
    nextRequestId += 1;
    const worker = new Worker(
      new URL("./project-archive.worker.ts", import.meta.url),
      { type: "module", name: "patterdraw-project-archive" },
    );
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<ArchiveWorkerResponse>) => {
      if (event.data.id !== requestId) return;
      finish();
      if (!event.data.ok) {
        reject(new Error(event.data.message || "Project archive processing failed."));
        return;
      }
      resolve(event.data);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Project archive worker failed."));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("Project archive worker returned unreadable data."));
    };

    try {
      if (operation.operation === "zip") {
        const transferableEntries = Object.fromEntries(
          Object.entries(operation.entries).map(([path, bytes]) => [path, bytes.slice()]),
        );
        worker.postMessage(
          { id: requestId, ...operation, entries: transferableEntries },
          Object.values(transferableEntries).map((entry) => entry.buffer as ArrayBuffer),
        );
        return;
      }
      const transferableBytes = operation.bytes.slice();
      worker.postMessage(
        { id: requestId, ...operation, bytes: transferableBytes },
        [transferableBytes.buffer as ArrayBuffer],
      );
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export async function createProjectArchive(
  entries: Record<string, Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!canUseArchiveWorker()) {
    const { createProjectArchiveSync } = await import("./project-archive-engine");
    return createProjectArchiveSync(entries, maxBytes);
  }
  const response = await runArchiveWorker({ operation: "zip", entries, maxBytes });
  if (!response.archive) throw new Error("Project archive worker returned no data.");
  return response.archive;
}

export async function extractProjectArchive(
  bytes: Uint8Array,
  maxBytes: number,
): Promise<Record<string, Uint8Array>> {
  if (!canUseArchiveWorker()) {
    const { extractProjectArchiveSync } = await import("./project-archive-engine");
    return extractProjectArchiveSync(bytes, maxBytes);
  }
  const response = await runArchiveWorker({ operation: "unzip", bytes, maxBytes });
  if (!response.entries) throw new Error("Project archive worker returned no entries.");
  return response.entries;
}
