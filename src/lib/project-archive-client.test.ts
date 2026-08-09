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
    PendingArchiveWorker.instances.length = 0;
    ErrorArchiveWorker.instances.length = 0;
    SemanticArchiveWorker.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it("falls back to synchronous archive creation when the module worker cannot start", async () => {
    vi.stubGlobal("Worker", StartupFailureArchiveWorker);
    const { createProjectArchive } = await import("./project-archive-client");

    const archive = await createProjectArchive({
      "project.json": new TextEncoder().encode("{}"),
    }, 1_024);

    expect(archive).toBeInstanceOf(Uint8Array);
    expect(archive.byteLength).toBeGreaterThan(0);
  });

  it("falls back once to synchronous extraction after a worker transport error", async () => {
    vi.stubGlobal("Worker", ErrorArchiveWorker);
    const { extractProjectArchive } = await import("./project-archive-client");
    const archive = zipSync({ "project.json": new TextEncoder().encode("{}") });

    const entries = await extractProjectArchive(archive, 1_024);
    expect(Array.from(entries["project.json"] ?? [])).toEqual([123, 125]);
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
});
