import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import {
  collectOfflineAppShellPaths,
  collectOfflineContinuityPathsFromFiles,
  createOfflineServiceWorkerAssetFromFiles,
} from "./build/offline-service-worker.mjs";

const excalidrawFontRoot = fileURLToPath(new URL(
  "./node_modules/@excalidraw/excalidraw/dist/prod/fonts/",
  import.meta.url,
));
const pdfjsStandardFontRoot = fileURLToPath(new URL(
  "./node_modules/pdfjs-dist/standard_fonts/",
  import.meta.url,
));
const mathJaxRoot = fileURLToPath(new URL("./node_modules/mathjax/", import.meta.url));
const mathJaxSreRoot = fileURLToPath(new URL("./node_modules/mathjax/sre/", import.meta.url));
const mathJaxSpeechWorkerSha256 = createHash("sha256")
  .update(readFileSync(path.join(mathJaxSreRoot, "speech-worker.js")))
  .digest("hex");
const mathJaxFontRoot = fileURLToPath(new URL(
  "./node_modules/@mathjax/mathjax-newcm-font/",
  import.meta.url,
));
const releaseLicenseRoot = fileURLToPath(new URL("./licenses/", import.meta.url));

async function fontFiles(root: string, prefix = ""): Promise<Array<{ absolute: string; relative: string }>> {
  const files: Array<{ absolute: string; relative: string }> = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await fontFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith(".woff2")) {
      files.push({ absolute: path.join(root, relative), relative: relative.split(path.sep).join("/") });
    }
  }
  return files;
}

async function assetFiles(root: string, prefix = ""): Promise<Array<{ absolute: string; relative: string }>> {
  const files: Array<{ absolute: string; relative: string }> = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await assetFiles(root, relative));
    else if (entry.isFile()) {
      files.push({ absolute: path.join(root, relative), relative: relative.split(path.sep).join("/") });
    }
  }
  return files;
}

function localAssetContentType(relativePath: string): string {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".json": return "application/json; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".pfb": return "application/x-font-type1";
    case ".ttf": return "font/ttf";
    case ".woff2": return "font/woff2";
    case ".txt":
    case ".mts": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function sendLocalAssetPathError(response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }, statusCode: 400 | 404): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(statusCode === 400 ? "Bad Request" : "Not found");
}

function isUnsafeLocalAssetPath(relativePath: string): boolean {
  return !relativePath
    || relativePath.includes("\0")
    || relativePath.split(/[\\/]/).some((part) => part === "." || part === "..");
}

function localExcalidrawFonts(): Plugin {
  return {
    name: "local-excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const prefix = "/excalidraw-assets/fonts/";
        const rawPath = (request.url || "").split(/[?#]/, 1)[0];
        if (!rawPath.startsWith(prefix)) return next();
        let relative: string;
        try {
          relative = decodeURIComponent(rawPath.slice(prefix.length));
        } catch {
          sendLocalAssetPathError(response, 400);
          return;
        }
        if (isUnsafeLocalAssetPath(relative)) {
          sendLocalAssetPathError(response, 404);
          return;
        }
        try {
          const bytes = await readFile(path.join(excalidrawFontRoot, relative));
          response.statusCode = 200;
          response.setHeader("Content-Type", "font/woff2");
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          response.end(bytes);
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      for (const file of await fontFiles(excalidrawFontRoot)) {
        this.emitFile({
          type: "asset",
          fileName: `excalidraw-assets/fonts/${file.relative}`,
          source: await readFile(file.absolute),
        });
      }
    },
  };
}

async function localPdfjsAssetList(): Promise<LocalAsset[]> {
  return (await assetFiles(pdfjsStandardFontRoot)).map((file) => ({
    absolute: file.absolute,
    output: `pdfjs/standard_fonts/${file.relative}`,
  }));
}

function localPdfjsAssets(): Plugin {
  return {
    name: "local-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const rawPath = (request.url || "").split(/[?#]/, 1)[0];
        const rawRequestPath = rawPath.replace(/^\//, "");
        if (!rawRequestPath.startsWith("pdfjs/standard_fonts/")) return next();
        let requestPath: string;
        try {
          requestPath = decodeURIComponent(rawRequestPath);
        } catch {
          sendLocalAssetPathError(response, 400);
          return;
        }
        if (isUnsafeLocalAssetPath(requestPath)) {
          sendLocalAssetPathError(response, 404);
          return;
        }
        const asset = (await localPdfjsAssetList()).find((candidate) => candidate.output === requestPath);
        if (!asset) return next();
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", localAssetContentType(asset.output));
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          response.end(await readFile(asset.absolute));
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      for (const asset of await localPdfjsAssetList()) {
        this.emitFile({ type: "asset", fileName: asset.output, source: await readFile(asset.absolute) });
      }
    },
  };
}

interface LocalAsset {
  absolute: string;
  output: string;
}

async function localMathJaxAssetList(): Promise<LocalAsset[]> {
  const dynamicFontNames = (await readdir(path.join(mathJaxFontRoot, "svg/dynamic")))
    .filter((name) => name.endsWith(".js"));
  const sreFiles = await assetFiles(mathJaxSreRoot);
  for (const required of ["speech-worker.js", "mathmaps/base.json", "mathmaps/en.json"]) {
    if (!sreFiles.some((file) => file.relative === required)) {
      throw new Error(`MathJax SRE asset is missing: ${required}`);
    }
  }
  return [
    { absolute: path.join(mathJaxRoot, "tex-svg.js"), output: "mathjax/tex-svg.js" },
    { absolute: path.join(mathJaxRoot, "ui/safe.js"), output: "mathjax/ui/safe.js" },
    ...sreFiles.map((file) => ({
      absolute: file.absolute,
      output: `mathjax/sre/${file.relative}`,
    })),
    { absolute: path.join(mathJaxFontRoot, "svg.js"), output: "mathjax-fonts/mathjax-newcm-font/svg.js" },
    ...dynamicFontNames.map((name) => ({
      absolute: path.join(mathJaxFontRoot, "svg/dynamic", name),
      output: `mathjax-fonts/mathjax-newcm-font/svg/dynamic/${name}`,
    })),
  ];
}

function localMathJaxAssets(): Plugin {
  return {
    name: "local-mathjax-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const rawPath = (request.url || "").split(/[?#]/, 1)[0];
        const rawRequestPath = rawPath.replace(/^\//, "");
        if (!rawRequestPath.startsWith("mathjax/") && !rawRequestPath.startsWith("mathjax-fonts/")) return next();
        let requestPath: string;
        try {
          requestPath = decodeURIComponent(rawRequestPath);
        } catch {
          sendLocalAssetPathError(response, 400);
          return;
        }
        if (!requestPath.startsWith("mathjax/") && !requestPath.startsWith("mathjax-fonts/")) return next();
        if (isUnsafeLocalAssetPath(requestPath)) {
          sendLocalAssetPathError(response, 404);
          return;
        }
        const asset = (await localMathJaxAssetList()).find((candidate) => candidate.output === requestPath);
        if (!asset) return next();
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", localAssetContentType(asset.output));
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          response.end(await readFile(asset.absolute));
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      for (const asset of await localMathJaxAssetList()) {
        this.emitFile({ type: "asset", fileName: asset.output, source: await readFile(asset.absolute) });
      }
    },
  };
}

function releaseLicenseBundle(): Plugin {
  return {
    name: "release-license-bundle",
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "licenses/PatterDraw-LICENSE.txt",
        source: await readFile(fileURLToPath(new URL("./LICENSE", import.meta.url))),
      });
      this.emitFile({
        type: "asset",
        fileName: "licenses/THIRD_PARTY_NOTICES.md",
        source: await readFile(fileURLToPath(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url))),
      });
      for (const entry of await readdir(releaseLicenseRoot, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        this.emitFile({
          type: "asset",
          fileName: `licenses/${entry.name}`,
          source: await readFile(path.join(releaseLicenseRoot, entry.name)),
        });
      }
    },
  };
}

function offlineAppShellBundle(): Plugin {
  const pendingOutputs = new Map<string, string[]>();
  const writtenOutputs = new Set<string>();
  let projectRoot = process.cwd();
  let defaultOutputDirectory = path.resolve(projectRoot, "dist");

  const outputDirectory = (options: { dir?: string; file?: string }): string => {
    if (options.file) {
      throw new Error("offline-app-shell: a directory output is required");
    }
    return options.dir
      ? path.resolve(projectRoot, options.dir)
      : defaultOutputDirectory;
  };

  const writeOutputAtomically = async (target: string, source: string | Uint8Array): Promise<void> => {
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, source, { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    name: "offline-app-shell-bundle",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      projectRoot = config.root;
      defaultOutputDirectory = path.resolve(config.root, config.build.outDir);
      if (config.build.write === false) {
        throw new Error("offline-app-shell: build.write=false cannot produce a finalized service worker");
      }
    },
    buildStart() {
      pendingOutputs.clear();
      writtenOutputs.clear();
    },
    generateBundle: {
      order: "post",
      handler(options, bundle) {
        const directory = outputDirectory(options);
        const paths = collectOfflineAppShellPaths(bundle);
        const previous = pendingOutputs.get(directory);
        if (previous && JSON.stringify(previous) !== JSON.stringify(paths)) {
          throw new Error(`offline-app-shell: conflicting startup closures for ${directory}`);
        }
        pendingOutputs.set(directory, paths);
        this.emitFile({
          type: "asset",
          fileName: "service-worker.js",
          // `closeBundle` replaces this non-installing sentinel atomically after
          // every output hook has finished mutating the emitted files.
          source: '"use strict"; throw new Error("PatterDraw service worker was not finalized.");\n',
        });
      },
    },
    writeBundle(options) {
      writtenOutputs.add(outputDirectory(options));
    },
    closeBundle: {
      order: "post",
      async handler() {
        for (const [directory, paths] of pendingOutputs) {
          if (!writtenOutputs.has(directory)) {
            throw new Error(`offline-app-shell: output was not written: ${directory}`);
          }
          const generated = await createOfflineServiceWorkerAssetFromFiles({
            continuityPaths: await collectOfflineContinuityPathsFromFiles({
              outputDirectory: directory,
              shellPaths: paths,
            }),
            outputDirectory: directory,
            paths,
          });
          if (!generated.continuityPack || !generated.continuityPackSource) {
            throw new Error("offline-app-shell: the finalized continuity pack is missing");
          }
          await writeOutputAtomically(
            path.join(directory, generated.continuityPack.path.slice(2)),
            generated.continuityPackSource,
          );
          // Publish the worker last. A build directory can therefore never
          // expose worker metadata that points at a pack which is not present.
          await writeOutputAtomically(path.join(directory, "service-worker.js"), generated.code);
          this.info(
            `PatterDraw offline app shell ${generated.version}: ${generated.entries.length} startup files / ${generated.totalBytes} bytes; ${generated.continuityEntries.length} continuity files / ${generated.continuityBytes} unpacked bytes; ${generated.continuityPack.bytes} pack bytes; ${generated.totalBytes + generated.continuityBytes} verified-cache bytes`,
          );
        }
        pendingOutputs.clear();
        writtenOutputs.clear();
      },
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    localExcalidrawFonts(),
    localPdfjsAssets(),
    localMathJaxAssets(),
    releaseLicenseBundle(),
    offlineAppShellBundle(),
  ],
  define: {
    __PATTERDRAW_MATHJAX_SPEECH_WORKER_SHA256__: JSON.stringify(mathJaxSpeechWorkerSha256),
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  resolve: {
    alias: [
      {
        find: /^@excalidraw\/mermaid-to-excalidraw$/,
        replacement: fileURLToPath(new URL("./src/stubs/mermaid-disabled.ts", import.meta.url)),
      },
    ],
  },
  build: {
    target: "es2022",
    // Public classroom builds should not ship tens of megabytes of embedded
    // source. Opt in explicitly when producing a local diagnostic bundle.
    sourcemap: process.env.PATTERDRAW_SOURCEMAPS === "true",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    // PDF and SVG safety fixtures are deliberately CPU-heavy and share large
    // parser/rendering modules. Serial execution avoids oversubscribing a
    // classroom or CI host; the timeout still fails a genuinely stuck test.
    testTimeout: 30_000,
    pool: "threads",
    maxWorkers: 1,
    server: {
      deps: {
        inline: ["@excalidraw/excalidraw", "open-color"],
      },
    },
  },
});
