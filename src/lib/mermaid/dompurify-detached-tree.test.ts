import { describe, expect, it } from "vitest";
import createDOMPurify from "dompurify";

// GHSA-p98j-92pf-mc4p: inspect the caller's detached nodes, not just the
// sanitized output. Resource-event dispatch itself is not simulated by jsdom.
describe("DOMPurify detached live-tree security", () => {
  it.each(["afterSanitizeElements", "afterSanitizeAttributes"] as const)(
    "neutralizes descendant handlers removed by %s",
    (hook) => {
      const purify = createDOMPurify(window);
      const root = document.createElement("div");
      root.innerHTML = '<section><img onerror="throw new Error(\'unsafe\')"></section>';
      const branch = root.querySelector("section")!;
      const image = branch.querySelector("img")!;
      document.body.append(root);
      try {
        const removeBranch = (node: Node) => {
          if (node === branch) branch.remove();
        };
        if (hook === "afterSanitizeElements") {
          purify.addHook(hook, removeBranch);
        } else {
          purify.addHook(hook, removeBranch);
        }
        purify.sanitize(root, { IN_PLACE: true });
        expect(root.contains(branch)).toBe(false);
        expect(image.getAttribute("onerror")).toBeNull();
      } finally {
        purify.removeAllHooks();
        root.remove();
      }
    },
  );

  it("neutralizes descendants of a permitted custom element removed after sanitization", () => {
    const purify = createDOMPurify(window);
    const root = document.createElement("div");
    root.innerHTML = '<classroom-label><img onerror="throw new Error(\'unsafe\')"></classroom-label>';
    const branch = root.querySelector("classroom-label")!;
    const image = branch.querySelector("img")!;
    document.body.append(root);
    try {
      purify.addHook("afterSanitizeElements", (node) => {
        if (node === branch) branch.remove();
      });
      purify.sanitize(root, {
        IN_PLACE: true,
        CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^classroom-label$/ },
      });
      expect(root.contains(branch)).toBe(false);
      expect(image.getAttribute("onerror")).toBeNull();
    } finally {
      purify.removeAllHooks();
      root.remove();
    }
  });

  it("retains ordinary diagram-label markup while removing executable attributes", () => {
    const purify = createDOMPurify(window);
    const root = document.createElement("div");
    root.innerHTML = '<section><strong>Start → Finish</strong><img onerror="throw new Error(\'unsafe\')"></section>';
    purify.sanitize(root, { IN_PLACE: true });
    expect(root.querySelector("strong")?.textContent).toBe("Start → Finish");
    expect(root.querySelector("section img")).not.toBeNull();
    expect(root.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });
});
