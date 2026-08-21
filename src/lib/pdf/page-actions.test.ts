import { describe, expect, it, vi } from "vitest";
import {
  createBlankProject,
  type ClassroomProject,
  type PdfDocumentSource,
  type SerializedScene,
} from "../../types";
import { getProjectContentSize } from "../project-budget";
import {
  PDF_PAGE_DELETE_UNDO_MS,
  deletePdfPageReversibly,
  duplicatePdfPage,
  pdfAdditionPreservesPageDeleteUndo,
  undoPdfPageDelete,
} from "./page-actions";

function file(id: string, payload = id): Record<string, unknown> {
  return {
    id,
    mimeType: "image/png",
    dataURL: `data:image/png;base64,${payload}`,
    created: 1,
  };
}

function element(
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    index: `a${id}`,
    type,
    x: 20,
    y: 30,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: "#1b1b1f",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
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
    locked: false,
    ...extra,
  };
}

function background(
  id: string,
  fileId: string,
  documentId: string,
  pageIndex: number,
): Record<string, unknown> {
  return element(id, "image", {
    index: "a0",
    x: 0,
    y: 0,
    width: 600,
    height: 800,
    strokeColor: "transparent",
    roughness: 0,
    strokeWidth: 1,
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
  });
}

function source(id: string, byteLength = 8, pageCount = 3): PdfDocumentSource {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    byteLength,
    sha256: id.padEnd(64, "a").slice(0, 64),
    pageCount,
    archivePath: `documents/${id}.pdf`,
  };
}

interface PageOptions {
  documentId?: string;
  pageIndex?: number;
  sourceInstanceId?: string;
  complex?: boolean;
}

function page(id: string, options: PageOptions = {}): SerializedScene {
  const documentId = options.documentId ?? "main-document";
  const pageIndex = options.pageIndex ?? 0;
  const backgroundId = `${id}-background`;
  const backgroundFileId = `${id}-background-file`;
  const elements: Record<string, unknown>[] = [
    background(backgroundId, backgroundFileId, documentId, pageIndex),
  ];
  const files: Record<string, Record<string, unknown>> = {
    [backgroundFileId]: file(backgroundFileId, "background"),
  };
  if (options.complex) {
    elements.push(
      element("container", "rectangle", {
        groupIds: ["group-one"],
        boundElements: [
          { id: "bound-text", type: "text" },
          { id: "arrow", type: "arrow" },
        ],
      }),
      element("bound-text", "text", {
        text: "Periodic table",
        originalText: "Periodic table",
        fontSize: 20,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: "container",
        autoResize: true,
        lineHeight: 1.25,
      }),
      element("arrow", "arrow", {
        points: [[0, 0], [160, 70]],
        startBinding: { elementId: "container", focus: 0, gap: 2 },
        endBinding: { elementId: "student-image", focus: 0, gap: 2 },
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      }),
      element("frame", "frame", {
        x: 250,
        y: 200,
        width: 300,
        height: 240,
        name: "Reference",
        customData: { classroomSlide: { kind: "slide", version: 1 } },
      }),
      element("frame-child", "ellipse", {
        x: 270,
        y: 220,
        frameId: "frame",
      }),
      element("student-image", "image", {
        x: 400,
        fileId: "student-image-file",
        status: "saved",
        scale: [1, 1],
        crop: null,
        boundElements: [{ id: "arrow", type: "arrow" }],
      }),
      element("equation", "image", {
        y: 500,
        fileId: "equation-file",
        status: "saved",
        scale: [1, 1],
        crop: null,
        customData: {
          classroomLatex: {
            source: "E=mc^2",
            renderer: "mathjax",
            rendererVersion: "4.1.3",
          },
        },
      }),
      element("off-page", "freedraw", {
        x: -900,
        y: 1_300,
        groupIds: ["group-one"],
        points: [[0, 0], [20, 10]],
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
      }),
      element("deleted-image", "image", {
        isDeleted: true,
        fileId: "deleted-file",
        status: "saved",
        scale: [1, 1],
        crop: null,
      }),
    );
    files["student-image-file"] = file("student-image-file", "student");
    files["equation-file"] = {
      ...file("equation-file", "equation"),
      mimeType: "image/svg+xml",
    };
    files["deleted-file"] = file("deleted-file", "deleted");
    // Models the one active wrapper preview plus an unrelated stale file. A
    // committed duplicate retains neither because no canonical live element
    // references them.
    files["patterdraw-dark-pdf-transient"] = file("patterdraw-dark-pdf-transient", "preview");
    files.unreferenced = file("unreferenced", "unused");
  }
  const scene: SerializedScene = {
    id,
    name: `${id}.pdf — page ${pageIndex + 1}`,
    elements,
    appState: options.complex ? {
      viewBackgroundColor: "#ffffff",
      selectedElementIds: { container: true, "off-page": true },
      selectedGroupIds: { "group-one": true },
      editingGroupId: "group-one",
      editingElement: { id: "container" },
    } : {},
    files,
    pdfPage: {
      documentId,
      sourceInstanceId: options.sourceInstanceId ?? `${documentId}-instance`,
      sourceName: `${documentId}.pdf`,
      pageIndex,
      width: 600,
      height: 800,
      rotation: 0,
      backgroundElementId: backgroundId,
    },
  };
  return scene;
}

function fixture(pages: readonly SerializedScene[]): {
  project: ClassroomProject;
  pdfBytes: Record<string, Uint8Array>;
} {
  const blank = createBlankProject(new Date("2026-08-20T00:00:00.000Z"));
  const documents: Record<string, PdfDocumentSource> = {};
  const pdfBytes: Record<string, Uint8Array> = {};
  for (const scene of pages) {
    const documentId = scene.pdfPage!.documentId;
    const pageCount = Math.max(
      documents[documentId]?.pageCount ?? 0,
      scene.pdfPage!.pageIndex + 1,
    );
    documents[documentId] = source(documentId, 8, pageCount);
    pdfBytes[documentId] ??= Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  }
  return {
    project: {
      ...blank,
      id: "page-actions-project",
      activeSceneId: pages[0]?.id ?? blank.activeSceneId,
      scenes: {
        [blank.activeSceneId]: blank.scenes[blank.activeSceneId],
        ...Object.fromEntries(pages.map((scene) => [scene.id, scene])),
      },
      slideOrder: [],
      pdfPageOrder: pages.map((scene) => scene.id),
      pdfDocuments: documents,
    },
    pdfBytes,
  };
}

function elementById(scene: SerializedScene, id: string): Record<string, unknown> {
  const result = scene.elements.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing test element ${id}.`);
  return result;
}

describe("PDF page duplication", () => {
  it("duplicates the full live graph with fresh scene, element, group, frame, slide, and file identities", () => {
    const originalPage = page("main-page", { complex: true, pageIndex: 1 });
    // Exercise forward-compatible workspace fields without making this test
    // own the concurrently introduced public type.
    Object.assign(originalPage.pdfPage!, { viewRotation: 90 });
    const { project, pdfBytes } = fixture([originalPage, page("last-page", { pageIndex: 2 })]);
    project.slideOrder = [{
      id: "reference-slide",
      sceneId: "main-page",
      frameId: "frame",
      title: "Reference",
      titleMode: "custom",
    }];
    const before = structuredClone(project);

    const result = duplicatePdfPage(project, pdfBytes, "main-page", {
      now: 1_000,
      updatedAt: "2026-08-20T01:00:00.000Z",
    });
    const duplicate = result.project.scenes[result.duplicatedSceneId];
    const map = result.elementIdMap;

    expect(project).toEqual(before);
    expect(result.pdfBytes).toBe(pdfBytes);
    expect(result.project.pdfDocuments).toBe(project.pdfDocuments);
    expect(result.project.pdfDocuments["main-document"]).toBe(project.pdfDocuments["main-document"]);
    expect(result.project.pdfPageOrder).toEqual([
      "main-page", result.duplicatedSceneId, "last-page",
    ]);
    expect(result.project.activeSceneId).toBe(result.duplicatedSceneId);
    expect(duplicate.pdfPage).toEqual({
      ...originalPage.pdfPage,
      backgroundElementId: map[originalPage.pdfPage!.backgroundElementId],
    });
    expect((duplicate.pdfPage as unknown as { viewRotation: number }).viewRotation).toBe(90);
    expect(duplicate.elements).toHaveLength(originalPage.elements.length - 1);
    expect(duplicate.elements.some((candidate) => candidate.id === "deleted-image")).toBe(false);
    expect(new Set(Object.values(map)).size).toBe(duplicate.elements.length);
    expect(Object.entries(map).every(([oldId, newId]) => oldId !== newId)).toBe(true);

    const container = elementById(duplicate, map.container);
    const label = elementById(duplicate, map["bound-text"]);
    const arrow = elementById(duplicate, map.arrow);
    const child = elementById(duplicate, map["frame-child"]);
    expect(container.boundElements).toEqual([
      { id: map["bound-text"], type: "text" },
      { id: map.arrow, type: "arrow" },
    ]);
    expect(label.containerId).toBe(map.container);
    expect(arrow.startBinding).toEqual(expect.objectContaining({ elementId: map.container }));
    expect(arrow.endBinding).toEqual(expect.objectContaining({ elementId: map["student-image"] }));
    expect(child.frameId).toBe(map.frame);
    expect(container.groupIds).not.toEqual(["group-one"]);
    expect(elementById(duplicate, map["off-page"]).groupIds).toEqual(container.groupIds);
    expect(elementById(duplicate, map["off-page"])).toMatchObject({ x: -900, y: 1_300 });

    expect(Object.keys(duplicate.files)).toHaveLength(3);
    expect(Object.keys(duplicate.files)).not.toContain("student-image-file");
    expect(Object.keys(duplicate.files)).not.toContain("equation-file");
    expect(Object.keys(duplicate.files)).not.toContain("deleted-file");
    expect(Object.keys(duplicate.files)).not.toContain("patterdraw-dark-pdf-transient");
    for (const [oldFileId, newFileId] of Object.entries(result.fileIdMap)) {
      expect(newFileId).not.toBe(oldFileId);
      expect(duplicate.files[newFileId]).toEqual({ ...originalPage.files[oldFileId], id: newFileId });
    }
    expect(elementById(duplicate, map["student-image"]).fileId)
      .toBe(result.fileIdMap["student-image-file"]);
    expect(elementById(duplicate, map.equation).customData)
      .toEqual(elementById(originalPage, "equation").customData);

    expect(result.project.slideOrder).toEqual([
      project.slideOrder[0],
      {
        ...project.slideOrder[0],
        id: result.slideIdMap["reference-slide"],
        sceneId: result.duplicatedSceneId,
        frameId: map.frame,
      },
    ]);
    expect(result.slideIdMap["reference-slide"]).not.toBe("reference-slide");
    expect(duplicate.appState.selectedElementIds).toEqual({
      [map.container]: true,
      [map["off-page"]]: true,
    });
    expect(duplicate.appState.editingGroupId).not.toBe("group-one");
    expect(duplicate.appState).not.toHaveProperty("editingElement");
    expect(result.additionalManifestBytes).toBeGreaterThan(0);
    expect(Object.isFrozen(result.elementIdMap)).toBe(true);
    expect(Object.isFrozen(result.fileIdMap)).toBe(true);
  });

  it("rejects capacity, content-budget, and caller preflight failures without publishing a partial page", () => {
    const { project, pdfBytes } = fixture([page("main-page", { complex: true })]);
    const original = structuredClone(project);
    const exactCurrentBytes = getProjectContentSize(project, pdfBytes).totalBytes;

    expect(() => duplicatePdfPage(project, pdfBytes, "main-page", {
      maxProjectBytes: exactCurrentBytes,
    })).toThrow(/too large/i);
    expect(project).toEqual(original);

    const validateCandidate = vi.fn(() => { throw new Error("reserved Undo would not fit"); });
    expect(() => duplicatePdfPage(project, pdfBytes, "main-page", { validateCandidate }))
      .toThrow("reserved Undo would not fit");
    expect(validateCandidate).toHaveBeenCalledOnce();
    expect(project).toEqual(original);

    for (let index = Object.keys(project.scenes).length; index < 512; index += 1) {
      const id = `filler-${index}`;
      project.scenes[id] = { id, name: id, elements: [], appState: {}, files: {} };
    }
    expect(() => duplicatePdfPage(project, pdfBytes, "main-page"))
      .toThrow(/reached its page and scene limit/i);
  });
});

describe("reversible PDF page deletion", () => {
  it("reserves the exact restored content budget while deletion Undo is visible", () => {
    const target = page("target", { documentId: "only-source", complex: true });
    const { project, pdfBytes } = fixture([target]);
    const deleted = deletePdfPageReversibly(project, pdfBytes, "target", { now: 1_000 });
    const restoredBytes = getProjectContentSize(project, pdfBytes).totalBytes;

    expect(pdfAdditionPreservesPageDeleteUndo(
      deleted.project,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 1_001, maxBytes: restoredBytes },
    )).toBe(true);
    expect(pdfAdditionPreservesPageDeleteUndo(
      deleted.project,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 1_001, maxBytes: restoredBytes - 1 },
    )).toBe(false);
    expect(pdfAdditionPreservesPageDeleteUndo(
      deleted.project,
      deleted.pdfBytes,
      deleted.transaction,
      { now: deleted.transaction.expiresAt, maxBytes: 1 },
    )).toBe(true);
  });

  it("restores into a subsequently reordered project without overwriting other scenes or drawings", () => {
    const first = page("first", { pageIndex: 0 });
    const target = page("target", { pageIndex: 1, complex: true });
    const third = page("third", { pageIndex: 2 });
    const { project, pdfBytes } = fixture([first, target, third]);
    project.activeSceneId = "target";
    project.slideOrder = [
      { id: "before", sceneId: "first", frameId: "unused", title: "Before" },
      { id: "target-slide", sceneId: "target", frameId: "frame", title: "Reference" },
      { id: "after", sceneId: "third", frameId: "unused", title: "After" },
    ];
    const before = structuredClone(project);
    const deleted = deletePdfPageReversibly(project, pdfBytes, "target", {
      now: 2_000,
      updatedAt: "2026-08-20T02:00:00.000Z",
    });

    expect(project).toEqual(before);
    expect(deleted.project.pdfPageOrder).toEqual(["first", "third"]);
    expect(deleted.project.activeSceneId).toBe("third");
    expect(deleted.project.slideOrder.map((slide) => slide.id)).toEqual(["before", "after"]);
    expect(deleted.project.pdfDocuments).toBe(project.pdfDocuments);
    expect(deleted.pdfBytes).toBe(pdfBytes);
    expect(deleted.transaction.sourceWasRemoved).toBe(false);
    expect(deleted.transaction.expiresAt - deleted.transaction.createdAt)
      .toBe(PDF_PAGE_DELETE_UNDO_MS);
    expect(Object.isFrozen(deleted.transaction)).toBe(true);
    expect(deleted.transaction.scene).toBe(target);
    expect(deleted.transaction.source).toBe(project.pdfDocuments["main-document"]);
    expect(Object.isFrozen(target)).toBe(false);

    const editedThird: SerializedScene = {
      ...deleted.project.scenes.third,
      elements: [
        ...deleted.project.scenes.third.elements,
        element("new-third-ink", "freedraw", {
          x: 900,
          points: [[0, 0], [5, 5]],
          pressures: [],
          simulatePressure: true,
          lastCommittedPoint: null,
        }),
      ],
    };
    const later: ClassroomProject = {
      ...deleted.project,
      activeSceneId: "third",
      scenes: { ...deleted.project.scenes, third: editedThird },
      pdfPageOrder: ["third", "first"],
      slideOrder: [
        deleted.project.slideOrder[1],
        { id: "new-slide", sceneId: "third", frameId: "new-frame", title: "New" },
        deleted.project.slideOrder[0],
      ],
    };
    const replacedSharedBytes = {
      ...deleted.pdfBytes,
      "main-document": Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 9),
    };
    expect(() => undoPdfPageDelete(later, replacedSharedBytes, deleted.transaction, {
      now: 2_001,
    })).toThrow(/source changed/i);
    const restored = undoPdfPageDelete(later, deleted.pdfBytes, deleted.transaction, {
      now: 2_001,
      updatedAt: "2026-08-20T02:00:01.000Z",
    });

    expect(restored.project.pdfPageOrder).toEqual(["third", "first", "target"]);
    expect(restored.project.scenes.target).toEqual(target);
    expect(restored.project.scenes.third).toBe(editedThird);
    expect(restored.project.scenes.third.elements).toContainEqual(
      expect.objectContaining({ id: "new-third-ink" }),
    );
    expect(restored.project.slideOrder.map((slide) => slide.id)).toEqual([
      "after", "new-slide", "before", "target-slide",
    ]);
    expect(restored.project.activeSceneId).toBe("target");
    expect(restored.restoredPageNumber).toBe(3);
  });

  it("removes and restores exact last-occurrence source metadata and a private byte snapshot", () => {
    const target = page("target", { documentId: "only-source", complex: true });
    const { project, pdfBytes } = fixture([target]);
    const originalScene = structuredClone(target);
    const originalSource = structuredClone(project.pdfDocuments["only-source"]);
    const originalBytes = pdfBytes["only-source"];
    const originalSha = project.pdfDocuments["only-source"].sha256;
    const deleted = deletePdfPageReversibly(project, pdfBytes, "target", { now: 3_000 });

    expect(deleted.project.pdfDocuments).not.toHaveProperty("only-source");
    expect(deleted.pdfBytes).not.toHaveProperty("only-source");
    expect(deleted.transaction.sourceWasRemoved).toBe(true);
    expect(JSON.stringify(deleted.transaction)).not.toContain("1,2,3,4,5,6,7,8");
    expect(deleted.transaction.scene).toBe(target);
    expect(deleted.transaction.source).toBe(project.pdfDocuments["only-source"]);

    const restored = undoPdfPageDelete(
      deleted.project,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 3_001 },
    );
    expect(restored.project.scenes.target).toEqual(originalScene);
    expect(restored.project.scenes.target).toBe(target);
    expect(restored.project.pdfDocuments["only-source"]).toEqual(originalSource);
    expect(restored.project.pdfDocuments["only-source"]).toBe(project.pdfDocuments["only-source"]);
    expect(restored.project.pdfDocuments["only-source"].sha256).toBe(originalSha);
    expect(restored.pdfBytes["only-source"]).toBe(originalBytes);
  });

  it("accepts an identical reintroduced source and rejects mismatched metadata or bytes atomically", () => {
    const target = page("target", { documentId: "only-source" });
    const { project, pdfBytes } = fixture([target]);
    const deleted = deletePdfPageReversibly(project, pdfBytes, "target", { now: 4_000 });
    const exactSource = structuredClone(project.pdfDocuments["only-source"]);
    const exactBytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const reintroduced: ClassroomProject = {
      ...deleted.project,
      pdfDocuments: { ...deleted.project.pdfDocuments, "only-source": exactSource },
    };
    const reintroducedBytes = { ...deleted.pdfBytes, "only-source": exactBytes };
    const restored = undoPdfPageDelete(
      reintroduced,
      reintroducedBytes,
      deleted.transaction,
      { now: 4_001 },
    );
    expect(restored.project.pdfDocuments["only-source"]).toBe(exactSource);
    expect(restored.pdfBytes["only-source"]).toBe(exactBytes);

    const mismatchedMetadata = {
      ...reintroduced,
      pdfDocuments: {
        ...reintroduced.pdfDocuments,
        "only-source": { ...exactSource, name: "replacement.pdf" },
      },
    };
    const metadataBefore = structuredClone(mismatchedMetadata);
    expect(() => undoPdfPageDelete(
      mismatchedMetadata,
      reintroducedBytes,
      deleted.transaction,
      { now: 4_001 },
    )).toThrow(/source collision/i);
    expect(mismatchedMetadata).toEqual(metadataBefore);

    const wrongBytes = { ...reintroducedBytes, "only-source": exactBytes.slice() };
    wrongBytes["only-source"][7] = 9;
    expect(() => undoPdfPageDelete(
      reintroduced,
      wrongBytes,
      deleted.transaction,
      { now: 4_001 },
    )).toThrow(/source collision/i);
  });

  it("rejects mutated retained scene, source, or byte references without copying or publishing partial state", () => {
    const deleteFresh = () => {
      const target = page("target", { documentId: "only-source", complex: true });
      const state = fixture([target]);
      const deleted = deletePdfPageReversibly(
        state.project,
        state.pdfBytes,
        "target",
        { now: 4_500 },
      );
      return { target, ...state, deleted };
    };

    const changedScene = deleteFresh();
    const sceneCurrentBefore = structuredClone(changedScene.deleted.project);
    changedScene.target.name = "mutated after deletion";
    expect(() => undoPdfPageDelete(
      changedScene.deleted.project,
      changedScene.deleted.pdfBytes,
      changedScene.deleted.transaction,
      { now: 4_501 },
    )).toThrow(/snapshot changed/i);
    expect(changedScene.deleted.project).toEqual(sceneCurrentBefore);

    const changedSource = deleteFresh();
    const sourceCurrentBefore = structuredClone(changedSource.deleted.project);
    changedSource.project.pdfDocuments["only-source"].name = "replacement.pdf";
    expect(() => undoPdfPageDelete(
      changedSource.deleted.project,
      changedSource.deleted.pdfBytes,
      changedSource.deleted.transaction,
      { now: 4_501 },
    )).toThrow(/snapshot changed/i);
    expect(changedSource.deleted.project).toEqual(sourceCurrentBefore);

    const changedBytes = deleteFresh();
    const byteCurrentBefore = structuredClone(changedBytes.deleted.project);
    changedBytes.pdfBytes["only-source"][0] = 255;
    expect(() => undoPdfPageDelete(
      changedBytes.deleted.project,
      changedBytes.deleted.pdfBytes,
      changedBytes.deleted.transaction,
      { now: 4_501 },
    )).toThrow(/snapshot changed/i);
    expect(changedBytes.deleted.project).toEqual(byteCurrentBefore);
  });

  it("rejects expiry, project, scene, and slide collisions without partial restoration", () => {
    const target = page("target", { complex: true });
    const { project, pdfBytes } = fixture([target]);
    project.slideOrder = [{
      id: "target-slide",
      sceneId: "target",
      frameId: "frame",
      title: "Target",
    }];
    const deleted = deletePdfPageReversibly(project, pdfBytes, "target", { now: 5_000 });

    expect(() => undoPdfPageDelete(
      deleted.project,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 5_000 + PDF_PAGE_DELETE_UNDO_MS },
    )).toThrow(/expired/i);
    expect(() => undoPdfPageDelete(
      { ...deleted.project, id: "different-project" },
      deleted.pdfBytes,
      deleted.transaction,
      { now: 5_001 },
    )).toThrow(/project changed/i);

    const sceneCollision: ClassroomProject = {
      ...deleted.project,
      scenes: { ...deleted.project.scenes, target: page("target") },
    };
    const sceneBefore = structuredClone(sceneCollision);
    expect(() => undoPdfPageDelete(
      sceneCollision,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 5_001 },
    )).toThrow(/scene collision/i);
    expect(sceneCollision).toEqual(sceneBefore);

    const slideCollision: ClassroomProject = {
      ...deleted.project,
      slideOrder: [{
        id: "target-slide",
        sceneId: deleted.project.activeSceneId,
        frameId: "other-frame",
        title: "Collision",
      }],
    };
    expect(() => undoPdfPageDelete(
      slideCollision,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 5_001 },
    )).toThrow(/slide collision/i);
  });

  it("removes an untouched emergency board on undo but keeps it after post-delete edits", () => {
    const target = page("target", { documentId: "only-source" });
    const { project, pdfBytes } = fixture([target]);
    // Model a legacy PDF-only project so deletion must preserve the invariant
    // that activeSceneId always names an extant scene.
    project.scenes = { target };
    const deleted = deletePdfPageReversibly(project, pdfBytes, "target", { now: 6_000 });
    const replacementId = deleted.project.activeSceneId;
    expect(Object.keys(deleted.project.scenes)).toEqual([replacementId]);

    const cleanUndo = undoPdfPageDelete(
      deleted.project,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 6_001 },
    );
    expect(Object.keys(cleanUndo.project.scenes)).toEqual(["target"]);

    const editedReplacement: SerializedScene = {
      ...deleted.project.scenes[replacementId],
      elements: [element("post-delete-note", "rectangle")],
    };
    const edited: ClassroomProject = {
      ...deleted.project,
      scenes: { [replacementId]: editedReplacement },
    };
    const editedUndo = undoPdfPageDelete(
      edited,
      deleted.pdfBytes,
      deleted.transaction,
      { now: 6_001 },
    );
    expect(editedUndo.project.scenes[replacementId]).toBe(editedReplacement);
    expect(editedUndo.project.scenes.target).toEqual(target);
  });
});
