#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Dockerfile computes the same inventory with the small POSIX tool set in
// nginx:alpine. Keep the path contract intentionally narrow so its line-based
// inventory cannot be ambiguous (for example, because of an embedded newline).
const safeRelativePath = /^[A-Za-z0-9._/-]+$/;

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeRelativePath(relative) {
  if (
    !relative
    || path.posix.isAbsolute(relative)
    || relative.split("/").some((part) => part === "..")
    || !safeRelativePath.test(relative)
  ) {
    throw new Error(`Release inventory contains an unsafe path: ${relative || "<root>"}`);
  }
}

/**
 * Hash every regular file in a release directory using a canonical inventory.
 *
 * The resulting anchor covers both the bytes and the relative path of every
 * file, including release metadata and SHA256SUMS. A caller can therefore
 * compare the anchor produced from a verified release tree with the exact
 * tree copied into an image; changing a file or adding an unlisted file makes
 * the anchor differ.
 */
export async function computeReleaseTreeInventory(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Release inventory root must be a real directory: ${root}`);
  }

  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertSafeRelativePath(relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Release inventory contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ bytes: bytes.length, path: relative, sha256: sha256(bytes) });
      } else {
        throw new Error(`Release inventory contains an unsupported entry: ${relative}`);
      }
    }
  }

  await visit(root);
  files.sort((left, right) => comparePaths(left.path, right.path));
  const inventoryLines = files.map((file) => `${file.sha256}  ${file.path}`);
  const inventory = inventoryLines.length > 0 ? `${inventoryLines.join("\n")}\n` : "";
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
  const [rootDirectory, expected] = process.argv.slice(2);
  if (!rootDirectory || process.argv.length > 4) {
    throw new Error("Usage: node deploy/release-inventory.mjs <release-directory> [expected-sha256]");
  }
  const result = await computeReleaseTreeInventory(rootDirectory);
  if (expected && !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("Expected release inventory SHA-256 must be 64 lowercase hexadecimal characters.");
  }
  if (expected && result.sha256 !== expected) {
    throw new Error(`Release inventory SHA-256 mismatch: expected ${expected}, received ${result.sha256}`);
  }
  console.log(result.sha256);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`release-inventory: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
