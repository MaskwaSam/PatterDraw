import { degrees, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { createBlankProject, type ClassroomProject, type SerializedScene } from "../../types";
import { sha256Hex } from "../sha256";
import { assertPdfSourceMetadata } from "./source-metadata";

async function onePagePdf(
  size: readonly [number, number] = [600, 800],
  configure?: (page: ReturnType<PDFDocument["addPage"]>) => void,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage(size as [number, number]);
  configure?.(page);
  return document.save();
}

function pageScene(
  id: string,
  pageIndex: number,
  width: number,
  height: number,
  rotation: 0 | 90 | 180 | 270,
  documentId = "pdf",
): SerializedScene {
  const backgroundElementId = `${id}-background`;
  return {
    id,
    name: id,
    elements: [{
      id: backgroundElementId,
      type: "image",
      fileId: `${id}-file`,
      x: 0,
      y: 0,
      width,
      height,
      angle: 0,
      locked: true,
      isDeleted: false,
      status: "saved",
      customData: {
        classroomRole: "pdf-background",
        pdfDocumentId: documentId,
        pdfPageIndex: pageIndex,
      },
    }],
    appState: {},
    files: {
      [`${id}-file`]: {
        id: `${id}-file`,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
      },
    },
    pdfPage: {
      documentId,
      pageIndex,
      width,
      height,
      rotation,
      backgroundElementId,
    },
  };
}

function projectFor(
  bytes: Uint8Array,
  pageCount: number,
  scenes: Record<string, SerializedScene>,
): ClassroomProject {
  const project = createBlankProject();
  project.pdfDocuments.pdf = {
    id: "pdf",
    name: "source.pdf",
    mimeType: "application/pdf",
    byteLength: bytes.byteLength,
    pageCount,
    archivePath: "documents/pdf.pdf",
  };
  project.scenes = { ...project.scenes, ...scenes };
  project.activeSceneId = Object.keys(scenes)[0] || project.activeSceneId;
  project.pdfPageOrder = Object.keys(scenes);
  return project;
}

describe("PDF source metadata preflight", () => {
  it("rejects a manifest that claims more pages than the source contains", async () => {
    const bytes = await onePagePdf();
    const project = projectFor(bytes, 2, {
      page: pageScene("page", 0, 600, 800, 0),
    });

    await expect(assertPdfSourceMetadata(project, { pdf: bytes }))
      .rejects.toThrow(/page count.*saved 2.*actual 1/i);
  });

  it("rejects stale geometry and rotation metadata", async () => {
    const bytes = await onePagePdf([600, 800], (page) => page.setRotation(degrees(90)));
    const project = projectFor(bytes, 1, {
      page: pageScene("page", 0, 600, 800, 0),
    });

    await expect(assertPdfSourceMetadata(project, { pdf: bytes }))
      .rejects.toThrow(/geometry no longer matches/i);
  });

  it("accounts for CropBox, MediaBox, UserUnit, and rotation", async () => {
    const bytes = await onePagePdf([612, 792], (page) => {
      page.setMediaBox(10, 20, 612, 792);
      page.setCropBox(72, 108, 360, 480);
      page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
      page.setRotation(degrees(90));
    });
    const project = projectFor(bytes, 1, {
      page: pageScene("page", 0, 960, 720, 90),
    });

    await expect(assertPdfSourceMetadata(project, { pdf: bytes })).resolves.toBeUndefined();
  });

  it("keeps valid page metadata when the retained order is reordered", async () => {
    const document = await PDFDocument.create();
    document.addPage([600, 800]);
    document.addPage([300, 400]);
    const bytes = await document.save();
    const project = projectFor(bytes, 2, {
      first: pageScene("first", 0, 600, 800, 0),
      second: pageScene("second", 1, 300, 400, 0),
    });
    project.pdfPageOrder = ["second", "first"];

    await expect(assertPdfSourceMetadata(project, { pdf: bytes })).resolves.toBeUndefined();
  });

  it("ignores wrapper view rotation while validating immutable source geometry", async () => {
    const bytes = await onePagePdf([600, 800]);
    const page = pageScene("page", 0, 600, 800, 0);
    page.pdfPage = { ...page.pdfPage!, viewRotation: 90 };
    const project = projectFor(bytes, 1, { page });
    await expect(assertPdfSourceMetadata(project, { pdf: bytes })).resolves.toBeUndefined();
  });

  it("normalizes negative and over-360 source rotations like PDF.js", async () => {
    const bytes = await onePagePdf([600, 800], (page) => page.setRotation(degrees(-90)));
    const project = projectFor(bytes, 1, {
      page: pageScene("page", 0, 800, 600, 270),
    });

    await expect(assertPdfSourceMetadata(project, { pdf: bytes })).resolves.toBeUndefined();
  });

  it("caches successful immutable source checks by verified SHA-256", async () => {
    const bytes = await onePagePdf();
    const project = projectFor(bytes, 1, {});
    project.pdfDocuments.pdf.sha256 = await sha256Hex(bytes);
    const loadSpy = vi.spyOn(PDFDocument, "load");

    try {
      await assertPdfSourceMetadata(project, { pdf: bytes });
      await assertPdfSourceMetadata(project, { pdf: bytes });
      expect(loadSpy).toHaveBeenCalledOnce();
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("honours abort before parsing any source", async () => {
    const bytes = await onePagePdf();
    const project = projectFor(bytes, 1, {
      page: pageScene("page", 0, 600, 800, 0),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(assertPdfSourceMetadata(project, { pdf: bytes }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
