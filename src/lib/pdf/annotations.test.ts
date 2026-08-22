import { describe, expect, it } from "vitest";
import {
  PDF_ANNOTATION_CLEAR_UNDO_MS,
  clearPdfAnnotations,
  countPdfPageAnnotations,
  getPdfAnnotationScopeSummary,
  isPatterDrawPdfAnnotation,
  undoPdfAnnotationClear,
} from "./annotations";
import {
  PDF_ANNOTATION_UNDO_RESERVATION_ERROR,
  assertPdfAdditionPreservesAnnotationUndo,
  pdfAdditionPreservesAnnotationUndo,
} from "./annotation-undo-reservation";
import { getProjectContentSize } from "../project-budget";
import { createDefaultClassroomTimeWidgetMetadata } from "../classroom-time/types";
import { createBlankProject, type ClassroomProject, type SerializedScene } from "../../types";

function localFile(id: string, data = id): Record<string, unknown> {
  return {
    id,
    mimeType: "image/png",
    dataURL: `data:image/png;base64,${data}`,
    created: 1,
    lastRetrieved: 1,
  };
}

function background(
  id: string,
  fileId: string,
  documentId: string,
  pageIndex: number,
  width = 600,
  height = 800,
): Record<string, unknown> {
  return {
    id,
    index: "a0",
    type: "image",
    x: 0,
    y: 0,
    width,
    height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: true,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
    customData: {
      classroomRole: "pdf-background",
      pdfDocumentId: documentId,
      pdfPageIndex: pageIndex,
    },
  };
}

function element(
  id: string,
  type = "rectangle",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    x: 20,
    y: 30,
    width: 100,
    height: 80,
    isDeleted: false,
    ...extra,
  };
}

function classroomTimeWidget(ownerId: string): {
  annotations: readonly Record<string, unknown>[];
  files: Record<string, Record<string, unknown>>;
} {
  const fileId = `${ownerId}-shell-file`;
  const metadata = createDefaultClassroomTimeWidgetMetadata("timer", ownerId);
  return {
    annotations: [
      element(`${ownerId}-anchor`, "image", {
        fileId,
        groupIds: [ownerId],
        customData: { classroomTimeWidget: metadata },
      }),
      element(`${ownerId}-value`, "text", {
        groupIds: [ownerId],
        customData: {
          classroomTimeWidget: { version: 1, ownerId, role: "primary-value" },
        },
      }),
      element(`${ownerId}-deleted-part`, "text", {
        isDeleted: true,
        groupIds: [ownerId],
        customData: {
          classroomTimeWidget: { version: 1, ownerId, role: "secondary-value" },
        },
      }),
    ],
    files: { [fileId]: localFile(fileId, "widget-shell") },
  };
}

interface PageOptions {
  documentId?: string;
  pageIndex?: number;
  sourceInstanceId?: string;
  sourceName?: string;
  annotations?: readonly Record<string, unknown>[];
  retained?: readonly Record<string, unknown>[];
  files?: Record<string, Record<string, unknown>>;
}

function page(id: string, options: PageOptions = {}): SerializedScene {
  const documentId = options.documentId ?? "main-pdf";
  const pageIndex = options.pageIndex ?? 0;
  const backgroundId = `${id}-background`;
  const backgroundFileId = `${id}-background-file`;
  return {
    id,
    name: `${id}.pdf page ${pageIndex + 1}`,
    elements: [
      background(backgroundId, backgroundFileId, documentId, pageIndex),
      ...(options.retained ?? []),
      ...(options.annotations ?? []),
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {
      [backgroundFileId]: localFile(backgroundFileId, `${id}-background`),
      ...(options.files ?? {}),
    },
    pdfPage: {
      documentId,
      ...(options.sourceInstanceId ? {
        sourceInstanceId: options.sourceInstanceId,
        sourceName: options.sourceName ?? `${options.sourceInstanceId}.pdf`,
      } : {}),
      pageIndex,
      width: 600,
      height: 800,
      rotation: 0,
      backgroundElementId: backgroundId,
    },
  };
}

function projectWithPages(pages: readonly SerializedScene[]): ClassroomProject {
  const blank = createBlankProject(new Date("2026-08-20T00:00:00.000Z"));
  const documents = new Map<string, number>();
  for (const scene of pages) {
    if (!scene.pdfPage) continue;
    documents.set(
      scene.pdfPage.documentId,
      Math.max(documents.get(scene.pdfPage.documentId) ?? 0, scene.pdfPage.pageIndex + 1),
    );
  }
  return {
    ...blank,
    id: "annotation-project",
    activeSceneId: pages[0]?.id ?? blank.activeSceneId,
    scenes: Object.fromEntries(pages.map((scene) => [scene.id, scene])),
    pdfPageOrder: pages.map((scene) => scene.id),
    pdfDocuments: Object.fromEntries([...documents].map(([id, pageCount]) => [id, {
      id,
      name: `${id}.pdf`,
      mimeType: "application/pdf" as const,
      byteLength: 100,
      sha256: id.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a"),
      pageCount,
      archivePath: `pdf/${id}.pdf`,
    }])),
  };
}

describe("PatterDraw PDF annotation identity", () => {
  it("counts every live user element and only excludes the exact page background", () => {
    const scene = page("page", {
      annotations: [
        element("text", "text"),
        element("frame", "frame"),
        element("equation", "image"),
        element("off-page", "freedraw", { x: -900 }),
        element("deleted", "rectangle", { isDeleted: true }),
      ],
    });
    expect(countPdfPageAnnotations(scene)).toBe(4);
    expect(scene.elements.map((candidate) => isPatterDrawPdfAnnotation(scene, candidate))).toEqual([
      false, true, true, true, true, false,
    ]);
    expect(countPdfPageAnnotations({ ...scene, pdfPage: undefined })).toBe(0);
    expect(isPatterDrawPdfAnnotation(
      scene,
      element("spoofed-background", "image", {
        locked: true,
        customData: { classroomRole: "pdf-background" },
      }),
    )).toBe(true);
    expect(isPatterDrawPdfAnnotation({ ...scene, pdfPage: undefined }, element("board"))).toBe(false);
  });

  it("counts a complete Classroom Time widget as one logical annotation", () => {
    const widget = classroomTimeWidget("timer-owner");
    const scene = page("page", {
      annotations: [...widget.annotations, element("ordinary-mark")],
      files: widget.files,
    });

    expect(countPdfPageAnnotations(scene)).toBe(2);
    expect(scene.elements.slice(1).map((candidate) => (
      isPatterDrawPdfAnnotation(scene, candidate)
    ))).toEqual([true, true, false, true]);
  });

  it("uses selected-file occurrence identity for source scope and document identity for legacy pages", () => {
    const pages = [
      page("main-1", { sourceInstanceId: "main-a", annotations: [element("a")] }),
      page("main-2", { sourceInstanceId: "main-a", pageIndex: 1 }),
      page("repeat", { sourceInstanceId: "main-b", pageIndex: 1, annotations: [element("b"), element("c")] }),
      page("legacy-1", { documentId: "legacy", annotations: [element("d")] }),
      page("legacy-2", { documentId: "legacy", pageIndex: 1 }),
    ];
    const project = projectWithPages(pages);

    expect(getPdfAnnotationScopeSummary(project, "main-1", "source-document")).toMatchObject({
      sourceIdentity: "main-a",
      annotationCount: 1,
      affectedPageCount: 1,
      affectedPageIds: ["main-1"],
      pages: [
        { sceneId: "main-1", annotationCount: 1 },
        { sceneId: "main-2", annotationCount: 0 },
      ],
    });
    expect(getPdfAnnotationScopeSummary(project, "repeat", "source-document")).toMatchObject({
      sourceIdentity: "main-b",
      annotationCount: 2,
      affectedPageIds: ["repeat"],
    });
    expect(getPdfAnnotationScopeSummary(project, "legacy-1", "source-document")).toMatchObject({
      sourceIdentity: "legacy",
      annotationCount: 1,
      pages: [
        { sceneId: "legacy-1", annotationCount: 1 },
        { sceneId: "legacy-2", annotationCount: 0 },
      ],
    });
  });

  it("reports exact page and project-wide counts including zero-count pages", () => {
    const project = projectWithPages([
      page("one", { annotations: [element("a"), element("b")] }),
      page("two"),
      page("three", { documentId: "other", annotations: [element("c")] }),
    ]);
    expect(getPdfAnnotationScopeSummary(project, "one", "page")).toMatchObject({
      annotationCount: 2,
      affectedPageCount: 1,
      affectedPageIds: ["one"],
      pages: [{ sceneId: "one", annotationCount: 2 }],
    });
    expect(getPdfAnnotationScopeSummary(project, "one", "all-pdf-pages")).toMatchObject({
      annotationCount: 3,
      affectedPageCount: 2,
      affectedPageIds: ["one", "three"],
      pages: [
        { sceneId: "one", annotationCount: 2 },
        { sceneId: "two", annotationCount: 0 },
        { sceneId: "three", annotationCount: 1 },
      ],
    });
  });

  it("treats repeated source pages and generated blank-page sources as independent pages", () => {
    const project = projectWithPages([
      page("repeat-a", {
        sourceInstanceId: "main-file",
        pageIndex: 0,
        annotations: [element("main-mark")],
      }),
      page("repeat-b", {
        sourceInstanceId: "main-file",
        pageIndex: 0,
        annotations: [element("repeat-mark")],
      }),
      page("blank", {
        documentId: "blank-document",
        sourceInstanceId: "blank-source",
        sourceName: "Blank page",
        annotations: [element("blank-mark")],
      }),
    ]);

    expect(getPdfAnnotationScopeSummary(project, "repeat-a", "source-document")).toMatchObject({
      annotationCount: 2,
      affectedPageCount: 2,
      affectedPageIds: ["repeat-a", "repeat-b"],
    });
    expect(getPdfAnnotationScopeSummary(project, "blank", "source-document")).toMatchObject({
      sourceIdentity: "blank-source",
      annotationCount: 1,
      affectedPageIds: ["blank"],
    });
  });
});

describe("clearing PDF annotations", () => {
  it("clears every live member of a widget atomically and restores it as one annotation", () => {
    const widget = classroomTimeWidget("timer-owner");
    const original = projectWithPages([page("one", {
      annotations: [...widget.annotations, element("ordinary-mark")],
      files: widget.files,
    })]);

    const cleared = clearPdfAnnotations(original, "one", "page", { now: 1_000 });
    expect(cleared.summary.annotationCount).toBe(2);
    expect(cleared.transaction.annotationCount).toBe(2);
    expect(cleared.project.scenes.one.elements.map((candidate) => candidate.id)).toEqual([
      "one-background",
      "timer-owner-deleted-part",
    ]);
    expect(cleared.project.scenes.one.files).not.toHaveProperty("timer-owner-shell-file");

    const restored = undoPdfAnnotationClear(cleared.project, cleared.transaction, { now: 1_001 });
    expect(restored.restoredAnnotationCount).toBe(2);
    expect(restored.project.scenes.one.elements).toEqual(original.scenes.one.elements);
    expect(restored.project.scenes.one.files).toEqual(original.scenes.one.files);
  });

  it("reserves capacity for file-backed annotations until Undo expires", () => {
    const imageFile = localFile("student-image", "A".repeat(4_096));
    const original = projectWithPages([page("one", {
      annotations: [element("student-image-element", "image", { fileId: "student-image" })],
      files: { "student-image": imageFile },
    })]);
    const cleared = clearPdfAnnotations(original, "one", "page", {
      now: 1_000,
      updatedAt: "2026-08-20T01:00:00.000Z",
    });
    const pdfData = { "main-pdf": new Uint8Array(100) };
    const restored = undoPdfAnnotationClear(cleared.project, cleared.transaction, {
      now: 1_001,
      updatedAt: "2026-08-20T01:00:01.000Z",
    });
    const exactBytes = getProjectContentSize(restored.project, pdfData).totalBytes;

    expect(pdfAdditionPreservesAnnotationUndo(
      cleared.project,
      pdfData,
      cleared.transaction,
      { now: 1_001, maxBytes: exactBytes },
    )).toBe(true);
    expect(pdfAdditionPreservesAnnotationUndo(
      cleared.project,
      pdfData,
      cleared.transaction,
      { now: 1_001, maxBytes: exactBytes - 1 },
    )).toBe(false);
    expect(() => assertPdfAdditionPreservesAnnotationUndo(
      cleared.project,
      pdfData,
      cleared.transaction,
      { now: 1_001, maxBytes: exactBytes - 1 },
    )).toThrow(PDF_ANNOTATION_UNDO_RESERVATION_ERROR);
    expect(cleared.project.scenes.one.elements.map((candidate) => candidate.id)).toEqual([
      "one-background",
    ]);
    expect(pdfAdditionPreservesAnnotationUndo(
      cleared.project,
      pdfData,
      cleared.transaction,
      { now: cleared.transaction.expiresAt, maxBytes: exactBytes - 1 },
    )).toBe(true);
  });

  it("allows a smaller PDF addition while retaining both it and restored annotations", () => {
    const original = projectWithPages([page("one", {
      annotations: [element("student-mark")],
    })]);
    const cleared = clearPdfAnnotations(original, "one", "page", {
      now: 2_000,
      updatedAt: "2026-08-20T02:00:00.000Z",
    });
    const inserted = page("inserted", { documentId: "extra-pdf" });
    const afterInsertion: ClassroomProject = {
      ...cleared.project,
      scenes: { ...cleared.project.scenes, inserted },
      pdfPageOrder: ["one", "inserted"],
      pdfDocuments: {
        ...cleared.project.pdfDocuments,
        "extra-pdf": projectWithPages([inserted]).pdfDocuments["extra-pdf"],
      },
    };
    const pdfData = {
      "main-pdf": new Uint8Array(100),
      "extra-pdf": new Uint8Array(100),
    };

    expect(pdfAdditionPreservesAnnotationUndo(
      afterInsertion,
      pdfData,
      cleared.transaction,
      { now: 2_001 },
    )).toBe(true);
    const restored = undoPdfAnnotationClear(afterInsertion, cleared.transaction, {
      now: 2_001,
      updatedAt: "2026-08-20T02:00:01.000Z",
    });
    expect(restored.project.pdfPageOrder).toEqual(["one", "inserted"]);
    expect(restored.project.scenes.one.elements.map((candidate) => candidate.id)).toContain("student-mark");
    expect(restored.project.scenes.inserted).toBe(inserted);
  });

  it("removes only live annotations and only their newly orphaned files", () => {
    const deleted = element("deleted-image", "image", { isDeleted: true, fileId: "shared-file" });
    const liveShared = element("live-shared", "image", { fileId: "shared-file" });
    const liveOrphan = element("live-orphan", "image", { fileId: "orphan-file" });
    const scene = page("one", {
      retained: [deleted],
      annotations: [element("shape"), liveShared, liveOrphan],
      files: {
        "shared-file": localFile("shared-file"),
        "orphan-file": localFile("orphan-file"),
        "unrelated-orphan": localFile("unrelated-orphan"),
      },
    });
    const project = projectWithPages([scene]);
    const original = structuredClone(project);
    const result = clearPdfAnnotations(project, "one", "page", {
      now: 1_000,
      updatedAt: "2026-08-20T01:00:00.000Z",
    });

    expect(project).toEqual(original);
    expect(result.summary).toMatchObject({ annotationCount: 3, affectedPageCount: 1 });
    expect(result.project.updatedAt).toBe("2026-08-20T01:00:00.000Z");
    expect(result.project.scenes.one.elements.map((candidate) => candidate.id)).toEqual([
      "one-background",
      "deleted-image",
    ]);
    expect(Object.keys(result.project.scenes.one.files).sort()).toEqual([
      "one-background-file",
      "shared-file",
      "unrelated-orphan",
    ]);
    expect(result.project.scenes.one.pdfPage).toEqual(project.scenes.one.pdfPage);
    expect(result.project.scenes.one.name).toBe(project.scenes.one.name);
    expect(result.project.scenes.one.appState).toBe(project.scenes.one.appState);
    expect(result.project.activeSceneId).toBe(project.activeSceneId);
    expect(result.project.title).toBe(project.title);
    expect(result.project.createdAt).toBe(project.createdAt);
    expect(result.project.slideOrder).toBe(project.slideOrder);
    expect(result.project.pdfDocuments).toBe(project.pdfDocuments);
    expect(result.project.pdfPageOrder).toBe(project.pdfPageOrder);
    expect("transaction" in result.project).toBe(false);
    expect(Object.isFrozen(result.transaction)).toBe(true);
    expect(result.transaction.expiresAt - result.transaction.createdAt).toBe(PDF_ANNOTATION_CLEAR_UNDO_MS);
  });

  it("clears one logical source or all sources as one project update", () => {
    const first = page("first", {
      sourceInstanceId: "source-a",
      annotations: [element("text", "text")],
    });
    const second = page("second", {
      sourceInstanceId: "source-a",
      pageIndex: 1,
      annotations: [element("arrow", "arrow", {
        startBinding: { elementId: "box", focus: 0, gap: 1 },
        endBinding: null,
      }), element("box")],
    });
    const other = page("other", {
      documentId: "other",
      sourceInstanceId: "source-b",
      annotations: [element("image", "image", { fileId: "image-file" })],
      files: { "image-file": localFile("image-file") },
    });
    const project = projectWithPages([first, second, other]);
    const source = clearPdfAnnotations(project, "first", "source-document", { now: 2_000 });
    expect(source.transaction.affectedPageIds).toEqual(["first", "second"]);
    expect(countPdfPageAnnotations(source.project.scenes.first)).toBe(0);
    expect(countPdfPageAnnotations(source.project.scenes.second)).toBe(0);
    expect(countPdfPageAnnotations(source.project.scenes.other)).toBe(1);

    const all = clearPdfAnnotations(project, "first", "all-pdf-pages", { now: 2_000 });
    expect(all.summary).toMatchObject({ annotationCount: 4, affectedPageCount: 3 });
    expect(all.transaction.affectedPageIds).toEqual(["first", "second", "other"]);
    expect(Object.values(all.project.scenes).map(countPdfPageAnnotations)).toEqual([0, 0, 0]);
  });

  it("canonicalizes the locked page background as part of the atomic clear", () => {
    const scene = page("one", { annotations: [element("ink")] });
    scene.elements = scene.elements.map((candidate) => candidate.id === "one-background"
      ? { ...candidate, x: 500, locked: false, isDeleted: true }
      : candidate);
    const result = clearPdfAnnotations(projectWithPages([scene]), "one", "page", { now: 3_000 });
    expect(result.project.scenes.one.elements[0]).toMatchObject({
      id: "one-background",
      x: 0,
      y: 0,
      locked: true,
      isDeleted: false,
    });
  });

  it("rejects empty scopes and missing pages", () => {
    const project = projectWithPages([page("clean")]);
    expect(() => clearPdfAnnotations(project, "clean", "page")).toThrow(/no PatterDraw annotations/i);
    expect(() => getPdfAnnotationScopeSummary(project, "missing", "page")).toThrow(/no longer exists/i);
  });

  it("fails atomically when any affected page has corrupt identities or local files", () => {
    const first = page("first", { annotations: [element("first-ink")] });
    const corrupt = page("corrupt", {
      pageIndex: 1,
      annotations: [
        element("collision"),
        element("collision", "text"),
      ],
    });
    const project = projectWithPages([first, corrupt]);
    const original = structuredClone(project);
    expect(() => clearPdfAnnotations(project, "first", "all-pdf-pages")).toThrow(/duplicate element identity/i);
    expect(project).toEqual(original);

    const missingFile = page("missing-file", {
      annotations: [element("image", "image", { fileId: "absent" })],
    });
    const missingProject = projectWithPages([missingFile]);
    expect(() => clearPdfAnnotations(missingProject, "missing-file", "page")).toThrow(/missing local data/i);
  });
});

describe("PDF annotation clear undo", () => {
  function undoFixture() {
    const boundBox = element("box", "rectangle", {
      boundElements: [{ id: "label", type: "text" }, { id: "arrow", type: "arrow" }],
    });
    const label = element("label", "text", { containerId: "box", text: "Periodic table" });
    const arrow = element("arrow", "arrow", {
      startBinding: { elementId: "box", focus: 0, gap: 2 },
      endBinding: null,
    });
    const image = element("image", "image", { fileId: "annotation-file" });
    const scene = page("one", {
      annotations: [boundBox, label, arrow, image],
      files: { "annotation-file": localFile("annotation-file", "annotation") },
    });
    const project = projectWithPages([scene]);
    return { project, scene };
  }

  it("restores exact prior order, bindings, and files", () => {
    const { project, scene } = undoFixture();
    const cleared = clearPdfAnnotations(project, "one", "page", { now: 5_000 });
    const undone = undoPdfAnnotationClear(cleared.project, cleared.transaction, {
      now: 10_000,
      updatedAt: "2026-08-20T02:00:00.000Z",
    });
    expect(undone.restoredAnnotationCount).toBe(4);
    expect(undone.affectedPageCount).toBe(1);
    expect(undone.project.scenes.one.elements).toEqual(scene.elements);
    expect(undone.project.scenes.one.files).toEqual(scene.files);
    expect(undone.project.scenes.one.elements.find((candidate) => candidate.id === "box")).toMatchObject({
      boundElements: [{ id: "label", type: "text" }, { id: "arrow", type: "arrow" }],
    });
    expect(undone.project.updatedAt).toBe("2026-08-20T02:00:00.000Z");
  });

  it("keeps post-clear work above the restored prior z-order", () => {
    const { project, scene } = undoFixture();
    const cleared = clearPdfAnnotations(project, "one", "page", { now: 5_000 });
    const afterScene = cleared.project.scenes.one;
    const postClear = element("new-ink", "freedraw", { fileId: "new-file" });
    const edited: ClassroomProject = {
      ...cleared.project,
      updatedAt: "2026-08-20T02:10:00.000Z",
      scenes: {
        ...cleared.project.scenes,
        one: {
          ...afterScene,
          elements: [...afterScene.elements, postClear],
          files: { ...afterScene.files, "new-file": localFile("new-file") },
        },
      },
    };
    const undone = undoPdfAnnotationClear(edited, cleared.transaction, { now: 6_000 });
    expect(undone.project.scenes.one.elements.map((candidate) => candidate.id)).toEqual([
      ...scene.elements.map((candidate) => candidate.id),
      "new-ink",
    ]);
    expect(undone.project.scenes.one.files["annotation-file"]).toEqual(scene.files["annotation-file"]);
    expect(undone.project.scenes.one.files["new-file"]).toEqual(localFile("new-file"));
  });

  it("rejects expiry, element collisions, and file collisions", () => {
    const { project } = undoFixture();
    const cleared = clearPdfAnnotations(project, "one", "page", { now: 5_000 });
    expect(() => undoPdfAnnotationClear(cleared.project, cleared.transaction, {
      now: 5_000 + PDF_ANNOTATION_CLEAR_UNDO_MS,
    })).toThrow(/expired/i);

    const collisionScene = cleared.project.scenes.one;
    const elementCollision: ClassroomProject = {
      ...cleared.project,
      scenes: {
        ...cleared.project.scenes,
        one: { ...collisionScene, elements: [...collisionScene.elements, element("box")] },
      },
    };
    expect(() => undoPdfAnnotationClear(elementCollision, cleared.transaction, { now: 6_000 })).toThrow(/collides/i);

    const fileCollision: ClassroomProject = {
      ...cleared.project,
      scenes: {
        ...cleared.project.scenes,
        one: {
          ...collisionScene,
          files: {
            ...collisionScene.files,
            "annotation-file": localFile("annotation-file", "different"),
          },
        },
      },
    };
    expect(() => undoPdfAnnotationClear(fileCollision, cleared.transaction, { now: 6_000 })).toThrow(/file collision/i);

    const identicalFileCollision: ClassroomProject = {
      ...cleared.project,
      scenes: {
        ...cleared.project.scenes,
        one: {
          ...collisionScene,
          files: {
            ...collisionScene.files,
            "annotation-file": localFile("annotation-file", "annotation"),
          },
        },
      },
    };
    expect(() => undoPdfAnnotationClear(identicalFileCollision, cleared.transaction, { now: 6_000 }))
      .toThrow(/file collision/i);
  });

  it("allows reorder and background revision changes but rejects stale project/page state atomically", () => {
    const deleted = element("old-tombstone", "image", {
      isDeleted: true,
      fileId: "shared-file",
    });
    const scene = page("one", {
      retained: [deleted],
      annotations: [element("live", "image", { fileId: "shared-file" })],
      files: { "shared-file": localFile("shared-file") },
    });
    const project = projectWithPages([scene]);
    const cleared = clearPdfAnnotations(project, "one", "page", { now: 8_000 });

    const reordered = { ...cleared.project, pdfPageOrder: [] };
    expect(undoPdfAnnotationClear(reordered, cleared.transaction, { now: 9_000 }).project.pdfPageOrder).toEqual([]);

    const revisedBackground: ClassroomProject = {
      ...cleared.project,
      scenes: {
        ...cleared.project.scenes,
        one: {
          ...cleared.project.scenes.one,
          elements: cleared.project.scenes.one.elements.map((candidate) => candidate.id === "one-background"
            ? { ...candidate, version: 42, versionNonce: 73, updated: 9_000 }
            : candidate),
          files: Object.fromEntries(Object.entries(cleared.project.scenes.one.files).map(([id, file]) => [
            id,
            { ...file, lastRetrieved: 9_000 },
          ])),
        },
      },
    };
    const revisionUndo = undoPdfAnnotationClear(revisedBackground, cleared.transaction, { now: 9_000 });
    expect(revisionUndo.project.scenes.one.elements[0])
      .toMatchObject({ version: 42, versionNonce: 73, updated: 9_000 });
    expect(revisionUndo.project.scenes.one.files["one-background-file"])
      .toMatchObject({ lastRetrieved: 9_000 });

    const replacedProject = { ...cleared.project, id: "different-project" };
    expect(() => undoPdfAnnotationClear(replacedProject, cleared.transaction, { now: 9_000 }))
      .toThrow(/document changed/i);

    const rotated: ClassroomProject = {
      ...cleared.project,
      scenes: {
        ...cleared.project.scenes,
        one: {
          ...cleared.project.scenes.one,
          pdfPage: { ...cleared.project.scenes.one.pdfPage!, rotation: 90 },
        },
      },
    };
    expect(() => undoPdfAnnotationClear(rotated, cleared.transaction, { now: 9_000 })).toThrow(/changed/i);

    const changedTombstone: ClassroomProject = {
      ...cleared.project,
      scenes: {
        ...cleared.project.scenes,
        one: {
          ...cleared.project.scenes.one,
          elements: cleared.project.scenes.one.elements.map((candidate) => candidate.id === "old-tombstone"
            ? { ...candidate, version: 99 }
            : candidate),
        },
      },
    };
    const before = structuredClone(changedTombstone);
    expect(() => undoPdfAnnotationClear(changedTombstone, cleared.transaction, { now: 9_000 })).toThrow(/changed/i);
    expect(changedTombstone).toEqual(before);
  });

  it("rejects missing pages and changed source metadata without partially restoring another page", () => {
    const first = page("first", {
      annotations: [element("first-image", "image", { fileId: "first-file" })],
      files: { "first-file": localFile("first-file") },
    });
    const second = page("second", {
      documentId: "second-document",
      annotations: [element("second-image", "image", { fileId: "second-file" })],
      files: { "second-file": localFile("second-file") },
    });
    const project = projectWithPages([first, second]);
    const cleared = clearPdfAnnotations(project, "first", "all-pdf-pages", { now: 12_000 });

    const missing: ClassroomProject = {
      ...cleared.project,
      scenes: { first: cleared.project.scenes.first },
      pdfPageOrder: ["first"],
    };
    const missingBefore = structuredClone(missing);
    expect(() => undoPdfAnnotationClear(missing, cleared.transaction, { now: 13_000 }))
      .toThrow(/no longer exists/i);
    expect(missing).toEqual(missingBefore);
    expect(countPdfPageAnnotations(missing.scenes.first)).toBe(0);

    const changedSource: ClassroomProject = {
      ...cleared.project,
      pdfDocuments: {
        ...cleared.project.pdfDocuments,
        "second-document": {
          ...cleared.project.pdfDocuments["second-document"],
          sha256: "b".repeat(64),
        },
      },
    };
    const changedSourceBefore = structuredClone(changedSource);
    expect(() => undoPdfAnnotationClear(changedSource, cleared.transaction, { now: 13_000 }))
      .toThrow(/changed/i);
    expect(changedSource).toEqual(changedSourceBefore);
    expect(countPdfPageAnnotations(changedSource.scenes.first)).toBe(0);
  });
});
