/**
 * Embedded web content is deliberately disabled in the offline student build.
 *
 * Keep this policy seam instead of deleting Excalidraw's embed types: a future
 * build may add wrapper-owned, hashed local embeds after it also supplies a
 * dedicated CSP, sandbox, resource budgets, export representation, and tests.
 * Native `iframe` and `magicframe` elements must remain blocked because they
 * bypass the wrapper renderer or belong to the disabled AI flow.
 */
export const EMBEDDED_CONTENT_MODE = "disabled" as const;

const BLOCKED_EMBED_ELEMENT_TYPES = new Set([
  "embeddable",
  "iframe",
  "magicframe",
]);

const SAFE_LOCAL_IMAGE_CLIPBOARD_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

function normalizedClipboardMimeType(type: unknown): string {
  return typeof type === "string"
    ? type.split(";", 1)[0].trim().toLowerCase()
    : "";
}

export function isBlockedEmbeddedElementType(type: unknown): boolean {
  return typeof type === "string" && BLOCKED_EMBED_ELEMENT_TYPES.has(type);
}

export function isSafeLocalImageClipboardType(type: unknown): boolean {
  return SAFE_LOCAL_IMAGE_CLIPBOARD_TYPES.has(normalizedClipboardMimeType(type));
}

export function clipboardElementsContainBlockedContent(
  elements: readonly unknown[] | undefined,
): boolean {
  return !!elements?.some((value) => {
    if (!value || typeof value !== "object") return true;
    const element = value as Record<string, unknown>;
    if (isBlockedEmbeddedElementType(element.type) || !!element.link) return true;
    const customData = element.customData;
    return !!customData
      && typeof customData === "object"
      && ("url" in customData || "href" in customData);
  });
}

/** Current student builds never validate a URL as embeddable. */
export function validateEmbeddedContentUrl(_url: string): boolean {
  return false;
}

/**
 * Capture raw HTML before Excalidraw's mixed-content paste handler can turn an
 * external image URL into a fetch. A real clipboard File is handled by the
 * native image pipeline and receives byte/dimension preflight separately.
 */
export function clipboardHtmlContainsBlockedContent(
  html: string | undefined,
  hasClipboardFile = false,
): boolean {
  if (!html) return false;
  if (/<(?:iframe|script|object|embed)\b/i.test(html)) return true;
  return !hasClipboardFile && /<img\b[^>]*\bsrc\s*=/i.test(html);
}

export interface SafeClipboardReadGuard {
  installed: boolean;
  restore: () => void;
}

/**
 * Excalidraw's context-menu Paste reads the Clipboard API directly and does
 * not dispatch a DOM paste event. Filter unsafe HTML from that API while
 * retaining plain text and real local image blobs for the normal paste path.
 */
export function installSafeClipboardReadGuard(): SafeClipboardReadGuard {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== "function") {
    return { installed: false, restore: () => undefined };
  }
  const ownDescriptor = Object.getOwnPropertyDescriptor(clipboard, "read");
  const originalRead = clipboard.read.bind(clipboard);
  const guardedRead = async (): Promise<ClipboardItems> => {
    const items = await originalRead();
    return Promise.all(items.map(async (item) => {
      if (!item.types.includes("text/html")) return item;
      const withoutHtml = (): ClipboardItem => ({
        types: item.types.filter((type) => type !== "text/html"),
        getType: (type: string) => item.getType(type),
        presentationStyle: item.presentationStyle,
      }) as ClipboardItem;
      let html: string;
      try {
        html = await (await item.getType("text/html")).text();
      } catch {
        return withoutHtml();
      }
      const hasImageFile = item.types.some(isSafeLocalImageClipboardType);
      if (!clipboardHtmlContainsBlockedContent(html, hasImageFile)) return item;
      return withoutHtml();
    }));
  };
  try {
    Object.defineProperty(clipboard, "read", {
      configurable: true,
      value: guardedRead,
      writable: true,
    });
  } catch {
    return { installed: false, restore: () => undefined };
  }
  return {
    installed: true,
    restore: () => {
      if (clipboard.read !== guardedRead) return;
      if (ownDescriptor) Object.defineProperty(clipboard, "read", ownDescriptor);
      else Reflect.deleteProperty(clipboard, "read");
    },
  };
}
