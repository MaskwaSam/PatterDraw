import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  evaluateReleaseReadiness,
  FINAL_NPM_VERSION,
  FINAL_REMOTE_LOOKUP_TIMEOUT_MS,
  lookupRemoteMainHead,
  parseRemoteMainHead,
} from "../scripts/release-readiness.mjs";

const commit = "a".repeat(40);

test("accepts only the pinned final toolchain and exact origin/main identity", () => {
  const result = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.7",
    npmVersion: FINAL_NPM_VERSION,
    originMain: commit,
    remoteMain: commit,
    sourceDirty: false,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.developmentOnly, false);
  assert.equal(result.toolchainMatches, true);
  assert.equal(result.trackingRefMatches, true);
  assert.equal(result.remoteRefMatches, true);
});

test("rejects a different or missing local tracking ref", () => {
  const stale = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.0",
    npmVersion: FINAL_NPM_VERSION,
    originMain: "b".repeat(40),
    remoteMain: commit,
    sourceDirty: false,
  });
  assert.match(stale.failures.join("\n"), /does not exactly match/);

  const missing = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.0",
    npmVersion: FINAL_NPM_VERSION,
    originMain: "",
    remoteMain: commit,
    sourceDirty: false,
  });
  assert.match(missing.failures.join("\n"), /tracking ref is missing/);
});

test("requires the current read-only origin main head for a final candidate", () => {
  const staleRemote = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.0",
    npmVersion: FINAL_NPM_VERSION,
    originMain: commit,
    remoteMain: "b".repeat(40),
    sourceDirty: false,
  });
  assert.match(staleRemote.failures.join("\n"), /current origin refs\/heads\/main/);
  assert.equal(staleRemote.remoteRefMatches, false);

  const unavailableRemote = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.0",
    npmVersion: FINAL_NPM_VERSION,
    originMain: commit,
    remoteMain: "",
    sourceDirty: false,
  });
  assert.match(unavailableRemote.failures.join("\n"), /could not be verified read-only/);
});

test("parses only one exact remote main receipt", () => {
  assert.equal(parseRemoteMainHead(`${commit}\trefs/heads/main\n`), commit);
  assert.equal(parseRemoteMainHead(`${commit}\trefs/heads/other\n`), "");
  assert.equal(parseRemoteMainHead(`${commit}\trefs/heads/main\n${commit}\trefs/heads/main\n`), "");
  assert.equal(parseRemoteMainHead("not-a-commit\trefs/heads/main\n"), "");
});

test("bounds a stalled remote lookup and reports the timeout precisely", async () => {
  let commandOptions;
  const result = await lookupRemoteMainHead({
    cwd: "/fixture",
    run: async (_command, _args, options) => {
      commandOptions = options;
      throw Object.assign(new Error("timed out"), {
        killed: true,
        signal: "SIGTERM",
      });
    },
  });

  assert.equal(commandOptions.timeout, FINAL_REMOTE_LOOKUP_TIMEOUT_MS);
  assert.equal(commandOptions.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.remoteMain, "");
  assert.match(result.remoteLookupFailure, /timed out after 20 seconds/);

  const readiness = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.0",
    npmVersion: FINAL_NPM_VERSION,
    originMain: commit,
    remoteLookupFailure: result.remoteLookupFailure,
    remoteMain: result.remoteMain,
    sourceDirty: false,
  });
  assert.match(readiness.failures.join("\n"), /timed out after 20 seconds/);
});

test("rejects toolchain drift for a final candidate", () => {
  for (const [nodeVersion, npmVersion] of [
    ["v22.14.0", FINAL_NPM_VERSION],
    ["v26.5.1", FINAL_NPM_VERSION],
    ["v22.13.0", "11.17.0"],
  ]) {
    const result = evaluateReleaseReadiness({
      head: commit,
      nodeVersion,
      npmVersion,
      originMain: commit,
      remoteMain: commit,
      sourceDirty: false,
    });
    assert.match(result.failures.join("\n"), /Final releases require Node 22\.13\.x/);
  }
});

test("explicit preparation overrides pass but permanently mark the result development-only", () => {
  const result = evaluateReleaseReadiness({
    allowDirtyDevelopment: true,
    allowToolchainMismatchDevelopment: true,
    allowUnpushedDevelopment: true,
    head: commit,
    nodeVersion: "v26.5.1",
    npmVersion: "11.17.0",
    originMain: "b".repeat(40),
    remoteMain: "",
    sourceDirty: true,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.developmentOnly, true);
  assert.equal(result.toolchainMatches, false);
  assert.equal(result.trackingRefMatches, false);
  assert.equal(result.remoteRefMatches, false);
});

test("a dirty worktree is never called a final candidate", () => {
  const result = evaluateReleaseReadiness({
    head: commit,
    nodeVersion: "v22.13.0",
    npmVersion: FINAL_NPM_VERSION,
    originMain: commit,
    remoteMain: commit,
    sourceDirty: true,
  });
  assert.match(result.failures.join("\n"), /worktree is dirty/);
  assert.equal(result.developmentOnly, false);
});

test("CI keeps pull requests development-only and reserves final artifacts for main", async () => {
  const workflow = await readFile(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
  assert.match(
    workflow,
    /if \[ "\$GITHUB_EVENT_NAME" = "pull_request" \]; then\s+release_preparation_args\+=\(--allow-unpushed-development\)/,
  );
  assert.match(
    workflow,
    /production-container[\s\S]*?github\.event_name == 'push'[\s\S]*?github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(
    workflow,
    /Upload verified production release[\s\S]*?github\.event_name == 'push'[\s\S]*?github\.ref == 'refs\/heads\/main'/,
  );
  assert.doesNotMatch(
    workflow,
    /git update-ref refs\/remotes\/origin\/main/,
  );
});
