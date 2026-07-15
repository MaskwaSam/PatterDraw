#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const scanRoots = [path.join(root, "src"), path.join(root, "index.html")];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".html"]);
const rules = [
  [/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//gi, "remote script source"],
  [/<link\b[^>]*\bhref\s*=\s*["']https?:\/\//gi, "remote stylesheet or preload"],
  [/\bfetch\s*\(\s*["'`]https?:\/\//g, "remote fetch"],
  [/\bimport\s*\(\s*["'`]https?:\/\//g, "remote dynamic import"],
  [/\bnew\s+(?:WebSocket|EventSource)\s*\(/g, "live network channel"],
  [/\bsendBeacon\s*\(/g, "telemetry beacon"],
  [/\b(?:gtag|plausible|posthog|mixpanel|amplitude)\s*\(/gi, "analytics call"],
  [/<iframe\b/gi, "iframe markup"],
  [/LiveCollaborationTrigger/g, "collaboration UI"],
  [/onCollabButtonClick/g, "collaboration callback"],
  [/libraryReturnUrl\s*=/g, "remote library return URL"],
];

async function filesUnder(candidate) {
  const stat = await import("node:fs/promises").then(({ stat }) => stat(candidate));
  if (stat.isFile()) return [candidate];
  const files = [];
  for (const entry of await readdir(candidate, { withFileTypes: true })) {
    const child = path.join(candidate, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(child);
  }
  return files;
}

const findings = [];
for (const scanRoot of scanRoots) {
  for (const file of await filesUnder(scanRoot)) {
    const source = await readFile(file, "utf8");
    for (const [pattern, label] of rules) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        findings.push(`${path.relative(root, file)}:${line} ${label}`);
      }
    }
  }
}

const mainSource = await readFile(path.join(root, "src/main.tsx"), "utf8");
if (!mainSource.includes("installOfflineNetworkGuard()")) {
  findings.push("src/main.tsx:1 runtime network guard is not installed");
}
if (!mainSource.includes("installLocalExcalidrawAssets()")) {
  findings.push("src/main.tsx:1 local Excalidraw asset path is not installed");
}
const indexSource = await readFile(path.join(root, "index.html"), "utf8");
if (!indexSource.includes("connect-src 'self'") || !indexSource.includes("frame-src 'none'") || !indexSource.includes("worker-src 'self' blob:")) {
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
