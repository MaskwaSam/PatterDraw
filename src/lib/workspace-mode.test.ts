import { describe, expect, it } from "vitest";
import type { ClassroomProject, SerializedScene } from "../types";
import { boardSceneId, projectForBoardStartup, workspaceModeClassName } from "./workspace-mode";

describe("workspace mode layout", () => {
  it.each([
    ["board", "is-board-mode"],
    ["slides", "is-slide-mode"],
    ["pdf", "is-pdf-mode"],
  ] as const)("maps %s to the matching shell class", (mode, expected) => {
    expect(workspaceModeClassName(mode)).toBe(expected);
  });
});

describe("board scene routing", () => {
  const scene = (id: string, pdf = false): SerializedScene => ({
    id,
    name: id,
    elements: [],
    appState: {},
    files: {},
    ...(pdf ? {
      pdfPage: { documentId: "doc", pageIndex: 0, width: 100, height: 100, rotation: 0, backgroundElementId: "bg" },
    } : {}),
  });

  const project = (activeSceneId: string, scenes: Record<string, SerializedScene>) => ({
    schemaVersion: 1,
    id: "project",
    title: "Test",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    activeSceneId,
    scenes,
    slideOrder: [],
    pdfPageOrder: [],
    pdfDocuments: {},
  }) satisfies ClassroomProject;

  it("keeps an active board scene", () => {
    expect(boardSceneId(project("board", { board: scene("board"), page: scene("page", true) }))).toBe("board");
  });

  it("routes away from a PDF page when entering board or slide mode", () => {
    expect(boardSceneId(project("page", { page: scene("page", true), board: scene("board") }))).toBe("board");
  });

  it("reports when a project contains only PDF pages", () => {
    expect(boardSceneId(project("page", { page: scene("page", true) }))).toBeNull();
  });

  it("opens a PDF-active project on its existing board scene", () => {
    const saved = project("page", { page: scene("page", true), board: scene("board") });
    const started = projectForBoardStartup(saved);
    expect(started.activeSceneId).toBe("board");
    expect(started.scenes.page).toBe(saved.scenes.page);
  });

  it("adds a board scene when a project contains only PDF pages", () => {
    const saved = project("page", { page: scene("page", true) });
    const started = projectForBoardStartup(saved);
    expect(started.activeSceneId).not.toBe("page");
    expect(started.scenes[started.activeSceneId]?.pdfPage).toBeUndefined();
    expect(started.scenes.page).toBe(saved.scenes.page);
  });
});
