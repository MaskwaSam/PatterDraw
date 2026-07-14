import { describe, expect, it } from "vitest";
import { createBlankProject, type ClassroomProject, type SerializedScene } from "../../types";
import {
  movePdfPage,
  orderedPdfScenes,
  reconcilePdfPageOrder,
  shiftPdfPage,
} from "./page-order";

function pdfScene(id: string, documentId: string, pageIndex: number): SerializedScene {
  return {
    id,
    name: `${documentId} page ${pageIndex + 1}`,
    elements: [],
    appState: {},
    files: {},
    pdfPage: {
      documentId,
      pageIndex,
      width: 600,
      height: 800,
      rotation: 0,
      backgroundElementId: `${id}-background`,
    },
  };
}

function projectWithPages(): ClassroomProject {
  const project = createBlankProject();
  project.pdfDocuments = {
    first: { id: "first", name: "first.pdf", mimeType: "application/pdf", byteLength: 1, pageCount: 2, archivePath: "documents/first.pdf" },
    second: { id: "second", name: "second.pdf", mimeType: "application/pdf", byteLength: 1, pageCount: 1, archivePath: "documents/second.pdf" },
  };
  project.scenes = {
    ...project.scenes,
    "first-2": pdfScene("first-2", "first", 1),
    "second-1": pdfScene("second-1", "second", 0),
    "first-1": pdfScene("first-1", "first", 0),
  };
  return project;
}

describe("PDF page order", () => {
  it("derives legacy order from document insertion and immutable source-page index", () => {
    const project = projectWithPages();
    delete project.pdfPageOrder;
    expect(reconcilePdfPageOrder(project)).toEqual(["first-1", "first-2", "second-1"]);
    expect(orderedPdfScenes(project).map((scene) => scene.id)).toEqual(["first-1", "first-2", "second-1"]);
  });

  it("keeps valid explicit order, removes duplicates and orphans, and appends missing pages", () => {
    const project = projectWithPages();
    project.pdfPageOrder = ["second-1", "missing", "second-1", "first-2"];
    expect(reconcilePdfPageOrder(project)).toEqual(["second-1", "first-2", "first-1"]);
  });

  it("moves pages before or after a drop target in either direction", () => {
    const order = ["one", "two", "three", "four"];
    expect(movePdfPage(order, "one", "three", "after")).toEqual(["two", "three", "one", "four"]);
    expect(movePdfPage(order, "four", "two", "before")).toEqual(["one", "four", "two", "three"]);
    expect(movePdfPage(order, "one", "one", "after")).toEqual(order);
  });

  it("shifts pages for keyboard and touch controls without changing source identity", () => {
    const project = projectWithPages();
    const page = project.scenes["first-2"];
    const pageIndex = page.pdfPage?.pageIndex;
    expect(shiftPdfPage(["first-1", "first-2", "second-1"], "first-2", -1)).toEqual(["first-2", "first-1", "second-1"]);
    expect(shiftPdfPage(["first-1", "first-2", "second-1"], "first-1", -1)).toEqual(["first-1", "first-2", "second-1"]);
    expect(page.pdfPage?.pageIndex).toBe(pageIndex);
  });
});
