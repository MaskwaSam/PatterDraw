#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { findRemoteSourceFindings } from "./offline-source-scan.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scanRoots = [
  path.join(root, "src"),
  path.join(root, "index.html"),
  path.join(root, "vite.config.ts"),
];
const findings = await findRemoteSourceFindings(root, scanRoots);

const mainSource = await readFile(path.join(root, "src/main.tsx"), "utf8");
if (!mainSource.includes("installOfflineNetworkGuard()")) {
  findings.push("src/main.tsx:1 runtime network guard is not installed");
}
if (!mainSource.includes("installLocalExcalidrawAssets()")) {
  findings.push("src/main.tsx:1 local Excalidraw asset path is not installed");
}
const indexSource = await readFile(path.join(root, "index.html"), "utf8");
const cspMatch = indexSource.match(
  /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\scontent="([^"]+)"/i,
);
const expectedCsp = new Map([
  ["default-src", ["'self'", "blob:", "data:"]],
  ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
  ["worker-src", ["'self'", "blob:"]],
  ["style-src", ["'self'", "'unsafe-inline'"]],
  ["img-src", ["'self'", "blob:", "data:"]],
  ["font-src", ["'self'", "data:"]],
  ["connect-src", ["'self'"]],
  ["media-src", ["'self'", "blob:", "data:"]],
  ["frame-src", ["'none'"]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'self'"]],
]);
const actualCsp = new Map(
  (cspMatch?.[1] || "")
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...tokens] = directive.split(/\s+/);
      return [name, tokens];
    }),
);
const cspMatches = actualCsp.size === expectedCsp.size
  && [...expectedCsp].every(([name, expectedTokens]) => {
    const actualTokens = actualCsp.get(name);
    return actualTokens?.length === expectedTokens.length
      && expectedTokens.every((token) => actualTokens.includes(token));
  });
if (!cspMatches) {
  findings.push("index.html:1 restrictive CSP is missing");
}
const packageSource = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (packageSource.dependencies?.mathjax !== "4.1.3") {
  findings.push("package.json:1 MathJax must remain pinned to 4.1.3");
}
if (packageSource.dependencies?.["@excalidraw/mermaid-to-excalidraw"] !== "2.2.2") {
  findings.push("package.json:1 Mermaid converter must remain pinned to 2.2.2");
}
if (packageSource.dependencies?.["pdfjs-dist"] !== "6.2.108") {
  findings.push("package.json:1 PDF.js must remain pinned to the reviewed 6.2.108 security release");
}
if (packageSource.dependencies?.pptxgenjs !== "file:vendor/pptxgenjs-browser") {
  findings.push("package.json:1 PptxGenJS must use the reviewed browser-only local package");
}
if (packageSource.dependencies?.jszip !== "3.10.1") {
  findings.push("package.json:1 JSZip must remain pinned to 3.10.1");
}

const vendorRoot = path.join(root, "vendor/pptxgenjs-browser");
const vendorManifest = JSON.parse(await readFile(path.join(vendorRoot, "package.json"), "utf8"));
if (
  vendorManifest.name !== "pptxgenjs"
  || vendorManifest.version !== "4.0.1-patterdraw.1"
  || vendorManifest.dependencies?.jszip !== "3.10.1"
  || Object.hasOwn(vendorManifest.dependencies || {}, "image-size")
) {
  findings.push("vendor/pptxgenjs-browser/package.json:1 reviewed browser-only dependency boundary changed");
}
for (const [relative, expectedSha256] of [
  ["package.json", "f3622752a70dee653dc91ef870e3ecc8ef2b503d7117e3bd674120d4babd9122"],
  ["dist/pptxgen.es.js", "05844c5625e2cda3b449eb967c2246dd57ca57341886a7c28eeebca263b29bd4"],
  ["types/index.d.ts", "0726d015dbcb55ccfa75546cb2fd43fe13a0dfeb783d08572f1c62f59193bbe5"],
  ["LICENSE", "7a2bfe96150786ed1908b8e63f98ebab88875c1e79e28faff6649e0f11f77e52"],
]) {
  const bytes = await readFile(path.join(vendorRoot, relative));
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    findings.push(`vendor/pptxgenjs-browser/${relative}: reviewed upstream PptxGenJS bytes changed`);
  }
}
const viteSource = await readFile(path.join(root, "vite.config.ts"), "utf8");
if (!viteSource.includes("localMathJaxAssets") || !viteSource.includes('"mathjax/tex-svg.js"')) {
  findings.push("vite.config.ts:1 local MathJax asset packaging is missing");
}
if (
  !viteSource.includes("localPdfjsAssets")
  || !viteSource.includes("pdfjs/standard_fonts/")
) {
  findings.push("vite.config.ts:1 local PDF.js standard-font asset packaging is missing");
}
if (
  !viteSource.includes("mathJaxSreRoot")
  || !viteSource.includes('"speech-worker.js"')
  || !viteSource.includes('"mathmaps/base.json"')
  || !viteSource.includes('"mathmaps/en.json"')
) {
  findings.push("vite.config.ts:1 local MathJax SRE worker assets are missing");
}
if (viteSource.includes("input/tex/extensions")) {
  findings.push("vite.config.ts:1 optional MathJax TeX extensions must not be shipped");
}
const importPdfSource = await readFile(path.join(root, "src/lib/pdf/import-pdf.ts"), "utf8");
if (
  !importPdfSource.includes("standardFontDataUrl")
  || !importPdfSource.includes("./pdfjs/standard_fonts/")
) {
  findings.push("src/lib/pdf/import-pdf.ts:1 PDF.js standardFontDataUrl must point at bundled local assets");
}
if (
  !importPdfSource.includes("enableScripting: false")
  || !importPdfSource.includes("isEvalSupported: false")
) {
  findings.push("src/lib/pdf/import-pdf.ts:1 PDF scripting and dynamic evaluation must remain explicitly disabled");
}
const darkPdfSource = await readFile(path.join(root, "src/lib/pdf/dark-preview.ts"), "utf8");
if (
  !darkPdfSource.includes("enableScripting: false")
  || !darkPdfSource.includes("isEvalSupported: false")
) {
  findings.push("src/lib/pdf/dark-preview.ts:1 PDF scripting and dynamic evaluation must remain explicitly disabled");
}
const noticesSource = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
if (!noticesSource.includes("LICENSE_FOXIT") || !noticesSource.includes("LICENSE_LIBERATION")) {
  findings.push("THIRD_PARTY_NOTICES.md:1 PDF.js standard-font license provenance is missing");
}

// When a build has already been produced, verify the exact runtime files that
// PDF.js and MathJax request. Keep this optional so check:safety remains useful
// before the first build in a fresh checkout.
try {
  await stat(path.join(root, "dist"));
  for (const relative of [
    "pdfjs/standard_fonts/LiberationSans-Regular.ttf",
    "pdfjs/standard_fonts/LICENSE_LIBERATION",
    "mathjax/sre/speech-worker.js",
    "mathjax/sre/mathmaps/base.json",
    "mathjax/sre/mathmaps/en.json",
  ]) {
    try {
      await stat(path.join(root, "dist", relative));
    } catch {
      findings.push(`dist/${relative}: bundled local runtime asset is missing`);
    }
  }
} catch {
  // No build output yet; source checks above still enforce the packaging path.
}
const latexSource = await readFile(path.join(root, "src/lib/latex/render-latex.ts"), "utf8");
if (!latexSource.includes("/mathjax/tex-svg.js") || !latexSource.includes("sanitizeMathSvg")) {
  findings.push("src/lib/latex/render-latex.ts:1 local or sanitized MathJax rendering is missing");
}
if (!latexSource.includes('"[-]": ["autoload", "require"]') || !latexSource.includes("isSafePaint")) {
  findings.push("src/lib/latex/render-latex.ts:1 MathJax extension or SVG paint safeguards are missing");
}
const appSource = await readFile(path.join(root, "src/App.tsx"), "utf8");
if (!appSource.includes("aiEnabled={false}") || !appSource.includes("MermaidDialog")) {
  findings.push("src/App.tsx:1 AI must stay disabled and the safe Mermaid dialog must stay installed");
}
if (appSource.includes("openExternalWebLink") || !appSource.includes("External links are disabled")) {
  findings.push("src/App.tsx:1 external canvas links must remain blocked");
}
if (
  appSource.includes('import { importPdf } from "./lib/pdf/import-pdf"')
  || appSource.includes('import { exportAnnotatedPdf')
  || appSource.includes('import { createBlankPdfFile')
  || !appSource.includes('import("./lib/pdf/import-pdf")')
  || !appSource.includes('import("./lib/pdf/export-pdf")')
) {
  findings.push("src/App.tsx:1 heavy PDF runtime modules must remain conditionally loaded");
}
if (
  appSource.includes('from "./lib/export-pptx"')
  || !appSource.includes('import("./lib/export-pptx")')
) {
  findings.push("src/App.tsx:1 PPTX generation must remain conditionally loaded");
}
const pptxExportSource = await readFile(path.join(root, "src/lib/export-pptx.ts"), "utf8");
if (
  !pptxExportSource.includes("MAX_PPTX_RASTER_PIXELS_PER_DECK")
  || !pptxExportSource.includes("MAX_PPTX_PNG_BYTES_PER_SLIDE")
  || !pptxExportSource.includes("MAX_PPTX_PNG_BYTES_PER_DECK")
) {
  findings.push("src/lib/export-pptx.ts:1 PPTX raster and encoded-image safety limits are missing");
}
const safetySource = await readFile(path.join(root, "src/lib/safety.ts"), "utf8");
if (
  !safetySource.includes("embeddedImageDataUrl")
  || safetySource.includes('candidate.startsWith("blob:")')
  || !safetySource.includes("next.link = null")
) {
  findings.push("src/lib/safety.ts:1 imported links and non-embedded image sources must remain blocked");
}
const stylesSource = await readFile(path.join(root, "src/styles.css"), "utf8");
for (const selector of [
  "library-menu-browse-button",
  'data-testid="lib-dropdown--remove"',
  "library-menu-items__no-items::after",
]) {
  if (!stylesSource.includes(selector)) {
    findings.push(`src/styles.css:1 native library offline safeguard must remain installed: ${selector}`);
  }
}
const mermaidSource = await readFile(path.join(root, "src/lib/mermaid/safe-mermaid.ts"), "utf8");
for (const safeguard of ["MAX_SOURCE_LENGTH", "SUPPORTED_DIAGRAM", "securityLevel: \"strict\"", "raw.files", "ALLOWED_ELEMENT_TYPES"]) {
  if (!mermaidSource.includes(safeguard)) {
    findings.push(`src/lib/mermaid/safe-mermaid.ts:1 Mermaid safeguard is missing: ${safeguard}`);
  }
}
if (!viteSource.includes("/^@excalidraw\\/mermaid-to-excalidraw$/")) {
  findings.push("vite.config.ts:1 Excalidraw's built-in live Mermaid dialog must remain stubbed");
}
const archiveClientSource = await readFile(path.join(root, "src/lib/project-archive-client.ts"), "utf8");
if (
  !archiveClientSource.includes('new URL("./project-archive.worker.ts", import.meta.url)')
  || archiveClientSource.includes("http://")
  || archiveClientSource.includes("https://")
) {
  findings.push("src/lib/project-archive-client.ts:1 project archive worker must remain locally bundled");
}

if (findings.length) {
  console.error("Offline safety check failed:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log("Offline safety check passed: no remote executable or collaboration paths in app sources.");
