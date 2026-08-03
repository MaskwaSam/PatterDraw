import { describe, expect, it } from "vitest";
import type { SerializedScene } from "../../types";
import { canonicalizePdfBackground } from "./background";

function pdfScene(): SerializedScene {
  return {
    id: "page",
    name: "Page 1",
    elements: [
      {
        id: "background",
        type: "image",
        fileId: "page-image",
        x: 0,
        y: 0,
        width: 600,
        height: 800,
        angle: 0,
        locked: true,
        isDeleted: false,
        opacity: 100,
        frameId: null,
        boundElements: null,
        crop: null,
        link: null,
        index: "a0",
        strokeColor: "transparent",
        backgroundColor: "transparent",
        strokeWidth: 1,
        strokeStyle: "solid",
        fillStyle: "solid",
        roughness: 0,
        roundness: null,
        groupIds: [],
        scale: [1, 1],
        status: "saved",
        version: 1,
        customData: {
          classroomRole: "pdf-background",
          pdfDocumentId: "document",
          pdfPageIndex: 0,
        },
      },
    ],
    appState: {},
    files: {
      "page-image": {
        id: "page-image",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
      },
    },
    pdfPage: {
      documentId: "document",
      pageIndex: 0,
      width: 600,
      height: 800,
      rotation: 0,
      backgroundElementId: "background",
    },
  };
}

describe("PDF background invariants", () => {
  it("leaves an already canonical background untouched", () => {
    const scene = pdfScene();
    expect(canonicalizePdfBackground(scene, scene.elements)).toBe(scene.elements);
  });

  it("restores a moved, unlocked, deleted, and replaced background", () => {
    const scene = pdfScene();
    const annotation = { id: "ink", type: "freedraw", x: -30, y: 900 };
    const damaged = [
      annotation,
      {
        ...scene.elements[0],
        fileId: "replacement-image",
        x: 90,
        y: 40,
        width: 200,
        height: 100,
        angle: 0.5,
        locked: false,
        isDeleted: true,
        opacity: 20,
        index: "z9",
        boundElements: [{ id: "ink", type: "arrow" }],
        strokeColor: "#ff0000",
        scale: [-1, 1],
        groupIds: ["group"],
        version: 7,
      },
    ];

    const repaired = canonicalizePdfBackground(scene, damaged);

    expect(repaired[0]).toMatchObject({
      id: "background",
      type: "image",
      fileId: "page-image",
      x: 0,
      y: 0,
      width: 600,
      height: 800,
      angle: 0,
      locked: true,
      isDeleted: false,
      opacity: 100,
      index: "a0",
      boundElements: null,
      strokeColor: "transparent",
      scale: [1, 1],
      groupIds: [],
      version: 8,
    });
    expect(repaired[1]).toBe(annotation);
  });

  it("allows a display-only file while retaining every background invariant", () => {
    const scene = pdfScene();
    const displayed = canonicalizePdfBackground(scene, scene.elements, "dark-page-image");

    expect(displayed[0]).toMatchObject({
      id: "background",
      fileId: "dark-page-image",
      locked: true,
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    });
    expect(canonicalizePdfBackground(scene, displayed, "dark-page-image")).toBe(displayed);
    expect(canonicalizePdfBackground(scene, displayed)[0].fileId).toBe("page-image");
  });

  it("removes extra background metadata once and remains idempotent", () => {
    const scene = pdfScene();
    scene.elements = [{
      ...scene.elements[0],
      customData: {
        ...(scene.elements[0].customData as Record<string, unknown>),
        importedLegacyFlag: true,
      },
    }];

    const repaired = canonicalizePdfBackground(scene, scene.elements);

    expect(repaired[0].customData).toEqual({
      classroomRole: "pdf-background",
      pdfDocumentId: "document",
      pdfPageIndex: 0,
    });
    expect(canonicalizePdfBackground(scene, repaired)).toBe(repaired);
  });

  it("does not manufacture a background when the source image is missing", () => {
    const scene = pdfScene();
    scene.elements = [];
    expect(canonicalizePdfBackground(scene, [])).toEqual([]);
  });

  it("does not alter ordinary board scenes", () => {
    const scene = pdfScene();
    delete scene.pdfPage;
    const elements = [{ id: "shape", type: "rectangle" }];
    expect(canonicalizePdfBackground(scene, elements)).toBe(elements);
  });
});
