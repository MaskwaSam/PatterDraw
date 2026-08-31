import { describe, expect, it } from "vitest";
import { createBlankProject, type ClassroomProject } from "../../types";
import { getProjectContentSize } from "../project-budget";
import { getPdfStorageAdmissionRequirement } from "./storage-admission";

function source(id: string, bytes: Uint8Array, sha256: string) {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf" as const,
    byteLength: bytes.byteLength,
    sha256,
    pageCount: 1,
    archivePath: `documents/${id}.pdf`,
  };
}

function withPdfBackground(
  project: ClassroomProject,
  documentId: string,
  dataUrl: string,
  pageIdentity = "page",
): ClassroomProject {
  const sceneId = `${documentId}-${pageIdentity}`;
  const backgroundElementId = `${sceneId}-background`;
  const fileId = `${sceneId}-file`;
  return {
    ...project,
    activeSceneId: sceneId,
    scenes: {
      ...project.scenes,
      [sceneId]: {
        id: sceneId,
        name: `${documentId}.pdf page 1`,
        elements: [{ id: backgroundElementId, type: "image", fileId }],
        appState: {},
        files: {
          [fileId]: {
            id: fileId,
            mimeType: "image/png",
            dataURL: dataUrl,
          },
        },
        pdfPage: {
          documentId,
          sourceInstanceId: `${documentId}-instance`,
          sourceName: `${documentId}.pdf`,
          pageIndex: 0,
          width: 612,
          height: 792,
          rotation: 0,
          backgroundElementId,
        },
      },
    },
    pdfPageOrder: [...(project.pdfPageOrder ?? []), sceneId],
  };
}

describe("PDF durable-storage admission", () => {
  it("measures rendered manifest files in addition to immutable source bytes", () => {
    const current = createBlankProject(new Date("2026-08-30T00:00:00.000Z"));
    const pdf = new Uint8Array(128);
    const renderedDataUrl = `data:image/png;base64,${"A".repeat(12_000)}`;
    const candidate = withPdfBackground(current, "source", renderedDataUrl);
    candidate.pdfDocuments = { source: source("source", pdf, "a".repeat(64)) };
    const currentSize = getProjectContentSize(current, {}).totalBytes;
    const candidateSize = getProjectContentSize(candidate, { source: pdf }).totalBytes;

    const admission = getPdfStorageAdmissionRequirement(
      current,
      {},
      candidate,
      { source: pdf },
      {
        minimumHeadroomBytes: 100,
        maximumHeadroomBytes: 10_000,
        headroomRatio: 0.1,
      },
    );

    expect(admission.currentContentBytes).toBe(currentSize);
    expect(admission.candidateContentBytes).toBe(candidateSize);
    expect(admission.additionalContentBytes).toBe(candidateSize - currentSize);
    expect(admission.additionalContentBytes).toBeGreaterThan(renderedDataUrl.length);
    expect(admission.requiredBytes).toBe(
      admission.additionalContentBytes + admission.safetyHeadroomBytes,
    );
  });

  it("does not count a deduplicated source blob again when another page shares it", () => {
    const blank = createBlankProject(new Date("2026-08-30T00:00:00.000Z"));
    const pdf = new Uint8Array(4_096);
    const current = withPdfBackground(blank, "shared", "data:image/png;base64,AAAA");
    current.pdfDocuments = { shared: source("shared", pdf, "b".repeat(64)) };
    const candidate = withPdfBackground(
      current,
      "shared",
      "data:image/png;base64,BBBB",
      "page-2",
    );

    const admission = getPdfStorageAdmissionRequirement(
      current,
      { shared: pdf },
      candidate,
      { shared: pdf },
      { minimumHeadroomBytes: 0, maximumHeadroomBytes: 0 },
    );

    const exactManifestGrowth = getProjectContentSize(candidate, { shared: pdf }).manifestBytes
      - getProjectContentSize(current, { shared: pdf }).manifestBytes;
    expect(admission.additionalContentBytes).toBe(exactManifestGrowth);
    expect(admission.additionalContentBytes).toBeLessThan(pdf.byteLength);
  });

  it("uses final-size growth for replacement bytes and includes unsaved live growth", () => {
    const blank = createBlankProject(new Date("2026-08-30T00:00:00.000Z"));
    const oldBytes = new Uint8Array(4_096);
    const current = withPdfBackground(blank, "replace", "data:image/png;base64,AAAA");
    current.pdfDocuments = { replace: source("replace", oldBytes, "c".repeat(64)) };
    const currentSize = getProjectContentSize(current, { replace: oldBytes }).totalBytes;

    const replacementBytes = new Uint8Array(4_096);
    const candidate: ClassroomProject = {
      ...current,
      pdfDocuments: {
        replace: source("replace", replacementBytes, "d".repeat(64)),
      },
    };
    const replacementOnly = getPdfStorageAdmissionRequirement(
      current,
      { replace: oldBytes },
      candidate,
      { replace: replacementBytes },
      { minimumHeadroomBytes: 0, maximumHeadroomBytes: 0 },
    );
    expect(replacementOnly.additionalContentBytes).toBe(0);

    const persistedBeforeUnsavedGrowth = currentSize - 512;
    const withUnsavedGrowth = getPdfStorageAdmissionRequirement(
      current,
      { replace: oldBytes },
      candidate,
      { replace: replacementBytes },
      {
        persistedContentBytes: persistedBeforeUnsavedGrowth,
        minimumHeadroomBytes: 0,
        maximumHeadroomBytes: 0,
      },
    );
    expect(withUnsavedGrowth.additionalContentBytes).toBe(512);
  });
});
