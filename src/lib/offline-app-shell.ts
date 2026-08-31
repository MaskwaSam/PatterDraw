/**
 * Register PatterDraw's generated app-shell service worker without making it a
 * startup dependency.
 *
 * The generated worker owns its cache/version policy. This client deliberately
 * does not call skipWaiting() or reload: a new release may install in the
 * background, but it must not replace the code under an open classroom
 * lesson. An already-controlled page requests one explicit update check after
 * load so a release reintroduced after a rollback is discovered immediately;
 * activation still waits for every client of the prior release to close.
 */

export const DEFAULT_APP_SHELL_WORKER_URL = "./service-worker.js";
export const DEFAULT_APP_SHELL_SCOPE = "./";

type ServiceWorkerLike = Pick<
  ServiceWorker,
  "state" | "addEventListener" | "removeEventListener"
>;

type ServiceWorkerRegistrationLike = Pick<ServiceWorkerRegistration, "scope"> & {
  active?: ServiceWorkerLike | null;
  installing?: ServiceWorkerLike | null;
  waiting?: ServiceWorkerLike | null;
  update?: () => Promise<ServiceWorkerRegistrationLike>;
  addEventListener?: ServiceWorkerRegistration["addEventListener"];
  removeEventListener?: ServiceWorkerRegistration["removeEventListener"];
};

interface ServiceWorkerContainerLike {
  readonly controller?: ServiceWorkerLike | null;
  readonly ready?: Promise<ServiceWorkerRegistrationLike>;
  register(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistrationLike>;
}

export interface OfflineAppShellEnvironment {
  document?: {
    baseURI?: unknown;
    readyState?: unknown;
  };
  location?: {
    href?: unknown;
  };
  navigator?: {
    serviceWorker?: ServiceWorkerContainerLike;
  };
  addEventListener?: (
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
  setTimeout?: (handler: () => void, timeout?: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface OfflineAppShellRegistrationOptions {
  /** Relative paths keep a packaged build portable at either / or a subpath. */
  workerUrl?: string | URL;
  scope?: string;
  /** Bound a broken install without making slow classroom networks fail early. */
  readinessTimeoutMs?: number;
}

export type OfflineAppShellRegistrationResult =
  | {
      status: "registered";
      registration: ServiceWorkerRegistrationLike;
    }
  | {
      status: "unsupported" | "invalid" | "canceled";
    }
  | {
      status: "failed";
      error: unknown;
    };

export type OfflineAppShellReadinessResult =
  | {
      status: "ready";
      registration: ServiceWorkerRegistrationLike;
      /** Whether a controller was visible at the exact readiness sample. */
      controlled: boolean;
    }
  | {
      status: "unsupported" | "invalid" | "canceled";
    }
  | {
      status: "failed";
      phase: "registration" | "installation" | "readiness";
      error: unknown;
    };

export type ScheduledOfflineAppShellRegistration = {
  cancel: () => void;
  result: Promise<OfflineAppShellReadinessResult>;
};

export type OfflineAppShellExperience = {
  cancel: () => void;
  destroy: () => void;
  result: Promise<OfflineAppShellReadinessResult>;
};

type ReadyOfflineAppShellResult = Extract<
  OfflineAppShellReadinessResult,
  { status: "ready" }
>;

type OfflineAppShellReadinessAttempt = {
  result: Promise<OfflineAppShellReadinessResult>;
  stopLateReadinessMonitor: () => void;
};

export const OFFLINE_APP_SHELL_STATUS_ID = "patterdraw-offline-app-shell-status";
export const OFFLINE_APP_SHELL_STATUS_ATTRIBUTE = "data-patterdraw-offline-app-shell";
export const OFFLINE_APP_SHELL_STATUS_EVENT = "patterdraw:offline-app-shell-status";
// Full classroom-feature continuity is a one-time post-load preparation, not
// part of editor usability. Leave ample margin above the measured 10 Mbps / 4x
// CPU lifecycle while still bounding a browser install that never settles.
export const DEFAULT_APP_SHELL_READINESS_TIMEOUT_MS = 75_000;

class OfflineAppShellLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineAppShellLifecycleError";
  }
}

function browserEnvironment(): OfflineAppShellEnvironment {
  return globalThis as unknown as OfflineAppShellEnvironment;
}

function baseUrl(environment: OfflineAppShellEnvironment): URL | null {
  const documentBase = environment.document?.baseURI;
  const locationHref = environment.location?.href;
  const raw = typeof documentBase === "string" && documentBase
    ? documentBase
    : typeof locationHref === "string" && locationHref
      ? locationHref
      : null;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isSafeSameOriginRegistration(
  workerUrl: string | URL,
  scope: string,
  environment: OfflineAppShellEnvironment,
): boolean {
  const base = baseUrl(environment);
  if (!base || (base.protocol !== "http:" && base.protocol !== "https:")) return false;
  try {
    const resolvedWorker = new URL(workerUrl, base);
    const resolvedScope = new URL(scope, base);
    const workerDirectory = resolvedWorker.pathname.slice(
      0,
      resolvedWorker.pathname.lastIndexOf("/") + 1,
    );
    return resolvedWorker.origin === base.origin
      && resolvedScope.origin === base.origin
      && (resolvedWorker.protocol === "http:" || resolvedWorker.protocol === "https:")
      && (resolvedScope.protocol === "http:" || resolvedScope.protocol === "https:")
      && !resolvedWorker.username
      && !resolvedWorker.password
      && !resolvedWorker.hash
      && !resolvedScope.username
      && !resolvedScope.password
      && !resolvedScope.hash
      // Without a Service-Worker-Allowed response header, browsers allow a
      // worker to control only its own directory and descendants. Keep the
      // portable default inside that fail-closed boundary.
      && resolvedScope.pathname.startsWith(workerDirectory);
  } catch {
    return false;
  }
}

/**
 * Register the local generated worker. Failure is returned as data and never
 * allowed to replace the editor with the bootstrap fatal screen.
 */
export async function registerOfflineAppShell(
  options: OfflineAppShellRegistrationOptions = {},
  environment: OfflineAppShellEnvironment = browserEnvironment(),
): Promise<OfflineAppShellRegistrationResult> {
  const serviceWorker = environment.navigator?.serviceWorker;
  if (!serviceWorker || typeof serviceWorker.register !== "function") {
    return { status: "unsupported" };
  }

  const workerUrl = options.workerUrl ?? DEFAULT_APP_SHELL_WORKER_URL;
  const scope = options.scope ?? DEFAULT_APP_SHELL_SCOPE;
  if (!isSafeSameOriginRegistration(workerUrl, scope, environment)) {
    return { status: "invalid" };
  }

  const wasControlledAtStart = Boolean(serviceWorker.controller);
  try {
    const registration = await serviceWorker.register(workerUrl, {
      scope,
      updateViaCache: "none",
    });
    // Registering the identical script URL/options resolves the existing
    // registration without necessarily running the update algorithm. Ask an
    // already-active registration to check explicitly so a marked release
    // reintroduced after rollback does not wait for the browser's 24-hour
    // stale-registration update window. Never await or force activation: the
    // browser-owned update job remains safely waiting behind open lessons.
    if (
      wasControlledAtStart
      && registration.active
      && typeof registration.update === "function"
    ) {
      void registration.update().catch(() => undefined);
    }
    return { status: "registered", registration };
  } catch (error) {
    return { status: "failed", error };
  }
}

function sameRegistrationScope(
  expected: ServiceWorkerRegistrationLike,
  actual: ServiceWorkerRegistrationLike,
): boolean {
  try {
    return new URL(actual.scope).href === new URL(expected.scope).href;
  } catch {
    return actual.scope === expected.scope;
  }
}

function validReadinessTimeout(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : DEFAULT_APP_SHELL_READINESS_TIMEOUT_MS;
}

/**
 * Wait for the registered app shell to have an activated worker. `register()`
 * resolving is intentionally insufficient: install can still fail while the
 * generated cache is being populated. The browser's `ready` promise is the
 * authority, while worker events turn otherwise-unbounded install failures
 * into a useful result.
 */
function startOfflineAppShellReadinessAttempt(
  registration: ServiceWorkerRegistrationLike,
  options: OfflineAppShellRegistrationOptions = {},
  environment: OfflineAppShellEnvironment = browserEnvironment(),
  onLateReady?: (readiness: ReadyOfflineAppShellResult) => void,
): OfflineAppShellReadinessAttempt {
  const serviceWorker = environment.navigator?.serviceWorker;
  const ready = serviceWorker?.ready;
  if (!serviceWorker || !ready || typeof ready.then !== "function") {
    return {
      result: Promise.resolve({
        status: "failed",
        phase: "readiness",
        error: new OfflineAppShellLifecycleError("Service worker readiness is unavailable."),
      }),
      stopLateReadinessMonitor() {},
    };
  }

  let lateMonitorStopped = false;
  let lateReadyQueued = false;
  let lateActivationCleanup: (() => void) | undefined;
  const stopLateReadinessMonitor = (): void => {
    lateMonitorStopped = true;
    lateReadyQueued = false;
    lateActivationCleanup?.();
    lateActivationCleanup = undefined;
  };

  const result = new Promise<OfflineAppShellReadinessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle: unknown;
    let missingWorkerCheckHandle: unknown;
    let activationCleanup: (() => void) | undefined;
    let resolvedReadyRegistration: ServiceWorkerRegistrationLike | undefined;
    const observedWorkers = new Map<ServiceWorkerLike, {
      onError: EventListener;
      onStateChange: EventListener;
    }>();

    const cleanup = (): void => {
      activationCleanup?.();
      activationCleanup = undefined;
      registration.removeEventListener?.("updatefound", onUpdateFound);
      for (const [worker, listeners] of observedWorkers) {
        worker.removeEventListener("error", listeners.onError);
        worker.removeEventListener("statechange", listeners.onStateChange);
      }
      observedWorkers.clear();
      if (timeoutHandle !== undefined) environment.clearTimeout?.(timeoutHandle);
      if (missingWorkerCheckHandle !== undefined) {
        environment.clearTimeout?.(missingWorkerCheckHandle);
      }
    };
    const reportLateReady = (
      readyRegistration: ServiceWorkerRegistrationLike,
    ): void => {
      if (lateMonitorStopped || lateReadyQueued || !timedOut || !onLateReady) return;
      lateActivationCleanup?.();
      lateActivationCleanup = undefined;
      lateReadyQueued = true;
      const readiness: ReadyOfflineAppShellResult = {
        status: "ready",
        registration: readyRegistration,
        controlled: Boolean(serviceWorker.controller),
      };
      // The bounded failure's handlers were registered before this monitor.
      // Queue late success so that it replaces, rather than races ahead of,
      // the timeout warning and diagnostic.
      void Promise.resolve().then(() => {
        if (lateMonitorStopped || !lateReadyQueued) return;
        lateReadyQueued = false;
        lateMonitorStopped = true;
        onLateReady(readiness);
      });
    };
    const observeLateReadiness = (
      readyRegistration: ServiceWorkerRegistrationLike,
    ): void => {
      if (lateMonitorStopped || !timedOut || !onLateReady) return;
      if (!sameRegistrationScope(registration, readyRegistration)) return;
      const activeWorker = readyRegistration.active;
      if (!activeWorker || activeWorker.state === "redundant") return;
      if (activeWorker.state === "activated") {
        reportLateReady(readyRegistration);
        return;
      }
      const onStateChange: EventListener = () => {
        if (activeWorker.state === "activated") {
          reportLateReady(readyRegistration);
        } else if (activeWorker.state === "redundant") {
          stopLateReadinessMonitor();
        }
      };
      lateActivationCleanup?.();
      activeWorker.addEventListener("statechange", onStateChange);
      lateActivationCleanup = (): void => {
        activeWorker.removeEventListener("statechange", onStateChange);
      };
      onStateChange(new Event("statechange"));
    };
    const settle = (result: OfflineAppShellReadinessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const failInstallation = (message: string): void => {
      settle({
        status: "failed",
        phase: "installation",
        error: new OfflineAppShellLifecycleError(message),
      });
    };
    const observeWorker = (worker: ServiceWorkerLike | null | undefined): void => {
      if (settled || !worker || observedWorkers.has(worker)) return;
      const onError: EventListener = () => {
        failInstallation("The offline app shell could not be installed.");
      };
      const onStateChange: EventListener = () => {
        if (worker.state === "redundant") {
          failInstallation("The offline app-shell install became redundant before activation.");
        }
      };
      observedWorkers.set(worker, { onError, onStateChange });
      worker.addEventListener("error", onError);
      worker.addEventListener("statechange", onStateChange);
      if (worker.state === "redundant") onStateChange(new Event("statechange"));
    };
    const onUpdateFound: EventListener = () => observeWorker(registration.installing);
    const hasRegistrationWorker = (): boolean => Boolean(
      registration.installing || registration.waiting || registration.active,
    );
    const checkForMissedFastInstallFailure = (): void => {
      if (settled) return;

      // Re-sample every slot, not only `installing`: a successful first
      // install can advance to waiting/active between register() resolving and
      // this task, while updatefound may already have been queued.
      observeWorker(registration.installing);
      observeWorker(registration.waiting);
      observeWorker(registration.active);
      if (!hasRegistrationWorker()) {
        failInstallation(
          "The offline app-shell install ended before a worker could be observed.",
        );
      }
    };

    registration.addEventListener?.("updatefound", onUpdateFound);
    observeWorker(registration.installing);
    observeWorker(registration.waiting);
    observeWorker(registration.active);

    if (!hasRegistrationWorker()) {
      // A very fast install failure can clear registration.installing before
      // register() resolves, leaving serviceWorker.ready pending forever. The
      // listeners above must be installed before deciding that no worker
      // exists. Give a legitimate first install an additional microtask and
      // browser task to publish updatefound/its worker, then fail promptly
      // instead of waiting for the full continuity-readiness timeout.
      void Promise.resolve().then(() => {
        void Promise.resolve().then(() => {
          if (settled || hasRegistrationWorker()) return;
          if (typeof environment.setTimeout !== "function") {
            checkForMissedFastInstallFailure();
            return;
          }
          const handle = environment.setTimeout(checkForMissedFastInstallFailure, 0);
          if (settled) {
            environment.clearTimeout?.(handle);
          } else {
            missingWorkerCheckHandle = handle;
          }
        });
      });
    }

    void ready.then((readyRegistration) => {
      if (settled) {
        observeLateReadiness(readyRegistration);
        return;
      }
      if (!sameRegistrationScope(registration, readyRegistration)) {
        settle({
          status: "failed",
          phase: "readiness",
          error: new OfflineAppShellLifecycleError(
            "A different service-worker scope became ready than the registered app shell.",
          ),
        });
        return;
      }
      resolvedReadyRegistration = readyRegistration;
      const activeWorker = readyRegistration.active;
      if (!activeWorker) {
        settle({
          status: "failed",
          phase: "readiness",
          error: new OfflineAppShellLifecycleError(
            "Service-worker readiness resolved without an active worker.",
          ),
        });
        return;
      }
      if (activeWorker.state === "redundant") {
        failInstallation("The offline app shell became redundant before it was ready.");
        return;
      }
      if (activeWorker.state === "activated") {
        settle({
          status: "ready",
          registration: readyRegistration,
          controlled: Boolean(serviceWorker.controller),
        });
        return;
      }

      // `ready` normally exposes an activated worker. Retain a defensive
      // activation wait for partially implemented browser engines.
      const onStateChange: EventListener = () => {
        if (activeWorker.state === "activated") {
          settle({
            status: "ready",
            registration: readyRegistration,
            controlled: Boolean(serviceWorker.controller),
          });
        } else if (activeWorker.state === "redundant") {
          failInstallation("The offline app shell became redundant before activation.");
        }
      };
      observeWorker(activeWorker);
      // Some partially implemented engines may expose a worker here before it
      // passes through installed and activating. Keep observing every
      // transition until settle() runs its cleanup; a one-shot listener can be
      // consumed by the first intermediate state and then wait until timeout.
      activeWorker.addEventListener("statechange", onStateChange);
      // The listener above is not part of observeWorker's generic pair, so
      // include it in cleanup without changing the public worker contract.
      activationCleanup = (): void => {
        activeWorker.removeEventListener("statechange", onStateChange);
      };
    }, (error) => {
      settle({ status: "failed", phase: "readiness", error });
    });

    if (typeof environment.setTimeout === "function") {
      timeoutHandle = environment.setTimeout(() => {
        timedOut = true;
        settle({
          status: "failed",
          phase: "readiness",
          error: new OfflineAppShellLifecycleError(
            "Offline preparation did not finish within the readiness window.",
          ),
        });
        if (resolvedReadyRegistration) observeLateReadiness(resolvedReadyRegistration);
      }, validReadinessTimeout(options.readinessTimeoutMs));
    }
  });

  return { result, stopLateReadinessMonitor };
}

export function waitForOfflineAppShellReadiness(
  registration: ServiceWorkerRegistrationLike,
  options: OfflineAppShellRegistrationOptions = {},
  environment: OfflineAppShellEnvironment = browserEnvironment(),
): Promise<OfflineAppShellReadinessResult> {
  return startOfflineAppShellReadinessAttempt(registration, options, environment).result;
}

/**
 * Defer optional service-worker work until the current page has completely
 * loaded. This keeps first paint and restoration of the live lesson ahead of
 * offline cache preparation. Calling cancel before the task starts prevents a
 * registration attempt; it never unregisters an already-installed worker.
 */
function scheduleOfflineAppShellRegistrationAttempt(
  options: OfflineAppShellRegistrationOptions = {},
  environment: OfflineAppShellEnvironment = browserEnvironment(),
  onLateReady?: (readiness: ReadyOfflineAppShellResult) => void,
): ScheduledOfflineAppShellRegistration {
  let canceled = false;
  let settled = false;
  let registrationStarted = false;
  let lateMonitoringStopped = false;
  let readinessAttempt: OfflineAppShellReadinessAttempt | undefined;
  let timeoutHandle: unknown;
  let resolveResult: (result: OfflineAppShellReadinessResult) => void = () => undefined;
  const result = new Promise<OfflineAppShellReadinessResult>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (value: OfflineAppShellReadinessResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };

  const run = (): void => {
    if (settled) return;
    if (canceled) {
      settle({ status: "canceled" });
      return;
    }
    registrationStarted = true;
    void registerOfflineAppShell(options, environment).then(async (registrationResult) => {
      if (registrationResult.status === "registered") {
        readinessAttempt = startOfflineAppShellReadinessAttempt(
          registrationResult.registration,
          options,
          environment,
          onLateReady,
        );
        if (lateMonitoringStopped) readinessAttempt.stopLateReadinessMonitor();
        settle(await readinessAttempt.result);
      } else if (registrationResult.status === "failed") {
        settle({
          status: "failed",
          phase: "registration",
          error: registrationResult.error,
        });
      } else {
        settle(registrationResult);
      }
    }, (error) => {
      // registerOfflineAppShell itself is failure-contained. Retain a defensive
      // branch so a hostile host implementation cannot create an unhandled
      // rejection in the editor bootstrap.
      settle({ status: "failed", phase: "registration", error });
    });
  };

  const schedule = (): void => {
    environment.removeEventListener?.("load", onLoad);
    if (settled || canceled) {
      run();
      return;
    }
    if (typeof environment.setTimeout === "function") {
      timeoutHandle = environment.setTimeout(run, 0);
    } else {
      run();
    }
  };
  const onLoad: EventListener = () => schedule();

  if (environment.document?.readyState === "complete") {
    schedule();
  } else if (typeof environment.addEventListener === "function") {
    environment.addEventListener("load", onLoad, { once: true });
  } else {
    schedule();
  }

  return {
    cancel() {
      lateMonitoringStopped = true;
      readinessAttempt?.stopLateReadinessMonitor();
      // Browser registration cannot be safely aborted once it has started.
      // Avoid unregistering an existing known-good controller; cancellation is
      // intentionally limited to the deferred pre-registration window.
      if (settled || canceled || registrationStarted) return;
      canceled = true;
      environment.removeEventListener?.("load", onLoad);
      if (timeoutHandle !== undefined) environment.clearTimeout?.(timeoutHandle);
      settle({ status: "canceled" });
    },
    result,
  };
}

export function scheduleOfflineAppShellRegistration(
  options: OfflineAppShellRegistrationOptions = {},
  environment: OfflineAppShellEnvironment = browserEnvironment(),
): ScheduledOfflineAppShellRegistration {
  return scheduleOfflineAppShellRegistrationAttempt(options, environment);
}

type OfflineAppShellDiagnosticStatus =
  | "preparing"
  | OfflineAppShellReadinessResult["status"];

function publishOfflineAppShellDiagnostic(
  targetDocument: Document,
  status: OfflineAppShellDiagnosticStatus,
  phase?: "registration" | "installation" | "readiness",
): void {
  targetDocument.documentElement.setAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE, status);
  const EventConstructor = targetDocument.defaultView?.CustomEvent;
  if (!EventConstructor) return;
  targetDocument.dispatchEvent(new EventConstructor(OFFLINE_APP_SHELL_STATUS_EVENT, {
    detail: phase ? { status, phase } : { status },
  }));
}

function styleOfflineNotice(element: HTMLElement): void {
  Object.assign(element.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483000",
    boxSizing: "border-box",
    maxWidth: "min(420px, calc(100vw - 32px))",
    padding: "10px 12px",
    border: "1px solid rgba(255, 255, 255, 0.28)",
    borderRadius: "9px",
    background: "#20242c",
    boxShadow: "0 6px 24px rgba(0, 0, 0, 0.28)",
    color: "#fff",
    font: "600 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  });
}

function styleOfflineNoticeButton(button: HTMLButtonElement): void {
  Object.assign(button.style, {
    marginInlineStart: "10px",
    padding: "5px 9px",
    border: "1px solid rgba(255, 255, 255, 0.55)",
    borderRadius: "6px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  });
}

/**
 * Start the deferred install and surface its real lifecycle state.
 *
 * A first install names its background preparation and announces success only
 * after the complete verified cache activates. Existing controlled sessions
 * remain visually quiet. Failures stay visible with a safe retry that simply
 * registers the same local worker again; this intentionally never unregisters
 * a known-good worker.
 */
export function installOfflineAppShellExperience(
  options: OfflineAppShellRegistrationOptions = {},
  environment: OfflineAppShellEnvironment = browserEnvironment(),
  targetDocument: Document | undefined = typeof document === "undefined" ? undefined : document,
): OfflineAppShellExperience {
  let destroyed = false;
  let current: ScheduledOfflineAppShellRegistration | undefined;
  let runGeneration = 0;
  let noticeTimer: number | undefined;
  let resolveFirst: (result: OfflineAppShellReadinessResult) => void = () => undefined;
  const result = new Promise<OfflineAppShellReadinessResult>((resolve) => {
    resolveFirst = resolve;
  });
  let firstSettled = false;

  const clearNotice = (): void => {
    if (!targetDocument) return;
    targetDocument.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.remove();
    if (noticeTimer !== undefined) {
      targetDocument.defaultView?.clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
  };

  const showNotice = (
    message: string,
    role: "alert" | "status",
    onRetry?: () => void,
  ): void => {
    if (!targetDocument?.body) return;
    clearNotice();
    const notice = targetDocument.createElement("div");
    notice.id = OFFLINE_APP_SHELL_STATUS_ID;
    notice.setAttribute("role", role);
    notice.setAttribute("aria-live", role === "alert" ? "assertive" : "polite");
    notice.setAttribute("aria-atomic", "true");
    styleOfflineNotice(notice);
    const text = targetDocument.createElement("span");
    text.textContent = message;
    notice.append(text);
    if (onRetry) {
      const retry = targetDocument.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry offline setup";
      retry.addEventListener("click", onRetry, { once: true });
      styleOfflineNoticeButton(retry);
      notice.append(retry);
    }
    if (role === "alert") {
      const dismiss = targetDocument.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", clearNotice, { once: true });
      styleOfflineNoticeButton(dismiss);
      notice.append(dismiss);
    }
    targetDocument.body.append(notice);
  };

  const report = (
    readiness: OfflineAppShellReadinessResult,
    wasControlledAtStart: boolean,
  ): void => {
    if (destroyed) return;
    if (targetDocument) {
      publishOfflineAppShellDiagnostic(
        targetDocument,
        readiness.status,
        readiness.status === "failed" ? readiness.phase : undefined,
      );
    }

    if (readiness.status === "ready") {
      clearNotice();
      // Already-controlled visits need no recurring classroom toast. A first
      // install reaches this branch only after the feature-continuity pack has
      // been verified and the worker's activation (including claim) completes.
      if (!wasControlledAtStart) {
        showNotice(
          "Offline classroom tools are ready. You can keep teaching, and this lesson stays open.",
          "status",
        );
        noticeTimer = targetDocument?.defaultView?.setTimeout(clearNotice, 6_000);
      }
      return;
    }
    if (readiness.status === "canceled") {
      clearNotice();
      return;
    }
    if (readiness.status === "unsupported") {
      showNotice(
        "This browser cannot prepare PatterDraw for offline use. Keep this page open while teaching.",
        "alert",
      );
      return;
    }
    if (readiness.status === "invalid") {
      showNotice(
        "Offline setup was blocked because its local app address is invalid.",
        "alert",
      );
      return;
    }
    showNotice(
      "Offline classroom setup did not finish. Keep this page open, or retry before relying on it without internet.",
      "alert",
      () => run(true),
    );
  };

  const run = (isRetry = false): void => {
    if (destroyed) return;
    current?.cancel();
    const generation = ++runGeneration;
    // clients.claim() can make the controller visible before readiness is
    // sampled. Preserve the pre-registration state so a genuine first install
    // still receives its one success notice.
    const wasControlledAtStart = Boolean(
      environment.navigator?.serviceWorker?.controller,
    );
    if (targetDocument) publishOfflineAppShellDiagnostic(targetDocument, "preparing");
    if (isRetry) {
      showNotice("Retrying offline classroom setup…", "status");
    } else if (!environment.navigator?.serviceWorker?.controller) {
      showNotice(
        "Preparing PDF, equation, diagram, and geometry tools for offline use… You can keep working.",
        "status",
      );
    }
    current = scheduleOfflineAppShellRegistrationAttempt(options, environment, (readiness) => {
      if (destroyed || generation !== runGeneration) return;
      report(readiness, wasControlledAtStart);
    });
    const scheduled = current;
    void scheduled.result.then((readiness) => {
      if (!firstSettled) {
        firstSettled = true;
        resolveFirst(readiness);
      }
      if (destroyed || generation !== runGeneration) return;
      report(readiness, wasControlledAtStart);
    }, (error) => {
      const failure: OfflineAppShellReadinessResult = {
        status: "failed",
        phase: "readiness",
        error,
      };
      if (!firstSettled) {
        firstSettled = true;
        resolveFirst(failure);
      }
      if (destroyed || generation !== runGeneration) return;
      report(failure, wasControlledAtStart);
    });
  };

  run();
  return {
    cancel() {
      current?.cancel();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      current?.cancel();
      clearNotice();
      targetDocument?.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    },
    result,
  };
}
