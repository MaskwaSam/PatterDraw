type ArchiveOperation =
  | { operation: "zip"; entries: Record<string, Uint8Array>; maxBytes: number }
  | { operation: "unzip"; bytes: Uint8Array; maxBytes: number };

/** Bound worker hangs while leaving headroom for a 150 MiB archive on classroom hardware. */
export const PROJECT_ARCHIVE_WORKER_TIMEOUT_MS = 60_000;

interface ArchiveWorkerResponse {
  id: number;
  ok: boolean;
  message?: string;
  archive?: Uint8Array;
  entries?: Record<string, Uint8Array>;
}

/**
 * Worker startup and transport failures are infrastructure errors. Production
 * browser builds deliberately do not retry them with synchronous parsing:
 * doing so would move untrusted archive work onto the UI thread after the
 * isolation boundary failed. Development/test builds retain the synchronous
 * path so local tooling and non-browser fixtures remain usable. Keep this
 * distinct from a response with `ok: false`: that response came from a
 * running worker and represents a validation/semantic verdict that must not
 * be retried with another engine either.
 */
class ArchiveWorkerInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveWorkerInfrastructureError";
  }
}

let nextRequestId = 1;

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : abortError();
  }
}

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined";
}

function canUseArchiveWorker(): boolean {
  return isBrowserRuntime() && typeof Worker === "function";
}

function canFallbackToSynchronousArchive(): boolean {
  return import.meta.env.PROD !== true && import.meta.env.MODE !== "production";
}

function runArchiveWorker(
  operation: ArchiveOperation,
  signal?: AbortSignal,
): Promise<ArchiveWorkerResponse> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId;
    nextRequestId += 1;
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./project-archive.worker.ts", import.meta.url),
        { type: "module", name: "patterdraw-project-archive" },
      );
    } catch (error) {
      reject(new ArchiveWorkerInfrastructureError(
        error instanceof Error && error.message
          ? error.message
          : "Project archive worker could not be started.",
      ));
      return;
    }
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const resolveOnce = (response: ArchiveWorkerResponse) => {
      if (settled) return;
      settled = true;
      finish();
      resolve(response);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };
    const onAbort = () => {
      rejectOnce(signal?.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<ArchiveWorkerResponse>) => {
      const response = event.data;
      if (!response || response.id !== requestId) return;
      if (typeof response.ok !== "boolean") {
        rejectOnce(new ArchiveWorkerInfrastructureError(
          "Project archive worker returned an invalid response.",
        ));
        return;
      }
      resolveOnce(response);
    };
    worker.onerror = (event) => {
      rejectOnce(new ArchiveWorkerInfrastructureError(
        event.message || "Project archive worker failed.",
      ));
    };
    worker.onmessageerror = () => {
      rejectOnce(new ArchiveWorkerInfrastructureError(
        "Project archive worker returned unreadable data.",
      ));
    };

    timeoutId = setTimeout(() => {
      rejectOnce(new ArchiveWorkerInfrastructureError(
        "Project archive worker timed out.",
      ));
    }, PROJECT_ARCHIVE_WORKER_TIMEOUT_MS);

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
      rejectOnce(new ArchiveWorkerInfrastructureError(
        error instanceof Error && error.message
          ? error.message
          : "Project archive worker could not receive the request.",
      ));
    }
  });
}

function isArchiveWorkerInfrastructureError(error: unknown): boolean {
  return error instanceof ArchiveWorkerInfrastructureError;
}

export async function createProjectArchive(
  entries: Record<string, Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!canUseArchiveWorker()) {
    if (isBrowserRuntime() && !canFallbackToSynchronousArchive()) {
      throw new ArchiveWorkerInfrastructureError("Project archive worker is unavailable.");
    }
    const { createProjectArchiveSync } = await import("./project-archive-engine");
    return createProjectArchiveSync(entries, maxBytes);
  }
  try {
    const response = await runArchiveWorker({ operation: "zip", entries, maxBytes });
    if (!response.ok) {
      throw new Error(response.message || "Project archive processing failed.");
    }
    if (!response.archive) {
      throw new ArchiveWorkerInfrastructureError("Project archive worker returned no data.");
    }
    return response.archive;
  } catch (error) {
    if (!isArchiveWorkerInfrastructureError(error)) throw error;
    if (isBrowserRuntime() && !canFallbackToSynchronousArchive()) throw error;
    const { createProjectArchiveSync } = await import("./project-archive-engine");
    return createProjectArchiveSync(entries, maxBytes);
  }
}

export async function extractProjectArchive(
  bytes: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  throwIfAborted(signal);
  if (!canUseArchiveWorker()) {
    if (isBrowserRuntime() && !canFallbackToSynchronousArchive()) {
      throw new ArchiveWorkerInfrastructureError("Project archive worker is unavailable.");
    }
    const { extractProjectArchiveSync } = await import("./project-archive-engine");
    throwIfAborted(signal);
    const entries = extractProjectArchiveSync(bytes, maxBytes);
    throwIfAborted(signal);
    return entries;
  }
  try {
    const response = await runArchiveWorker({ operation: "unzip", bytes, maxBytes }, signal);
    throwIfAborted(signal);
    if (!response.ok) {
      throw new Error(response.message || "Project archive processing failed.");
    }
    if (!response.entries) {
      throw new ArchiveWorkerInfrastructureError("Project archive worker returned no entries.");
    }
    return response.entries;
  } catch (error) {
    if (!isArchiveWorkerInfrastructureError(error)) throw error;
    if (isBrowserRuntime() && !canFallbackToSynchronousArchive()) {
      // Abort is still allowed to win if it raced with infrastructure failure.
      throwIfAborted(signal);
      throw error;
    }
    // Abort must win over recovery. The synchronous engine has the same
    // pre/post-operation checks as the no-worker path, but cannot be
    // interrupted while fflate is executing.
    throwIfAborted(signal);
    const { extractProjectArchiveSync } = await import("./project-archive-engine");
    throwIfAborted(signal);
    const entries = extractProjectArchiveSync(bytes, maxBytes);
    throwIfAborted(signal);
    return entries;
  }
}
