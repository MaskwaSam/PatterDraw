import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const excalidrawFontRoot = fileURLToPath(new URL(
  "./node_modules/@excalidraw/excalidraw/dist/prod/fonts/",
  import.meta.url,
));
const mathJaxRoot = fileURLToPath(new URL("./node_modules/mathjax/", import.meta.url));
const mathJaxFontRoot = fileURLToPath(new URL(
  "./node_modules/@mathjax/mathjax-newcm-font/",
  import.meta.url,
));

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

function localExcalidrawFonts(): Plugin {
  return {
    name: "local-excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const prefix = "/excalidraw-assets/fonts/";
        if (!request.url?.startsWith(prefix)) return next();
        const relative = decodeURIComponent(request.url.slice(prefix.length).split(/[?#]/, 1)[0]);
        if (!relative || relative.split("/").some((part) => part === "." || part === "..")) return next();
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

interface LocalAsset {
  absolute: string;
  output: string;
}

async function localMathJaxAssetList(): Promise<LocalAsset[]> {
  const dynamicFontNames = (await readdir(path.join(mathJaxFontRoot, "svg/dynamic")))
    .filter((name) => name.endsWith(".js"));
  return [
    { absolute: path.join(mathJaxRoot, "tex-svg.js"), output: "mathjax/tex-svg.js" },
    { absolute: path.join(mathJaxRoot, "ui/safe.js"), output: "mathjax/ui/safe.js" },
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
        const requestPath = decodeURIComponent((request.url || "").split(/[?#]/, 1)[0]).replace(/^\//, "");
        if (!requestPath.startsWith("mathjax/") && !requestPath.startsWith("mathjax-fonts/")) return next();
        const asset = (await localMathJaxAssetList()).find((candidate) => candidate.output === requestPath);
        if (!asset) return next();
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
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

export default defineConfig({
  base: "./",
  plugins: [react(), localExcalidrawFonts(), localMathJaxAssets()],
  define: {
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
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    pool: "threads",
    maxWorkers: 2,
    server: {
      deps: {
        inline: ["@excalidraw/excalidraw", "open-color"],
      },
    },
  },
});
