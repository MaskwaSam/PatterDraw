import { createReadStream } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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
  const options = {
    dist: "dist",
    host: "127.0.0.1",
    port: "4174",
    testGzipAssets: false,
    testNavigationFaults: false,
    testPerformanceProfile: false,
  };
  const allowed = new Map([
    ["--dist", "dist"],
    ["--host", "host"],
    ["--port", "port"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--test-navigation-faults") {
      if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      options.testNavigationFaults = true;
      seen.add(flag);
      continue;
    }
    if (flag === "--test-gzip-assets") {
      if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      options.testGzipAssets = true;
      seen.add(flag);
      continue;
    }
    if (flag === "--test-performance-profile") {
      if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      options.testPerformanceProfile = true;
      seen.add(flag);
      continue;
    }
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
if (options.testGzipAssets && options.testPerformanceProfile) {
  throw new Error("--test-gzip-assets and --test-performance-profile cannot be combined.");
}
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

// Test-only packaged performance profile. Enforcing it at the HTTP server
// makes the latency, bandwidth, and byte accounting apply to document, module,
// and service-worker-global requests alike; a page-scoped CDP session cannot
// reliably observe or throttle the worker's install fetches.
const testPerformanceProfile = Object.freeze({
  downloadBytesPerSecond: (10 * 1024 * 1024) / 8,
  latencyMs: 40,
});
const testPerformanceEndpointPrefix = `${routePrefix}__patterdraw_test/performance/`;
const testPerformanceCookie = "patterdraw_performance_session";
const testPerformanceSessions = new Map();
const testPerformanceTokenPattern = /^[a-f0-9]{32}$/;

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

function acceptsGzip(rawHeader) {
  const header = Array.isArray(rawHeader) ? rawHeader.join(",") : String(rawHeader || "");
  let explicitGzip;
  let wildcard = false;
  for (const entry of header.split(",")) {
    const [rawName, ...parameters] = entry.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const qualityParameter = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
    const quality = qualityParameter
      ? Number(qualityParameter.trim().slice(2))
      : 1;
    const accepted = Number.isFinite(quality) && quality > 0;
    if (name === "gzip") explicitGzip = accepted;
    if (name === "*" && accepted) wildcard = true;
  }
  return explicitGzip ?? wildcard;
}

function isTestCompressible(relativePath) {
  return new Set([".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt"])
    .has(path.extname(relativePath).toLowerCase());
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

function cookieValue(request, name) {
  for (const cookie of String(request.headers.cookie || "").split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    return cookie.slice(separator + 1).trim();
  }
  return null;
}

function createTestPerformanceSession(token) {
  return {
    bodyBytes: 0,
    completedResponseCount: 0,
    nextTransferAt: 0,
    requestCount: 0,
    requests: new Map(),
    startedAt: Date.now(),
    token,
  };
}

function activeTestPerformanceSession(request) {
  if (!options.testPerformanceProfile) return null;
  const token = cookieValue(request, testPerformanceCookie);
  if (!testPerformanceTokenPattern.test(token || "")) return null;
  return testPerformanceSessions.get(token) || null;
}

function recordTestPerformanceRequest(session, relativePath) {
  session.requestCount += 1;
  const metrics = session.requests.get(relativePath) || {
    bodyBytes: 0,
    completedResponseCount: 0,
    requestCount: 0,
  };
  metrics.requestCount += 1;
  session.requests.set(relativePath, metrics);
  return metrics;
}

function testPerformanceSnapshot(session) {
  return {
    bodyBytes: session.bodyBytes,
    completedResponseCount: session.completedResponseCount,
    profile: testPerformanceProfile,
    requestCount: session.requestCount,
    requests: [...session.requests.entries()]
      .map(([relativePath, metrics]) => ({ relativePath, ...metrics }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    startedAt: session.startedAt,
  };
}

function sendTestPerformanceJson(response, requestMethod, statusCode, payload, cookie = null) {
  setSecurityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cookie) response.setHeader("Set-Cookie", cookie);
  response.end(requestMethod === "HEAD" ? undefined : `${JSON.stringify(payload)}\n`);
}

function handleTestPerformanceEndpoint(request, response, pathname, requestUrl) {
  if (!options.testPerformanceProfile || !pathname.startsWith(testPerformanceEndpointPrefix)) {
    return false;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendMethodNotAllowed(response, request.method);
    return true;
  }
  const action = pathname.slice(testPerformanceEndpointPrefix.length);
  const token = requestUrl.searchParams.get("token") || "";
  if (!testPerformanceTokenPattern.test(token)) {
    sendTestPerformanceJson(response, request.method, 400, {
      error: "Invalid performance-session token.",
    });
    return true;
  }
  if (action === "start") {
    testPerformanceSessions.set(token, createTestPerformanceSession(token));
    sendTestPerformanceJson(
      response,
      request.method,
      200,
      { profile: testPerformanceProfile, started: true },
      `${testPerformanceCookie}=${token}; HttpOnly; Path=${routePrefix}; SameSite=Strict`,
    );
    return true;
  }
  const session = testPerformanceSessions.get(token);
  if (!session) {
    sendTestPerformanceJson(response, request.method, 404, {
      error: "Performance session not found.",
    });
    return true;
  }
  if (action === "metrics") {
    sendTestPerformanceJson(response, request.method, 200, testPerformanceSnapshot(session));
    return true;
  }
  if (action === "stop") {
    const snapshot = testPerformanceSnapshot(session);
    testPerformanceSessions.delete(token);
    sendTestPerformanceJson(
      response,
      request.method,
      200,
      snapshot,
      `${testPerformanceCookie}=; HttpOnly; Max-Age=0; Path=${routePrefix}; SameSite=Strict`,
    );
    return true;
  }
  sendTestPerformanceJson(response, request.method, 404, {
    error: "Unknown performance endpoint.",
  });
  return true;
}

function streamTestPerformanceFile(response, filePath, session, relativePath) {
  const requestMetrics = recordTestPerformanceRequest(session, relativePath);
  const stream = createReadStream(filePath, { highWaterMark: 32 * 1024 });
  let timer = null;
  let responseCompleted = false;
  let sourceEnded = false;
  let pendingChunk = false;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!stream.destroyed) stream.destroy();
  };
  const finishIfReady = () => {
    if (!sourceEnded || pendingChunk || responseCompleted || response.destroyed) return;
    responseCompleted = true;
    session.completedResponseCount += 1;
    requestMetrics.completedResponseCount += 1;
    response.end();
  };

  response.once("close", () => {
    if (!responseCompleted) stop();
  });
  stream.once("error", () => response.destroy());
  stream.once("end", () => {
    sourceEnded = true;
    finishIfReady();
  });

  timer = setTimeout(() => {
    timer = null;
    stream.on("data", (chunk) => {
      stream.pause();
      pendingChunk = true;
      const now = Date.now();
      const transferStartsAt = Math.max(now, session.nextTransferAt);
      const transferFinishesAt = transferStartsAt
        + (chunk.length / testPerformanceProfile.downloadBytesPerSecond) * 1_000;
      session.nextTransferAt = transferFinishesAt;
      timer = setTimeout(() => {
        timer = null;
        if (response.destroyed) {
          stop();
          return;
        }
        response.write(chunk, () => {
          if (response.destroyed) {
            stop();
            return;
          }
          session.bodyBytes += chunk.length;
          requestMetrics.bodyBytes += chunk.length;
          pendingChunk = false;
          stream.resume();
          finishIfReady();
        });
      }, Math.max(0, Math.ceil(transferFinishesAt - now)));
    });
  }, testPerformanceProfile.latencyMs);
}

function sendSimulatedRollbackHtml(response, requestMethod) {
  const body = Buffer.from(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>PatterDraw rollback fixture</title></head><body>Previous PatterDraw release</body></html>\n",
    "utf8",
  );
  setSecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(requestMethod === "HEAD" ? undefined : body);
}

async function serveFile(
  response,
  filePath,
  requestMethod,
  {
    acceptEncoding = "",
    performanceSession = null,
    suppressAppShellMarker = false,
  } = {},
) {
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
  if (path.basename(resolvedFilePath) === "index.html" && !suppressAppShellMarker) {
    response.setHeader("X-PatterDraw-App-Shell", "patterdraw-app-shell-v1");
  }
  const isHashedBuildAsset = relativePath.startsWith("assets/")
    && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path.basename(relativePath));
  const isServiceWorker = path.basename(resolvedFilePath) === "service-worker.js";
  response.setHeader(
    "Cache-Control",
    path.basename(resolvedFilePath) === "index.html"
      ? "no-store"
      : isServiceWorker
        ? "no-store, no-transform"
        : isHashedBuildAsset
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
  );
  const isTestGzipEligible = options.testGzipAssets
    && !isServiceWorker
    && isTestCompressible(relativePath);
  if (isTestGzipEligible) response.setHeader("Vary", "Accept-Encoding");
  const useTestGzip = isTestGzipEligible && acceptsGzip(acceptEncoding);
  if (useTestGzip) {
    const sourceBytes = await readFile(resolvedFilePath);
    const compressedBytes = gzipSync(sourceBytes, { level: 9 });
    response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Content-Length", String(compressedBytes.byteLength));
    // Test-only provenance lets the browser lifecycle prove that the worker
    // cached the decoded representation rather than compressed wire bytes.
    response.setHeader("X-PatterDraw-Test-Uncompressed-Length", String(sourceBytes.byteLength));
    response.end(requestMethod === "HEAD" ? undefined : compressedBytes);
    return true;
  }
  if (requestMethod === "HEAD") {
    response.end();
  } else if (performanceSession) {
    streamTestPerformanceFile(response, resolvedFilePath, performanceSession, relativePath);
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

let simulatedRollbackActive = false;
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
    if (handleTestPerformanceEndpoint(request, response, pathname, requestUrl)) return;
    const performanceSession = activeTestPerformanceSession(request);
    if (options.testNavigationFaults) {
      if (requestUrl.searchParams.get("__patterdraw_test_reintroduce") === "1") {
        simulatedRollbackActive = false;
      } else if (requestUrl.searchParams.get("__patterdraw_test_rollback") === "1") {
        simulatedRollbackActive = true;
      }
    }
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
    if (simulatedRollbackActive && relativePath === "service-worker.js") {
      sendNotFound(response, request.method);
      return;
    }
    if (
      options.testNavigationFaults
      && requestUrl.searchParams.get("__patterdraw_test_navigation_abort") === "1"
      && !isAssetPath(relativePath)
    ) {
      // Deterministically exercise the worker's thrown-network-error branch,
      // including after the rollback fixture has retired cached routing.
      // Keeping this before rollback HTML avoids browser-specific offline
      // emulation while proving both normal fallback and fail-closed routing.
      response.destroy();
      return;
    }
    if (simulatedRollbackActive && !isAssetPath(relativePath)) {
      // A true rollback serves the previous, pre-service-worker application,
      // not the candidate JavaScript that would immediately register again.
      // Keep this fixture intentionally inert so retirement can be observed
      // without a race against a second candidate registration.
      sendSimulatedRollbackHtml(response, request.method);
      return;
    }
    const simulatedStatus = options.testNavigationFaults
      ? Number(requestUrl.searchParams.get("__patterdraw_test_navigation_status"))
      : 0;
    if (
      (simulatedStatus === 502 || simulatedStatus === 503)
      && !isAssetPath(relativePath)
    ) {
      setSecurityHeaders(response);
      response.statusCode = simulatedStatus;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : `Simulated ${simulatedStatus}`);
      return;
    }
    const suppressAppShellMarker = simulatedRollbackActive;
    const requestedFile = safeDistPath(relativePath);
    if (requestedFile) {
      const served = await serveFile(response, requestedFile, request.method, {
        acceptEncoding: request.headers["accept-encoding"],
        performanceSession,
        suppressAppShellMarker,
      });
      if (served === true || served === null) {
        if (served === null) sendNotFound(response, request.method);
        return;
      }
    }

    if (pathname === "/") {
      const served = await serveFile(response, realIndexPath, request.method, {
        acceptEncoding: request.headers["accept-encoding"],
        performanceSession,
        suppressAppShellMarker,
      });
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
      const served = await serveFile(response, realIndexPath, request.method, {
        acceptEncoding: request.headers["accept-encoding"],
        performanceSession,
        suppressAppShellMarker,
      });
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
