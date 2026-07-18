import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  CLASSROOM_SLIDE_CUSTOM_DATA_KEY,
  deleteSlideBoundary,
  detachElementsFromSlideFrames,
  focusSlide,
  isSlideFrame,
  moveSlide,
  reconcileSlideTitleModes,
  reconcileSlides,
  removeSlide,
  sanitizeClassroomSlideMetadata,
  slideFrameCustomData,
  syncSlideFrameNames,
} from "./slides";

function element(
  id: string,
  type: string,
  overrides: Record<string, unknown> = {},
): ExcalidrawElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    frameId: null,
    groupIds: [],
    isDeleted: false,
    version: 1,
    versionNonce: 11,
    index: id,
    ...overrides,
  } as unknown as ExcalidrawElement;
}

const frame = (
  id: string,
  x: number,
  y: number,
  name: string | null = null,
  tagged = true,
) => element(id, "frame", {
  x,
  y,
  name,
  customData: tagged ? slideFrameCustomData(undefined) : undefined,
});

describe("slide classification and ordering", () => {
  it("accepts only the validated internal slide tag", () => {
    expect(sanitizeClassroomSlideMetadata({ kind: "slide", version: 1 })).toEqual({
      kind: "slide",
      version: 1,
    });
    expect(sanitizeClassroomSlideMetadata({ kind: "slide", version: 2 })).toBeNull();
    expect(sanitizeClassroomSlideMetadata({ kind: "frame", version: 1 })).toBeNull();
    expect(isSlideFrame(frame("slide", 0, 0))).toBe(true);
    expect(isSlideFrame(frame("native", 0, 0, null, false))).toBe(false);
    expect(isSlideFrame(element("shape", "rectangle", {
      customData: { [CLASSROOM_SLIDE_CUSTOM_DATA_KEY]: { kind: "slide", version: 1 } },
    }))).toBe(false);
  });

  it("discovers only tagged slides and then preserves explicit order", () => {
    const initial = reconcileSlides("scene", [
      frame("b", 400, 0),
      frame("native", 200, 0, "Native frame", false),
      frame("a", 0, 0),
    ], []);
    expect(initial.map((slide) => slide.frameId)).toEqual(["a", "b"]);
    const reordered = moveSlide(initial, initial[1].id, initial[0].id);
    const reconciled = reconcileSlides("scene", [frame("a", 0, 0), frame("b", 400, 0)], reordered);
    expect(reconciled.map((slide) => slide.frameId)).toEqual(["b", "a"]);
    expect(reconciled.map((slide) => slide.title)).toEqual(["Slide 1", "Slide 2"]);
  });

  it("renumbers automatic names after reorder and deletion while preserving custom names", () => {
    const initial = reconcileSlides("scene", [
      frame("a", 0, 0, "Slide 1"),
      frame("b", 200, 0, "Lesson opener"),
      frame("c", 400, 0, "Slide 3"),
    ], []);
    const moved = moveSlide(initial, initial[2].id, initial[0].id);
    expect(moved.map((slide) => slide.title)).toEqual(["Slide 1", "Slide 2", "Lesson opener"]);
    expect(removeSlide(moved, moved[0].id).map((slide) => slide.title)).toEqual([
      "Slide 1",
      "Lesson opener",
    ]);

    const synced = syncSlideFrameNames([
      frame("a", 0, 0, "Slide 1"),
      frame("b", 200, 0, "Lesson opener"),
      frame("c", 400, 0, "Slide 3"),
    ], moved);
    const syncedName = (id: string) => {
      const candidate = synced.find((entry) => entry.id === id);
      return candidate?.type === "frame" ? candidate.name : null;
    };
    expect(syncedName("c")).toBe("Slide 1");
    expect(syncedName("a")).toBe("Slide 2");
    expect(syncedName("b")).toBe("Lesson opener");
  });

  it("persists title ownership so a custom Slide N name is never renumbered", () => {
    const initial = reconcileSlides("scene", [
      frame("a", 0, 0, "Slide 1"),
      frame("b", 200, 0, "Slide 2"),
    ], []);
    const renamed = reconcileSlides("scene", [
      frame("a", 0, 0, "Slide 10"),
      frame("b", 200, 0, "Slide 2"),
    ], initial);
    expect(renamed.map(({ title, titleMode }) => [title, titleMode])).toEqual([
      ["Slide 10", "custom"],
      ["Slide 2", "automatic"],
    ]);

    const moved = moveSlide(renamed, renamed[1].id, renamed[0].id);
    expect(moved.map(({ title, titleMode }) => [title, titleMode])).toEqual([
      ["Slide 1", "automatic"],
      ["Slide 10", "custom"],
    ]);
    expect(removeSlide(moved, moved[0].id)[0]).toMatchObject({
      title: "Slide 10",
      titleMode: "custom",
    });
  });

  it("infers legacy title ownership from the authoritative rail position", () => {
    const sceneId = "scene";
    expect(reconcileSlideTitleModes([
      { id: "a", sceneId, frameId: "a", title: "Slide 1" },
      { id: "b", sceneId, frameId: "b", title: "Slide 10" },
    ])).toMatchObject([
      { title: "Slide 1", titleMode: "automatic" },
      { title: "Slide 10", titleMode: "custom" },
    ]);
  });

  it("removes slides when their tagged frame is deleted", () => {
    const initial = reconcileSlides("scene", [frame("a", 0, 0)], []);
    expect(reconcileSlides("scene", [], initial)).toEqual([]);
  });
});

describe("detached slide behavior", () => {
  it("clears only slide frame ownership without changing coordinates, groups, or ordinary frames", () => {
    const slide = frame("slide", 0, 0);
    const native = frame("native", 400, 0, "Native", false);
    const slideChild = element("slide-child", "rectangle", {
      x: 20,
      y: 30,
      frameId: "slide",
      groupIds: ["outer", "inner"],
      boundElements: [{ id: "arrow", type: "arrow" }],
    });
    const nativeChild = element("native-child", "ellipse", {
      x: 450,
      y: 40,
      frameId: "native",
      groupIds: ["native-group"],
    });

    const result = detachElementsFromSlideFrames([slideChild, nativeChild, native, slide]);
    const detached = result.find((candidate) => candidate.id === "slide-child");
    expect(detached).toMatchObject({
      x: 20,
      y: 30,
      frameId: null,
      groupIds: ["outer", "inner"],
      boundElements: [{ id: "arrow", type: "arrow" }],
    });
    expect(result.find((candidate) => candidate.id === "native-child")).toBe(nativeChild);
  });

  it("deletes only the slide boundary and removes its now-obsolete group IDs", () => {
    const slide = frame("slide", 0, 0, "Slide 1") as ExcalidrawElement;
    const groupedSlide = { ...slide, groupIds: ["slide-group"] } as ExcalidrawElement;
    const content = element("content", "rectangle", {
      frameId: "slide",
      groupIds: ["persistent-group", "slide-group"],
    });
    const native = frame("native", 500, 0, "Native", false);
    const nativeChild = element("native-child", "text", {
      frameId: "native",
      groupIds: ["persistent-group"],
    });

    const result = deleteSlideBoundary([content, nativeChild, native, groupedSlide], "slide");
    expect(result.map((candidate) => candidate.id)).toEqual(["content", "native-child", "native"]);
    expect(result[0]).toMatchObject({ frameId: null, groupIds: ["persistent-group"] });
    expect(result[1]).toMatchObject({ frameId: "native", groupIds: ["persistent-group"] });
  });
});

describe("slide focus", () => {
  it("uses the requested Morph duration for tagged slides only", () => {
    const slideFrame = frame("a", 0, 0);
    const scrollToContent = vi.fn();
    const api = {
      getSceneElements: () => [slideFrame],
      scrollToContent,
    } as unknown as ExcalidrawImperativeAPI;

    expect(focusSlide(api, "a", true, 650)).toBe(true);
    expect(scrollToContent).toHaveBeenCalledWith(slideFrame, {
      fitToViewport: true,
      viewportZoomFactor: 0.92,
      animate: true,
      duration: 650,
    });
  });

  it("does not treat an ordinary frame as a slide", () => {
    const api = {
      getSceneElements: () => [frame("native", 0, 0, null, false)],
      scrollToContent: vi.fn(),
    } as unknown as ExcalidrawImperativeAPI;
    expect(focusSlide(api, "native")).toBe(false);
  });
});
