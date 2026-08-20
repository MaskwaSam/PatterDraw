import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const deployRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(deployRoot, "..");
const expectedDockerignore = [
  "*",
  "!deploy/",
  "!deploy/**",
  "!dist/",
  "!dist/release/",
  "!dist/release/**",
  "",
].join("\n");
const fixtureFiles = [
  "Dockerfile",
  "compose.yaml",
  "deploy-config-inventory.mjs",
  "nginx.conf",
  "release-inventory.mjs",
  "security-headers.conf",
  "verify-config.mjs",
];

async function createFixture(dockerignore) {
  const root = await mkdtemp(path.join(tmpdir(), "patterdraw-verify-config-"));
  const fixtureDeployRoot = path.join(root, "deploy");
  await mkdir(fixtureDeployRoot);
  await Promise.all(fixtureFiles.map((name) => (
    copyFile(path.join(deployRoot, name), path.join(fixtureDeployRoot, name))
  )));
  if (dockerignore !== null) {
    await writeFile(path.join(root, ".dockerignore"), dockerignore);
  }
  return root;
}

function verifyFixture(root, arguments_ = ["--config-only"]) {
  return spawnSync(
    process.execPath,
    [path.join(root, "deploy", "verify-config.mjs"), ...arguments_],
    { cwd: root, encoding: "utf8" },
  );
}

test("repository Docker context is restricted to reviewed deployment inputs", async () => {
  assert.equal(await readFile(path.join(repoRoot, ".dockerignore"), "utf8"), expectedDockerignore);

  const root = await createFixture(expectedDockerignore);
  try {
    const result = verifyFixture(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deployment configuration checks passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration verification fails closed when .dockerignore is absent", async () => {
  const root = await createFixture(null);
  try {
    for (const arguments_ of [["--config-only"], []]) {
      const result = verifyFixture(root, arguments_);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /\.dockerignore must exist and be readable/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration verification rejects a broadened Docker context", async () => {
  const root = await createFixture(`${expectedDockerignore}!src/**\n`);
  try {
    for (const arguments_ of [["--config-only"], []]) {
      const result = verifyFixture(root, arguments_);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must exactly restrict the Docker context/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
