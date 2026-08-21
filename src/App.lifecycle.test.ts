import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER" },
  convertToExcalidrawElements: (elements: unknown[]) => elements,
  DefaultSidebar: () => null,
  Excalidraw: () => null,
  getCommonBounds: () => [0, 0, 0, 0],
  newElementWith: (element: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...element, ...patch }),
  sceneCoordsToViewportCoords: (point: { sceneX: number; sceneY: number }) => ({ x: point.sceneX, y: point.sceneY }),
  serializeAsJSON: (
    elements: unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => JSON.stringify({
    elements,
    // Match Excalidraw's local serializer: browser-only transient state is
    // omitted, while zoom/pan remains persistable scene state.
    appState: Object.fromEntries(Object.entries(appState).filter(([key]) => [
      "gridModeEnabled",
      "openMenu",
      "openSidebar",
      "scrollX",
      "scrollY",
      "theme",
      "zoom",
    ].includes(key))),
    files,
  }),
  Sidebar: () => null,
  viewportCoordsToSceneCoords: (point: { clientX: number; clientY: number }) => ({ x: point.clientX, y: point.clientY }),
}));

// App imports the browser PDF preview adapter at module evaluation time. These
// lifecycle tests exercise exported pure guards only, so loading PDF.js here
// adds no coverage and makes Node emit its legacy-build warning. Keep the test
// boundary explicit instead of normalizing that warning across the suite.
vi.mock("./lib/pdf/dark-preview", () => ({
  fitPdfRasterDimensions: vi.fn(),
  getPdfRasterDimensions: vi.fn(),
  renderDarkPdfPreview: vi.fn(),
}));

vi.stubGlobal("DOMMatrix", class DOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  is2D = true;
  isIdentity = true;
  m11 = 1;
  m12 = 0;
  m13 = 0;
  m14 = 0;
  m21 = 0;
  m22 = 1;
  m23 = 0;
  m24 = 0;
  m31 = 0;
  m32 = 0;
  m33 = 1;
  m34 = 0;
  m41 = 0;
  m42 = 0;
  m43 = 0;
  m44 = 1;
});
vi.stubGlobal("Path2D", class Path2D {});
vi.stubGlobal("ImageData", class ImageData {});
const { canonicalizePersistedWrapperTool } = await import("./lib/safety");
const {
  darkPdfDisplaySceneIsCurrent,
  hydrationChangesMatch,
  pdfAnnotationSummaryMatches,
  pdfAnnotationUndoFitsContentBudget,
  presentationInkPointerDownIsCurrent,
  presentationInkStrokeIsCurrent,
  preserveDeletedForPendingPdfUndo,
  preserveDeletedSceneRecords,
  preservePendingScenePersistence,
  prefersReducedMotion,
  readBoundedProjectFileBytes,
  sceneOperationIsCurrent,
  startupLoadGenerationIsCurrent,
} = await import("./App");
type PendingScene = Parameters<typeof hydrationChangesMatch>[0];

describe("wrapper tool hydration", () => {
  it.each(["classroom-bucket-fill", "classroom-lasso"])(
    "normalizes the legacy %s marker to selection",
    (customType) => {
      const appState: Record<string, unknown> = {
        activeTool: {
          type: "custom",
          customType,
          locked: true,
          lastActiveTool: { type: "rectangle" },
        },
      };

      canonicalizePersistedWrapperTool(appState);

      expect(appState.activeTool).toEqual({
        type: "selection",
        customType: null,
        locked: false,
        lastActiveTool: null,
      });
    },
  );

  it("leaves unrelated custom tools unchanged", () => {
    const activeTool = { type: "custom", customType: "other-wrapper-tool" };
    const appState: Record<string, unknown> = { activeTool };
    canonicalizePersistedWrapperTool(appState);
    expect(appState.activeTool).toBe(activeTool);
  });
});

describe("presentation ink lifecycle guard", () => {
  const stroke = { sceneId: "scene-a", generation: 7 };

  it("accepts only the active freedraw stroke in the same scene generation", () => {
    expect(presentationInkStrokeIsCurrent(stroke, {
      sceneId: "scene-a",
      generation: 7,
      tool: "freedraw",
    })).toBe(true);
  });

  it.each([
    { sceneId: "scene-b", generation: 7, tool: "freedraw" as const },
    { sceneId: "scene-a", generation: 8, tool: "freedraw" as const },
    { sceneId: "scene-a", generation: 7, tool: "laser" as const },
    { sceneId: null, generation: 7, tool: null },
  ])("rejects a stale callback (%s)", (current) => {
    expect(presentationInkStrokeIsCurrent(stroke, current)).toBe(false);
  });
});

describe("presentation ink pointer-down scene guard", () => {
  it("rejects arming while a transition has advanced the active scene ref", () => {
    expect(presentationInkPointerDownIsCurrent("scene-b", "scene-a", true)).toBe(false);
  });

  it("requires the live editor scene to match the active scene", () => {
    expect(presentationInkPointerDownIsCurrent("scene-b", "scene-a", false)).toBe(false);
    expect(presentationInkPointerDownIsCurrent("scene-b", "scene-b", false)).toBe(true);
  });

  it("rejects missing scene identities", () => {
    expect(presentationInkPointerDownIsCurrent(null, null, false)).toBe(false);
  });
});

describe("scene hydration persistence equality", () => {
  const pending = (appState: Record<string, unknown>): PendingScene => ({
    sceneId: "scene-a",
    elements: [],
    appState,
    files: {},
  } as unknown as PendingScene);

  it("keeps a persistable zoom or pan edit made between hydration paints", () => {
    expect(hydrationChangesMatch(
      pending({ scrollX: 0, scrollY: 0, zoom: { value: 1 }, theme: "light" }),
      pending({ scrollX: 120, scrollY: -40, zoom: { value: 1.25 }, theme: "dark" }),
    )).toBe(false);
  });

  it("ignores non-persistable transient state and wrapper-owned preferences", () => {
    expect(hydrationChangesMatch(
      pending({
        openDialog: null,
        openMenu: null,
        openSidebar: null,
        gridModeEnabled: false,
        scrollX: 0,
        scrollY: 0,
        theme: "light",
        zoom: { value: 1 },
      }),
      pending({
        openDialog: { name: "imageExport" },
        openMenu: { name: "canvasActions" },
        openSidebar: { name: "default", tab: "library" },
        gridModeEnabled: true,
        scrollX: 0,
        scrollY: 0,
        theme: "dark",
        zoom: { value: 1 },
      }),
    )).toBe(true);
  });
});

describe("scene hydration buffer ordering", () => {
  const pending = (sceneId: string, scrollX: number): PendingScene => ({
    sceneId,
    elements: [],
    appState: { scrollX, scrollY: 0, zoom: { value: 1 } },
    files: {},
  } as unknown as PendingScene);

  it("lets a same-scene hydration edit replace an older debounced snapshot", () => {
    const result = preservePendingScenePersistence(pending("scene-a", 10), pending("scene-a", 20));
    expect(result.pending?.appState.scrollX).toBe(20);
    expect(result.buffered).toBeNull();
  });

  it("retains a different-scene buffer until the normal pending scene commits", () => {
    const result = preservePendingScenePersistence(pending("scene-a", 10), pending("scene-b", 20));
    expect(result.pending?.sceneId).toBe("scene-a");
    expect(result.buffered?.sceneId).toBe("scene-b");
  });
});

describe("destructive scene persistence", () => {
  it("promotes affected pending scenes so PDF clear Undo retains tombstones", () => {
    const affected = {
      sceneId: "pdf-page-a",
      elements: [],
      appState: {},
      files: {},
    } as unknown as PendingScene;
    const unrelated = {
      ...affected,
      sceneId: "pdf-page-b",
    } as unknown as PendingScene;

    const promoted = preserveDeletedForPendingPdfUndo(affected, ["pdf-page-a"]);

    expect(promoted).not.toBe(affected);
    expect(promoted?.preserveDeleted).toBe(true);
    expect(preserveDeletedForPendingPdfUndo(promoted, ["pdf-page-a"])).toBe(promoted);
    expect(preserveDeletedForPendingPdfUndo(unrelated, ["pdf-page-a"])).toBe(unrelated);
    expect(preserveDeletedForPendingPdfUndo(affected, undefined)).toBe(affected);
  });

  it("retains tombstones in z-order and their otherwise orphaned local files", () => {
    const liveElements = [
      { id: "live-a", type: "rectangle", isDeleted: false },
      { id: "deleted-image", type: "image", isDeleted: true, fileId: "deleted-file" },
      { id: "live-b", type: "text", isDeleted: false },
    ] as unknown as Parameters<typeof preserveDeletedSceneRecords>[0];
    const files = {
      "deleted-file": { id: "deleted-file", dataURL: "data:image/png;base64,AA==" },
      "live-file": { id: "live-file", dataURL: "data:image/png;base64,AQ==" },
    } as unknown as Parameters<typeof preserveDeletedSceneRecords>[1];

    const result = preserveDeletedSceneRecords(
      liveElements,
      files,
      [
        { id: "live-a", type: "rectangle", serialized: true },
        { id: "live-b", type: "text", serialized: true },
        { id: "serializer-extra", type: "line", serialized: true },
      ],
      {
        "live-file": { id: "live-file", dataURL: "data:image/png;base64,AQ==" },
      },
    );

    expect(result.elements.map((element) => element.id)).toEqual([
      "live-a",
      "deleted-image",
      "live-b",
      "serializer-extra",
    ]);
    expect(result.elements[1]).toBe(liveElements[1]);
    expect(Object.keys(result.files).sort()).toEqual(["deleted-file", "live-file"]);
  });
});

describe("PDF annotation transaction guards", () => {
  const summary = {
    scope: "source-document" as const,
    anchorPageId: "page-a",
    annotationCount: 2,
    affectedPageCount: 2,
    affectedPageIds: ["page-a", "page-b"],
    pages: [
      { sceneId: "page-a", annotationCount: 1 },
      { sceneId: "page-b", annotationCount: 1 },
    ],
    sourceIdentity: "source-a",
  };

  it("requires renewed confirmation when destructive scope counts or page identities change", () => {
    expect(pdfAnnotationSummaryMatches(summary, { ...summary })).toBe(true);
    expect(pdfAnnotationSummaryMatches(summary, { ...summary, annotationCount: 3 })).toBe(false);
    expect(pdfAnnotationSummaryMatches(summary, { ...summary, affectedPageCount: 1 })).toBe(false);
    expect(pdfAnnotationSummaryMatches(summary, { ...summary, affectedPageIds: ["page-b", "page-a"] })).toBe(false);
    expect(pdfAnnotationSummaryMatches(summary, { ...summary, sourceIdentity: "source-b" })).toBe(false);
  });

  it("accepts an undo exactly at the content boundary and rejects one byte beyond it", async () => {
    const { createBlankProject } = await import("./types");
    const project = createBlankProject(new Date("2026-08-20T12:00:00.000Z"));
    const exactBytes = new TextEncoder().encode(JSON.stringify(project, null, 2)).byteLength;
    expect(pdfAnnotationUndoFitsContentBudget(project, {}, exactBytes)).toBe(true);
    expect(pdfAnnotationUndoFitsContentBudget(project, {}, exactBytes - 1)).toBe(false);
  });
});

describe("startup autosave load fencing", () => {
  it("accepts only the generation that was current when startup began", () => {
    expect(startupLoadGenerationIsCurrent(0, 0, false)).toBe(true);
    expect(startupLoadGenerationIsCurrent(0, 1, false)).toBe(false);
    expect(startupLoadGenerationIsCurrent(0, 0, true)).toBe(false);
  });
});

describe("project file allocation boundary", () => {
  it("rejects an oversized project before arrayBuffer is called", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const oversizedFile = {
      size: Number.MAX_SAFE_INTEGER,
      arrayBuffer,
    } as unknown as Blob;

    await expect(readBoundedProjectFileBytes(oversizedFile)).rejects.toThrow(
      "Project file is larger than",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("returns bytes for a project within the limit", async () => {
    const source = Uint8Array.from([80, 65, 84, 84, 69, 82]);
    const file = new Blob([source]);

    await expect(readBoundedProjectFileBytes(file)).resolves.toEqual(source);
  });
});

describe("delayed scene operation fencing", () => {
  const operation = {
    projectId: "project-a",
    sceneId: "scene-a",
    hydrationGeneration: 4,
  };

  it("accepts a callback only for the same project, scene, and hydration generation", () => {
    expect(sceneOperationIsCurrent(operation, { ...operation })).toBe(true);
  });

  it.each([
    { projectId: "project-b", sceneId: "scene-a", hydrationGeneration: 4 },
    { projectId: "project-a", sceneId: "scene-b", hydrationGeneration: 4 },
    { projectId: "project-a", sceneId: "scene-a", hydrationGeneration: 5 },
    { ...operation, cancelled: true },
  ])("rejects a stale callback (%s)", (current) => {
    expect(sceneOperationIsCurrent(operation, current)).toBe(false);
  });
});

describe("dark PDF display hydration guard", () => {
  it("allows display updates only after the active scene is the hydrated editor scene", () => {
    expect(darkPdfDisplaySceneIsCurrent(
      "scene-b",
      "scene-b",
      "scene-b",
      false,
    )).toBe(true);
  });

  it.each([
    { active: "scene-a", hydrated: "scene-b", switching: false },
    { active: "scene-b", hydrated: "scene-a", switching: false },
    { active: "scene-b", hydrated: "scene-b", switching: true },
    { active: null, hydrated: "scene-b", switching: false },
    { active: "scene-b", hydrated: null, switching: false },
  ])("rejects an update across an unsettled scene boundary (%s)", ({ active, hydrated, switching }) => {
    expect(darkPdfDisplaySceneIsCurrent(
      "scene-b",
      active,
      hydrated,
      switching,
    )).toBe(false);
  });
});

describe("reduced-motion capability guard", () => {
  it("falls back to normal motion when matchMedia is unavailable or throws", () => {
    const original = window.matchMedia;
    try {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
      expect(prefersReducedMotion()).toBe(false);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => { throw new Error("unsupported"); },
      });
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });
});
