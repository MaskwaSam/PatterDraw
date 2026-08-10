import {
  MAX_CLIPBOARD_TEXT_BYTES,
  assertImportTextBytes,
} from "./structural-limits";

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

/** Run in the capture phase, before Excalidraw JSON.parse/DOMParser work. */
export function assertClipboardTextPayloadsWithinLimit(
  plainText: string | undefined,
  html: string | undefined,
): void {
  if (plainText) {
    assertImportTextBytes(plainText, MAX_CLIPBOARD_TEXT_BYTES, "Clipboard text");
  }
  if (html) {
    assertImportTextBytes(html, MAX_CLIPBOARD_TEXT_BYTES, "Clipboard HTML");
  }
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
  const ownReadTextDescriptor = Object.getOwnPropertyDescriptor(clipboard, "readText");
  const originalRead = clipboard.read.bind(clipboard);
  const originalReadText = typeof clipboard.readText === "function"
    ? clipboard.readText.bind(clipboard)
    : undefined;
  const guardedRead = async (): Promise<ClipboardItems> => {
    const items = await originalRead();
    return Promise.all(items.map(async (item) => {
      const blockedTypes = new Set<string>();
      const withoutBlockedTypes = (): ClipboardItem => ({
        types: item.types.filter((type) => !blockedTypes.has(type)),
        getType: (type: string) => blockedTypes.has(type)
          ? Promise.reject(new DOMException("Clipboard type is blocked by the offline content policy.", "NotAllowedError"))
          : item.getType(type),
        presentationStyle: item.presentationStyle,
      }) as ClipboardItem;

      if (item.types.includes("text/plain")) {
        try {
          const plainBlob = await item.getType("text/plain");
          if (plainBlob.size > MAX_CLIPBOARD_TEXT_BYTES) throw new Error("Clipboard text is too large.");
          assertImportTextBytes(
            await plainBlob.text(),
            MAX_CLIPBOARD_TEXT_BYTES,
            "Clipboard text",
          );
        } catch {
          blockedTypes.add("text/plain");
        }
      }

      if (item.types.includes("text/html")) {
        try {
          const htmlBlob = await item.getType("text/html");
          if (htmlBlob.size > MAX_CLIPBOARD_TEXT_BYTES) throw new Error("Clipboard HTML is too large.");
          const html = await htmlBlob.text();
          assertImportTextBytes(html, MAX_CLIPBOARD_TEXT_BYTES, "Clipboard HTML");
          const hasImageFile = item.types.some(isSafeLocalImageClipboardType);
          if (clipboardHtmlContainsBlockedContent(html, hasImageFile)) {
            blockedTypes.add("text/html");
          }
        } catch {
          blockedTypes.add("text/html");
        }
      }

      return blockedTypes.size ? withoutBlockedTypes() : item;
    }));
  };
  const guardedReadText = originalReadText
    ? async (): Promise<string> => {
      const text = await originalReadText();
      assertImportTextBytes(text, MAX_CLIPBOARD_TEXT_BYTES, "Clipboard text");
      return text;
    }
    : undefined;
  const restoreRead = () => {
    if (clipboard.read !== guardedRead) return;
    if (ownDescriptor) Object.defineProperty(clipboard, "read", ownDescriptor);
    else Reflect.deleteProperty(clipboard, "read");
  };
  const restoreReadText = () => {
    if (!guardedReadText || clipboard.readText !== guardedReadText) return;
    if (ownReadTextDescriptor) Object.defineProperty(clipboard, "readText", ownReadTextDescriptor);
    else Reflect.deleteProperty(clipboard, "readText");
  };
  try {
    Object.defineProperty(clipboard, "read", {
      configurable: true,
      value: guardedRead,
      writable: true,
    });
    if (guardedReadText) {
      Object.defineProperty(clipboard, "readText", {
        configurable: true,
        value: guardedReadText,
        writable: true,
      });
    }
  } catch {
    restoreReadText();
    restoreRead();
    return { installed: false, restore: () => undefined };
  }
  return {
    installed: true,
    restore: () => {
      restoreReadText();
      restoreRead();
    },
  };
}
