import { describe, expect, it } from "vitest";
import { createBlankProject, type ClassroomProject, type SerializedScene } from "../types";
import {
  assertSafeProject,
  isPersistedWrapperTool,
  isSafeLocalImageSource,
  sanitizeProject,
  sanitizeScene,
} from "./safety";
import { MAX_STRUCTURAL_DEPTH } from "./structural-limits";
import { MATH_TOOL_CATALOGUE } from "./math-tools/catalogue";

const scene = (elements: readonly Record<string, unknown>[]): SerializedScene => ({
  id: "scene-1",
  name: "Test",
  elements,
  appState: {},
  files: {},
});

const pdfScene = (id: string, pageIndex: number): SerializedScene => ({
  id,
  name: `Page ${pageIndex + 1}`,
  elements: [{
    id: `${id}-background`,
    type: "image",
    fileId: `${id}-file`,
    x: 0,
    y: 0,
    width: 600,
    height: 800,
    angle: 0,
    locked: true,
    isDeleted: false,
    opacity: 100,
    frameId: null,
    groupIds: [],
    scale: [1, 1],
    status: "saved",
    customData: {
      classroomRole: "pdf-background",
      pdfDocumentId: "pdf",
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
    documentId: "pdf",
    pageIndex,
    width: 600,
    height: 800,
    rotation: 0,
    backgroundElementId: `${id}-background`,
  },
});

describe("student safety", () => {
  it("rejects a deeply nested scene before sanitizeScene can clone it", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < MAX_STRUCTURAL_DEPTH + 1; index += 1) {
      nested = { next: nested };
    }
    expect(() => sanitizeScene(scene([{
      id: "deep",
      type: "rectangle",
      customData: nested,
    }]))).toThrow(/maximum structural depth/);
  });

  it.each([
    "Untitled classroom canvas",
    "Untitled PatterDraw project",
  ])("renames the legacy default title %s", (title) => {
    const project = createBlankProject();
    project.title = title;
    delete project.titleMode;

    expect(sanitizeProject(project)).toMatchObject({
      title: "Untitled PatterDraw canvas",
      titleMode: "default",
    });
  });

  it("preserves user-chosen project titles while normalizing branding", () => {
    const project = createBlankProject();
    project.title = "My classroom canvas";
    project.titleMode = "custom";

    expect(sanitizeProject(project)).toMatchObject({
      title: "My classroom canvas",
      titleMode: "custom",
    });
  });

  it("preserves a user-chosen title that matches a legacy default", () => {
    const project = createBlankProject();
    project.title = "Untitled classroom canvas";
    project.titleMode = "custom";

    expect(sanitizeProject(project)).toMatchObject({
      title: "Untitled classroom canvas",
      titleMode: "custom",
    });
  });

  it("rejects malformed project titles before they reach filename generation", () => {
    const project = createBlankProject();

    expect(() => assertSafeProject({ ...project, title: null } as unknown as ClassroomProject))
      .toThrow(/project title must be text/i);
    expect(() => assertSafeProject({ ...project, titleMode: "legacy" } as unknown as ClassroomProject))
      .toThrow(/project title mode/i);
  });

  it("removes iframe, embeddable, and linked elements from imported scenes", () => {
    const safe = sanitizeScene(scene([
      { id: "shape", type: "rectangle", link: "https://example.com/lesson" },
      { id: "unsafe", type: "rectangle", link: "javascript:alert(1)" },
      { id: "embed", type: "embeddable", link: "https://example.com" },
      { id: "iframe", type: "iframe" },
      { id: "generated", type: "magicframe" },
    ]));
    expect(safe.elements).toEqual([
      { id: "shape", type: "rectangle", link: null },
      { id: "unsafe", type: "rectangle", link: null },
    ]);
  });

  it.each(["classroom-bucket-fill", "classroom-lasso"])(
    "normalizes the persisted wrapper-only %s tool",
    (customType) => {
      const safe = sanitizeScene({
        ...scene([]),
        appState: {
          activeTool: {
            type: "custom",
            customType,
          locked: true,
            lastActiveTool: { type: "rectangle" },
          },
        },
      });

      expect(safe.appState.activeTool).toEqual({
        type: "selection",
        customType: null,
        locked: false,
        lastActiveTool: null,
      });
    },
  );

  it("ignores malformed persisted custom tool values", () => {
    const tool = Object.create(null) as Record<string, unknown>;
    tool.type = "custom";
    tool.customType = Object.create(null);

    expect(() => isPersistedWrapperTool(tool)).not.toThrow();
    expect(isPersistedWrapperTool(tool)).toBe(false);
  });

  it("accepts only embedded base64 image data for persisted files", () => {
    expect(isSafeLocalImageSource("data:image/png;base64,AA==")).toBe(true);
    expect(isSafeLocalImageSource("data:image/svg+xml;base64,PHN2Zy8+")).toBe(true);
    expect(isSafeLocalImageSource("design/editor-concept.png?offline-probe=1")).toBe(false);
    expect(isSafeLocalImageSource("?offline-probe=1")).toBe(false);
    expect(isSafeLocalImageSource("blob:https://classroom.local/transient")).toBe(false);
    expect(isSafeLocalImageSource("data:image/svg+xml,<svg/>")).toBe(false);
    expect(isSafeLocalImageSource("https://example.test/image.png")).toBe(false);
  });

  it("drops imported image elements when their local embedded file is rejected", () => {
    const imported = scene([
      { id: "probe", type: "image", fileId: "probe-file" },
      { id: "valid", type: "image", fileId: "valid-file" },
    ]);
    imported.files = {
      "probe-file": {
        id: "probe-file",
        mimeType: "image/png",
        dataURL: "design/editor-concept.png?offline-probe=1",
      },
      "valid-file": {
        id: "valid-file",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
      },
    };

    const safe = sanitizeScene(imported);
    expect(Object.keys(safe.files)).toEqual(["valid-file"]);
    expect(safe.elements.map((element) => element.id)).toEqual(["valid"]);
  });

  it("repairs canvas-encoded PNG bytes that Excalidraw labels as GIF", () => {
    const imported = scene([{ id: "gif", type: "image", fileId: "gif-file" }]);
    imported.files = {
      "gif-file": {
        id: "gif-file",
        mimeType: "image/gif",
        dataURL: "data:image/gif;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    };

    const safe = sanitizeScene(imported);
    expect(safe.elements.map((element) => element.id)).toEqual(["gif"]);
    expect(safe.files["gif-file"]).toMatchObject({
      mimeType: "image/png",
      dataURL: expect.stringMatching(/^data:image\/png;base64,/),
    });
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

  it("does not confuse scene and frame identities containing separator characters", () => {
    const project = createBlankProject();
    project.activeSceneId = "a";
    project.scenes = {
      a: {
        ...scene([]),
        id: "a",
      },
      ["a\u0000b"]: {
        ...scene([{ id: "c", type: "frame" }]),
        id: "a\u0000b",
      },
    };
    project.slideOrder = [{
      id: "slide",
      sceneId: "a",
      frameId: "b\u0000c",
      title: "Dangling",
    }];

    expect(() => assertSafeProject(project)).toThrow(/missing frame/);
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
        page: pdfScene("page", 0),
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

  it("rejects inherited scene names in the active scene and PDF page order", () => {
    const activeSceneProject = createBlankProject();
    activeSceneProject.activeSceneId = "toString";
    expect(() => assertSafeProject(activeSceneProject)).toThrow(/active scene is missing/);

    const pageProject = createBlankProject();
    const scenes = Object.create({ toString: pdfScene("toString", 0) }) as ClassroomProject["scenes"];
    scenes.page = pdfScene("page", 0);
    pageProject.activeSceneId = "page";
    pageProject.scenes = scenes;
    pageProject.pdfDocuments.pdf = {
      id: "pdf",
      name: "source.pdf",
      mimeType: "application/pdf",
      byteLength: 1,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    pageProject.pdfPageOrder = ["toString"];
    expect(() => assertSafeProject(pageProject)).toThrow(/invalid page scene/);
  });

  it("rejects inherited PDF document identities used by a page", () => {
    const project = createBlankProject();
    project.activeSceneId = "page";
    project.scenes.page = pdfScene("page", 0);
    project.pdfPageOrder = ["page"];
    project.pdfDocuments = Object.create({
      pdf: {
        id: "pdf",
        name: "source.pdf",
        mimeType: "application/pdf",
        byteLength: 1,
        pageCount: 1,
        archivePath: "documents/pdf.pdf",
      },
    }) as ClassroomProject["pdfDocuments"];
    expect(() => assertSafeProject(project)).toThrow(/missing source document/);
  });

  it("rejects inherited scene identities in slide order", () => {
    const project = createBlankProject();
    const activeSceneId = project.activeSceneId;
    const scenes = Object.create({
      toString: {
        ...scene([{ id: "frame", type: "frame" }]),
        id: "toString",
      },
    }) as ClassroomProject["scenes"];
    scenes[activeSceneId] = project.scenes[activeSceneId];
    project.scenes = scenes;
    project.slideOrder = [{
      id: "slide",
      sceneId: "toString",
      frameId: "frame",
      title: "Inherited",
    }];
    expect(() => assertSafeProject(project)).toThrow(/missing scene/);
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
          ...pdfScene("page", 2),
          pdfPage: {
            ...pdfScene("page", 2).pdfPage!,
            pageIndex: 2,
          },
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

  it("repairs stored PDF background transforms and rejects a missing local raster", () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "source.pdf",
      mimeType: "application/pdf",
      byteLength: 1,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    const page = pdfScene("page", 0);
    page.elements = [{
      ...page.elements[0],
      x: 100,
      locked: false,
      isDeleted: true,
      opacity: 10,
    }];
    project.scenes.page = page;

    expect(sanitizeProject(project).scenes.page.elements[0]).toMatchObject({
      id: "page-background",
      x: 0,
      y: 0,
      width: 600,
      height: 800,
      locked: true,
      isDeleted: false,
      opacity: 100,
    });

    page.files = {};
    expect(() => assertSafeProject(project)).toThrow(/missing or unsafe local image/);
  });

  it("rejects PDF document identities that alias the same archive entry", () => {
    const project = createBlankProject();
    project.pdfDocuments.first = {
      id: "first",
      name: "first.pdf",
      mimeType: "application/pdf",
      byteLength: 1,
      pageCount: 1,
      archivePath: "documents/shared.pdf",
    };
    project.pdfDocuments.second = {
      id: "second",
      name: "second.pdf",
      mimeType: "application/pdf",
      byteLength: 1,
      pageCount: 1,
      archivePath: "documents/shared.pdf",
    };

    expect(() => assertSafeProject(project)).toThrow(/duplicate archive path/);
  });

  it("accepts legacy PDF metadata without a hash and rejects malformed content identities", () => {
    const project = createBlankProject();
    project.pdfDocuments.pdf = {
      id: "pdf",
      name: "source.pdf",
      mimeType: "application/pdf",
      byteLength: 1,
      pageCount: 1,
      archivePath: "documents/pdf.pdf",
    };
    expect(() => assertSafeProject(project)).not.toThrow();
    project.pdfDocuments.pdf.sha256 = "not-a-sha256";
    expect(() => assertSafeProject(project)).toThrow(/content identity is malformed/);
  });

  it("rejects duplicate element identities in imported scenes", () => {
    const project = createBlankProject();
    project.scenes[project.activeSceneId].elements = [
      { id: "duplicate", type: "rectangle" },
      { id: "duplicate", type: "ellipse" },
    ];
    expect(() => assertSafeProject(project)).toThrow(/duplicate element identity/);
  });

  it("preserves valid math metadata and strips or rejects invalid imported metadata", () => {
    const generated = MATH_TOOL_CATALOGUE.find((tool) => tool.kind === "ruler")!.generate({ kind: "ruler" });
    if ("pieces" in generated) throw new Error("Ruler must be a single tool.");
    const ruler = generated.metadata;
    const validScene = scene([{
      id: "ruler",
      type: "image",
      fileId: "ruler-file",
      customData: { classroomMathTool: ruler },
    }]);
    validScene.files = {
      "ruler-file": {
        id: "ruler-file",
        mimeType: "image/svg+xml",
        dataURL: "data:image/svg+xml;base64,PHN2Zy8+",
      },
    };
    expect((sanitizeScene(validScene).elements[0].customData as Record<string, unknown>).classroomMathTool).toEqual(ruler);

    const invalidScene = scene([{
      id: "bad",
      type: "image",
      fileId: "bad-file",
      customData: { classroomMathTool: { ...ruler, naturalWidth: -1 }, note: "keep" },
    }]);
    invalidScene.files = {
      "bad-file": {
        id: "bad-file",
        mimeType: "image/svg+xml",
        dataURL: "data:image/svg+xml;base64,PHN2Zy8+",
      },
    };
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
