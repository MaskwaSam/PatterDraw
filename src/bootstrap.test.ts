import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppErrorBoundary,
  FatalScreen,
  getMissingBootstrapCapabilities,
  installGlobalErrorHandlers,
  type BootstrapEnvironment,
} from "./bootstrap";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function completeEnvironment(): BootstrapEnvironment {
  const fetch = Object.assign(() => Promise.resolve(new Response()), {
    bind: Function.prototype.bind,
  });
  const open = Object.assign(() => null, {
    bind: Function.prototype.bind,
  });
  const xhr = Object.assign(function XMLHttpRequest() {}, {
    prototype: { open() {} },
  });
  const url = Object.assign(function URL() {}, {
    createObjectURL() { return "blob:test"; },
  });
  const blob = Object.assign(function Blob() {}, {
    prototype: { arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } },
  });
  const file = Object.assign(function File() {}, {
    prototype: { arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } },
  });
  return {
    document: {
      addEventListener() {},
      createElement(tagName: string) {
        return tagName === "canvas" ? { getContext: () => ({}) } : {};
      },
      getElementById() { return {}; },
    },
    location: { protocol: "http:" },
    navigator: {},
    fetch,
    XMLHttpRequest: xhr,
    open,
    URL: url,
    Blob: blob,
    File: file,
    FileReader: function FileReader() {},
    structuredClone: () => ({}),
    TextEncoder: function TextEncoder() {},
    TextDecoder: function TextDecoder() {},
    Promise,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe("bootstrap capability preflight", () => {
  it("accepts the browser surfaces required by the offline entrypoint", () => {
    expect(getMissingBootstrapCapabilities(completeEnvironment())).toEqual([]);
  });

  it("reports missing surfaces in a stable, user-readable order", () => {
    const environment = completeEnvironment();
    delete environment.TextEncoder;
    delete environment.fetch;
    delete environment.XMLHttpRequest;
    delete environment.URL;
    expect(getMissingBootstrapCapabilities(environment)).toEqual([
      "fetch",
      "XMLHttpRequest.open",
      "URL",
      "TextEncoder",
    ]);
  });

  it("recognizes file URLs as unsupported without touching the network", () => {
    const environment = completeEnvironment();
    environment.location = { protocol: "file:" };
    expect(getMissingBootstrapCapabilities(environment)).toContain("an HTTP(S) origin");
  });
});

describe("global bootstrap failure handlers", () => {
  it("handles uncaught window errors but ignores resource errors and handled events", () => {
    const handler = vi.fn();
    const eventWindow = document.defaultView as Window;
    const dispose = installGlobalErrorHandlers(eventWindow, handler);
    const resource = document.createElement("img");
    resource.dispatchEvent(new ErrorEvent("error", {
      bubbles: true,
      cancelable: true,
      error: new Error("image failed"),
    }));
    expect(handler).not.toHaveBeenCalled();

    const handled = new Event("error", { cancelable: true });
    Object.defineProperty(handled, "error", { value: new Error("handled") });
    handled.preventDefault();
    eventWindow.dispatchEvent(handled);
    expect(handler).not.toHaveBeenCalled();

    const uncaught = new Event("error", { cancelable: true });
    Object.defineProperty(uncaught, "error", { value: new Error("uncaught") });
    eventWindow.dispatchEvent(uncaught);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(uncaught.defaultPrevented).toBe(true);
    dispose();
  });

  it("normalizes unhandled rejection reasons and does not stack listeners", () => {
    const first = vi.fn();
    const second = vi.fn();
    const eventWindow = document.defaultView as Window;
    const dispose = installGlobalErrorHandlers(eventWindow, first);
    const sameDispose = installGlobalErrorHandlers(eventWindow, second);
    expect(sameDispose).toBe(dispose);

    const rejection = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(rejection, "reason", { value: "offline failure" });
    eventWindow.dispatchEvent(rejection);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(second.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(rejection.defaultPrevented).toBe(true);
    dispose();
  });

  it("ignores expected AbortError cancellations", () => {
    const handler = vi.fn();
    const eventWindow = document.defaultView as Window;
    const dispose = installGlobalErrorHandlers(eventWindow, handler);
    const rejection = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(rejection, "reason", { value: new DOMException("cancelled", "AbortError") });
    eventWindow.dispatchEvent(rejection);
    expect(handler).not.toHaveBeenCalled();
    expect(rejection.defaultPrevented).toBe(true);
    dispose();
  });
});

describe("fatal recovery UI", () => {
  it("renders a reload action without exposing the failed module detail", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const onReload = vi.fn();
    act(() => {
      root.render(createElement(FatalScreen, {
        failure: { kind: "bootstrap", error: new Error("secret chunk URL") },
        onReload,
      }));
    });
    expect(container.querySelector("[data-testid='patterdraw-fatal-screen']")).not.toBeNull();
    expect(container.textContent).toContain("PatterDraw could not start");
    expect(container.textContent).toContain("Reloading does not delete local autosave data on this device");
    expect(container.textContent).not.toContain("secret chunk URL");
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("renders the fatal shell for an App render exception", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const boundary = new AppErrorBoundary({ children: null, onReload: vi.fn() });
    boundary.state = AppErrorBoundary.getDerivedStateFromError(new Error("render detail"));
    await act(async () => {
      root.render(boundary.render());
    });
    expect(container.querySelector("[data-fatal-kind='runtime']")).not.toBeNull();
    expect(container.textContent).toContain("PatterDraw stopped unexpectedly");
    expect(container.textContent).not.toContain("render detail");
  });
});
