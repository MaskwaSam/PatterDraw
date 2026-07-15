import { describe, expect, it } from "vitest";
import { MAX_MATH_SVG_BYTES, mathSvgToDataUrl, sanitizeGeneratedMathSvg } from "./svg";

const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect data-part="body" width="100" height="50" fill="#fff"/></svg>';

describe("generated math SVG safety", () => {
  it("preserves safe deterministic SVG and encodes Unicode labels locally", () => {
    const unicode = safeSvg.replace("</svg>", '<text x="4" y="20">π √ 30°</text></svg>');
    expect(sanitizeGeneratedMathSvg(unicode)).toBe(unicode);
    const dataUrl = mathSvgToDataUrl(unicode);
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(new TextDecoder().decode(Uint8Array.from(atob(dataUrl.split(",")[1]), (character) => character.charCodeAt(0)))).toContain("π √ 30°");
  });

  it("allows nested path-only MathJax SVG while rejecting linked glyph references", () => {
    const nested = safeSvg.replace(
      "</svg>",
      '<svg x="5" y="5" width="40" height="20" viewBox="0 0 20 10" preserveAspectRatio="xMidYMid meet"><path d="M0 0L20 10"/></svg></svg>',
    );
    expect(sanitizeGeneratedMathSvg(nested)).toBe(nested);
    expect(() => sanitizeGeneratedMathSvg(
      safeSvg.replace("</svg>", '<defs><path id="glyph" d="M0 0L1 1"/></defs><use href="#glyph"/></svg>'),
    )).toThrow(/disallowed use/);
  });

  it.each([
    ['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><script>alert(1)</script></svg>', /disallowed script/],
    ['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect onclick="alert(1)"/></svg>', /disallowed onclick/],
    ['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><image href="https://example.com/a.png"/></svg>', /disallowed image/],
    ['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect fill="url(https://example.com/x)"/></svg>', /unsafe fill/],
    ['<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="50"></svg>', /invalid width/],
  ])("rejects unsafe generated content", (svg, message) => {
    expect(() => sanitizeGeneratedMathSvg(svg)).toThrow(message);
  });

  it("rejects excessive byte and node counts", () => {
    const tooManyNodes = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">${"<circle cx=\"1\" cy=\"1\" r=\"1\"/>".repeat(5_001)}</svg>`;
    expect(() => sanitizeGeneratedMathSvg(tooManyNodes)).toThrow(/too many elements/);
    const tooManyBytes = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text>${"a".repeat(MAX_MATH_SVG_BYTES)}</text></svg>`;
    expect(() => sanitizeGeneratedMathSvg(tooManyBytes)).toThrow(/too large/);
  });
});
