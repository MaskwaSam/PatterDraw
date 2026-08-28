#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptRoot, "..");
const sourceReleaseScript = path.join(scriptRoot, "package-release.mjs");

async function run(command, args, options = {}) {
  return execFile(command, args, { encoding: "utf8", ...options });
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the isolated fixture build to start.");
}

const fixtureParent = await mkdtemp(path.join(tmpdir(), "patterdraw-release-isolation-"));
const fixtureRoot = path.join(fixtureParent, "repo");
const readyPath = path.join(fixtureParent, "build-ready");
const allowReadPath = path.join(fixtureParent, "allow-read");
const readDonePath = path.join(fixtureParent, "read-done");
const allowFinishPath = path.join(fixtureParent, "allow-finish");
const safeSource = "committed source\n";
const safeDependency = "committed dependency\n";

try {
  await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "licenses"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "public"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "vendor", "fixture-dependency"), { recursive: true });
  await copyFile(sourceReleaseScript, path.join(fixtureRoot, "scripts", "package-release.mjs"));
  await copyFile(
    path.join(scriptRoot, "verify-geogon-vendor.mjs"),
    path.join(fixtureRoot, "scripts", "verify-geogon-vendor.mjs"),
  );
  await cp(path.join(sourceRoot, "public", "geogon"), path.join(fixtureRoot, "public", "geogon"), {
    recursive: true,
  });
  await cp(path.join(sourceRoot, "licenses"), path.join(fixtureRoot, "licenses"), {
    recursive: true,
  });
  await writeFile(path.join(fixtureRoot, ".gitignore"), "node_modules/\ndist/\n.patterdraw-dist-stage-*/\n.patterdraw-release.lock/\n");
  await writeFile(path.join(fixtureRoot, "LICENSE"), "fixture license\n");
  await writeFile(path.join(fixtureRoot, "THIRD_PARTY_NOTICES.md"), "fixture notices\n");
  await writeFile(path.join(fixtureRoot, "licenses", "Fixture-LICENSE.txt"), "fixture dependency license\n");
  await writeFile(path.join(fixtureRoot, "source.txt"), safeSource);
  await writeFile(
    path.join(fixtureRoot, "vendor", "fixture-dependency", "package.json"),
    `${JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }, null, 2)}\n`,
  );
  await writeFile(path.join(fixtureRoot, "vendor", "fixture-dependency", "value.txt"), safeDependency);
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({
      name: "patterdraw-release-isolation-fixture",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { build: "node scripts/fixture-build.mjs" },
      dependencies: { "fixture-dependency": "file:vendor/fixture-dependency" },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(fixtureRoot, "scripts", "fixture-build.mjs"),
    `import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";

async function waitForSignal(filePath) {
  while (true) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await writeFile(process.env.PATTERDRAW_ISOLATION_READY, "ready\\n");
await waitForSignal(process.env.PATTERDRAW_ISOLATION_ALLOW_READ);
const source = await readFile("source.txt", "utf8");
const dependency = await readFile("node_modules/fixture-dependency/value.txt", "utf8");
await writeFile(process.env.PATTERDRAW_ISOLATION_READ_DONE, "read\\n");
await waitForSignal(process.env.PATTERDRAW_ISOLATION_ALLOW_FINISH);
await mkdir("dist/licenses", { recursive: true });
await cp("public/geogon", "dist/geogon", { recursive: true });
await cp("licenses", "dist/licenses", { recursive: true });
await writeFile("dist/index.html", source + dependency);
await copyFile("LICENSE", "dist/licenses/PatterDraw-LICENSE.txt");
await copyFile("THIRD_PARTY_NOTICES.md", "dist/licenses/THIRD_PARTY_NOTICES.md");
`,
  );

  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fixtureRoot });
  await run("git", ["init", "--quiet"], { cwd: fixtureRoot });
  await run("git", ["config", "user.name", "PatterDraw Release Test"], { cwd: fixtureRoot });
  await run("git", ["config", "user.email", "release-test@invalid.example"], { cwd: fixtureRoot });
  await run("git", ["add", "."], { cwd: fixtureRoot });
  await run("git", ["commit", "--quiet", "-m", "Fixture"], { cwd: fixtureRoot });

  const packaging = run(
    process.execPath,
    ["scripts/package-release.mjs", "--build"],
    {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        PATTERDRAW_ISOLATION_ALLOW_FINISH: allowFinishPath,
        PATTERDRAW_ISOLATION_ALLOW_READ: allowReadPath,
        PATTERDRAW_ISOLATION_READ_DONE: readDonePath,
        PATTERDRAW_ISOLATION_READY: readyPath,
      },
    },
  );
  await waitForFile(readyPath);
  try {
    await run(process.execPath, ["scripts/package-release.mjs", "--build"], { cwd: fixtureRoot });
    throw new Error("A concurrent release command unexpectedly acquired the release lock.");
  } catch (error) {
    if (!String(error?.stderr || error?.message || error).includes("Another release package or verification is active")) {
      throw error;
    }
  }
  await writeFile(path.join(fixtureRoot, "source.txt"), "transient uncommitted source\n");
  const installedDependency = path.join(fixtureRoot, "node_modules", "fixture-dependency", "value.txt");
  await writeFile(installedDependency, "transient dependency bytes\n");
  await writeFile(allowReadPath, "read now\n");
  await waitForFile(readDonePath);
  await writeFile(path.join(fixtureRoot, "source.txt"), safeSource);
  await writeFile(installedDependency, safeDependency);
  await writeFile(allowFinishPath, "finish now\n");
  await packaging;

  const packagedSource = await readFile(path.join(fixtureRoot, "dist", "release", "index.html"), "utf8");
  if (packagedSource !== safeSource + safeDependency) {
    throw new Error("Final release included transient source or dependency bytes instead of the committed snapshot.");
  }
  const provenance = JSON.parse(
    await readFile(path.join(fixtureRoot, "dist", "release", "provenance.json"), "utf8"),
  );
  if (provenance.releaseMode !== "final" || provenance.source?.dirty !== false) {
    throw new Error("Fixture release did not retain final clean provenance.");
  }
  console.log("Immutable release source isolation check passed.");
} finally {
  await rm(fixtureParent, { force: true, recursive: true });
}
