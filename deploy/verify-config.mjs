import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { computeDeployConfigInventory } from "./deploy-config-inventory.mjs";
import { computeReleaseTreeInventory } from "./release-inventory.mjs";

const deployRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(deployRoot, "..");
const configOnly = process.argv.includes("--config-only");
const unexpected = process.argv.slice(2).filter((argument) => argument !== "--config-only");
const expectedDockerignore = [
  "*",
  "!deploy/",
  "!deploy/**",
  "!dist/",
  "!dist/release/",
  "!dist/release/**",
  "",
].join("\n");

if (unexpected.length > 0) {
  throw new Error(`Unknown argument: ${unexpected[0]}`);
}

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(message);
}

function rejectMatch(text, pattern, message) {
  if (pattern.test(text)) throw new Error(message);
}

const [compose, dockerfile, nginx, headers, dockerignore] = await Promise.all([
  readFile(path.join(deployRoot, "compose.yaml"), "utf8"),
  readFile(path.join(deployRoot, "Dockerfile"), "utf8"),
  readFile(path.join(deployRoot, "nginx.conf"), "utf8"),
  readFile(path.join(deployRoot, "security-headers.conf"), "utf8"),
  readFile(path.join(repoRoot, ".dockerignore"), "utf8").catch((error) => {
    throw new Error("The repository root .dockerignore must exist and be readable.", { cause: error });
  }),
]);

if (dockerignore !== expectedDockerignore) {
  throw new Error(
    "The repository root .dockerignore must exactly restrict the Docker context to deploy/ and dist/release/.",
  );
}
rejectMatch(compose, /^\s*ports\s*:/m, "PatterDraw must not publish a host port.");
requireMatch(compose, /^\s*read_only:\s*true\s*$/m, "Compose must use a read-only root filesystem.");
requireMatch(compose, /^\s*user:\s*["']101:101["']\s*$/m, "Compose must run NGINX as uid/gid 101.");
requireMatch(compose, /^\s*cap_drop:\s*$/m, "Compose must drop Linux capabilities.");
requireMatch(compose, /^\s*-\s*ALL\s*$/m, "Compose must drop every Linux capability.");
requireMatch(compose, /no-new-privileges:true/, "Compose must prevent privilege escalation.");
requireMatch(compose, /^\s*pids_limit:\s*64\s*$/m, "Compose must bound process count.");
requireMatch(compose, /^\s*restart:\s*unless-stopped\s*$/m, "Compose must define restart behavior.");
requireMatch(compose, /^\s*healthcheck:\s*$/m, "Compose must define a health check.");
requireMatch(compose, /^\s*logging:\s*$/m, "Compose must bound container logs.");
requireMatch(
  compose,
  /^\s*name:\s*patterdraw_edge\s*$/m,
  "Compose must hard-bind the dedicated PatterDraw edge network.",
);
rejectMatch(
  compose,
  /PATTERDRAW_EDGE_NETWORK/,
  "The dedicated PatterDraw edge network must not be caller-selectable.",
);
requireMatch(compose, /^\s*external:\s*true\s*$/m, "Compose must treat the edge network as pre-existing.");
requireMatch(compose, /^\s*-\s*patterdraw\s*$/m, "Compose must provide the stable patterdraw network alias.");
requireMatch(
  compose,
  /\n    networks:\n      edge:\n        aliases:\n          - patterdraw\n\nnetworks:\n  edge:\n    name: patterdraw_edge\n    external: true\s*$/,
  "PatterDraw must have exactly one service network: the dedicated patterdraw_edge network.",
);
requireMatch(
  compose,
  /PATTERDRAW_RELEASE_TREE_SHA256/,
  "Compose must pass and label the verified release-tree inventory anchor.",
);
requireMatch(
  compose,
  /ca\.spatterson\.patterdraw\.release-tree-sha256:/,
  "Compose must expose the release-tree inventory anchor on the container label.",
);
requireMatch(
  compose,
  /PATTERDRAW_DEPLOY_CONFIG_SHA256/,
  "Compose must pass and label the reviewed deployment configuration anchor.",
);
requireMatch(
  compose,
  /ca\.spatterson\.patterdraw\.deploy-config-sha256:/,
  "Compose must expose the deployment configuration anchor on the container label.",
);

requireMatch(
  dockerfile,
  /^FROM\s+nginx:[^\s]+@sha256:[0-9a-f]{64}\s*$/m,
  "The NGINX base image must be pinned by digest.",
);
requireMatch(dockerfile, /^USER\s+101:101\s*$/m, "The image must default to a non-root user.");
requireMatch(dockerfile, /sha256sum -c SHA256SUMS/, "The image build must verify release checksums.");
requireMatch(
  dockerfile,
  /^ARG PATTERDRAW_RELEASE_TREE_SHA256\s*$/m,
  "The image build must accept the verified release-tree inventory anchor.",
);
requireMatch(
  dockerfile,
  /PATTERDRAW_RELEASE_TREE_SHA256/,
  "The image build must cryptographically bind the copied release tree to its verified anchor.",
);
requireMatch(
  dockerfile,
  /ca\.spatterson\.patterdraw\.release-tree-sha256=/,
  "The image must retain the release-tree inventory anchor as a provenance label.",
);
requireMatch(
  dockerfile,
  /^ARG PATTERDRAW_DEPLOY_CONFIG_SHA256\s*$/m,
  "The image build must accept the reviewed deployment configuration anchor.",
);
requireMatch(
  dockerfile,
  /ca\.spatterson\.patterdraw\.deploy-config-sha256=/,
  "The image must retain the deployment configuration anchor as a provenance label.",
);
requireMatch(
  dockerfile,
  /test "\$actual_deploy_config_sha256" = "\$PATTERDRAW_DEPLOY_CONFIG_SHA256"/,
  "The image build must compare its deployment files with the reviewed anchor.",
);
requireMatch(
  dockerfile,
  /sha256sum \/tmp\/patterdraw-release\.inventory/,
  "The image build must hash its complete copied release inventory.",
);
requireMatch(
  dockerfile,
  /test "\$actual_release_tree_sha256" = "\$PATTERDRAW_RELEASE_TREE_SHA256"/,
  "The image build must compare its release inventory with the verified anchor.",
);
requireMatch(
  dockerfile,
  /rm -rf \/usr\/share\/nginx\/html\/\* \/usr\/share\/nginx\/html\/\.\[!\.\]\* \/usr\/share\/nginx\/html\/\.\.\?\*/,
  "The image build must remove NGINX's stock HTML payload before copying the release.",
);
requireMatch(dockerfile, /"releaseMode"/, "The image build must reject a non-final release.");
requireMatch(dockerfile, /"dirty"/, "The image build must reject dirty release provenance.");

requireMatch(nginx, /listen 8080 default_server;/, "NGINX must have a rejecting default server.");
const nginxServerNames = [...nginx.matchAll(/^\s*server_name\s+([^;]+);\s*$/gm)]
  .map((match) => match[1].trim());
if (
  nginxServerNames.length !== 2
  || nginxServerNames[0] !== "_"
  || nginxServerNames[1] !== "draw.spatterson.ca"
) {
  throw new Error(
    "NGINX must recognize exactly draw.spatterson.ca after its rejecting default server.",
  );
}
requireMatch(nginx, /return 444;/, "NGINX must reject unknown Host headers.");
requireMatch(
  nginx,
  /include \/etc\/nginx\/mime\.types;\s*(?:#[^\n]*\n\s*)*types\s*\{\s*application\/javascript\s+mjs;\s*\}\s*default_type application\/octet-stream;/,
  "NGINX must explicitly serve .mjs files as application/javascript.",
);
for (const [routeName, routePattern] of [
  ["root", /location = \/ \{[^}]*add_header Cache-Control "no-store, no-transform" always;[^}]*\}/],
  ["direct index", /location = \/index\.html \{[^}]*add_header Cache-Control "no-store, no-transform" always;[^}]*\}/],
  ["SPA fallback", /location @patterdraw_app \{[^}]*add_header Cache-Control "no-store, no-transform" always;[^}]*\}/],
]) {
  requireMatch(
    nginx,
    routePattern,
    `NGINX must keep the ${routeName} HTML response uncached and prevent proxy-side script injection.`,
  );
}
for (const [routeName, routePattern] of [
  ["root", /location = \/ \{[^}]*add_header X-PatterDraw-App-Shell "patterdraw-app-shell-v1" always;[^}]*\}/],
  ["direct index", /location = \/index\.html \{[^}]*add_header X-PatterDraw-App-Shell "patterdraw-app-shell-v1" always;[^}]*\}/],
  ["SPA fallback", /location @patterdraw_app \{[^}]*add_header X-PatterDraw-App-Shell "patterdraw-app-shell-v1" always;[^}]*\}/],
]) {
  requireMatch(
    nginx,
    routePattern,
    `NGINX must advertise the app-shell rollback protocol on the ${routeName} HTML response.`,
  );
}
requireMatch(
  nginx,
  /location = \/service-worker\.js \{[^}]*default_type application\/javascript;[^}]*add_header Cache-Control "no-cache, no-transform" always;[^}]*try_files \$uri =404;[^}]*\}/,
  "NGINX must revalidate the same-origin app-shell worker without allowing proxy transformation.",
);
requireMatch(nginx, /max-age=31536000, immutable/, "NGINX must cache hashed assets immutably.");
requireMatch(
  nginx,
  /location @asset_not_found[\s\S]*?add_header Cache-Control "no-store" always;[\s\S]*?return 404;/,
  "NGINX must prevent missing hashed-asset responses from being cached.",
);
requireMatch(
  nginx,
  /error_page 404 = @asset_not_found;/,
  "NGINX hashed-asset misses must use the non-immutable 404 policy.",
);
requireMatch(nginx, /try_files \$uri =404;/, "NGINX must fail closed for missing static assets.");

requireMatch(
  headers,
  /frame-src 'self'/,
  "The main PatterDraw policy must permit its pinned same-origin GeoGon frame.",
);
requireMatch(headers, /frame-ancestors 'none'/, "PatterDraw itself must not be frameable.");
requireMatch(headers, /X-Frame-Options "DENY"/, "PatterDraw itself must retain DENY framing protection.");

const geoGonCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'self'; object-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
for (const [routeName, routePattern] of [
  ["entry point", /location = \/geogon\/index\.html \{[\s\S]*?\n        \}/],
  ["static payload", /location \^~ \/geogon\/ \{[\s\S]*?\n        \}/],
]) {
  const route = nginx.match(routePattern)?.[0] || "";
  if (!route) throw new Error(`NGINX must define a dedicated GeoGon ${routeName} route.`);
  if (!route.includes(`Content-Security-Policy "${geoGonCsp}"`)) {
    throw new Error(`The GeoGon ${routeName} route must use the pinned child CSP.`);
  }
  if (!route.includes('X-Frame-Options "SAMEORIGIN"')) {
    throw new Error(`The GeoGon ${routeName} route must permit only same-origin framing.`);
  }
  if (route.includes("patterdraw-security.conf")) {
    throw new Error(`The GeoGon ${routeName} route must not inherit conflicting parent framing headers.`);
  }
}
requireMatch(
  nginx,
  /location = \/geogon\/index\.html \{[\s\S]*?Cache-Control "no-store, no-transform" always;/,
  "The GeoGon HTML entry point must not be cached or transformed.",
);
requireMatch(
  nginx,
  /location \^~ \/geogon\/ \{[\s\S]*?error_page 404 = @asset_not_found;[\s\S]*?try_files \$uri =404;/,
  "GeoGon static resources must fail closed through the non-cacheable missing-asset policy.",
);
for (const requiredHeader of [
  "Content-Security-Policy",
  "Permissions-Policy",
  "Referrer-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "X-PatterDraw-Production-Dist",
]) {
  if (!headers.includes(requiredHeader)) throw new Error(`Missing security header: ${requiredHeader}.`);
}

if (configOnly) {
  console.log("PatterDraw deployment configuration checks passed (release not checked).");
  process.exit(0);
}

const releaseRoot = path.join(repoRoot, "dist", "release");
const verification = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "package-release.mjs"), "--verify", "--out", releaseRoot],
  { cwd: repoRoot, encoding: "utf8" },
);
if (verification.status !== 0) {
  process.stderr.write(verification.stdout || "");
  process.stderr.write(verification.stderr || "");
  throw new Error("The final release verifier rejected dist/release.");
}

const [provenanceBytes, manifestBytes] = await Promise.all([
  readFile(path.join(releaseRoot, "provenance.json")),
  readFile(path.join(releaseRoot, "release-manifest.json")),
]);
const provenance = JSON.parse(provenanceBytes.toString("utf8"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (provenance.releaseMode !== "final" || provenance.source?.dirty !== false) {
  throw new Error("PatterDraw deployment requires final, clean provenance.");
}
if (manifest.releaseMode !== "final" || manifest.sourceDirty !== false) {
  throw new Error("PatterDraw deployment requires a final, clean release manifest.");
}
if (manifest.gitCommit !== provenance.source?.commit) {
  throw new Error("Release provenance and manifest commits do not match.");
}

const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const currentCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const currentStatus = spawnSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (currentCommit.status !== 0 || currentStatus.status !== 0) {
  throw new Error("The current source checkout could not be verified for deployment.");
}
if (currentCommit.stdout.trim() !== provenance.source.commit) {
  throw new Error("The final release commit does not match the current source checkout.");
}
if (currentStatus.stdout.trim()) {
  throw new Error("PatterDraw deployment requires a clean current source checkout.");
}

const [releaseTreeInventory, deployConfigInventory] = await Promise.all([
  computeReleaseTreeInventory(releaseRoot),
  computeDeployConfigInventory(deployRoot),
]);
const imageTag = [
  provenance.source.commit.slice(0, 12),
  manifestSha256.slice(0, 12),
  releaseTreeInventory.sha256.slice(0, 12),
  deployConfigInventory.sha256.slice(0, 12),
].join("-");
console.log("PatterDraw deployment configuration and final release checks passed.");
console.log(`PATTERDRAW_GIT_COMMIT=${provenance.source.commit}`);
console.log(`PATTERDRAW_MANIFEST_SHA256=${manifestSha256}`);
console.log(`PATTERDRAW_RELEASE_TREE_SHA256=${releaseTreeInventory.sha256}`);
console.log(`PATTERDRAW_DEPLOY_CONFIG_SHA256=${deployConfigInventory.sha256}`);
console.log(`PATTERDRAW_IMAGE_TAG=${imageTag}`);
