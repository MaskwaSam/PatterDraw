import { describe, expect, it, vi } from "vitest";
import {
  assessStorageReadiness,
  requestDurableStorage,
} from "./storage-readiness";

describe("storage readiness", () => {
  it("reports quota headroom and an already-persistent origin", async () => {
    const result = await assessStorageReadiness({
      requiredBytes: 25,
      storage: {
        estimate: vi.fn(async () => ({ quota: 100, usage: 40 })),
        persisted: vi.fn(async () => true),
      },
    });

    expect(result).toEqual({
      durableStorage: "persisted",
      quotaBytes: 100,
      usageBytes: 40,
      availableBytes: 60,
      requiredBytes: 25,
      hasRequiredCapacity: true,
    });
  });

  it("requests persistence only when explicitly asked", async () => {
    const persist = vi.fn(async () => true);
    const storage = {
      estimate: vi.fn(async () => ({ quota: 1_000, usage: 0 })),
      persisted: vi.fn(async () => false),
      persist,
    };

    const observed = await assessStorageReadiness({ storage });
    expect(observed.durableStorage).toBe("denied");
    expect(persist).not.toHaveBeenCalled();

    const requested = await requestDurableStorage(100, storage);
    expect(requested.durableStorage).toBe("granted");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("keeps unsupported and rejected capabilities advisory", async () => {
    const unsupported = await assessStorageReadiness({
      requiredBytes: 10,
      storage: null,
    });
    expect(unsupported).toMatchObject({
      durableStorage: "unsupported",
      hasRequiredCapacity: null,
    });

    const rejected = await requestDurableStorage(10, {
      estimate: vi.fn(async () => { throw new Error("blocked"); }),
      persisted: vi.fn(async () => { throw new Error("blocked"); }),
      persist: vi.fn(async () => { throw new Error("blocked"); }),
    });
    expect(rejected).toMatchObject({
      durableStorage: "unavailable",
      hasRequiredCapacity: null,
    });
    expect(rejected.advisory).toMatch(/could not be measured/i);
  });

  it("warns when reported quota cannot fit the requested operation", async () => {
    const result = await assessStorageReadiness({
      requiredBytes: 61,
      storage: {
        estimate: vi.fn(async () => ({ quota: 100, usage: 40 })),
        persisted: vi.fn(async () => true),
      },
    });
    expect(result.hasRequiredCapacity).toBe(false);
    expect(result.advisory).toMatch(/not enough/i);
  });

  it("treats an explicit quota-exhaustion estimate failure as no capacity", async () => {
    const result = await assessStorageReadiness({
      requiredBytes: 1,
      storage: {
        estimate: vi.fn(async () => {
          throw new DOMException("Storage is full.", "QuotaExceededError");
        }),
        persisted: vi.fn(async () => true),
      },
    });

    expect(result).toMatchObject({
      availableBytes: 0,
      requiredBytes: 1,
      hasRequiredCapacity: false,
    });
    expect(result.advisory).toMatch(/quota is exhausted/i);
  });

  it("cancels a storage estimate that never settles", async () => {
    const controller = new AbortController();
    const readiness = assessStorageReadiness({
      requiredBytes: 1,
      signal: controller.signal,
      storage: {
        estimate: vi.fn(() => new Promise<StorageEstimate>(() => undefined)),
      },
    });

    controller.abort();

    await expect(readiness).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects invalid required-byte values before using browser capabilities", async () => {
    await expect(assessStorageReadiness({ requiredBytes: -1, storage: null }))
      .rejects.toThrow(/invalid/i);
  });
});
