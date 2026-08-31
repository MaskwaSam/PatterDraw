import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

// Cache Storage is shared by every service-worker scope on an origin. The
// runtime appends its encoded registration scope before the content version so
// a nested PatterDraw install can never evict a neighbouring install's shell.
export const APP_SHELL_CACHE_PREFIX = "patterdraw-app-shell-v2:";
export const APP_SHELL_MAX_BYTES = 5 * 1024 * 1024;
// Include every worker-owned response/header and metadata contract in the
// content version. Bump this value whenever those policies change, even when
// the compiled application bytes do not, so an older canonical cache can
// never be mistaken for a policy-equivalent release.
export const APP_SHELL_CACHE_POLICY_VERSION = "patterdraw-cache-policy-v5";
// Keep the one-time feature-continuity preparation independently bounded just
// above the measured classroom build (44,089,747 unpacked bytes, 523 entries,
// 22,134,826 wire bytes). The combined verified cache has its own cap so the
// 5 MiB usable-start allowance cannot silently expand the full footprint.
export const CONTINUITY_CACHE_MAX_BYTES = 48 * 1024 * 1024;
export const CONTINUITY_CACHE_MAX_ENTRIES = 560;
export const CONTINUITY_PACK_MAX_BYTES = 24 * 1024 * 1024;
export const OFFLINE_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const ROUTING_STATE_RESERVED_BYTES = 32 * 1024;
export const APP_SHELL_PROTOCOL_HEADER = "X-PatterDraw-App-Shell";
export const APP_SHELL_PROTOCOL_VERSION = "patterdraw-app-shell-v1";
export const GEOGON_RELEASE_AUTHORITY = "386e47223740ed9955ae1fe8a022516fea98d57f";

const CONTINUITY_RUNTIME_PREFIXES = Object.freeze([
  "assets/",
  "excalidraw-assets/",
  "geogon/",
  "mathjax/",
  "mathjax-fonts/",
  "pdfjs/",
]);
const CONTINUITY_RUNTIME_EXTENSIONS = new Set([
  "css", "gif", "html", "jpeg", "jpg", "js", "json", "mjs", "mts",
  "pfb", "png", "svg", "ttf", "wasm", "webp", "woff", "woff2",
]);

function fail(message) {
  throw new Error(`offline-app-shell: ${message}`);
}

function sourceBytes(output) {
  if (output.type === "chunk") return Buffer.byteLength(output.code, "utf8");
  if (typeof output.source === "string") return Buffer.byteLength(output.source, "utf8");
  if (output.source instanceof Uint8Array) return output.source.byteLength;
  return Buffer.byteLength(String(output.source ?? ""), "utf8");
}

function sourceHash(output) {
  const source = output.type === "chunk" ? output.code : output.source ?? "";
  return createHash("sha256").update(source).digest("hex");
}

function finalizedSourceEntry(fileName, source) {
  return {
    bytes: source.byteLength,
    mime: expectedMime(fileName),
    path: `./${fileName}`,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

function manifestVersion(entries) {
  return createHash("sha256")
    .update(`${APP_SHELL_CACHE_POLICY_VERSION}\n`)
    .update(entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""))
    .digest("hex")
    .slice(0, 20);
}

function safeRelativeAssetPath(fileName) {
  return typeof fileName === "string"
    && fileName.length > 0
    && !fileName.startsWith("/")
    && !fileName.includes("\\")
    && !fileName.includes("?")
    && !fileName.includes("#")
    && !fileName.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isOptionalFeatureAsset(fileName) {
  const basename = fileName.split("/").at(-1) || "";
  // pdf.js exposes its worker URL through Vite metadata even though the worker
  // is only fetched when a PDF feature is opened. Keeping it out of the startup
  // shell avoids a 1.2+ MiB duplicate first-visit transfer for every student.
  return basename.startsWith("pdf.worker") && basename.endsWith(".mjs");
}

function isFeatureOnlyShellPath(fileName) {
  const normalized = fileName.toLowerCase();
  return isOptionalFeatureAsset(fileName)
    || normalized.startsWith("geogon/")
    || normalized.startsWith("mathjax/")
    || normalized.startsWith("mathjax-fonts/")
    || normalized.includes("mermaid");
}

function expectedMime(fileName) {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const mimeByExtension = {
    css: "text/css",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript",
    json: "application/json",
    mjs: "application/javascript",
    mts: "text/plain",
    pfb: "application/x-font-type1",
    png: "image/png",
    svg: "image/svg+xml",
    ttf: "font/ttf",
    wasm: "application/wasm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  const mime = mimeByExtension[extension];
  if (!mime) fail(`startup cache contains an unsupported file type: ${fileName}`);
  return mime;
}

function isContinuityRuntimePath(fileName) {
  const extension = fileName.split(".").at(-1)?.toLowerCase() || "";
  return CONTINUITY_RUNTIME_PREFIXES.some((prefix) => fileName.startsWith(prefix))
    && CONTINUITY_RUNTIME_EXTENSIONS.has(extension);
}

async function listRuntimeFiles(root, prefix) {
  const files = [];
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (error) {
    fail(`required continuity directory ${prefix} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listRuntimeFiles(root, `${relative}/`));
    else if (entry.isFile() && isContinuityRuntimePath(relative)) files.push(relative);
    else if (entry.isSymbolicLink()) fail(`continuity path must not be a symbolic link: ${relative}`);
  }
  return files;
}

/**
 * Find the finalized, local-only runtime closure needed by an already-open
 * lesson. All emitted application chunks are included because PDF, equation,
 * Mermaid, and worker chunk sharing is decided by Rollup. Fixed local runtime
 * trees cover Excalidraw fonts, MathJax, PDF standard fonts, and GeoGon.
 * Licences, release metadata, and ordinary HTML entry points are deliberately
 * excluded.
 */
export async function collectOfflineContinuityPathsFromFiles({
  outputDirectory,
  shellPaths = [],
}) {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    fail("a finalized output directory is required for continuity discovery");
  }
  const root = path.resolve(outputDirectory);
  const excluded = new Set(shellPaths);
  const paths = [];
  for (const prefix of CONTINUITY_RUNTIME_PREFIXES) {
    paths.push(...await listRuntimeFiles(root, prefix));
  }
  const unique = [...new Set(paths)].filter((fileName) => !excluded.has(fileName)).sort();
  if (unique.length !== paths.filter((fileName) => !excluded.has(fileName)).length) {
    fail("duplicate continuity path");
  }
  if (unique.length === 0) fail("the finalized build has no continuity resources");
  if (unique.length > CONTINUITY_CACHE_MAX_ENTRIES) {
    fail(`continuity closure contains ${unique.length} files (limit ${CONTINUITY_CACHE_MAX_ENTRIES})`);
  }
  return unique;
}

/**
 * Select only the code, CSS, and directly imported assets needed to restore
 * the initial editor. Heavy feature-only chunks stay outside this usable-start
 * budget; the finalized continuity pass packages them separately after load.
 */
export function collectOfflineAppShellPaths(bundle) {
  const selected = new Set(["index.html"]);
  const entryChunks = Object.values(bundle).filter((output) => (
    output.type === "chunk" && output.isEntry
  ));
  if (entryChunks.length === 0) fail("the build has no JavaScript entry chunk");

  const queue = [];
  for (const entry of entryChunks) {
    selected.add(entry.fileName);
    queue.push({ chunk: entry, includeDynamicImports: true });
  }

  const visited = new Set();
  while (queue.length > 0) {
    const next = queue.shift();
    const key = `${next.chunk.fileName}:${next.includeDynamicImports ? "dynamic" : "static"}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const metadata = next.chunk.viteMetadata;
    for (const fileName of metadata?.importedCss || []) selected.add(fileName);
    for (const fileName of metadata?.importedAssets || []) {
      if (!isOptionalFeatureAsset(fileName)) selected.add(fileName);
    }

    const dependencies = [
      ...next.chunk.imports,
      ...(next.includeDynamicImports ? next.chunk.dynamicImports : []),
    ];
    for (const fileName of dependencies) {
      const output = bundle[fileName];
      if (!output || output.type !== "chunk") {
        fail(`startup chunk ${next.chunk.fileName} references missing chunk ${fileName}`);
      }
      selected.add(fileName);
      // The entrypoint deliberately imports App asynchronously so bootstrap
      // failures can show a recovery shell. Follow that one startup boundary,
      // then only static imports so feature-only code stays lazy.
      queue.push({ chunk: output, includeDynamicImports: false });
    }
  }

  return [...selected].sort().map((fileName) => {
    if (!safeRelativeAssetPath(fileName)) fail(`unsafe cache path ${String(fileName)}`);
    const output = bundle[fileName];
    if (!output) fail(`the build is missing selected app-shell file ${fileName}`);
    return fileName;
  });
}

function createOfflineAppShellManifest(entries, continuityEntries = [], continuityPack = null) {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) fail("duplicate startup cache path");
  const unexpectedFeature = entries.find((entry) => isFeatureOnlyShellPath(entry.path.slice(2)));
  if (unexpectedFeature) {
    fail(`feature-only asset entered the startup cache: ${unexpectedFeature.path}`);
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  if (totalBytes > APP_SHELL_MAX_BYTES) {
    fail(`startup cache is ${totalBytes} bytes (limit ${APP_SHELL_MAX_BYTES})`);
  }
  const continuityPaths = continuityEntries.map((entry) => entry.path);
  if (new Set(continuityPaths).size !== continuityPaths.length) fail("duplicate continuity path");
  if (continuityPaths.some((continuityPath) => paths.includes(continuityPath))) {
    fail("startup and continuity manifests overlap");
  }
  const continuityBytes = continuityEntries.reduce((total, entry) => total + entry.bytes, 0);
  if (continuityBytes > CONTINUITY_CACHE_MAX_BYTES) {
    fail(`continuity closure is ${continuityBytes} bytes (limit ${CONTINUITY_CACHE_MAX_BYTES})`);
  }
  if (continuityEntries.length > CONTINUITY_CACHE_MAX_ENTRIES) {
    fail(`continuity closure contains ${continuityEntries.length} files (limit ${CONTINUITY_CACHE_MAX_ENTRIES})`);
  }
  if (totalBytes + continuityBytes + ROUTING_STATE_RESERVED_BYTES > OFFLINE_CACHE_MAX_BYTES) {
    fail(`verified offline cache plus routing-state reserve is ${totalBytes + continuityBytes + ROUTING_STATE_RESERVED_BYTES} bytes (limit ${OFFLINE_CACHE_MAX_BYTES})`);
  }
  if (continuityEntries.length > 0 && !continuityPack) fail("continuity resources require a pack");
  if (continuityEntries.length === 0 && continuityPack) fail("an empty continuity closure must not have a pack");
  const version = manifestVersion([...entries, ...continuityEntries]);
  return { continuityBytes, continuityEntries, continuityPack, entries, totalBytes, version };
}

export function collectOfflineAppShell(bundle) {
  const entries = collectOfflineAppShellPaths(bundle).map((fileName) => {
    const output = bundle[fileName];
    return {
      bytes: sourceBytes(output),
      mime: expectedMime(fileName),
      path: `./${fileName}`,
      sha256: sourceHash(output),
    };
  });
  return createOfflineAppShellManifest(entries);
}

async function finalizedEntries(root, paths) {
  return Promise.all(paths.map(async (fileName) => {
    if (!safeRelativeAssetPath(fileName)) fail(`unsafe finalized cache path ${String(fileName)}`);
    const absolute = path.resolve(root, ...fileName.split("/"));
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`finalized cache path escapes the output directory: ${fileName}`);
    }
    let source;
    try {
      source = await readFile(absolute);
    } catch (error) {
      fail(`unable to read finalized app-shell file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { entry: finalizedSourceEntry(fileName, source), source };
  }));
}

/**
 * Create the worker from the exact bytes already written to the output
 * directory. Rollup-compatible bundle objects are still used to choose the
 * startup closure, but are deliberately not trusted for integrity hashes:
 * later output hooks may finalize or rewrite emitted chunks before disk.
 */
export async function createOfflineServiceWorkerAssetFromFiles({
  continuityPaths = [],
  outputDirectory,
  paths,
}) {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    fail("a finalized output directory is required");
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    fail("at least one finalized app-shell path is required");
  }
  const root = path.resolve(outputDirectory);
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length !== paths.length) fail("duplicate finalized app-shell path");
  const uniqueContinuityPaths = [...new Set(continuityPaths)].sort();
  if (uniqueContinuityPaths.length !== continuityPaths.length) fail("duplicate finalized continuity path");
  if (uniqueContinuityPaths.some((fileName) => uniquePaths.includes(fileName))) {
    fail("startup and continuity paths overlap");
  }
  const [shellFiles, continuityFiles] = await Promise.all([
    finalizedEntries(root, uniquePaths),
    finalizedEntries(root, uniqueContinuityPaths),
  ]);
  const entries = shellFiles.map((file) => file.entry);
  let offset = 0;
  const continuityEntries = continuityFiles.map(({ entry }) => {
    const withOffset = { ...entry, offset };
    offset += entry.bytes;
    return withOffset;
  });
  let continuityPack = null;
  let continuityPackSource = null;
  if (continuityEntries.length > 0) {
    const uncompressed = Buffer.concat(continuityFiles.map((file) => file.source));
    if (uncompressed.byteLength !== offset) fail("continuity pack byte accounting failed");
    continuityPackSource = gzipSync(uncompressed, { level: 9 });
    if (continuityPackSource.byteLength > CONTINUITY_PACK_MAX_BYTES) {
      fail(`compressed continuity pack is ${continuityPackSource.byteLength} bytes (limit ${CONTINUITY_PACK_MAX_BYTES})`);
    }
    const sha256 = createHash("sha256").update(continuityPackSource).digest("hex");
    continuityPack = {
      bytes: continuityPackSource.byteLength,
      path: `./assets/patterdraw-continuity-${sha256.slice(0, 20)}.bin`,
      sha256,
      uncompressedBytes: uncompressed.byteLength,
    };
  }
  const manifest = createOfflineAppShellManifest(entries, continuityEntries, continuityPack);
  return {
    ...manifest,
    continuityPackSource,
    code: renderOfflineServiceWorker(manifest),
  };
}

export function renderOfflineServiceWorker({
  continuityEntries = [],
  continuityPack = null,
  entries,
  version,
}) {
  if (!/^[0-9a-f]{20}$/.test(version || "")) fail("invalid cache version");
  const paths = entries.map((entry) => entry.path);
  if (paths.length === 0 || paths[0] !== "./index.html") {
    // collectOfflineAppShell sorts index first because `i` sorts before `a`?
    // Do not rely on that incidental order; only require index membership.
    if (!paths.includes("./index.html")) fail("index.html is not cached");
  }
  for (const relativePath of paths) {
    if (!relativePath.startsWith("./") || !safeRelativeAssetPath(relativePath.slice(2))) {
      fail(`unsafe worker cache path ${String(relativePath)}`);
    }
  }
  if (new Set(paths).size !== paths.length) fail("duplicate worker cache path");

  let shellBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`invalid worker cache size for ${entry.path}`);
    }
    shellBytes += entry.bytes;
  }
  if (shellBytes > APP_SHELL_MAX_BYTES) {
    fail(`startup cache is ${shellBytes} bytes (limit ${APP_SHELL_MAX_BYTES})`);
  }

  const continuityPaths = continuityEntries.map((entry) => entry.path);
  for (const relativePath of continuityPaths) {
    if (!relativePath.startsWith("./") || !safeRelativeAssetPath(relativePath.slice(2))) {
      fail(`unsafe worker continuity path ${String(relativePath)}`);
    }
  }
  if (new Set(continuityPaths).size !== continuityPaths.length) fail("duplicate worker continuity path");
  if (continuityPaths.some((continuityPath) => paths.includes(continuityPath))) {
    fail("startup and continuity worker manifests overlap");
  }

  const precacheEntries = entries.map((entry) => {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
      fail(`invalid worker cache hash for ${entry.path}`);
    }
    if (entry.mime !== expectedMime(entry.path.slice(2))) {
      fail(`invalid worker cache MIME for ${entry.path}`);
    }
    return { bytes: entry.bytes, mime: entry.mime, path: entry.path, sha256: entry.sha256 };
  });

  let expectedOffset = 0;
  const continuityPrecacheEntries = continuityEntries.map((entry) => {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 || "")) {
      fail(`invalid worker continuity hash for ${entry.path}`);
    }
    if (entry.mime !== expectedMime(entry.path.slice(2))) {
      fail(`invalid worker continuity MIME for ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.offset) || entry.offset !== expectedOffset) {
      fail(`invalid worker continuity offset for ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`invalid worker continuity size for ${entry.path}`);
    }
    expectedOffset += entry.bytes;
    return { bytes: entry.bytes, mime: entry.mime, offset: entry.offset, path: entry.path, sha256: entry.sha256 };
  });
  if (continuityPrecacheEntries.length > CONTINUITY_CACHE_MAX_ENTRIES) {
    fail(`continuity closure contains ${continuityPrecacheEntries.length} files (limit ${CONTINUITY_CACHE_MAX_ENTRIES})`);
  }
  if (expectedOffset > CONTINUITY_CACHE_MAX_BYTES) {
    fail(`continuity closure is ${expectedOffset} bytes (limit ${CONTINUITY_CACHE_MAX_BYTES})`);
  }
  if (shellBytes + expectedOffset + ROUTING_STATE_RESERVED_BYTES > OFFLINE_CACHE_MAX_BYTES) {
    fail(`verified offline cache plus routing-state reserve is ${shellBytes + expectedOffset + ROUTING_STATE_RESERVED_BYTES} bytes (limit ${OFFLINE_CACHE_MAX_BYTES})`);
  }
  if (continuityPrecacheEntries.length > 0) {
    if (
      !continuityPack
      || !continuityPack.path?.startsWith("./assets/patterdraw-continuity-")
      || !/^[0-9a-f]{64}$/.test(continuityPack.sha256 || "")
      || !Number.isSafeInteger(continuityPack.bytes)
      || continuityPack.bytes <= 0
      || continuityPack.bytes > CONTINUITY_PACK_MAX_BYTES
      || !Number.isSafeInteger(continuityPack.uncompressedBytes)
      || continuityPack.uncompressedBytes !== expectedOffset
      || continuityPack.uncompressedBytes > CONTINUITY_CACHE_MAX_BYTES
    ) fail("invalid worker continuity pack");
  } else if (continuityPack) {
    fail("an empty worker continuity manifest must not have a pack");
  }

  return `"use strict";
const CACHE_NAMESPACE_PREFIX = ${JSON.stringify(APP_SHELL_CACHE_PREFIX)};
const SCOPE_CACHE_PREFIX = CACHE_NAMESPACE_PREFIX + encodeURIComponent(self.registration.scope) + ":";
const CACHE_NAME = SCOPE_CACHE_PREFIX + ${JSON.stringify(version)};
const INSTALL_CACHE_NAME = CACHE_NAME + ":installing";
const ROUTING_STATE_URL = new URL("./.__patterdraw_offline_routing_state__", self.registration.scope).href;
const ROUTING_STATE_SCHEMA = 2;
const ROUTING_STATE_MAX_BYTES = ${ROUTING_STATE_RESERVED_BYTES};
const ROUTING_STATE_MAX_CLIENTS = 64;
const ROUTING_STATE_PENDING_MAX_AGE_MS = 2 * 60 * 1000;
const ASSET_AUTHORITY_PARAMETER = "patterdraw-asset-sha256";
const GEOGON_AUTHORITY_PARAMETER = "patterdraw-geogon";
const GEOGON_RELEASE_AUTHORITY = ${JSON.stringify(GEOGON_RELEASE_AUTHORITY)};
const SHELL_PROTOCOL_HEADER = ${JSON.stringify(APP_SHELL_PROTOCOL_HEADER)};
const SHELL_PROTOCOL_VERSION = ${JSON.stringify(APP_SHELL_PROTOCOL_VERSION)};
const PRECACHE = ${JSON.stringify(precacheEntries)};
const PRECACHE_TOTAL_BYTES = ${shellBytes};
const CONTINUITY = ${JSON.stringify(continuityPrecacheEntries)};
const CONTINUITY_TOTAL_BYTES = ${expectedOffset};
const CONTINUITY_PACK = ${JSON.stringify(continuityPack)};
const PRECACHE_PATHS = PRECACHE.map((entry) => entry.path);
const CONTINUITY_PATHS = CONTINUITY.map((entry) => entry.path);
const CACHED_PATHS = [...PRECACHE_PATHS, ...CONTINUITY_PATHS];

function scopedUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

const PRECACHE_URLS = new Set(CACHED_PATHS.map(scopedUrl));
const PRECACHE_BY_URL = new Map([...PRECACHE, ...CONTINUITY].map((entry) => [scopedUrl(entry.path), entry]));
const INDEX_URL = scopedUrl("./index.html");
const GEOGON_ENTRY_URL = scopedUrl("./geogon/index.html");
const MATHJAX_SPEECH_WORKER_URL = scopedUrl("./mathjax/sre/speech-worker.js");
const SCOPE_URL = new URL(self.registration.scope);
let routingStateQueue = Promise.resolve();

function contentTypeMatches(expected, actual) {
  const normalized = String(actual || "").split(";", 1)[0].trim().toLowerCase();
  if (expected === "application/javascript") {
    return normalized === expected || normalized === "text/javascript";
  }
  return normalized === expected;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readExactResponseBytes(response, expectedBytes, label) {
  const declaredLength = response.headers.get("Content-Length");
  // A Content-Length accompanying Content-Encoding describes transport bytes,
  // while Fetch exposes the decoded body. Validate only comparable lengths.
  if (
    !response.headers.has("Content-Encoding")
    && declaredLength !== null
    && (!/^\\d+$/.test(declaredLength) || Number(declaredLength) !== expectedBytes)
  ) throw new Error(label + " has an invalid declared size.");
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(label + " cannot be read with bounded streaming.");
  }
  const reader = response.body.getReader();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array) || offset + value.byteLength > output.byteLength) {
      void reader.cancel().catch(() => undefined);
      throw new Error(label + " exceeded its size limit.");
    }
    output.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== output.byteLength) {
    throw new Error(label + " has an invalid size.");
  }
  return output.buffer;
}

async function readBoundedResponseBytes(response, maximumBytes, label) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(label + " cannot be read with bounded streaming.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array) || totalBytes + value.byteLength > maximumBytes) {
      void reader.cancel().catch(() => undefined);
      throw new Error(label + " exceeded its size limit.");
    }
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function normalRoutingState() {
  return {
    mode: "normal",
    passThroughClients: [],
    pendingClients: [],
    protectedClients: [],
  };
}

function isValidClientId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function normalizeRoutingState(value) {
  if (
    !value
    || typeof value !== "object"
    || value.schema !== ROUTING_STATE_SCHEMA
    || value.cacheName !== CACHE_NAME
    || value.scope !== self.registration.scope
    || !["normal", "retired", "reintroducing"].includes(value.mode)
    || !Array.isArray(value.passThroughClients)
    || !Array.isArray(value.pendingClients)
    || !Array.isArray(value.protectedClients)
  ) return null;
  const passThroughClients = [...new Set(value.passThroughClients)];
  const protectedClients = [...new Set(value.protectedClients)];
  const pendingClients = value.pendingClients.map((pending) => (
    pending && typeof pending === "object"
      ? {
          clientId: pending.clientId,
          createdAt: pending.createdAt,
          routing: pending.routing,
        }
      : null
  ));
  const pendingIds = pendingClients.map((pending) => pending?.clientId);
  if (
    passThroughClients.length + protectedClients.length + pendingClients.length
      > ROUTING_STATE_MAX_CLIENTS
    || passThroughClients.some((clientId) => !isValidClientId(clientId))
    || protectedClients.some((clientId) => !isValidClientId(clientId))
    || passThroughClients.some((clientId) => protectedClients.includes(clientId))
    || pendingClients.some((pending) => (
      !pending
      || !isValidClientId(pending.clientId)
      || !Number.isSafeInteger(pending.createdAt)
      || pending.createdAt < 0
      || (pending.routing !== "protected" && pending.routing !== "pass-through")
    ))
    || new Set(pendingIds).size !== pendingIds.length
    || pendingIds.some((clientId) => (
      passThroughClients.includes(clientId) || protectedClients.includes(clientId)
    ))
    || (
      value.mode === "normal"
      && (
        passThroughClients.length > 0
        || pendingClients.length > 0
        || protectedClients.length > 0
      )
    )
  ) return null;
  return { mode: value.mode, passThroughClients, pendingClients, protectedClients };
}

async function readRoutingStateDirect() {
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(ROUTING_STATE_URL);
  if (!response) {
    // Every successfully installed release owns this record. Its absence is
    // ambiguous (eviction, tampering, or a partial legacy cache), so default
    // to network-only retirement rather than resurrecting cached HTML.
    return {
      mode: "retired",
      passThroughClients: [],
      pendingClients: [],
      protectedClients: [],
    };
  }
  try {
    if (!contentTypeMatches("application/json", response.headers.get("Content-Type"))) {
      throw new Error("Unexpected PatterDraw routing-state MIME.");
    }
    const bytes = await readBoundedResponseBytes(
      response,
      ROUTING_STATE_MAX_BYTES,
      "PatterDraw routing state",
    );
    const state = normalizeRoutingState(JSON.parse(new TextDecoder().decode(bytes)));
    if (state) return state;
  } catch {
    // A malformed state must fail closed. Unknown clients use the network and
    // navigation never resurrects the cached release while server intent is
    // uncertain; a later successful marked response can recover coherently.
  }
  return {
    mode: "retired",
    passThroughClients: [],
    pendingClients: [],
    protectedClients: [],
  };
}

function routingStateResponse(state) {
  const normalized = normalizeRoutingState({
    ...state,
    cacheName: CACHE_NAME,
    schema: ROUTING_STATE_SCHEMA,
    scope: self.registration.scope,
  });
  if (!normalized) throw new Error("PatterDraw routing state is invalid.");
  const body = JSON.stringify({
    cacheName: CACHE_NAME,
    mode: normalized.mode,
    passThroughClients: normalized.passThroughClients,
    pendingClients: normalized.pendingClients,
    protectedClients: normalized.protectedClients,
    schema: ROUTING_STATE_SCHEMA,
    scope: self.registration.scope,
  });
  if (new TextEncoder().encode(body).byteLength > ROUTING_STATE_MAX_BYTES) {
    throw new Error("PatterDraw routing state exceeded its size limit.");
  }
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
    status: 200,
  });
}

async function writeRoutingStateDirect(state) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(ROUTING_STATE_URL, routingStateResponse(state));
}

async function initializeRoutingState(cache) {
  await cache.put(ROUTING_STATE_URL, routingStateResponse(normalRoutingState()));
}

function enqueueRoutingStateMutation(mutate) {
  const operation = routingStateQueue.then(async () => {
    const state = await readRoutingStateDirect();
    return mutate(state);
  });
  routingStateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readRoutingState() {
  await routingStateQueue;
  return readRoutingStateDirect();
}

function clientRouting(state, clientId) {
  if (state.mode === "normal") return "protected";
  if (!isValidClientId(clientId)) return "pass-through";
  if (state.protectedClients.includes(clientId)) return "protected";
  return state.pendingClients.find((pending) => pending.clientId === clientId)?.routing
    || "pass-through";
}

async function controlledClientIds() {
  if (typeof self.clients.matchAll !== "function") return [];
  const clients = await self.clients.matchAll({ includeUncontrolled: false, type: "all" });
  return clients.map((client) => client.id).filter(isValidClientId);
}

function addClient(set, clientId) {
  if (isValidClientId(clientId)) set.add(clientId);
}

function reconcileClientSets(state, liveClients) {
  const protectedClients = new Set(
    state.mode === "normal"
      ? liveClients
      : state.protectedClients.filter((id) => liveClients.has(id)),
  );
  const passThroughClients = new Set(
    state.mode === "normal"
      ? []
      : state.passThroughClients.filter((id) => liveClients.has(id)),
  );
  const pendingClients = [];
  if (state.mode !== "normal") {
    const now = Date.now();
    for (const pending of state.pendingClients) {
      if (liveClients.has(pending.clientId)) {
        if (pending.routing === "protected") protectedClients.add(pending.clientId);
        else passThroughClients.add(pending.clientId);
      } else if (
        pending.createdAt >= now - ROUTING_STATE_PENDING_MAX_AGE_MS
        && pending.createdAt <= now + ROUTING_STATE_PENDING_MAX_AGE_MS
      ) {
        // A resulting client normally materializes just after its response is
        // returned. Keep the reservation across concurrent fetch events and
        // worker restarts; a short expiry bounds creations that never finish.
        pendingClients.push(pending);
      }
    }
    // A client that appeared while the worker was asleep or before its parent
    // classification was persisted is ambiguous. Keep it network-only until a
    // successful marked navigation explicitly protects its new lineage.
    for (const clientId of liveClients) {
      if (
        !protectedClients.has(clientId)
        && !passThroughClients.has(clientId)
        && !pendingClients.some((pending) => pending.clientId === clientId)
      ) passThroughClients.add(clientId);
    }
  }
  return { passThroughClients, pendingClients, protectedClients };
}

function classifyResultClient(
  { passThroughClients, pendingClients, protectedClients },
  clientId,
  routing,
  liveClients,
) {
  protectedClients.delete(clientId);
  passThroughClients.delete(clientId);
  const previous = pendingClients.findIndex((pending) => pending.clientId === clientId);
  if (previous >= 0) pendingClients.splice(previous, 1);
  if (liveClients.has(clientId)) {
    if (routing === "protected") protectedClients.add(clientId);
    else passThroughClients.add(clientId);
  } else {
    pendingClients.push({ clientId, createdAt: Date.now(), routing });
  }
}

function routingClientCount({ passThroughClients, pendingClients, protectedClients }) {
  return passThroughClients.size + pendingClients.length + protectedClients.size;
}

function hasPassThroughLineage({ passThroughClients, pendingClients }) {
  return passThroughClients.size > 0
    || pendingClients.some((pending) => pending.routing === "pass-through");
}

async function transitionToRetired(event) {
  return enqueueRoutingStateMutation(async (state) => {
    const liveClients = new Set(await controlledClientIds());
    addClient(liveClients, event.clientId);
    const routing = reconcileClientSets(
      state,
      liveClients,
    );
    if (!isValidClientId(event.resultingClientId)) {
      // In NORMAL, keep the all-A invariant and return cached A without
      // changing state. During a transition, an unidentified result cannot be
      // classified safely, so fail the navigation instead of mixing it.
      return state.mode === "normal" ? "cached-a" : "fail";
    }
    classifyResultClient(
      routing,
      event.resultingClientId,
      "pass-through",
      liveClients,
    );
    if (routingClientCount(routing) > ROUTING_STATE_MAX_CLIENTS) {
      return state.mode === "normal" ? "cached-a" : "fail";
    }
    await writeRoutingStateDirect({
      mode: "retired",
      passThroughClients: [...routing.passThroughClients],
      pendingClients: routing.pendingClients,
      protectedClients: [...routing.protectedClients],
    });
    return "network-rollback";
  });
}

async function transitionToReintroducing(event) {
  return enqueueRoutingStateMutation(async (state) => {
    if (state.mode === "normal") return;
    const liveClients = new Set(await controlledClientIds());
    addClient(liveClients, event.clientId);
    const routing = reconcileClientSets(
      state,
      liveClients,
    );
    if (!isValidClientId(event.resultingClientId)) {
      throw new Error("Unable to identify the reintroduced PatterDraw client.");
    }
    classifyResultClient(
      routing,
      event.resultingClientId,
      "protected",
      liveClients,
    );
    if (routingClientCount(routing) > ROUTING_STATE_MAX_CLIENTS) {
      throw new Error("PatterDraw routing state exceeded its client limit.");
    }
    await writeRoutingStateDirect(!hasPassThroughLineage(routing)
      ? normalRoutingState()
      : {
          mode: "reintroducing",
          passThroughClients: [...routing.passThroughClients],
          pendingClients: routing.pendingClients,
          protectedClients: [...routing.protectedClients],
        });
  });
}

async function inheritClientRouting(event, state) {
  if (state.mode === "normal") return;
  await enqueueRoutingStateMutation(async (latest) => {
    if (latest.mode === "normal") return;
    const sourceRouting = clientRouting(latest, event.clientId);
    const liveClients = new Set(await controlledClientIds());
    addClient(liveClients, event.clientId);
    const routing = reconcileClientSets(
      latest,
      liveClients,
    );
    if (isValidClientId(event.resultingClientId)) {
      classifyResultClient(
        routing,
        event.resultingClientId,
        sourceRouting,
        liveClients,
      );
    }
    if (routingClientCount(routing) > ROUTING_STATE_MAX_CLIENTS) {
      throw new Error("PatterDraw routing state exceeded its client limit.");
    }
    await writeRoutingStateDirect(
      latest.mode === "reintroducing" && !hasPassThroughLineage(routing)
        ? normalRoutingState()
        : {
            mode: latest.mode,
            passThroughClients: [...routing.passThroughClients],
            pendingClients: routing.pendingClients,
            protectedClients: [...routing.protectedClients],
          },
    );
  });
}

function hasVerifiedAssetAuthority(url, expected) {
  const values = url.searchParams.getAll(ASSET_AUTHORITY_PARAMETER);
  return values.length === 1 && values[0] === expected.sha256;
}

async function authorizeBlobWorkerClient(clientId) {
  if (!isValidClientId(clientId) || typeof self.clients.get !== "function") return false;
  const client = await self.clients.get(clientId);
  if (!client || client.type !== "worker") return false;
  let clientUrl;
  try {
    clientUrl = new URL(client.url);
  } catch {
    return false;
  }
  if (clientUrl.protocol !== "blob:" || clientUrl.origin !== SCOPE_URL.origin) return false;
  await enqueueRoutingStateMutation(async (latest) => {
    if (latest.mode === "normal") return;
    const liveClients = new Set(await controlledClientIds());
    addClient(liveClients, clientId);
    const routing = reconcileClientSets(latest, liveClients);
    classifyResultClient(routing, clientId, "protected", liveClients);
    if (routingClientCount(routing) > ROUTING_STATE_MAX_CLIENTS) {
      throw new Error("PatterDraw routing state exceeded its client limit.");
    }
    await writeRoutingStateDirect(
      latest.mode === "reintroducing" && !hasPassThroughLineage(routing)
        ? normalRoutingState()
        : {
            mode: latest.mode,
            passThroughClients: [...routing.passThroughClients],
            pendingClients: routing.pendingClients,
            protectedClients: [...routing.protectedClients],
          },
    );
  });
  return true;
}

function hasVerifiedGeoGonAuthority(url) {
  const authority = url.searchParams.getAll(GEOGON_AUTHORITY_PARAMETER);
  const host = url.searchParams.getAll("host");
  return authority.length === 1
    && authority[0] === GEOGON_RELEASE_AUTHORITY
    && host.length === 1
    && host[0] === "patterdraw"
    && [...url.searchParams.keys()].length === 2;
}

async function authorizeGeoGonFrameClient(event) {
  if (
    event.request.mode !== "navigate"
    || event.request.destination !== "iframe"
    || !isValidClientId(event.resultingClientId)
  ) return false;
  await enqueueRoutingStateMutation(async (latest) => {
    if (latest.mode === "normal") return;
    const liveClients = new Set(await controlledClientIds());
    addClient(liveClients, event.clientId);
    const routing = reconcileClientSets(latest, liveClients);
    classifyResultClient(routing, event.resultingClientId, "protected", liveClients);
    if (routingClientCount(routing) > ROUTING_STATE_MAX_CLIENTS) {
      throw new Error("PatterDraw routing state exceeded its client limit.");
    }
    await writeRoutingStateDirect(
      latest.mode === "reintroducing" && !hasPassThroughLineage(routing)
        ? normalRoutingState()
        : {
            mode: latest.mode,
            passThroughClients: [...routing.passThroughClients],
            pendingClients: routing.pendingClients,
            protectedClients: [...routing.protectedClients],
          },
    );
  });
  return true;
}

async function verifiedShellResponse(request, expected) {
  const response = await fetch(request);
  if (
    !response.ok
    || response.type === "opaque"
    || response.redirected
    || response.url !== request.url
    || !contentTypeMatches(expected.mime, response.headers.get("Content-Type"))
  ) {
    throw new Error("Unable to verify required PatterDraw app-shell resource.");
  }
  const bytes = await readExactResponseBytes(
    response,
    expected.bytes,
    "PatterDraw app-shell resource",
  );
  if (await sha256Hex(bytes) !== expected.sha256) {
    throw new Error("PatterDraw app-shell resource failed its integrity check.");
  }
  const headers = new Headers(response.headers);
  // Fetch exposes a decoded body. Do not retain transport framing/encoding on
  // the reconstructed verified response or a cache hit could be decoded twice.
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("Transfer-Encoding");
  return new Response(bytes, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function cachedShellResponseMatches(cache, requestUrl, expected) {
  // cache.match() is deliberately issued for the exact canonical URL. Do not
  // accept a response found through ignoreSearch or another relaxed match.
  const response = await cache.match(requestUrl);
  if (
    !response
    || !response.ok
    || response.type === "opaque"
    || response.redirected
    || !contentTypeMatches(expected.mime, response.headers.get("Content-Type"))
    || response.headers.has("Content-Encoding")
    || response.headers.has("Content-Length")
    || response.headers.has("Transfer-Encoding")
  ) return false;
  try {
    return await sha256Hex(await readExactResponseBytes(
      response,
      expected.bytes,
      "Cached PatterDraw app-shell resource",
    )) === expected.sha256;
  } catch {
    return false;
  }
}

async function cacheContainsVerifiedPrecache(cache) {
  for (const relativePath of CACHED_PATHS) {
    const requestUrl = scopedUrl(relativePath);
    if (!await cachedShellResponseMatches(cache, requestUrl, PRECACHE_BY_URL.get(requestUrl))) {
      return false;
    }
  }
  return true;
}

async function repairCanonicalCache(candidateCache, canonicalCache) {
  // The candidate is complete before canonical writes start. Overwrite exact
  // manifest entries in place so an active worker never loses its cache name;
  // a failed put can leave only already-verified improvements behind.
  for (const relativePath of CACHED_PATHS) {
    const requestUrl = scopedUrl(relativePath);
    const expected = PRECACHE_BY_URL.get(requestUrl);
    if (!await cachedShellResponseMatches(candidateCache, requestUrl, expected)) {
      throw new Error("Unable to verify staged PatterDraw app-shell resource.");
    }
    const response = await candidateCache.match(requestUrl);
    await canonicalCache.put(requestUrl, response);
  }
  if (!await cacheContainsVerifiedPrecache(canonicalCache)) {
    throw new Error("Unable to repair the canonical PatterDraw app-shell cache.");
  }
}

function continuityResponseHeaders(entry) {
  const headers = new Headers({
    "Cache-Control": entry.path === "./geogon/index.html"
      ? "no-store, no-transform"
      : entry.path.startsWith("./assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    "Content-Type": entry.mime,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (entry.path.startsWith("./geogon/")) {
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'self'; object-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Permissions-Policy", "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()");
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }
  return headers;
}

async function populateContinuityCache(cache) {
  if (CONTINUITY.length === 0) return;
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot prepare PatterDraw's release-continuity cache.");
  }
  const packUrl = scopedUrl(CONTINUITY_PACK.path);
  // The compressed pack is staging input only. Do not leave a second 20+ MiB
  // copy in the browser HTTP cache after its unpacked entries reach
  // CacheStorage; each release verifies its one network transfer directly.
  const request = new Request(packUrl, { cache: "no-store", credentials: "same-origin" });
  const response = await fetch(request);
  if (
    !response.ok
    || response.type === "opaque"
    || response.redirected
    || response.url !== request.url
    || !contentTypeMatches("application/octet-stream", response.headers.get("Content-Type"))
  ) throw new Error("Unable to verify PatterDraw's release-continuity pack.");
  const compressed = await readExactResponseBytes(
    response,
    CONTINUITY_PACK.bytes,
    "PatterDraw's release-continuity pack",
  );
  if (
    compressed.byteLength !== CONTINUITY_PACK.bytes
    || await sha256Hex(compressed) !== CONTINUITY_PACK.sha256
  ) throw new Error("PatterDraw's release-continuity pack failed its integrity check.");
  const decompressed = await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
  if (
    decompressed.byteLength !== CONTINUITY_PACK.uncompressedBytes
    || decompressed.byteLength !== CONTINUITY_TOTAL_BYTES
  ) throw new Error("PatterDraw's release-continuity pack has an invalid size.");
  for (const entry of CONTINUITY) {
    const end = entry.offset + entry.bytes;
    if (end > decompressed.byteLength) {
      throw new Error("PatterDraw's release-continuity entry is out of bounds.");
    }
    const bytes = decompressed.slice(entry.offset, end);
    if (await sha256Hex(bytes) !== entry.sha256) {
      throw new Error("A PatterDraw release-continuity resource failed its integrity check.");
    }
    await cache.put(scopedUrl(entry.path), new Response(bytes, {
      headers: continuityResponseHeaders(entry),
      status: 200,
    }));
  }
}

async function removeObsoleteCanonicalEntries(canonicalCache) {
  for (const request of await canonicalCache.keys()) {
    if (!PRECACHE_URLS.has(request.url) && request.url !== ROUTING_STATE_URL) {
      await canonicalCache.delete(request);
    }
  }
}

function isSameScopeHtmlResponse(response) {
  if (response.type === "opaque") return false;
  if (!contentTypeMatches("text/html", response.headers.get("Content-Type"))) return false;
  try {
    const responseUrl = new URL(response.url);
    return responseUrl.origin === SCOPE_URL.origin
      && responseUrl.pathname.startsWith(SCOPE_URL.pathname);
  } catch {
    return false;
  }
}

function isSuccessfulMarkedAppResponse(request, response) {
  if (response.status < 200 || response.status >= 400) return false;
  if (response.redirected || response.type === "opaque") return false;
  if (response.headers.get(SHELL_PROTOCOL_HEADER) !== SHELL_PROTOCOL_VERSION) return false;
  if (!contentTypeMatches("text/html", response.headers.get("Content-Type"))) return false;
  try {
    const requestUrl = new URL(request.url);
    const responseUrl = new URL(response.url);
    // Fetch response URLs do not retain the request fragment. Ignore only that
    // client-side navigation state while keeping the origin, path, and query
    // under exact URL equality.
    requestUrl.hash = "";
    responseUrl.hash = "";
    return responseUrl.origin === requestUrl.origin && responseUrl.href === requestUrl.href;
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // The service-worker install algorithm keeps the previously installed
    // waiting worker in this slot until this install succeeds. Refuse to
    // replace it: its complete cache is the only safe successor to the active
    // classroom release if this newer install crashes, fails integrity, or
    // runs out of quota. This check must remain before every cache or network
    // operation so repeated deployments while an old lesson stays open are
    // hard-bounded to one active and one waiting release.
    if (self.registration.waiting) {
      throw new Error("A verified PatterDraw update is already waiting for open lessons to close.");
    }
    // A worker-only update can legitimately have the same startup manifest as
    // the active worker, and therefore the same CACHE_NAME. Never write into
    // or delete that known-good cache while the replacement is still
    // installing. Verify the candidate into a disposable sibling cache; once
    // every byte succeeds, validate the canonical cache before reuse and
    // repair it in place from the verified candidate when incomplete.
    const cacheAlreadyExists = (await caches.keys()).includes(CACHE_NAME);
    const canonicalCache = cacheAlreadyExists ? await caches.open(CACHE_NAME) : null;
    const canonicalCacheWasValid = canonicalCache
      ? await cacheContainsVerifiedPrecache(canonicalCache)
      : false;
    const candidateCacheName = cacheAlreadyExists ? INSTALL_CACHE_NAME : CACHE_NAME;
    if (cacheAlreadyExists) await caches.delete(INSTALL_CACHE_NAME);
    const cache = await caches.open(candidateCacheName);
    try {
      for (const relativePath of PRECACHE_PATHS) {
        const requestUrl = scopedUrl(relativePath);
        const request = new Request(requestUrl, {
          // Only index is mutable. Vite's content-addressed assets are safe to
          // reuse from the browser HTTP cache after their embedded SHA check.
          cache: relativePath === "./index.html" ? "reload" : "force-cache",
          credentials: "same-origin",
        });
        const expected = PRECACHE_BY_URL.get(requestUrl);
        let response;
        try {
          response = await verifiedShellResponse(request, expected);
        } catch (error) {
          if (relativePath === "./index.html") throw error;
          // A stale/corrupt HTTP-cache entry must not make Retry fail forever.
          // Re-fetch once, but apply the same URL/MIME/SHA checks before trust.
          response = await verifiedShellResponse(new Request(requestUrl, {
            cache: "reload",
            credentials: "same-origin",
          }), expected);
        }
        await cache.put(request, response);
      }
      await populateContinuityCache(cache);
      // Reserve and verify the release-local mutable routing record as part of
      // the atomic candidate. Same-version repair deliberately copies only
      // immutable manifest entries so an incumbent rollback state survives.
      await initializeRoutingState(cache);
      if (canonicalCache) {
        if (!canonicalCacheWasValid) await repairCanonicalCache(cache, canonicalCache);
        await removeObsoleteCanonicalEntries(canonicalCache);
        await caches.delete(INSTALL_CACHE_NAME);
      }
    } catch (error) {
      await caches.delete(candidateCacheName);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => (
      name.startsWith(SCOPE_CACHE_PREFIX) && name !== CACHE_NAME
        ? caches.delete(name)
        : Promise.resolve(false)
    )));
    // The first fully verified worker may safely control the page that
    // registered it. Claiming does not reload or remount the lesson; it closes
    // the vulnerable uncontrolled-client window before the next deployment.
    await self.clients.claim();
  })());
});

function isAppNavigation(url) {
  // Direct entry-point navigations may carry classroom/deep-link state in the
  // query or fragment. Match those against the immutable cached entry point
  // before applying the extension guard used for ordinary static assets.
  const canonicalUrl = new URL(url.href);
  canonicalUrl.search = "";
  canonicalUrl.hash = "";
  if (canonicalUrl.href === INDEX_URL) return true;
  if (!url.pathname.startsWith(SCOPE_URL.pathname)) return false;
  const relativePath = url.pathname.slice(SCOPE_URL.pathname.length);
  const finalSegment = relativePath.split("/").filter(Boolean).at(-1) || "";
  return !finalSegment.includes(".") && !relativePath.startsWith("geogon/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && isAppNavigation(url)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.status === 0 || response.status >= 500) {
          const state = await readRoutingState();
          if (state.mode === "normal") {
            const cached = await (await caches.open(CACHE_NAME)).match(INDEX_URL);
            if (cached) return cached;
          }
          // A same-scope HTML error still creates an A-controlled document.
          // Transitional states default unknown clients to network-only, but
          // persist the resulting lineage explicitly before returning it so a
          // later worker restart cannot reinterpret that document.
          if (isSameScopeHtmlResponse(response)) {
            const transition = await transitionToRetired(event);
            if (transition === "network-rollback") return response;
            throw new Error("Unable to classify the server-error document safely.");
          }
          return response;
        }
        if (isSuccessfulMarkedAppResponse(request, response)) {
          // A marked response can belong to a newer static release. Never let
          // B's HTML execute under A's controller/cache: that mixed client can
          // keep B waiting while asking A for B-only lazy URLs. Pin every
          // controlled marked navigation to this worker's verified index;
          // registration from that page still discovers and installs B, which
          // activates naturally after all A clients close.
          await transitionToReintroducing(event);
          const cached = await (await caches.open(CACHE_NAME)).match(INDEX_URL);
          if (cached) return cached;
          throw new Error("The verified PatterDraw entry point is unavailable.");
        }
        if (isSameScopeHtmlResponse(response)) {
          // A rollback, login/error document, or followed redirect that ends
          // inside this worker's scope intentionally lacks the exact marked
          // app-response contract. Keep the registration so a future marked
          // release is an ordinary waiting update, but durably route this
          // result and its descendants network-only before exposing its HTML.
          const transition = await transitionToRetired(event);
          if (transition === "network-rollback") return response;
          if (transition === "cached-a") {
            const cached = await (await caches.open(CACHE_NAME)).match(INDEX_URL);
            if (cached) return cached;
          }
          throw new Error("Unable to classify the same-scope document safely.");
        }
        return response;
      } catch (networkError) {
        const state = await readRoutingState();
        if (state.mode === "normal") {
          const cached = await (await caches.open(CACHE_NAME)).match(INDEX_URL);
          if (cached) return cached;
        }
        throw networkError;
      }
    })());
    return;
  }

  const canonicalUrl = new URL(url.href);
  canonicalUrl.search = "";
  canonicalUrl.hash = "";
  if (!PRECACHE_URLS.has(canonicalUrl.href)) return;
  event.respondWith((async () => {
    const state = await readRoutingState();
    await inheritClientRouting(event, state);
    const expected = PRECACHE_BY_URL.get(canonicalUrl.href);
    const hasGeoGonAuthority = canonicalUrl.href === GEOGON_ENTRY_URL
      && hasVerifiedGeoGonAuthority(url);
    const authorizedGeoGonFrame = hasGeoGonAuthority
      && await authorizeGeoGonFrameClient(event);
    const hasAssetAuthority = canonicalUrl.href === MATHJAX_SPEECH_WORKER_URL
      && expected
      && hasVerifiedAssetAuthority(url, expected);
    const authorizedBlobWorker = hasAssetAuthority
      && await authorizeBlobWorkerClient(event.clientId);
    if (
      clientRouting(state, event.clientId) !== "protected"
      && !authorizedBlobWorker
      && !authorizedGeoGonFrame
    ) {
      return fetch(request);
    }
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(canonicalUrl.href);
    return cached || fetch(request);
  })());
});
`;
}

export function createOfflineServiceWorkerAsset(bundle) {
  const manifest = collectOfflineAppShell(bundle);
  return {
    ...manifest,
    continuityPackSource: null,
    code: renderOfflineServiceWorker(manifest),
  };
}
