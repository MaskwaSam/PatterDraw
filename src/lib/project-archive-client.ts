type ArchiveOperation =
  | { operation: "zip"; entries: Record<string, Uint8Array>; maxBytes: number }
  | { operation: "unzip"; bytes: Uint8Array; maxBytes: number }
  | { operation: "preflight" };

/** Bound worker hangs while leaving headroom for a 150 MiB archive on classroom hardware. */
export const PROJECT_ARCHIVE_WORKER_TIMEOUT_MS = 60_000;
/** A readiness check should fail quickly enough to remain a startup advisory. */
export const PROJECT_ARCHIVE_PREFLIGHT_TIMEOUT_MS = 5_000;

interface ArchiveWorkerResponse {
  id: number;
  ok: boolean;
  message?: string;
  archive?: Uint8Array;
  entries?: Record<string, Uint8Array>;
  ready?: boolean;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isArchiveEntries(value: unknown): value is Record<string, Uint8Array> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isUint8Array);
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
  timeoutMs = PROJECT_ARCHIVE_WORKER_TIMEOUT_MS,
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
    }, timeoutMs);

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
      if (operation.operation === "preflight") {
        worker.postMessage({ id: requestId, ...operation });
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

export type ProjectArchiveWorkerReadiness = Readonly<
  | { available: true }
  | { available: false; message: string }
>;

/**
 * Start the exact production module worker and complete a round trip before
 * students depend on Save/Open. Unsupported or blocked workers are reported
 * as a capability result rather than throwing; caller cancellation still
 * rejects with AbortError.
 */
export async function preflightProjectArchiveWorker(
  signal?: AbortSignal,
): Promise<ProjectArchiveWorkerReadiness> {
  throwIfAborted(signal);
  if (!isBrowserRuntime()) {
    return Object.freeze({
      available: false,
      message: "Project archive readiness can only be checked in a browser.",
    });
  }
  if (!canUseArchiveWorker()) {
    return Object.freeze({
      available: false,
      message: "This browser cannot start the project archive worker. Save and Open may be unavailable.",
    });
  }
  try {
    const response = await runArchiveWorker(
      { operation: "preflight" },
      signal,
      PROJECT_ARCHIVE_PREFLIGHT_TIMEOUT_MS,
    );
    throwIfAborted(signal);
    if (!response.ok || response.ready !== true) {
      return Object.freeze({
        available: false,
        message: response.message || "The project archive worker did not pass its readiness check.",
      });
    }
    return Object.freeze({ available: true });
  } catch (error) {
    throwIfAborted(signal);
    return Object.freeze({
      available: false,
      message: error instanceof Error && error.message
        ? error.message
        : "The project archive worker did not pass its readiness check.",
    });
  }
}

function isArchiveWorkerInfrastructureError(error: unknown): boolean {
  return error instanceof ArchiveWorkerInfrastructureError;
}

export async function createProjectArchive(
  entries: Record<string, Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!canUseArchiveWorker()) {
    if (isBrowserRuntime() && !canFallbackToSynchronousArchive()) {
      throw new ArchiveWorkerInfrastructureError("Project archive worker is unavailable.");
    }
    const { createProjectArchiveSync } = await import("./project-archive-engine");
    throwIfAborted(signal);
    const archive = createProjectArchiveSync(entries, maxBytes);
    throwIfAborted(signal);
    return archive;
  }
  try {
    const response = await runArchiveWorker({ operation: "zip", entries, maxBytes }, signal);
    throwIfAborted(signal);
    if (!response.ok) {
      throw new Error(response.message || "Project archive processing failed.");
    }
    if (!isUint8Array(response.archive)) {
      throw new ArchiveWorkerInfrastructureError("Project archive worker returned no data.");
    }
    return response.archive;
  } catch (error) {
    if (!isArchiveWorkerInfrastructureError(error)) throw error;
    if (isBrowserRuntime() && !canFallbackToSynchronousArchive()) throw error;
    throwIfAborted(signal);
    const { createProjectArchiveSync } = await import("./project-archive-engine");
    throwIfAborted(signal);
    const archive = createProjectArchiveSync(entries, maxBytes);
    throwIfAborted(signal);
    return archive;
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
    if (!isArchiveEntries(response.entries)) {
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
