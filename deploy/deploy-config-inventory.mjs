#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_CONFIG_FILES = Object.freeze([
  "Dockerfile",
  "compose.yaml",
  "nginx.conf",
  "security-headers.conf",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Bind every file that controls the built image or its runtime isolation. */
export async function computeDeployConfigInventory(deployDirectory) {
  const root = path.resolve(deployDirectory);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Deployment configuration root must be a real directory: ${root}`);
  }

  const files = [];
  for (const relative of DEPLOY_CONFIG_FILES) {
    const absolute = path.join(root, relative);
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Deployment configuration must be a regular file: ${relative}`);
    }
    const bytes = await readFile(absolute);
    files.push({ bytes: bytes.length, path: relative, sha256: sha256(bytes) });
  }
  const inventory = `${files.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`;
  return {
    files,
    inventory,
    sha256: sha256(Buffer.from(inventory, "utf8")),
  };
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function main() {
  const [deployDirectory, expected] = process.argv.slice(2);
  if (!deployDirectory || process.argv.length > 4) {
    throw new Error("Usage: node deploy/deploy-config-inventory.mjs <deploy-directory> [expected-sha256]");
  }
  const result = await computeDeployConfigInventory(deployDirectory);
  if (expected && !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("Expected deployment configuration SHA-256 must be 64 lowercase hexadecimal characters.");
  }
  if (expected && result.sha256 !== expected) {
    throw new Error(`Deployment configuration SHA-256 mismatch: expected ${expected}, received ${result.sha256}`);
  }
  console.log(result.sha256);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`deploy-config-inventory: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
