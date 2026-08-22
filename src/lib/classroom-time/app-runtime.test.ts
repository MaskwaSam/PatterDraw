import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createClassroomCalendarStoreV1 } from "./calendar";
import {
  activeClassroomTimeAlarmDescriptors,
  advanceExpiredClassroomTimeWidget,
  applyClassroomTimeControl,
  classroomTimePreferencePatchForMetadata,
  classroomTimeRenderContext,
  createClassroomTimeMetadataFromPreferences,
  selectedClassroomTimeWidget,
} from "./app-runtime";
import { DEFAULT_CLASSROOM_TIME_PREFERENCES } from "./preferences";
import { createClassroomTimeWidgetScene } from "./scene";
import { parseClassroomTimeWidgetMetadata } from "./types";

const NOW = 2_000_000;

function create(kind: "calendar" | "dashboard" | "pomodoro" | "timer", owner = `${kind}-owner`) {
  return createClassroomTimeMetadataFromPreferences(kind, owner, DEFAULT_CLASSROOM_TIME_PREFERENCES);
}

describe("classroom-time app runtime", () => {
  it("builds independent metadata from device defaults and round-trips a defaults patch", () => {
    const metadata = create("dashboard");
    expect(metadata.kind).toBe("dashboard");
    if (metadata.kind !== "dashboard") throw new Error("Expected dashboard metadata.");
    metadata.calendar.projectEventIds.push("event-1");
    expect(DEFAULT_CLASSROOM_TIME_PREFERENCES.calendar.projectEventIds).toEqual([]);
    const patch = classroomTimePreferencePatchForMetadata(metadata);
    expect(patch.dashboardPanels).toEqual(metadata.panels);
    expect(patch.calendar).toEqual({
      view: metadata.calendar.view,
      showProjectEvents: metadata.calendar.showProjectEvents,
      showDeviceEvents: metadata.calendar.showDeviceEvents,
      showWeekends: metadata.calendar.showWeekends,
      showWeekNumbers: metadata.calendar.showWeekNumbers,
      highlightToday: metadata.calendar.highlightToday,
      density: metadata.calendar.density,
    });
    expect(patch.calendar).not.toHaveProperty("projectEventIds");
    expect(patch.calendar).not.toHaveProperty("transferCache");
  });

  it("starts, pauses, extends, resets, and skips deadline-based runtimes", () => {
    const timer = create("timer");
    if (timer.kind !== "timer") throw new Error("Expected timer metadata.");
    const running = applyClassroomTimeControl(timer, "timer", "start", NOW);
    expect(running.kind === "timer" && running.runtime.deadlineMs).toBe(NOW + timer.timer.durationMs);
    const extended = applyClassroomTimeControl(running, "timer", "add-minute", NOW + 1_000);
    expect(extended.kind === "timer" && extended.runtime.deadlineMs).toBe(NOW + timer.timer.durationMs + 60_000);
    expect(parseClassroomTimeWidgetMetadata(extended)).not.toBeNull();
    const paused = applyClassroomTimeControl(extended, "timer", "pause", NOW + 2_000);
    expect(paused.kind === "timer" && paused.runtime.status).toBe("paused");
    const reset = applyClassroomTimeControl(paused, "timer", "reset", NOW + 3_000);
    expect(reset.kind === "timer" && reset.runtime.status).toBe("idle");

    const pomodoro = create("pomodoro");
    if (pomodoro.kind !== "pomodoro") throw new Error("Expected Pomodoro metadata.");
    const skipped = applyClassroomTimeControl(pomodoro, "pomodoro", "skip", NOW);
    expect(skipped.kind === "pomodoro" && skipped.runtime.phase).toBe("short-break");
  });

  it("advances expired timers and Pomodoros once", () => {
    const timer = applyClassroomTimeControl(create("timer"), "timer", "start", NOW);
    const timerResult = advanceExpiredClassroomTimeWidget(timer, NOW + 10 * 60_000);
    expect(timerResult.completedTargets).toEqual(["timer"]);
    expect(timerResult.metadata.kind === "timer" && timerResult.metadata.runtime.status).toBe("completed");

    const pomodoro = applyClassroomTimeControl(create("pomodoro"), "pomodoro", "start", NOW);
    const pomodoroResult = advanceExpiredClassroomTimeWidget(pomodoro, NOW + 30 * 60_000);
    expect(pomodoroResult.completedTargets).toEqual(["pomodoro"]);
    expect(pomodoroResult.metadata.kind === "pomodoro" && pomodoroResult.metadata.runtime.phase).toBe("short-break");
  });

  it("finds one selected logical widget from any of its parts", () => {
    const metadata = create("timer");
    const widget = createClassroomTimeWidgetScene({ metadata, x: 10, y: 20, now: NOW });
    const child = widget.elements[1];
    const selected = selectedClassroomTimeWidget(widget.elements, { [child.id]: true });
    expect(selected?.ownerId).toBe(metadata.ownerId);
    expect(selected?.elementIds).toHaveLength(widget.elements.length);
    expect(selectedClassroomTimeWidget(widget.elements, {})).toBeNull();
  });

  it("derives one bounded alarm descriptor per active target", () => {
    const timer = applyClassroomTimeControl(create("timer"), "timer", "start", NOW);
    if (timer.kind !== "timer") throw new Error("Expected timer metadata.");
    const widget = createClassroomTimeWidgetScene({ metadata: timer, x: 0, y: 0, now: NOW });
    const descriptors = activeClassroomTimeAlarmDescriptors("project-1", widget.elements);
    expect(descriptors).toEqual([expect.objectContaining({
      id: `${timer.ownerId}:timer`,
      sourceProjectId: "project-1",
      target: "timer",
      deadlineMs: NOW + timer.timer.durationMs,
    })]);
  });

  it("resolves only referenced project events plus device events into display labels", () => {
    const metadata = create("calendar");
    if (metadata.kind !== "calendar") throw new Error("Expected calendar metadata.");
    metadata.calendar.projectEventIds.push("project-event");
    const widget = createClassroomTimeWidgetScene({ metadata, x: 0, y: 0, now: NOW });
    const event = (id: string, title: string, color: string, note?: string) => ({
      schemaVersion: 1 as const,
      id,
      date: "2026-08-21",
      title,
      ...(note ? { note } : {}),
      color,
      allDay: true,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    const context = classroomTimeRenderContext(
      widget.elements as readonly ExcalidrawElement[],
      createClassroomCalendarStoreV1("project", [
        event("project-event", "Assembly", "#4169e1", "Gym doors open at 9"),
        event("hidden", "Hidden", "#000000"),
      ]),
      createClassroomCalendarStoreV1("device", [event("device-event", "Personal", "#aa00cc", "Private reminder")]),
      new Date(2026, 7, 21).getTime(),
      "dark",
    );
    expect(context.boardTheme).toBe("dark");
    expect(context.calendarEventLabelsByOwner?.[metadata.ownerId]).toEqual([
      "08-21 · Personal",
      "08-21 · Assembly",
    ]);
    expect(context.calendarEventsByOwner?.[metadata.ownerId]).toEqual([
      {
        date: "2026-08-21",
        label: "Personal",
        note: "Private reminder",
        color: "#AA00CC",
      },
      {
        date: "2026-08-21",
        label: "Assembly",
        note: "Gym doors open at 9",
        color: "#4169E1",
      },
    ]);
  });

  it("shows all project events when a new widget has no explicit event selection", () => {
    const metadata = create("calendar");
    if (metadata.kind !== "calendar") throw new Error("Expected calendar metadata.");
    metadata.calendar.showDeviceEvents = false;
    const widget = createClassroomTimeWidgetScene({ metadata, x: 0, y: 0, now: NOW });
    const event = {
      schemaVersion: 1 as const,
      id: "existing-event",
      date: "2026-08-22",
      title: "Existing project event",
      color: "#4169e1",
      allDay: true,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const context = classroomTimeRenderContext(
      widget.elements,
      createClassroomCalendarStoreV1("project", [event]),
      createClassroomCalendarStoreV1("device"),
      new Date(2026, 7, 21).getTime(),
    );
    expect(context.calendarEventLabelsByOwner?.[metadata.ownerId]).toEqual([
      "08-22 · Existing project event",
    ]);
  });
});
