import { sanitizePdfLinkUrl } from "./pdf/link-url";

const blockedMessage = "PatterDraw blocks external network access.";
const guardedDocuments = new WeakSet<Document>();
let openPdfWindow: typeof window.open | undefined;

/** The sole external-navigation exception: an explicit click on a local PDF link. */
export function openPdfWebLink(value: string, event: MouseEvent): void {
  const url = sanitizePdfLinkUrl(value);
  if (!url || !event.isTrusted || event.type !== "click" || event.button !== 0) return;
  openPdfWindow?.(url, "_blank", "noopener,noreferrer");
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export function isAllowedOfflineUrl(value: string | URL, base = window.location.href): boolean {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value, base);
  } catch {
    return false;
  }
  if (url.protocol === "blob:" || url.protocol === "data:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin === new URL(base).origin;
}

export function installOfflineNavigationGuard(targetDocument = document): void {
  if (guardedDocuments.has(targetDocument)) return;
  guardedDocuments.add(targetDocument);
  targetDocument.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (!href || isAllowedOfflineUrl(href, targetDocument.baseURI)) return;
    event.preventDefault();
  }, true);
}

export function installOfflineNetworkGuard(): void {
  if ((window as unknown as Record<string, unknown>).__patterDrawNetworkGuard) return;
  (window as unknown as Record<string, unknown>).__patterDrawNetworkGuard = true;
  installOfflineNavigationGuard();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : input;
    if (!isAllowedOfflineUrl(target)) return Promise.reject(new TypeError(blockedMessage));
    return nativeFetch(input, init);
  }) as typeof window.fetch;

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function guardedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    if (!isAllowedOfflineUrl(url)) throw new DOMException(blockedMessage, "SecurityError");
    Reflect.apply(nativeOpen, this, [method, url.toString(), async, username, password]);
  } as typeof XMLHttpRequest.prototype.open;

  if ("sendBeacon" in navigator) {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: () => false,
    });
  }

  const nativeWindowOpen = window.open.bind(window);
  openPdfWindow = nativeWindowOpen;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url && !isAllowedOfflineUrl(url)) return null;
    return nativeWindowOpen(url, target, features);
  }) as typeof window.open;
}

export function filterOfflineFontSources(source: string, base = window.location.href): string {
  return source
    .split(/,\s*(?=url\()/i)
    .filter((part) => {
      const match = part.match(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/i);
      return !match || isAllowedOfflineUrl(match[1], base);
    })
    .join(", ");
}

export function installLocalExcalidrawAssets(): void {
  window.EXCALIDRAW_ASSET_PATH = new URL("./excalidraw-assets/", window.location.href).toString();
  if (!("FontFace" in window)) return;
  const NativeFontFace = window.FontFace;
  window.FontFace = class OfflineFontFace extends NativeFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      super(
        family,
        typeof source === "string" ? filterOfflineFontSources(source) : source,
        descriptors,
      );
    }
  };
}
