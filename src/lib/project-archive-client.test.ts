import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

class PendingArchiveWorker {
  static instances: PendingArchiveWorker[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    PendingArchiveWorker.instances.push(this);
  }
}

class StartupFailureArchiveWorker {
  constructor() {
    throw new Error("Failed to construct module worker (CSP).");
  }
}

class ErrorArchiveWorker {
  static instances: ErrorArchiveWorker[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(() => {
    queueMicrotask(() => this.onerror?.({ message: "404 loading worker module" } as ErrorEvent));
  });
  terminate = vi.fn();

  constructor() {
    ErrorArchiveWorker.instances.push(this);
  }
}

class SemanticArchiveWorker {
  static instances: SemanticArchiveWorker[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn((request: { id: number }) => {
    queueMicrotask(() => this.onmessage?.({
      data: {
        id: request.id,
        ok: false,
        message: "Project archive expands beyond the PatterDraw safety limit.",
      },
    } as MessageEvent<unknown>));
  });
  terminate = vi.fn();

  constructor() {
    SemanticArchiveWorker.instances.push(this);
  }
}

describe("project archive worker cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    PendingArchiveWorker.instances.length = 0;
    ErrorArchiveWorker.instances.length = 0;
    SemanticArchiveWorker.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it("fails closed when the module worker cannot start in a browser", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubGlobal("Worker", StartupFailureArchiveWorker);
    const { extractProjectArchive } = await import("./project-archive-client");
    const archive = zipSync({ "project.json": new TextEncoder().encode("{}") });

    await expect(extractProjectArchive(archive, 1_024))
      .rejects.toThrow("Failed to construct module worker (CSP).");
  });

  it("fails closed when archive creation cannot start its production worker", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubGlobal("Worker", StartupFailureArchiveWorker);
    const { createProjectArchive } = await import("./project-archive-client");

    await expect(createProjectArchive({
      "project.json": new TextEncoder().encode("{}"),
    }, 1_024)).rejects.toThrow("Failed to construct module worker (CSP).");
  });

  it("fails closed when the browser has no Worker API in production", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubGlobal("Worker", undefined);
    const { extractProjectArchive } = await import("./project-archive-client");
    const archive = zipSync({ "project.json": new TextEncoder().encode("{}") });

    await expect(extractProjectArchive(archive, 1_024))
      .rejects.toThrow("Project archive worker is unavailable.");
  });

  it("fails closed after a worker transport error instead of parsing on the UI thread", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubGlobal("Worker", ErrorArchiveWorker);
    const { extractProjectArchive } = await import("./project-archive-client");
    const archive = zipSync({ "project.json": new TextEncoder().encode("{}") });

    await expect(extractProjectArchive(archive, 1_024))
      .rejects.toThrow("404 loading worker module");
    expect(ErrorArchiveWorker.instances).toHaveLength(1);
    expect(ErrorArchiveWorker.instances[0].postMessage).toHaveBeenCalledOnce();
    expect(ErrorArchiveWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("does not retry a semantic worker validation failure", async () => {
    vi.stubGlobal("Worker", SemanticArchiveWorker);
    const { extractProjectArchive } = await import("./project-archive-client");

    await expect(extractProjectArchive(new Uint8Array([1, 2, 3]), 1_024))
      .rejects.toThrow("Project archive expands beyond the PatterDraw safety limit.");
    expect(SemanticArchiveWorker.instances).toHaveLength(1);
    expect(SemanticArchiveWorker.instances[0].postMessage).toHaveBeenCalledOnce();
  });

  it("terminates a superseded unzip worker and rejects with AbortError", async () => {
    vi.stubGlobal("Worker", PendingArchiveWorker);
    const { extractProjectArchive } = await import("./project-archive-client");
    const controller = new AbortController();

    const extraction = extractProjectArchive(
      new Uint8Array([1, 2, 3, 4]),
      1_024,
      controller.signal,
    );
    controller.abort();

    await expect(extraction).rejects.toMatchObject({ name: "AbortError" });
    expect(PendingArchiveWorker.instances).toHaveLength(1);
    expect(PendingArchiveWorker.instances[0].postMessage).toHaveBeenCalledOnce();
    expect(PendingArchiveWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("terminates and rejects a worker that exceeds the archive timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MODE", "production");
    vi.stubGlobal("Worker", PendingArchiveWorker);
    const { extractProjectArchive, PROJECT_ARCHIVE_WORKER_TIMEOUT_MS } = await import("./project-archive-client");

    const extraction = extractProjectArchive(new Uint8Array([1, 2, 3, 4]), 1_024);
    const rejection = expect(extraction).rejects.toThrow("Project archive worker timed out.");
    await vi.advanceTimersByTimeAsync(PROJECT_ARCHIVE_WORKER_TIMEOUT_MS);

    await rejection;
    expect(PendingArchiveWorker.instances).toHaveLength(1);
    expect(PendingArchiveWorker.instances[0].postMessage).toHaveBeenCalledOnce();
    expect(PendingArchiveWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
});
