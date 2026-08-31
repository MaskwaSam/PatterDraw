#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const FINAL_NODE_VERSION_PATTERN = /^v22\.13\.\d+$/;
export const FINAL_NPM_VERSION = "11.12.1";
export const FINAL_TRACKING_REF = "refs/remotes/origin/main";
export const FINAL_REMOTE_REF = "refs/heads/main";
export const FINAL_REMOTE_LOOKUP_TIMEOUT_MS = 20_000;

function isCommit(value) {
  return /^[0-9a-f]{40}$/i.test(value || "");
}

export function parseRemoteMainHead(output) {
  const matches = String(output || "")
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/^([0-9a-f]{40})\s+refs\/heads\/main$/iu))
    .filter(Boolean);
  return matches.length === 1 ? matches[0][1].toLowerCase() : "";
}

export async function lookupRemoteMainHead({ cwd, run = execFile } = {}) {
  try {
    const { stdout } = await run(
      "git",
      ["ls-remote", "--exit-code", "origin", FINAL_REMOTE_REF],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 64 * 1024,
        timeout: FINAL_REMOTE_LOOKUP_TIMEOUT_MS,
      },
    );
    return {
      remoteLookupFailure: "",
      remoteMain: parseRemoteMainHead(stdout),
    };
  } catch (error) {
    const timedOut = error?.killed === true
      || error?.code === "ETIMEDOUT"
      || error?.signal === "SIGTERM";
    return {
      remoteLookupFailure: timedOut
        ? `The read-only origin ${FINAL_REMOTE_REF} lookup timed out after ${FINAL_REMOTE_LOOKUP_TIMEOUT_MS / 1000} seconds.`
        : "",
      remoteMain: "",
    };
  }
}

export function evaluateReleaseReadiness({
  allowDirtyDevelopment = false,
  allowToolchainMismatchDevelopment = false,
  allowUnpushedDevelopment = false,
  head,
  nodeVersion,
  npmVersion,
  originMain,
  remoteLookupFailure = "",
  remoteMain,
  sourceDirty = false,
}) {
  const failures = [];
  const toolchainMatches = FINAL_NODE_VERSION_PATTERN.test(nodeVersion)
    && npmVersion === FINAL_NPM_VERSION;
  const trackingRefMatches = isCommit(head) && head === originMain;
  const remoteRefMatches = isCommit(head) && head === remoteMain;

  if (!isCommit(head)) {
    failures.push("Unable to resolve a full HEAD commit.");
  }
  if (sourceDirty && !allowDirtyDevelopment) {
    failures.push("The source worktree is dirty; commit the reviewed source before a final release.");
  }
  if (!toolchainMatches && !allowToolchainMismatchDevelopment) {
    failures.push(
      `Final releases require Node 22.13.x and npm ${FINAL_NPM_VERSION}; received ${nodeVersion || "unknown"} and ${npmVersion || "unknown"}.`,
    );
  }
  if (!trackingRefMatches && !allowUnpushedDevelopment) {
    failures.push(
      originMain
        ? `HEAD ${head} does not exactly match the local ${FINAL_TRACKING_REF} tracking ref (${originMain}).`
        : `The local ${FINAL_TRACKING_REF} tracking ref is missing; fetch or push through the reviewed GitHub workflow before a final release.`,
    );
  }
  if (!remoteRefMatches && !allowUnpushedDevelopment) {
    failures.push(
      remoteMain
        ? `HEAD ${head} does not exactly match the current origin ${FINAL_REMOTE_REF} head (${remoteMain}).`
        : remoteLookupFailure
          || `The current origin ${FINAL_REMOTE_REF} head could not be verified read-only; check GitHub access before a final release.`,
    );
  }

  return {
    developmentOnly: allowDirtyDevelopment
      || allowToolchainMismatchDevelopment
      || allowUnpushedDevelopment,
    failures,
    remoteRefMatches,
    toolchainMatches,
    trackingRefMatches,
  };
}

async function command(commandName, args, { allowFailure = false, cwd, env } = {}) {
  try {
    const { stdout } = await execFile(commandName, args, { cwd, encoding: "utf8", env });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = error?.stderr?.trim() || error?.message || String(error);
    throw new Error(`${commandName} ${args.join(" ")} failed: ${detail}`);
  }
}

export async function inspectLocalReleaseReadiness({
  allowDirtyDevelopment = false,
  allowToolchainMismatchDevelopment = false,
  allowUnpushedDevelopment = false,
  cwd,
} = {}) {
  const remoteLookupPromise = allowUnpushedDevelopment
    ? Promise.resolve({ remoteLookupFailure: "", remoteMain: "" })
    : lookupRemoteMainHead({ cwd });
  const [head, originMain, remoteLookup, npmVersion, status] = await Promise.all([
    command("git", ["rev-parse", "HEAD"], { cwd }),
    command("git", ["rev-parse", "--verify", FINAL_TRACKING_REF], {
      allowFailure: true,
      cwd,
    }),
    remoteLookupPromise,
    command("npm", ["--version"], { allowFailure: true, cwd }),
    command("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd }),
  ]);
  const result = evaluateReleaseReadiness({
    allowDirtyDevelopment,
    allowToolchainMismatchDevelopment,
    allowUnpushedDevelopment,
    head,
    nodeVersion: process.version,
    npmVersion: npmVersion || "unavailable",
    originMain,
    remoteLookupFailure: remoteLookup.remoteLookupFailure,
    remoteMain: remoteLookup.remoteMain,
    sourceDirty: status.length > 0,
  });
  return {
    ...result,
    head,
    nodeVersion: process.version,
    npmVersion: npmVersion || "unavailable",
    originMain,
    remoteLookupFailure: remoteLookup.remoteLookupFailure,
    remoteMain: remoteLookup.remoteMain,
    sourceDirty: status.length > 0,
  };
}

export async function assertLocalReleaseReadiness(options = {}) {
  const result = await inspectLocalReleaseReadiness(options);
  if (result.failures.length > 0) {
    throw new Error([
      "Release readiness failed:",
      ...result.failures.map((failure) => `- ${failure}`),
      "Preparation-only checks may use --allow-dirty-development, --allow-unpushed-development, and/or --allow-toolchain-mismatch-development. Those overrides must never be used for deployment.",
    ].join("\n"));
  }
  return result;
}

function parseArguments(argv) {
  const options = {
    allowDirtyDevelopment: false,
    allowToolchainMismatchDevelopment: false,
    allowUnpushedDevelopment: false,
  };
  for (const argument of argv) {
    if (argument === "--allow-dirty-development") {
      options.allowDirtyDevelopment = true;
    } else if (argument === "--allow-toolchain-mismatch-development") {
      options.allowToolchainMismatchDevelopment = true;
    } else if (argument === "--allow-unpushed-development") {
      options.allowUnpushedDevelopment = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: node scripts/release-readiness.mjs [development overrides]

Performs a non-mutating final-release gate. It never fetches or pushes, but a
final candidate performs a read-only git ls-remote lookup. It requires Node
22.13.x, npm 11.12.1, and HEAD to exactly equal both the local
refs/remotes/origin/main tracking ref and the current origin refs/heads/main.

Preparation-only overrides:
  --allow-dirty-development
  --allow-unpushed-development
  --allow-toolchain-mismatch-development
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await assertLocalReleaseReadiness({
    ...options,
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  });
  console.log(`Release readiness: ${result.developmentOnly ? "development preparation only" : "final candidate"}`);
  console.log(`HEAD: ${result.head}`);
  console.log(`${FINAL_TRACKING_REF}: ${result.originMain || "missing"}`);
  console.log(`origin ${FINAL_REMOTE_REF}: ${result.remoteMain || "unverified"}`);
  console.log(`Toolchain: Node ${result.nodeVersion}, npm ${result.npmVersion}`);
  console.log(`Worktree dirty: ${result.sourceDirty}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`release-readiness: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
