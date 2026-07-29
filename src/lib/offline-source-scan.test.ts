import { describe, expect, it } from "vitest";
import {
  findRemoteSourceReferences,
  isScannableSourceFile,
} from "../../scripts/offline-source-scan.mjs";

describe("offline source scanning", () => {
  it("scans CSS files", () => {
    expect(isScannableSourceFile("src/styles.css")).toBe(true);
  });

  it("detects remote CSS imports and assets, including protocol-relative URLs", () => {
    const findings = findRemoteSourceReferences(`
      @import "https://example.test/theme.css";
      @import url('//example.test/fonts.css');
      .hero { background-image: url(https://example.test/hero.png); }
    `, "src/unsafe.css");

    expect(findings).toEqual([
      "src/unsafe.css:2 remote CSS import",
      "src/unsafe.css:3 remote CSS import",
      "src/unsafe.css:3 remote CSS asset",
      "src/unsafe.css:4 remote CSS asset",
    ]);
  });

  it("allows bundled, embedded, and blob-backed CSS assets", () => {
    const findings = findRemoteSourceReferences(`
      @import "./theme.css";
      .local { background: url("../images/local.png"); }
      .embedded { background: url("data:image/png;base64,AA=="); }
      .runtime { background: url(blob:local-preview); }
    `, "src/safe.css");

    expect(findings).toEqual([]);
  });

  it("detects remote CSS in HTML style blocks and style attributes", () => {
    const findings = findRemoteSourceReferences(`
      <style>
        @import url("https://example.test/theme.css");
        .hero { background-image: url(//example.test/hero.png); }
        .local { background: url("./local.png"); }
        .embedded { mask-image: url(data:image/svg+xml;base64,AA==); }
      </style>
      <main style="background-image: url('https://example.test/card.png')"></main>
      <aside style="background-image: url(blob:local-preview)"></aside>
    `, "index.html");

    expect(findings).toEqual([
      "index.html:3 remote CSS import",
      "index.html:3 remote CSS asset",
      "index.html:4 remote CSS asset",
      "index.html:8 remote CSS asset",
    ]);
  });

  it("detects remote CSS in scoped TSX styling contexts", () => {
    const findings = findRemoteSourceReferences(`
      const cardStyle = {
        backgroundImage: "url(https://example.test/card.png)",
      };
      const localStyle = { backgroundImage: "url(./local.png)" };
      const tooltipCss = "background-image: url(https://example.test/tooltip.png)";
      const sheet = css\`
        @import url("//example.test/theme.css");
      \`;
      export function Card() {
        return (
          <>
            <style>{\`.badge { mask-image: url(https://example.test/badge.svg); }\`}</style>
            <div style={cardStyle} />
            <div style={{ backgroundImage: "url(data:image/png;base64,AA==)" }} />
            <div style={{ backgroundImage: "url(blob:local-preview)" }} />
            <div style={{ backgroundImage: \`url(https://example.test/inline.png)\` }} />
          </>
        );
      }
    `, "src/Card.tsx");

    expect(findings).toEqual([
      "src/Card.tsx:3 remote CSS asset",
      "src/Card.tsx:6 remote CSS asset",
      "src/Card.tsx:8 remote CSS import",
      "src/Card.tsx:8 remote CSS asset",
      "src/Card.tsx:13 remote CSS asset",
      "src/Card.tsx:17 remote CSS asset",
    ]);
  });

  it("does not treat ordinary test-source fixture strings as live TSX styling", () => {
    const findings = findRemoteSourceReferences(`
      const jsxFixture = \`
        <div style={{ backgroundImage: "url(https://example.test/fixture.png)" }} />
      \`;
      const cssFixture = "@import url(https://example.test/fixture.css)";
      expect(jsxFixture).toContain(cssFixture);
    `, "src/example.test.tsx");

    expect(findings).toEqual([]);
  });
});
