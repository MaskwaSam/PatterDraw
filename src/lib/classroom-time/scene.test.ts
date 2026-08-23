import { describe, expect, it } from "vitest";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  CLASSROOM_CALENDAR_SCHEMA_VERSION,
  createClassroomCalendarStoreV1,
  type ClassroomCalendarEventV1,
} from "./calendar";
import {
  createDefaultClassroomTimeWidgetMetadata,
  parseClassroomTimeChildData,
  parseClassroomTimeWidgetMetadata,
  type ClassroomTimeWidgetKind,
  type ClassroomTimeWidgetMetadataV1,
} from "./types";
import {
  materializeClassroomTimeWidgetSnapshot,
  startTimerRuntime,
} from "./runtime";
import {
  assertClassroomTimeWidgetSceneLimits,
  canonicalizeClassroomTimeWidgetsForPersistence,
  classroomTimeLogicalOwnerIds,
  classroomTimeWidgetOwnerId,
  createClassroomTimeWidgetScene,
  expandClassroomTimeWidgetElementIds,
  forkClassroomTimeWidgets,
  forkDuplicatedClassroomTimeWidgets,
  forkNewClassroomTimeWidgetDuplicates,
  isClassroomTimeWidgetAnchor,
  materializeClassroomTimeWidgetsForExport,
  MAX_CLASSROOM_TIME_PARTS,
  reconcileClassroomTimeWidgets,
  tickClassroomTimeWidgets,
  ungroupClassroomTimeWidget,
} from "./scene";

function sequence(prefix = "generated"): () => string {
  let index = 0;
  return () => `${prefix}-${index++}`;
}

function create(
  kind: ClassroomTimeWidgetKind,
  ownerId = `${kind}-owner`,
  overrides: Partial<Parameters<typeof createClassroomTimeWidgetScene>[0]> = {},
) {
  return createClassroomTimeWidgetScene({
    metadata: createDefaultClassroomTimeWidgetMetadata(kind, ownerId),
    x: 100,
    y: 200,
    now: 10_000,
    createId: sequence(kind),
    ...overrides,
  });
}

function anchor(elements: readonly ExcalidrawElement[]): ExcalidrawElement {
  const found = elements.find(isClassroomTimeWidgetAnchor);
  if (!found) throw new Error("Expected a classroom widget anchor.");
  return found;
}

function metadata(element: ExcalidrawElement): ClassroomTimeWidgetMetadataV1 {
  const parsed = parseClassroomTimeWidgetMetadata(element.customData?.classroomTimeWidget);
  if (!parsed) throw new Error("Expected canonical classroom widget metadata.");
  return parsed;
}

function role(element: ExcalidrawElement): string | null {
  return parseClassroomTimeChildData(element.customData?.classroomTimeWidget)?.role ?? null;
}

function filesFor(created: ReturnType<typeof create>): BinaryFiles {
  return Object.fromEntries(created.files.map((file) => [file.id, file])) as BinaryFiles;
}

function renderedParts(
  elements: readonly ExcalidrawElement[],
  rolePrefix: string,
): readonly Record<string, unknown>[] {
  return elements
    .filter((element) => !element.isDeleted && role(element)?.startsWith(rolePrefix))
    .map((element) => ({
      role: role(element),
      type: element.type,
      text: element.type === "text" ? element.text : null,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      fontSize: element.type === "text" ? element.fontSize : null,
      strokeColor: element.strokeColor,
    }))
    .sort((left, right) => String(left.role).localeCompare(String(right.role)));
}

function timerMetadata(ownerId: string, startedAt: number, durationMs = 5 * 60_000): ClassroomTimeWidgetMetadataV1 {
  const base = createDefaultClassroomTimeWidgetMetadata("timer", ownerId);
  if (base.kind !== "timer") throw new Error("Timer factory returned the wrong kind.");
  const timer = { ...base.timer, durationMs };
  return {
    ...base,
    timer,
    runtime: startTimerRuntime({
      status: "idle",
      remainingMs: durationMs,
      deadlineMs: null,
      completedAtMs: null,
    }, durationMs, startedAt),
  };
}

function calendarEvent(
  id: string,
  date: string,
  title: string,
): ClassroomCalendarEventV1 {
  return {
    schemaVersion: CLASSROOM_CALENDAR_SCHEMA_VERSION,
    id,
    date,
    title,
    color: "#2563EB",
    allDay: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("classroom time widget scene creation", () => {
  it.each(["clock", "timer", "pomodoro", "calendar", "dashboard"] as const)(
    "creates one atomic %s group with one immutable SVG shell",
    (kind) => {
      const created = create(kind);
      const shell = anchor(created.elements);

      expect(created.elements.length).toBeGreaterThan(1);
      expect(created.elements.length).toBeLessThanOrEqual(MAX_CLASSROOM_TIME_PARTS);
      expect(created.files).toHaveLength(1);
      expect(created.files[0]).toMatchObject({ mimeType: "image/svg+xml", version: 1 });
      expect(created.files[0].dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(shell).toMatchObject({
        type: "image",
        fileId: created.files[0].id,
        frameId: null,
        groupIds: [created.ownerId],
      });
      expect(metadata(shell)).toMatchObject({ kind, ownerId: created.ownerId, version: 1 });

      for (const child of created.elements.filter((element) => element.id !== shell.id)) {
        expect(["text", "line", "freedraw"]).toContain(child.type);
        expect(child.groupIds[0]).toBe(created.ownerId);
        const data = child.customData?.classroomTimeWidget as Record<string, unknown>;
        expect(Object.keys(data).sort()).toEqual(["ownerId", "role", "version"]);
        expect(parseClassroomTimeChildData(data)).not.toBeNull();
      }
    },
  );

  it("preserves frame, outer group, rotation, and negative image scale", () => {
    const created = create("clock", "transform-owner", {
      frameId: "class-frame",
      groupIds: ["outer-group"],
      angle: Math.PI / 5,
      scale: [-1, 1],
    });
    const shell = anchor(created.elements);
    expect(shell).toMatchObject({ frameId: "class-frame", angle: Math.PI / 5, scale: [-1, 1] });
    for (const element of created.elements) {
      expect(element.frameId).toBe("class-frame");
      expect(element.groupIds).toEqual(["transform-owner", "outer-group"]);
    }
  });

  it("uses the clean local palette without remote or executable shell content", () => {
    const created = create("dashboard");
    const encoded = created.files[0].dataURL.split(",", 2)[1];
    const svg = atob(encoded);
    expect(svg).toContain("#FFFFFF");
    expect(svg).toContain("#2563EB");
    expect(svg).toContain("#7447C7");
    expect(svg).not.toMatch(/<(?:script|iframe|foreignObject)\b/i);
    expect(svg).not.toMatch(/\b(?:href|src)\s*=/i);
    expect(svg.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:/i);
  });

  it("canonicalizes archived path visuals and renders clocks and countdowns as text only", () => {
    const dashboard = createDefaultClassroomTimeWidgetMetadata("dashboard", "legacy-path-visuals");
    if (dashboard.kind !== "dashboard") throw new Error("Expected dashboard metadata.");
    dashboard.clock.display = "analog";
    dashboard.timer.progressStyle = "ring";
    dashboard.pomodoro.progressStyle = "bar";

    const created = createClassroomTimeWidgetScene({
      metadata: dashboard,
      x: 0,
      y: 0,
      now: Date.UTC(2026, 7, 19, 18, 5, 6),
      createId: sequence("legacy-path-visuals"),
    });
    const canonical = metadata(anchor(created.elements));
    expect(canonical.kind).toBe("dashboard");
    if (canonical.kind !== "dashboard") throw new Error("Expected canonical dashboard metadata.");
    expect(canonical.clock.display).toBe("digital");
    expect(canonical.timer.progressStyle).toBe("none");
    expect(canonical.pomodoro.progressStyle).toBe("none");
    expect(created.elements
      .filter((element) => !isClassroomTimeWidgetAnchor(element))
      .every((element) => element.type === "text")).toBe(true);
    expect(created.elements.some((element) => [
      "hour-hand",
      "minute-hand",
      "second-hand",
      "progress-ring",
    ].includes(role(element) ?? ""))).toBe(false);
  });

  it("applies explicit and follow-board themes to native parts and the SVG shell", () => {
    const base = createDefaultClassroomTimeWidgetMetadata("timer", "theme-owner");
    const light = createClassroomTimeWidgetScene({
      metadata: base,
      x: 0,
      y: 0,
      now: 10_000,
      createId: sequence("theme-light"),
      renderContext: { boardTheme: "light" },
    });
    const dark = createClassroomTimeWidgetScene({
      metadata: base,
      x: 0,
      y: 0,
      now: 10_000,
      createId: sequence("theme-dark"),
      renderContext: { boardTheme: "dark" },
    });
    const primaryColor = (elements: readonly ExcalidrawElement[]) => elements
      .find((element) => role(element) === "primary-value")?.strokeColor;
    const decodeShell = (created: typeof light) => atob(created.files[0].dataURL.split(",", 2)[1]);

    expect(primaryColor(light.elements)).toBe("#1F2937");
    expect(primaryColor(dark.elements)).not.toBe(primaryColor(light.elements));
    expect(decodeShell(light)).toContain('fill="#FFFFFF"');
    expect(decodeShell(dark)).not.toBe(decodeShell(light));
    expect(decodeShell(dark)).toContain('fill="#3C414D"');

    const explicitLight = createClassroomTimeWidgetScene({
      metadata: { ...base, appearance: { ...base.appearance, theme: "light" } },
      x: 0,
      y: 0,
      now: 10_000,
      createId: sequence("theme-explicit-light"),
      renderContext: { boardTheme: "dark" },
    });
    expect(primaryColor(explicitLight.elements)).toBe(primaryColor(light.elements));
    expect(decodeShell(explicitLight)).toBe(decodeShell(light));

    const exportedDark = materializeClassroomTimeWidgetsForExport(
      light.elements,
      10_000,
      { boardTheme: "dark" },
    );
    expect(primaryColor(exportedDark)).toBe(primaryColor(dark.elements));
  });

  it("maps canonical 0..1 opacity to Excalidraw percent opacity", () => {
    const base = createDefaultClassroomTimeWidgetMetadata("timer", "opacity-owner");
    const created = create("timer", "opacity-owner", {
      metadata: { ...base, appearance: { ...base.appearance, opacity: 0.35 } },
    });
    expect(created.elements
      .filter((element) => !isClassroomTimeWidgetAnchor(element))
      .every((element) => element.opacity === 35)).toBe(true);
    const svg = atob(created.files[0].dataURL.split(",", 2)[1]);
    expect(svg).toContain('<g opacity="0.35">');
  });

  it("renders bounded calendar event labels, notes, and configured colours", () => {
    const created = create("calendar", "events-owner", {
      renderContext: {
        calendarEventsByOwner: {
          "events-owner": [
            { date: "2026-08-19", label: "Math quiz", note: "Bring a calculator", color: "#aabbcc" },
            { date: "2026-08-20", label: "Library visit", color: "#123456" },
          ],
        },
      },
    });
    const events = created.elements.filter((element) => role(element)?.startsWith("calendar-event-"));
    expect(events).toHaveLength(2);
    expect(events.map((element) => element.type === "text" ? element.text : null))
      .toEqual(["08-19 · Math quiz — Bring a calculator", "08-20 · Library visit"]);
    expect(events.map((element) => element.strokeColor)).toEqual(["#AABBCC", "#123456"]);
  });

  it("renders an explicit timezone label for standalone and dashboard clocks", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const clockBase = createDefaultClassroomTimeWidgetMetadata("clock", "timezone-clock");
    if (clockBase.kind !== "clock") throw new Error("Clock defaults returned the wrong kind.");
    const hidden = createClassroomTimeWidgetScene({
      metadata: { ...clockBase, clock: { ...clockBase.clock, timeZone: "America/Edmonton", showTimezone: false } },
      x: 0,
      y: 0,
      now,
      createId: sequence("timezone-hidden"),
    });
    const shown = createClassroomTimeWidgetScene({
      metadata: { ...clockBase, clock: { ...clockBase.clock, timeZone: "America/Edmonton", showTimezone: true } },
      x: 0,
      y: 0,
      now,
      createId: sequence("timezone-shown"),
    });
    expect(hidden.elements.some((element) => role(element) === "secondary-value")).toBe(false);
    const timezone = shown.elements.find((element) => role(element) === "secondary-value");
    expect(timezone?.type === "text" ? timezone.text : null).toBe("America/Edmonton");

    const dashboardBase = createDefaultClassroomTimeWidgetMetadata("dashboard", "timezone-dashboard");
    if (dashboardBase.kind !== "dashboard") throw new Error("Dashboard defaults returned the wrong kind.");
    const dashboard = createClassroomTimeWidgetScene({
      metadata: {
        ...dashboardBase,
        clock: {
          ...dashboardBase.clock,
          showDate: false,
          showWeekday: false,
          showTimezone: true,
          timeZone: "America/Edmonton",
        },
      },
      x: 0,
      y: 0,
      now,
      createId: sequence("timezone-dashboard"),
    });
    const dashboardTimezone = dashboard.elements.find((element) => role(element) === "dashboard-clock-secondary");
    expect(dashboardTimezone?.type === "text" ? dashboardTimezone.text : null).toBe("America/Edmonton");
  });

  it("makes every standalone calendar view toggle visible and deterministic", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const base = createDefaultClassroomTimeWidgetMetadata("calendar", "calendar-settings");
    if (base.kind !== "calendar") throw new Error("Calendar defaults returned the wrong kind.");
    const createCalendar = (
      calendar: typeof base.calendar,
      idPrefix: string,
    ) => createClassroomTimeWidgetScene({
      metadata: { ...base, calendar },
      x: 0,
      y: 0,
      now,
      createId: sequence(idPrefix),
      renderContext: {
        calendarEventLabelsByOwner: {
          "calendar-settings": ["Math quiz", "Library visit", "Assembly", "Lab", "Review", "Dismissal"],
        },
      },
    });
    const baseline = createCalendar(base.calendar, "calendar-baseline");
    const baselineSignature = renderedParts(baseline.elements, "calendar-");
    const variants = [
      { name: "week", settings: { ...base.calendar, view: "week" as const } },
      { name: "agenda", settings: { ...base.calendar, view: "agenda" as const } },
      { name: "weekends", settings: { ...base.calendar, showWeekends: false } },
      { name: "week-numbers", settings: { ...base.calendar, showWeekNumbers: true } },
      { name: "today", settings: { ...base.calendar, highlightToday: false } },
      { name: "density", settings: { ...base.calendar, density: "compact" as const } },
    ];
    for (const variant of variants) {
      expect(renderedParts(createCalendar(variant.settings, `calendar-${variant.name}`).elements, "calendar-"), variant.name)
        .not.toEqual(baselineSignature);
    }

    const monthDays = baseline.elements.filter((element) => role(element)?.startsWith("calendar-day-") && !element.isDeleted);
    const weekdayOnly = createCalendar({ ...base.calendar, showWeekends: false }, "calendar-weekdays");
    const week = createCalendar({ ...base.calendar, view: "week" }, "calendar-week");
    const agenda = createCalendar({ ...base.calendar, view: "agenda" }, "calendar-agenda");
    const compactAgenda = createCalendar({ ...base.calendar, view: "agenda", density: "compact" }, "calendar-compact-agenda");
    expect(monthDays).toHaveLength(42);
    expect(weekdayOnly.elements.filter((element) => role(element)?.startsWith("calendar-day-") && !element.isDeleted)).toHaveLength(30);
    expect(week.elements.filter((element) => role(element)?.startsWith("calendar-day-") && !element.isDeleted)).toHaveLength(7);
    expect(agenda.elements.filter((element) => role(element)?.startsWith("calendar-day-") && !element.isDeleted)).toHaveLength(8);
    expect(compactAgenda.elements.filter((element) => role(element)?.startsWith("calendar-day-") && !element.isDeleted)).toHaveLength(14);

    const numbered = createCalendar({ ...base.calendar, showWeekNumbers: true }, "calendar-numbered");
    expect(numbered.elements.some((element) => element.type === "text" && role(element)?.startsWith("calendar-day-") && /^W\d+ ·/.test(element.text))).toBe(true);
    const highlighted = monthDays.filter((element) => element.strokeColor === base.appearance.accentColor.toUpperCase());
    const unhighlighted = createCalendar({ ...base.calendar, highlightToday: false }, "calendar-unhighlighted");
    expect(highlighted).toHaveLength(1);
    expect(unhighlighted.elements.some((element) => role(element)?.startsWith("calendar-day-") && element.strokeColor === base.appearance.accentColor.toUpperCase())).toBe(false);

    const deterministic = createCalendar(base.calendar, "calendar-deterministic");
    expect(renderedParts(deterministic.elements, "calendar-")).toEqual(baselineSignature);
    expect(deterministic.files[0].dataURL).toBe(baseline.files[0].dataURL);
    expect(anchor(tickClassroomTimeWidgets(baseline.elements, now))).toBe(anchor(baseline.elements));
  });

  it("applies calendar view toggles to the dashboard calendar panel", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const base = createDefaultClassroomTimeWidgetMetadata("dashboard", "dashboard-calendar-settings");
    if (base.kind !== "dashboard") throw new Error("Dashboard defaults returned the wrong kind.");
    const createDashboard = (calendar: typeof base.calendar, idPrefix: string) => createClassroomTimeWidgetScene({
      metadata: { ...base, clock: { ...base.clock, timeZone: "UTC" }, calendar },
      x: 0,
      y: 0,
      now,
      createId: sequence(idPrefix),
      renderContext: {
        calendarEventsByOwner: {
          "dashboard-calendar-settings": [
            { date: "2026-08-20", label: "Math quiz", note: "Chapter 3", color: "#C2410C" },
            { date: "2026-08-21", label: "Library visit", color: "#047857" },
          ],
        },
      },
    });
    const baseline = createDashboard(base.calendar, "dashboard-calendar-baseline");
    const baselineSignature = renderedParts(baseline.elements, "dashboard-calendar-");
    const variants = [
      { name: "week", settings: { ...base.calendar, view: "week" as const } },
      { name: "agenda", settings: { ...base.calendar, view: "agenda" as const } },
      { name: "weekends", settings: { ...base.calendar, showWeekends: false } },
      { name: "week-numbers", settings: { ...base.calendar, showWeekNumbers: true } },
      { name: "today", settings: { ...base.calendar, highlightToday: false } },
      { name: "density", settings: { ...base.calendar, density: "compact" as const } },
    ];
    for (const variant of variants) {
      expect(renderedParts(createDashboard(variant.settings, `dashboard-calendar-${variant.name}`).elements, "dashboard-calendar-"), variant.name)
        .not.toEqual(baselineSignature);
    }
    const agenda = createDashboard({ ...base.calendar, view: "agenda" }, "dashboard-calendar-agenda-events");
    const agendaEvent = agenda.elements.find((element) => element.type === "text"
      && role(element)?.startsWith("dashboard-calendar-day-")
      && element.text.includes("Math quiz — Chapter 3"));
    expect(agendaEvent?.strokeColor).toBe("#C2410C");
    const monthEvent = baseline.elements.find((element) => element.type === "text"
      && role(element)?.startsWith("dashboard-calendar-day-")
      && element.text.includes("Math quiz — Chapter 3"));
    expect(monthEvent?.strokeColor).toBe("#C2410C");
  });
});

describe("classroom time widget ticks", () => {
  it("runs 3,600 ticks with constant elements, IDs, shell file, and anchor", () => {
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("long-running-owner", 1_000, 3_700_000),
      x: 0,
      y: 0,
      now: 1_000,
      createId: sequence("tick"),
    });
    const originalIds = created.elements.map((element) => element.id);
    const originalFileIds = created.files.map((file) => file.id);
    const originalAnchor = anchor(created.elements);
    let elements = created.elements;
    for (let second = 1; second <= 3_600; second += 1) {
      elements = tickClassroomTimeWidgets(elements, 1_000 + second * 1_000);
    }
    expect(elements.map((element) => element.id)).toEqual(originalIds);
    expect(created.files.map((file) => file.id)).toEqual(originalFileIds);
    expect(anchor(elements)).toBe(originalAnchor);
    expect(elements).toHaveLength(created.elements.length);
    const afterMetadata = metadata(anchor(elements));
    const beforeMetadata = metadata(originalAnchor);
    expect(afterMetadata.kind).toBe("timer");
    expect(beforeMetadata.kind).toBe("timer");
    if (afterMetadata.kind === "timer" && beforeMetadata.kind === "timer") {
      expect(afterMetadata.runtime).toEqual(beforeMetadata.runtime);
    }
  });

  it("updates native timer text without changing the shell", () => {
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("timer-owner", 10_000, 60_000),
      x: 0,
      y: 0,
      now: 10_000,
      createId: sequence("timer"),
    });
    const beforeShell = anchor(created.elements);
    const beforeText = created.elements.find((element) => role(element) === "primary-value");
    const after = tickClassroomTimeWidgets(created.elements, 25_000);
    const afterText = after.find((element) => role(element) === "primary-value");
    expect(afterText?.type).toBe("text");
    expect(afterText).not.toBe(beforeText);
    if (afterText?.type === "text") expect(afterText.text).toBe("00:45");
    expect(anchor(after)).toBe(beforeShell);
    const afterShell = anchor(after);
    expect(afterShell.type).toBe("image");
    if (afterShell.type === "image" && beforeShell.type === "image") {
      expect(afterShell.fileId).toBe(beforeShell.fileId);
    }
  });

  it("returns the original array when a captured value has not changed", () => {
    const created = create("calendar");
    const first = tickClassroomTimeWidgets(created.elements, 10_000);
    const second = tickClassroomTimeWidgets(first, 10_000);
    expect(second).toBe(first);
  });
});

describe("classroom time widget reconciliation", () => {
  it("applies calendar configuration changes and tombstones removed live slots", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const base = createDefaultClassroomTimeWidgetMetadata("calendar", "calendar-reconfigure");
    if (base.kind !== "calendar") throw new Error("Calendar defaults returned the wrong kind.");
    const created = createClassroomTimeWidgetScene({
      metadata: base,
      x: 0,
      y: 0,
      now,
      createId: sequence("calendar-reconfigure"),
    });
    const shell = anchor(created.elements);
    const changedMetadata = {
      ...base,
      calendar: { ...base.calendar, showWeekends: false, density: "compact" as const },
    };
    const candidate = created.elements.map((element) => element.id === shell.id ? {
      ...element,
      customData: { classroomTimeWidget: changedMetadata },
    } as ExcalidrawElement : element);
    const reconciled = reconcileClassroomTimeWidgets(candidate, {
      now,
      files: filesFor(created),
      createId: sequence("calendar-reconfigured"),
    });
    const liveDays = reconciled.elements.filter((element) => !element.isDeleted && role(element)?.startsWith("calendar-day-"));
    expect(liveDays).toHaveLength(30);
    expect(liveDays.every((element) => element.type === "text" && element.fontSize === 14)).toBe(true);
    expect(reconciled.elements.filter((element) => element.isDeleted && role(element)?.startsWith("calendar-day-"))).toHaveLength(12);
    expect(reconciled.addedFiles).toHaveLength(1);
  });

  it("updates today styling without churning the static calendar shell", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const base = createDefaultClassroomTimeWidgetMetadata("calendar", "calendar-highlight");
    if (base.kind !== "calendar") throw new Error("Calendar defaults returned the wrong kind.");
    const created = createClassroomTimeWidgetScene({ metadata: base, x: 0, y: 0, now, createId: sequence("calendar-highlight") });
    const shell = anchor(created.elements);
    const candidate = created.elements.map((element) => element.id === shell.id ? {
      ...element,
      customData: { classroomTimeWidget: { ...base, calendar: { ...base.calendar, highlightToday: false } } },
    } as ExcalidrawElement : element);
    const reconciled = reconcileClassroomTimeWidgets(candidate, {
      now,
      files: Object.fromEntries(created.files.map((file) => [file.id, file])) as BinaryFiles,
      createId: sequence("calendar-highlight-reconcile"),
    });
    expect(reconciled.addedFiles).toEqual([]);
    expect(reconciled.elements.some((element) => !element.isDeleted
      && role(element)?.startsWith("calendar-day-")
      && element.strokeColor === base.appearance.accentColor.toUpperCase())).toBe(false);
  });

  it("repairs a missing part and a detached part without replacing the shell file", () => {
    const created = create("calendar", "repair-owner", { frameId: "frame-a", groupIds: ["outer"] });
    const missing = created.elements.find((element) => role(element) === "calendar-day-12");
    const detached = created.elements.find((element) => role(element) === "calendar-day-13");
    if (!missing || !detached) throw new Error("Calendar fixture is incomplete.");
    const corrupted = created.elements
      .filter((element) => element.id !== missing.id)
      .map((element) => element.id === detached.id ? { ...element, groupIds: [], frameId: null } as ExcalidrawElement : element);
    const reconciled = reconcileClassroomTimeWidgets(corrupted, {
      now: 11_000,
      files: filesFor(created),
      createId: sequence("repair"),
    });

    expect(reconciled.addedFiles).toEqual([]);
    expect(reconciled.orphanedFileIds).toEqual([]);
    expect(reconciled.repairedOwnerIds).toContain("repair-owner");
    expect(reconciled.elements.some((element) => role(element) === "calendar-day-12")).toBe(true);
    const repairedDetached = reconciled.elements.find((element) => element.id === detached.id);
    expect(repairedDetached?.groupIds).toEqual(["repair-owner", "outer"]);
    expect(repairedDetached?.frameId).toBe("frame-a");
  });

  it("regenerates the shell only when its immutable file is missing or appearance changes", () => {
    const created = create("timer", "shell-owner");
    const stable = reconcileClassroomTimeWidgets(created.elements, {
      now: 11_000,
      files: filesFor(created),
      createId: sequence("stable"),
    });
    expect(stable.addedFiles).toEqual([]);

    const oldAnchor = anchor(created.elements);
    const oldMetadata = metadata(oldAnchor);
    const changedMetadata = {
      ...oldMetadata,
      appearance: { ...oldMetadata.appearance, accentColor: "#7C3AED" },
    } as ClassroomTimeWidgetMetadataV1;
    const changedElements = created.elements.map((element) => element.id === oldAnchor.id ? {
      ...element,
      customData: { classroomTimeWidget: changedMetadata },
    } as ExcalidrawElement : element);
    const changed = reconcileClassroomTimeWidgets(changedElements, {
      now: 12_000,
      files: filesFor(created),
      createId: sequence("new-shell"),
    });
    expect(changed.addedFiles).toHaveLength(1);
    expect(changed.orphanedFileIds).toEqual([created.files[0].id]);
    const changedAnchor = anchor(changed.elements);
    expect(changedAnchor.type).toBe("image");
    if (changedAnchor.type === "image") expect(changedAnchor.fileId).toBe(changed.addedFiles[0].id);
  });

  it("cascades anchor deletion to every owned part", () => {
    const created = create("pomodoro", "delete-owner");
    const shell = anchor(created.elements);
    const deleted = created.elements.map((element) => element.id === shell.id ? {
      ...element,
      isDeleted: true,
    } as ExcalidrawElement : element);
    const reconciled = reconcileClassroomTimeWidgets(deleted, { now: 12_000 });
    expect(reconciled.elements
      .filter((element) => classroomTimeWidgetOwnerId(element) === "delete-owner")
      .every((element) => element.isDeleted)).toBe(true);
  });

  it("freezes duplicate and orphaned parts rather than deleting visible work", () => {
    const created = create("timer", "atomic-owner");
    const child = created.elements.find((element) => role(element) === "primary-value");
    if (!child) throw new Error("Timer fixture has no primary value.");
    const duplicate = { ...child, id: "duplicate-part" } as ExcalidrawElement;
    const reconciled = reconcileClassroomTimeWidgets([...created.elements, duplicate], {
      now: 12_000,
      files: filesFor(created),
    });
    const frozen = reconciled.elements.find((element) => element.id === "duplicate-part");
    expect(frozen?.isDeleted).toBe(false);
    expect(classroomTimeWidgetOwnerId(frozen!)).toBeNull();
    expect(frozen?.groupIds).not.toContain("atomic-owner");
  });
});

describe("classroom time persistence canonicalization", () => {
  it("retains project labels while tombstoning and scrubbing every transient calendar row", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const projectCalendar = createClassroomCalendarStoreV1("project", [
      calendarEvent("project-past", "2026-08-10", "Project Past"),
      {
        ...calendarEvent("project-future", "2026-08-20", "Project Lesson"),
        note: "Bring rulers",
        color: "#0F766E",
      },
    ]);
    const base = createDefaultClassroomTimeWidgetMetadata("calendar", "persistence-calendar");
    if (base.kind !== "calendar") throw new Error("Calendar defaults returned the wrong kind.");
    const created = createClassroomTimeWidgetScene({
      metadata: base,
      x: 0,
      y: 0,
      now,
      createId: sequence("persistence-calendar"),
      renderContext: {
        calendarEventsByOwner: {
          "persistence-calendar": [
            { date: "2026-08-19", label: "Device Secret", note: "Private note", color: "#D946EF" },
            { date: "2026-08-20", label: "Device Extra", color: "#DC2626" },
            { date: "2026-08-21", label: "Device Third", color: "#7C3AED" },
          ],
        },
      },
    });
    const eventZero = created.elements.find((element) => role(element) === "calendar-event-0");
    const eventTwo = created.elements.find((element) => role(element) === "calendar-event-2");
    if (eventZero?.type !== "text" || eventTwo?.type !== "text") throw new Error("Calendar event fixtures are unavailable.");
    const marker = (calendarRole: `calendar-event-${number}`) => ({
      classroomTimeWidget: {
        version: 1,
        ownerId: "persistence-calendar",
        role: calendarRole,
      },
    });
    const duplicateDesired = {
      ...eventZero,
      id: "device-duplicate-desired",
      text: "Device Duplicate",
      originalText: "Device Duplicate",
    } as ExcalidrawElement;
    const extraDevice = {
      ...eventTwo,
      id: "device-extra-row",
      text: "Device Extra Row",
      originalText: "Device Extra Row",
      customData: marker("calendar-event-4"),
    } as ExcalidrawElement;
    const alreadyDeleted = {
      ...eventTwo,
      id: "device-deleted-row",
      isDeleted: true,
      text: "Device Deleted Row",
      originalText: "Device Deleted Row",
      customData: marker("calendar-event-5"),
    } as ExcalidrawElement;
    const input = [...created.elements, duplicateDesired, extraDevice, alreadyDeleted];
    const inputFiles = filesFor(created);
    const inputSnapshot = JSON.stringify(input);
    const fileSnapshot = JSON.stringify(inputFiles);

    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      input,
      inputFiles,
      projectCalendar,
      now,
      sequence("canonical-calendar"),
    );
    const liveLabels = canonical.elements
      .filter((element) => !element.isDeleted && role(element)?.startsWith("calendar-event-"))
      .map((element) => element.type === "text" ? element.text : null);
    expect(liveLabels).toEqual([
      "08-20 · Project Lesson — Bring rulers",
      "08-10 · Project Past",
    ]);
    const persistedProjectLesson = canonical.elements.find((element) => element.type === "text"
      && !element.isDeleted
      && element.text.includes("Project Lesson"));
    expect(persistedProjectLesson?.strokeColor).toBe("#0F766E");
    expect(canonical.elements.some((element) => element.type === "text"
      && `${element.text}\n${element.originalText}`.includes("Device"))).toBe(false);
    expect(JSON.stringify(canonical)).not.toContain("Private note");
    expect(JSON.stringify(canonical)).not.toContain("#D946EF");
    for (const id of ["device-duplicate-desired", "device-extra-row", "device-deleted-row"]) {
      const tombstone = canonical.elements.find((element) => element.id === id);
      expect(tombstone).toMatchObject({ isDeleted: true, text: "", originalText: "", strokeColor: "transparent" });
      expect(role(tombstone!)).toMatch(/^calendar-event-/);
    }
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(JSON.stringify(inputFiles)).toBe(fileSnapshot);

    const repeated = canonicalizeClassroomTimeWidgetsForPersistence(
      canonical.elements,
      canonical.files,
      projectCalendar,
      now,
      sequence("canonical-calendar-repeat"),
    );
    expect(repeated).toEqual(canonical);

    const live = reconcileClassroomTimeWidgets(canonical.elements, {
      now,
      files: canonical.files,
      createId: sequence("live-device-refill"),
      renderContext: {
        calendarEventLabelsByOwner: {
          "persistence-calendar": ["Live Device One", "Live Device Two", "Live Device Three"],
        },
      },
    });
    expect(live.elements
      .filter((element) => !element.isDeleted && role(element)?.startsWith("calendar-event-"))
      .map((element) => element.type === "text" ? element.text : null))
      .toEqual(["Live Device One", "Live Device Two", "Live Device Three"]);
    const preservedTombstone = live.elements.find((element) => element.id === "device-extra-row");
    expect(preservedTombstone).toMatchObject({ isDeleted: true, text: "", originalText: "" });
    expect(role(preservedTombstone!)).toBe("calendar-event-4");

    const recanonicalized = canonicalizeClassroomTimeWidgetsForPersistence(
      live.elements,
      canonical.files,
      projectCalendar,
      now,
      sequence("recanonical-calendar"),
    );
    expect(recanonicalized.elements.some((element) => element.type === "text"
      && `${element.text}\n${element.originalText}`.includes("Live Device"))).toBe(false);
  });

  it("scrubs duplicate and deleted dashboard agenda labels without losing their markers", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const projectCalendar = createClassroomCalendarStoreV1("project", [
      {
        ...calendarEvent("dashboard-project", "2026-08-20", "Project Board Event"),
        note: "Project details",
        color: "#B45309",
      },
    ]);
    const base = createDefaultClassroomTimeWidgetMetadata("dashboard", "persistence-dashboard");
    if (base.kind !== "dashboard") throw new Error("Dashboard defaults returned the wrong kind.");
    const created = createClassroomTimeWidgetScene({
      metadata: {
        ...base,
        clock: { ...base.clock, timeZone: "UTC" },
        calendar: { ...base.calendar, view: "agenda", density: "compact" },
      },
      x: 0,
      y: 0,
      now,
      createId: sequence("persistence-dashboard"),
      renderContext: {
        calendarEventsByOwner: {
          "persistence-dashboard": [{
            date: "2026-08-19",
            label: "Device Dashboard Secret",
            note: "Private dashboard details",
            color: "#BE123C",
          }],
        },
      },
    });
    const dayZero = created.elements.find((element) => role(element) === "dashboard-calendar-day-0");
    if (dayZero?.type !== "text") throw new Error("Dashboard agenda fixture is unavailable.");
    const duplicate = {
      ...dayZero,
      id: "dashboard-device-duplicate",
      text: "Device Dashboard Duplicate",
      originalText: "Device Dashboard Duplicate",
    } as ExcalidrawElement;
    const deleted = {
      ...dayZero,
      id: "dashboard-device-deleted",
      isDeleted: true,
      text: "Device Dashboard Deleted",
      originalText: "Device Dashboard Deleted",
      customData: {
        classroomTimeWidget: {
          version: 1,
          ownerId: "persistence-dashboard",
          role: "dashboard-calendar-day-13",
        },
      },
    } as ExcalidrawElement;
    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      [...created.elements, duplicate, deleted],
      filesFor(created),
      projectCalendar,
      now,
      sequence("canonical-dashboard"),
    );
    expect(canonical.elements.some((element) => element.type === "text"
      && `${element.text}\n${element.originalText}`.includes("Device Dashboard"))).toBe(false);
    expect(canonical.elements.some((element) => element.type === "text"
      && !element.isDeleted
      && role(element)?.startsWith("dashboard-calendar-day-")
      && element.text.includes("Project Board Event — Project details")
      && element.strokeColor === "#B45309")).toBe(true);
    expect(JSON.stringify(canonical)).not.toContain("Private dashboard details");
    expect(JSON.stringify(canonical)).not.toContain("#BE123C");
    for (const id of ["dashboard-device-duplicate", "dashboard-device-deleted"]) {
      const tombstone = canonical.elements.find((element) => element.id === id);
      expect(tombstone).toMatchObject({ isDeleted: true, text: "", originalText: "", strokeColor: "transparent" });
      expect(role(tombstone!)).toMatch(/^dashboard-calendar-day-/);
    }
  });

  it("tombstones a live device agenda row when the dashboard calendar panel is disabled", () => {
    const now = Date.UTC(2026, 7, 19, 18, 5, 6);
    const base = createDefaultClassroomTimeWidgetMetadata("dashboard", "disabled-dashboard-calendar");
    if (base.kind !== "dashboard") throw new Error("Dashboard defaults returned the wrong kind.");
    const liveMetadata = {
      ...base,
      clock: { ...base.clock, timeZone: "UTC" },
      calendar: { ...base.calendar, view: "agenda" as const },
    };
    const created = createClassroomTimeWidgetScene({
      metadata: liveMetadata,
      x: 0,
      y: 0,
      now,
      createId: sequence("disabled-dashboard-calendar"),
      renderContext: {
        calendarEventLabelsByOwner: {
          "disabled-dashboard-calendar": ["Device Agenda Must Not Persist"],
        },
      },
    });
    const shell = anchor(created.elements);
    const liveRow = created.elements.find((element) => role(element) === "dashboard-calendar-day-0");
    if (liveRow?.type !== "text") throw new Error("Dashboard agenda row is unavailable.");
    expect(liveRow.text).toContain("Device Agenda Must Not Persist");
    const disabledMetadata = {
      ...liveMetadata,
      panels: { ...liveMetadata.panels, calendar: false },
    };
    const candidate = created.elements.map((element) => element.id === shell.id ? {
      ...element,
      customData: { classroomTimeWidget: disabledMetadata },
    } as ExcalidrawElement : element);
    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      candidate,
      filesFor(created),
      createClassroomCalendarStoreV1("project"),
      now,
      sequence("disabled-dashboard-canonical"),
    );
    const tombstone = canonical.elements.find((element) => element.id === liveRow.id);
    expect(tombstone).toMatchObject({
      isDeleted: true,
      text: "",
      originalText: "",
    });
    expect(role(tombstone!)).toBe("dashboard-calendar-day-0");
    expect(parseClassroomTimeChildData(tombstone?.customData?.classroomTimeWidget)).toEqual({
      version: 1,
      ownerId: "disabled-dashboard-calendar",
      role: "dashboard-calendar-day-0",
    });
  });

  it("merges a regenerated shell into a new files object", () => {
    const created = create("calendar", "persistence-shell");
    const missingFiles = {} as BinaryFiles;
    const canonical = canonicalizeClassroomTimeWidgetsForPersistence(
      created.elements,
      missingFiles,
      createClassroomCalendarStoreV1("project"),
      10_000,
      sequence("persistence-shell-repair"),
    );
    expect(Object.keys(missingFiles)).toEqual([]);
    expect(Object.keys(canonical.files)).toHaveLength(1);
    const shell = anchor(canonical.elements);
    expect(shell.type === "image" ? canonical.files[shell.fileId!]?.id : null)
      .toBe(shell.type === "image" ? shell.fileId : null);
  });
});

describe("classroom time widget duplication and freezing", () => {
  it("rekeys a copied running timer and pauses it at the exact remaining duration", () => {
    const startedAt = 100_000;
    const copiedAt = 160_000;
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("source-owner", startedAt, 5 * 60_000),
      x: 100,
      y: 200,
      now: startedAt,
      frameId: "frame-one",
      groupIds: ["outer-group"],
      angle: Math.PI / 7,
      scale: [-1, 1],
      createId: sequence("source"),
    });
    const idsBefore = created.elements.map((element) => element.id);
    const sourceShell = anchor(created.elements);
    const forked = forkClassroomTimeWidgets(created.elements, copiedAt, sequence("copy"));
    const copiedShell = anchor(forked.elements);
    const copiedMetadata = metadata(copiedShell);

    expect(copiedMetadata.ownerId).toBe("copy-0");
    expect(forked.ownerIdMap).toEqual({ "source-owner": "copy-0" });
    expect(forked.elements.map((element) => element.id)).not.toEqual(idsBefore);
    expect(copiedShell).toMatchObject({ frameId: "frame-one", angle: Math.PI / 7, scale: [-1, 1] });
    expect(copiedShell.groupIds).toEqual(["copy-0", "outer-group"]);
    expect(copiedShell.type === "image" && sourceShell.type === "image" ? copiedShell.fileId : null)
      .toBe(sourceShell.type === "image" ? sourceShell.fileId : null);
    expect(copiedMetadata.kind).toBe("timer");
    if (copiedMetadata.kind === "timer") {
      expect(copiedMetadata.runtime).toEqual({
        status: "paused",
        remainingMs: 4 * 60_000,
        deadlineMs: null,
        completedAtMs: null,
      });
      expect(materializeClassroomTimeWidgetSnapshot(copiedMetadata, copiedAt + 60_000).timer?.remainingMs)
        .toBe(4 * 60_000);
    }
    expect(metadata(sourceShell).ownerId).toBe("source-owner");
  });

  it("materializes once and removes live metadata when explicitly ungrouped", () => {
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("freeze-owner", 1_000, 60_000),
      x: 0,
      y: 0,
      now: 1_000,
      groupIds: ["outer"],
      createId: sequence("freeze"),
    });
    const frozen = ungroupClassroomTimeWidget(created.elements, "freeze-owner", 31_000);
    expect(frozen).not.toBe(created.elements);
    expect(classroomTimeLogicalOwnerIds(frozen)).toEqual([]);
    expect(frozen.every((element) => !element.groupIds.includes("freeze-owner"))).toBe(true);
    expect(frozen.every((element) => element.groupIds.includes("outer"))).toBe(true);
    const value = frozen.find((element) => element.type === "text" && element.originalText === "00:30");
    expect(value).toBeDefined();
  });

  it("forks only new onDuplicate elements while preserving every original exactly", () => {
    const startedAt = 50_000;
    const copiedAt = 80_000;
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("original-owner", startedAt, 120_000),
      x: 30,
      y: 40,
      now: startedAt,
      groupIds: ["outer"],
      createId: sequence("original"),
    });
    const nativeDuplicates = created.elements.map((element, index) => ({
      ...element,
      id: `native-duplicate-${index}`,
      x: element.x + 24,
      y: element.y + 24,
      groupIds: element.groupIds.map((groupId) => (
        groupId === "original-owner" ? "native-widget-group" : "native-outer-group"
      )),
    } as ExcalidrawElement));
    const nativeDuplicateAnchor = anchor(nativeDuplicates);
    const connector = {
      ...created.elements[1],
      id: "duplicate-connector",
      type: "line",
      customData: undefined,
      groupIds: [],
      points: [[0, 0], [100, 40]],
      lastCommittedPoint: null,
      startBinding: { elementId: nativeDuplicateAnchor.id, focus: 0, gap: 2 },
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
    } as unknown as ExcalidrawElement;
    const nextElements = [...created.elements, ...nativeDuplicates, connector];
    const forked = forkNewClassroomTimeWidgetDuplicates(
      nextElements,
      created.elements,
      copiedAt,
      sequence("forked"),
    );

    expect(forked.elements.slice(0, created.elements.length)).toEqual(created.elements);
    created.elements.forEach((element, index) => expect(forked.elements[index]).toBe(element));
    expect(metadata(anchor(forked.elements.slice(0, created.elements.length))).ownerId).toBe("original-owner");

    const copiedElements = forked.elements.slice(
      created.elements.length,
      created.elements.length + nativeDuplicates.length,
    );
    const copiedAnchor = anchor(copiedElements);
    const originalAnchor = anchor(created.elements);
    const copiedMetadata = metadata(copiedAnchor);
    expect(copiedMetadata.ownerId).toBe("forked-0");
    expect(copiedElements.every((element) => !element.id.startsWith("native-duplicate-"))).toBe(true);
    expect(copiedElements.every((element) => (
      element.groupIds[0] === "forked-0"
      && element.groupIds[1] === "native-outer-group"
      && !element.groupIds.includes("native-widget-group")
    ))).toBe(true);
    expect(copiedAnchor.x).toBe(originalAnchor.x + 24);
    expect(copiedAnchor.y).toBe(originalAnchor.y + 24);
    expect(copiedAnchor.type === "image" && originalAnchor.type === "image"
      ? copiedAnchor.fileId === originalAnchor.fileId
      : false).toBe(true);
    if (copiedMetadata.kind === "timer") {
      expect(copiedMetadata.runtime).toEqual({
        status: "paused",
        remainingMs: 90_000,
        deadlineMs: null,
        completedAtMs: null,
      });
    } else {
      throw new Error("Copied widget is not a timer.");
    }
    expect(Object.keys(forked.elementIdMap).sort())
      .toEqual(nativeDuplicates.map((element) => element.id).sort());
    const remappedConnector = forked.elements.find((element) => element.id === connector.id);
    expect(remappedConnector?.type).toBe("line");
    if (remappedConnector?.type === "line") {
      expect(remappedConnector.startBinding?.elementId)
        .toBe(forked.elementIdMap[nativeDuplicateAnchor.id]);
    }
  });

  it("replaces the deepest owner group for an externally pasted complete widget", () => {
    const startedAt = 40_000;
    const pastedAt = 70_000;
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("library-source-owner", startedAt, 90_000),
      x: 12,
      y: 18,
      now: startedAt,
      groupIds: ["library-outer-group"],
      createId: sequence("library-source"),
    });
    const pasted = created.elements.map((element, index) => ({
      ...element,
      id: `external-paste-${index}`,
      groupIds: element.groupIds.map((groupId) => (
        groupId === "library-source-owner" ? "pasted-owner-group" : "pasted-outer-group"
      )),
    } as ExcalidrawElement));
    const forked = forkNewClassroomTimeWidgetDuplicates(
      pasted,
      [],
      pastedAt,
      sequence("external-fork"),
    );
    const pastedMetadata = metadata(anchor(forked.elements));
    expect(pastedMetadata.ownerId).toBe("external-fork-0");
    expect(forked.elements.every((element) => (
      element.groupIds[0] === "external-fork-0"
      && element.groupIds[1] === "pasted-outer-group"
      && !element.groupIds.includes("pasted-owner-group")
    ))).toBe(true);
    if (pastedMetadata.kind === "timer") {
      expect(pastedMetadata.runtime).toEqual({
        status: "paused",
        remainingMs: 60_000,
        deadlineMs: null,
        completedAtMs: null,
      });
    } else {
      throw new Error("Externally pasted widget is not a timer.");
    }
  });

  it("forks an already-duplicated PDF scene without invalidating its element ID map", () => {
    const startedAt = 100_000;
    const copiedAt = 145_000;
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("pdf-source-owner", startedAt, 120_000),
      x: 18,
      y: 27,
      now: startedAt,
      frameId: "source-frame",
      groupIds: ["source-outer-group"],
      angle: Math.PI / 9,
      scale: [-1, 1],
      createId: sequence("pdf-source"),
    });
    const nativeDuplicates = created.elements.map((element, index) => ({
      ...element,
      id: `pdf-native-${index}`,
      frameId: "duplicated-frame",
      groupIds: element.groupIds.map((groupId) => (
        groupId === "pdf-source-owner" ? "pdf-native-widget-group" : "pdf-native-outer-group"
      )),
    } as ExcalidrawElement));
    const duplicateAnchor = anchor(nativeDuplicates);
    const connector = {
      ...created.elements[1],
      id: "pdf-native-connector",
      type: "line",
      customData: undefined,
      groupIds: ["pdf-native-outer-group"],
      frameId: "duplicated-frame",
      points: [[0, 0], [100, 40]],
      lastCommittedPoint: null,
      startBinding: { elementId: duplicateAnchor.id, focus: 0, gap: 2 },
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
    } as unknown as ExcalidrawElement;
    const duplicatedScene = [...nativeDuplicates, connector];
    const forked = forkDuplicatedClassroomTimeWidgets(duplicatedScene, {
      sourceToDuplicateGroupIds: new Map([
        ["pdf-source-owner", "pdf-native-widget-group"],
        ["source-outer-group", "pdf-native-outer-group"],
      ]),
      now: copiedAt,
      createId: sequence("pdf-fork"),
    });

    expect(forked.ownerIdMap).toEqual({ "pdf-source-owner": "pdf-fork-0" });
    expect(forked.elementIdMap).toEqual({});
    expect(forked.elements.map((element) => element.id))
      .toEqual(duplicatedScene.map((element) => element.id));
    expect(forked.elements.at(-1)).toBe(connector);
    const copiedElements = forked.elements.slice(0, nativeDuplicates.length);
    expect(copiedElements.every((element) => (
      element.groupIds[0] === "pdf-fork-0"
      && element.groupIds[1] === "pdf-native-outer-group"
      && !element.groupIds.includes("pdf-native-widget-group")
    ))).toBe(true);
    const copiedAnchor = anchor(copiedElements);
    expect(copiedAnchor).toMatchObject({
      id: duplicateAnchor.id,
      frameId: "duplicated-frame",
      angle: Math.PI / 9,
      scale: [-1, 1],
    });
    const copiedMetadata = metadata(copiedAnchor);
    expect(copiedMetadata.ownerId).toBe("pdf-fork-0");
    if (copiedMetadata.kind === "timer") {
      expect(copiedMetadata.runtime).toEqual({
        status: "paused",
        remainingMs: 75_000,
        deadlineMs: null,
        completedAtMs: null,
      });
    } else {
      throw new Error("Copied PDF widget is not a timer.");
    }
    expect(metadata(anchor(created.elements)).ownerId).toBe("pdf-source-owner");
    expect(created.elements.every((element) => element.groupIds[0] === "pdf-source-owner")).toBe(true);
    if (connector.type === "line") {
      expect(connector.startBinding?.elementId).toBe(duplicateAnchor.id);
    }
  });
});

describe("classroom time export and logical ownership", () => {
  it("materializes every export clone at one captured timestamp without mutating live state", () => {
    const created = createClassroomTimeWidgetScene({
      metadata: timerMetadata("export-owner", 1_000, 60_000),
      x: 0,
      y: 0,
      now: 1_000,
      createId: sequence("export"),
    });
    const first = materializeClassroomTimeWidgetsForExport(created.elements, 21_000);
    const second = materializeClassroomTimeWidgetsForExport(created.elements, 21_000);
    const later = materializeClassroomTimeWidgetsForExport(created.elements, 31_000);
    const value = (elements: readonly ExcalidrawElement[]) => {
      const element = elements.find((candidate) => role(candidate) === "primary-value");
      return element?.type === "text" ? element.text : null;
    };
    expect(value(first)).toBe("00:40");
    expect(value(second)).toBe("00:40");
    expect(value(later)).toBe("00:30");
    expect(value(created.elements)).toBe("01:00");
    expect(anchor(first)).toBe(anchor(created.elements));
  });

  it("expands a selected part to one logical widget annotation", () => {
    const created = create("clock", "logical-owner");
    const selectedPart = created.elements[2];
    const expanded = expandClassroomTimeWidgetElementIds(created.elements, new Set([selectedPart.id]));
    expect(expanded).toEqual(new Set(created.elements.map((element) => element.id)));
    expect(classroomTimeLogicalOwnerIds(created.elements)).toEqual(["logical-owner"]);
  });

  it("enforces the project-wide widget cap", () => {
    const anchors = Array.from({ length: 65 }, (_, index) => {
      const created = create("clock", `owner-${index}`);
      return anchor(created.elements);
    });
    expect(() => assertClassroomTimeWidgetSceneLimits(anchors)).toThrow(/at most 64/);
  });
});
