import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEPLOY_CONFIG_FILES,
  computeDeployConfigInventory,
} from "./deploy-config-inventory.mjs";

async function writeFixture(root) {
  await Promise.all(DEPLOY_CONFIG_FILES.map((name) => (
    writeFile(path.join(root, name), `reviewed ${name}\n`)
  )));
}

test("deployment configuration inventory binds every image and runtime file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patterdraw-deploy-config-"));
  try {
    await writeFixture(root);
    const reviewed = await computeDeployConfigInventory(root);
    assert.equal(reviewed.files.length, DEPLOY_CONFIG_FILES.length);
    assert.equal(
      reviewed.inventory,
      [
        "31d803f1f1a03f724f595bd7d73e4f8d2b37e478e384f76befea6b8bc9b46055  Dockerfile",
        "8d26e289150ee4c97979897168c9f3e36a6ce55bed63e09ad647d0717094e1ba  compose.yaml",
        "ebd6cb92b6fb2a6e7a45ad3bc07fe1176d4539cf42e58cf1e8a7e752be171d91  nginx.conf",
        "264be22babf0780679ab8760e83afa4494e3cd97480f72f5803f07fd057f9805  security-headers.conf",
        "",
      ].join("\n"),
    );
    assert.equal(
      reviewed.sha256,
      "617187ba69373bae5b4d5ee0599473dacd09a3f51aed12b764cdc9c02dbfba37",
    );
    assert.equal((await computeDeployConfigInventory(root)).sha256, reviewed.sha256);

    await writeFile(path.join(root, "nginx.conf"), "changed nginx\n");
    assert.notEqual((await computeDeployConfigInventory(root)).sha256, reviewed.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment configuration inventory rejects a linked control file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patterdraw-deploy-config-"));
  try {
    await writeFixture(root);
    await rm(path.join(root, "compose.yaml"));
    await symlink("Dockerfile", path.join(root, "compose.yaml"));
    await assert.rejects(
      () => computeDeployConfigInventory(root),
      /must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
