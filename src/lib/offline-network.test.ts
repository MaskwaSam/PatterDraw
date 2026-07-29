import { describe, expect, it } from "vitest";
import {
  filterOfflineFontSources,
  installOfflineNavigationGuard,
  isAllowedOfflineUrl,
} from "./offline-network";

describe("offline network policy", () => {
  const base = "https://classroom.local/course/app/index.html";

  it("allows only same-origin HTTP resources and local data", () => {
    expect(isAllowedOfflineUrl("./worker.js", base)).toBe(true);
    expect(isAllowedOfflineUrl("https://classroom.local/assets/font.woff2", base)).toBe(true);
    expect(isAllowedOfflineUrl("blob:https://classroom.local/id", base)).toBe(true);
    expect(isAllowedOfflineUrl("data:image/png;base64,AA==", base)).toBe(true);
  });

  it("blocks external and executable schemes", () => {
    expect(isAllowedOfflineUrl("https://libraries.excalidraw.com", base)).toBe(false);
    expect(isAllowedOfflineUrl("wss://example.com/socket", base)).toBe(false);
    expect(isAllowedOfflineUrl("javascript:alert(1)", base)).toBe(false);
  });

  it("removes remote fallback fonts while keeping local font sources", () => {
    const sources = "url('https://classroom.local/excalidraw-assets/fonts/default.woff2') format('woff2'), url('https://esm.sh/fallback.woff2') format('woff2')";
    expect(filterOfflineFontSources(sources, base)).toBe("url('https://classroom.local/excalidraw-assets/fonts/default.woff2') format('woff2')");
  });

  it("blocks ordinary external anchor navigation while preserving local links", () => {
    installOfflineNavigationGuard(document);
    const external = document.createElement("a");
    external.href = "https://example.test/mermaid-docs";
    let externalHandlerRan = false;
    external.addEventListener("click", () => { externalHandlerRan = true; });
    document.body.append(external);
    const externalClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    external.dispatchEvent(externalClick);
    expect(externalClick.defaultPrevented).toBe(true);
    expect(externalHandlerRan).toBe(true);

    const local = document.createElement("a");
    local.href = "#local-help";
    document.body.append(local);
    const localClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    local.dispatchEvent(localClick);
    expect(localClick.defaultPrevented).toBe(false);
  });
});
