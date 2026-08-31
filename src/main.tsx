import { createRoot, type Root } from "react-dom/client";
import {
  AppErrorBoundary,
  FatalScreen,
  getMissingBootstrapCapabilities,
  installGlobalErrorHandlers,
  LoadingScreen,
  renderStaticFatalScreen,
  type FatalFailure,
} from "./bootstrap";
import { installLocalExcalidrawAssets, installOfflineNetworkGuard } from "./lib/offline-network";
import { installOfflineAppShellExperience } from "./lib/offline-app-shell";

function renderFatal(
  root: Root | null,
  mount: HTMLElement | null,
  failure: FatalFailure,
): void {
  if (root) {
    try {
      root.render(<FatalScreen failure={failure} />);
      return;
    } catch {
      // A broken React root must not turn recovery into another blank screen.
    }
  }
  if (typeof document !== "undefined") {
    renderStaticFatalScreen(document, failure, mount);
  }
}

function renderApp(root: Root, App: typeof import("./App").default): void {
  root.render(
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>,
  );
}

async function bootstrap(root: Root, mount: HTMLElement): Promise<void> {
  let fatalShown = false;
  let removeGlobalErrorHandlers: (() => void) | undefined;
  const showFatal = (failure: FatalFailure): void => {
    if (fatalShown) return;
    fatalShown = true;
    removeGlobalErrorHandlers?.();
    renderFatal(root, mount, failure);
  };

  removeGlobalErrorHandlers = installGlobalErrorHandlers(window, (error) => {
    showFatal({ kind: "runtime", error });
  });

  try {
    // These calls mutate browser globals, so capability preflight must happen
    // before either guard is invoked.
    installOfflineNetworkGuard();
    installLocalExcalidrawAssets();
    const { default: App } = await import("./App");
    if (fatalShown) return;
    renderApp(root, App);
    // Registration is optional and deferred until window load. A new worker
    // may install in the background, but it never replaces the code beneath
    // this open classroom lesson or forces a reload.
    if (import.meta.env.PROD) installOfflineAppShellExperience();
  } catch (error) {
    showFatal({ kind: "bootstrap", error });
  }
}

function start(): void {
  if (typeof document === "undefined") return;
  const mount = document.getElementById("root");
  if (!mount) {
    renderStaticFatalScreen(document, { kind: "bootstrap" }, document.body);
    return;
  }

  let root: Root;
  try {
    root = createRoot(mount);
  } catch {
    renderStaticFatalScreen(document, { kind: "bootstrap" }, mount);
    return;
  }

  const missing = getMissingBootstrapCapabilities();
  if (missing.length > 0) {
    renderFatal(root, mount, { kind: "unsupported-browser", missing });
    return;
  }

  try {
    root.render(<LoadingScreen />);
  } catch {
    renderStaticFatalScreen(document, { kind: "bootstrap" }, mount);
    return;
  }

  // Do not use top-level await here. A rejected App chunk is handled by the
  // promise catch in bootstrap(), which keeps a deterministic recovery shell
  // visible instead of allowing a blank document.
  void bootstrap(root, mount).catch((error) => {
    renderFatal(root, mount, { kind: "bootstrap", error });
  });
}

start();
