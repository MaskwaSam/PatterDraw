import { describe, expect, it } from "vitest";
import {
  createBlankProject,
  type ClassroomProject,
  type PdfDocumentSource,
  type SerializedScene,
} from "../../types";
import { projectForPdfReplacement, replaceProjectPdf } from "./replacement";

function pdfScene(id: string, documentId: string, pageIndex: number): SerializedScene {
  return {
    id,
    name: `Page ${pageIndex + 1}`,
    elements: [{ id: `${id}-background`, type: "image", locked: true }],
    appState: {},
    files: {},
    pdfPage: {
      documentId,
      pageIndex,
      width: 612,
      height: 792,
      rotation: 0,
      backgroundElementId: `${id}-background`,
    },
  };
}

function source(id: string, pageCount: number): PdfDocumentSource {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    byteLength: 20,
    pageCount,
    archivePath: `documents/${id}.pdf`,
  };
}

describe("normal PDF replacement", () => {
  it("removes old PDF content while preserving board scenes and slides", () => {
    const project = createBlankProject(new Date("2026-09-01T12:00:00.000Z"));
    const boardId = project.activeSceneId;
    project.title = "Lesson board";
    project.scenes[boardId] = {
      ...project.scenes[boardId],
      elements: [{ id: "kept-frame", type: "frame" }],
    };
    project.scenes.oldPage = pdfScene("oldPage", "oldPdf", 7);
    project.pdfPageOrder = ["oldPage"];
    project.pdfDocuments = { oldPdf: source("oldPdf", 1) };
    project.slideOrder = [{
      id: "slide",
      sceneId: boardId,
      frameId: "kept-frame",
      title: "Kept slide",
    }];
    project.activeSceneId = "oldPage";

    const replacement = replaceProjectPdf(
      project,
      [pdfScene("newPage", "newPdf", 3)],
      source("newPdf", 1),
      "2026-09-01T12:01:00.000Z",
    );

    expect(replacement.title).toBe("Lesson board");
    expect(replacement.scenes[boardId]).toBe(project.scenes[boardId]);
    expect(replacement.slideOrder).toEqual(project.slideOrder);
    expect(replacement.scenes).not.toHaveProperty("oldPage");
    expect(replacement.pdfDocuments).toEqual({ newPdf: source("newPdf", 1) });
    expect(replacement.pdfPageOrder).toEqual(["newPage"]);
    expect(replacement.activeSceneId).toBe("newPage");
    expect(replacement.scenes.newPage.pdfPage?.pageIndex).toBe(3);
  });

  it("creates a board when replacing a legacy PDF-only project", () => {
    const project = createBlankProject();
    const oldPage = pdfScene("oldPage", "oldPdf", 0);
    const pdfOnly: ClassroomProject = {
      ...project,
      activeSceneId: oldPage.id,
      scenes: { [oldPage.id]: oldPage },
      pdfPageOrder: [oldPage.id],
      pdfDocuments: { oldPdf: source("oldPdf", 1) },
    };

    const base = projectForPdfReplacement(pdfOnly);

    expect(Object.values(base.scenes)).toHaveLength(1);
    expect(base.scenes[base.activeSceneId]?.pdfPage).toBeUndefined();
    expect(base.pdfPageOrder).toEqual([]);
    expect(base.pdfDocuments).toEqual({});
  });
});
