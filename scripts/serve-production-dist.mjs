import { createReadStream } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptRoot, "..");
const routePrefix = "/classroom/math/unit-01/patterdraw/";
const staticAssetPrefixes = [
  "assets/",
  "excalidraw-assets/",
  "geogon/",
  "licenses/",
  "mathjax/",
  "mathjax-fonts/",
  "pdfjs/",
];

function parseArguments(argv) {
  const options = { dist: "dist", host: "127.0.0.1", port: "4174" };
  const allowed = new Map([
    ["--dist", "dist"],
    ["--host", "host"],
    ["--port", "port"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = allowed.get(flag);
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    options[key] = value;
    seen.add(flag);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const distRoot = path.resolve(repoRoot, options.dist);
const host = options.host;
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`--port must be an integer between 1024 and 65535 (received ${port}).`);
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".pfb": "application/x-font-type1",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

// Keep the header policy as strict as the offline student build permits. The
// same baseline is present in index.html as a file-open fallback, while these
// response headers also protect nested Moodle-style routes and static assets.
// `frame-ancestors` is intentionally header-only: browsers ignore that
// directive when it is delivered from a meta tag.
const contentSecurityPolicy = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob: data:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// GeoGon is a reviewed, pinned local subapplication. Its HTML needs an inline
// import map, but it cannot connect to a network endpoint or frame another
// origin. Only this path may be embedded by the PatterDraw parent.
const geoGonContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "worker-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

function setSecurityHeaders(response, allowLocalGeoGonFrame = false) {
  response.setHeader(
    "Content-Security-Policy",
    allowLocalGeoGonFrame ? geoGonContentSecurityPolicy : contentSecurityPolicy,
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.setHeader("X-Frame-Options", allowLocalGeoGonFrame ? "SAMEORIGIN" : "DENY");
}

function decodeRequestPath(rawUrl) {
  const rawPath = String(rawUrl || "/").split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Malformed percent escapes must never become a production fallback route.
    return null;
  }
  if (
    !decoded
    || decoded.includes("\0")
    || decoded.split(/[\\/]/).some((part) => part === "..")
  ) return null;
  return decoded;
}

function safeDistPath(relativePath) {
  if (
    !relativePath
    || relativePath.includes("\0")
    || relativePath.split(/[\\/]/).some((part) => part === "..")
  ) return null;
  const candidate = path.resolve(distRoot, relativePath);
  return candidate === distRoot || candidate.startsWith(`${distRoot}${path.sep}`)
    ? candidate
    : null;
}

function isInsideDist(candidate) {
  return candidate === realDistRoot || candidate.startsWith(`${realDistRoot}${path.sep}`);
}

function isAssetPath(relativePath) {
  return path.extname(relativePath) !== ""
    || staticAssetPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function sendNotFound(response, requestMethod) {
  setSecurityHeaders(response);
  response.statusCode = 404;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(requestMethod === "HEAD" ? undefined : "Not found");
}

function sendMethodNotAllowed(response, requestMethod) {
  setSecurityHeaders(response);
  response.statusCode = 405;
  response.setHeader("Allow", "GET, HEAD");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(requestMethod === "HEAD" ? undefined : "Method not allowed");
}

async function serveFile(response, filePath, requestMethod) {
  let resolvedFilePath;
  try {
    resolvedFilePath = await realpath(filePath);
  } catch {
    return false;
  }
  if (!isInsideDist(resolvedFilePath)) {
    // A lexically safe path can still escape through a symlink in dist/.
    // Treat that as a missing resource and never stream bytes from outside the
    // build root.
    return null;
  }
  let fileStats;
  try {
    fileStats = await stat(resolvedFilePath);
  } catch {
    return false;
  }
  if (!fileStats.isFile()) return false;
  const relativePath = path.relative(realDistRoot, resolvedFilePath).split(path.sep).join("/");
  const isLocalGeoGonFile = relativePath.startsWith("geogon/");
  response.statusCode = 200;
  setSecurityHeaders(response, isLocalGeoGonFile);
  response.setHeader("Content-Type", contentTypes[path.extname(resolvedFilePath).toLowerCase()] || "application/octet-stream");
  response.setHeader("Content-Length", String(fileStats.size));
  response.setHeader("X-PatterDraw-Production-Dist", "1");
  const isHashedBuildAsset = relativePath.startsWith("assets/")
    && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path.basename(relativePath));
  response.setHeader(
    "Cache-Control",
    path.basename(resolvedFilePath) === "index.html"
      ? "no-store"
      : isHashedBuildAsset
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
  );
  if (requestMethod === "HEAD") {
    response.end();
  } else {
    createReadStream(resolvedFilePath).on("error", () => response.destroy()).pipe(response);
  }
  return true;
}

const indexPath = path.join(distRoot, "index.html");
await access(indexPath);
const distStats = await lstat(distRoot);
if (!distStats.isDirectory() || distStats.isSymbolicLink()) {
  throw new Error("dist must be a real directory, not a symlink.");
}
const realDistRoot = await realpath(distRoot);
// Parent aliases such as macOS `/var` -> `/private/var` are safe: the root
// itself was lstat'd above and every served file is contained against this
// canonical path. Rejecting any textual realpath difference made isolated
// production fixtures unusable without improving the symlink boundary.
const realIndexPath = await realpath(indexPath);
if (!isInsideDist(realIndexPath)) {
  throw new Error("dist/index.html resolves outside the production build root.");
}
const indexBytes = await readFile(realIndexPath);
const indexText = indexBytes.toString("utf8");
if (!indexText.includes("PatterDraw") || indexText.includes("/src/main.tsx")) {
  throw new Error("dist/index.html does not look like a production PatterDraw build.");
}

const server = http.createServer(async (request, response) => {
  try {
    setSecurityHeaders(response);
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendMethodNotAllowed(response, request.method);
      return;
    }
    // Inspect the raw URL before WHATWG URL parsing can normalize dot
    // segments. This keeps encoded traversal and malformed escapes on the
    // same fail-closed 404 path as ordinary missing assets.
    const pathname = decodeRequestPath(request.url);
    if (!pathname) {
      sendNotFound(response, request.method);
      return;
    }
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const routeWithoutTrailingSlash = routePrefix.slice(0, -1);
    if (pathname === routeWithoutTrailingSlash) {
      response.statusCode = 308;
      response.setHeader("Location", `${routePrefix}${requestUrl.search}`);
      response.end();
      return;
    }

    const nestedRequest = pathname === routePrefix || pathname.startsWith(routePrefix);
    const rootRequest = pathname === "/" || isAssetPath(pathname.slice(1));
    if (!nestedRequest && !rootRequest) {
      sendNotFound(response, request.method);
      return;
    }

    const relativePath = nestedRequest
      ? pathname.slice(routePrefix.length)
      : pathname.slice(1);
    const requestedFile = safeDistPath(relativePath);
    if (requestedFile) {
      const served = await serveFile(response, requestedFile, request.method);
      if (served === true || served === null) {
        if (served === null) sendNotFound(response, request.method);
        return;
      }
    }

    if (pathname === "/") {
      const served = await serveFile(response, realIndexPath, request.method);
      if (served !== true) sendNotFound(response, request.method);
      return;
    }

    // Never turn a missing JavaScript, worker, font, or other static asset
    // into HTML: that masks broken production paths and can fail much later
    // as an opaque module or worker parse error.
    if (isAssetPath(relativePath)) {
      sendNotFound(response, request.method);
      return;
    }

    // Vite's relative base makes asset URLs resolve below either the root or
    // a realistic Moodle-style nested subdirectory. Unknown application paths
    // under that subdirectory still receive the built entry point.
    if (nestedRequest) {
      const served = await serveFile(response, realIndexPath, request.method);
      if (served !== true) sendNotFound(response, request.method);
      return;
    }
    sendNotFound(response, request.method);
  } catch (error) {
    console.error(
      `Production request failed: ${request.method || "?"} ${request.url || "/"} (${error?.code || error?.message || error})`,
    );
    setSecurityHeaders(response);
    response.statusCode = error?.code === "ENOENT" ? 404 : 500;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(response.statusCode === 404 ? "Not found" : "Production server error");
  }
});

server.once("error", (error) => {
  console.error(`Unable to serve production dist: ${error?.code || error?.message || error}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Serving production dist at http://${host}:${port}${routePrefix}`);
});

function closeServer() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);
