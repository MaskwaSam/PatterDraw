export type DurableStorageState =
  | "persisted"
  | "granted"
  | "denied"
  | "unsupported"
  | "unavailable";

export interface StorageReadiness {
  durableStorage: DurableStorageState;
  quotaBytes: number | null;
  usageBytes: number | null;
  availableBytes: number | null;
  requiredBytes: number;
  hasRequiredCapacity: boolean | null;
  /** A browser capability failure is advisory; project work can continue. */
  advisory?: string;
}

interface StorageManagerLike {
  estimate?: () => Promise<StorageEstimate>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

export interface AssessStorageReadinessOptions {
  /** Additional local capacity needed for the planned operation. */
  requiredBytes?: number;
  /**
   * Request durable storage. Call this only from a deliberate user action;
   * browsers may require user activation before granting persistence.
   */
  requestPersistence?: boolean;
  /** Cancel capability probes that would otherwise keep an import waiting. */
  signal?: AbortSignal;
  /** Focused test/integration seam. Defaults to navigator.storage. */
  storage?: StorageManagerLike | null;
}

function browserStorageManager(): StorageManagerLike | null {
  if (typeof navigator === "undefined") return null;
  return navigator.storage ?? null;
}

function finiteStorageValue(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function validateRequiredBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The required local storage size is invalid.");
  }
}

function isQuotaExceededError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { name?: unknown }).name === "QuotaExceededError",
  );
}

function storageReadinessAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfStorageReadinessAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw storageReadinessAbortReason(signal);
}

function waitForStorageCapability<T>(
  capability: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return capability;
  throwIfStorageReadinessAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(storageReadinessAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    capability.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Assess quota and persistence without making unsupported/rejected browser
 * capabilities fatal. The result is suitable for a classroom-readiness
 * warning before large imports or project work begins.
 */
export async function assessStorageReadiness(
  options: AssessStorageReadinessOptions = {},
): Promise<Readonly<StorageReadiness>> {
  const requiredBytes = options.requiredBytes ?? 0;
  validateRequiredBytes(requiredBytes);
  throwIfStorageReadinessAborted(options.signal);
  const storage = options.storage === undefined
    ? browserStorageManager()
    : options.storage;

  if (!storage) {
    return Object.freeze({
      durableStorage: "unsupported",
      quotaBytes: null,
      usageBytes: null,
      availableBytes: null,
      requiredBytes,
      hasRequiredCapacity: null,
      advisory: "This browser cannot report or protect local storage. Download project backups often.",
    });
  }

  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  let estimateFailed = false;
  let quotaExhausted = false;
  if (typeof storage.estimate === "function") {
    try {
      const estimate = await waitForStorageCapability(storage.estimate(), options.signal);
      quotaBytes = finiteStorageValue(estimate.quota);
      usageBytes = finiteStorageValue(estimate.usage);
    } catch (error) {
      throwIfStorageReadinessAborted(options.signal);
      if (isQuotaExceededError(error)) {
        // A quota-exhaustion signal is materially different from an absent or
        // blocked estimate. Treat it as zero available capacity so a rendered
        // PDF candidate is rejected before any live project state is changed.
        quotaBytes = 0;
        usageBytes = 0;
        quotaExhausted = true;
      } else {
        estimateFailed = true;
      }
    }
  }

  let durableStorage: DurableStorageState = "unsupported";
  let persistenceFailed = false;
  if (typeof storage.persisted === "function") {
    try {
      durableStorage = await waitForStorageCapability(storage.persisted(), options.signal)
        ? "persisted"
        : "denied";
    } catch {
      throwIfStorageReadinessAborted(options.signal);
      durableStorage = "unavailable";
      persistenceFailed = true;
    }
  }

  if (
    options.requestPersistence
    && durableStorage !== "persisted"
    && typeof storage.persist === "function"
  ) {
    try {
      durableStorage = await waitForStorageCapability(storage.persist(), options.signal)
        ? "granted"
        : "denied";
    } catch {
      throwIfStorageReadinessAborted(options.signal);
      durableStorage = "unavailable";
      persistenceFailed = true;
    }
  }

  const availableBytes = quotaBytes !== null && usageBytes !== null
    ? Math.max(0, quotaBytes - Math.min(quotaBytes, usageBytes))
    : null;
  const hasRequiredCapacity = availableBytes === null
    ? null
    : availableBytes >= requiredBytes;
  const advisories: string[] = [];
  if (estimateFailed || typeof storage.estimate !== "function") {
    advisories.push("Available browser storage could not be measured.");
  }
  if (quotaExhausted) {
    advisories.push("Browser storage reported that its quota is exhausted.");
  }
  if (persistenceFailed) {
    advisories.push("Durable local storage could not be checked.");
  } else if (durableStorage === "unsupported") {
    advisories.push("This browser does not offer durable local storage.");
  } else if (durableStorage === "denied") {
    advisories.push("The browser may remove local work under storage pressure.");
  }
  if (hasRequiredCapacity === false) {
    advisories.push("There is not enough reported browser storage for this operation.");
  }

  throwIfStorageReadinessAborted(options.signal);

  return Object.freeze({
    durableStorage,
    quotaBytes,
    usageBytes,
    availableBytes,
    requiredBytes,
    hasRequiredCapacity,
    ...(advisories.length ? { advisory: advisories.join(" ") } : {}),
  });
}

/** Explicit user-driven convenience wrapper for requesting persistence. */
export function requestDurableStorage(
  requiredBytes = 0,
  storage?: StorageManagerLike | null,
): Promise<Readonly<StorageReadiness>> {
  return assessStorageReadiness({
    requiredBytes,
    requestPersistence: true,
    ...(storage !== undefined ? { storage } : {}),
  });
}
