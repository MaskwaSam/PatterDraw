#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertLocalReleaseReadiness,
  FINAL_NODE_VERSION_PATTERN,
  FINAL_NPM_VERSION,
} from "./release-readiness.mjs";

const execFile = promisify(execFileCallback);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptRoot, "..");
const defaultDist = path.join(repoRoot, "dist");
const defaultOutput = path.join(defaultDist, "release");
const releaseLockPath = path.join(repoRoot, ".patterdraw-release.lock");
const metadataFiles = ["release-manifest.json", "provenance.json", "sbom.cdx.json"];
const checksumFile = "SHA256SUMS";
// This is the reviewed top-level Vite output contract from vite.config.ts.
// A deliberate new root asset must be added here so a stale/custom packaging
// directory cannot silently become part of a release payload.
const allowedBuildTopLevelEntries = new Set([
  "assets",
  "excalidraw-assets",
  "geogon",
  "index.html",
  "licenses",
  "mathjax",
  "mathjax-fonts",
  "pdfjs",
  "service-worker.js",
]);
const manifestSchema = "patterdraw.release-manifest.v1";
const provenanceSchema = "patterdraw.provenance.v1";
const sbomSchema = "CycloneDX";
const geoGonVendor = Object.freeze({
  license: "GPL-3.0-or-later",
  repository: "https://github.com/MaskwaSam/3dgeogon",
  sourceCommit: "386e47223740ed9955ae1fe8a022516fea98d57f",
  version: "0.2.10",
  upstreamFiles: new Map([
    ["BRAND_ASSETS.md", "1c403191332c508363a82f5a5858d29d8b45710b79eecaadf2eb26fc125dd656"],
    ["EMBEDDING.md", "53badbb03f5bde036d05277c5950b529d3271a98f4f36a5ee59ca661e6d7248e"],
    ["LICENSE", "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"],
    ["THIRD_PARTY_NOTICES.md", "e26ee46b967bfb0629682243b29c63724c5eb0227ef84f801961b5c82f86365c"],
    ["app.js", "eb8a45fa27aa5434bc9ce351bf60d3b1d553196fb71f4d221d816aa68a286178"],
    ["build/three-0.185.1/LICENSE", "8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc"],
    ["build/three-0.185.1/controls/OrbitControls.js", "faabb4e8dfd9235ee4a9fd7c9a3d75f90f1689dbd4944bd6fd32117dacec5f93"],
    ["build/three-0.185.1/lines/Line2.js", "69dd2120d4df14208796acf199f80a64d37e042cfa65dc2b98286694b2954194"],
    ["build/three-0.185.1/lines/LineGeometry.js", "b7ec6b0011e3b09dc72e17cfd8e8945295cb2bc8c8aa9aa19e47119680bdad7e"],
    ["build/three-0.185.1/lines/LineMaterial.js", "d4517001f9d7b3e885ea5baa930de0077351e885db52ef4565cde4c7dd17eb23"],
    ["build/three-0.185.1/lines/LineSegments2.js", "fcbc20f576e88343cea12131f49b7003d7ab44ede422fcb694e567456022f7a0"],
    ["build/three-0.185.1/lines/LineSegmentsGeometry.js", "471f0a954a0c9c59d3d151392f424142a9164a722802f63b371971378a84a1b1"],
    ["build/three-0.185.1/readme_moodle.txt", "f8c92d204271bd62af323fe9206629296978e1e743e83fd5c6c195bd799ccbc7"],
    ["build/three-0.185.1/three.core.js", "3718df126d69c125362a03340913204470d8c50238605150e57f808840fb7759"],
    ["build/three-0.185.1/three.module.js", "bbf5ed13fe4373f5bd38b14ea8e62e9f157327da5638edc6d3863e08b167c9c7"],
    ["build/three-0.185.1/vendor-manifest.json", "e10f319c847495c7caf861db252ddb85254ccb81c28dc3cb47d35730f68a966e"],
    ["geometry/composite-topology.js", "1801b6213e3a42342ec078bfeb4674e51ca2dc792278a3a2b125ee4684a4fe04"],
    ["geometry/curved-net-layout.js", "6589af2c942a7b622c51c5318e3b6f2bb10a8a04c97bd981a18594b311193a85"],
    ["geometry/curved-orthographic.js", "72039ca33eff4a69d9051c0dd8c8e0f9624f541783a24280d200ae836ca9608e"],
    ["geometry/net-layout.js", "0cd24a686c11eb9ca28eac2dd009e0890bf78475544b62298c506f19dd0c4354"],
    ["geometry/orthographic-views.js", "09d2439bd51ca08074c4a2f87ec81edb08e6c8ed3ae64d02ae1aaf01d12d3ecc"],
    ["geometry/solid-topology.js", "e08263cb08d5c70ba5e3e9a88ed4c0adada59fe03a1b92b6f7ca02b3c1de8132"],
    ["images/3DGeoGon-icon.svg", "4b4f4b0619d35ca2a2f33bad31f11b00adab26f56106da3b9c73875fd8421254"],
    ["images/3DGeoGon-logo.svg", "f9fa5922eef9ab852f1bd2ab0ce952528f2360c718f1205be548e88586c1bdee"],
    ["images/screenshot.png", "a84725dfc25d90d9c56767aeed5344afdffdddd05930af39ad165050fb73f245"],
    ["index.html", "921efd4a3bef2101f9a12bb9d517dbc58f34e013eeee4e51ddaf9fe121250f79"],
    ["manifest.json", "bffdf4920726278bafa4d5e80926d91f866533fd91bf4cde41c8222eb41804d9"],
    ["style.css", "8c78695c860953a7c75927517aec89995c080174a2adc472d82d85fb6336d50c"],
  ]),
});
const geoGonIntegrationFiles = new Map([
  ["PATTERDRAW_VENDOR.md", "14afd52a71a97b6158c44e1cb510f54365b2da6cd8a4a1024e906aa90ad9f92a"],
]);
const threeVendor = Object.freeze({
  integrity: "sha512-5aojFCXKwnjBRZvUnt3WFfEcvUJgkN5LlijRFN95hMy8WVkG4I0QNcJE+OuWvuJ0bOdStrbfXn0pkd6/QyiAlg==",
  license: "MIT",
  source: "https://registry.npmjs.org/three/-/three-0.185.1.tgz",
  version: "0.185.1",
});
const geoGonBomRef = `vendor:3dgeogon@${geoGonVendor.version}#${geoGonVendor.sourceCommit}`;
const threeBomRef = `vendor:3dgeogon/three@${threeVendor.version}`;

function usage() {
  return `Usage:
  node scripts/package-release.mjs [--build] [--allow-dirty] [development overrides] [--dist <directory>] [--out <directory>]
  node scripts/package-release.mjs --verify [--allow-dirty] [development overrides] [--out <release-directory>]

The default output is dist/release/. Packaging requires a clean git worktree unless
--allow-dirty is supplied. SOURCE_DATE_EPOCH may be set to a commit-compatible
Unix timestamp; otherwise the HEAD commit timestamp is used. Packaging output
must be a top-level release or release-* directory inside the build directory.
--build performs a fresh empty-output Vite build first and is required by the
supported npm release:package workflow. Clean final builds use an immutable archive
of HEAD so provenance cannot describe stale or concurrently modified source bytes.

Final packaging additionally requires Node 22.13.x, npm 11.12.1, and HEAD to
exactly equal both the local refs/remotes/origin/main tracking ref and a fresh
read-only lookup of origin refs/heads/main. The local-only
preparation flags --allow-unpushed-development and
--allow-toolchain-mismatch-development always produce a development artifact
and must never be used for deployment. Development verification requires the
exact same preparation flags recorded during packaging; no development flag
can be used to verify a final artifact.
`;
}

function fail(message) {
  throw new Error(message);
}

async function acquireReleaseLock() {
  try {
    await mkdir(releaseLockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(`Another release package or verification is active (${releaseLockPath}). If a prior process crashed, remove this lock only after confirming no release command is running.`);
    }
    throw error;
  }
  try {
    await writeFile(
      path.join(releaseLockPath, "owner.json"),
      jsonBytes({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(releaseLockPath, { force: true, recursive: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(releaseLockPath, { force: true, recursive: true });
  };
}

function normalizedRelativePath(value) {
  return value.split(path.sep).join("/");
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseArguments(argv) {
  const options = {
    allowDirty: false,
    allowToolchainMismatchDevelopment: false,
    allowUnpushedDevelopment: false,
    build: false,
    dist: defaultDist,
    help: false,
    out: defaultOutput,
    verify: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-dirty" || argument === "--development") {
      options.allowDirty = true;
    } else if (argument === "--allow-toolchain-mismatch-development") {
      options.allowToolchainMismatchDevelopment = true;
    } else if (argument === "--allow-unpushed-development") {
      options.allowUnpushedDevelopment = true;
    } else if (argument === "--build") {
      options.build = true;
    } else if (argument === "--verify") {
      options.verify = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--dist") {
      options.dist = path.resolve(repoRoot, argv[++index] || fail("--dist requires a directory."));
    } else if (argument === "--out" || argument === "--output") {
      options.out = path.resolve(repoRoot, argv[++index] || fail(`${argument} requires a directory.`));
    } else {
      fail(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  return options;
}

function isDevelopmentRelease(options) {
  return options.allowDirty
    || options.allowToolchainMismatchDevelopment
    || options.allowUnpushedDevelopment;
}

function developmentOverrideArguments(options) {
  return [
    ...(options.allowDirty ? ["--allow-dirty"] : []),
    ...(options.allowUnpushedDevelopment ? ["--allow-unpushed-development"] : []),
    ...(options.allowToolchainMismatchDevelopment
      ? ["--allow-toolchain-mismatch-development"]
      : []),
  ];
}

function readinessOptions(options) {
  return {
    allowDirtyDevelopment: options.allowDirty,
    allowToolchainMismatchDevelopment: options.allowToolchainMismatchDevelopment,
    allowUnpushedDevelopment: options.allowUnpushedDevelopment,
    cwd: repoRoot,
  };
}

async function assertReleaseReadinessUnchanged(options, expected, phase) {
  const actual = await assertLocalReleaseReadiness(readinessOptions(options));
  for (const key of [
    "head",
    "nodeVersion",
    "npmVersion",
    "originMain",
    "remoteMain",
    "sourceDirty",
    "developmentOnly",
  ]) {
    if (actual[key] !== expected[key]) {
      fail(`Release readiness changed during ${phase} (${key}).`);
    }
  }
  return actual;
}

async function command(commandName, args, { allowFailure = false, cwd = repoRoot } = {}) {
  try {
    const { stdout } = await execFile(commandName, args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = error?.stderr?.trim() || error?.message || String(error);
    fail(`${commandName} ${args.join(" ")} failed: ${detail}`);
  }
}

async function gitMetadata({ cwd = repoRoot } = {}) {
  const commit = await command("git", ["rev-parse", "HEAD"], { cwd });
  if (!/^[0-9a-f]{40}$/i.test(commit)) fail("Unable to resolve a full git HEAD commit.");
  const commitEpochText = await command("git", ["show", "-s", "--format=%ct", commit], { cwd });
  const commitEpoch = Number(commitEpochText);
  if (!Number.isSafeInteger(commitEpoch) || commitEpoch < 0) fail(`Invalid HEAD commit timestamp: ${commitEpochText}`);
  const status = await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  return {
    commit,
    commitShort: commit.slice(0, 12),
    commitEpoch,
    dirty: status.length > 0,
    statusSha256: sha256(Buffer.from(status, "utf8")),
  };
}

function sourceDateEpoch(commitEpoch) {
  const raw = process.env.SOURCE_DATE_EPOCH ?? String(commitEpoch);
  if (!/^\d+$/.test(raw)) fail(`SOURCE_DATE_EPOCH must be a non-negative integer (received ${raw}).`);
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch)) fail(`SOURCE_DATE_EPOCH is outside the safe integer range: ${raw}`);
  return epoch;
}

async function npmVersion({ cwd = repoRoot } = {}) {
  const version = await command("npm", ["--version"], { allowFailure: true, cwd });
  return version || "unavailable";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inventorySha256(files) {
  const lines = [...files]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([relative, hash]) => `${hash}  ${relative}`);
  return sha256(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}

function geoGonVendorVerificationMetadata() {
  const threeFiles = new Map([...geoGonVendor.upstreamFiles]
    .filter(([relative]) => relative.startsWith("build/three-0.185.1/"))
    .map(([relative, hash]) => [relative.slice("build/three-0.185.1/".length), hash]));
  const packagedFiles = new Map([
    ...geoGonVendor.upstreamFiles,
    ...geoGonIntegrationFiles,
  ]);
  return {
    component: "3DGeoGon",
    inventorySha256: inventorySha256(geoGonVendor.upstreamFiles),
    license: geoGonVendor.license,
    packagedFileCount: packagedFiles.size,
    packagedInventorySha256: inventorySha256(packagedFiles),
    sourceCommit: geoGonVendor.sourceCommit,
    sourceRepository: geoGonVendor.repository,
    upstreamFileCount: geoGonVendor.upstreamFiles.size,
    version: geoGonVendor.version,
    bundledThree: {
      component: "Three.js",
      inventorySha256: inventorySha256(threeFiles),
      license: threeVendor.license,
      source: threeVendor.source,
      sourceIntegrity: threeVendor.integrity,
      upstreamFileCount: threeFiles.size,
      version: threeVendor.version,
    },
  };
}

async function verifyPackagedGeoGon(root, files) {
  const expected = new Map([...geoGonVendor.upstreamFiles]
    .map(([relative, hash]) => [`geogon/${relative}`, hash]));
  const expectedIntegration = new Map([...geoGonIntegrationFiles]
    .map(([relative, hash]) => [`geogon/${relative}`, hash]));
  const geogonFiles = files.filter(({ relative }) => relative.startsWith("geogon/"));
  const actual = new Map(geogonFiles.map((file) => [file.relative, file]));
  const unexpected = geogonFiles
    .filter(({ relative }) => !expected.has(relative) && !expectedIntegration.has(relative))
    .map(({ relative }) => relative);
  if (unexpected.length > 0) fail(`Packaged GeoGon contains unexpected files: ${unexpected.join(", ")}`);
  for (const [relative, expectedHash] of expected) {
    const file = actual.get(relative);
    if (!file) fail(`Packaged GeoGon file is missing: ${relative}`);
    if (file.sha256 !== expectedHash) fail(`Packaged GeoGon file differs from pinned upstream bytes: ${relative}`);
  }
  for (const [relative, expectedHash] of expectedIntegration) {
    const file = actual.get(relative);
    if (!file) fail(`Packaged GeoGon integration file is missing: ${relative}`);
    if (file.sha256 !== expectedHash) fail(`Packaged GeoGon integration file differs from reviewed bytes: ${relative}`);
  }
  for (const [relative, expectedHash] of [
    ["licenses/3dgeogon-GPL-3.0-or-later.txt", geoGonVendor.upstreamFiles.get("LICENSE")],
    ["licenses/three-LICENSE.txt", geoGonVendor.upstreamFiles.get("build/three-0.185.1/LICENSE")],
  ]) {
    const file = files.find((candidate) => candidate.relative === relative);
    if (!file || file.sha256 !== expectedHash) fail(`Packaged vendor license differs from pinned upstream bytes: ${relative}`);
  }

  const vendorRecord = await readFile(path.join(root, "geogon/PATTERDRAW_VENDOR.md"), "utf8");
  for (const required of [
    geoGonVendor.repository,
    geoGonVendor.sourceCommit,
    geoGonVendor.version,
    geoGonVendor.license,
    `Three.js version: \`${threeVendor.version}\``,
  ]) {
    if (!vendorRecord.includes(required)) fail(`Packaged GeoGon vendor record is missing pinned provenance: ${required}`);
  }
  return geoGonVendorVerificationMetadata();
}

async function ensureDirectory(directory, description) {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${description} must be a real directory: ${directory}`);
}

async function walkFiles(root, { excludePrefix = "" } = {}) {
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (excludePrefix && (relative === excludePrefix || relative.startsWith(`${excludePrefix}/`))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Symlinks are not allowed in a release tree: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ bytes: bytes.length, relative, sha256: sha256(bytes), source: absolute });
      } else {
        fail(`Unsupported filesystem entry in release tree: ${relative}`);
      }
    }
  }
  await visit(root);
  files.sort((a, b) => compareStrings(a.relative, b.relative));
  return files;
}

async function copyPayload(outputRoot, files) {
  for (const file of files) {
    const target = path.join(outputRoot, file.relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.source, target);
  }
}

async function setDeterministicTimes(root, epoch) {
  const timestamp = new Date(epoch * 1000);
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Symlinks are not allowed in a release tree: ${entry.name}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (!entry.isFile()) fail(`Unsupported filesystem entry in release tree: ${entry.name}`);
      if (entry.isDirectory()) await chmod(absolute, 0o755);
      else await chmod(absolute, 0o644);
      await utimes(absolute, timestamp, timestamp);
    }
    await chmod(directory, 0o755);
    await utimes(directory, timestamp, timestamp);
  }
  await visit(root);
}

async function verifyDeterministicMetadata(root, epoch) {
  const expectedMtime = epoch * 1000;
  const toleranceMs = 1000;
  async function visit(directory) {
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) fail(`Release directory contains an invalid directory: ${directory}`);
    if ((directoryStats.mode & 0o777) !== 0o755) fail(`Release directory mode is not 0755: ${path.relative(root, directory) || "."}`);
    if (Math.abs(directoryStats.mtimeMs - expectedMtime) > toleranceMs) fail(`Release directory mtime is not deterministic: ${path.relative(root, directory) || "."}`);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Symlinks are not allowed in a release tree: ${path.relative(root, absolute)}`);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) fail(`Unsupported filesystem entry in release tree: ${path.relative(root, absolute)}`);
      const stats = await lstat(absolute);
      if ((stats.mode & 0o777) !== 0o644) fail(`Release file mode is not 0644: ${path.relative(root, absolute)}`);
      if (Math.abs(stats.mtimeMs - expectedMtime) > toleranceMs) fail(`Release file mtime is not deterministic: ${path.relative(root, absolute)}`);
    }
  }
  await visit(root);
}

async function removeExistingOutput(outputRoot) {
  let stats;
  try {
    stats = await lstat(outputRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) fail(`Refusing to replace a symlink output directory: ${outputRoot}`);
  if (!stats.isDirectory()) fail(`Release output exists but is not a directory: ${outputRoot}`);
  await rm(outputRoot, { recursive: true, force: true });
}

async function validateOutputPath(distRoot, outputRoot) {
  const realDistRoot = await realpath(distRoot);
  const distStats = await lstat(distRoot);
  if (!distStats.isDirectory() || distStats.isSymbolicLink()) fail("Build directory must be a real directory, not a symlink.");
  const relative = path.relative(distRoot, outputRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Release output must be a child of the build directory.");
  let current = distRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stats.isSymbolicLink()) fail(`Release output path contains a symlink: ${current}`);
    if (!stats.isDirectory() && current !== outputRoot) fail(`Release output parent is not a directory: ${current}`);
  }
  let existingParent = outputRoot;
  while (true) {
    try {
      await lstat(existingParent);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existingParent);
      if (parent === existingParent) fail("Unable to resolve the release output parent.");
      existingParent = parent;
    }
  }
  const realParent = await realpath(existingParent);
  if (!isWithin(realDistRoot, realParent)) fail("Release output parent resolves outside the build directory.");
  let outputStats;
  try {
    outputStats = await lstat(outputRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (outputStats?.isSymbolicLink()) fail(`Refusing a symlink release output: ${outputRoot}`);
  if (outputStats) {
    const realOutput = await realpath(outputRoot);
    if (!isWithin(realDistRoot, realOutput)) fail("Release output resolves outside the build directory.");
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath, description) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to read ${description} (${filePath}): ${error?.message || error}`);
  }
  return parsed;
}

function packageNameFromLockPath(lockPath, entry) {
  if (entry.name) return entry.name;
  const marker = lockPath.lastIndexOf("node_modules/");
  return marker >= 0 ? lockPath.slice(marker + "node_modules/".length) : lockPath;
}

function purlName(packageName) {
  if (packageName.startsWith("@")) {
    const slash = packageName.indexOf("/");
    if (slash > 1) return `${encodeURIComponent(packageName.slice(0, slash))}/${encodeURIComponent(packageName.slice(slash + 1))}`;
  }
  return encodeURIComponent(packageName);
}

function dependencyLicense(expression) {
  if (typeof expression !== "string" || expression.length === 0) return undefined;
  const trimmed = expression.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(trimmed)) return { license: { id: trimmed } };
  return { expression: trimmed.replace(/^\((.*)\)$/, "$1") };
}

function buildVendoredSbomComponents() {
  const verification = geoGonVendorVerificationMetadata();
  return [
    {
      "bom-ref": geoGonBomRef,
      name: "3DGeoGon",
      type: "application",
      version: geoGonVendor.version,
      purl: `pkg:github/MaskwaSam/3dgeogon@${geoGonVendor.sourceCommit}`,
      licenses: [{ license: { id: geoGonVendor.license } }],
      externalReferences: [
        { type: "vcs", url: `${geoGonVendor.repository}/tree/${geoGonVendor.sourceCommit}` },
        { type: "license", url: `${geoGonVendor.repository}/blob/${geoGonVendor.sourceCommit}/LICENSE` },
      ],
      properties: [
        { name: "patterdraw:dependencyType", value: "bundled-subapplication" },
        { name: "patterdraw:vendorPath", value: "geogon/" },
        { name: "patterdraw:sourceRepository", value: geoGonVendor.repository },
        { name: "patterdraw:sourceCommit", value: geoGonVendor.sourceCommit },
        { name: "patterdraw:inventorySha256", value: verification.inventorySha256 },
        { name: "patterdraw:packagedInventorySha256", value: verification.packagedInventorySha256 },
        { name: "patterdraw:hashScope", value: `sorted SHA-256 inventory of ${verification.upstreamFileCount} pinned upstream files` },
      ],
    },
    {
      "bom-ref": threeBomRef,
      name: "three",
      type: "library",
      version: threeVendor.version,
      purl: `pkg:npm/three@${threeVendor.version}`,
      licenses: [{ license: { id: threeVendor.license } }],
      externalReferences: [{ type: "distribution", url: threeVendor.source }],
      properties: [
        { name: "patterdraw:dependencyType", value: "bundled-transitive" },
        { name: "patterdraw:vendorPath", value: `geogon/build/three-${threeVendor.version}/` },
        { name: "patterdraw:resolved", value: threeVendor.source },
        { name: "patterdraw:integrity", value: threeVendor.integrity },
        { name: "patterdraw:inventorySha256", value: verification.bundledThree.inventorySha256 },
        { name: "patterdraw:hashScope", value: `sorted SHA-256 inventory of ${verification.bundledThree.upstreamFileCount} bundled files` },
      ],
    },
  ];
}

function buildVendoredSbomDependencies() {
  return [
    { ref: geoGonBomRef, dependsOn: [threeBomRef] },
    { ref: threeBomRef, dependsOn: [] },
  ];
}

function buildSbom({ lockfile, lockHash, packageInfo, source, toolchain }) {
  const rootPackage = lockfile.packages?.[""] || {};
  const directDependencies = new Map();
  for (const [name, version] of Object.entries(rootPackage.dependencies || {})) {
    directDependencies.set(name, "runtime");
  }
  for (const name of Object.keys(rootPackage.devDependencies || {})) {
    directDependencies.set(name, "development");
  }
  const components = [];
  for (const [lockPath, rawEntry] of Object.entries(lockfile.packages || {})) {
    if (!lockPath.startsWith("node_modules/")) continue;
    const entry = rawEntry.link ? lockfile.packages[rawEntry.resolved] : rawEntry;
    if (!entry || !entry.version) fail(`Lockfile package is missing a version: ${lockPath}`);
    const packageName = packageNameFromLockPath(lockPath, entry);
    const version = String(entry.version);
    const purl = `pkg:npm/${purlName(packageName)}@${encodeURIComponent(version)}`;
    const component = {
      "bom-ref": `lock:${lockPath}@${version}`,
      name: packageName.startsWith("@") ? packageName.slice(packageName.indexOf("/") + 1) : packageName,
      purl,
      type: "library",
      version,
      properties: [
        { name: "patterdraw:lockfilePath", value: lockPath },
        { name: "patterdraw:dependencyType", value: directDependencies.get(packageName) || "transitive" },
      ],
    };
    if (packageName.startsWith("@")) component.group = packageName.slice(0, packageName.indexOf("/"));
    const license = dependencyLicense(entry.license);
    if (license) component.licenses = [license];
    if (entry.resolved) component.properties.push({ name: "patterdraw:resolved", value: String(entry.resolved) });
    if (entry.integrity) component.properties.push({ name: "patterdraw:integrity", value: String(entry.integrity) });
    components.push(component);
  }
  components.push(...buildVendoredSbomComponents());
  components.sort((a, b) => compareStrings(a["bom-ref"], b["bom-ref"]));
  return {
    bomFormat: sbomSchema,
    metadata: {
      component: { name: packageInfo.name, type: "application", version: packageInfo.version },
      properties: [
        { name: "patterdraw:lockfileSha256", value: lockHash },
        { name: "patterdraw:sourceCommit", value: source.commit },
        { name: "patterdraw:sourceDirty", value: String(source.dirty) },
        { name: "patterdraw:sourceDateEpoch", value: String(source.sourceDateEpoch) },
        { name: "patterdraw:node", value: toolchain.node },
        { name: "patterdraw:npm", value: toolchain.npm },
      ],
      timestamp: source.timestamp,
      tools: [{ vendor: "PatterDraw", name: "package-release.mjs", version: "1" }],
    },
    specVersion: "1.5",
    version: 1,
    components,
    dependencies: buildVendoredSbomDependencies(),
  };
}

async function licenseVerification({ distRoot, sourceRoot }) {
  const sourceLicenseRoot = path.join(sourceRoot, "licenses");
  const expected = [
    { source: path.join(sourceRoot, "LICENSE"), target: "licenses/PatterDraw-LICENSE.txt" },
    { source: path.join(sourceRoot, "THIRD_PARTY_NOTICES.md"), target: "licenses/THIRD_PARTY_NOTICES.md" },
  ];
  for (const entry of await readdir(sourceLicenseRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    expected.push({ source: path.join(sourceLicenseRoot, entry.name), target: `licenses/${entry.name}` });
  }
  expected.sort((a, b) => compareStrings(a.target, b.target));
  const verified = [];
  const missing = [];
  for (const entry of expected) {
    const sourceBytes = await readFile(entry.source);
    const targetPath = path.join(distRoot, entry.target);
    try {
      const targetBytes = await readFile(targetPath);
      if (!targetBytes.equals(sourceBytes)) {
        fail(`Bundled license differs from source: ${entry.target}`);
      }
      verified.push({ bytes: targetBytes.length, path: entry.target, sha256: sha256(targetBytes) });
    } catch (error) {
      if (error?.code === "ENOENT") missing.push(entry.target);
      else throw error;
    }
  }
  if (missing.length > 0) fail(`Required license files are missing from dist/licenses: ${missing.join(", ")}`);
  return {
    expectedCount: expected.length,
    passed: verified.length === expected.length,
    files: verified,
  };
}

function checksumLines(files) {
  return `${files
    .slice()
    .sort((a, b) => compareStrings(a.path, b.path))
    .map((file) => `${file.sha256}  ${file.path}`)
    .join("\n")}\n`;
}

async function toolchainMetadata(packageInfo, lockfile, buildCommand, { commandRoot = repoRoot } = {}) {
  const lockedVersion = (name) => lockfile.packages?.[`node_modules/${name}`]?.version || "unavailable";
  return {
    node: process.version,
    npm: await npmVersion({ cwd: commandRoot }),
    packageManager: packageInfo.packageManager || "npm",
    typescript: lockedVersion("typescript"),
    vite: lockedVersion("vite"),
    buildCommand,
    sourceMaps: "forbidden",
  };
}

async function packageRelease(
  options,
  {
    buildCommand = options.build ? "npm run build -- --emptyOutDir" : "prebuilt dist (development only)",
    commandRoot = repoRoot,
    displayOutputRoot = options.out,
    sourceMetadata,
    sourceRoot = repoRoot,
  } = {},
) {
  const { dist: distRoot, out: outputRoot } = options;
  if (!options.build && !isDevelopmentRelease(options)) {
    fail("Final release packaging requires --build so the payload is rebuilt from the recorded source. Use --allow-dirty only for an explicitly prebuilt development artifact.");
  }
  await ensureDirectory(distRoot, "Build directory");
  if (!isWithin(distRoot, outputRoot)) fail("--out must be inside the build directory (use an ignored directory such as dist/release).");
  const outputRelativeToDist = normalizedRelativePath(path.relative(distRoot, outputRoot));
  if (!/^release(?:[-_][A-Za-z0-9._-]+)?$/.test(outputRelativeToDist)) {
    fail("--out must be a top-level release or release-* directory inside the build directory.");
  }
  if (outputRoot === distRoot) fail("--out must not be the build directory itself.");
  if (outputRoot === repoRoot) fail("--out must not be the repository root.");
  if (isWithin(outputRoot, distRoot)) fail("--out must not contain the build directory.");
  await validateOutputPath(distRoot, outputRoot);
  const source = sourceMetadata ? { ...sourceMetadata } : await gitMetadata({ cwd: sourceRoot });
  if (source.dirty && !options.allowDirty) {
    fail("Refusing final release packaging from a dirty worktree. Commit all source changes first, or pass --allow-dirty for a development artifact.");
  }
  source.sourceDateEpoch = sourceDateEpoch(source.commitEpoch);
  source.timestamp = new Date(source.sourceDateEpoch * 1000).toISOString();

  const packageInfo = await readJson(path.join(sourceRoot, "package.json"), "package.json");
  const lockfileBytes = await readFile(path.join(sourceRoot, "package-lock.json"));
  const lockfile = JSON.parse(lockfileBytes.toString("utf8"));
  const lockHash = sha256(lockfileBytes);
  if (lockfile.lockfileVersion !== 3) fail(`Expected npm lockfileVersion 3, received ${lockfile.lockfileVersion}.`);
  if (lockfile.name !== packageInfo.name || lockfile.version !== packageInfo.version) {
    fail("package.json and package-lock.json root metadata do not match.");
  }
  const toolchain = await toolchainMetadata(
    packageInfo,
    lockfile,
    buildCommand,
    { commandRoot },
  );

  const outputInsideDist = isWithin(distRoot, outputRoot);
  if (outputInsideDist && outputRelativeToDist === "") fail("--out must not be the build directory itself.");
  const payload = await walkFiles(distRoot, { excludePrefix: outputInsideDist ? normalizedRelativePath(outputRelativeToDist) : "" });
  if (payload.length === 0) fail("Build directory is empty; run npm run build before packaging.");
  if (!payload.some((file) => file.relative === "index.html")) fail("Build directory is missing index.html.");
  const unexpectedTopLevel = payload.find((file) => (
    !allowedBuildTopLevelEntries.has(file.relative.split("/", 1)[0])
  ));
  if (unexpectedTopLevel) {
    fail(`Build directory contains an unexpected top-level entry: ${unexpectedTopLevel.relative}`);
  }
  const staleReleaseEntries = payload.filter((file) => {
    const topLevel = file.relative.split("/", 1)[0];
    const basename = path.posix.basename(file.relative);
    return /^release(?:[-_].*)?$/.test(topLevel)
      || metadataFiles.includes(basename)
      || basename === checksumFile;
  });
  if (staleReleaseEntries.length > 0) {
    fail(`Build directory contains stale release artifacts; remove generated release directories before packaging (for example: ${staleReleaseEntries[0].relative}).`);
  }
  const sourceMaps = payload.filter((file) => file.relative.toLowerCase().endsWith(".map"));
  if (sourceMaps.length > 0) fail(`Source maps are not publishable release files: ${sourceMaps.map((file) => file.relative).join(", ")}`);
  const vendoredComponents = await verifyPackagedGeoGon(distRoot, payload);
  const licenses = await licenseVerification({ distRoot, sourceRoot });
  const releaseMode = isDevelopmentRelease(options) ? "development" : "final";
  const recordedDevelopmentOverrides = developmentOverrideArguments(options);

  await removeExistingOutput(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  await copyPayload(outputRoot, payload);

  const payloadManifest = payload.map(({ bytes, relative, sha256: hash }) => ({ bytes, path: relative, sha256: hash }));
  const totalBytes = payload.reduce((total, file) => total + file.bytes, 0);
  // Keep artifact identity stable when an otherwise identical build tree is
  // packaged outside the repository (for example in a release worker's temp
  // directory). The deployable root is relative to the selected build root,
  // not to the caller's machine-specific repository path.
  const artifactPath = normalizedRelativePath(path.relative(distRoot, outputRoot));
  const artifactDisplayPath = normalizedRelativePath(path.relative(repoRoot, displayOutputRoot));
  const provenance = {
    schemaVersion: provenanceSchema,
    releaseMode,
    developmentOverrides: recordedDevelopmentOverrides,
    source: {
      commit: source.commit,
      commitShort: source.commitShort,
      dirty: source.dirty,
      sourceDateEpoch: source.sourceDateEpoch,
      timestamp: source.timestamp,
    },
    toolchain,
    package: { name: packageInfo.name, version: packageInfo.version },
    lockfile: { file: "package-lock.json", lockfileVersion: lockfile.lockfileVersion, sha256: lockHash },
    vendoredComponents,
    artifact: { kind: "directory", path: artifactPath, payloadFileCount: payload.length, payloadBytes: totalBytes },
  };
  const sbom = buildSbom({ lockfile, lockHash, packageInfo, source, toolchain });
  const manifest = {
    schemaVersion: manifestSchema,
    releaseMode,
    developmentOverrides: recordedDevelopmentOverrides,
    gitCommit: source.commit,
    sourceDirty: source.dirty,
    toolVersions: toolchain,
    fileCount: payload.length,
    artifact: {
      kind: "directory",
      path: artifactPath,
      mtimeSourceDateEpoch: source.sourceDateEpoch,
      payloadFileCount: payload.length,
      payloadBytes: totalBytes,
      metadataFiles: [...metadataFiles, checksumFile],
      totalFileCount: payload.length + metadataFiles.length + 1,
    },
    checksums: {
      file: checksumFile,
      algorithm: "sha256",
      covers: [...payloadManifest.map((file) => file.path), ...metadataFiles].sort(compareStrings),
    },
    dependencies: {
      sbom: "sbom.cdx.json",
      componentCount: sbom.components.length,
      lockfileSha256: lockHash,
      vendoredComponents,
    },
    licenses,
    package: { name: packageInfo.name, version: packageInfo.version },
    source: {
      commit: source.commit,
      commitShort: source.commitShort,
      dirty: source.dirty,
      sourceDateEpoch: source.sourceDateEpoch,
      timestamp: source.timestamp,
    },
    toolchain,
    files: payloadManifest,
  };
  await writeFile(path.join(outputRoot, "provenance.json"), jsonBytes(provenance));
  await writeFile(path.join(outputRoot, "sbom.cdx.json"), jsonBytes(sbom));
  await writeFile(path.join(outputRoot, "release-manifest.json"), jsonBytes(manifest));
  const metadataInventory = [];
  for (const relative of metadataFiles) {
    const bytes = await readFile(path.join(outputRoot, relative));
    metadataInventory.push({ bytes: bytes.length, path: relative, sha256: sha256(bytes) });
  }
  await writeFile(path.join(outputRoot, checksumFile), checksumLines([...payloadManifest, ...metadataInventory]));
  await setDeterministicTimes(outputRoot, source.sourceDateEpoch);
  console.log(`Release directory: ${artifactDisplayPath}`);
  console.log(`Payload: ${payload.length} files, ${totalBytes} bytes`);
  console.log(`Source: ${source.commitShort} (dirty=${source.dirty})`);
  const verifyOverrides = developmentOverrideArguments(options);
  console.log(`Verify: node scripts/package-release.mjs --verify${verifyOverrides.length > 0 ? ` ${verifyOverrides.join(" ")}` : ""} --out ${artifactDisplayPath}`);
}

async function buildAndPackageRelease(options) {
  if (options.verify) fail("--build cannot be combined with --verify.");
  if (options.dist !== defaultDist || options.out !== defaultOutput) {
    fail("--build uses the canonical dist/ and dist/release/ paths; omit --dist and --out.");
  }
  const sourceBeforeBuild = await gitMetadata();
  if (sourceBeforeBuild.dirty && !options.allowDirty) {
    fail("Refusing a final release build from a dirty worktree. Commit all source changes first, or pass --allow-dirty for a development artifact.");
  }
  if (sourceBeforeBuild.dirty) {
    await command(process.execPath, ["scripts/verify-geogon-vendor.mjs"]);
    await assertSourceStateUnchanged(sourceBeforeBuild, "GeoGon verification");
    console.log("Verified pinned GeoGon vendor source before release build.");
    await command("npm", ["run", "build", "--", "--emptyOutDir"]);
    await assertSourceStateUnchanged(sourceBeforeBuild, "build");
    await packageRelease(options);
    await assertSourceStateUnchanged(sourceBeforeBuild, "package");
    return;
  }

  await buildFinalReleaseFromCommit(options, sourceBeforeBuild);
}

async function assertSourceStateUnchanged(expected, phase) {
  const actual = await gitMetadata();
  if (
    actual.commit !== expected.commit
    || actual.dirty !== expected.dirty
    || actual.statusSha256 !== expected.statusSha256
  ) {
    fail(`The source checkout changed while the release ${phase} was running.`);
  }
}

async function buildFinalReleaseFromCommit(options, source) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "patterdraw-release-"));
  const archivePath = path.join(temporaryRoot, "source.tar");
  const snapshotRoot = path.join(temporaryRoot, "source");
  const snapshotDist = path.join(snapshotRoot, "dist");
  const snapshotOutput = path.join(snapshotDist, "release");
  try {
    await mkdir(snapshotRoot, { recursive: true });
    await command("git", ["archive", "--format=tar", "--output", archivePath, source.commit]);
    await command("tar", ["-xf", archivePath, "-C", snapshotRoot]);

    await command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: snapshotRoot });
    await command(process.execPath, ["scripts/verify-geogon-vendor.mjs"], { cwd: snapshotRoot });
    console.log("Verified pinned GeoGon vendor source inside the immutable release snapshot.");
    await command("npm", ["run", "build", "--", "--emptyOutDir"], { cwd: snapshotRoot });
    await assertSourceStateUnchanged(source, "immutable build");

    const snapshotOptions = { ...options, dist: snapshotDist, out: snapshotOutput };
    await packageRelease(snapshotOptions, {
      buildCommand: "npm ci --ignore-scripts --no-audit --no-fund && node scripts/verify-geogon-vendor.mjs && npm run build -- --emptyOutDir",
      commandRoot: snapshotRoot,
      displayOutputRoot: defaultOutput,
      sourceMetadata: source,
      sourceRoot: snapshotRoot,
    });
    await verifyRelease({ ...snapshotOptions, verify: true });
    await assertSourceStateUnchanged(source, "immutable package");

    await assertReleaseReadinessUnchanged(
      options,
      options.releaseReadiness,
      "immutable build before artifact installation",
    );
    await installCanonicalDist(snapshotDist, sourceDateEpoch(source.commitEpoch), options, {
      assertReadiness: () => assertReleaseReadinessUnchanged(
        options,
        options.releaseReadiness,
        "canonical artifact handoff",
      ),
    });
    await assertSourceStateUnchanged(source, "artifact installation");
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function installCanonicalDist(snapshotDist, epoch, options, { assertReadiness } = {}) {
  const stagingRoot = await mkdtemp(path.join(repoRoot, ".patterdraw-dist-stage-"));
  const candidateDist = path.join(stagingRoot, "dist");
  const previousDist = `${stagingRoot}-previous`;
  const failedDist = `${stagingRoot}-failed`;
  let candidateInstalled = false;
  let previousMoved = false;
  try {
    await cp(snapshotDist, candidateDist, { preserveTimestamps: true, recursive: true });
    await setDeterministicTimes(path.join(candidateDist, "release"), epoch);
    await verifyRelease({ ...options, out: path.join(candidateDist, "release"), verify: true });
    await assertReadiness?.();

    let currentStats;
    try {
      currentStats = await lstat(defaultDist);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (currentStats) {
      if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
        fail(`Canonical build directory must be a real directory: ${defaultDist}`);
      }
      await rename(defaultDist, previousDist);
      previousMoved = true;
    }

    try {
      await rename(candidateDist, defaultDist);
      candidateInstalled = true;
    } catch (error) {
      if (previousMoved) {
        await rename(previousDist, defaultDist);
        previousMoved = false;
      }
      throw error;
    }

    await verifyRelease({ ...options, out: defaultOutput, verify: true });
    await assertReadiness?.();
    if (previousMoved) {
      await rm(previousDist, { force: true, recursive: true });
      previousMoved = false;
    }
  } catch (error) {
    if (candidateInstalled) {
      await rename(defaultDist, failedDist);
      if (previousMoved) {
        await rename(previousDist, defaultDist);
        previousMoved = false;
      }
      await rm(failedDist, { force: true, recursive: true });
    }
    throw error;
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

function parseChecksumFile(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail(`Invalid SHA256SUMS line: ${line}`);
    entries.push({ path: match[2], sha256: match[1] });
  }
  const paths = new Set();
  for (const entry of entries) {
    if (paths.has(entry.path)) fail(`Duplicate SHA256SUMS path: ${entry.path}`);
    paths.add(entry.path);
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (compareStrings(entries[index - 1].path, entries[index].path) >= 0) fail("SHA256SUMS paths are not sorted.");
  }
  return entries;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sbomProperty(sbom, name) {
  return sbom.metadata?.properties?.find((property) => property.name === name)?.value;
}

async function verifyRelease(options) {
  const outputRoot = options.out;
  await ensureDirectory(outputRoot, "Release directory");
  const manifest = await readJson(path.join(outputRoot, "release-manifest.json"), "release-manifest.json");
  const provenance = await readJson(path.join(outputRoot, "provenance.json"), "provenance.json");
  const sbom = await readJson(path.join(outputRoot, "sbom.cdx.json"), "sbom.cdx.json");
  if (manifest.schemaVersion !== manifestSchema) fail(`Unsupported release manifest schema: ${manifest.schemaVersion}`);
  if (provenance.schemaVersion !== provenanceSchema) fail(`Unsupported provenance schema: ${provenance.schemaVersion}`);
  if (manifest.releaseMode !== "final" && manifest.releaseMode !== "development") {
    fail(`Unsupported release mode: ${manifest.releaseMode}`);
  }
  const expectedDevelopmentOverrides = developmentOverrideArguments(options);
  if (manifest.releaseMode === "final" && expectedDevelopmentOverrides.length > 0) {
    fail("Development override flags cannot be used to verify a final release artifact.");
  }
  if (
    !Array.isArray(manifest.developmentOverrides)
    || !manifest.developmentOverrides.every((value) => typeof value === "string")
    || new Set(manifest.developmentOverrides).size !== manifest.developmentOverrides.length
    || !sameJson(manifest.developmentOverrides, expectedDevelopmentOverrides)
  ) {
    fail("Release verification requires the exact development override flags recorded during packaging.");
  }
  if (
    manifest.releaseMode === "final"
    && options.releaseReadiness?.head !== manifest.source?.commit
  ) {
    fail("Final release source commit does not match the locally reviewed HEAD.");
  }
  if (manifest.releaseMode === "final" && manifest.source?.dirty !== false) {
    fail("A final release cannot have dirty source provenance.");
  }
  if (manifest.source?.dirty === true && !options.allowDirty) {
    fail("Release provenance is dirty; pass --allow-dirty only for development verification.");
  }
  if (manifest.releaseMode !== "final" && !isDevelopmentRelease(options)) {
    fail("Release was packaged in development mode; pass the same explicit development flags used during packaging.");
  }
  if (manifest.releaseMode === "final" && (
    !FINAL_NODE_VERSION_PATTERN.test(manifest.toolchain?.node || "")
    || manifest.toolchain?.npm !== FINAL_NPM_VERSION
  )) {
    fail(`Final release manifest requires Node 22.13.x and npm ${FINAL_NPM_VERSION}.`);
  }
  if (manifest.gitCommit !== manifest.source?.commit || manifest.sourceDirty !== manifest.source?.dirty) {
    fail("Manifest top-level provenance aliases do not match the source object.");
  }
  if (manifest.artifact?.mtimeSourceDateEpoch !== manifest.source?.sourceDateEpoch) {
    fail("Manifest deterministic mtime does not match sourceDateEpoch.");
  }
  if (
    manifest.artifact?.kind !== "directory"
    || typeof manifest.artifact.path !== "string"
    || manifest.artifact.path.length === 0
    || path.isAbsolute(manifest.artifact.path)
    || manifest.artifact.path.split("/").some((part) => part === "..")
  ) {
    fail("Manifest artifact identity is invalid.");
  }
  if (!sameJson(manifest.artifact.metadataFiles, [...metadataFiles, checksumFile])) {
    fail("Manifest artifact metadata inventory is invalid.");
  }
  if (manifest.checksums?.file !== checksumFile || manifest.checksums?.algorithm !== "sha256") {
    fail("Manifest checksum metadata is invalid.");
  }
  if (manifest.fileCount !== manifest.artifact?.payloadFileCount || JSON.stringify(manifest.toolVersions) !== JSON.stringify(manifest.toolchain)) {
    fail("Manifest top-level inventory aliases do not match the release metadata.");
  }
  if (manifest.toolchain?.sourceMaps !== "forbidden") fail("Release manifest does not enforce the no-source-maps policy.");
  if (manifest.dependencies?.sbom !== "sbom.cdx.json") fail("Release manifest points to an unexpected SBOM file.");
  if (!Number.isSafeInteger(manifest.source?.sourceDateEpoch) || manifest.source.sourceDateEpoch < 0) {
    fail("Release manifest has an invalid sourceDateEpoch.");
  }
  await verifyDeterministicMetadata(outputRoot, manifest.source.sourceDateEpoch);
  if (!Array.isArray(manifest.files) || manifest.files.length !== manifest.artifact.payloadFileCount) fail("Manifest payload file count is inconsistent.");
  for (const file of manifest.files) {
    if (
      !file
      || typeof file.path !== "string"
      || file.path.length === 0
      || path.posix.isAbsolute(file.path)
      || file.path.split("/").some((part) => part === "..")
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !/^[0-9a-f]{64}$/.test(file.sha256)
    ) fail("Manifest contains an invalid payload file entry.");
  }
  for (let index = 1; index < manifest.files.length; index += 1) {
    if (compareStrings(manifest.files[index - 1].path, manifest.files[index].path) >= 0) fail("Manifest payload paths are not sorted.");
  }
  const payloadBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes !== manifest.artifact.payloadBytes) {
    fail("Manifest payload byte count is inconsistent.");
  }
  const expectedCoveredPaths = [...manifest.files.map((file) => file.path), ...metadataFiles].sort(compareStrings);
  if (!sameJson(manifest.checksums.covers, expectedCoveredPaths)) {
    fail("Manifest checksum coverage inventory is inconsistent.");
  }
  const checksums = parseChecksumFile(await readFile(path.join(outputRoot, checksumFile), "utf8"));
  const expectedChecksumPaths = new Set([...manifest.files.map((file) => file.path), ...metadataFiles]);
  const actualChecksumPaths = new Set(checksums.map((file) => file.path));
  if (checksums.length !== expectedChecksumPaths.size || actualChecksumPaths.size !== expectedChecksumPaths.size) {
    fail("SHA256SUMS does not cover exactly the payload and metadata files.");
  }
  for (const expected of expectedChecksumPaths) {
    if (!actualChecksumPaths.has(expected)) fail(`SHA256SUMS is missing ${expected}.`);
  }
  const allEntries = await walkFiles(outputRoot);
  const allowedPaths = new Set([...expectedChecksumPaths, checksumFile]);
  for (const entry of allEntries) {
    if (!allowedPaths.has(entry.relative)) fail(`Unexpected file in release directory: ${entry.relative}`);
  }
  for (const entry of checksums) {
    const actual = allEntries.find((candidate) => candidate.relative === entry.path);
    if (!actual) fail(`SHA256SUMS references a missing file: ${entry.path}`);
    if (actual.sha256 !== entry.sha256) fail(`SHA256 mismatch: ${entry.path}`);
  }
  for (const file of manifest.files) {
    const actual = allEntries.find((candidate) => candidate.relative === file.path);
    if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) fail(`Manifest file entry mismatch: ${file.path}`);
    if (file.path.toLowerCase().endsWith(".map")) fail(`Source map present in release: ${file.path}`);
  }
  const vendoredComponents = await verifyPackagedGeoGon(outputRoot, allEntries);
  if (!sameJson(manifest.dependencies?.vendoredComponents, vendoredComponents)) {
    fail("Release manifest vendored-component provenance is invalid.");
  }
  if (!sameJson(provenance.vendoredComponents, vendoredComponents)) {
    fail("Release provenance does not match the packaged vendored components.");
  }
  if (manifest.artifact.totalFileCount !== allEntries.length) fail("Manifest total file count is inconsistent.");
  if (manifest.artifact.totalFileCount !== manifest.artifact.payloadFileCount + metadataFiles.length + 1) {
    fail("Manifest artifact file totals are inconsistent.");
  }
  if (!Array.isArray(sbom.components)) fail("SBOM components must be an array.");
  if (manifest.dependencies.componentCount !== sbom.components.length) fail("Manifest SBOM component count is inconsistent.");
  if (sbom.bomFormat !== sbomSchema || sbom.specVersion !== "1.5" || sbom.version !== 1) {
    fail("SBOM identity is invalid.");
  }
  if (
    sbom.metadata?.component?.name !== manifest.package?.name
    || sbom.metadata?.component?.version !== manifest.package?.version
    || sbom.metadata?.component?.type !== "application"
  ) {
    fail("SBOM application metadata does not match the release manifest.");
  }
  if (sbomProperty(sbom, "patterdraw:lockfileSha256") !== manifest.dependencies.lockfileSha256) {
    fail("SBOM lockfile hash does not match the release manifest.");
  }
  if (
    sbomProperty(sbom, "patterdraw:sourceCommit") !== manifest.source.commit
    || sbomProperty(sbom, "patterdraw:sourceDirty") !== String(manifest.source.dirty)
    || sbomProperty(sbom, "patterdraw:sourceDateEpoch") !== String(manifest.source.sourceDateEpoch)
    || sbomProperty(sbom, "patterdraw:node") !== manifest.toolchain.node
    || sbomProperty(sbom, "patterdraw:npm") !== manifest.toolchain.npm
  ) {
    fail("SBOM provenance properties do not match the release manifest.");
  }
  const expectedVendoredSbomComponents = new Map(buildVendoredSbomComponents()
    .map((component) => [component["bom-ref"], component]));
  const foundVendoredSbomComponents = new Set();
  const componentRefs = new Set();
  for (const component of sbom.components) {
    const componentRef = component?.["bom-ref"];
    if (
      !component
      || typeof componentRef !== "string"
      || componentRef.length === 0
      || componentRefs.has(componentRef)
    ) fail("SBOM contains an invalid or duplicate component.");
    componentRefs.add(componentRef);

    const expectedVendoredComponent = expectedVendoredSbomComponents.get(componentRef);
    if (expectedVendoredComponent) {
      if (!sameJson(component, expectedVendoredComponent)) {
        fail(`SBOM vendored component does not match pinned provenance: ${componentRef}`);
      }
      foundVendoredSbomComponents.add(componentRef);
      continue;
    }

    const properties = Array.isArray(component?.properties) ? component.properties : [];
    const lockfilePath = properties.find((property) => (
      property?.name === "patterdraw:lockfilePath"
    ))?.value;
    if (
      typeof component.name !== "string"
      || component.name.length === 0
      || component.type !== "library"
      || typeof component.version !== "string"
      || component.version.length === 0
      || typeof component.purl !== "string"
      || !component.purl.startsWith("pkg:npm/")
      || !Array.isArray(component.properties)
      || typeof lockfilePath !== "string"
      || !lockfilePath.startsWith("node_modules/")
    ) fail("SBOM contains an invalid or duplicate component.");
  }
  for (const componentRef of expectedVendoredSbomComponents.keys()) {
    if (!foundVendoredSbomComponents.has(componentRef)) {
      fail(`SBOM is missing a pinned vendored component: ${componentRef}`);
    }
  }
  if (!Array.isArray(sbom.dependencies)) fail("SBOM dependencies must be an array.");
  const sbomDependencies = new Map();
  for (const dependency of sbom.dependencies) {
    if (
      !dependency
      || typeof dependency.ref !== "string"
      || dependency.ref.length === 0
      || sbomDependencies.has(dependency.ref)
      || !Array.isArray(dependency.dependsOn)
      || dependency.dependsOn.some((ref) => typeof ref !== "string" || ref.length === 0)
      || new Set(dependency.dependsOn).size !== dependency.dependsOn.length
    ) fail("SBOM contains an invalid or duplicate dependency relationship.");
    if (!componentRefs.has(dependency.ref) || dependency.dependsOn.some((ref) => !componentRefs.has(ref))) {
      fail("SBOM dependency relationship references an unknown component.");
    }
    sbomDependencies.set(dependency.ref, dependency);
  }
  for (const expected of buildVendoredSbomDependencies()) {
    if (!sameJson(sbomDependencies.get(expected.ref), expected)) {
      fail(`SBOM vendored dependency relationship is invalid: ${expected.ref}`);
    }
  }
  if (provenance.releaseMode !== manifest.releaseMode
    || !sameJson(provenance.developmentOverrides, manifest.developmentOverrides)
    || !sameJson(provenance.source, manifest.source)
    || !sameJson(provenance.toolchain, manifest.toolchain)
    || !sameJson(provenance.package, manifest.package)
    || provenance.lockfile?.file !== "package-lock.json"
    || provenance.lockfile?.lockfileVersion !== 3
    || provenance.lockfile?.sha256 !== manifest.dependencies.lockfileSha256
    || provenance.artifact?.kind !== manifest.artifact.kind
    || provenance.artifact?.path !== manifest.artifact.path
    || provenance.artifact?.payloadFileCount !== manifest.artifact.payloadFileCount
    || provenance.artifact?.payloadBytes !== manifest.artifact.payloadBytes) {
    fail("Provenance source metadata does not match the release manifest.");
  }
  if (!Array.isArray(manifest.licenses?.files) || manifest.licenses.files.length === 0) {
    fail("License verification metadata is incomplete.");
  }
  const licenseFiles = new Map();
  for (const file of manifest.licenses.files) {
    if (
      !file
      || typeof file.path !== "string"
      || !file.path.startsWith("licenses/")
      || licenseFiles.has(file.path)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes <= 0
      || !/^[0-9a-f]{64}$/.test(file.sha256)
    ) fail("License verification metadata contains an invalid file entry.");
    licenseFiles.set(file.path, file);
  }
  if (
    manifest.licenses.passed !== true
    || manifest.licenses.expectedCount !== manifest.licenses.files.length
    || licenseFiles.size !== manifest.licenses.expectedCount
  ) fail("License verification metadata is incomplete.");
  for (const [relative, expected] of licenseFiles) {
    const actual = allEntries.find((entry) => entry.relative === relative);
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail(`License file verification failed: ${relative}`);
  }
  console.log(`Verified release directory: ${normalizedRelativePath(path.relative(repoRoot, outputRoot))}`);
  console.log(`Payload: ${manifest.artifact.payloadFileCount} files, ${manifest.artifact.payloadBytes} bytes`);
  console.log(`Source: ${manifest.source.commitShort} (dirty=${manifest.source.dirty})`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const releaseLock = await acquireReleaseLock();
  try {
    const releaseReadiness = await assertLocalReleaseReadiness(readinessOptions(options));
    const readyOptions = { ...options, releaseReadiness };
    if (options.verify) await verifyRelease(readyOptions);
    else if (options.build) await buildAndPackageRelease(readyOptions);
    else await packageRelease(readyOptions);
    await assertReleaseReadinessUnchanged(
      readyOptions,
      releaseReadiness,
      options.verify ? "artifact verification" : "artifact packaging",
    );
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  console.error(`package-release: ${error?.message || error}`);
  process.exitCode = 1;
});
