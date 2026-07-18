import { describe, expect, it } from "vitest";
import { createBlankProject, type ClassroomProject, type SerializedScene } from "../types";
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

  it("normalizes and validates the Morph slide-transition preference", () => {
    const project = createBlankProject();
    delete project.slideMorphEnabled;
    delete project.slideMorphDurationMs;
    expect(sanitizeProject(project).slideMorphEnabled).toBe(false);
    expect(sanitizeProject({ ...project, slideMorphEnabled: true }).slideMorphEnabled).toBe(true);
    expect(sanitizeProject({ ...project, slideMorphEnabled: false }).slideMorphEnabled).toBe(false);
    expect(sanitizeProject(project).slideMorphDurationMs).toBe(650);
    expect(sanitizeProject({ ...project, slideMorphDurationMs: 673 }).slideMorphDurationMs).toBe(650);
    expect(sanitizeProject({ ...project, slideMorphDurationMs: 6_000 }).slideMorphDurationMs).toBe(5_000);
    expect(() => assertSafeProject({ ...project, slideMorphEnabled: "yes" } as unknown as ClassroomProject))
      .toThrow(/Morph preference must be a boolean/);
    expect(() => assertSafeProject({ ...project, slideMorphDurationMs: 5_000 })).not.toThrow();
    expect(() => assertSafeProject({ ...project, slideMorphDurationMs: 5_001 }))
      .toThrow(/Morph duration must be between/);
  });

  it("normalizes and validates the slide-frame aspect-ratio preference", () => {
    const project = createBlankProject();
    delete project.slideFrameAspectRatio;
    delete project.slideWidescreenFrames;
    expect(sanitizeProject(project).slideFrameAspectRatio).toBe("freeform");
    expect(sanitizeProject({ ...project, slideWidescreenFrames: true }).slideFrameAspectRatio).toBe("16:9");
    expect(sanitizeProject({ ...project, slideFrameAspectRatio: "4:3" }).slideFrameAspectRatio).toBe("4:3");
    expect(() => assertSafeProject({ ...project, slideFrameAspectRatio: "3:2" } as unknown as ClassroomProject))
      .toThrow(/aspect ratio must be freeform, 16:9, or 4:3/);
    expect(() => assertSafeProject({ ...project, slideWidescreenFrames: "yes" } as unknown as ClassroomProject))
      .toThrow(/widescreen frame preference must be a boolean/);
  });

  it("migrates legacy slideOrder frames to tagged detached slides without changing schema or geometry", () => {
    const project = createBlankProject();
    const sceneId = project.activeSceneId;
    project.slideOrder = [{ id: "slide-record", sceneId, frameId: "legacy-frame", title: "Opening" }];
    project.scenes[sceneId].elements = [
      { id: "legacy-frame", type: "frame", x: 10, y: 20, width: 800, height: 450, name: "Slide 1", groupIds: [] },
      { id: "slide-child", type: "rectangle", x: 30, y: 40, width: 50, height: 60, frameId: "legacy-frame", groupIds: ["keep-group"] },
      { id: "native-frame", type: "frame", x: 900, y: 20, width: 200, height: 200, groupIds: [] },
      { id: "native-child", type: "ellipse", x: 920, y: 40, width: 40, height: 40, frameId: "native-frame", groupIds: ["native-group"] },
    ];

    const safe = sanitizeProject(project);
    const elements = safe.scenes[sceneId].elements;
    expect(safe.schemaVersion).toBe(1);
    expect(safe.slideOrder[0]).toMatchObject({ title: "Opening", titleMode: "custom" });
    expect(elements[0]).toMatchObject({
      id: "legacy-frame",
      x: 10,
      y: 20,
      width: 800,
      height: 450,
      name: "Opening",
      customData: { classroomSlide: { kind: "slide", version: 1 } },
    });
    expect(elements[1]).toMatchObject({
      x: 30,
      y: 40,
      frameId: null,
      groupIds: ["keep-group"],
    });
    expect(elements[3]).toMatchObject({ frameId: "native-frame", groupIds: ["native-group"] });
  });

  it("normalizes and validates persistent slide title ownership", () => {
    const project = createBlankProject();
    const sceneId = project.activeSceneId;
    project.slideOrder = [
      { id: "automatic", sceneId, frameId: "a", title: "Slide 1" },
      { id: "custom", sceneId, frameId: "b", title: "Slide 10" },
    ];
    expect(sanitizeProject(project).slideOrder).toMatchObject([
      { title: "Slide 1", titleMode: "automatic" },
      { title: "Slide 10", titleMode: "custom" },
    ]);
    expect(() => assertSafeProject({
      ...project,
      slideOrder: [{ ...project.slideOrder[0], titleMode: "derived" }],
    } as unknown as ClassroomProject)).toThrow(/title mode must be automatic or custom/);
  });

  it("strips invalid slide tags while sanitizing imports and rejects them during strict validation", () => {
    const invalid = scene([{
      id: "frame",
      type: "frame",
      customData: { classroomSlide: { kind: "slide", version: 99 }, note: "keep" },
    }]);
    expect(sanitizeScene(invalid).elements[0].customData).toEqual({ note: "keep" });
    const project = createBlankProject();
    project.scenes[project.activeSceneId] = { ...invalid, id: project.activeSceneId };
    expect(() => assertSafeProject(project)).toThrow(/invalid classroom metadata/);
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
