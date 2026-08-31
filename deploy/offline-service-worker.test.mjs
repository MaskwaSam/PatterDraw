import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import {
  APP_SHELL_CACHE_POLICY_VERSION,
  APP_SHELL_CACHE_PREFIX,
  APP_SHELL_MAX_BYTES,
  APP_SHELL_PROTOCOL_HEADER,
  APP_SHELL_PROTOCOL_VERSION,
  CONTINUITY_CACHE_MAX_BYTES,
  CONTINUITY_CACHE_MAX_ENTRIES,
  CONTINUITY_PACK_MAX_BYTES,
  GEOGON_RELEASE_AUTHORITY,
  OFFLINE_CACHE_MAX_BYTES,
  ROUTING_STATE_RESERVED_BYTES,
  collectOfflineAppShell,
  collectOfflineAppShellPaths,
  collectOfflineContinuityPathsFromFiles,
  createOfflineServiceWorkerAsset,
  createOfflineServiceWorkerAssetFromFiles,
  renderOfflineServiceWorker,
} from "../build/offline-service-worker.mjs";

function chunk(fileName, options = {}) {
  return {
    code: options.code || `export const value = ${JSON.stringify(fileName)};`,
    dynamicImports: options.dynamicImports || [],
    fileName,
    imports: options.imports || [],
    isEntry: options.isEntry || false,
    type: "chunk",
    viteMetadata: {
      importedAssets: new Set(options.importedAssets || []),
      importedCss: new Set(options.importedCss || []),
    },
  };
}

function asset(fileName, source = fileName) {
  return { fileName, source, type: "asset" };
}

function fixtureBundle() {
  return {
    "index.html": asset("index.html", "<script src='./assets/main-12345678.js'></script>"),
    "assets/main-12345678.js": chunk("assets/main-12345678.js", {
      dynamicImports: ["assets/App-12345678.js"],
      imports: ["assets/runtime-12345678.js"],
      isEntry: true,
    }),
    "assets/runtime-12345678.js": chunk("assets/runtime-12345678.js"),
    "assets/App-12345678.js": chunk("assets/App-12345678.js", {
      dynamicImports: ["assets/pdf-export-12345678.js"],
      importedAssets: [
        "assets/pdf.worker.min-12345678.mjs",
        "assets/teacher-12345678.woff2",
      ],
      importedCss: ["assets/App-12345678.css"],
      imports: ["assets/editor-12345678.js"],
    }),
    "assets/editor-12345678.js": chunk("assets/editor-12345678.js"),
    "assets/pdf-export-12345678.js": chunk("assets/pdf-export-12345678.js"),
    "assets/pdf.worker.min-12345678.mjs": chunk("assets/pdf.worker.min-12345678.mjs"),
    "assets/App-12345678.css": asset("assets/App-12345678.css", ".app{}"),
    "assets/teacher-12345678.woff2": asset("assets/teacher-12345678.woff2", new Uint8Array([1, 2, 3])),
  };
}

function manifestEntry(path, body, mime) {
  return {
    bytes: Buffer.byteLength(body),
    mime,
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function serviceWorkerRuntime(code, {
  clients = [],
  fetch: fetchImplementation,
  failPutAt,
  failPutWhen,
  scope = "https://classroom.test/tools/patterdraw/",
  stores: sharedStores,
  waiting = null,
} = {}) {
  const listeners = new Map();
  const stores = sharedStores || new Map();
  let claimCalls = 0;
  let openCalls = 0;
  let putCalls = 0;
  let unregisterCalls = 0;
  const caches = {
    async delete(name) {
      return stores.delete(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async open(name) {
      openCalls += 1;
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async delete(request) {
          const key = typeof request === "string" ? request : request.url;
          return store.delete(key);
        },
        async keys() {
          return [...store.keys()].map((url) => new Request(url));
        },
        async match(request) {
          const key = typeof request === "string" ? request : request.url;
          return store.get(key)?.clone?.() || store.get(key);
        },
        async put(request, response) {
          const key = typeof request === "string" ? request : request.url;
          putCalls += 1;
          if (putCalls === failPutAt) throw new DOMException("Quota exceeded", "QuotaExceededError");
          if (failPutWhen?.({ key, putCalls })) {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
          store.set(key, response.clone?.() || response);
        },
      };
    },
  };
  const self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    location: { origin: new URL(scope).origin },
    clients: {
      async claim() {
        claimCalls += 1;
      },
      async get(clientId) {
        return clients.find((client) => client.id === clientId);
      },
      async matchAll() {
        return clients;
      },
    },
    registration: {
      scope,
      waiting,
      async unregister() {
        unregisterCalls += 1;
        return true;
      },
    },
  };
  vm.runInNewContext(code, {
    Array,
    Blob,
    DecompressionStream,
    Headers,
    Map,
    Promise,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    caches,
    claimCalls: () => claimCalls,
    crypto: webcrypto,
    encodeURIComponent,
    fetch: fetchImplementation,
    self,
  });
  return {
    caches,
    claimCalls: () => claimCalls,
    openCalls: () => openCalls,
    async dispatchLifecycle(type) {
      let completion;
      listeners.get(type)({ waitUntil(promise) { completion = promise; } });
      await completion;
    },
    async dispatchAsset(url, {
      clientId = "",
      resultingClientId = "",
    } = {}) {
      let response;
      listeners.get("fetch")({
        clientId,
        request: { method: "GET", mode: "same-origin", url },
        resultingClientId,
        respondWith(promise) { response = promise; },
      });
      return response;
    },
    async dispatchNavigation(url, {
      clientId = "",
      destination = "document",
      resultingClientId = "navigation-result",
    } = {}) {
      let response;
      listeners.get("fetch")({
        clientId,
        request: { destination, method: "GET", mode: "navigate", url },
        resultingClientId,
        respondWith(promise) { response = promise; },
      });
      return response;
    },
    registration: self.registration,
    putCalls: () => putCalls,
    stores,
    unregisterCalls: () => unregisterCalls,
  };
}

function navigationResponse(body, {
  contentType = "text/html",
  marker,
  redirected = false,
  status = 200,
  url,
} = {}) {
  const headers = new Headers({ "Content-Type": contentType });
  if (marker !== undefined) headers.set(APP_SHELL_PROTOCOL_HEADER, marker);
  const response = new Response(body, { headers, status });
  Object.defineProperties(response, {
    redirected: { configurable: true, value: redirected },
    url: { configurable: true, value: url },
  });
  return response;
}

function installResponse(request, bodies, overrides = {}) {
  const body = bodies.get(request.url);
  if (!body) throw new Error(`Unexpected install URL ${request.url}`);
  const bytes = Buffer.from(body.body);
  return {
    arrayBuffer: async () => bytes,
    body: new Blob([bytes]).stream(),
    headers: new Headers({
      "Content-Length": String(bytes.byteLength),
      "Content-Type": overrides.contentType || body.mime,
    }),
    ok: true,
    redirected: Boolean(overrides.redirected),
    status: 200,
    statusText: "OK",
    type: "basic",
    url: overrides.url || request.url,
  };
}

test("selects the startup closure but leaves feature-only dynamic chunks lazy", () => {
  const manifest = collectOfflineAppShell(fixtureBundle());
  const paths = manifest.entries.map((entry) => entry.path);
  assert(paths.includes("./index.html"));
  assert(paths.includes("./assets/main-12345678.js"));
  assert(paths.includes("./assets/App-12345678.js"));
  assert(paths.includes("./assets/editor-12345678.js"));
  assert(paths.includes("./assets/App-12345678.css"));
  assert(paths.includes("./assets/teacher-12345678.woff2"));
  assert(!paths.includes("./assets/pdf-export-12345678.js"));
  assert(!paths.includes("./assets/pdf.worker.min-12345678.mjs"));
  assert(!paths.some((entry) => /(?:geogon|mathjax|mermaid)/i.test(entry)));
  assert(manifest.totalBytes <= APP_SHELL_MAX_BYTES);
  assert(manifest.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  assert(manifest.entries.every((entry) => typeof entry.mime === "string"));
  assert.match(manifest.version, /^[0-9a-f]{20}$/);
});

test("changes the cache version when startup bytes change", () => {
  const first = collectOfflineAppShell(fixtureBundle());
  const changed = fixtureBundle();
  changed["assets/editor-12345678.js"].code += "\nexport const changed = true;";
  const second = collectOfflineAppShell(changed);
  assert.notEqual(first.version, second.version);
});

test("binds cache identity to the worker-owned response and metadata policy", () => {
  const manifest = collectOfflineAppShell(fixtureBundle());
  const entries = manifest.entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("");
  const expected = createHash("sha256")
    .update(`${APP_SHELL_CACHE_POLICY_VERSION}\n`)
    .update(entries)
    .digest("hex")
    .slice(0, 20);
  assert.equal(manifest.version, expected);
  assert.match(APP_SHELL_CACHE_POLICY_VERSION, /^patterdraw-cache-policy-v\d+$/);
});

test("hashes finalized output bytes instead of an earlier bundle snapshot", async () => {
  const bundle = fixtureBundle();
  const snapshot = collectOfflineAppShell(bundle);
  const paths = collectOfflineAppShellPaths(bundle);
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "patterdraw-offline-shell-"));
  const changedPath = "assets/editor-12345678.js";
  const finalizedBody = "export const value = 'finalized after generateBundle';\n";
  try {
    for (const fileName of paths) {
      const output = bundle[fileName];
      const source = fileName === changedPath
        ? finalizedBody
        : output.type === "chunk" ? output.code : output.source;
      const target = path.join(outputDirectory, ...fileName.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }

    const generated = await createOfflineServiceWorkerAssetFromFiles({
      outputDirectory,
      paths,
    });
    const finalEntry = generated.entries.find((entry) => entry.path === `./${changedPath}`);
    const snapshotEntry = snapshot.entries.find((entry) => entry.path === `./${changedPath}`);
    const finalHash = createHash("sha256").update(finalizedBody).digest("hex");
    assert.equal(finalEntry.sha256, finalHash);
    assert.notEqual(finalEntry.sha256, snapshotEntry.sha256);
    assert(generated.code.includes(finalHash));
    assert.notEqual(generated.version, snapshot.version);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("packs the finalized classroom-feature closure once with per-resource integrity", async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "patterdraw-continuity-"));
  const shellPaths = ["index.html", "assets/main-12345678.js"];
  const runtimeFiles = new Map([
    ["index.html", "<!doctype html><title>PatterDraw</title>"],
    ["assets/main-12345678.js", "import('./pdf-12345678.js');"],
    ["assets/pdf-12345678.js", "export const pdf = true;"],
    ["assets/pdf.worker.min-12345678.mjs", "export const worker = true;"],
    ["excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2", new Uint8Array([5, 6, 7])],
    ["geogon/index.html", "<!doctype html><meta http-equiv='Content-Security-Policy' content=\"connect-src 'none'\">"],
    ["geogon/app.js", "globalThis.geogon = true;"],
    ["geogon/LICENSE", "not a runtime resource"],
    ["mathjax/tex-svg.js", "globalThis.MathJax = {};"],
    ["mathjax-fonts/mathjax-newcm-font/svg.js", "globalThis.MathJaxFont = {};"],
    ["pdfjs/standard_fonts/FoxitSans.pfb", new Uint8Array([1, 2, 3, 4])],
  ]);
  try {
    for (const prefix of ["assets", "excalidraw-assets/fonts/Virgil", "geogon", "mathjax", "mathjax-fonts", "pdfjs/standard_fonts"]) {
      await mkdir(path.join(outputDirectory, prefix), { recursive: true });
    }
    for (const [fileName, source] of runtimeFiles) {
      const target = path.join(outputDirectory, fileName);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }

    const continuityPaths = await collectOfflineContinuityPathsFromFiles({
      outputDirectory,
      shellPaths,
    });
    assert.deepEqual(continuityPaths, [
      "assets/pdf-12345678.js",
      "assets/pdf.worker.min-12345678.mjs",
      "excalidraw-assets/fonts/Virgil/Virgil-Regular.woff2",
      "geogon/app.js",
      "geogon/index.html",
      "mathjax-fonts/mathjax-newcm-font/svg.js",
      "mathjax/tex-svg.js",
      "pdfjs/standard_fonts/FoxitSans.pfb",
    ]);
    assert(!continuityPaths.includes("geogon/LICENSE"));
    const generated = await createOfflineServiceWorkerAssetFromFiles({
      continuityPaths,
      outputDirectory,
      paths: shellPaths,
    });
    const repeated = await createOfflineServiceWorkerAssetFromFiles({
      continuityPaths,
      outputDirectory,
      paths: shellPaths,
    });
    assert(generated.continuityPack);
    assert(generated.continuityPackSource);
    assert.equal(generated.continuityEntries.length, continuityPaths.length);
    assert(generated.continuityEntries.length <= CONTINUITY_CACHE_MAX_ENTRIES);
    assert(generated.continuityBytes <= CONTINUITY_CACHE_MAX_BYTES);
    assert(
      generated.totalBytes + generated.continuityBytes + ROUTING_STATE_RESERVED_BYTES
      <= OFFLINE_CACHE_MAX_BYTES,
    );
    assert(generated.continuityPack.bytes <= CONTINUITY_PACK_MAX_BYTES);
    assert.match(generated.continuityPack.path, /^\.\/assets\/patterdraw-continuity-[0-9a-f]{20}\.bin$/);
    assert.equal(
      createHash("sha256").update(generated.continuityPackSource).digest("hex"),
      generated.continuityPack.sha256,
    );
    assert.equal(gunzipSync(generated.continuityPackSource).byteLength, generated.continuityBytes);
    assert.deepEqual(repeated.continuityPack, generated.continuityPack);
    assert.deepEqual(repeated.continuityPackSource, generated.continuityPackSource);
    assert.equal(repeated.version, generated.version);
    assert(generated.code.includes("populateContinuityCache"));
    assert(generated.code.includes("DecompressionStream(\"gzip\")"));
    assert(generated.code.includes('cache: "no-store"'));
    assert(generated.code.includes("readExactResponseBytes"));
    assert(generated.code.includes('label + " exceeded its size limit."'));
    assert(generated.code.includes("release-continuity resource failed its integrity check"));

    const scope = "https://classroom.test/tools/patterdraw/";
    const installBodies = new Map(shellPaths.map((fileName) => [
      new URL(`./${fileName}`, scope).href,
      {
        body: runtimeFiles.get(fileName),
        mime: generated.entries.find((entry) => entry.path === `./${fileName}`).mime,
      },
    ]));
    installBodies.set(new URL(generated.continuityPack.path, scope).href, {
      body: generated.continuityPackSource,
      mime: "application/octet-stream",
    });
    const runtime = serviceWorkerRuntime(generated.code, {
      scope,
      fetch: async (request) => installResponse(request, installBodies),
    });
    await runtime.dispatchLifecycle("install");
    await runtime.dispatchLifecycle("activate");
    assert.equal(runtime.claimCalls(), 1);
    const cacheName = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${generated.version}`;
    const cache = runtime.stores.get(cacheName);
    assert(cache);
    for (const entry of generated.continuityEntries) {
      const cached = cache.get(new URL(entry.path, scope).href);
      assert(cached, entry.path);
      assert.equal(
        createHash("sha256").update(Buffer.from(await cached.clone().arrayBuffer())).digest("hex"),
        entry.sha256,
        entry.path,
      );
    }
    for (const entry of generated.continuityEntries) {
      const response = await runtime.dispatchAsset(new URL(entry.path, scope).href);
      assert(response, entry.path);
      assert.equal(
        createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"),
        entry.sha256,
        `first-use fetch: ${entry.path}`,
      );
    }
    const cachedGeoGon = cache.get(new URL("./geogon/index.html", scope).href);
    assert.equal(cachedGeoGon.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.match(cachedGeoGon.headers.get("Content-Security-Policy"), /connect-src 'none'/);

    const corruptedBodies = new Map(installBodies);
    const corruptedPack = Buffer.from(generated.continuityPackSource);
    corruptedPack[0] ^= 0xff;
    corruptedBodies.set(new URL(generated.continuityPack.path, scope).href, {
      body: corruptedPack,
      mime: "application/octet-stream",
    });
    const corruptRuntime = serviceWorkerRuntime(generated.code, {
      scope,
      fetch: async (request) => installResponse(request, corruptedBodies),
    });
    await assert.rejects(corruptRuntime.dispatchLifecycle("install"), /integrity check/);
    assert(!corruptRuntime.stores.has(cacheName));

    const quotaRuntime = serviceWorkerRuntime(generated.code, {
      failPutAt: shellPaths.length + 1,
      scope,
      fetch: async (request) => installResponse(request, installBodies),
    });
    await assert.rejects(quotaRuntime.dispatchLifecycle("install"), /Quota exceeded/);
    assert.equal(quotaRuntime.putCalls(), shellPaths.length + 1);
    assert(!quotaRuntime.stores.has(cacheName));

    const oversizedRuntime = serviceWorkerRuntime(generated.code, {
      scope,
      fetch: async (request) => {
        const response = installResponse(request, installBodies);
        if (request.url === new URL(generated.continuityPack.path, scope).href) {
          response.body = new Blob([
            generated.continuityPackSource,
            new Uint8Array([0xff]),
          ]).stream();
          response.arrayBuffer = async () => {
            throw new Error("The bounded stream reader must be used.");
          };
        }
        return response;
      },
    });
    await assert.rejects(
      oversizedRuntime.dispatchLifecycle("install"),
      /exceeded its size limit/,
    );
    assert(!oversizedRuntime.stores.has(cacheName));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("emits a conservative worker with no update takeover or remote dependency", () => {
  const generated = createOfflineServiceWorkerAsset(fixtureBundle());
  assert(generated.code.includes(`const CACHE_NAMESPACE_PREFIX = ${JSON.stringify(APP_SHELL_CACHE_PREFIX)}`));
  assert(generated.code.includes("encodeURIComponent(self.registration.scope)"));
  assert(generated.code.includes("name.startsWith(SCOPE_CACHE_PREFIX)"));
  assert(generated.code.includes(`const SHELL_PROTOCOL_HEADER = ${JSON.stringify(APP_SHELL_PROTOCOL_HEADER)}`));
  assert(generated.code.includes(`const SHELL_PROTOCOL_VERSION = ${JSON.stringify(APP_SHELL_PROTOCOL_VERSION)}`));
  assert(generated.code.includes('cache: relativePath === "./index.html" ? "reload" : "force-cache"'));
  assert(generated.code.includes('crypto.subtle.digest("SHA-256", bytes)'));
  assert(generated.code.includes("response.redirected"));
  assert(generated.code.includes("response.url !== request.url"));
  assert(generated.code.includes('headers.delete("Content-Encoding")'));
  assert(generated.code.includes("response.status >= 500"));
  assert(generated.code.includes("await transitionToRetired(event)"));
  assert(generated.code.includes("await transitionToReintroducing(event)"));
  assert(generated.code.includes("event.resultingClientId"));
  assert(generated.code.includes('request.mode === "navigate"'));
  assert(generated.code.includes('request.method !== "GET"'));
  assert(generated.code.includes("url.origin !== self.location.origin"));
  assert(generated.code.includes("await fetch(request)"));
  assert(!generated.code.includes("skipWaiting"));
  assert(!generated.code.includes("registration.unregister"));
  assert(generated.code.includes("await self.clients.claim()"));
  assert(!generated.code.includes("http://"));
  assert(!generated.code.includes("https://"));
});

test("a pending verified update blocks newer installs before cache or network mutation", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const neighbourScope = "https://classroom.test/tools/neighbour/";
  const entries = [
    manifestEntry("./index.html", "<!doctype html>", "text/html"),
    manifestEntry("./assets/main-12345678.js", "export const ready = true;", "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? "<!doctype html>" : "export const ready = true;",
    mime: entry.mime,
  }]));
  const cachePrefix = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:`;
  const activeCacheName = `${cachePrefix}${"a".repeat(20)}`;
  const waitingCacheName = `${cachePrefix}${"b".repeat(20)}`;
  const neighbourCacheName = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(neighbourScope)}:sentinel`;

  for (const version of ["c".repeat(20), "d".repeat(20)]) {
    let fetchCalls = 0;
    const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
      scope,
      waiting: { state: "installed" },
      fetch: async (request) => {
        fetchCalls += 1;
        return installResponse(request, bodies);
      },
    });
    const activeCache = new Map([[new URL("./index.html", scope).href, new Response("active A")]]);
    const waitingCache = new Map([[new URL("./index.html", scope).href, new Response("waiting B")]]);
    const neighbourCache = new Map([[new URL("sentinel", neighbourScope).href, new Response("neighbour")]]);
    runtime.stores.set(activeCacheName, activeCache);
    runtime.stores.set(waitingCacheName, waitingCache);
    runtime.stores.set(neighbourCacheName, neighbourCache);

    await assert.rejects(
      runtime.dispatchLifecycle("install"),
      /verified PatterDraw update is already waiting/,
    );
    assert.equal(fetchCalls, 0, version);
    assert.equal(runtime.openCalls(), 0, version);
    assert.equal(runtime.putCalls(), 0, version);
    assert.strictEqual(runtime.stores.get(activeCacheName), activeCache, version);
    assert.strictEqual(runtime.stores.get(waitingCacheName), waitingCache, version);
    assert.strictEqual(runtime.stores.get(neighbourCacheName), neighbourCache, version);
    assert.deepEqual([...runtime.stores.keys()].sort(), [
      activeCacheName,
      neighbourCacheName,
      waitingCacheName,
    ].sort(), version);
    assert.equal(
      await runtime.stores.get(waitingCacheName).get(new URL("./index.html", scope).href).text(),
      "waiting B",
      version,
    );
  }
});

test("the waiting release activates, scope-cleans A, and permits the current server update", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const neighbourScope = "https://classroom.test/tools/neighbour/";
  const entries = [
    manifestEntry("./index.html", "<!doctype html>", "text/html"),
    manifestEntry("./assets/main-12345678.js", "export const ready = true;", "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? "<!doctype html>" : "export const ready = true;",
    mime: entry.mime,
  }]));
  const cachePrefix = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:`;
  const cacheA = `${cachePrefix}${"a".repeat(20)}`;
  const cacheB = `${cachePrefix}${"b".repeat(20)}`;
  const cacheD = `${cachePrefix}${"d".repeat(20)}`;
  const neighbourCache = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(neighbourScope)}:sentinel`;
  const versionB = serviceWorkerRuntime(renderOfflineServiceWorker({
    entries,
    version: "b".repeat(20),
  }), { scope });
  versionB.stores.set(cacheA, new Map());
  versionB.stores.set(cacheB, new Map());
  versionB.stores.set(neighbourCache, new Map());

  await versionB.dispatchLifecycle("activate");
  assert.equal(versionB.claimCalls(), 1);
  assert.deepEqual([...versionB.stores.keys()].sort(), [cacheB, neighbourCache].sort());

  let fetchCalls = 0;
  const versionD = serviceWorkerRuntime(renderOfflineServiceWorker({
    entries,
    version: "d".repeat(20),
  }), {
    scope,
    fetch: async (request) => {
      fetchCalls += 1;
      return installResponse(request, bodies);
    },
  });
  versionD.stores.set(cacheB, versionB.stores.get(cacheB));
  versionD.stores.set(neighbourCache, versionB.stores.get(neighbourCache));
  await versionD.dispatchLifecycle("install");
  assert.equal(fetchCalls, entries.length);
  assert(versionD.stores.has(cacheB));
  assert(versionD.stores.has(cacheD));
  assert(versionD.stores.has(neighbourCache));
});

test("rejects unsafe, duplicate, and index-free generated manifests", () => {
  assert.throws(() => renderOfflineServiceWorker({
    entries: [{ path: "../outside.js" }],
    version: "a".repeat(20),
  }), /index\.html is not cached|unsafe worker cache path/);
  assert.throws(() => renderOfflineServiceWorker({
    entries: [{ path: "./index.html" }, { path: "./index.html" }],
    version: "a".repeat(20),
  }), /duplicate worker cache path/);
  assert.throws(() => renderOfflineServiceWorker({
    entries: [{ path: "./index.html" }],
    version: "not-a-version",
  }), /invalid cache version/);
});

test("accepts a marked app response when Fetch strips only the navigation fragment", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Verified PatterDraw</title>";
  const entries = [manifestEntry("./index.html", indexBody, "text/html")];
  const version = "b".repeat(20);
  const bodies = new Map([[new URL("./index.html", scope).href, {
    body: indexBody,
    mime: "text/html",
  }]]);
  let serverMode = "marked";
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      const responseUrl = new URL(request.url);
      responseUrl.hash = "";
      if (serverMode === "error") {
        return navigationResponse("gateway", {
          status: 503,
          url: responseUrl.href,
        });
      }
      return navigationResponse("<!doctype html><title>Marked server</title>", {
        marker: APP_SHELL_PROTOCOL_VERSION,
        url: responseUrl.href,
      });
    },
  });

  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");

  const navigationUrl = `${scope}lesson?class=20-3#board`;
  const markedResponse = await runtime.dispatchNavigation(navigationUrl);
  assert.equal(await markedResponse.text(), indexBody);

  const cacheName = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`;
  const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
  const stateAfterMarkedNavigation = runtime.stores.get(cacheName).get(stateUrl);
  assert(stateAfterMarkedNavigation);
  assert.equal(
    JSON.parse(await stateAfterMarkedNavigation.clone().text()).mode,
    "normal",
  );

  serverMode = "error";
  const gatewayResponse = await runtime.dispatchNavigation(navigationUrl);
  assert.equal(await gatewayResponse.text(), indexBody);
  const stateAfterGatewayError = runtime.stores.get(cacheName).get(stateUrl);
  assert(stateAfterGatewayError);
  assert.equal(JSON.parse(await stateAfterGatewayError.clone().text()).mode, "normal");
});

test("keeps cleanup scope-local and routes rollback without unregistering the active release", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>PatterDraw candidate</title>";
  const entries = [manifestEntry("./index.html", indexBody, "text/html")];
  const version = "b".repeat(20);
  const bodies = new Map([[new URL("./index.html", scope).href, {
    body: indexBody,
    mime: "text/html",
  }]]);
  let navigationStatus = 200;
  let rollback = false;
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    clients: [{ id: "lesson-a" }, { id: "lesson-b" }],
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      if (rollback) {
        return navigationResponse("<!doctype html><title>Rolled back</title>", {
          url: request.url,
        });
      }
      return navigationResponse("gateway", {
        status: navigationStatus,
        marker: APP_SHELL_PROTOCOL_VERSION,
        url: request.url,
      });
    },
  });
  const ownPrefix = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:`;
  const neighbourScope = "https://classroom.test/other/patterdraw/";
  const neighbourCache = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(neighbourScope)}:old`;
  runtime.stores.set(`${ownPrefix}old`, new Map());
  runtime.stores.set(neighbourCache, new Map());

  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");
  assert.equal(runtime.claimCalls(), 1);
  assert(!runtime.stores.has(`${ownPrefix}old`));
  assert(runtime.stores.has(`${ownPrefix}${version}`));
  assert(runtime.stores.has(neighbourCache));

  const newerMarkedResponse = await runtime.dispatchNavigation(`${scope}lesson`);
  assert.equal(await newerMarkedResponse.text(), indexBody);
  assert.equal(runtime.unregisterCalls(), 0);

  for (const status of [502, 503]) {
    navigationStatus = status;
    const response = await runtime.dispatchNavigation(`${scope}lesson-${status}`);
    assert.equal(await response.text(), indexBody);
  }

  rollback = true;
  const rollbackResponse = await runtime.dispatchNavigation(`${scope}rolled-back`, {
    clientId: "lesson-a",
    resultingClientId: "rollback-client",
  });
  assert.match(await rollbackResponse.text(), /Rolled back/);
  assert.equal(runtime.unregisterCalls(), 0);
  assert(runtime.stores.has(`${ownPrefix}${version}`));
  assert(runtime.stores.has(neighbourCache));
  const routingStateResponse = runtime.stores.get(`${ownPrefix}${version}`).get(
    new URL("./.__patterdraw_offline_routing_state__", scope).href,
  );
  assert(routingStateResponse);
  const routingState = JSON.parse(await routingStateResponse.text());
  assert.equal(typeof routingState.pendingClients[0]?.createdAt, "number");
  assert.deepEqual({
    ...routingState,
    pendingClients: routingState.pendingClients.map(({ createdAt, ...pending }) => pending),
  }, {
    cacheName: `${ownPrefix}${version}`,
    mode: "retired",
    passThroughClients: [],
    pendingClients: [{
      clientId: "rollback-client",
      routing: "pass-through",
    }],
    protectedClients: ["lesson-a", "lesson-b"],
    schema: 2,
    scope,
  });
});

test("protects open A client lineages while rollback clients stay network-only until marked reintroduction", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Verified A</title>";
  const lazyBody = "export const release = 'A';";
  const entries = [
    manifestEntry("./index.html", indexBody, "text/html"),
    manifestEntry("./assets/lazy-a1234567.js", lazyBody, "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? indexBody : lazyBody,
    mime: entry.mime,
  }]));
  const liveClients = [{ id: "lesson-a" }, { id: "lesson-b" }];
  let serverMode = "marked";
  const networkAssets = [];
  const workerCode = renderOfflineServiceWorker({
    entries,
    version: "f".repeat(20),
  });
  const fetchImplementation = async (request) => {
    if (request instanceof Request) return installResponse(request, bodies);
    if (request.mode !== "navigate") {
      networkAssets.push({ clientId: request.clientId, url: request.url });
      return navigationResponse("export const release = 'rollback';", {
        contentType: "application/javascript",
        url: request.url,
      });
    }
    if (serverMode === "error") {
      return navigationResponse("gateway", { status: 503, url: request.url });
    }
    return navigationResponse(
      serverMode === "unmarked"
        ? "<!doctype html><title>Rollback</title>"
        : "<!doctype html><title>Marked server</title>",
      {
        marker: serverMode === "marked" ? APP_SHELL_PROTOCOL_VERSION : undefined,
        url: request.url,
      },
    );
  };
  let runtime = serviceWorkerRuntime(workerCode, {
    clients: liveClients,
    scope,
    fetch: fetchImplementation,
  });
  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");

  serverMode = "unmarked";
  const rollbackResponse = await runtime.dispatchNavigation(`${scope}lesson`, {
    clientId: "lesson-a",
    resultingClientId: "rollback-client",
  });
  assert.match(await rollbackResponse.text(), /Rollback/);
  liveClients.splice(0, liveClients.length, { id: "lesson-b" }, { id: "rollback-client" });

  // Model browser termination/restart of the active worker. Routing must come
  // from the bounded canonical-cache record, not ephemeral globals.
  runtime = serviceWorkerRuntime(workerCode, {
    clients: liveClients,
    fetch: fetchImplementation,
    scope,
    stores: runtime.stores,
  });

  const lazyUrl = new URL("./assets/lazy-a1234567.js", scope).href;
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, {
      clientId: "lesson-b",
      resultingClientId: "protected-worker",
    })).text(),
    lazyBody,
  );
  liveClients.push({ id: "protected-worker" });
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, {
      clientId: "rollback-client",
      resultingClientId: "rollback-worker",
    })).text(),
    "export const release = 'rollback';",
  );
  liveClients.push({ id: "rollback-worker" });
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, { clientId: "protected-worker" })).text(),
    lazyBody,
  );
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, { clientId: "rollback-worker" })).text(),
    "export const release = 'rollback';",
  );
  assert.equal(networkAssets.length, 2);

  // Concurrent child-worker creations can complete before either resulting
  // client is visible to clients.matchAll(). Reserve both IDs durably so the
  // second serialized mutation cannot prune the first one as "not live".
  const concurrentProtectedChildren = ["protected-child-one", "protected-child-two"];
  const concurrentChildResponses = await Promise.all(concurrentProtectedChildren.map(
    (resultingClientId) => runtime.dispatchAsset(lazyUrl, {
      clientId: "lesson-b",
      resultingClientId,
    }),
  ));
  assert.deepEqual(
    await Promise.all(concurrentChildResponses.map((response) => response.text())),
    [lazyBody, lazyBody],
  );
  const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
  const ownCache = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${"f".repeat(20)}`;
  const reservedChildrenState = JSON.parse(await runtime.stores.get(ownCache)
    .get(stateUrl).clone().text());
  assert.deepEqual(
    reservedChildrenState.pendingClients
      .filter(({ clientId }) => concurrentProtectedChildren.includes(clientId))
      .map(({ clientId, routing }) => ({ clientId, routing }))
      .sort((left, right) => left.clientId.localeCompare(right.clientId)),
    concurrentProtectedChildren.map((clientId) => ({
      clientId,
      routing: "protected",
    })),
  );
  liveClients.push(...concurrentProtectedChildren.map((id) => ({ id })));
  for (const childId of concurrentProtectedChildren) {
    assert.equal(
      await (await runtime.dispatchAsset(lazyUrl, { clientId: childId })).text(),
      lazyBody,
    );
  }

  // Creating and terminating many protected child workers must prune dead
  // lineage IDs instead of exhausting the bounded state record.
  for (let index = 0; index < 140; index += 1) {
    const childId = `short-lived-protected-worker-${index}`;
    for (let cursor = liveClients.length - 1; cursor >= 0; cursor -= 1) {
      if (liveClients[cursor].id.startsWith("short-lived-protected-worker-")) {
        liveClients.splice(cursor, 1);
      }
    }
    assert.equal(
      await (await runtime.dispatchAsset(lazyUrl, {
        clientId: "lesson-b",
        resultingClientId: childId,
      })).text(),
      lazyBody,
    );
    // The reservation is written before the resulting client materializes.
    // Its first request promotes the reservation to a live protected lineage;
    // the next iteration then proves the terminated ID is pruned.
    liveClients.push({ id: childId });
    assert.equal(
      await (await runtime.dispatchAsset(lazyUrl, { clientId: childId })).text(),
      lazyBody,
    );
  }

  serverMode = "error";
  assert.equal(
    (await runtime.dispatchNavigation(`${scope}rollback-offline`, {
      clientId: "rollback-client",
      resultingClientId: "rollback-error-result",
    })).status,
    503,
  );
  liveClients.push({ id: "rollback-error-result" });
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, { clientId: "rollback-error-result" })).text(),
    "export const release = 'rollback';",
  );
  assert.equal(
    (await runtime.dispatchNavigation(`${scope}protected-offline`, {
      clientId: "lesson-b",
      resultingClientId: "protected-error-result",
    })).status,
    503,
  );
  liveClients.push({ id: "protected-error-result" });
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, { clientId: "protected-error-result" })).text(),
    "export const release = 'rollback';",
  );

  serverMode = "marked";
  // Simulate a rollback descendant that appeared while the worker process was
  // asleep and therefore has no persisted classification. It must default to
  // pass-through and prevent premature NORMAL state.
  liveClients.push({ id: "unknown-rollback-descendant" });
  const reintroducedClientIds = ["reintroduced-client-one", "reintroduced-client-two"];
  const reintroduced = await Promise.all(reintroducedClientIds.map(
    (resultingClientId) => runtime.dispatchNavigation(`${scope}lesson`, {
      clientId: "rollback-client",
      resultingClientId,
    }),
  ));
  assert.deepEqual(
    await Promise.all(reintroduced.map((response) => response.text())),
    [indexBody, indexBody],
  );
  const reservedNavigationsState = JSON.parse(await runtime.stores.get(ownCache)
    .get(stateUrl).clone().text());
  assert.deepEqual(
    reservedNavigationsState.pendingClients
      .filter(({ clientId }) => reintroducedClientIds.includes(clientId))
      .map(({ clientId, routing }) => ({ clientId, routing }))
      .sort((left, right) => left.clientId.localeCompare(right.clientId)),
    reintroducedClientIds.map((clientId) => ({
      clientId,
      routing: "protected",
    })),
  );
  liveClients.push(...reintroducedClientIds.map((id) => ({ id })));
  for (const clientId of reintroducedClientIds) {
    assert.equal(
      await (await runtime.dispatchAsset(lazyUrl, { clientId })).text(),
      lazyBody,
    );
  }
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, { clientId: "rollback-client" })).text(),
    "export const release = 'rollback';",
  );
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, {
      clientId: "unknown-rollback-descendant",
    })).text(),
    "export const release = 'rollback';",
  );
  const transitionalState = runtime.stores.get(ownCache).get(stateUrl);
  assert.equal(JSON.parse(await transitionalState.clone().text()).mode, "reintroducing");

  liveClients.splice(
    0,
    liveClients.length,
    { id: "lesson-b" },
    { id: "protected-worker" },
    ...concurrentProtectedChildren.map((id) => ({ id })),
    ...reintroducedClientIds.map((id) => ({ id })),
  );
  // No new navigation is needed to normalize. Any ordinary protected static
  // request reconciles dead pass-through lineages and restores NORMAL only
  // after every live controlled client is protected.
  assert.equal(
    await (await runtime.dispatchAsset(lazyUrl, {
      clientId: reintroducedClientIds[0],
    })).text(),
    lazyBody,
  );
  const normalState = runtime.stores.get(ownCache).get(stateUrl);
  assert(normalState);
  assert.equal(JSON.parse(await normalState.text()).mode, "normal");
  assert.equal(runtime.unregisterCalls(), 0);
});

test("content-authorizes only a same-origin blob worker during a release transition", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Verified A</title>";
  const speechBody = "self.postMessage('ready');";
  const mapBody = JSON.stringify({ locale: "en" });
  const entries = [
    manifestEntry("./index.html", indexBody, "text/html"),
    manifestEntry("./mathjax/sre/speech-worker.js", speechBody, "application/javascript"),
    manifestEntry("./mathjax/sre/mathmaps/base.json", mapBody, "application/json"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html")
      ? indexBody
      : entry.path.endsWith(".json") ? mapBody : speechBody,
    mime: entry.mime,
  }]));
  const liveClients = [{ id: "lesson-a", type: "window", url: scope }];
  let serverMode = "marked";
  let networkAssetFetches = 0;
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({
    entries,
    version: "7".repeat(20),
  }), {
    clients: liveClients,
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      if (request.mode !== "navigate") {
        networkAssetFetches += 1;
        return navigationResponse("network asset", {
          contentType: request.url.endsWith(".json") ? "application/json" : "application/javascript",
          url: request.url,
        });
      }
      return navigationResponse(
        serverMode === "marked"
          ? "<!doctype html><title>Marked release</title>"
          : "<!doctype html><title>Rollback</title>",
        {
          marker: serverMode === "marked" ? APP_SHELL_PROTOCOL_VERSION : undefined,
          url: request.url,
        },
      );
    },
  });
  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");

  serverMode = "rollback";
  await runtime.dispatchNavigation(`${scope}rollback`, {
    clientId: "lesson-a",
    resultingClientId: "rollback-window",
  });
  liveClients.push({ id: "rollback-window", type: "window", url: `${scope}rollback` });
  serverMode = "marked";
  await runtime.dispatchNavigation(`${scope}lesson`, {
    clientId: "rollback-window",
    resultingClientId: "reintroduced-window",
  });
  liveClients.push({ id: "reintroduced-window", type: "window", url: `${scope}lesson` });

  const speechEntry = entries.find((entry) => entry.path.endsWith("speech-worker.js"));
  assert(speechEntry);
  const speechUrl = new URL(speechEntry.path, scope);
  speechUrl.searchParams.set("patterdraw-asset-sha256", speechEntry.sha256);
  liveClients.push({
    id: "mathjax-blob-worker",
    type: "worker",
    url: "blob:https://classroom.test/mathjax-worker",
  });
  assert.equal(
    await (await runtime.dispatchAsset(speechUrl.href, {
      clientId: "mathjax-blob-worker",
    })).text(),
    speechBody,
  );
  const mapUrl = new URL("./mathjax/sre/mathmaps/base.json", scope).href;
  assert.equal(
    await (await runtime.dispatchAsset(mapUrl, { clientId: "mathjax-blob-worker" })).text(),
    mapBody,
  );

  // The capability must not let a rollback Window client fetch cached A or
  // promote itself and mix the remainder of release A into its document.
  assert.equal(
    await (await runtime.dispatchAsset(speechUrl.href, { clientId: "rollback-window" })).text(),
    "network asset",
  );
  assert.equal(
    await (await runtime.dispatchAsset(new URL(speechEntry.path, scope).href, {
      clientId: "rollback-window",
    })).text(),
    "network asset",
  );

  const mapEntry = entries.find((entry) => entry.path.endsWith("base.json"));
  assert(mapEntry);
  const wrongPathUrl = new URL(mapEntry.path, scope);
  wrongPathUrl.searchParams.set("patterdraw-asset-sha256", mapEntry.sha256);
  liveClients.push({
    id: "wrong-path-blob-worker",
    type: "worker",
    url: "blob:https://classroom.test/wrong-path-worker",
  });
  assert.equal(
    await (await runtime.dispatchAsset(wrongPathUrl.href, {
      clientId: "wrong-path-blob-worker",
    })).text(),
    "network asset",
  );
  const invalidAuthorityUrl = new URL(speechEntry.path, scope);
  invalidAuthorityUrl.searchParams.set("patterdraw-asset-sha256", "0".repeat(64));
  liveClients.push({
    id: "invalid-authority-blob-worker",
    type: "worker",
    url: "blob:https://classroom.test/invalid-authority-worker",
  });
  assert.equal(
    await (await runtime.dispatchAsset(invalidAuthorityUrl.href, {
      clientId: "invalid-authority-blob-worker",
    })).text(),
    "network asset",
  );
  assert.equal(networkAssetFetches, 4);
});

test("content-authorizes only the pinned GeoGon iframe entry during a release transition", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Verified A</title>";
  const geoGonBody = "<!doctype html><script src='./app.js'></script>";
  const geoGonScript = "globalThis.geogonRelease = 'A';";
  const entries = [
    manifestEntry("./index.html", indexBody, "text/html"),
    manifestEntry("./geogon/index.html", geoGonBody, "text/html"),
    manifestEntry("./geogon/app.js", geoGonScript, "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path === "./index.html"
      ? indexBody
      : entry.path.endsWith("app.js") ? geoGonScript : geoGonBody,
    mime: entry.mime,
  }]));
  const liveClients = [{ id: "lesson-a", type: "window", url: scope }];
  let serverMode = "marked";
  const networkRequests = [];
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({
    entries,
    version: "6".repeat(20),
  }), {
    clients: liveClients,
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      networkRequests.push({
        destination: request.destination,
        mode: request.mode,
        url: request.url,
      });
      if (request.mode === "navigate") {
        return navigationResponse(
          serverMode === "marked"
            ? "<!doctype html><title>Marked release B</title>"
            : "<!doctype html><title>Rollback</title>",
          {
            marker: serverMode === "marked" ? APP_SHELL_PROTOCOL_VERSION : undefined,
            url: request.url,
          },
        );
      }
      return navigationResponse("globalThis.geogonRelease = 'network';", {
        contentType: "application/javascript",
        url: request.url,
      });
    },
  });
  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");

  serverMode = "rollback";
  await runtime.dispatchNavigation(`${scope}rollback`, {
    clientId: "lesson-a",
    resultingClientId: "rollback-window",
  });
  liveClients.push({ id: "rollback-window", type: "window", url: `${scope}rollback` });
  serverMode = "marked";
  await runtime.dispatchNavigation(`${scope}lesson`, {
    clientId: "rollback-window",
    resultingClientId: "reintroduced-window",
  });
  liveClients.push({ id: "reintroduced-window", type: "window", url: `${scope}lesson` });

  const authorizedEntry = new URL("./geogon/index.html", scope);
  authorizedEntry.searchParams.set("host", "patterdraw");
  authorizedEntry.searchParams.set("patterdraw-geogon", GEOGON_RELEASE_AUTHORITY);
  assert.equal(
    await (await runtime.dispatchNavigation(authorizedEntry.href, {
      clientId: "",
      destination: "iframe",
      resultingClientId: "geogon-frame",
    })).text(),
    geoGonBody,
  );
  liveClients.push({ id: "geogon-frame", type: "window", url: authorizedEntry.href });
  assert.equal(
    await (await runtime.dispatchAsset(new URL("./geogon/app.js", scope).href, {
      clientId: "geogon-frame",
    })).text(),
    geoGonScript,
  );

  const wrongAuthority = new URL(authorizedEntry);
  wrongAuthority.searchParams.set("patterdraw-geogon", "0".repeat(40));
  assert.match(
    await (await runtime.dispatchNavigation(wrongAuthority.href, {
      destination: "iframe",
      resultingClientId: "wrong-authority-frame",
    })).text(),
    /Marked release B/,
  );
  assert.match(
    await (await runtime.dispatchNavigation(authorizedEntry.href, {
      destination: "document",
      resultingClientId: "top-level-window",
    })).text(),
    /Marked release B/,
  );
  const wrongPath = new URL("./index.html", scope);
  wrongPath.searchParams.set("host", "patterdraw");
  wrongPath.searchParams.set("patterdraw-geogon", GEOGON_RELEASE_AUTHORITY);
  assert.match(
    await (await runtime.dispatchNavigation(wrongPath.href, {
      destination: "iframe",
      resultingClientId: "wrong-path-frame",
    })).text(),
    /Verified A/,
  );
  assert.equal(
    networkRequests.filter(({ url }) => url.includes("geogon/index.html")).length,
    2,
  );
});

test("missing, malformed, and oversized routing state fail closed without offline resurrection", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Verified A</title>";
  const lazyBody = "export const release = 'A';";
  const entries = [
    manifestEntry("./index.html", indexBody, "text/html"),
    manifestEntry("./assets/lazy-a1234567.js", lazyBody, "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? indexBody : lazyBody,
    mime: entry.mime,
  }]));
  const version = "9".repeat(20);
  const cacheName = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`;
  const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
  const lazyUrl = new URL("./assets/lazy-a1234567.js", scope).href;

  for (const scenario of ["missing", "malformed", "oversized"]) {
    const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
      clients: [{ id: "ambiguous-client" }],
      scope,
      fetch: async (request) => {
        if (request instanceof Request) return installResponse(request, bodies);
        if (request.mode === "navigate") {
          return navigationResponse("gateway", { status: 503, url: request.url });
        }
        return navigationResponse("export const release = 'network';", {
          contentType: "application/javascript",
          url: request.url,
        });
      },
    });
    await runtime.dispatchLifecycle("install");
    const cache = await runtime.caches.open(cacheName);
    if (scenario === "missing") {
      await cache.delete(stateUrl);
    } else if (scenario === "malformed") {
      await cache.put(stateUrl, new Response("{not-json", {
        headers: { "Content-Type": "application/json" },
      }));
    } else {
      await cache.put(stateUrl, new Response(`{"padding":"${"x".repeat(33 * 1024)}"}`, {
        headers: { "Content-Type": "application/json" },
      }));
    }

    const navigation = await runtime.dispatchNavigation(`${scope}lesson`, {
      clientId: "ambiguous-client",
      resultingClientId: "ambiguous-result",
    });
    assert.equal(navigation.status, 503, scenario);
    assert.equal(
      await (await runtime.dispatchAsset(lazyUrl, { clientId: "ambiguous-client" })).text(),
      "export const release = 'network';",
      scenario,
    );
  }
});

test("a routing-state quota failure never exposes unmarked HTML under the cached worker", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Verified A</title>";
  const entries = [manifestEntry("./index.html", indexBody, "text/html")];
  const bodies = new Map([[new URL("./index.html", scope).href, {
    body: indexBody,
    mime: "text/html",
  }]]);
  const version = "8".repeat(20);
  const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
  let rejectStateWrites = false;
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    clients: [{ id: "lesson-a" }],
    failPutWhen: ({ key }) => rejectStateWrites && key === stateUrl,
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      return navigationResponse("<!doctype html><title>Unmarked rollback</title>", {
        url: request.url,
      });
    },
  });
  await runtime.dispatchLifecycle("install");
  rejectStateWrites = true;

  const response = await runtime.dispatchNavigation(`${scope}lesson`, {
    clientId: "lesson-a",
    resultingClientId: "rollback-client",
  });
  assert.equal(await response.text(), indexBody);
  assert.equal(runtime.unregisterCalls(), 0);

  const installFailure = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    failPutWhen: ({ key }) => key === stateUrl,
    scope,
    fetch: async (request) => installResponse(request, bodies),
  });
  await assert.rejects(
    installFailure.dispatchLifecycle("install"),
    /Quota exceeded/,
  );
  assert.equal(
    installFailure.stores.has(
      `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`,
    ),
    false,
  );
});

test("falls back to the cached entry point for direct index navigations with query or hash state", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>PatterDraw cached entry</title>";
  const entries = [manifestEntry("./index.html", indexBody, "text/html")];
  const version = "e".repeat(20);
  const bodies = new Map([[new URL("./index.html", scope).href, {
    body: indexBody,
    mime: "text/html",
  }]]);
  let throwNavigationError = false;
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      if (throwNavigationError) throw new Error("offline");
      return navigationResponse("gateway", {
        status: 503,
        marker: APP_SHELL_PROTOCOL_VERSION,
        url: request.url,
      });
    },
  });
  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");

  const queryResponse = await runtime.dispatchNavigation(
    `${scope}index.html?lesson=quadratics&student=local`,
  );
  assert.equal(await queryResponse.text(), indexBody);

  throwNavigationError = true;
  const fragmentResponse = await runtime.dispatchNavigation(
    `${scope}index.html?lesson=quadratics#board`,
  );
  assert.equal(await fragmentResponse.text(), indexBody);
});

test("classifies every same-scope HTML document before returning errors or redirects", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>PatterDraw candidate</title>";
  const entries = [manifestEntry("./index.html", indexBody, "text/html")];
  const version = "c".repeat(20);
  const bodies = new Map([[new URL("./index.html", scope).href, {
    body: indexBody,
    mime: "text/html",
  }]]);
  const ownCache = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`;
  const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;

  const cases = [
    ...[401, 403, 404, 408, 429].map((status) => ({
      expectRetired: true,
      label: `same-scope HTML HTTP ${status}`,
      marker: status === 404 ? APP_SHELL_PROTOCOL_VERSION : undefined,
      status,
    })),
    {
      expectRetired: true,
      label: "followed same-scope HTML redirect",
      marker: APP_SHELL_PROTOCOL_VERSION,
      redirected: true,
      url: `${scope}login`,
    },
    {
      contentType: "application/json",
      expectRetired: false,
      label: "same-scope non-HTML response",
    },
    {
      expectRetired: false,
      label: "same-origin redirect outside the worker scope",
      redirected: true,
      url: "https://classroom.test/login",
    },
    {
      expectRetired: false,
      label: "different-origin redirect",
      redirected: true,
      url: "https://login.classroom.test/tools/patterdraw/lesson",
    },
  ];

  for (const testCase of cases) {
    const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
      scope,
      fetch: async (request) => {
        if (request instanceof Request) return installResponse(request, bodies);
        return navigationResponse("online response", {
          url: request.url,
          ...testCase,
        });
      },
    });
    await runtime.dispatchLifecycle("install");
    await runtime.dispatchLifecycle("activate");
    const response = await runtime.dispatchNavigation(`${scope}lesson`, {
      clientId: "open-a-client",
      resultingClientId: "navigation-result",
    });
    assert.equal(await response.text(), "online response", testCase.label);
    assert.equal(runtime.unregisterCalls(), 0, testCase.label);
    assert(runtime.stores.has(ownCache), testCase.label);
    const state = JSON.parse(await runtime.stores.get(ownCache).get(stateUrl).clone().text());
    assert.equal(state.mode, testCase.expectRetired ? "retired" : "normal", testCase.label);
    assert.equal(
      state.pendingClients.some((pending) => (
        pending.clientId === "navigation-result" && pending.routing === "pass-through"
      )),
      testCase.expectRetired,
      testCase.label,
    );
  }
});

test("fails closed to cached A when a rollback result cannot be assigned a client lineage", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>PatterDraw candidate</title>";
  const entries = [manifestEntry("./index.html", indexBody, "text/html")];
  const version = "d".repeat(20);
  const bodies = new Map([[new URL("./index.html", scope).href, {
    body: indexBody,
    mime: "text/html",
  }]]);
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    scope,
    fetch: async (request) => {
      if (request instanceof Request) return installResponse(request, bodies);
      return navigationResponse("<!doctype html><title>Safe rollback</title>", {
        url: request.url,
      });
    },
  });
  const ownCache = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`;
  await runtime.dispatchLifecycle("install");
  await runtime.dispatchLifecycle("activate");

  runtime.caches.delete = async () => {
    throw new Error("rollback must not delete a cache used by another open tab");
  };

  const response = await runtime.dispatchNavigation(`${scope}rolled-back`, {
    clientId: "lesson-a",
    resultingClientId: "",
  });
  assert.equal(await response.text(), indexBody);
  assert.equal(runtime.unregisterCalls(), 0);
  assert(runtime.stores.has(ownCache));
  const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
  assert.equal(
    JSON.parse(await runtime.stores.get(ownCache).get(stateUrl).clone().text()).mode,
    "normal",
  );
  // Because NORMAL means every controlled client is running cached A, an
  // unidentified rollback result is given cached A and remains coherently
  // protected on its subsequent static requests.
  assert.equal(
    await (await runtime.dispatchAsset(new URL("./index.html", scope).href, {
      clientId: "unidentified-result",
    })).text(),
    indexBody,
  );

  const classifiedRollback = await runtime.dispatchNavigation(`${scope}classified-rollback`, {
    clientId: "lesson-a",
    resultingClientId: "rollback-client",
  });
  assert.match(await classifiedRollback.text(), /Safe rollback/);
  await assert.rejects(
    runtime.dispatchNavigation(`${scope}ambiguous-during-retirement`, {
      clientId: "rollback-client",
      resultingClientId: "",
    }),
    /Unable to classify the same-scope document safely/,
  );
});

test("rejects an oversized startup response before buffering past its manifest size", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const entries = [
    manifestEntry("./index.html", "<!doctype html>", "text/html"),
    manifestEntry("./assets/main-12345678.js", "export const ready = true;", "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? "<!doctype html>" : "export const ready = true;",
    mime: entry.mime,
  }]));
  const version = "d".repeat(20);
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    scope,
    fetch: async (request) => {
      const response = installResponse(request, bodies);
      if (request.url.endsWith(".js")) {
        response.body = new Blob([
          Buffer.from(bodies.get(request.url).body),
          new Uint8Array([0xff]),
        ]).stream();
        response.arrayBuffer = async () => {
          throw new Error("The bounded startup reader must be used.");
        };
      }
      return response;
    },
  });
  const ownPrefix = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:`;
  const oldCache = `${ownPrefix}known-good`;
  runtime.stores.set(oldCache, new Map());

  await assert.rejects(
    runtime.dispatchLifecycle("install"),
    /app-shell resource exceeded its size limit/,
  );
  assert(runtime.stores.has(oldCache));
  assert(!runtime.stores.has(`${ownPrefix}${version}`));
});

test("failed redirect, MIME, URL, or integrity checks retain an older working shell", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const entries = [
    manifestEntry("./index.html", "<!doctype html>", "text/html"),
    manifestEntry("./assets/main-12345678.js", "export const ready = true;", "application/javascript"),
  ];
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? "<!doctype html>" : "export const ready = true;",
    mime: entry.mime,
  }]));
  for (const poison of ["redirect", "mime", "url", "integrity"]) {
    const version = createHash("sha256").update(poison).digest("hex").slice(0, 20);
    const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
      scope,
      fetch: async (request) => {
        const isScript = request.url.endsWith(".js");
        if (!isScript) return installResponse(request, bodies);
        if (poison === "redirect") return installResponse(request, bodies, { redirected: true });
        if (poison === "mime") return installResponse(request, bodies, { contentType: "text/html" });
        if (poison === "url") return installResponse(request, bodies, { url: `${request.url}?login=1` });
        const response = installResponse(request, bodies);
        const tampered = Buffer.from(bodies.get(request.url).body);
        tampered[0] ^= 0xff;
        response.body = new Blob([tampered]).stream();
        return response;
      },
    });
    const ownPrefix = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:`;
    const oldCache = `${ownPrefix}known-good`;
    runtime.stores.set(oldCache, new Map());
    await assert.rejects(runtime.dispatchLifecycle("install"));
    assert(runtime.stores.has(oldCache), poison);
    assert(!runtime.stores.has(`${ownPrefix}${version}`), poison);
  }
});

test("a failed same-manifest runtime update preserves the active same-name cache", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Known-good shell</title>";
  const scriptBody = "export const ready = true;";
  const entries = [
    manifestEntry("./index.html", indexBody, "text/html"),
    manifestEntry("./assets/main-12345678.js", scriptBody, "application/javascript"),
  ];
  // A runtime-only worker change retains the startup-derived version and thus
  // CACHE_NAME. Model the incumbent worker's complete cache before installing
  // a replacement whose network verification fails partway through.
  const version = "e".repeat(20);
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? indexBody : scriptBody,
    mime: entry.mime,
  }]));
  const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
    scope,
    fetch: async (request) => {
      const response = installResponse(request, bodies);
      if (request.url.endsWith(".js")) {
        const tampered = Buffer.from(bodies.get(request.url).body);
        tampered[0] ^= 0xff;
        response.body = new Blob([tampered]).stream();
      }
      return response;
    },
  });
  const activeCacheName = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`;
  const activeCache = new Map([
    [new URL("./index.html", scope).href, new Response(indexBody, {
      headers: { "Content-Type": "text/html" },
    })],
    [new URL("./assets/main-12345678.js", scope).href, new Response(scriptBody, {
      headers: { "Content-Type": "application/javascript" },
    })],
  ]);
  runtime.stores.set(activeCacheName, activeCache);

  await assert.rejects(runtime.dispatchLifecycle("install"), /integrity check/);

  assert.strictEqual(runtime.stores.get(activeCacheName), activeCache);
  assert.equal(
    await (await runtime.caches.open(activeCacheName)).match(new URL("./index.html", scope).href).then((response) => response.text()),
    indexBody,
  );
  assert.equal(
    await (await runtime.caches.open(activeCacheName)).match(new URL("./assets/main-12345678.js", scope).href).then((response) => response.text()),
    scriptBody,
  );
  assert(!runtime.stores.has(`${activeCacheName}:installing`));
});

test("a successful same-version install repairs empty or partial canonical caches exactly", async () => {
  const scope = "https://classroom.test/tools/patterdraw/";
  const indexBody = "<!doctype html><title>Repaired shell</title>";
  const scriptBody = "export const repaired = true;";
  const entries = [
    manifestEntry("./index.html", indexBody, "text/html"),
    manifestEntry("./assets/main-12345678.js", scriptBody, "application/javascript"),
  ];
  const expectedByUrl = new Map(entries.map((entry) => [new URL(entry.path, scope).href, entry]));
  const bodies = new Map(entries.map((entry) => [new URL(entry.path, scope).href, {
    body: entry.path.endsWith(".html") ? indexBody : scriptBody,
    mime: entry.mime,
  }]));

  for (const scenario of ["empty", "partial"]) {
    const version = createHash("sha256").update(`repair-${scenario}`).digest("hex").slice(0, 20);
    const runtime = serviceWorkerRuntime(renderOfflineServiceWorker({ entries, version }), {
      scope,
      fetch: async (request) => installResponse(request, bodies),
    });
    const canonicalName = `${APP_SHELL_CACHE_PREFIX}${encodeURIComponent(scope)}:${version}`;
    const canonicalStore = new Map();
    const stateUrl = new URL("./.__patterdraw_offline_routing_state__", scope).href;
    const incumbentRoutingState = JSON.stringify({
      cacheName: canonicalName,
      mode: "retired",
      passThroughClients: ["rollback-client"],
      pendingClients: [],
      protectedClients: ["open-a-client"],
      schema: 2,
      scope,
    });
    canonicalStore.set(stateUrl, new Response(incumbentRoutingState, {
      headers: { "Content-Type": "application/json" },
    }));
    if (scenario === "partial") {
      canonicalStore.set(new URL("./index.html", scope).href, new Response(indexBody, {
        headers: {
          "Content-Type": "text/html",
          "X-Poison": "must-not-survive-repair",
        },
      }));
      canonicalStore.set(new URL("./obsolete.js", scope).href, new Response("poison", {
        headers: { "Content-Type": "application/javascript" },
      }));
    }
    runtime.stores.set(canonicalName, canonicalStore);

    await runtime.dispatchLifecycle("install");

    assert.strictEqual(runtime.stores.get(canonicalName), canonicalStore, scenario);
    assert(!runtime.stores.has(`${canonicalName}:installing`), scenario);
    const canonicalCache = await runtime.caches.open(canonicalName);
    const cachedUrls = (await canonicalCache.keys()).map((request) => request.url).sort();
    assert.deepEqual(cachedUrls, [...expectedByUrl.keys(), stateUrl].sort(), scenario);
    for (const [url, expected] of expectedByUrl) {
      const response = await canonicalCache.match(url);
      const expectedBody = url.endsWith(".html") ? indexBody : scriptBody;
      assert.equal(await response.text(), expectedBody, `${scenario}: ${url} body`);
      assert.equal(response.headers.get("Content-Type"), expected.mime, `${scenario}: ${url} MIME`);
      assert.equal(response.headers.get("X-Poison"), null, `${scenario}: ${url} poison header`);
      assert.equal(response.headers.get("Content-Encoding"), null, `${scenario}: ${url} encoding`);
      assert.equal(response.headers.get("Content-Length"), null, `${scenario}: ${url} length`);
      assert.equal(response.headers.get("Transfer-Encoding"), null, `${scenario}: ${url} transfer encoding`);
    }
    assert.equal(
      await (await canonicalCache.match(stateUrl)).text(),
      incumbentRoutingState,
      `${scenario}: incumbent routing state`,
    );
  }
});
