import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APP_SHELL_SCOPE,
  DEFAULT_APP_SHELL_READINESS_TIMEOUT_MS,
  DEFAULT_APP_SHELL_WORKER_URL,
  installOfflineAppShellExperience,
  OFFLINE_APP_SHELL_STATUS_ATTRIBUTE,
  OFFLINE_APP_SHELL_STATUS_EVENT,
  OFFLINE_APP_SHELL_STATUS_ID,
  registerOfflineAppShell,
  scheduleOfflineAppShellRegistration,
  waitForOfflineAppShellReadiness,
  type OfflineAppShellEnvironment,
} from "./offline-app-shell";

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState;

  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }

  transition(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  active: FakeServiceWorker | null;
  installing: FakeServiceWorker | null;
  scope: string;
  waiting: FakeServiceWorker | null;
  update?: () => Promise<FakeRegistration>;

  constructor(
    scope = "https://classroom.test/tools/patterdraw/",
    workers: Partial<Pick<FakeRegistration, "active" | "installing" | "waiting">> = {},
  ) {
    super();
    this.scope = scope;
    this.active = workers.active ?? null;
    this.installing = workers.installing ?? null;
    this.waiting = workers.waiting ?? null;
  }
}

type Register = (
  scriptURL: string | URL,
  options?: RegistrationOptions,
) => Promise<FakeRegistration>;

function registrationEnvironment(
  register: Register,
  overrides: Partial<OfflineAppShellEnvironment> = {},
): OfflineAppShellEnvironment {
  return {
    document: {
      baseURI: "https://classroom.test/tools/patterdraw/",
      readyState: "complete",
    },
    location: { href: "https://classroom.test/tools/patterdraw/" },
    navigator: { serviceWorker: { register } },
    setTimeout(handler, timeout) {
      if ((timeout ?? 0) === 0) handler();
      return 1;
    },
    clearTimeout() {},
    ...overrides,
  };
}

describe("offline app-shell registration", () => {
  it("remains optional when service workers are unavailable", async () => {
    await expect(registerOfflineAppShell({}, {
      document: { baseURI: "https://classroom.test/" },
      location: { href: "https://classroom.test/" },
      navigator: {},
    })).resolves.toEqual({ status: "unsupported" });
  });

  it("registers the portable local worker without forcing an update or takeover", async () => {
    const registration = new FakeRegistration();
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const serviceWorker = { register };
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker },
    });

    await expect(registerOfflineAppShell({}, environment)).resolves.toEqual({
      status: "registered",
      registration,
    });
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(DEFAULT_APP_SHELL_WORKER_URL, {
      scope: DEFAULT_APP_SHELL_SCOPE,
      updateViaCache: "none",
    });
    expect(Object.keys(serviceWorker)).toEqual(["register"]);
  });

  it("checks for a reintroduced release on an existing controller without forcing activation", async () => {
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const update = vi.fn().mockResolvedValue(registration);
    registration.update = update;
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, controller: active } },
    });

    await expect(registerOfflineAppShell({}, environment)).resolves.toEqual({
      status: "registered",
      registration,
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not start a redundant update check for an uncontrolled first install", async () => {
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const update = vi.fn().mockResolvedValue(registration);
    registration.update = update;
    const register = vi.fn<Register>().mockResolvedValue(registration);

    await registerOfflineAppShell({}, registrationEnvironment(register, {
      navigator: { serviceWorker: { register, controller: null } },
    }));
    expect(update).not.toHaveBeenCalled();
  });

  it("supports an explicitly injected same-origin worker and scope", async () => {
    const registration = new FakeRegistration();
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const environment = registrationEnvironment(register);

    await expect(registerOfflineAppShell({
      workerUrl: new URL("https://classroom.test/tools/patterdraw/sw-v1.js"),
      scope: "/tools/patterdraw/",
    }, environment)).resolves.toEqual({ status: "registered", registration });
    expect(register).toHaveBeenCalledWith(
      new URL("https://classroom.test/tools/patterdraw/sw-v1.js"),
      { scope: "/tools/patterdraw/", updateViaCache: "none" },
    );
  });

  it.each([
    ["cross-origin worker", { workerUrl: "https://remote.test/service-worker.js" }],
    ["cross-origin scope", { scope: "https://remote.test/" }],
    ["non-HTTP worker", { workerUrl: "data:text/javascript,close()" }],
    ["fragmented worker URL", { workerUrl: "./service-worker.js#unexpected" }],
    ["scope above worker", { workerUrl: "./workers/service-worker.js", scope: "./" }],
  ] as const)("rejects an invalid %s without contacting the browser", async (_label, options) => {
    const register = vi.fn<Register>();
    await expect(registerOfflineAppShell(options, registrationEnvironment(register)))
      .resolves.toEqual({ status: "invalid" });
    expect(register).not.toHaveBeenCalled();
  });

  it("contains registration errors instead of rejecting the editor bootstrap", async () => {
    const error = new DOMException("Service worker disabled by policy", "SecurityError");
    const register = vi.fn<Register>().mockRejectedValue(error);
    await expect(registerOfflineAppShell({}, registrationEnvironment(register)))
      .resolves.toEqual({ status: "failed", error });
  });
});

describe("offline app-shell readiness", () => {
  it("does not confuse successful registration with completed cache installation", async () => {
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
    });

    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);
    let resolved = false;
    void readiness.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const active = new FakeServiceWorker("activated");
    registration.installing = null;
    registration.active = active;
    resolveReady?.(registration);
    await expect(readiness).resolves.toEqual({
      status: "ready",
      registration,
      controlled: false,
    });
  });

  it("waits for an activating ready worker to reach activated", async () => {
    const active = new FakeServiceWorker("activating");
    const registration = new FakeRegistration(undefined, { active });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready: Promise.resolve(registration) } },
    });
    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);
    await Promise.resolve();

    active.transition("activated");
    await expect(readiness).resolves.toMatchObject({
      status: "ready",
      registration,
      controlled: false,
    });
  });

  it("keeps observing a defensive ready worker across intermediate states", async () => {
    const active = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { active });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready: Promise.resolve(registration) } },
    });
    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);
    let settled = false;
    void readiness.then(() => { settled = true; });
    await Promise.resolve();

    active.transition("installed");
    active.transition("activating");
    await Promise.resolve();
    expect(settled).toBe(false);

    active.transition("activated");
    await expect(readiness).resolves.toMatchObject({
      status: "ready",
      registration,
      controlled: false,
    });
  });

  it("reports an install that becomes redundant before readiness", async () => {
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const ready = new Promise<FakeRegistration>(() => undefined);
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready } },
    });
    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);

    installing.transition("redundant");
    await expect(readiness).resolves.toMatchObject({
      status: "failed",
      phase: "installation",
      error: expect.objectContaining({ name: "OfflineAppShellLifecycleError" }),
    });
  });

  it("promptly reports a fast install failure that cleared every worker slot", async () => {
    const registration = new FakeRegistration();
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const ready = new Promise<FakeRegistration>(() => undefined);
    const clearTimeout = vi.fn();
    let missingWorkerCheck: (() => void) | undefined;
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) missingWorkerCheck = handler;
        else readinessTimeout = handler;
        return (timeout ?? 0) === 0 ? 31 : 32;
      },
      clearTimeout,
    });

    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);
    await Promise.resolve();
    await Promise.resolve();
    expect(missingWorkerCheck).toBeTypeOf("function");
    expect(readinessTimeout).toBeTypeOf("function");

    missingWorkerCheck?.();
    await expect(readiness).resolves.toMatchObject({
      status: "failed",
      phase: "installation",
      error: expect.objectContaining({ name: "OfflineAppShellLifecycleError" }),
    });
    expect(clearTimeout).toHaveBeenCalledWith(32);
    expect(readinessTimeout).toBeTypeOf("function");
  });

  it("does not mistake a queued first-install worker for a fast failure", async () => {
    const registration = new FakeRegistration();
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    let missingWorkerCheck: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) missingWorkerCheck = handler;
        return (timeout ?? 0) === 0 ? 33 : 34;
      },
    });

    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);
    const installing = new FakeServiceWorker("installing");
    void Promise.resolve().then(() => {
      registration.installing = installing;
      registration.dispatchEvent(new Event("updatefound"));
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(missingWorkerCheck).toBeUndefined();

    const active = new FakeServiceWorker("activated");
    registration.installing = null;
    registration.active = active;
    resolveReady?.(registration);
    await expect(readiness).resolves.toEqual({
      status: "ready",
      registration,
      controlled: false,
    });
  });

  it("bounds a readiness promise that never settles", async () => {
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const ready = new Promise<FakeRegistration>(() => undefined);
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready } },
      setTimeout(handler, timeout) {
        expect(timeout).toBe(1234);
        readinessTimeout = handler;
        return 8;
      },
    });
    const readiness = waitForOfflineAppShellReadiness(
      registration,
      { readinessTimeoutMs: 1234 },
      environment,
    );

    readinessTimeout?.();
    await expect(readiness).resolves.toMatchObject({
      status: "failed",
      phase: "readiness",
      error: expect.objectContaining({ name: "OfflineAppShellLifecycleError" }),
    });
  });

  it("uses a 75-second default window for full feature-continuity preparation", async () => {
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const ready = new Promise<FakeRegistration>(() => undefined);
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready } },
      setTimeout(handler, timeout) {
        expect(timeout).toBe(DEFAULT_APP_SHELL_READINESS_TIMEOUT_MS);
        readinessTimeout = handler;
        return 9;
      },
    });

    const readiness = waitForOfflineAppShellReadiness(registration, {}, environment);
    readinessTimeout?.();
    await expect(readiness).resolves.toMatchObject({ status: "failed", phase: "readiness" });
    expect(DEFAULT_APP_SHELL_READINESS_TIMEOUT_MS).toBe(75_000);
  });

  it("rejects readiness from a different worker scope", async () => {
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const unrelated = new FakeRegistration("https://classroom.test/other/", { active });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready: Promise.resolve(unrelated) } },
    });

    await expect(waitForOfflineAppShellReadiness(registration, {}, environment))
      .resolves.toMatchObject({ status: "failed", phase: "readiness" });
  });
});

describe("offline app-shell scheduling", () => {
  it("keeps the scheduled result pending after register resolves until readiness resolves", async () => {
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
    });

    const scheduled = scheduleOfflineAppShellRegistration({}, environment);
    let settled = false;
    void scheduled.result.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(register).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    const active = new FakeServiceWorker("activated");
    registration.installing = null;
    registration.active = active;
    resolveReady?.(registration);
    await expect(scheduled.result).resolves.toMatchObject({ status: "ready" });
  });

  it("waits on window load for an interactive document, then defers one task", async () => {
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let loadListener: EventListener | undefined;
    let deferred: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      document: {
        baseURI: "https://classroom.test/tools/patterdraw/",
        readyState: "interactive",
      },
      addEventListener(type, listener, options) {
        expect(type).toBe("load");
        expect(options).toEqual({ once: true });
        loadListener = listener;
      },
      removeEventListener() {},
      navigator: {
        serviceWorker: { register, ready: Promise.resolve(registration), controller: null },
      },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) deferred = handler;
        return 7;
      },
    });

    const scheduled = scheduleOfflineAppShellRegistration({}, environment);
    expect(register).not.toHaveBeenCalled();
    loadListener?.(new Event("load"));
    expect(register).not.toHaveBeenCalled();
    deferred?.();
    await expect(scheduled.result).resolves.toEqual({
      status: "ready",
      registration,
      controlled: false,
    });
    expect(register).toHaveBeenCalledOnce();
  });

  it("can be canceled before registration without unregistering anything", async () => {
    const register = vi.fn<Register>();
    const clearTimeout = vi.fn();
    const environment = registrationEnvironment(register, {
      setTimeout() { return 11; },
      clearTimeout,
    });

    const scheduled = scheduleOfflineAppShellRegistration({}, environment);
    scheduled.cancel();
    await expect(scheduled.result).resolves.toEqual({ status: "canceled" });
    expect(clearTimeout).toHaveBeenCalledWith(11);
    expect(register).not.toHaveBeenCalled();
  });
});

describe("offline app-shell classroom status", () => {
  it("announces first-install readiness and publishes a diagnostic state", async () => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const serviceWorker: {
      controller: FakeServiceWorker | null;
      ready: Promise<FakeRegistration>;
      register: Register;
    } = {
      controller: null,
      ready: Promise.resolve(registration),
      register: undefined as unknown as Register,
    };
    const register = vi.fn<Register>().mockImplementation(async () => {
      // Model the generated worker's clients.claim(): readiness observes a
      // controller even though this was genuinely an uncontrolled first load.
      serviceWorker.controller = active;
      return registration;
    });
    serviceWorker.register = register;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker },
    });
    const states: string[] = [];
    const onStatus = (event: Event): void => {
      states.push((event as CustomEvent<{ status: string }>).detail.status);
    };
    document.addEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);

    const experience = installOfflineAppShellExperience({}, environment, document);
    const preparingNotice = document.getElementById(OFFLINE_APP_SHELL_STATUS_ID);
    expect(preparingNotice?.getAttribute("role")).toBe("status");
    expect(preparingNotice?.textContent).toContain("Preparing PDF, equation, diagram, and geometry tools");
    await expect(experience.result).resolves.toMatchObject({
      status: "ready",
      controlled: true,
    });

    expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
      .toBe("ready");
    const notice = document.getElementById(OFFLINE_APP_SHELL_STATUS_ID);
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(notice?.textContent).toContain("Offline classroom tools are ready");
    expect(states).toEqual(["preparing", "ready"]);

    document.removeEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);
    experience.destroy();
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)).toBeNull();
    expect(document.documentElement.hasAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE)).toBe(false);
  });

  it("replaces a bounded timeout warning when that exact registration activates later", async () => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) handler();
        else readinessTimeout = handler;
        return 21;
      },
    });
    const states: Array<{ status: string; phase?: string }> = [];
    const onStatus = (event: Event): void => {
      states.push((event as CustomEvent<{ status: string; phase?: string }>).detail);
    };
    document.addEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);

    const experience = installOfflineAppShellExperience(
      { readinessTimeoutMs: 25 },
      environment,
      document,
    );
    await vi.waitFor(() => expect(readinessTimeout).toBeTypeOf("function"));
    readinessTimeout?.();
    const boundedResult = await experience.result;
    expect(boundedResult).toMatchObject({ status: "failed", phase: "readiness" });
    expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
      .toBe("failed");
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.textContent)
      .toContain("Offline classroom setup did not finish");

    const active = new FakeServiceWorker("activating");
    registration.installing = null;
    registration.active = active;
    resolveReady?.(registration);
    await Promise.resolve();
    expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
      .toBe("failed");
    active.transition("activated");
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
        .toBe("ready");
    });
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.textContent)
      .toContain("Offline classroom tools are ready");
    await expect(experience.result).resolves.toBe(boundedResult);
    expect(states).toEqual([
      { status: "preparing" },
      { status: "failed", phase: "readiness" },
      { status: "ready" },
    ]);

    document.removeEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);
    experience.destroy();
  });

  it("does not accept late readiness from a different registered scope", async () => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const unrelated = new FakeRegistration(
      "https://classroom.test/other/",
      { active: new FakeServiceWorker("activated") },
    );
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) handler();
        else readinessTimeout = handler;
        return 22;
      },
    });

    const experience = installOfflineAppShellExperience(
      { readinessTimeoutMs: 25 },
      environment,
      document,
    );
    await vi.waitFor(() => expect(readinessTimeout).toBeTypeOf("function"));
    readinessTimeout?.();
    await expect(experience.result).resolves.toMatchObject({
      status: "failed",
      phase: "readiness",
    });
    resolveReady?.(unrelated);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
      .toBe("failed");
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.textContent)
      .toContain("Offline classroom setup did not finish");
    experience.destroy();
  });

  it("does not reinterpret a non-timeout installation failure as late readiness", async () => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
    });

    const experience = installOfflineAppShellExperience({}, environment, document);
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
    installing.transition("redundant");
    await expect(experience.result).resolves.toMatchObject({
      status: "failed",
      phase: "installation",
    });

    registration.installing = null;
    registration.active = new FakeServiceWorker("activated");
    resolveReady?.(registration);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
      .toBe("failed");
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.textContent)
      .toContain("Offline classroom setup did not finish");
    experience.destroy();
  });

  it("ignores a timed-out registration that activates after the experience is destroyed", async () => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    const installing = new FakeServiceWorker("installing");
    const registration = new FakeRegistration(undefined, { installing });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    let resolveReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) handler();
        else readinessTimeout = handler;
        return 23;
      },
    });

    const experience = installOfflineAppShellExperience(
      { readinessTimeoutMs: 25 },
      environment,
      document,
    );
    await vi.waitFor(() => expect(readinessTimeout).toBeTypeOf("function"));
    readinessTimeout?.();
    await experience.result;
    registration.installing = null;
    const active = new FakeServiceWorker("activating");
    registration.active = active;
    resolveReady?.(registration);
    await Promise.resolve();
    active.transition("activated");
    experience.destroy();
    await Promise.resolve();

    expect(document.documentElement.hasAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE)).toBe(false);
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)).toBeNull();
  });

  it("invalidates a timed-out late monitor when the teacher explicitly retries", async () => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE);
    const firstRegistration = new FakeRegistration(undefined, {
      installing: new FakeServiceWorker("installing"),
    });
    const retryError = new DOMException("retry rejected", "AbortError");
    const register = vi.fn<Register>()
      .mockResolvedValueOnce(firstRegistration)
      .mockRejectedValueOnce(retryError);
    let resolveFirstReady: ((registration: FakeRegistration) => void) | undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveFirstReady = resolve;
    });
    let readinessTimeout: (() => void) | undefined;
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker: { register, ready, controller: null } },
      setTimeout(handler, timeout) {
        if ((timeout ?? 0) === 0) handler();
        else readinessTimeout = handler;
        return 24;
      },
    });
    const states: string[] = [];
    const onStatus = (event: Event): void => {
      states.push((event as CustomEvent<{ status: string }>).detail.status);
    };
    document.addEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);

    const experience = installOfflineAppShellExperience(
      { readinessTimeoutMs: 25 },
      environment,
      document,
    );
    await vi.waitFor(() => expect(readinessTimeout).toBeTypeOf("function"));
    readinessTimeout?.();
    const boundedResult = await experience.result;
    document.querySelector<HTMLButtonElement>(
      `#${OFFLINE_APP_SHELL_STATUS_ID} button`,
    )?.click();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));

    firstRegistration.installing = null;
    firstRegistration.active = new FakeServiceWorker("activated");
    resolveFirstReady?.(firstRegistration);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
        .toBe("failed");
    });
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.textContent)
      .toContain("Offline classroom setup did not finish");
    expect(states).not.toContain("ready");
    await expect(experience.result).resolves.toBe(boundedResult);

    document.removeEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);
    experience.destroy();
  });

  it("keeps already-controlled classroom visits visually quiet", async () => {
    document.body.replaceChildren();
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const register = vi.fn<Register>().mockResolvedValue(registration);
    const environment = registrationEnvironment(register, {
      navigator: {
        serviceWorker: { register, ready: Promise.resolve(registration), controller: active },
      },
    });

    const experience = installOfflineAppShellExperience({}, environment, document);
    await experience.result;
    expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
      .toBe("ready");
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)).toBeNull();
    experience.destroy();
  });

  it("shows an accessible failure with a retry that never unregisters the active shell", async () => {
    document.body.replaceChildren();
    const active = new FakeServiceWorker("activated");
    const registration = new FakeRegistration(undefined, { active });
    const error = new DOMException("install rejected", "AbortError");
    const register = vi.fn<Register>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(registration);
    const serviceWorker = {
      register,
      ready: Promise.resolve(registration),
      controller: active,
    };
    const environment = registrationEnvironment(register, {
      navigator: { serviceWorker },
    });
    const events: Array<{ status: string; phase?: string }> = [];
    const onStatus = (event: Event): void => {
      events.push((event as CustomEvent<{ status: string; phase?: string }>).detail);
    };
    document.addEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);

    const experience = installOfflineAppShellExperience({}, environment, document);
    await expect(experience.result).resolves.toEqual({
      status: "failed",
      phase: "registration",
      error,
    });
    const failure = document.getElementById(OFFLINE_APP_SHELL_STATUS_ID);
    expect(failure?.getAttribute("role")).toBe("alert");
    expect(failure?.textContent).toContain("Offline classroom setup did not finish");
    const retry = failure?.querySelector("button");
    expect(retry?.textContent).toBe("Retry offline setup");
    retry?.click();

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledTimes(2);
      expect(document.documentElement.getAttribute(OFFLINE_APP_SHELL_STATUS_ATTRIBUTE))
        .toBe("ready");
    });
    expect(Object.keys(serviceWorker)).toEqual(["register", "ready", "controller"]);
    expect(events).toContainEqual({ status: "failed", phase: "registration" });
    document.removeEventListener(OFFLINE_APP_SHELL_STATUS_EVENT, onStatus);
    experience.destroy();
  });

  it("explains unsupported offline support without blocking the editor", async () => {
    document.body.replaceChildren();
    const environment = registrationEnvironment(vi.fn<Register>(), {
      navigator: {},
    });
    const experience = installOfflineAppShellExperience({}, environment, document);

    await expect(experience.result).resolves.toEqual({ status: "unsupported" });
    expect(document.getElementById(OFFLINE_APP_SHELL_STATUS_ID)?.textContent)
      .toContain("cannot prepare PatterDraw for offline use");
    experience.destroy();
  });
});
