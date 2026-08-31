import { describe, expect, it } from "vitest";
import {
  encodeAutosaveHistoryProjectManifest,
  latestAutosaveHistoryForProject,
  planAutosaveHistoryCommit,
  type AutosaveHistorySummary,
} from "./autosave-history";
import { createBlankProject } from "../types";

const sha = (character: string) => character.repeat(64);

function summary(
  snapshotId: string,
  projectId: string,
  manifestBytes: number,
  pdfReferences: AutosaveHistorySummary["pdfReferences"] = [],
): AutosaveHistorySummary {
  return {
    schemaVersion: 1,
    snapshotId,
    projectId,
    title: `Project ${projectId}`,
    capturedAt: `2026-08-${String(Number(snapshotId.replace(/\D/g, "") || 1)).padStart(2, "0")}T12:00:00.000Z`,
    projectUpdatedAt: "2026-08-01T12:00:00.000Z",
    manifestSha256: sha("a"),
    manifestBytes,
    logicalBytes: manifestBytes + pdfReferences.reduce((total, entry) => total + entry.byteLength, 0),
    pdfReferences,
  };
}

describe("autosave recovery history planning", () => {
  it("keeps only the newest bounded snapshots for each project", () => {
    const incoming = summary("snapshot4", "alpha", 100);
    const plan = planAutosaveHistoryCommit([
      summary("snapshot3", "beta", 100),
      summary("snapshot2", "alpha", 100),
      summary("snapshot1", "alpha", 100),
    ], incoming, {
      maxBytes: 2 * 1024 * 1024,
      maxSnapshots: 4,
      maxSnapshotsPerProject: 2,
    });

    expect(plan.entries.map((entry) => entry.snapshotId)).toEqual([
      "snapshot4",
      "snapshot3",
      "snapshot2",
    ]);
    expect(plan.droppedSnapshotIds).toEqual(["snapshot1"]);
  });

  it("deduplicates immutable PDFs in its physical byte budget", () => {
    const sharedPdf = { sha256: sha("b"), byteLength: 600_000 };
    const incoming = summary("snapshot3", "alpha", 100_000, [sharedPdf]);
    const plan = planAutosaveHistoryCommit([
      summary("snapshot2", "beta", 100_000, [sharedPdf]),
      summary("snapshot1", "gamma", 100_000),
    ], incoming, {
      maxBytes: 2 * 1024 * 1024,
      maxSnapshots: 3,
      maxSnapshotsPerProject: 1,
    });

    expect(plan.physicalBytes).toBe(900_000);
    expect(plan.entries).toHaveLength(3);
  });

  it("prunes the oldest snapshots and reports orphaned PDF blobs", () => {
    const oldPdf = { sha256: sha("c"), byteLength: 300_000 };
    const incoming = summary("snapshot3", "alpha", 200_000);
    const plan = planAutosaveHistoryCommit([
      summary("snapshot2", "beta", 200_000),
      summary("snapshot1", "gamma", 200_000, [oldPdf]),
    ], incoming, {
      maxBytes: 2 * 1024 * 1024,
      maxSnapshots: 2,
      maxSnapshotsPerProject: 1,
    });

    expect(plan.entries.map((entry) => entry.snapshotId)).toEqual(["snapshot3", "snapshot2"]);
    expect(plan.droppedSnapshotIds).toEqual(["snapshot1"]);
    expect(plan.orphanedPdfSha256s).toEqual([oldPdf.sha256]);
  });

  it("rejects one snapshot that cannot fit its bounded local history", () => {
    const incoming = summary("snapshot1", "alpha", 1_100_000);
    expect(() => planAutosaveHistoryCommit([], incoming, {
      maxBytes: 2 * 1024 * 1024,
      maxSnapshots: 2,
      maxSnapshotsPerProject: 1,
    })).toThrow(/too large/i);
  });

  it("rejects conflicting byte lengths for one content hash", () => {
    const incoming = summary("snapshot2", "alpha", 10, [
      { sha256: sha("d"), byteLength: 20 },
    ]);
    expect(() => planAutosaveHistoryCommit([
      summary("snapshot1", "beta", 10, [
        { sha256: sha("d"), byteLength: 21 },
      ]),
    ], incoming, {
      maxBytes: 2 * 1024 * 1024,
      maxSnapshots: 2,
      maxSnapshotsPerProject: 1,
    })).toThrow(/conflicting PDF content metadata/i);
  });

  it("finds the newest recovery copy for one project", () => {
    const entries = [
      summary("snapshot3", "alpha", 10),
      summary("snapshot2", "beta", 10),
      summary("snapshot1", "alpha", 10),
    ];
    expect(latestAutosaveHistoryForProject(entries, "alpha")?.snapshotId).toBe("snapshot3");
    expect(latestAutosaveHistoryForProject(entries, "missing")).toBeNull();
  });

  it("uses capture time rather than out-of-order commit completion for recency", () => {
    const olderFinishingLate = {
      ...summary("snapshot1", "alpha", 10),
      capturedAt: "2026-08-01T12:00:00.000Z",
    };
    const newerAlreadyCommitted = {
      ...summary("snapshot2", "alpha", 10),
      capturedAt: "2026-08-02T12:00:00.000Z",
    };
    const plan = planAutosaveHistoryCommit([newerAlreadyCommitted], olderFinishingLate, {
      maxBytes: 2 * 1024 * 1024,
      maxSnapshots: 2,
      maxSnapshotsPerProject: 1,
    });

    expect(plan.entries.map((entry) => entry.snapshotId)).toEqual(["snapshot2"]);
    expect(plan.incomingRetained).toBe(false);
    expect(latestAutosaveHistoryForProject(
      [olderFinishingLate, newerAlreadyCommitted],
      "alpha",
    )?.snapshotId).toBe("snapshot2");
  });

  it("encodes recovery manifests as measurable compact UTF-8 bytes", () => {
    const project = createBlankProject();
    project.scenes[project.activeSceneId].appState = {
      localData: "A".repeat(2_000),
    };
    const manifest = encodeAutosaveHistoryProjectManifest(project);
    expect(ArrayBuffer.isView(manifest)).toBe(true);
    expect(new TextDecoder().decode(manifest)).toBe(JSON.stringify(project));
  });
});
