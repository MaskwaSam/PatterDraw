import { describe, expect, it } from "vitest";
import { sanitizeMathSvg, validateLatexSource } from "./render-latex";

describe("LaTeX input safety", () => {
  it("accepts ordinary classroom equations", () => {
    expect(validateLatexSource("  x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}  "))
      .toBe("x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}");
  });

  it.each([
    "\\href{https://example.test}{x}",
    "\\require{html}",
    "\\newcommand{\\x}{y}",
    "\\htmlData{student=true}{x}",
    "\\newenvironment{loop}{}{}",
    "\\csname href\\endcsname",
    "\\color{url(https://example.test/paint)}{x}",
  ])(
    "rejects unsafe input: %s",
    (source) => expect(() => validateLatexSource(source)).toThrow(/disabled/),
  );

  it("removes active or external SVG content", () => {
    const source = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" href="https://root.example.test" viewBox="0 0 10 10"><defs><path id="p" d="M0 0"/></defs><use href="#p" fill="url(https://paint.example.test)"/><text x="1" y="2">safe fallback</text><a href="https://example.test"><path d="M1 1"/></a><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject></svg>',
      "image/svg+xml",
    ).documentElement as unknown as SVGSVGElement;
    const safe = sanitizeMathSvg(source, "x^2");
    expect(safe.querySelector("script, foreignObject, a")).toBeNull();
    expect(safe.getAttribute("href")).toBeNull();
    expect(safe.querySelector("use")?.getAttribute("href")).toBe("#p");
    expect(safe.querySelector("use")?.getAttribute("fill")).toBeNull();
    expect(safe.querySelector("text")?.textContent).toBe("safe fallback");
    expect(safe.outerHTML).not.toContain("https://");
  });

  it("rejects excessive structural nesting", () => {
    expect(() => validateLatexSource(`${"{".repeat(49)}x${"}".repeat(49)}`)).toThrow(/complex/);
  });
});
