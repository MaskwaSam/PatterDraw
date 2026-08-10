import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeReleaseTreeInventory } from "./release-inventory.mjs";

test("release-tree inventory changes for modified and extra files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patterdraw-release-inventory-"));
  try {
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "<!doctype html>\n");
    await writeFile(path.join(root, "assets", "app-abc12345.js"), "console.log('reviewed');\n");
    await writeFile(path.join(root, "SHA256SUMS"), "reviewed-checksum-list\n");

    const reviewed = await computeReleaseTreeInventory(root);
    assert.equal(reviewed.files.length, 3);
    assert.equal((await computeReleaseTreeInventory(root)).sha256, reviewed.sha256);

    await writeFile(path.join(root, "assets", "unlisted.js"), "console.log('extra');\n");
    assert.notEqual((await computeReleaseTreeInventory(root)).sha256, reviewed.sha256);
    await rm(path.join(root, "assets", "unlisted.js"));

    await writeFile(path.join(root, "assets", "app-abc12345.js"), "console.log('modified');\n");
    await writeFile(path.join(root, "SHA256SUMS"), "rewritten-checksum-list\n");
    assert.notEqual((await computeReleaseTreeInventory(root)).sha256, reviewed.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-tree inventory rejects symbolic links and ambiguous paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patterdraw-release-inventory-"));
  try {
    await writeFile(path.join(root, "index.html"), "<!doctype html>\n");
    await writeFile(path.join(root, "bad name.js"), "not used");
    await assert.rejects(() => computeReleaseTreeInventory(root), /unsafe path/);
    await rm(path.join(root, "bad name.js"));

    await symlink("index.html", path.join(root, "bad-link.js"));
    await assert.rejects(() => computeReleaseTreeInventory(root), /symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
