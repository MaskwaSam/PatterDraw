#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(repoRoot, "public/geogon");
const source = Object.freeze({
  commit: "386e47223740ed9955ae1fe8a022516fea98d57f",
  repository: "https://github.com/MaskwaSam/3dgeogon",
  version: "0.2.10",
});

// These are the unmodified runtime and corresponding-source files copied from
// the pinned upstream commit. Keep PatterDraw integration files out of this map.
const upstreamFiles = new Map([
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
]);

const requiredPatterDrawFiles = new Map([
  ["PATTERDRAW_VENDOR.md", "14afd52a71a97b6158c44e1cb510f54365b2da6cd8a4a1024e906aa90ad9f92a"],
]);

function fail(message) {
  throw new Error(`GeoGon vendor verification failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectFiles(directory, relativeDirectory = "") {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`symlinks are not allowed: ${relative}`);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else fail(`unsupported filesystem entry: ${relative}`);
  }
  return files;
}

async function verify() {
  const rootStats = await lstat(vendorRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail("public/geogon must be a real directory");

  const actualFiles = await collectFiles(vendorRoot);
  const allowedFiles = new Set([
    ...upstreamFiles.keys(),
    ...requiredPatterDrawFiles.keys(),
  ]);
  const unexpectedFiles = actualFiles.filter((relative) => !allowedFiles.has(relative));
  if (unexpectedFiles.length > 0) fail(`unexpected files: ${unexpectedFiles.join(", ")}`);
  for (const [relative, expectedHash] of requiredPatterDrawFiles) {
    if (!actualFiles.includes(relative)) fail(`required PatterDraw vendor record is missing: ${relative}`);
    const actualHash = sha256(await readFile(path.join(vendorRoot, relative)));
    if (actualHash !== expectedHash) fail(`PatterDraw vendor record differs from reviewed bytes: ${relative}`);
  }

  for (const [relative, expectedHash] of upstreamFiles) {
    let bytes;
    try {
      bytes = await readFile(path.join(vendorRoot, relative));
    } catch (error) {
      if (error?.code === "ENOENT") fail(`upstream file is missing: ${relative}`);
      throw error;
    }
    const actualHash = sha256(bytes);
    if (actualHash !== expectedHash) {
      fail(`${relative} differs from 3DGeoGon ${source.version} at ${source.commit}`);
    }
  }

  for (const [relative, expectedHash] of [
    ["licenses/3dgeogon-GPL-3.0-or-later.txt", upstreamFiles.get("LICENSE")],
    ["licenses/three-LICENSE.txt", upstreamFiles.get("build/three-0.185.1/LICENSE")],
  ]) {
    const bytes = await readFile(path.join(repoRoot, relative));
    if (sha256(bytes) !== expectedHash) fail(`release license copy differs from its vendored source: ${relative}`);
  }

  const vendorRecord = await readFile(path.join(vendorRoot, "PATTERDRAW_VENDOR.md"), "utf8");
  for (const expected of [source.repository, source.version, source.commit, "GPL-3.0-or-later", "Three.js version: `0.185.1`"]) {
    if (!vendorRecord.includes(expected)) fail(`PATTERDRAW_VENDOR.md is missing provenance: ${expected}`);
  }

  const appSource = await readFile(path.join(vendorRoot, "app.js"), "utf8");
  if (!appSource.startsWith("// SPDX-License-Identifier: GPL-3.0-or-later")) {
    fail("app.js is missing its GPL-3.0-or-later SPDX header");
  }
  const threeManifest = JSON.parse(await readFile(
    path.join(vendorRoot, "build/three-0.185.1/vendor-manifest.json"),
    "utf8",
  ));
  if (threeManifest.package !== "three" || threeManifest.version !== "0.185.1" || threeManifest.license !== "MIT") {
    fail("Three.js vendor provenance changed");
  }
  for (const [relative, expectedHash] of Object.entries(threeManifest.files || {})) {
    const bytes = await readFile(path.join(vendorRoot, "build/three-0.185.1", relative));
    if (sha256(bytes) !== expectedHash) fail(`Three.js vendor manifest mismatch: ${relative}`);
  }

  const integrationFiles = await Promise.all(actualFiles
    .filter((relative) => requiredPatterDrawFiles.has(relative))
    .map(async (relative) => ({
      relative,
      sha256: sha256(await readFile(path.join(vendorRoot, relative))),
    })));

  console.log(JSON.stringify({
    ok: true,
    source,
    upstreamFiles: upstreamFiles.size,
    integrationFiles,
  }, null, 2));
}

verify().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
