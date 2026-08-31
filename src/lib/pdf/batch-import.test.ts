import { describe, expect, it, vi } from "vitest";
import {
  createBlankProject,
  type ClassroomProject,
  type PdfDocumentSource,
  type SerializedScene,
} from "../../types";
import type { ImportedPdf, ImportPdfOptions } from "./import-pdf";
import type { PdfImportSelection } from "./import-selection";
import {
  importPdfBatchAtomically,
  PdfBatchImportSelectionError,
} from "./batch-import";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function source(id: string, sha256: string, byteLength: number, pageCount: number): PdfDocumentSource {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    byteLength,
    sha256,
    pageCount,
    archivePath: `documents/${id}.pdf`,
  };
}

function pdfScene(
  id: string,
  documentId: string,
  pageIndex: number,
  sourceInstanceId = documentId,
  sourceName = `${documentId}.pdf`,
): SerializedScene {
  return {
    id,
    name: `${sourceName} — page ${pageIndex + 1}`,
    elements: [],
    appState: {},
    files: {},
    pdfPage: {
      documentId,
      sourceInstanceId,
      sourceName,
      pageIndex,
      width: 612,
      height: 792,
      rotation: 0,
      backgroundElementId: `background-${id}`,
    },
  };
}

function baseProject(): { project: ClassroomProject; pdfBytes: Record<string, Uint8Array> } {
  const project = createBlankProject(new Date("2026-08-20T00:00:00.000Z"));
  const board = project.activeSceneId;
  const page = pdfScene("main-page", "main-document", 0, "main-instance", "main.pdf");
  project.scenes = { [board]: project.scenes[board], [page.id]: page };
  project.activeSceneId = page.id;
  project.pdfPageOrder = [page.id];
  project.pdfDocuments = {
    "main-document": source("main-document", SHA_A, 4, 1),
  };
  return { project, pdfBytes: { "main-document": new Uint8Array(4) } };
}

function selection(
  id: string,
  file: File,
  sha256: string,
  pageCount: number,
  sourcePageIndices: readonly number[],
): PdfImportSelection {
  return { file, pageCount, sha256, sourceInstanceId: id, sourcePageIndices };
}

function importer() {
  let call = 0;
  return vi.fn(async (file: File, options: ImportPdfOptions): Promise<ImportedPdf> => {
    const documentId = options.documentId || `new-document-${call}`;
    const indices = options.sourcePageIndices || [];
    const scenes = indices.map((pageIndex, index) => pdfScene(
      `inserted-${call}-${index}`,
      documentId,
      pageIndex,
      options.sourceInstanceId || documentId,
      options.sourceName || file.name,
    ));
    const sha256 = options.inspection?.sha256 || "c".repeat(64);
    const result = {
      source: source(documentId, sha256, file.size, options.inspection?.pageCount || 1),
      bytes: new Uint8Array(file.size),
      scenes,
      rasterUsage: { encodedBytes: scenes.length, pixels: scenes.length },
    };
    call += 1;
    return result;
  });
}

describe("atomic multi-PDF insertion", () => {
  it("keeps explicit file/page order, immutable source indices, and activates the first inserted page", async () => {
    const { project, pdfBytes } = baseProject();
    const first = new File([new Uint8Array(8)], "periodic-table.pdf", { type: "application/pdf" });
    const second = new File([new Uint8Array(8)], "renamed-copy.pdf", { type: "application/pdf" });
    const importOne = importer();

    const result = await importPdfBatchAtomically(
      project,
      pdfBytes,
      [
        selection("periodic-instance", first, SHA_B, 3, [2, 0, 2]),
        selection("copy-instance", second, SHA_B, 3, [1]),
      ],
      "after",
      "main-page",
      { importOne, now: () => "2026-08-20T01:00:00.000Z" },
    );

    expect(result.project.pdfPageOrder).toEqual([
      "main-page",
      "inserted-0-0",
      "inserted-0-1",
      "inserted-0-2",
      "inserted-1-0",
    ]);
    expect(result.project.activeSceneId).toBe("inserted-0-0");
    expect(result.insertedSceneIds).toEqual([
      "inserted-0-0", "inserted-0-1", "inserted-0-2", "inserted-1-0",
    ]);
    expect(result.insertedSceneIds.map((id) => result.project.scenes[id].pdfPage?.pageIndex))
      .toEqual([2, 0, 2, 1]);
    expect(result.project.scenes["inserted-1-0"].pdfPage).toEqual(expect.objectContaining({
      documentId: "new-document-0",
      sourceInstanceId: "copy-instance",
      sourceName: "renamed-copy.pdf",
    }));
    expect(Object.keys(result.project.pdfDocuments)).toHaveLength(2);
    expect(Object.keys(result.pdfBytes)).toHaveLength(2);
    expect(importOne.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      documentId: "new-document-0",
      documentPosition: 2,
      documentTotal: 2,
      sourcePageIndices: [1],
    }));
  });

  it.each([
    ["before", ["inserted-0-0", "main-page"]],
    ["end", ["main-page", "inserted-0-0"]],
  ] as const)("supports %s placement", async (placement, expectedOrder) => {
    const { project, pdfBytes } = baseProject();
    const file = new File([new Uint8Array(6)], "supplement.pdf", { type: "application/pdf" });
    const result = await importPdfBatchAtomically(
      project,
      pdfBytes,
      [selection("supplement-instance", file, SHA_B, 1, [0])],
      placement,
      "main-page",
      { importOne: importer() },
    );
    expect(result.project.pdfPageOrder).toEqual(expectedOrder);
  });

  it("rejects a batch failure without mutating the caller's project or byte map", async () => {
    const { project, pdfBytes } = baseProject();
    const projectBefore = structuredClone(project);
    const bytesBefore = pdfBytes["main-document"].slice();
    const files = [
      new File([new Uint8Array(5)], "one.pdf", { type: "application/pdf" }),
      new File([new Uint8Array(7)], "broken.pdf", { type: "application/pdf" }),
    ];
    const firstResult = importer();
    const importOne = vi.fn(async (file: File, options: ImportPdfOptions) => {
      if (file.name === "broken.pdf") throw new Error("The second PDF is malformed.");
      return firstResult(file, options);
    });

    const failure = importPdfBatchAtomically(
      project,
      pdfBytes,
      [
        selection("one", files[0], SHA_B, 1, [0]),
        selection("broken", files[1], "c".repeat(64), 1, [0]),
      ],
      "after",
      "main-page",
      { importOne },
    );
    await expect(failure).rejects.toThrow("second PDF is malformed");
    await expect(failure).rejects.toMatchObject({
      name: "PdfBatchImportSelectionError",
      selectionIndex: 1,
      sourceInstanceId: "broken",
      fileName: "broken.pdf",
      cause: expect.any(Error),
    });

    expect(project).toEqual(projectBefore);
    expect(pdfBytes).toEqual({ "main-document": bytesBefore });
    expect(project.pdfPageOrder).toEqual(["main-page"]);
  });

  it("preserves AbortError instead of classifying cancellation as a source failure", async () => {
    const { project, pdfBytes } = baseProject();
    const abort = new DOMException("cancelled", "AbortError");
    const file = new File([new Uint8Array(5)], "cancelled.pdf", { type: "application/pdf" });

    await expect(importPdfBatchAtomically(
      project,
      pdfBytes,
      [selection("cancelled", file, SHA_B, 1, [0])],
      "after",
      "main-page",
      { importOne: vi.fn(async () => { throw abort; }) },
    )).rejects.toBe(abort);
    expect(abort).not.toBeInstanceOf(PdfBatchImportSelectionError);
  });

  it("discards staged pages when cancellation arrives after a document render", async () => {
    const { project, pdfBytes } = baseProject();
    const projectBefore = structuredClone(project);
    const controller = new AbortController();
    const render = importer();
    const importOne = vi.fn(async (file: File, options: ImportPdfOptions) => {
      const result = await render(file, options);
      controller.abort();
      return result;
    });
    const file = new File([new Uint8Array(5)], "cancelled.pdf", { type: "application/pdf" });

    await expect(importPdfBatchAtomically(
      project,
      pdfBytes,
      [selection("cancelled", file, SHA_B, 1, [0])],
      "after",
      "main-page",
      { importOne, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(project).toEqual(projectBefore);
    expect(Object.keys(pdfBytes)).toEqual(["main-document"]);
  });

  it("reuses a source already in the project without replacing its bytes or metadata", async () => {
    const { project, pdfBytes } = baseProject();
    const originalBytes = pdfBytes["main-document"];
    const originalSource = project.pdfDocuments["main-document"];
    const file = new File([new Uint8Array(4)], "same-bytes-new-name.pdf", {
      type: "application/pdf",
    });
    const importOne = importer();

    const result = await importPdfBatchAtomically(
      project,
      pdfBytes,
      [selection("same-source-instance", file, SHA_A, 1, [0])],
      "end",
      "main-page",
      { importOne },
    );

    expect(importOne.mock.calls[0]?.[1].documentId).toBe("main-document");
    expect(result.project.pdfDocuments).toEqual({ "main-document": originalSource });
    expect(result.pdfBytes["main-document"]).toBe(originalBytes);
    expect(result.project.scenes["inserted-0-0"].pdfPage).toEqual(expect.objectContaining({
      documentId: "main-document",
      sourceInstanceId: "same-source-instance",
      sourceName: "same-bytes-new-name.pdf",
      pageIndex: 0,
    }));
  });

  it("rejects capacity overflow before rendering any selected file", async () => {
    const { project, pdfBytes } = baseProject();
    for (let index = Object.keys(project.scenes).length; index < 512; index += 1) {
      const id = `filler-${index}`;
      project.scenes[id] = {
        id,
        name: id,
        elements: [],
        appState: {},
        files: {},
      };
    }
    const importOne = importer();
    const file = new File([new Uint8Array(5)], "overflow.pdf", { type: "application/pdf" });

    await expect(importPdfBatchAtomically(
      project,
      pdfBytes,
      [selection("overflow", file, SHA_B, 1, [0])],
      "after",
      "main-page",
      { importOne },
    )).rejects.toThrow("reached its page and scene limit");
    expect(importOne).not.toHaveBeenCalled();
  });

  it("rejects a 501st output PDF page before rendering despite spare scene slots", async () => {
    const { project, pdfBytes } = baseProject();
    for (let index = 1; index < 499; index += 1) {
      const page = pdfScene(`existing-${index}`, "main-document", 0);
      project.scenes[page.id] = page;
      project.pdfPageOrder?.push(page.id);
    }
    const importOne = importer();
    const file = new File([new Uint8Array(5)], "two-more.pdf", { type: "application/pdf" });

    await expect(importPdfBatchAtomically(
      project,
      pdfBytes,
      [selection("overflow", file, SHA_B, 2, [0, 1])],
      "after",
      "main-page",
      { importOne },
    )).rejects.toThrow("at most 1 more PDF page");
    expect(Object.keys(project.scenes).length).toBeLessThan(512);
    expect(importOne).not.toHaveBeenCalled();
  });

  it("carries the remaining raster ledger across sequential source imports", async () => {
    const { project, pdfBytes } = baseProject();
    const files = [
      new File([new Uint8Array(5)], "one.pdf", { type: "application/pdf" }),
      new File([new Uint8Array(5)], "two.pdf", { type: "application/pdf" }),
    ];
    const render = importer();
    let call = 0;
    const importOne = vi.fn(async (file: File, options: ImportPdfOptions) => {
      const imported = await render(file, options);
      const pixels = call++ === 0 ? 6 : 4;
      return { ...imported, rasterUsage: { encodedBytes: pixels, pixels } };
    });
    const rasterBudget = {
      maxEdge: 100,
      maxPixelsPerPage: 10,
      maxPixelsPerDocument: 10,
    } as const;

    await expect(importPdfBatchAtomically(
      project,
      pdfBytes,
      [
        selection("one", files[0], SHA_B, 1, [0]),
        selection("two", files[1], "c".repeat(64), 1, [0]),
      ],
      "after",
      "main-page",
      { importOne, rasterBudget },
    )).resolves.toMatchObject({ insertedSceneIds: ["inserted-0-0", "inserted-1-0"] });
    expect(importOne.mock.calls.map(([, options]) => options.maxRasterPixelsForImport))
      .toEqual([10, 4]);
    expect(importOne.mock.calls.map(([, options]) => options.maxEncodedBytesPerDocument))
      .toEqual([40, 34]);
  });

  it("rejects a staged raster overflow atomically", async () => {
    const { project, pdfBytes } = baseProject();
    const projectBefore = structuredClone(project);
    const files = [
      new File([new Uint8Array(5)], "one.pdf", { type: "application/pdf" }),
      new File([new Uint8Array(5)], "too-much.pdf", { type: "application/pdf" }),
    ];
    const render = importer();
    let call = 0;
    const importOne = vi.fn(async (file: File, options: ImportPdfOptions) => {
      const imported = await render(file, options);
      const pixels = call++ === 0 ? 6 : 5;
      return { ...imported, rasterUsage: { encodedBytes: pixels, pixels } };
    });

    await expect(importPdfBatchAtomically(
      project,
      pdfBytes,
      [
        selection("one", files[0], SHA_B, 1, [0]),
        selection("too-much", files[1], "c".repeat(64), 1, [0]),
      ],
      "after",
      "main-page",
      {
        importOne,
        rasterBudget: { maxEdge: 100, maxPixelsPerPage: 10, maxPixelsPerDocument: 10 },
      },
    )).rejects.toThrow(/persisted images are too large/i);
    expect(project).toEqual(projectBefore);
    expect(Object.keys(pdfBytes)).toEqual(["main-document"]);
  });
});
