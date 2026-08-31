import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ClassroomSlide } from "../types";
import { isEditableKeyboardTarget } from "../lib/keyboard-targets";
import { materializeClassroomTimeWidgetSnapshot } from "../lib/classroom-time/runtime";
import type { ClassroomTimeWidgetMetadataV1 } from "../lib/classroom-time/types";
import {
  PRESENTATION_INK_COLOURS,
  PRESENTATION_INK_WIDTHS,
  type PresentationInkColour,
  type PresentationInkWidth,
} from "../lib/presentation-ink";
import {
  CloseIcon,
  EraserIcon,
  HidePanelIcon,
  InkIcon,
  LaserIcon,
  NextIcon,
  PreviousIcon,
  ShowPanelIcon,
} from "./Icons";

const PRESENTATION_CONTROLS_TOGGLE_SETTLE_MS = 350;

function formatPresentationRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export type PresentationTool = "eraser" | "freedraw" | "laser";
export type PresentationClassroomTimeTarget = "pomodoro" | "timer";

export interface PresentationClassroomTimeControls {
  metadata: ClassroomTimeWidgetMetadataV1;
  nowMs: number;
  activeTarget: PresentationClassroomTimeTarget;
}

interface PresentationOverlayProps {
  slides: readonly ClassroomSlide[];
  index: number;
  tool: PresentationTool;
  inkColour: PresentationInkColour;
  inkWidth: PresentationInkWidth;
  classroomTime?: PresentationClassroomTimeControls | null;
  /** Pauses wrapper-owned global shortcuts while another app surface owns the keyboard. */
  shortcutsPaused?: boolean;
  onIndexChange: (index: number) => void;
  onToolChange: (tool: PresentationTool) => void;
  onClassroomTimeCommand?: (
    command: "add-minute" | "pause" | "reset" | "skip" | "start",
    target: PresentationClassroomTimeTarget,
  ) => void;
  onClassroomTimeTargetChange?: (target: PresentationClassroomTimeTarget) => void;
  onInkColourChange: (colour: PresentationInkColour) => void;
  onInkWidthChange: (width: PresentationInkWidth) => void;
  onExit: () => void;
}

export function PresentationOverlay({
  slides,
  index,
  tool,
  inkColour,
  inkWidth,
  classroomTime = null,
  shortcutsPaused = false,
  onIndexChange,
  onToolChange,
  onClassroomTimeCommand,
  onClassroomTimeTargetChange,
  onInkColourChange,
  onInkWidthChange,
  onExit,
}: PresentationOverlayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedButtonRef = useRef<HTMLButtonElement>(null);
  const expandedCollapseButtonRef = useRef<HTMLButtonElement>(null);
  const wasCollapsedRef = useRef(false);
  const toggleSettleTimerRef = useRef<number | null>(null);

  const classroomTimeSnapshot = classroomTime
    ? materializeClassroomTimeWidgetSnapshot(classroomTime.metadata, classroomTime.nowMs)
    : null;
  const classroomTimeTarget = classroomTime
    ? classroomTime.metadata.kind === "timer" || classroomTime.metadata.kind === "pomodoro"
      ? classroomTime.metadata.kind
      : classroomTime.metadata.kind === "dashboard"
        ? classroomTime.activeTarget === "pomodoro" && classroomTime.metadata.panels.pomodoro
          ? "pomodoro"
          : classroomTime.metadata.panels.timer
            ? "timer"
            : classroomTime.metadata.panels.pomodoro
              ? "pomodoro"
              : null
        : null
    : null;
  const classroomTimerSnapshot = classroomTimeTarget === "timer"
    ? classroomTimeSnapshot?.timer
    : classroomTimeTarget === "pomodoro"
      ? classroomTimeSnapshot?.pomodoro
      : null;
  const classroomTimePhase = classroomTimeTarget === "pomodoro" && classroomTimeSnapshot?.pomodoro
    ? classroomTimeSnapshot.pomodoro.phase.replace("-", " ")
    : "Timer";
  const classroomTimeLabel = classroomTime?.metadata.label
    || (classroomTimeTarget === "pomodoro" ? "Pomodoro" : "Timer");
  const classroomTimeRemaining = classroomTimerSnapshot
    ? formatPresentationRemaining(classroomTimerSnapshot.remainingMs)
    : null;

  const toggleControls = useCallback(() => {
    if (toggleSettleTimerRef.current !== null) return;
    // Absorb rapid discrete taps as well as key-repeat. The first intent wins,
    // then the toggle becomes available again after the visual change settles.
    toggleSettleTimerRef.current = window.setTimeout(() => {
      toggleSettleTimerRef.current = null;
    }, PRESENTATION_CONTROLS_TOGGLE_SETTLE_MS);
    setCollapsed((current) => !current);
  }, []);

  useEffect(() => () => {
    if (toggleSettleTimerRef.current !== null) {
      window.clearTimeout(toggleSettleTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutsPaused) return;
      if (isEditableKeyboardTarget(event.target)) return;

      const target = event.target instanceof Element ? event.target : null;
      const isPresentationControl = Boolean(target?.closest(
        ".presentation-controls, .presentation-controls-collapsed",
      ));
      if (
        !isPresentationControl
        && target?.closest([
          "dialog",
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[role="menu"]',
          '[role="listbox"]',
          '[aria-modal="true"]',
          '[aria-busy="true"]',
          ".modal-backdrop",
          ".Modal",
          ".context-menu",
          ".dropdown-menu",
        ].join(", "))
      ) {
        return;
      }

      const plainToolShortcut = !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        ? ({
            "0": "eraser",
            "7": "freedraw",
            e: "eraser",
            k: "laser",
            p: "freedraw",
          } as const)[event.key.toLowerCase() as "0" | "7" | "e" | "k" | "p"]
        : undefined;
      if (plainToolShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) onToolChange(plainToolShortcut);
        return;
      }

      const isPlainCollapseShortcut = event.key.toLowerCase() === "c"
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey;
      if (isPlainCollapseShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) toggleControls();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onExit();
        return;
      }
      if (
        (event.key === " " || event.key === "Enter")
        && target?.closest("button, a[href]")
      ) {
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        onIndexChange(Math.min(slides.length - 1, index + 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        onIndexChange(Math.max(0, index - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        onIndexChange(0);
      } else if (event.key === "End") {
        event.preventDefault();
        onIndexChange(slides.length - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [index, onExit, onIndexChange, onToolChange, shortcutsPaused, slides.length, toggleControls]);

  useEffect(() => {
    if (collapsed) {
      collapsedButtonRef.current?.focus();
    } else if (wasCollapsedRef.current) {
      expandedCollapseButtonRef.current?.focus();
    }
    wasCollapsedRef.current = collapsed;
  }, [collapsed]);

  const slideStatus = (
    <span
      className="visually-hidden"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      Slide {index + 1} of {slides.length}
    </span>
  );

  if (collapsed) {
    return (
      <>
        {slideStatus}
        <div
          className="presentation-controls-collapsed"
          role="toolbar"
          aria-label="Collapsed presentation controls"
        >
          <button
            ref={collapsedButtonRef}
            className="presentation-collapse-toggle"
            type="button"
            onClick={toggleControls}
            aria-label="Expand presentation controls"
            aria-expanded="false"
            aria-keyshortcuts="C"
            title="Show presentation controls (C)"
          >
            <ShowPanelIcon />
            <span aria-hidden="true">{index + 1} / {slides.length}</span>
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {slideStatus}
      <div className="presentation-controls" role="toolbar" aria-label="Presentation controls">
        <div className="presentation-main-controls">
          <button type="button" onClick={() => onIndexChange(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous slide"><PreviousIcon /></button>
          <span className="presentation-count" aria-hidden="true">{index + 1} / {slides.length}</span>
          <button type="button" onClick={() => onIndexChange(Math.min(slides.length - 1, index + 1))} disabled={index >= slides.length - 1} aria-label="Next slide"><NextIcon /></button>
          <span className="presentation-separator" />
          <button type="button" className={tool === "laser" ? "is-active" : ""} onClick={() => onToolChange("laser")} aria-label="Laser" aria-keyshortcuts="K" aria-pressed={tool === "laser"} title="Laser (K)"><LaserIcon /><span className="icon-label">Laser</span></button>
          <button type="button" className={tool === "freedraw" ? "is-active" : ""} onClick={() => onToolChange("freedraw")} aria-label="Ink" aria-keyshortcuts="P 7" aria-pressed={tool === "freedraw"} title="Ink (P or 7)"><InkIcon /><span className="icon-label">Ink</span></button>
          <button type="button" className={tool === "eraser" ? "is-active" : ""} onClick={() => onToolChange("eraser")} aria-label="Eraser" aria-keyshortcuts="E 0" aria-pressed={tool === "eraser"} title="Eraser (E or 0)"><EraserIcon /><span className="icon-label">Eraser</span></button>
          {classroomTimeTarget && classroomTimerSnapshot && onClassroomTimeCommand ? (
            <>
              <span className="presentation-separator" />
              {classroomTime?.metadata.kind === "dashboard"
                && classroomTime.metadata.panels.timer
                && classroomTime.metadata.panels.pomodoro
                && onClassroomTimeTargetChange ? (
                  <>
                    <button type="button" aria-label="Control dashboard timer" aria-pressed={classroomTimeTarget === "timer"} className={classroomTimeTarget === "timer" ? "is-active" : ""} onClick={() => onClassroomTimeTargetChange("timer")}>Timer</button>
                    <button type="button" aria-label="Control dashboard Pomodoro" aria-pressed={classroomTimeTarget === "pomodoro"} className={classroomTimeTarget === "pomodoro" ? "is-active" : ""} onClick={() => onClassroomTimeTargetChange("pomodoro")}>Pomodoro</button>
                  </>
                ) : null}
              <span className="presentation-count" aria-label={`${classroomTimeLabel}, ${classroomTimePhase}, ${classroomTimeRemaining} remaining`}>
                {classroomTimeLabel} · {classroomTimeRemaining}
              </span>
              {classroomTimerSnapshot.status === "running" ? (
                <button type="button" aria-label="Pause" onClick={() => onClassroomTimeCommand("pause", classroomTimeTarget)}>Pause</button>
              ) : (
                <button type="button" aria-label={classroomTimerSnapshot.status === "completed" ? "Restart" : "Start"} onClick={() => onClassroomTimeCommand("start", classroomTimeTarget)}>{classroomTimerSnapshot.status === "completed" ? "Restart" : "Start"}</button>
              )}
              <button type="button" aria-label="Reset" onClick={() => onClassroomTimeCommand("reset", classroomTimeTarget)}>Reset</button>
              <button type="button" aria-label="Add one minute" onClick={() => onClassroomTimeCommand("add-minute", classroomTimeTarget)}>+1 min</button>
              {classroomTimeTarget === "pomodoro" ? <button type="button" aria-label="Skip" onClick={() => onClassroomTimeCommand("skip", classroomTimeTarget)}>Skip</button> : null}
            </>
          ) : null}
          <button ref={expandedCollapseButtonRef} className="presentation-collapse-toggle" type="button" onClick={toggleControls} aria-label="Collapse presentation controls" aria-expanded="true" aria-keyshortcuts="C" title="Collapse controls to bottom-left (C)"><HidePanelIcon /><span className="icon-label">Collapse</span></button>
          <button type="button" onClick={onExit} aria-label="Exit" title="Exit presentation"><CloseIcon /><span className="icon-label">Exit</span></button>
        </div>
        <div className="presentation-ink-palette" role="group" aria-label="Ink colours">
          <span className="presentation-palette-label">Ink colour</span>
          {PRESENTATION_INK_COLOURS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={`presentation-colour-swatch ${inkColour === value ? "is-selected" : ""}`}
              style={{ "--swatch-colour": value } as CSSProperties}
              onClick={() => onInkColourChange(value)}
              aria-label={`${label} ink`}
              aria-pressed={inkColour === value}
              title={`${label} ink`}
            >
              <span className="visually-hidden">{label}</span>
            </button>
          ))}
        </div>
        <div className="presentation-width-picker" role="group" aria-label="Ink widths">
          <span className="presentation-palette-label">Ink width</span>
          {PRESENTATION_INK_WIDTHS.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={`presentation-width-button ${inkWidth === value ? "is-selected" : ""}`}
              onClick={() => onInkWidthChange(value)}
              aria-label={`${label} ink width`}
              aria-pressed={inkWidth === value}
              title={`${label} — ${value}px on screen`}
            >
              <span className="presentation-width-line" style={{ height: value }} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
