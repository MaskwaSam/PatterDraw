import { Component, type CSSProperties, type ReactNode } from "react";

/**
 * The bootstrap runs before the App chunk (and its stylesheet) has loaded.
 * Keep the recovery UI self contained so a failed chunk can never leave an
 * otherwise empty document behind.
 */

export type FatalFailure =
  | {
      kind: "unsupported-browser";
      missing: readonly string[];
    }
  | {
      kind: "bootstrap" | "runtime";
      error?: unknown;
    };

export interface BootstrapEnvironment {
  document?: {
    addEventListener?: unknown;
    createElement?: (tagName: string) => unknown;
    getElementById?: (id: string) => unknown;
  };
  location?: {
    protocol?: unknown;
  };
  navigator?: unknown;
  fetch?: unknown;
  XMLHttpRequest?: {
    prototype?: {
      open?: unknown;
    };
  };
  open?: unknown;
  URL?: {
    createObjectURL?: unknown;
  };
  Blob?: {
    prototype?: {
      arrayBuffer?: unknown;
    };
  };
  File?: {
    prototype?: {
      arrayBuffer?: unknown;
    };
  };
  FileReader?: unknown;
  structuredClone?: unknown;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
  Promise?: unknown;
  requestAnimationFrame?: unknown;
  cancelAnimationFrame?: unknown;
  matchMedia?: unknown;
}

type CanvasDocument = NonNullable<BootstrapEnvironment["document"]> & {
  createElement?: (tagName: string) => {
    getContext?: (contextId: string) => unknown;
  };
};

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function hasCallableMember(value: unknown, member: string): boolean {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  return isCallable((value as Record<string, unknown>)[member]);
}

/**
 * Return a deterministic list of browser capabilities required before the
 * offline guard and App module can be safely evaluated.
 *
 * The function accepts an environment object so tests can exercise old or
 * partially implemented browser surfaces without mutating the real window.
 * IndexedDB, Web Crypto, workers, clipboard, and ResizeObserver are not part
 * of this gate: the app has explicit fallbacks for those surfaces and can
 * still open a temporary board when storage is unavailable.
 */
export function getMissingBootstrapCapabilities(
  environment: BootstrapEnvironment = globalThis as unknown as BootstrapEnvironment,
): string[] {
  const missing: string[] = [];
  const targetDocument = environment.document;

  if (!targetDocument || !isCallable(targetDocument.addEventListener)
    || !isCallable(targetDocument.createElement)
    || !isCallable(targetDocument.getElementById)) {
    missing.push("a DOM document");
  }

  const protocol = environment.location?.protocol;
  if (typeof protocol === "string" && protocol !== "http:" && protocol !== "https:") {
    missing.push("an HTTP(S) origin");
  }

  if (!isCallable(environment.Promise)) missing.push("Promises");

  if (!isCallable(environment.fetch) || !hasCallableMember(environment.fetch, "bind")) {
    missing.push("fetch");
  }

  const xhr = environment.XMLHttpRequest;
  if (!xhr || !isCallable(xhr) || !isCallable(xhr.prototype?.open)) {
    missing.push("XMLHttpRequest.open");
  }

  if (!environment.navigator || (typeof environment.navigator !== "object"
    && typeof environment.navigator !== "function")) {
    missing.push("navigator");
  }

  if (!isCallable(environment.URL)) {
    missing.push("URL");
  } else if (!isCallable(environment.URL.createObjectURL)) {
    missing.push("URL.createObjectURL");
  }

  if (!isCallable(environment.Blob)
    || !isCallable(environment.Blob.prototype?.arrayBuffer)) {
    missing.push("Blob.arrayBuffer");
  }

  if (!isCallable(environment.File)
    || !isCallable(environment.File.prototype?.arrayBuffer)) {
    missing.push("File.arrayBuffer");
  }

  if (!isCallable(environment.structuredClone)) missing.push("structuredClone");
  if (!isCallable(environment.TextEncoder)) missing.push("TextEncoder");
  if (!isCallable(environment.TextDecoder)) missing.push("TextDecoder");
  if (!isCallable(environment.requestAnimationFrame)) missing.push("requestAnimationFrame");
  if (!isCallable(environment.cancelAnimationFrame)) missing.push("cancelAnimationFrame");

  // Canvas is checked by asking for a 2D context rather than only checking
  // the constructor. A browser may expose canvas but have it disabled by a
  // policy or an unavailable graphics backend.
  if (targetDocument && isCallable(targetDocument.createElement)) {
    try {
      const createElement = (targetDocument as CanvasDocument).createElement as (
        tagName: string,
      ) => { getContext?: (contextId: string) => unknown };
      const canvas = createElement.call(targetDocument, "canvas");
      if (!canvas || !isCallable(canvas.getContext) || !canvas.getContext("2d")) {
        missing.push("Canvas 2D");
      }
    } catch {
      missing.push("Canvas 2D");
    }
  }

  return missing;
}

export function normalizeBootstrapError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason);
  if (reason && typeof reason === "object") {
    const candidate = reason as { message?: unknown };
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return new Error(candidate.message);
    }
  }
  return new Error("PatterDraw encountered an unexpected error.");
}

function isAbortLikeError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  return (reason as { name?: unknown }).name === "AbortError";
}

export type GlobalFailureHandler = (reason: unknown) => void;

interface InstalledGlobalHandlers {
  dispose: () => void;
  setHandler: (handler: GlobalFailureHandler) => void;
}

const GLOBAL_HANDLERS_KEY = "__patterDrawGlobalErrorHandlers";

type ErrorHandlingWindow = Window & {
  [GLOBAL_HANDLERS_KEY]?: InstalledGlobalHandlers;
};

/**
 * Install one pair of global handlers. A second call updates the callback
 * rather than stacking listeners, which keeps bootstrap/retry tests and any
 * embedded host from receiving duplicate fatal renders.
 */
export function installGlobalErrorHandlers(
  target: Window,
  handler: GlobalFailureHandler,
): () => void {
  const host = target as ErrorHandlingWindow;
  const existing = host[GLOBAL_HANDLERS_KEY];
  if (existing) {
    existing.setHandler(handler);
    return existing.dispose;
  }

  let currentHandler = handler;
  const onError = (event: ErrorEvent): void => {
    // Resource failures (for example an image or script element) bubble as
    // `error` events too. They have an element target (nodeType 1), whereas a
    // genuine window error is targeted at the Window object. Checking the node
    // type avoids proxy identity differences across DOM implementations.
    if (event.target && (event.target as { nodeType?: unknown }).nodeType === 1) return;
    if (event.defaultPrevented) return;
    try {
      currentHandler(normalizeBootstrapError(event.error || event.message));
    } finally {
      event.preventDefault();
    }
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (event.defaultPrevented) return;
    // App-level file/PDF switches deliberately cancel stale work. Those
    // AbortErrors are expected control flow, not evidence that the editor
    // crashed, so suppress the browser's duplicate rejection report without
    // replacing the live editor with a fatal screen.
    if (isAbortLikeError(event.reason)) {
      event.preventDefault();
      return;
    }
    try {
      currentHandler(normalizeBootstrapError(event.reason));
    } finally {
      event.preventDefault();
    }
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
    if (host[GLOBAL_HANDLERS_KEY]?.dispose === dispose) {
      delete host[GLOBAL_HANDLERS_KEY];
    }
  };
  const installed: InstalledGlobalHandlers = {
    dispose,
    setHandler(nextHandler) {
      currentHandler = nextHandler;
    },
  };
  host[GLOBAL_HANDLERS_KEY] = installed;
  return dispose;
}

export function reloadPatterDraw(): void {
  try {
    if (typeof window !== "undefined" && typeof window.location.reload === "function") {
      window.location.reload();
    }
  } catch {
    // A host or test harness may intentionally disable navigation. The fatal
    // shell remains actionable through its own diagnostics in that case.
  }
}

const shellStyle: CSSProperties = {
  alignItems: "center",
  background: "#f3f5f8",
  color: "#172033",
  display: "grid",
  fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  minHeight: "100%",
  overflow: "auto",
  padding: "32px 20px",
  width: "100%",
};

const cardStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #d8dde6",
  borderRadius: "12px",
  boxShadow: "0 14px 38px rgb(15 23 42 / 12%)",
  maxWidth: "560px",
  padding: "28px",
  width: "100%",
};

const buttonStyle: CSSProperties = {
  background: "#2859c5",
  border: "1px solid #204aa5",
  borderRadius: "7px",
  color: "#ffffff",
  cursor: "pointer",
  fontWeight: 650,
  marginTop: "8px",
  padding: "10px 15px",
};

const titleStyle: CSSProperties = {
  fontSize: "22px",
  lineHeight: 1.2,
  margin: "0 0 12px",
};

const paragraphStyle: CSSProperties = {
  color: "#536078",
  fontSize: "14px",
  lineHeight: 1.55,
  margin: "10px 0",
};

const listStyle: CSSProperties = {
  color: "#536078",
  fontSize: "13px",
  lineHeight: 1.5,
  margin: "8px 0 14px",
  paddingLeft: "22px",
};

function failureCopy(failure: FatalFailure): {
  title: string;
  description: string;
} {
  if (failure.kind === "unsupported-browser") {
    return {
      title: "PatterDraw needs a supported browser",
      description: "This browser is missing a capability required to run the offline editor.",
    };
  }
  if (failure.kind === "bootstrap") {
    return {
      title: "PatterDraw could not start",
      description: "The editor could not be loaded. Reload PatterDraw to try again.",
    };
  }
  return {
    title: "PatterDraw stopped unexpectedly",
    description: "The editor encountered a problem and needs to be reloaded.",
  };
}

export interface FatalScreenProps {
  failure: FatalFailure;
  onReload?: () => void;
}

export function FatalScreen({ failure, onReload = reloadPatterDraw }: FatalScreenProps) {
  const copy = failureCopy(failure);
  return (
    <main
      aria-live="assertive"
      data-fatal-kind={failure.kind}
      data-testid="patterdraw-fatal-screen"
      role="alert"
      style={shellStyle}
    >
      <section style={cardStyle}>
        <h1 style={titleStyle}>{copy.title}</h1>
        <p style={paragraphStyle}>{copy.description}</p>
        {failure.kind === "unsupported-browser" && (
          <>
            <p style={paragraphStyle}>
              Open PatterDraw from a local HTTP(S) address in a current browser. File URLs cannot load its bundled offline workers.
            </p>
            {failure.missing.length > 0 && (
              <>
                <p style={paragraphStyle}>Missing capabilities:</p>
                <ul data-testid="patterdraw-missing-capabilities" style={listStyle}>
                  {failure.missing.map((capability) => <li key={capability}>{capability}</li>)}
                </ul>
              </>
            )}
          </>
        )}
        <p style={paragraphStyle}>
          Reloading does not delete local autosave data on this device.
        </p>
        <button type="button" onClick={onReload} style={buttonStyle}>
          Reload PatterDraw
        </button>
      </section>
    </main>
  );
}

export function LoadingScreen() {
  return (
    <main aria-live="polite" data-testid="patterdraw-loading-screen" role="status" style={shellStyle}>
      <section style={cardStyle}>
        <h1 style={titleStyle}>Loading PatterDraw…</h1>
        <p style={paragraphStyle}>Preparing the offline classroom editor.</p>
      </section>
    </main>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  onReload?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/** Catch render and lifecycle failures from the dynamically loaded App. */
export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(_error?: unknown): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <FatalScreen
          failure={{ kind: "runtime" }}
          onReload={this.props.onReload}
        />
      );
    }
    return this.props.children;
  }
}

function staticFailureText(failure: FatalFailure): {
  title: string;
  description: string;
} {
  return failureCopy(failure);
}

function replaceChildrenSafely(parent: Element, child: Element): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  parent.appendChild(child);
}

/**
 * Last-resort fallback for a missing mount node or a failed React root. This
 * intentionally uses textContent and inline styles, never innerHTML or error
 * details supplied by a failed module.
 */
export function renderStaticFatalScreen(
  targetDocument: Document,
  failure: FatalFailure,
  mount: Element | null = targetDocument.getElementById("root") || targetDocument.body,
  onReload: () => void = reloadPatterDraw,
): HTMLElement | null {
  if (!mount) return null;
  const copy = staticFailureText(failure);
  const screen = targetDocument.createElement("main");
  screen.dataset.fatalKind = failure.kind;
  screen.dataset.testid = "patterdraw-fatal-screen";
  screen.setAttribute("aria-live", "assertive");
  screen.setAttribute("role", "alert");
  Object.assign(screen.style, shellStyle);

  const card = targetDocument.createElement("section");
  Object.assign(card.style, cardStyle);
  const title = targetDocument.createElement("h1");
  Object.assign(title.style, titleStyle);
  title.textContent = copy.title;
  card.append(title);
  const description = targetDocument.createElement("p");
  Object.assign(description.style, paragraphStyle);
  description.textContent = copy.description;
  card.append(description);

  if (failure.kind === "unsupported-browser") {
    const support = targetDocument.createElement("p");
    Object.assign(support.style, paragraphStyle);
    support.textContent = "Open PatterDraw from a local HTTP(S) address in a current browser. File URLs cannot load its bundled offline workers.";
    card.append(support);
    if (failure.missing.length > 0) {
      const missing = targetDocument.createElement("p");
      Object.assign(missing.style, paragraphStyle);
      missing.textContent = `Missing capabilities: ${failure.missing.join(", ")}`;
      card.append(missing);
    }
  }

  const autosave = targetDocument.createElement("p");
  Object.assign(autosave.style, paragraphStyle);
  autosave.textContent = "Reloading does not delete local autosave data on this device.";
  card.append(autosave);
  const reload = targetDocument.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload PatterDraw";
  Object.assign(reload.style, buttonStyle);
  reload.addEventListener("click", onReload);
  card.append(reload);
  screen.append(card);
  replaceChildrenSafely(mount, screen);
  return screen;
}
