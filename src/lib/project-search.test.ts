import { describe, expect, it } from "vitest";
import type { ClassroomProject, SerializedScene } from "../types";
import { createBlankProject } from "../types";
import { slideFrameCustomData } from "./slides";
import { searchProjectText } from "./project-search";

function element(
  id: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    frameId: null,
    groupIds: [],
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    index: id,
    seed: 1,
    updated: 1,
    locked: false,
    opacity: 100,
    text: type === "text" ? "" : undefined,
    ...overrides,
  };
}

function scene(
  id: string,
  name: string,
  elements: readonly Record<string, unknown>[],
  pdfPage?: SerializedScene["pdfPage"],
): SerializedScene {
  return {
    id,
    name,
    elements,
    appState: {},
    files: {},
    ...(pdfPage ? { pdfPage } : {}),
  };
}

function projectWithScenes(scenes: Record<string, SerializedScene>): ClassroomProject {
  const project = createBlankProject(new Date("2026-01-01T00:00:00.000Z"));
  project.activeSceneId = Object.keys(scenes)[0] || project.activeSceneId;
  project.scenes = scenes;
  project.slideOrder = [];
  project.pdfPageOrder = [];
  project.pdfDocuments = {};
  return project;
}

describe("searchProjectText", () => {
  it("returns no results for empty queries and malformed project data", () => {
    const project = projectWithScenes({ board: scene("board", "Board", []) });
    expect(searchProjectText(project, "")).toEqual([]);
    expect(searchProjectText(project, "   \n\t ")).toEqual([]);
    expect(searchProjectText(null as unknown as ClassroomProject, "text")).toEqual([]);
    expect(searchProjectText({ scenes: { broken: null } } as unknown as ClassroomProject, "text")).toEqual([]);
    expect(searchProjectText({ scenes: { broken: { elements: [null, 4, "text"] } } } as unknown as ClassroomProject, "text")).toEqual([]);
  });

  it("matches case, diacritics, and collapsed whitespace while preserving display text", () => {
    const original = "  Café\tde\njà vu  ";
    const project = projectWithScenes({
      board: scene("board", "Canvas", [element("text-1", "text", { text: original })]),
    });

    const results = searchProjectText(project, "CAFE   DE JA VU");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      key: "board:text-1",
      text: original,
      scope: "board",
      contextLabel: "Canvas",
    });
  });

  it("excludes deleted, non-text, empty-id, and malformed text elements", () => {
    const project = projectWithScenes({
      board: scene("board", "Canvas", [
        element("live", "text", { text: "needle" }),
        element("deleted", "text", { text: "needle", isDeleted: true }),
        element("shape", "rectangle", { text: "needle" }),
        element("", "text", { text: "needle" }),
        element("missing-text", "text", { text: 42 }),
        { id: "no-type", text: "needle", isDeleted: false },
      ]),
    });

    expect(searchProjectText(project, "needle").map((result) => result.elementId)).toEqual(["live"]);
  });

  it("classifies board, slide, and PDF text in deterministic navigation order", () => {
    const slideFrame = element("frame", "frame", {
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      customData: slideFrameCustomData(undefined),
    });
    const slideText = element("slide-text", "text", {
      x: 25,
      y: 30,
      text: "needle slide",
      frameId: null,
    });
    const page = (id: string, pageIndex: number, textId: string): SerializedScene => scene(
      id,
      `${id} scene`,
      [element(textId, "text", { text: "needle PDF" })],
      {
        documentId: "lesson",
        pageIndex,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: `${id}-background`,
      },
    );
    const project = projectWithScenes({
      board: scene("board", "Board canvas", [element("board-text", "text", { text: "needle board" })]),
      slides: scene("slides", "Slide canvas", [slideFrame, slideText]),
      page1: page("page1", 0, "pdf-1"),
      page2: page("page2", 1, "pdf-2"),
    });
    project.slideOrder = [{ id: "slide-record", sceneId: "slides", frameId: "frame", title: "Opening" }];
    project.pdfDocuments = {
      lesson: {
        id: "lesson",
        name: "Lesson.pdf",
        mimeType: "application/pdf",
        byteLength: 1,
        pageCount: 2,
        archivePath: "documents/lesson.pdf",
      },
    };
    project.pdfPageOrder = ["page2", "page1"];

    expect(searchProjectText(project, "needle").map(({ elementId, scope }) => [elementId, scope])).toEqual([
      ["board-text", "board"],
      ["slide-text", "slide"],
      ["pdf-2", "pdf"],
      ["pdf-1", "pdf"],
    ]);
    const results = searchProjectText(project, "needle");
    expect(results[1]).toMatchObject({
      scope: "slide",
      slideId: "slide-record",
      slideTitle: "Opening",
      slideIndex: 0,
    });
    expect(results.slice(2)).toMatchObject([
      { scope: "pdf", pdfOutputIndex: 0, pdfSourcePageIndex: 1, pdfDocumentName: "Lesson.pdf" },
      { scope: "pdf", pdfOutputIndex: 1, pdfSourcePageIndex: 0, pdfDocumentName: "Lesson.pdf" },
    ]);
  });

  it("keeps immutable PDF source page indexes after output reordering", () => {
    const project = projectWithScenes({
      first: scene("first", "First page", [element("first-text", "text", { text: "target" })], {
        documentId: "doc",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "first-background",
      }),
      second: scene("second", "Second page", [element("second-text", "text", { text: "target" })], {
        documentId: "doc",
        pageIndex: 1,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "second-background",
      }),
    });
    project.pdfDocuments = {
      doc: {
        id: "doc",
        name: "Source.pdf",
        mimeType: "application/pdf",
        byteLength: 1,
        pageCount: 2,
        archivePath: "documents/source.pdf",
      },
    };
    project.pdfPageOrder = ["second", "first"];

    expect(searchProjectText(project, "target").map((result) => ({
      id: result.elementId,
      output: result.pdfOutputIndex,
      source: result.pdfSourcePageIndex,
    }))).toEqual([
      { id: "second-text", output: 0, source: 1 },
      { id: "first-text", output: 1, source: 0 },
    ]);
  });

  it("labels byte-deduplicated PDF occurrences with each selected file name", () => {
    const project = projectWithScenes({
      original: scene("original", "Original page", [element("first-text", "text", { text: "target" })], {
        documentId: "doc",
        sourceInstanceId: "source-one",
        sourceName: "periodic-table.pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "original-background",
      }),
      copy: scene("copy", "Copy page", [element("copy-text", "text", { text: "target" })], {
        documentId: "doc",
        sourceInstanceId: "source-two",
        sourceName: "chemistry-reference.pdf",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        backgroundElementId: "copy-background",
      }),
    });
    project.pdfDocuments = {
      doc: {
        id: "doc",
        name: "periodic-table.pdf",
        mimeType: "application/pdf",
        byteLength: 1,
        pageCount: 1,
        archivePath: "documents/doc.pdf",
      },
    };
    project.pdfPageOrder = ["original", "copy"];

    expect(searchProjectText(project, "target").map((result) => result.pdfDocumentName)).toEqual([
      "periodic-table.pdf",
      "chemistry-reference.pdf",
    ]);
  });

  it("assigns overlapping slide content to the first matching explicit slide only", () => {
    const firstFrame = element("frame-a", "frame", {
      x: 0,
      y: 0,
      width: 220,
      height: 160,
      customData: slideFrameCustomData(undefined),
    });
    const secondFrame = element("frame-b", "frame", {
      x: 100,
      y: 0,
      width: 220,
      height: 160,
      customData: slideFrameCustomData(undefined),
    });
    const project = projectWithScenes({
      canvas: scene("canvas", "Canvas", [
        firstFrame,
        secondFrame,
        element("detached", "text", { x: 130, y: 40, text: "overlap" }),
      ]),
    });
    project.slideOrder = [
      { id: "slide-b", sceneId: "canvas", frameId: "frame-b", title: "Second" },
      { id: "slide-a", sceneId: "canvas", frameId: "frame-a", title: "First" },
    ];

    const results = searchProjectText(project, "overlap");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      key: "canvas:detached",
      scope: "slide",
      slideId: "slide-b",
      slideTitle: "Second",
      slideIndex: 0,
    });
  });

  it("does not mutate the project or its nested scene data", () => {
    const project = projectWithScenes({
      board: scene("board", "Board", [element("text", "text", { text: "target" })]),
    });
    const snapshot = structuredClone(project);
    searchProjectText(project, "target");
    expect(project).toEqual(snapshot);
  });
});
