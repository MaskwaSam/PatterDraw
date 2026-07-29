#!/usr/bin/env node

import { readFile } from "node:fs/promises";
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
const viteSource = await readFile(path.join(root, "vite.config.ts"), "utf8");
if (!viteSource.includes("localMathJaxAssets") || !viteSource.includes('"mathjax/tex-svg.js"')) {
  findings.push("vite.config.ts:1 local MathJax asset packaging is missing");
}
if (viteSource.includes("input/tex/extensions")) {
  findings.push("vite.config.ts:1 optional MathJax TeX extensions must not be shipped");
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

if (findings.length) {
  console.error("Offline safety check failed:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log("Offline safety check passed: no remote executable or collaboration paths in app sources.");
