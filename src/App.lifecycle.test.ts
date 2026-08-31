import { describe, expect, it, vi } from "vitest";
import type { ClassroomAlarmCancellationReceiptV1 } from "./lib/classroom-time";

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
  applyClassroomTimeLibraryTransferIntent,
  attachProjectCalendarTransferCache,
  classroomAlarmJobFromDescriptor,
  classroomAlarmIdentitiesForTransactionReceipts,
  classroomAlarmTransactionReceiptMatchesProject,
  classroomTimeAlarmReconciliationNeeded,
  classroomTimeAlarmNoticeAfterSupersedingJob,
  classroomTimeAlarmNoticeCanDismiss,
  classroomAlarmStartWarning,
  classroomTimeActiveTargetAfterSelection,
  classroomTimeAlarmDescriptorsNeedingTrustedStart,
  classroomTimeControlPublicationFenceMatches,
  classroomTimeOperationSceneSignature,
  classroomTimeDisplayTickContentFingerprint,
  classroomTimeDisplayTickElementsMatch,
  classroomTimeSchedulerPublicationFenceMatches,
  classroomTimeTickFenceMatches,
  createClassroomTimeSchedulerIndex,
  darkPdfDisplaySceneIsCurrent,
  forkNativeClassroomTimeWidgetDuplicates,
  finalizeClassroomTimeSchedulerAlarmReservation,
  hydrationChangeMatchesSnapshot,
  hydrationChangesMatch,
  importClassroomTimeCalendarTransfer,
  materializeProjectClassroomTimeWidgets,
  materializeClassroomTimeSceneForDisplay,
  canonicalizePdfBackgroundForPersistence,
  pauseClassroomTimeElementsWithoutMatchingAlarmJob,
  pauseUnauthorizedClassroomTimeWidgetsInProject,
  projectWithPendingScene,
  pdfAnnotationSummaryMatches,
  pdfAnnotationUndoFitsContentBudget,
  presentationClassroomTimeSelectionForLiveScene,
  presentationInkPointerDownIsCurrent,
  presentationInkStrokeIsCurrent,
  protectPresentationSlideFrameElements,
  preserveDeletedForPendingPdfUndo,
  preserveDeletedSceneRecords,
  preservePendingScenePersistence,
  prefersReducedMotion,
  prepareClassroomAlarmPublication,
  prepareClassroomTimeLibraryItemForSelection,
  prepareSameProjectClassroomAlarmReplacement,
  readBoundedProjectFileBytes,
  replacedClassroomTimeAlarmIdentities,
  rollbackClassroomAlarmPublicationReceipts,
  sceneOperationIsCurrent,
  scheduleClassroomTimeConfirmationToast,
  shouldAllowNativePersonalLibraryCanvasDrop,
  snapshotSceneHydrationChange,
  startupLoadGenerationIsCurrent,
  updateClassroomTimeSchedulerSceneIndex,
  updateRememberedPresentationClassroomTimeSelection,
} = await import("./App");
const {
  CLASSROOM_CALENDAR_SCHEMA_VERSION,
  CLASSROOM_ALARM_REGISTRY_STORAGE_KEY,
  acknowledgeBlockedClassroomAlarmJobs,
  activateClassroomAlarmTransaction,
  activeClassroomTimeAlarmDescriptors,
  advanceExpiredClassroomTimeWidget,
  cancelClassroomAlarmIdentitiesWithReceipt,
  createClassroomCalendarStoreV1,
  createDefaultClassroomTimeWidgetMetadata,
  createProjectCalendarTransferCache,
  dueClassroomAlarmJobs,
  readClassroomAlarmRegistry,
  stageCancelledClassroomAlarmReceipt,
  stageSchedulerClassroomAlarmJobs,
  stageTrustedClassroomAlarmJobs,
} = await import("./lib/classroom-time");
const {
  classroomTimeWidgetMetadata,
  createClassroomTimeWidgetScene,
  reconcileClassroomTimeWidgets,
  tickClassroomTimeWidgets,
} = await import("./lib/classroom-time/scene");
const { createBlankProject } = await import("./types");
type PendingScene = Parameters<typeof hydrationChangesMatch>[0];

const calendarEvent = (id: string, title: string) => ({
  schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
  id,
  date: "2026-09-01",
  title,
  color: "#3366CC",
  allDay: true,
  createdAt: "2026-08-21T15:00:00.000Z",
  updatedAt: "2026-08-21T15:00:00.000Z",
});

const idSequence = (prefix: string) => {
  let index = 0;
  return () => `${prefix}-${index++}`;
};

const alarmStorage = (registry?: Record<string, unknown>) => {
  const values = new Map<string, string>();
  if (registry) {
    values.set(CLASSROOM_ALARM_REGISTRY_STORAGE_KEY, JSON.stringify(registry));
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

const runningAlarmProject = (projectId: string, ownerId: string) => {
  const timer = createDefaultClassroomTimeWidgetMetadata("timer", ownerId);
  if (timer.kind !== "timer") throw new Error("Timer defaults changed kind.");
  const created = createClassroomTimeWidgetScene({
    metadata: {
      ...timer,
      runtime: {
        status: "running",
        remainingMs: 60_000,
        deadlineMs: 61_000,
        completedAtMs: null,
      },
    },
    x: 0,
    y: 0,
    now: 1_000,
    createId: idSequence(`${ownerId}-transaction-element`),
  });
  const project = createBlankProject(new Date("2026-08-21T12:00:00.000Z"));
  const scene = project.scenes[project.activeSceneId];
  return {
    ...project,
    id: projectId,
    scenes: {
      ...project.scenes,
      [scene.id]: {
        ...scene,
        elements: created.elements,
        files: Object.fromEntries(created.files.map((file) => [file.id, file])),
      },
    },
  };
};

describe("classroom alarm descriptor boundary", () => {
  it("whitelists the descriptor fields required by strict alarm-job validation", () => {
    const job = classroomAlarmJobFromDescriptor({
      id: "widget-one:timer",
      sourceProjectId: "project-one",
      ownerId: "widget-one",
      widgetKind: "timer",
      target: "timer",
      label: "Class Timer",
      deadlineMs: 1_800_000_060_000,
      createdAtMs: 1_800_000_000_000,
      tone: "warm-chime",
      repeat: false,
    });

    expect(job.id).toBe("widget-one:timer");
    expect(job.target).toBe("timer");
    expect(Object.keys(job).sort()).toEqual([
      "blockedAttempts",
      "createdAtMs",
      "deadlineMs",
      "deliveryState",
      "deliveryStateAtMs",
      "id",
      "label",
      "lastSoundAtMs",
      "ownerId",
      "repeat",
      "soundCount",
      "soundWindowStartedAtMs",
      "sourceProjectId",
      "target",
      "tone",
      "version",
      "widgetKind",
    ]);
  });

  it("removes only the superseded job from a multi-alarm completion notice", () => {
    const blockedJob = (ownerId: string, label: string) => ({
      ...classroomAlarmJobFromDescriptor({
        id: `${ownerId}:timer`,
        sourceProjectId: "project-one",
        ownerId,
        widgetKind: "timer" as const,
        target: "timer" as const,
        label,
        deadlineMs: 1_800_000_060_000,
        createdAtMs: 1_800_000_000_000,
        tone: "warm-chime" as const,
        repeat: false,
      }),
      deliveryState: "blocked" as const,
      deliveryStateAtMs: 1_800_000_060_000,
      blockedAttempts: 1,
    });
    const first = blockedJob("widget-one", "Class Timer");
    const second = blockedJob("widget-two", "Break Timer");
    const notice = {
      jobs: [first, second],
      jobIds: [first.id, second.id],
      message: "Class Timer and Break Timer have finished.",
      blocked: true,
      deliveryPending: false,
    };

    expect(classroomTimeAlarmNoticeAfterSupersedingJob(notice, first.id)).toEqual({
      jobs: [second],
      jobIds: [second.id],
      message: "Break Timer has finished.",
      blocked: true,
      deliveryPending: false,
    });
    expect(classroomTimeAlarmNoticeAfterSupersedingJob(notice, "unrelated:timer"))
      .toBe(notice);
    expect(classroomTimeAlarmNoticeAfterSupersedingJob({
      ...notice,
      jobs: [first],
      jobIds: [first.id],
    }, first.id)).toBeNull();
    expect(classroomTimeAlarmNoticeCanDismiss({
      ...notice,
      deliveryPending: true,
    })).toBe(false);
    expect(classroomTimeAlarmNoticeCanDismiss(notice)).toBe(true);
  });

  it("durably acknowledges only the exact blocked jobs behind Dismiss", async () => {
    const blocked = {
      ...classroomAlarmJobFromDescriptor({
        id: "dismiss-owner:timer",
        sourceProjectId: "dismiss-project",
        ownerId: "dismiss-owner",
        widgetKind: "timer",
        target: "timer",
        label: "Dismiss me",
        createdAtMs: 1_000,
        deadlineMs: 2_000,
        tone: "warm-chime",
        repeat: false,
      }),
      deliveryState: "blocked" as const,
      deliveryStateAtMs: 2_000,
      blockedAttempts: 1,
    };
    const unrelated = {
      ...blocked,
      id: "keep-owner:timer",
      ownerId: "keep-owner",
      label: "Keep me",
    };
    const storage = alarmStorage({
      version: 1,
      revision: 0,
      jobs: [blocked, unrelated],
    });

    const acknowledged = await acknowledgeBlockedClassroomAlarmJobs(
      [blocked],
      2_001,
      storage,
    );
    expect(acknowledged.status).toBe("persisted");
    expect(acknowledged.registry.jobs).toEqual([unrelated]);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([unrelated]);
  });
});

describe("classroom calendar library transfer boundary", () => {
  it("allows only a genuine native Personal Library card drag to reach the canvas", () => {
    const mime = "application/vnd.excalidrawlib+json";
    expect(shouldAllowNativePersonalLibraryCanvasDrop(true, [mime], false)).toBe(true);
    expect(shouldAllowNativePersonalLibraryCanvasDrop(false, [mime], false)).toBe(false);
    expect(shouldAllowNativePersonalLibraryCanvasDrop(true, ["text/plain"], false)).toBe(false);
    expect(shouldAllowNativePersonalLibraryCanvasDrop(true, [mime], true)).toBe(false);
  });

  it("adds a complete private-safe Dashboard item and restores a paused rekeyed widget with a local shell", () => {
    const capturedAt = Date.parse("2026-09-01T12:00:00.000Z");
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "library-dashboard-owner");
    if (dashboard.kind !== "dashboard") throw new Error("Dashboard defaults changed kind.");
    const sourceProject = {
      ...createBlankProject(),
      id: "library-source-project",
      projectCalendar: createClassroomCalendarStoreV1("project", [
        calendarEvent("source-project-event", "SOURCE_PROJECT_LIBRARY_EVENT"),
      ]),
    };
    const metadata = {
      ...dashboard,
      timerRuntime: {
        status: "running" as const,
        remainingMs: 30_000,
        deadlineMs: capturedAt + 30_000,
        completedAtMs: null,
      },
      calendar: {
        ...dashboard.calendar,
        view: "agenda" as const,
        showProjectEvents: true,
        showDeviceEvents: true,
      },
    };
    const created = createClassroomTimeWidgetScene({
      metadata,
      x: 0,
      y: 0,
      now: capturedAt - 1_000,
      createId: idSequence("library-dashboard-element"),
    });
    const sourceFiles = Object.fromEntries(created.files.map((file) => [file.id, file]));
    const displayed = materializeClassroomTimeSceneForDisplay(
      created.elements,
      sourceFiles,
      sourceProject.projectCalendar,
      createClassroomCalendarStoreV1("device", [
        calendarEvent("private-device-event", "PRIVATE_DEVICE_LIBRARY_EVENT"),
      ]),
      capturedAt,
      idSequence("library-dashboard-live"),
    );
    expect(JSON.stringify(displayed.elements)).toContain("PRIVATE_DEVICE_LIBRARY_EVENT");
    const sourceAnchor = displayed.elements.find((element) => classroomTimeWidgetMetadata(element));
    if (!sourceAnchor) throw new Error("Displayed Dashboard anchor is missing.");
    // Native group selection may expose only the anchor in selectedElementIds;
    // the wrapper must expand it to the complete owned widget.
    const selectedElementIds = { [sourceAnchor.id]: true };
    const prepared = prepareClassroomTimeLibraryItemForSelection(
      displayed.elements,
      displayed.files,
      sourceProject,
      selectedElementIds,
      capturedAt + 1,
      idSequence("prepared-library-item"),
    );
    if (!prepared) throw new Error("Complete Dashboard selection was not prepared.");
    expect(prepared.ownerIds).toEqual(["library-dashboard-owner"]);
    expect(JSON.stringify(prepared.item)).toContain("SOURCE_PROJECT_LIBRARY_EVENT");
    expect(JSON.stringify(prepared.item)).not.toContain("PRIVATE_DEVICE_LIBRARY_EVENT");
    expect(prepared.item.elements.some((element) => element.type === "image")).toBe(true);
    expect(prepared.item.elements.every((element) => element.frameId === null)).toBe(true);

    const selectedChild = displayed.elements.find((element) => (
      element.id !== sourceAnchor.id
      && element.groupIds.includes("library-dashboard-owner")
    ));
    if (!selectedChild) throw new Error("Displayed Dashboard child is missing.");
    const preparedFromChild = prepareClassroomTimeLibraryItemForSelection(
      displayed.elements,
      displayed.files,
      sourceProject,
      { [selectedChild.id]: true },
      capturedAt + 1,
      idSequence("prepared-child-library-item"),
    );
    expect(preparedFromChild?.item.elements).toHaveLength(prepared.item.elements.length);

    const unrelated = {
      ...displayed.elements.find((element) => element.type === "text")!,
      id: "unrelated-library-selection",
      customData: undefined,
      groupIds: [],
    };
    expect(() => prepareClassroomTimeLibraryItemForSelection(
      [...displayed.elements, unrelated],
      displayed.files,
      sourceProject,
      { ...selectedElementIds, [unrelated.id]: true },
      capturedAt + 1,
      idSequence("mixed-library-item"),
    )).toThrow(/by itself/i);

    const sourceOwnerId = prepared.ownerIds[0];
    const inserted = prepared.item.elements.map((element, index) => ({
      ...element,
      id: `native-library-insert-${index}`,
      groupIds: element.groupIds.map((groupId) => (
        groupId === sourceOwnerId ? "native-library-owner-group" : groupId
      )),
    }));
    const forked = forkNativeClassroomTimeWidgetDuplicates(
      inserted,
      [],
      capturedAt + 2,
      () => "forked-library-owner",
    );
    expect(forked.elements.map((element) => element.id))
      .toEqual(inserted.map((element) => element.id));
    const forkedAnchor = forked.elements.find((element) => classroomTimeWidgetMetadata(element));
    const forkedMetadata = forkedAnchor && classroomTimeWidgetMetadata(forkedAnchor);
    if (!forkedMetadata || forkedMetadata.kind !== "dashboard") {
      throw new Error("Inserted Dashboard metadata was not restored.");
    }
    expect(forkedMetadata.ownerId).toBe("forked-library-owner");
    expect(forkedMetadata.timerRuntime.status).toBe("paused");
    expect(forkedMetadata.timerRuntime.deadlineMs).toBeNull();

    const destinationCalendar = createClassroomCalendarStoreV1("project");
    const imported = importClassroomTimeCalendarTransfer(
      forkedMetadata,
      "library-destination-project",
      destinationCalendar,
    );
    expect(imported.calendarChanged).toBe(true);
    expect(imported.projectCalendar.events.map((event) => event.title))
      .toEqual(["SOURCE_PROJECT_LIBRARY_EVENT"]);
    const importedAgain = importClassroomTimeCalendarTransfer(
      imported.metadata,
      "library-destination-project",
      imported.projectCalendar,
    );
    expect(importedAgain.calendarChanged).toBe(false);
    expect(importedAgain.projectCalendar.events).toHaveLength(1);

    const withImportedMetadata = forked.elements.map((element) => (
      classroomTimeWidgetMetadata(element)
        ? { ...element, customData: { classroomTimeWidget: imported.metadata } }
        : element
    ));
    const reconciled = reconcileClassroomTimeWidgets(withImportedMetadata, {
      now: capturedAt + 3,
      files: {},
      createId: idSequence("restored-library-shell"),
    });
    expect(reconciled.addedFiles).toHaveLength(1);
    expect(reconciled.addedFiles[0].mimeType).toBe("image/svg+xml");
    expect(reconciled.addedFiles[0].dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("preserves Project A provenance while Project B is open and imports colliding events", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("calendar", "calendar-owner");
    const created = createClassroomTimeWidgetScene({
      metadata,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("calendar-element"),
    });
    const projectA = {
      ...createBlankProject(),
      id: "project-a",
      projectCalendar: createClassroomCalendarStoreV1("project", [
        calendarEvent("collision", "Project A event"),
      ]),
    };
    const projectB = {
      ...createBlankProject(),
      id: "project-b",
      projectCalendar: createClassroomCalendarStoreV1("project", [
        calendarEvent("collision", "Project B event"),
      ]),
    };
    const prepared = attachProjectCalendarTransferCache(created.elements, projectA);
    const preparedAnchor = prepared.find((element) => classroomTimeWidgetMetadata(element));
    const preparedMetadata = preparedAnchor && classroomTimeWidgetMetadata(preparedAnchor);
    if (!preparedAnchor || !preparedMetadata || preparedMetadata.kind !== "calendar"
      || !preparedMetadata.calendar.transferCache) {
      throw new Error("Calendar transfer cache was not prepared.");
    }
    const item = [{
      id: "new-library-item",
      status: "unpublished" as const,
      created: 1,
      name: "Project A calendar",
      elements: created.elements,
    }] as Parameters<typeof applyClassroomTimeLibraryTransferIntent>[0];
    const applied = applyClassroomTimeLibraryTransferIntent(item, {
      baselineItemIds: new Set(["existing-item"]),
      cacheByAnchorId: new Map([[preparedAnchor.id, {
        ownerId: preparedMetadata.ownerId,
        kind: "calendar",
        transferCache: preparedMetadata.calendar.transferCache,
      }]]),
      expiresAt: 10_000,
    });
    expect(applied.matchedItemId).toBe("new-library-item");
    const cachedAnchor = applied.items[0].elements.find((element) => (
      classroomTimeWidgetMetadata(element)?.kind === "calendar"
    ));
    const cachedMetadata = cachedAnchor && classroomTimeWidgetMetadata(cachedAnchor);
    if (!cachedMetadata || cachedMetadata.kind !== "calendar"
      || !cachedMetadata.calendar.transferCache) {
      throw new Error("Library item did not receive its source cache.");
    }
    const sourceCache = cachedMetadata.calendar.transferCache;
    expect(sourceCache.sourceProjectId).toBe("project-a");
    expect(sourceCache.events.map((event) => event.title)).toEqual(["Project A event"]);

    const whileBIsOpen = attachProjectCalendarTransferCache(
      applied.items[0].elements,
      projectB,
    );
    expect(whileBIsOpen).toBe(applied.items[0].elements);
    expect(classroomTimeWidgetMetadata(cachedAnchor)?.kind).toBe("calendar");

    const imported = importClassroomTimeCalendarTransfer(
      cachedMetadata,
      projectB.id,
      projectB.projectCalendar,
    );
    expect(imported.calendarChanged).toBe(true);
    expect(imported.projectCalendar.events.map((event) => event.title).sort()).toEqual([
      "Project A event",
      "Project B event",
    ]);
    if (imported.metadata.kind !== "calendar") throw new Error("Imported widget changed kind.");
    expect(imported.metadata.calendar.projectEventIds).toHaveLength(1);
    expect(imported.metadata.calendar.transferCache).toBeNull();
  });

  it("keeps same-project all-events dynamic and fails closed for an empty cross-project cache", () => {
    const allEvents = createDefaultClassroomTimeWidgetMetadata("calendar", "all-events-owner");
    if (allEvents.kind !== "calendar") throw new Error("Calendar defaults changed kind.");
    const sourceWithEvent = createClassroomCalendarStoreV1("project", [
      calendarEvent("later-event", "Added later"),
    ]);
    const sameProjectCache = createProjectCalendarTransferCache("project-a", sourceWithEvent);
    const sameProject = importClassroomTimeCalendarTransfer({
      ...allEvents,
      calendar: { ...allEvents.calendar, transferCache: sameProjectCache },
    }, "project-a", sourceWithEvent);
    if (sameProject.metadata.kind !== "calendar") throw new Error("Widget changed kind.");
    expect(sameProject.metadata.calendar.projectEventIds).toEqual([]);
    expect(sameProject.metadata.calendar.showProjectEvents).toBe(true);
    expect(sameProject.metadata.calendar.transferCache).toBeNull();

    const emptyCache = createProjectCalendarTransferCache(
      "empty-project",
      createClassroomCalendarStoreV1("project"),
    );
    const crossProject = importClassroomTimeCalendarTransfer({
      ...allEvents,
      calendar: { ...allEvents.calendar, transferCache: emptyCache },
    }, "project-b", sourceWithEvent);
    if (crossProject.metadata.kind !== "calendar") throw new Error("Widget changed kind.");
    expect(crossProject.metadata.calendar.projectEventIds).toEqual([]);
    expect(crossProject.metadata.calendar.showProjectEvents).toBe(false);
  });

  it("does not enrich an imported or pre-existing item without a matching Add intent", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("calendar", "unmatched-owner");
    const created = createClassroomTimeWidgetScene({
      metadata,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("unmatched-element"),
    });
    const items = [{
      id: "imported-item",
      status: "unpublished" as const,
      created: 1,
      name: "Imported",
      elements: created.elements,
    }] as Parameters<typeof applyClassroomTimeLibraryTransferIntent>[0];
    expect(applyClassroomTimeLibraryTransferIntent(items, null).items).toBe(items);
    expect(applyClassroomTimeLibraryTransferIntent(items, {
      baselineItemIds: new Set(["imported-item"]),
      cacheByAnchorId: new Map(),
      expiresAt: 10_000,
    }).items).toBe(items);
  });
});

describe("native Classroom Time duplication boundary", () => {
  it("preserves Excalidraw duplicate IDs, selection targets, bindings, and originals", () => {
    const timer = createDefaultClassroomTimeWidgetMetadata("timer", "source-owner");
    if (timer.kind !== "timer") throw new Error("Timer defaults changed kind.");
    const running = {
      ...timer,
      runtime: {
        status: "running" as const,
        remainingMs: 120_000,
        deadlineMs: 121_000,
        completedAtMs: null,
      },
    };
    const created = createClassroomTimeWidgetScene({
      metadata: running,
      x: 10,
      y: 20,
      now: 1_000,
      groupIds: ["outer-group"],
      createId: idSequence("source-element"),
    });
    const duplicates = created.elements.map((element, index) => ({
      ...element,
      id: `native-duplicate-${index}`,
      groupIds: element.groupIds.map((groupId) => (
        groupId === "source-owner" ? "native-owner-group" : groupId
      )),
    }));
    const duplicateAnchor = duplicates.find((element) => classroomTimeWidgetMetadata(element));
    if (!duplicateAnchor) throw new Error("Duplicate anchor is missing.");
    const connector = {
      ...duplicates[1],
      id: "native-connector",
      type: "line",
      customData: undefined,
      groupIds: [],
      startBinding: { elementId: duplicateAnchor.id, focus: 0, gap: 2 },
      endBinding: null,
    } as typeof duplicates[number];
    const nextElements = [...created.elements, ...duplicates, connector];
    const createId = vi.fn(() => "forked-owner");
    const forked = forkNativeClassroomTimeWidgetDuplicates(
      nextElements,
      created.elements,
      31_000,
      createId,
    );

    expect(forked.elements.map((element) => element.id))
      .toEqual(nextElements.map((element) => element.id));
    created.elements.forEach((element, index) => expect(forked.elements[index]).toBe(element));
    expect(forked.elementIdMap).toEqual({});
    expect(createId).toHaveBeenCalledTimes(1);
    const forkedAnchor = forked.elements.find((element) => element.id === duplicateAnchor.id);
    const forkedMetadata = forkedAnchor && classroomTimeWidgetMetadata(forkedAnchor);
    expect(forkedMetadata?.ownerId).toBe("forked-owner");
    expect(forkedAnchor?.groupIds).toContain("forked-owner");
    const forkedConnector = forked.elements.find((element) => element.id === connector.id);
    expect(forkedConnector).toBe(connector);
    expect((forkedConnector as unknown as {
      startBinding?: { elementId: string };
    }).startBinding?.elementId).toBe(duplicateAnchor.id);
  });
});

describe("bounded Classroom Time scheduler index", () => {
  it("early-indexes empty projects and caps malformed live input at 64 widgets", () => {
    const blank = createBlankProject();
    expect(createClassroomTimeSchedulerIndex(blank)).toMatchObject({ widgetCount: 0 });

    const template = blank.scenes[blank.activeSceneId];
    const scenes = Object.fromEntries(Array.from({ length: 70 }, (_, index) => {
      const sceneId = `scene-${index}`;
      const created = createClassroomTimeWidgetScene({
        metadata: createDefaultClassroomTimeWidgetMetadata("clock", `owner-${index}`),
        x: 0,
        y: 0,
        now: 1_000,
        createId: idSequence(`widget-${index}`),
      });
      return [sceneId, { ...template, id: sceneId, elements: created.elements }];
    }));
    const oversized = { ...blank, activeSceneId: "scene-0", scenes };
    const bounded = createClassroomTimeSchedulerIndex(oversized);
    expect(bounded.widgetCount).toBe(64);
    expect(bounded.scenes.size).toBe(64);

    const oneWidget = Object.values(scenes)[0].elements;
    const live = updateClassroomTimeSchedulerSceneIndex(
      createClassroomTimeSchedulerIndex(blank),
      blank.id,
      blank.activeSceneId,
      oneWidget,
    );
    expect(live.widgetCount).toBe(1);
    expect(updateClassroomTimeSchedulerSceneIndex(
      live,
      blank.id,
      blank.activeSceneId,
      [],
    ).widgetCount).toBe(0);
  });
});

describe("Classroom Time persistence and alarm display boundaries", () => {
  it("keeps transient PDF refinement out of persistence and alarm-operation fences", () => {
    const blank = createBlankProject(new Date("2026-08-21T12:00:00.000Z"));
    const scene = blank.scenes[blank.activeSceneId];
    const background = {
      id: "stable-pdf-background",
      type: "image",
      fileId: "source-pdf-page",
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
      versionNonce: 1,
      updated: 1,
      customData: {
        classroomRole: "pdf-background",
        pdfDocumentId: "pdf-document",
        pdfPageIndex: 0,
      },
    };
    const sourceFile = {
      id: "source-pdf-page",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AA==",
      created: 1,
    };
    const pdfScene = {
      ...scene,
      appState: { ...scene.appState, openMenu: null, openSidebar: null },
      elements: [background],
      files: { [sourceFile.id]: sourceFile },
      pdfPage: {
        documentId: "pdf-document",
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0 as const,
        backgroundElementId: background.id,
      },
    };
    const project = {
      ...blank,
      scenes: { ...blank.scenes, [scene.id]: pdfScene },
      pdfPageOrder: [scene.id],
    };
    const previewFile = {
      ...sourceFile,
      id: "transient-sharp-preview",
      dataURL: "data:image/png;base64,BBBB",
      created: 2,
    };
    const previewBackground = {
      ...background,
      fileId: previewFile.id,
      version: 42,
      versionNonce: 42,
      updated: 42,
    };
    const previewFiles = {
      [sourceFile.id]: sourceFile,
      [previewFile.id]: previewFile,
    };
    const transientIds = new Set([previewFile.id]);
    const previewElements = [previewBackground] as unknown as Parameters<typeof classroomTimeOperationSceneSignature>[1];
    const canonicalElements = [background] as unknown as Parameters<typeof classroomTimeOperationSceneSignature>[1];
    const sourceFiles = { [sourceFile.id]: sourceFile } as unknown as Parameters<typeof classroomTimeOperationSceneSignature>[2];
    const livePreviewFiles = previewFiles as unknown as Parameters<typeof classroomTimeOperationSceneSignature>[2];

    const persistent = canonicalizePdfBackgroundForPersistence(
      pdfScene,
      [previewBackground],
    );
    expect(persistent).toEqual([background]);
    const committed = projectWithPendingScene(project, {
      sceneId: scene.id,
      elements: previewElements,
      appState: pdfScene.appState as unknown as Parameters<typeof projectWithPendingScene>[1]["appState"],
      files: sourceFiles,
    });
    expect(committed).toBe(project);
    expect(committed?.updatedAt).toBe(project.updatedAt);

    const canonicalSignature = classroomTimeOperationSceneSignature(
      pdfScene,
      canonicalElements,
      sourceFiles,
      transientIds,
    );
    const previewSignature = classroomTimeOperationSceneSignature(
      pdfScene,
      previewElements,
      livePreviewFiles,
      transientIds,
    );
    expect(previewSignature).toEqual(canonicalSignature);

    const annotation = {
      ...background,
      id: "student-annotation",
      type: "rectangle",
      fileId: null,
      locked: false,
      customData: undefined,
      index: "a1",
      version: 1,
    };
    const annotatedElements = [previewBackground, annotation] as unknown as Parameters<typeof classroomTimeOperationSceneSignature>[1];
    const beforeEdit = classroomTimeOperationSceneSignature(
      pdfScene,
      annotatedElements,
      livePreviewFiles,
      transientIds,
    );
    const editedElements = [
      previewBackground,
      { ...annotation, x: 24, version: 2 },
    ] as unknown as Parameters<typeof classroomTimeOperationSceneSignature>[1];
    const afterEdit = classroomTimeOperationSceneSignature(
      pdfScene,
      editedElements,
      livePreviewFiles,
      transientIds,
    );
    expect(afterEdit).not.toEqual(beforeEdit);
  });

  it("keeps device titles out of a direct scene commit and rematerializes them locally", () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata("calendar", "calendar-owner");
    const created = createClassroomTimeWidgetScene({
      metadata,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("privacy-widget"),
    });
    const projectCalendar = createClassroomCalendarStoreV1("project", [
      calendarEvent("project-event", "Project planning day"),
    ]);
    const deviceCalendar = createClassroomCalendarStoreV1("device", [
      calendarEvent("device-event", "Private device appointment"),
    ]);
    const files = Object.fromEntries(created.files.map((file) => [file.id, file]));
    const displayed = materializeClassroomTimeSceneForDisplay(
      created.elements,
      files,
      projectCalendar,
      deviceCalendar,
      1_800_000_000_000,
      idSequence("display-row"),
    );
    expect(JSON.stringify(displayed.elements)).toContain("Private device appointment");
    expect(JSON.stringify(displayed.elements)).toContain("Project planning day");

    const blank = createBlankProject();
    const scene = blank.scenes[blank.activeSceneId];
    const project = {
      ...blank,
      projectCalendar,
      scenes: {
        ...blank.scenes,
        [scene.id]: {
          ...scene,
          elements: created.elements,
          files,
        },
      },
    };
    const committed = projectWithPendingScene(project, {
      sceneId: scene.id,
      elements: displayed.elements,
      appState: scene.appState as unknown as Parameters<typeof projectWithPendingScene>[1]["appState"],
      files: displayed.files,
      preserveDeleted: true,
    });
    if (!committed) throw new Error("Scene commit failed.");
    const archiveJson = JSON.stringify(committed);
    expect(archiveJson).not.toContain("Private device appointment");
    expect(archiveJson).toContain("Project planning day");

    const storedScene = committed.scenes[scene.id];
    const reloadedDisplay = materializeClassroomTimeSceneForDisplay(
      storedScene.elements as Parameters<typeof materializeClassroomTimeSceneForDisplay>[0],
      storedScene.files as Parameters<typeof materializeClassroomTimeSceneForDisplay>[1],
      committed.projectCalendar,
      deviceCalendar,
      1_800_000_000_000,
      idSequence("reloaded-row"),
    );
    expect(JSON.stringify(reloadedDisplay.elements)).toContain("Private device appointment");

    const canonicalBeforeExport = JSON.stringify(committed);
    const exportCopy = materializeProjectClassroomTimeWidgets(
      committed,
      1_800_000_000_000,
      deviceCalendar,
      "dark",
      idSequence("pdf-export-device-row"),
    );
    expect(JSON.stringify(exportCopy.scenes[scene.id].elements))
      .toContain("Private device appointment");
    expect(Object.keys(exportCopy.scenes[scene.id].files).length).toBeGreaterThan(0);
    expect(JSON.stringify(committed)).toBe(canonicalBeforeExport);
    expect(exportCopy.updatedAt).toBe(committed.updatedAt);
  });

  it("suppresses revision-normalized display ticks without suppressing user or widget-state edits", () => {
    const timer = createDefaultClassroomTimeWidgetMetadata("timer", "tick-fence-owner");
    if (timer.kind !== "timer") throw new Error("Timer defaults changed kind.");
    const created = createClassroomTimeWidgetScene({
      metadata: {
        ...timer,
        timer: { ...timer.timer, durationMs: 10_000 },
        runtime: {
          status: "running",
          remainingMs: 10_000,
          deadlineMs: 11_000,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("display-tick-widget"),
    });
    const ticked = tickClassroomTimeWidgets(created.elements, 2_100);
    expect(ticked).not.toBe(created.elements);

    // Excalidraw may normalize these three bookkeeping fields while applying
    // updateScene(). That callback is still the exact wrapper-owned display
    // tick and must return before projectWithPendingScene/autosave.
    const revisionNormalized = ticked.map((element) => ({
      ...element,
      version: element.version + 1,
      versionNonce: element.versionNonce + 1,
      updated: element.updated + 1,
    }));
    expect(classroomTimeDisplayTickElementsMatch(ticked, revisionNormalized)).toBe(true);
    const tickFence = {
      sceneId: "timer-scene",
      elementFingerprint: "pre-normalization-revision-fingerprint",
      fileFingerprint: "",
      expectedDisplayContentFingerprint: classroomTimeDisplayTickContentFingerprint(ticked),
    };
    expect(classroomTimeTickFenceMatches(
      tickFence,
      "timer-scene",
      revisionNormalized,
      {},
    )).toBe(true);

    // The runtime fence stores an immutable signature before updateScene.
    // Excalidraw owns and may mutate the element objects in place, so live
    // object identity must never make a later user edit look like the tick.
    const inPlaceElements = ticked.map((element) => ({ ...element }));
    const inPlaceFence = {
      ...tickFence,
      expectedDisplayContentFingerprint: classroomTimeDisplayTickContentFingerprint(inPlaceElements),
    };
    for (const element of inPlaceElements) {
      const mutable = element as unknown as Record<string, unknown>;
      mutable.version = element.version + 1;
      mutable.versionNonce = element.versionNonce + 1;
      mutable.updated = element.updated + 1;
    }
    expect(classroomTimeTickFenceMatches(
      inPlaceFence,
      "timer-scene",
      inPlaceElements,
      {},
    )).toBe(true);
    (inPlaceElements[0] as unknown as Record<string, unknown>).x = inPlaceElements[0].x + 1;
    expect(classroomTimeTickFenceMatches(
      inPlaceFence,
      "timer-scene",
      inPlaceElements,
      {},
    )).toBe(false);

    // A concurrent layer-order edit, move/draw, or semantic widget metadata
    // transition differs in persisted content, so it must fall through to
    // normal scene persistence even while a display-tick fence is outstanding.
    const reorderedByIndex = revisionNormalized.map((element) => ({ ...element }));
    (reorderedByIndex[0] as unknown as Record<string, unknown>).index = "semantic-z-order-edit";
    expect(classroomTimeTickFenceMatches(
      tickFence,
      "timer-scene",
      reorderedByIndex,
      {},
    )).toBe(false);
    const moved = revisionNormalized.map((element, index) => (
      index === 0 ? { ...element, x: element.x + 1 } : element
    ));
    expect(classroomTimeTickFenceMatches(tickFence, "timer-scene", moved, {})).toBe(false);
    expect(classroomTimeTickFenceMatches(
      tickFence,
      "timer-scene",
      [...revisionNormalized].reverse(),
      {},
    )).toBe(false);
    const transitioned = revisionNormalized.map((element) => {
      const metadata = classroomTimeWidgetMetadata(element);
      if (!metadata) return element;
      const advanced = advanceExpiredClassroomTimeWidget(metadata, 11_001);
      return {
        ...element,
        customData: {
          ...element.customData,
          classroomTimeWidget: advanced.metadata,
        },
      };
    });
    expect(classroomTimeTickFenceMatches(
      tickFence,
      "timer-scene",
      transitioned,
      {},
    )).toBe(false);
    expect(classroomTimeTickFenceMatches(
      tickFence,
      "another-scene",
      revisionNormalized,
      {},
    )).toBe(false);
  });

  it("accepts a revision-normalized trusted Start publication without accepting stale idle content", () => {
    const timer = createDefaultClassroomTimeWidgetMetadata(
      "timer",
      "trusted-start-fence-owner",
    );
    if (timer.kind !== "timer") throw new Error("Timer defaults changed kind.");
    const idle = createClassroomTimeWidgetScene({
      metadata: timer,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("trusted-start-fence-element"),
    }).elements;
    const running = createClassroomTimeWidgetScene({
      metadata: {
        ...timer,
        runtime: {
          status: "running",
          remainingMs: timer.timer.durationMs,
          deadlineMs: 1_000 + timer.timer.durationMs,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("trusted-start-fence-element"),
    }).elements;
    const normalizeRevisions = (elements: typeof idle) => elements.map((element) => ({
      ...element,
      version: element.version + 1,
      versionNonce: element.versionNonce + 1,
      updated: element.updated + 1,
    }));
    const runningFence = {
      sceneId: "timer-scene",
      elementFingerprint: "running-revisions",
      fileFingerprint: "",
      expectedDisplayContentFingerprint: classroomTimeDisplayTickContentFingerprint(running),
    };

    expect(classroomTimeTickFenceMatches(
      runningFence,
      "timer-scene",
      normalizeRevisions(idle),
      {},
    )).toBe(false);

    const runningCallback = normalizeRevisions(running);
    expect(classroomTimeTickFenceMatches(
      runningFence,
      "timer-scene",
      runningCallback,
      {},
    )).toBe(true);
    const movedRunningCallback = runningCallback.map((element, index) => (
      index === 0 ? { ...element, x: element.x + 1 } : element
    ));
    expect(classroomTimeTickFenceMatches(
      runningFence,
      "timer-scene",
      movedRunningCallback,
      {},
    )).toBe(false);
  });

  it("expires widget-added confirmation on a hard deadline without clearing a newer notice", () => {
    vi.useFakeTimers();
    try {
      const current = { current: null as { token: number; message: string } | null };
      const published: Array<{ token: number; message: string } | null> = [];
      const publish = (toast: { token: number; message: string } | null) => {
        published.push(toast);
      };
      const cancelFirst = scheduleClassroomTimeConfirmationToast(
        { token: 1, message: "Timer added." },
        current,
        publish,
        2_500,
      );
      expect(current.current?.message).toBe("Timer added.");
      vi.advanceTimersByTime(2_499);
      expect(published).toEqual([{ token: 1, message: "Timer added." }]);
      vi.advanceTimersByTime(1);
      expect(current.current).toBeNull();
      expect(published).toEqual([{ token: 1, message: "Timer added." }, null]);
      cancelFirst();

      const cancelSecond = scheduleClassroomTimeConfirmationToast(
        { token: 2, message: "Clock added." },
        current,
        publish,
        2_500,
      );
      current.current = { token: 3, message: "Newer notice" };
      vi.advanceTimersByTime(2_500);
      expect(current.current).toEqual({ token: 3, message: "Newer notice" });
      expect(published.at(-1)).toEqual({ token: 2, message: "Clock added." });
      cancelSecond();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses a restored running widget unless its exact durable alarm exists", () => {
    const timer = createDefaultClassroomTimeWidgetMetadata("timer", "timer-owner");
    if (timer.kind !== "timer") throw new Error("Timer defaults changed kind.");
    const running = {
      ...timer,
      runtime: {
        status: "running" as const,
        remainingMs: 60_000,
        deadlineMs: 61_000,
        completedAtMs: null,
      },
    };
    const created = createClassroomTimeWidgetScene({
      metadata: running,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("alarm-widget"),
    });
    const descriptor = activeClassroomTimeAlarmDescriptors(
      "project-one",
      created.elements,
    )[0];
    if (!descriptor) throw new Error("Running timer descriptor is missing.");
    const emptyRegistry = {
      version: 1 as const,
      revision: 0,
      jobs: [],
      deliveredTombstones: [],
      cancellationTombstones: [],
    };
    const paused = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
      created.elements,
      "project-one",
      emptyRegistry,
      2_000,
    );
    const pausedAnchor = paused.find((element) => classroomTimeWidgetMetadata(element));
    const pausedMetadata = pausedAnchor && classroomTimeWidgetMetadata(pausedAnchor);
    expect(pausedMetadata?.kind).toBe("timer");
    if (!pausedMetadata || pausedMetadata.kind !== "timer") {
      throw new Error("Paused timer metadata is missing.");
    }
    expect(pausedMetadata.runtime.status).toBe("paused");

    const authorized = pauseClassroomTimeElementsWithoutMatchingAlarmJob(
      created.elements,
      "project-one",
      { ...emptyRegistry, jobs: [classroomAlarmJobFromDescriptor(descriptor)] },
      2_000,
    );
    expect(authorized).toBe(created.elements);
  });
});

describe("same-project archive alarm authority", () => {
  const runningTimerProject = (projectId: string, ownerId: string) => {
    const timer = createDefaultClassroomTimeWidgetMetadata("timer", ownerId);
    if (timer.kind !== "timer") throw new Error("Timer defaults changed kind.");
    const created = createClassroomTimeWidgetScene({
      metadata: {
        ...timer,
        runtime: {
          status: "running",
          remainingMs: 60_000,
          deadlineMs: 61_000,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence(`${ownerId}-element`),
    });
    const project = createBlankProject(new Date("2026-08-21T12:00:00.000Z"));
    const scene = project.scenes[project.activeSceneId];
    return {
      ...project,
      id: projectId,
      scenes: {
        ...project.scenes,
        [scene.id]: {
          ...scene,
          elements: created.elements,
          files: Object.fromEntries(created.files.map((file) => [file.id, file])),
        },
      },
    };
  };
  const emptyRegistry = () => ({
    version: 1 as const,
    revision: 0,
    jobs: [],
    deliveredTombstones: [],
    cancellationTombstones: [],
  });

  it("cancels an exact outgoing alarm omitted by a same-ID archive", () => {
    const outgoing = runningTimerProject("same-project", "omitted-owner");
    const incoming = { ...createBlankProject(), id: outgoing.id };
    const descriptor = activeClassroomTimeAlarmDescriptors(
      outgoing.id,
      outgoing.scenes[outgoing.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!descriptor) throw new Error("Outgoing timer descriptor is missing.");
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      { ...emptyRegistry(), jobs: [classroomAlarmJobFromDescriptor(descriptor)] },
      2_000,
    );
    expect(prepared.cancelledIdentities).toEqual([{
      sourceProjectId: outgoing.id,
      ownerId: "omitted-owner",
      target: "timer",
    }]);
    expect(prepared.state.jobs).toEqual([]);
    expect(prepared.state.cancellationTombstones).toHaveLength(1);
  });

  it("pauses an incoming generation fenced by an earlier cancellation", () => {
    const outgoing = { ...createBlankProject(), id: "same-project" };
    const incoming = runningTimerProject(outgoing.id, "cancelled-owner");
    const descriptor = activeClassroomTimeAlarmDescriptors(
      incoming.id,
      incoming.scenes[incoming.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!descriptor) throw new Error("Incoming timer descriptor is missing.");
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      {
        ...emptyRegistry(),
        cancellationTombstones: [{
          version: 1,
          sourceProjectId: incoming.id,
          ownerId: descriptor.ownerId,
          target: descriptor.target,
          cancelledAtMs: descriptor.createdAtMs,
          cancelledGeneration: {
            jobId: descriptor.id,
            createdAtMs: descriptor.createdAtMs,
            deadlineMs: descriptor.deadlineMs,
          },
          restoredAtMs: null,
        }],
      },
      2_000,
    );
    expect(prepared.state.jobs).toEqual([]);
    expect(prepared.pausedIdentities).toHaveLength(1);
    const anchor = prepared.project.scenes[prepared.project.activeSceneId].elements.find(
      (element) => classroomTimeWidgetMetadata(element as Parameters<typeof classroomTimeWidgetMetadata>[0]),
    );
    const metadata = anchor && classroomTimeWidgetMetadata(
      anchor as Parameters<typeof classroomTimeWidgetMetadata>[0],
    );
    expect(metadata?.kind).toBe("timer");
    if (!metadata || metadata.kind !== "timer") throw new Error("Paused timer is missing.");
    expect(metadata.runtime.status).toBe("paused");
  });

  it("recovers a safe incoming running generation", () => {
    const outgoing = { ...createBlankProject(), id: "same-project" };
    const incoming = runningTimerProject(outgoing.id, "recoverable-owner");
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      emptyRegistry(),
      2_000,
    );
    expect(prepared.state.jobs).toHaveLength(1);
    expect(prepared.state.jobs[0]).toMatchObject({
      sourceProjectId: incoming.id,
      ownerId: "recoverable-owner",
      deliveryState: "pending",
    });
    expect(prepared.pausedIdentities).toEqual([]);
    expect(prepared.project).toBe(incoming);
  });

  it("preserves unrelated jobs while recovering a different project's running alarm", () => {
    const outgoing = runningTimerProject("project-a", "owner-a");
    const incoming = runningTimerProject("project-b", "owner-b");
    const descriptor = activeClassroomTimeAlarmDescriptors(
      outgoing.id,
      outgoing.scenes[outgoing.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!descriptor) throw new Error("Outgoing timer descriptor is missing.");
    const existingJob = classroomAlarmJobFromDescriptor(descriptor);
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      { ...emptyRegistry(), jobs: [existingJob] },
      2_000,
    );
    expect(prepared.project).toBe(incoming);
    expect(prepared.state.jobs).toHaveLength(2);
    expect(prepared.state.jobs).toEqual(expect.arrayContaining([
      existingJob,
      expect.objectContaining({
        sourceProjectId: incoming.id,
        ownerId: "owner-b",
        deliveryState: "pending",
      }),
    ]));
    expect(prepared.cancelledIdentities).toEqual([]);
    expect(prepared.pausedIdentities).toEqual([]);
  });

  it("pauses a different project's incoming generation behind a durable cancellation fence", () => {
    const outgoing = runningTimerProject("project-a", "owner-a");
    const incoming = runningTimerProject("project-b", "owner-b");
    const descriptor = activeClassroomTimeAlarmDescriptors(
      incoming.id,
      incoming.scenes[incoming.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!descriptor) throw new Error("Incoming timer descriptor is missing.");
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      {
        ...emptyRegistry(),
        cancellationTombstones: [{
          version: 1,
          sourceProjectId: incoming.id,
          ownerId: descriptor.ownerId,
          target: descriptor.target,
          cancelledAtMs: descriptor.createdAtMs,
          cancelledGeneration: {
            jobId: descriptor.id,
            createdAtMs: descriptor.createdAtMs,
            deadlineMs: descriptor.deadlineMs,
          },
          restoredAtMs: null,
        }],
      },
      2_000,
    );
    expect(prepared.state.jobs).toEqual([]);
    expect(prepared.pausedIdentities).toEqual([{
      sourceProjectId: incoming.id,
      ownerId: "owner-b",
      target: "timer",
    }]);
  });

  it("preserves an unrelated job when a different project reuses its compact alarm ID", () => {
    const outgoing = runningTimerProject("project-a", "collision-owner");
    const incoming = runningTimerProject("project-b", "collision-owner");
    const outgoingDescriptor = activeClassroomTimeAlarmDescriptors(
      outgoing.id,
      outgoing.scenes[outgoing.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!outgoingDescriptor) throw new Error("Outgoing timer descriptor is missing.");
    const outgoingJob = classroomAlarmJobFromDescriptor(outgoingDescriptor);
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      { ...emptyRegistry(), jobs: [outgoingJob] },
      2_000,
    );
    expect(prepared.state.jobs).toEqual([outgoingJob]);
    expect(prepared.pausedIdentities).toEqual([{
      sourceProjectId: incoming.id,
      ownerId: "collision-owner",
      target: "timer",
    }]);
  });

  it("fails closed when a different project's incoming alarm exceeds device capacity", () => {
    const outgoing = runningTimerProject("project-a", "owner-a");
    const incoming = runningTimerProject("project-b", "owner-b");
    const jobs = Array.from({ length: 32 }, (_, index) => {
      const project = runningTimerProject("capacity-project", `capacity-owner-${index}`);
      const descriptor = activeClassroomTimeAlarmDescriptors(
        project.id,
        project.scenes[project.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
      )[0];
      if (!descriptor) throw new Error("Capacity timer descriptor is missing.");
      return classroomAlarmJobFromDescriptor(descriptor);
    });
    expect(() => prepareSameProjectClassroomAlarmReplacement(
      outgoing,
      incoming,
      { ...emptyRegistry(), jobs },
      2_000,
    )).toThrow("The device already has 32 active classroom alarms.");
  });

  it("uses the same cancellation fence when hydrating an interrupted autosave", () => {
    const incoming = runningTimerProject("startup-project", "cancelled-before-save");
    const descriptor = activeClassroomTimeAlarmDescriptors(
      incoming.id,
      incoming.scenes[incoming.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!descriptor) throw new Error("Incoming timer descriptor is missing.");
    const prepared = prepareSameProjectClassroomAlarmReplacement(
      null,
      incoming,
      {
        ...emptyRegistry(),
        cancellationTombstones: [{
          version: 1,
          sourceProjectId: incoming.id,
          ownerId: descriptor.ownerId,
          target: descriptor.target,
          cancelledAtMs: descriptor.createdAtMs,
          cancelledGeneration: {
            jobId: descriptor.id,
            createdAtMs: descriptor.createdAtMs,
            deadlineMs: descriptor.deadlineMs,
          },
          restoredAtMs: null,
        }],
      },
      2_000,
    );
    const anchor = prepared.project.scenes[prepared.project.activeSceneId].elements.find(
      (element) => classroomTimeWidgetMetadata(element as Parameters<typeof classroomTimeWidgetMetadata>[0]),
    );
    const metadata = anchor && classroomTimeWidgetMetadata(
      anchor as Parameters<typeof classroomTimeWidgetMetadata>[0],
    );
    if (!metadata || metadata.kind !== "timer") throw new Error("Paused startup timer is missing.");
    expect(metadata.runtime.status).toBe("paused");
    expect(prepared.state.jobs).toEqual([]);
  });

  it("pauses project-wide running metadata after another tab cancels its alarm", () => {
    const project = runningTimerProject("cross-tab-project", "cross-tab-owner");
    const descriptor = activeClassroomTimeAlarmDescriptors(
      project.id,
      project.scenes[project.activeSceneId].elements as Parameters<typeof activeClassroomTimeAlarmDescriptors>[1],
    )[0];
    if (!descriptor) throw new Error("Cross-tab timer descriptor is missing.");

    const paused = pauseUnauthorizedClassroomTimeWidgetsInProject(
      project,
      emptyRegistry(),
      2_000,
    );
    const pausedAnchor = paused.scenes[paused.activeSceneId].elements.find(
      (element) => classroomTimeWidgetMetadata(
        element as Parameters<typeof classroomTimeWidgetMetadata>[0],
      ),
    );
    const pausedMetadata = pausedAnchor && classroomTimeWidgetMetadata(
      pausedAnchor as Parameters<typeof classroomTimeWidgetMetadata>[0],
    );
    if (!pausedMetadata || pausedMetadata.kind !== "timer") {
      throw new Error("Cross-tab paused timer is missing.");
    }
    expect(pausedMetadata.runtime.status).toBe("paused");

    expect(pauseUnauthorizedClassroomTimeWidgetsInProject(
      project,
      { ...emptyRegistry(), jobs: [classroomAlarmJobFromDescriptor(descriptor)] },
      2_000,
    )).toBe(project);
  });

  it("does not invalidate a later Start for idle or already-authorized project reconciliation", () => {
    const idle = createBlankProject();
    const idleScene = idle.scenes[idle.activeSceneId];
    const idleWidget = createClassroomTimeWidgetScene({
      metadata: createDefaultClassroomTimeWidgetMetadata("timer", "idle-undo-owner"),
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("idle-undo-widget"),
    });
    idle.scenes[idle.activeSceneId] = {
      ...idleScene,
      elements: idleWidget.elements,
      files: Object.fromEntries(idleWidget.files.map((file) => [file.id, file])),
    };
    expect(classroomTimeAlarmReconciliationNeeded(idle, emptyRegistry())).toBe(false);

    const running = runningTimerProject("undo-restart-project", "undo-restart-owner");
    const descriptor = activeClassroomTimeAlarmDescriptors(
      running.id,
      running.scenes[running.activeSceneId].elements as Parameters<
        typeof activeClassroomTimeAlarmDescriptors
      >[1],
    )[0];
    if (!descriptor) throw new Error("Undo-restart timer descriptor is missing.");
    const exact = classroomAlarmJobFromDescriptor(descriptor);
    expect(classroomTimeAlarmReconciliationNeeded(
      running,
      { ...emptyRegistry(), jobs: [exact] },
    )).toBe(false);
    expect(classroomTimeAlarmReconciliationNeeded(running, emptyRegistry())).toBe(true);
    expect(classroomTimeAlarmReconciliationNeeded(running, {
      ...emptyRegistry(),
      jobs: [{ ...exact, createdAtMs: exact.createdAtMs - 1 }],
    })).toBe(true);
    expect(classroomTimeAlarmReconciliationNeeded(running, {
      ...emptyRegistry(),
      jobs: [{ ...exact, deliveryState: "blocked", deliveryStateAtMs: 2_000 }],
    })).toBe(true);
  });

  it("identifies and authorizes exactly one automatically started Pomodoro phase", () => {
    const base = createDefaultClassroomTimeWidgetMetadata("pomodoro", "auto-phase-owner");
    if (base.kind !== "pomodoro") throw new Error("Pomodoro defaults changed kind.");
    const pomodoro = {
      ...base.pomodoro,
      focusDurationMs: 1_000,
      shortBreakDurationMs: 1_000,
      autoStartBreaks: true,
    };
    const previous = createClassroomTimeWidgetScene({
      metadata: {
        ...base,
        pomodoro,
        runtime: {
          status: "running",
          phase: "focus",
          completedFocusSessions: 0,
          remainingMs: 1_000,
          deadlineMs: 2_000,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("auto-previous"),
    });
    const next = createClassroomTimeWidgetScene({
      metadata: {
        ...base,
        pomodoro,
        runtime: {
          status: "running",
          phase: "short-break",
          completedFocusSessions: 1,
          remainingMs: 1_000,
          deadlineMs: 3_000,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 2_000,
      createId: idSequence("auto-next"),
    });
    const projectId = "auto-phase-project";
    const previousDescriptors = activeClassroomTimeAlarmDescriptors(projectId, previous.elements);
    const nextDescriptors = activeClassroomTimeAlarmDescriptors(projectId, next.elements);
    const starts = classroomTimeAlarmDescriptorsNeedingTrustedStart(
      previousDescriptors,
      nextDescriptors,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      ownerId: "auto-phase-owner",
      target: "pomodoro",
      createdAtMs: 2_000,
      deadlineMs: 3_000,
    });

    const project = createBlankProject(new Date("2026-08-21T12:00:00.000Z"));
    const activeScene = project.scenes[project.activeSceneId];
    const candidate = {
      ...project,
      id: projectId,
      scenes: {
        ...project.scenes,
        [activeScene.id]: {
          ...activeScene,
          elements: next.elements,
          files: Object.fromEntries(next.files.map((file) => [file.id, file])),
        },
      },
    };
    const job = classroomAlarmJobFromDescriptor(starts[0]);
    const finalized = finalizeClassroomTimeSchedulerAlarmReservation(
      candidate,
      starts,
      { ...emptyRegistry(), jobs: [job] },
      2_000,
    );
    expect(finalized).toEqual({ project: candidate, authorized: true });
  });

  it("publishes a paused Pomodoro phase when atomic storage or capacity reservation fails", () => {
    const base = createDefaultClassroomTimeWidgetMetadata("pomodoro", "failed-auto-owner");
    if (base.kind !== "pomodoro") throw new Error("Pomodoro defaults changed kind.");
    const running = createClassroomTimeWidgetScene({
      metadata: {
        ...base,
        runtime: {
          status: "running",
          phase: "short-break",
          completedFocusSessions: 1,
          remainingMs: 30_000,
          deadlineMs: 32_000,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 2_000,
      createId: idSequence("failed-auto"),
    });
    const project = createBlankProject(new Date("2026-08-21T12:00:00.000Z"));
    const activeScene = project.scenes[project.activeSceneId];
    const candidate = {
      ...project,
      id: "failed-auto-project",
      scenes: {
        ...project.scenes,
        [activeScene.id]: {
          ...activeScene,
          elements: running.elements,
          files: Object.fromEntries(running.files.map((file) => [file.id, file])),
        },
      },
    };
    const descriptors = activeClassroomTimeAlarmDescriptors(
      candidate.id,
      running.elements,
    );
    const finalized = finalizeClassroomTimeSchedulerAlarmReservation(
      candidate,
      descriptors,
      null,
      2_000,
    );
    expect(finalized.authorized).toBe(false);
    const anchor = finalized.project.scenes[activeScene.id].elements.find(
      (element) => classroomTimeWidgetMetadata(element as Parameters<typeof classroomTimeWidgetMetadata>[0]),
    );
    const metadata = anchor && classroomTimeWidgetMetadata(
      anchor as Parameters<typeof classroomTimeWidgetMetadata>[0],
    );
    if (!metadata || metadata.kind !== "pomodoro") throw new Error("Paused Pomodoro is missing.");
    expect(metadata.runtime).toMatchObject({
      status: "paused",
      phase: "short-break",
      remainingMs: 30_000,
      deadlineMs: null,
    });
  });

  it("keeps a blocked completion job and pauses its automatically started next phase", () => {
    const base = createDefaultClassroomTimeWidgetMetadata("pomodoro", "blocked-auto-owner");
    if (base.kind !== "pomodoro") throw new Error("Pomodoro defaults changed kind.");
    const running = createClassroomTimeWidgetScene({
      metadata: {
        ...base,
        runtime: {
          status: "running",
          phase: "short-break",
          completedFocusSessions: 1,
          remainingMs: 30_000,
          deadlineMs: 32_000,
          completedAtMs: null,
        },
      },
      x: 0,
      y: 0,
      now: 2_000,
      createId: idSequence("blocked-auto"),
    });
    const project = createBlankProject(new Date("2026-08-21T12:00:00.000Z"));
    const scene = project.scenes[project.activeSceneId];
    const candidate = {
      ...project,
      id: "blocked-auto-project",
      scenes: {
        ...project.scenes,
        [scene.id]: {
          ...scene,
          elements: running.elements,
          files: Object.fromEntries(running.files.map((file) => [file.id, file])),
        },
      },
    };
    const descriptor = activeClassroomTimeAlarmDescriptors(candidate.id, running.elements)[0];
    if (!descriptor) throw new Error("Auto-start descriptor is missing.");
    const blockedJob = {
      ...classroomAlarmJobFromDescriptor({
        ...descriptor,
        createdAtMs: 1_000,
        deadlineMs: 2_000,
      }),
      deliveryState: "blocked" as const,
      deliveryStateAtMs: 2_000,
      blockedAttempts: 1,
    };
    const finalized = finalizeClassroomTimeSchedulerAlarmReservation(
      candidate,
      [descriptor],
      { ...emptyRegistry(), jobs: [blockedJob] },
      2_000,
    );
    expect(finalized.authorized).toBe(false);
    expect(blockedJob.deliveryState).toBe("blocked");
    const anchor = finalized.project.scenes[scene.id].elements.find(
      (element) => classroomTimeWidgetMetadata(element as Parameters<typeof classroomTimeWidgetMetadata>[0]),
    );
    const metadata = anchor && classroomTimeWidgetMetadata(
      anchor as Parameters<typeof classroomTimeWidgetMetadata>[0],
    );
    if (!metadata || metadata.kind !== "pomodoro") throw new Error("Paused Pomodoro is missing.");
    expect(metadata.runtime.status).toBe("paused");
  });

  it("keeps whole-project fences strict while direct controls tolerate same-project React replacement", () => {
    const project = createBlankProject();
    const expected = {
      project,
      activeSceneId: project.activeSceneId,
      hydrationGeneration: 4,
      operationGeneration: 7,
      elementContentFingerprint: "before-content",
      elementFingerprint: "before-elements",
      fileFingerprint: "before-files",
    };
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, expected)).toBe(true);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      elementFingerprint: "student-drew-while-lock-waited",
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      activeSceneId: "another-scene",
      hydrationGeneration: 5,
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
    })).toBe(false);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
    })).toBe(true);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project, id: "another-project" },
    })).toBe(false);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
      elementFingerprint: "student-drew-while-lock-waited",
    })).toBe(true);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
      elementContentFingerprint: "student-drew-while-lock-waited",
      elementFingerprint: "student-drew-while-lock-waited",
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, expected, true)).toBe(false);
  });

  it.each([
    "Pomodoro scheduler",
    "PDF clear",
    "PDF page delete",
    "PDF Undo",
    "Customize widget",
    "Convert widget",
    "Delete widget",
  ])("rejects stale %s publication after drawing or navigation", () => {
    const project = createBlankProject();
    const expected = {
      project,
      activeSceneId: project.activeSceneId,
      hydrationGeneration: 8,
      operationGeneration: 13,
      elementContentFingerprint: "content-before-lock",
      elementFingerprint: "elements-before-lock",
      fileFingerprint: "files-before-lock",
    };
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      elementFingerprint: "student-drew-during-lock",
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      fileFingerprint: "student-added-image-during-lock",
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      activeSceneId: "navigated-page",
      hydrationGeneration: expected.hydrationGeneration + 1,
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      operationGeneration: expected.operationGeneration + 1,
    })).toBe(false);
    expect(classroomTimeSchedulerPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
    })).toBe(false);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
    })).toBe(true);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project, id: "different-project" },
    })).toBe(false);
    expect(classroomTimeControlPublicationFenceMatches(expected, {
      ...expected,
      project: { ...project },
      elementContentFingerprint: "student-drew-during-lock",
      elementFingerprint: "student-drew-during-lock",
    })).toBe(false);
  });
});

describe("crash-safe classroom alarm publication", () => {
  const descriptorFor = (project: ReturnType<typeof runningAlarmProject>) => {
    const descriptor = activeClassroomTimeAlarmDescriptors(
      project.id,
      project.scenes[project.activeSceneId].elements as Parameters<
        typeof activeClassroomTimeAlarmDescriptors
      >[1],
    )[0];
    if (!descriptor) throw new Error("Running timer descriptor is missing.");
    return descriptor;
  };

  it("keeps recovered jobs staged until the matching project is published and activated", async () => {
    const project = runningAlarmProject("publication-project", "publication-owner");
    const storage = alarmStorage();
    const prepared = await prepareClassroomAlarmPublication(project, 2_000, { storage });

    expect(prepared.project).toBe(project);
    expect(prepared.receipts).toHaveLength(1);
    expect(classroomAlarmTransactionReceiptMatchesProject(prepared.receipts[0], project)).toBe(true);
    expect(classroomAlarmIdentitiesForTransactionReceipts(prepared.receipts)).toEqual([{
      sourceProjectId: project.id,
      ownerId: "publication-owner",
      target: "timer",
    }]);
    const stagedRegistry = readClassroomAlarmRegistry(storage);
    expect(stagedRegistry.jobs[0].deliveryState).toBe("staged");
    expect(dueClassroomAlarmJobs(stagedRegistry, 61_000)).toEqual([]);

    const activated = await activateClassroomAlarmTransaction(
      prepared.receipts[0],
      2_001,
      storage,
    );
    expect(activated.status).toBe("persisted");
    expect(activated.registry.jobs[0].deliveryState).toBe("pending");
  });

  it("resolves a startup or file-open crash-stage only for an exact incoming project descriptor", async () => {
    const project = runningAlarmProject("startup-project", "startup-owner");
    const job = classroomAlarmJobFromDescriptor(descriptorFor(project));
    const matchingStorage = alarmStorage();
    const crashStage = await stageTrustedClassroomAlarmJobs([job], 2_000, matchingStorage);
    if (!crashStage.receipt) throw new Error("Crash-stage receipt is missing.");

    const matching = await prepareClassroomAlarmPublication(project, 2_001, {
      resolvePersistedTransactions: true,
      storage: matchingStorage,
    });
    expect(matching.receipts.map(({ transactionId }) => transactionId)).toEqual([
      crashStage.receipt.transactionId,
    ]);
    expect(matching.project).toBe(project);

    const mismatchedStorage = alarmStorage();
    const mismatchedStage = await stageTrustedClassroomAlarmJobs([job], 2_000, mismatchedStorage);
    if (!mismatchedStage.receipt) throw new Error("Mismatched crash-stage receipt is missing.");
    const blank = { ...createBlankProject(), id: "different-project" };
    const mismatched = await prepareClassroomAlarmPublication(blank, 2_001, {
      resolvePersistedTransactions: true,
      storage: mismatchedStorage,
    });
    expect(mismatched.receipts).toEqual([]);
    expect(readClassroomAlarmRegistry(mismatchedStorage).jobs).toEqual([]);
    expect(readClassroomAlarmRegistry(mismatchedStorage).stagedTransactions).toBeUndefined();
  });

  it("restores the exact pending preimage when a trusted Start loses its publication fence", async () => {
    const project = runningAlarmProject("stale-start-project", "stale-start-owner");
    const original = classroomAlarmJobFromDescriptor(descriptorFor(project));
    const replacement = {
      ...original,
      createdAtMs: original.createdAtMs + 1,
      deadlineMs: original.deadlineMs + 60_000,
    };
    const storage = alarmStorage({ version: 1, revision: 0, jobs: [original] });
    const staged = await stageTrustedClassroomAlarmJobs([replacement], 2_000, storage);
    if (!staged.receipt) throw new Error("Trusted Start receipt is missing.");

    expect(await rollbackClassroomAlarmPublicationReceipts(
      [staged.receipt],
      2_001,
      storage,
    )).toBe(true);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([original]);
    expect(readClassroomAlarmRegistry(storage).stagedTransactions).toBeUndefined();
  });

  it.each(["blocked", "delivering"] as const)(
    "preserves %s work when scheduler auto-start staging races alarm delivery",
    async (deliveryState) => {
      const project = runningAlarmProject("scheduler-project", "scheduler-owner");
      const pristine = classroomAlarmJobFromDescriptor(descriptorFor(project));
      const incumbent = {
        ...pristine,
        deadlineMs: 1_500,
        deliveryState,
        deliveryStateAtMs: 1_500,
        ...(deliveryState === "blocked" ? { blockedAttempts: 1 } : {}),
      };
      const requested = {
        ...pristine,
        createdAtMs: 2_000,
        deadlineMs: 62_000,
      };
      const storage = alarmStorage({ version: 1, revision: 0, jobs: [incumbent] });

      const staged = await stageSchedulerClassroomAlarmJobs([requested], 2_000, storage);
      expect(staged.status).toBe("rolled-back");
      expect(staged.receipt).toBeNull();
      expect(readClassroomAlarmRegistry(storage).jobs).toEqual([incumbent]);
    },
  );

  it("captures the generation that exists under the cancellation lock and rotates Undo authority after stale rollback", async () => {
    const project = runningAlarmProject("pdf-undo-project", "pdf-undo-owner");
    const original = classroomAlarmJobFromDescriptor(descriptorFor(project));
    const storage = alarmStorage({ version: 1, revision: 0, jobs: [original] });
    const unlockedSnapshot = readClassroomAlarmRegistry(storage).jobs[0];
    const newer = {
      ...original,
      createdAtMs: 2_000,
      deadlineMs: 62_000,
    };
    const newerStage = await stageTrustedClassroomAlarmJobs([newer], 2_000, storage);
    if (!newerStage.receipt) throw new Error("Newer Start receipt is missing.");
    await activateClassroomAlarmTransaction(newerStage.receipt, 2_001, storage);

    const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt([{
      sourceProjectId: project.id,
      ownerId: "pdf-undo-owner",
      target: "timer",
    }], 2_002, storage);
    if (!cancellation.receipt) throw new Error("PDF cancellation receipt is missing.");
    expect(cancellation.receipt.cancelledJobs[0]).toEqual(newer);
    expect(cancellation.receipt.cancelledJobs[0]).not.toEqual(unlockedSnapshot);

    const stagedUndo = await stageCancelledClassroomAlarmReceipt(
      cancellation.receipt,
      2_003,
      storage,
    );
    if (!stagedUndo.receipt) throw new Error("PDF Undo stage receipt is missing.");
    expect(dueClassroomAlarmJobs(readClassroomAlarmRegistry(storage), newer.deadlineMs)).toEqual([]);
    const refreshedReceipts: ClassroomAlarmCancellationReceiptV1[] = [];
    expect(await rollbackClassroomAlarmPublicationReceipts(
      [stagedUndo.receipt],
      2_004,
      storage,
      (_transaction, refreshed) => { refreshedReceipts.push(refreshed); },
    )).toBe(true);
    const refreshedReceipt = refreshedReceipts[0];
    if (!refreshedReceipt) throw new Error("Rotated PDF cancellation receipt is missing.");
    expect(refreshedReceipt.receiptId).not.toBe(cancellation.receipt.receiptId);

    const retry = await stageCancelledClassroomAlarmReceipt(refreshedReceipt, 2_005, storage);
    if (!retry.receipt) throw new Error("Retried PDF Undo receipt is missing.");
    await activateClassroomAlarmTransaction(retry.receipt, 2_006, storage);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([newer]);
  });

  it("cancels only changed alarms for a same-project replacement", () => {
    const outgoing = runningAlarmProject("same-open-project", "same-open-owner");
    const sameProjectBlank = { ...createBlankProject(), id: outgoing.id };
    expect(replacedClassroomTimeAlarmIdentities(outgoing, sameProjectBlank)).toEqual([{
      sourceProjectId: outgoing.id,
      ownerId: "same-open-owner",
      target: "timer",
    }]);
    expect(replacedClassroomTimeAlarmIdentities(
      outgoing,
      { ...sameProjectBlank, id: "different-open-project" },
    )).toEqual([]);
  });

  it("restores the exact outgoing generation when a same-project open is abandoned", async () => {
    const outgoing = runningAlarmProject("same-open-restore", "same-open-restore-owner");
    const original = classroomAlarmJobFromDescriptor(descriptorFor(outgoing));
    const incoming = { ...createBlankProject(), id: outgoing.id };
    const identities = replacedClassroomTimeAlarmIdentities(outgoing, incoming);
    const storage = alarmStorage({ version: 1, revision: 0, jobs: [original] });

    const cancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
      identities,
      2_000,
      storage,
    );
    if (!cancellation.receipt) throw new Error("Same-project open cancellation receipt is missing.");
    expect(cancellation.receipt.cancelledJobs).toEqual([original]);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([]);

    const restore = await stageCancelledClassroomAlarmReceipt(
      cancellation.receipt,
      2_001,
      storage,
    );
    if (!restore.receipt) throw new Error("Abandoned-open restore receipt is missing.");
    expect(classroomAlarmTransactionReceiptMatchesProject(restore.receipt, outgoing)).toBe(true);
    expect(dueClassroomAlarmJobs(readClassroomAlarmRegistry(storage), original.deadlineMs)).toEqual([]);

    const activated = await activateClassroomAlarmTransaction(restore.receipt, 2_002, storage);
    expect(activated.status).toBe("persisted");
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([original]);
  });

  it("keeps the outgoing alarm while a different project open stages and activates its own alarm", async () => {
    const outgoing = runningAlarmProject("different-open-outgoing", "different-open-old-owner");
    const incoming = runningAlarmProject("different-open-incoming", "different-open-new-owner");
    const outgoingJob = classroomAlarmJobFromDescriptor(descriptorFor(outgoing));
    const storage = alarmStorage({ version: 1, revision: 0, jobs: [outgoingJob] });

    expect(replacedClassroomTimeAlarmIdentities(outgoing, incoming)).toEqual([]);
    const prepared = await prepareClassroomAlarmPublication(incoming, 2_000, {
      resolvePersistedTransactions: true,
      storage,
    });
    expect(prepared.receipts).toHaveLength(1);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual(expect.arrayContaining([
      outgoingJob,
      expect.objectContaining({
        sourceProjectId: incoming.id,
        ownerId: "different-open-new-owner",
        deliveryState: "staged",
      }),
    ]));

    const activated = await activateClassroomAlarmTransaction(
      prepared.receipts[0],
      2_001,
      storage,
    );
    expect(activated.status).toBe("persisted");
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual(expect.arrayContaining([
      outgoingJob,
      expect.objectContaining({
        sourceProjectId: incoming.id,
        ownerId: "different-open-new-owner",
        deliveryState: "pending",
      }),
    ]));
  });

  it("restores P after a competing different-project open publishes Q before stale same-project cleanup", async () => {
    const projectP = runningAlarmProject("interleaved-open-p", "interleaved-open-p-owner");
    const projectQ = runningAlarmProject("interleaved-open-q", "interleaved-open-q-owner");
    const projectPJob = classroomAlarmJobFromDescriptor(descriptorFor(projectP));
    const storage = alarmStorage({ version: 1, revision: 0, jobs: [projectPJob] });

    // Open A targets a changed archive with P's same project ID, so it must
    // cancel P's outgoing generation before it can publish the replacement.
    const openAReplacement = { ...createBlankProject(), id: projectP.id };
    const openACancellation = await cancelClassroomAlarmIdentitiesWithReceipt(
      replacedClassroomTimeAlarmIdentities(projectP, openAReplacement),
      2_000,
      storage,
    );
    if (!openACancellation.receipt) throw new Error("Interleaved open cancellation receipt is missing.");

    // Open B supersedes A and publishes unrelated Q. Different-project opens
    // intentionally preserve background alarms from P.
    const openBPrepared = await prepareClassroomAlarmPublication(projectQ, 2_001, {
      resolvePersistedTransactions: true,
      storage,
    });
    expect(openBPrepared.receipts).toHaveLength(1);
    await activateClassroomAlarmTransaction(openBPrepared.receipts[0], 2_002, storage);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual([
      expect.objectContaining({ sourceProjectId: projectQ.id, deliveryState: "pending" }),
    ]);

    // A's stale cleanup restores its exact P receipt as background authority
    // without disturbing Q's already-published generation.
    const openARestore = await stageCancelledClassroomAlarmReceipt(
      openACancellation.receipt,
      2_003,
      storage,
    );
    if (!openARestore.receipt) throw new Error("Interleaved open restore receipt is missing.");
    expect(classroomAlarmTransactionReceiptMatchesProject(openARestore.receipt, projectP)).toBe(true);
    await activateClassroomAlarmTransaction(openARestore.receipt, 2_004, storage);
    expect(readClassroomAlarmRegistry(storage).jobs).toEqual(expect.arrayContaining([
      projectPJob,
      expect.objectContaining({ sourceProjectId: projectQ.id, deliveryState: "pending" }),
    ]));
  });

  it("never treats a staged job as published alarm authority", async () => {
    const project = runningAlarmProject("staged-authority-project", "staged-authority-owner");
    const descriptor = descriptorFor(project);
    const storage = alarmStorage();
    const staged = await stageTrustedClassroomAlarmJobs(
      [classroomAlarmJobFromDescriptor(descriptor)],
      2_000,
      storage,
    );
    const paused = pauseUnauthorizedClassroomTimeWidgetsInProject(
      project,
      staged.registry,
      2_001,
    );
    const anchor = paused.scenes[paused.activeSceneId].elements.find((element) => (
      classroomTimeWidgetMetadata(element as Parameters<typeof classroomTimeWidgetMetadata>[0])
    ));
    const metadata = anchor && classroomTimeWidgetMetadata(
      anchor as Parameters<typeof classroomTimeWidgetMetadata>[0],
    );
    if (!metadata || metadata.kind !== "timer") throw new Error("Paused staged timer is missing.");
    expect(metadata.runtime.status).toBe("paused");
  });
});

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

describe("classroom alarm start warnings", () => {
  it("keeps silent countdowns usable while clearly describing the alarm risk", () => {
    expect(classroomAlarmStartWarning("ready", false, 0.7)).toBeNull();
    expect(classroomAlarmStartWarning("blocked", false, 0.7)).toContain("browser blocked alarm sound");
    expect(classroomAlarmStartWarning("unavailable", false, 0.7)).toContain("unavailable in this browser");
    expect(classroomAlarmStartWarning("ready", true, 0.7)).toContain("alarms are muted");
    expect(classroomAlarmStartWarning("ready", false, 0)).toContain("volume is 0%");
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
    { sceneId: "scene-a", generation: 7, tool: "eraser" as const },
    { sceneId: null, generation: 7, tool: null },
  ])("rejects a stale callback (%s)", (current) => {
    expect(presentationInkStrokeIsCurrent(stroke, current)).toBe(false);
  });
});

describe("presentation eraser slide-boundary guard", () => {
  it("conservatively rejects a simultaneous frame-and-child erasure inside the slide", () => {
    const previousElements = [
      { id: "frame", type: "frame", isDeleted: false, frameId: null },
      { id: "child", type: "freedraw", isDeleted: false, frameId: "frame" },
      { id: "other", type: "freedraw", isDeleted: false, frameId: null },
    ] as unknown as Parameters<typeof protectPresentationSlideFrameElements>[2];
    const elements = [
      { id: "frame", type: "frame", isDeleted: true, frameId: null },
      { id: "child", type: "freedraw", isDeleted: true, frameId: "frame" },
      { id: "other", type: "freedraw", isDeleted: true, frameId: null },
    ] as unknown as Parameters<typeof protectPresentationSlideFrameElements>[0];

    const protectedElements = protectPresentationSlideFrameElements(
      elements,
      new Set(["frame"]),
      previousElements,
    );
    expect(protectedElements.find((element) => element.id === "frame")?.isDeleted).toBe(false);
    expect(protectedElements.find((element) => element.id === "child")?.isDeleted).toBe(false);
    expect(protectedElements.find((element) => element.id === "other")?.isDeleted).toBe(true);
  });

  it("does not resurrect a child erased before the boundary-touch gesture", () => {
    const previousElements = [
      { id: "frame", type: "frame", isDeleted: false, frameId: null },
      { id: "old-child", type: "freedraw", isDeleted: true, frameId: "frame" },
      { id: "new-child", type: "freedraw", isDeleted: false, frameId: "frame" },
    ] as unknown as Parameters<typeof protectPresentationSlideFrameElements>[2];
    const elements = [
      { id: "frame", type: "frame", isDeleted: true, frameId: null },
      { id: "old-child", type: "freedraw", isDeleted: true, frameId: "frame" },
      { id: "new-child", type: "freedraw", isDeleted: true, frameId: "frame" },
    ] as unknown as Parameters<typeof protectPresentationSlideFrameElements>[0];

    const protectedElements = protectPresentationSlideFrameElements(
      elements,
      new Set(["frame"]),
      previousElements,
    );
    expect(protectedElements.find((element) => element.id === "frame")?.isDeleted).toBe(false);
    expect(protectedElements.find((element) => element.id === "old-child")?.isDeleted).toBe(true);
    expect(protectedElements.find((element) => element.id === "new-child")?.isDeleted).toBe(false);
  });

  it("allows a direct child erasure when its slide frame remains intact", () => {
    const elements = [
      { id: "frame", type: "frame", isDeleted: false, frameId: null },
      { id: "child", type: "freedraw", isDeleted: true, frameId: "frame" },
    ] as unknown as Parameters<typeof protectPresentationSlideFrameElements>[0];
    expect(protectPresentationSlideFrameElements(elements, new Set(["frame"]))).toBe(elements);
  });
});

describe("presentation classroom-time selection hydration", () => {
  const presentationWidget = () => {
    const metadata = createDefaultClassroomTimeWidgetMetadata(
      "dashboard",
      "presentation-dashboard-owner",
    );
    const created = createClassroomTimeWidgetScene({
      metadata,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("presentation-dashboard-element"),
    });
    const anchor = created.elements.find((element) => classroomTimeWidgetMetadata(element));
    if (!anchor) throw new Error("Presentation Dashboard anchor is missing.");
    return {
      elements: created.elements,
      selection: {
        anchorId: anchor.id,
        elementIds: created.elements.map((element) => element.id),
        metadata,
        ownerId: metadata.ownerId,
        projectId: "presentation-project",
        sceneId: "scene-a",
      },
    };
  };

  it("preserves the remembered widget while hydration clears or changes the editor selection", () => {
    const { selection } = presentationWidget();
    const liveContext = { projectId: selection.projectId, sceneId: selection.sceneId };
    expect(updateRememberedPresentationClassroomTimeSelection(selection, null, liveContext)).toBe(selection);
    expect(updateRememberedPresentationClassroomTimeSelection(selection, {
      ...selection,
      anchorId: "different-anchor",
    }, liveContext)).toBe(selection);
    const refreshed = { ...selection, elementIds: [selection.anchorId] };
    expect(updateRememberedPresentationClassroomTimeSelection(
      selection,
      refreshed,
      liveContext,
    )).toEqual(refreshed);
    expect(updateRememberedPresentationClassroomTimeSelection(
      selection,
      refreshed,
      { ...liveContext, sceneId: "scene-b" },
    )).toBe(selection);
  });

  it("preserves the teacher's dashboard target during presentation hydration", () => {
    const { selection } = presentationWidget();
    const timer = createDefaultClassroomTimeWidgetMetadata("timer", "incoming-timer-owner");
    expect(classroomTimeActiveTargetAfterSelection("pomodoro", {
      ...selection,
      anchorId: "incoming-timer-anchor",
      metadata: timer,
      ownerId: timer.ownerId,
    }, true)).toBe("pomodoro");
    expect(classroomTimeActiveTargetAfterSelection("pomodoro", {
      ...selection,
      anchorId: "incoming-timer-anchor",
      metadata: timer,
      ownerId: timer.ownerId,
    }, false)).toBe("timer");
  });

  it("exposes controls only after the exact remembered anchor and owner are live", () => {
    const { elements, selection } = presentationWidget();
    expect(presentationClassroomTimeSelectionForLiveScene(
      selection,
      elements,
      {
        activeSceneId: "scene-a",
        hydratedSceneId: "scene-a",
        projectId: selection.projectId,
        switching: false,
      },
    )).toEqual(expect.objectContaining({
      anchorId: selection.anchorId,
      ownerId: selection.ownerId,
      metadata: selection.metadata,
    }));

    expect(presentationClassroomTimeSelectionForLiveScene(
      selection,
      elements,
      {
        activeSceneId: "scene-b",
        hydratedSceneId: "scene-a",
        projectId: selection.projectId,
        switching: false,
      },
    )).toBeNull();
    expect(presentationClassroomTimeSelectionForLiveScene(
      selection,
      elements,
      {
        activeSceneId: "scene-a",
        hydratedSceneId: "scene-a",
        projectId: selection.projectId,
        switching: true,
      },
    )).toBeNull();
    expect(presentationClassroomTimeSelectionForLiveScene(
      selection,
      elements.filter((element) => element.id !== selection.anchorId),
      {
        activeSceneId: "scene-a",
        hydratedSceneId: "scene-a",
        projectId: selection.projectId,
        switching: false,
      },
    )).toBeNull();

    expect(presentationClassroomTimeSelectionForLiveScene(
      selection,
      elements,
      {
        activeSceneId: "scene-b",
        hydratedSceneId: "scene-b",
        projectId: selection.projectId,
        switching: false,
      },
    )).toBeNull();

    const otherMetadata = createDefaultClassroomTimeWidgetMetadata(
      "dashboard",
      "other-presentation-dashboard-owner",
    );
    const other = createClassroomTimeWidgetScene({
      metadata: otherMetadata,
      x: 0,
      y: 0,
      now: 1_000,
      createId: idSequence("other-presentation-dashboard-element"),
    });
    const otherAnchor = other.elements.find((element) => classroomTimeWidgetMetadata(element));
    if (!otherAnchor) throw new Error("Other presentation Dashboard anchor is missing.");
    expect(presentationClassroomTimeSelectionForLiveScene(
      selection,
      [{ ...otherAnchor, id: selection.anchorId }],
      {
        activeSceneId: "scene-a",
        hydratedSceneId: "scene-a",
        projectId: selection.projectId,
        switching: false,
      },
    )).toBeNull();
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

  it("keeps an immutable baseline when the live editor mutates an element in place", () => {
    const element = {
      id: "annotation-a",
      type: "rectangle",
      x: 20,
      y: 30,
      width: 100,
      height: 60,
      isDeleted: false,
    };
    const file = {
      id: "file-a",
      dataURL: "data:image/png;base64,AA==",
      mimeType: "image/png",
      created: 1,
    };
    const live = {
      sceneId: "scene-a",
      elements: [element],
      appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
      files: { "file-a": file },
    } as unknown as PendingScene;
    const snapshot = snapshotSceneHydrationChange(live);

    element.x = 140;
    file.created = 2;

    expect((snapshot.elements[0] as unknown as { x: number }).x).toBe(20);
    expect((snapshot.files["file-a"] as unknown as { created: number }).created).toBe(1);
    expect(hydrationChangeMatchesSnapshot(live, snapshot)).toBe(false);
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
