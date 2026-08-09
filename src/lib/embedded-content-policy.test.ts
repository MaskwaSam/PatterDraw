import { describe, expect, it } from "vitest";
import {
  clipboardElementsContainBlockedContent,
  clipboardHtmlContainsBlockedContent,
  EMBEDDED_CONTENT_MODE,
  installSafeClipboardReadGuard,
  isBlockedEmbeddedElementType,
  isSafeLocalImageClipboardType,
  validateEmbeddedContentUrl,
} from "./embedded-content-policy";

describe("embedded content policy", () => {
  it("keeps the student build disabled through one explicit policy seam", () => {
    expect(EMBEDDED_CONTENT_MODE).toBe("disabled");
    expect(validateEmbeddedContentUrl("https://example.invalid/widget")).toBe(false);
  });

  it.each(["embeddable", "iframe", "magicframe"])("blocks %s elements", (type) => {
    expect(isBlockedEmbeddedElementType(type)).toBe(true);
  });

  it("allows ordinary elements and formatted text", () => {
    expect(isBlockedEmbeddedElementType("rectangle")).toBe(false);
    expect(clipboardHtmlContainsBlockedContent("<p>Class notes</p>")).toBe(false);
    expect(clipboardElementsContainBlockedContent([{ type: "rectangle", link: null }])).toBe(false);
  });

  it("blocks web-capable elements and links in Excalidraw clipboard JSON", () => {
    expect(clipboardElementsContainBlockedContent([{ type: "iframe" }])).toBe(true);
    expect(clipboardElementsContainBlockedContent([{ type: "rectangle", link: "local-review" }])).toBe(true);
    expect(clipboardElementsContainBlockedContent([{
      type: "rectangle",
      customData: { href: "local-review" },
    }])).toBe(true);
    expect(clipboardElementsContainBlockedContent([null])).toBe(true);
  });

  it("blocks active HTML and URL-backed image HTML before mixed paste", () => {
    const remote = ["https", "://example.invalid"].join("");
    const tag = (name: string, attributes: string) => `<${name}${attributes}>`;
    expect(clipboardHtmlContainsBlockedContent(tag("iframe", ` src="${remote}"`))).toBe(true);
    expect(clipboardHtmlContainsBlockedContent(tag("script", ` src="${remote}/a.js"`))).toBe(true);
    expect(clipboardHtmlContainsBlockedContent(tag("img", ` src="${remote}/a.png"`))).toBe(true);
  });

  it("lets an actual clipboard image file use the native preflight path", () => {
    expect(clipboardHtmlContainsBlockedContent('<img src="blob:clipboard">', true)).toBe(false);
  });

  it("trusts only image MIME types that the local preflight can persist", () => {
    expect(isSafeLocalImageClipboardType("image/png")).toBe(true);
    expect(isSafeLocalImageClipboardType(" IMAGE/PNG; charset=binary ")).toBe(true);
    expect(isSafeLocalImageClipboardType(" IMAGE/JPEG ")).toBe(true);
    expect(isSafeLocalImageClipboardType("image/svg+xml")).toBe(true);
    expect(isSafeLocalImageClipboardType("image/bmp")).toBe(false);
    expect(isSafeLocalImageClipboardType("image/avif")).toBe(false);
    expect(isSafeLocalImageClipboardType("image/unknown")).toBe(false);
  });

  it("filters unsafe HTML from direct Clipboard API reads and preserves plain text", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalRead = async () => [{
      types: ["text/html", "text/plain"],
      getType: async (type: string) => new Blob([
        type === "text/html" ? `<${"img"} src="remote-review">` : "Class note",
      ], { type }),
      presentationStyle: "unspecified",
    }] as ClipboardItem[];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: originalRead },
    });
    try {
      const guard = installSafeClipboardReadGuard();
      expect(guard.installed).toBe(true);
      const [item] = await navigator.clipboard.read();
      expect(item.types).toEqual(["text/plain"]);
      expect(await (await item.getType("text/plain")).text()).toBe("Class note");
      guard.restore();
      expect(navigator.clipboard.read).toBe(originalRead);
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("reports when direct Clipboard API filtering cannot be installed", () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {},
    });
    try {
      expect(installSafeClipboardReadGuard().installed).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("fails closed when clipboard HTML cannot be read", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: async () => [{
          types: ["text/html", "text/plain"],
          getType: async (type: string) => {
            if (type === "text/html") throw new Error("clipboard read failed");
            return new Blob(["Safe fallback text"], { type });
          },
          presentationStyle: "unspecified",
        }],
      },
    });
    try {
      const guard = installSafeClipboardReadGuard();
      expect(guard.installed).toBe(true);
      const [item] = await navigator.clipboard.read();
      expect(item.types).toEqual(["text/plain"]);
      expect(await (await item.getType("text/plain")).text()).toBe("Safe fallback text");
      guard.restore();
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
