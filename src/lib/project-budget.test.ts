import { describe, expect, it } from "vitest";
import { createBlankProject } from "../types";
import {
  assertProjectCanAcceptAdditionalBytes,
  assertProjectFitsContentBudget,
  getJsonUtf8ByteLength,
  getProjectContentSize,
} from "./project-budget";

describe("project content budget", () => {
  it("measures formatted JSON exactly without building a complete encoded copy", () => {
    const samples: unknown[] = [
      createBlankProject(),
      { text: "plain", escaped: "\"\\\n\t", emoji: "🐺", loneSurrogate: "\ud800" },
      { nested: [{ value: 1 }, undefined, Number.POSITIVE_INFINITY], omitted: undefined },
      [],
      {},
    ];
    const encoder = new TextEncoder();
    for (const sample of samples) {
      expect(getJsonUtf8ByteLength(sample)).toBe(
        encoder.encode(JSON.stringify(sample, null, 2)).byteLength,
      );
    }
  });

  it("counts the UTF-8 manifest and original PDF bytes", () => {
    const project = createBlankProject();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "source.pdf",
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };

    const size = getProjectContentSize(project, { pdf: bytes });
    expect(size.pdfBytes).toBe(4);
    expect(size.manifestBytes).toBeGreaterThan(100);
    expect(size.totalBytes).toBe(size.manifestBytes + size.pdfBytes);
  });

  it("rejects content before an oversized project is committed", () => {
    const project = createBlankProject();
    project.title = "worksheet".repeat(100);
    project.titleMode = "custom";
    expect(() => assertProjectFitsContentBudget(project, {}, 256))
      .toThrow("complete project is too large");
  });

  it("rejects missing PDF bytes while measuring the project", () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "missing.pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    expect(() => getProjectContentSize(project, {})).toThrow(/does not match/);
  });

  it("preflights additional source bytes before expensive PDF rendering", () => {
    const project = createBlankProject();
    const current = getProjectContentSize(project, {});
    expect(() => assertProjectCanAcceptAdditionalBytes(
      project,
      {},
      32,
      current.totalBytes + 31,
    )).toThrow(/complete project is too large/);
  });
});
