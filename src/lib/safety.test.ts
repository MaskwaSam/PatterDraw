import { describe, expect, it } from "vitest";
import type { ClassroomProject, SerializedScene } from "../types";
import { assertSafeProject, sanitizeProject, sanitizeScene, sanitizeWebLink } from "./safety";
import { MATH_TOOL_CATALOGUE } from "./math-tools/catalogue";

const scene = (elements: readonly Record<string, unknown>[]): SerializedScene => ({
  id: "scene-1",
  name: "Test",
  elements,
  appState: {},
  files: {},
});

describe("student safety", () => {
  it("removes iframe and embeddable elements while preserving safe web links", () => {
    const safe = sanitizeScene(scene([
      { id: "shape", type: "rectangle", link: "https://example.com/lesson" },
      { id: "unsafe", type: "rectangle", link: "javascript:alert(1)" },
      { id: "embed", type: "embeddable", link: "https://example.com" },
      { id: "iframe", type: "iframe" },
      { id: "generated", type: "magicframe" },
    ]));
    expect(safe.elements).toEqual([
      { id: "shape", type: "rectangle", link: "https://example.com/lesson" },
      { id: "unsafe", type: "rectangle", link: null },
    ]);
  });

  it("allows only HTTP and HTTPS hyperlink schemes", () => {
    expect(sanitizeWebLink(" https://example.com/lesson ")).toBe("https://example.com/lesson");
    expect(sanitizeWebLink("http://localhost:5173/help")).toBe("http://localhost:5173/help");
    expect(sanitizeWebLink("mailto:teacher@example.com")).toBeNull();
    expect(sanitizeWebLink("javascript:alert(1)")).toBeNull();
    expect(sanitizeWebLink("data:text/html,unsafe")).toBeNull();
  });

  it("sanitizes every scene in a project", () => {
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Test",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "scene-1",
      scenes: { "scene-1": scene([{ id: "a", type: "rectangle", link: "mailto:test@example.com" }]) },
      slideOrder: [],
      pdfDocuments: {},
    } satisfies ClassroomProject;
    expect(sanitizeProject(project).scenes["scene-1"].elements[0].link).toBeNull();
  });

  it("rejects duplicate or dangling PDF page-order entries", () => {
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Test",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: {
        page: {
          ...scene([]),
          id: "page",
          pdfPage: { documentId: "pdf", pageIndex: 0, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
        },
      },
      slideOrder: [],
      pdfPageOrder: ["page", "page"],
      pdfDocuments: {
        pdf: { id: "pdf", name: "source.pdf", mimeType: "application/pdf", byteLength: 1, pageCount: 1, archivePath: "documents/pdf.pdf" },
      },
    } satisfies ClassroomProject;
    expect(() => assertSafeProject(project)).toThrow(/duplicate/);
    expect(() => assertSafeProject({ ...project, pdfPageOrder: ["missing"] })).toThrow(/invalid page scene/);
  });

  it("rejects a PDF scene with an out-of-range immutable source-page index", () => {
    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Test",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "page",
      scenes: {
        page: {
          ...scene([]),
          id: "page",
          pdfPage: { documentId: "pdf", pageIndex: 2, width: 600, height: 800, rotation: 0, backgroundElementId: "background" },
        },
      },
      slideOrder: [],
      pdfPageOrder: ["page"],
      pdfDocuments: {
        pdf: { id: "pdf", name: "source.pdf", mimeType: "application/pdf", byteLength: 1, pageCount: 1, archivePath: "documents/pdf.pdf" },
      },
    } satisfies ClassroomProject;
    expect(() => assertSafeProject(project)).toThrow(/source-page index/);
  });

  it("preserves valid math metadata and strips or rejects invalid imported metadata", () => {
    const generated = MATH_TOOL_CATALOGUE.find((tool) => tool.kind === "ruler")!.generate({ kind: "ruler" });
    if ("pieces" in generated) throw new Error("Ruler must be a single tool.");
    const ruler = generated.metadata;
    const validScene = scene([{ id: "ruler", type: "image", customData: { classroomMathTool: ruler } }]);
    expect((sanitizeScene(validScene).elements[0].customData as Record<string, unknown>).classroomMathTool).toEqual(ruler);

    const invalidScene = scene([{ id: "bad", type: "image", customData: { classroomMathTool: { ...ruler, naturalWidth: -1 }, note: "keep" } }]);
    expect(sanitizeScene(invalidScene).elements[0].customData).toEqual({ note: "keep" });

    const project = {
      schemaVersion: 1,
      id: "project",
      title: "Test",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      activeSceneId: "scene-1",
      scenes: { "scene-1": invalidScene },
      slideOrder: [],
      pdfDocuments: {},
    } satisfies ClassroomProject;
    expect(() => assertSafeProject(project)).toThrow(/math tool/);
  });
});
