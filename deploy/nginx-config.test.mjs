import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployRoot = path.dirname(fileURLToPath(import.meta.url));

test("NGINX accepts only the exact draw.spatterson.ca hostname", async () => {
  const nginx = await readFile(path.join(deployRoot, "nginx.conf"), "utf8");
  const serverNames = [...nginx.matchAll(/^\s*server_name\s+([^;]+);\s*$/gm)]
    .map((match) => match[1].trim());

  assert.deepEqual(serverNames, [
    "_",
    "draw.spatterson.ca",
  ]);
  assert.match(nginx, /server_name _;[\s\S]*?return 444;/);
});
