import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedScene } from "../types";

const { exportToBlobMock } = vi.hoisted(() => ({
  exportToBlobMock: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: exportToBlobMock,
}));

import {
  renderSlideThumbnail,
  SLIDE_THUMBNAIL_MAX_EDGE,
  slidePreviewRevision,
} from "./slide-thumbnail";

function element(
  id: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    isDeleted: false,
    frameId: null,
    version: 1,
    versionNonce: 11,
    index: id,
    ...overrides,
  };
}

function makeScene(overrides: Partial<SerializedScene> = {}): SerializedScene {
  return {
    id: "scene",
    name: "Board",
    elements: [
      element("frame", "frame", { x: 0, y: 0, width: 1_280, height: 720, customData: { classroomSlide: { kind: "slide", version: 1 } } }),
      element("shape", "rectangle", { x: 20, y: 20, width: 100, height: 100, frameId: "frame", version: 2 }),
      element("image", "image", { x: 140, y: 20, width: 100, height: 100, frameId: "frame", fileId: "used-file" }),
      element("blocked", "iframe", { frameId: "frame" }),
      element("unrelated", "ellipse", { x: 2_000, y: 2_000, width: 100, height: 100 }),
    ],
    appState: {},
    files: {
      "used-file": {
        id: "used-file",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
        created: 10,
        version: 3,
      },
      "unused-file": {
        id: "unused-file",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,BB==",
        created: 20,
        version: 4,
      },
    },
    ...overrides,
  };
}

describe("slide thumbnail revisions", () => {
  it("ignores viewport, unrelated elements, and unrelated files", () => {
    const original = makeScene();
    const changed = makeScene({
      appState: { scrollX: 500, scrollY: -250, zoom: { value: 2 } },
      elements: original.elements.map((candidate) => candidate.id === "unrelated"
        ? { ...candidate, version: 99, versionNonce: 999 }
        : candidate),
      files: {
        ...original.files,
        "unused-file": {
          ...original.files["unused-file"],
          version: 100,
          dataURL: "data:image/png;base64,THIS-IS-UNRELATED",
        },
      },
    });

    expect(slidePreviewRevision(changed, "frame"))
      .toBe(slidePreviewRevision(original, "frame"));
  });

  it("changes for ordered frame content and referenced local file revisions", () => {
    const original = makeScene();
    const contentChanged = makeScene({
      elements: original.elements.map((candidate) => candidate.id === "shape"
        ? { ...candidate, version: 3, versionNonce: 12 }
        : candidate),
    });
    const reordered = makeScene({
      elements: [original.elements[1], original.elements[0], ...original.elements.slice(2)],
    });
    const fileChanged = makeScene({
      files: {
        ...original.files,
        "used-file": { ...original.files["used-file"], version: 4 },
      },
    });
    const revision = slidePreviewRevision(original, "frame");

    expect(slidePreviewRevision(contentChanged, "frame")).not.toBe(revision);
    expect(slidePreviewRevision(reordered, "frame")).not.toBe(revision);
    expect(slidePreviewRevision(fileChanged, "frame")).not.toBe(revision);
  });

  it("returns null when the frame no longer exists", () => {
    expect(slidePreviewRevision(makeScene({ elements: [] }), "frame")).toBeNull();
  });
});

describe("slide thumbnail rendering", () => {
  beforeEach(() => {
    exportToBlobMock.mockReset();
  });

  it("exports a 320px frame-clipped local PNG from shared render data", async () => {
    const blob = new Blob(["thumbnail"], { type: "image/png" });
    exportToBlobMock.mockResolvedValue(blob);
    const input = makeScene();

    await expect(renderSlideThumbnail(input, "frame")).resolves.toBe(blob);
    expect(exportToBlobMock).toHaveBeenCalledTimes(1);
    expect(exportToBlobMock).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/png",
      maxWidthOrHeight: SLIDE_THUMBNAIL_MAX_EDGE,
      exportPadding: 0,
      appState: {
        exportBackground: true,
        viewBackgroundColor: "#ffffff",
      },
    }));
    const options = exportToBlobMock.mock.calls[0][0];
    expect(options.exportingFrame.id).toBe("frame");
    expect(options.elements.map((candidate: { id: string }) => candidate.id)).toEqual([
      "frame",
      "shape",
      "image",
    ]);
    expect(Object.keys(options.files)).toEqual(["used-file"]);
  });

  it("does not invoke Excalidraw export for a stale slide", async () => {
    await expect(renderSlideThumbnail(makeScene({ elements: [] }), "frame"))
      .resolves.toBeNull();
    expect(exportToBlobMock).not.toHaveBeenCalled();
  });
});
