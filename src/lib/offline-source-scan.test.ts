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

  it("allows only the reviewed, sandboxed local GeoGon tool frame", () => {
    const frameTag = "iframe";
    const findings = findRemoteSourceReferences(`
      import {
        LOCAL_GEOGON_VERSION,
        localGeoGonUrl,
      } from "../lib/local-geogon";
      export function GeoGonDialog() {
        return <${frameTag}
          key={frameKey}
          ref={iframeRef}
          className="geogon-frame"
          src={localGeoGonUrl()}
          title="Bundled 3D GeoGon editor"
          sandbox="allow-scripts allow-same-origin allow-downloads"
          referrerPolicy="no-referrer"
          tabIndex={0}
          onLoad={() => void handleFrameLoad()}
        />;
      }
    `, "src/components/GeoGonDialog.tsx");

    expect(findings).toEqual([]);
  });

  it("still rejects any unreviewed or additional frame", () => {
    const frameTag = "iframe";
    expect(findRemoteSourceReferences(`
      import {
        LOCAL_GEOGON_VERSION,
        localGeoGonUrl,
      } from "../lib/local-geogon";
      const unsafe = <${frameTag} src="./other/index.html" />;
    `, "src/components/GeoGonDialog.tsx")).toEqual([
      "src/components/GeoGonDialog.tsx:6 embedded web-content markup",
    ]);
    expect(findRemoteSourceReferences(
      `<${frameTag} src="./geogon/index.html" />`,
      "src/components/OtherDialog.tsx",
    )).toEqual(["src/components/OtherDialog.tsx:1 embedded web-content markup"]);
  });

  it("rejects a spoofed GeoGon frame source even when the safe resolver is present", () => {
    const frameTag = "iframe";
    expect(findRemoteSourceReferences(`
      import { localGeoGonUrl } from "../lib/local-geogon";
      export function GeoGonDialog() {
        void localGeoGonUrl();
        const source = window.name;
        return <${frameTag}
          src={source}
          title="Bundled 3D GeoGon editor"
          sandbox="allow-scripts allow-same-origin allow-downloads"
          referrerPolicy="no-referrer"
        />;
      }
    `, "src/components/GeoGonDialog.tsx")).toEqual([
      "src/components/GeoGonDialog.tsx:6 embedded web-content markup",
    ]);
  });

  it("rejects a GeoGon resolver shadowed inside the dialog", () => {
    const frameTag = "iframe";
    expect(findRemoteSourceReferences(`
      import { localGeoGonUrl } from "../lib/local-geogon";
      export function GeoGonDialog() {
        const localGeoGonUrl = () => window.name;
        return <${frameTag}
          src={localGeoGonUrl()}
          title="Bundled 3D GeoGon editor"
          sandbox="allow-scripts allow-same-origin allow-downloads"
          referrerPolicy="no-referrer"
        />;
      }
    `, "src/components/GeoGonDialog.tsx")).toEqual([
      "src/components/GeoGonDialog.tsx:5 embedded web-content markup",
    ]);
  });

  it("rejects GeoGon iframe spread overrides and srcDoc", () => {
    const frameTag = "iframe";
    const source = (extra: string) => `
      import { localGeoGonUrl } from "../lib/local-geogon";
      export function GeoGonDialog() {
        return <${frameTag}
          key={frameKey}
          ref={iframeRef}
          className="geogon-frame"
          src={localGeoGonUrl()}
          title="Bundled 3D GeoGon editor"
          sandbox="allow-scripts allow-same-origin allow-downloads"
          referrerPolicy="no-referrer"
          tabIndex={0}
          onLoad={() => void handleFrameLoad()}
          ${extra}
        />;
      }
    `;
    for (const extra of [
      "{...{ src: window.name }}",
      "srcDoc={window.name}",
    ]) {
      expect(findRemoteSourceReferences(
        source(extra),
        "src/components/GeoGonDialog.tsx",
      )).toEqual([
        "src/components/GeoGonDialog.tsx:4 embedded web-content markup",
      ]);
    }
  });

  it("rejects programmatic iframe creation outside the reviewed dialog", () => {
    const frameTag = "iframe";
    const findings = findRemoteSourceReferences(`
      const domFrame = document.createElement("${frameTag}");
      const reactFrame = React.createElement("${frameTag}", { src: window.name });
      const runtimeFrame = jsx("${frameTag}", { src: window.name });
      const bracketFrame = React["createElement"]("${frameTag}", {});
    `, "src/programmatic-frame.tsx");
    expect(findings).toEqual([
      "src/programmatic-frame.tsx:2 programmatic embedded web-content creation",
      "src/programmatic-frame.tsx:3 programmatic embedded web-content creation",
      "src/programmatic-frame.tsx:4 programmatic embedded web-content creation",
      "src/programmatic-frame.tsx:5 programmatic embedded web-content creation",
    ]);
  });
});
