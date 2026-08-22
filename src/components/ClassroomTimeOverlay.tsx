import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ClassroomTimeWidgetMetadataV1 } from "../lib/classroom-time/types";
import { materializeClassroomTimeWidgetSnapshot } from "../lib/classroom-time/runtime";

export type ClassroomTimeOverlayTarget = "pomodoro" | "timer";
export type ClassroomTimeOverlayCommand = "add-minute" | "pause" | "reset" | "skip" | "start";

export interface ClassroomTimeOverlayProps {
  metadata: ClassroomTimeWidgetMetadataV1;
  nowMs: number;
  activeTarget?: ClassroomTimeOverlayTarget;
  completionNotice?: string | null;
  onCommand: (command: ClassroomTimeOverlayCommand, target: ClassroomTimeOverlayTarget) => void;
  onConvertToOrdinaryElements: () => void;
  onCustomize: () => void;
  onDeleteWidget: () => void;
  onDismissCompletion: () => void;
  onDuplicate: () => void;
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function titleFor(metadata: ClassroomTimeWidgetMetadataV1): string {
  if (metadata.label) return metadata.label;
  if (metadata.kind === "calendar") return "Class Calendar";
  if (metadata.kind === "dashboard") return "Classroom Dashboard";
  return metadata.kind[0].toUpperCase() + metadata.kind.slice(1);
}

function targetFor(
  metadata: ClassroomTimeWidgetMetadataV1,
  activeTarget: ClassroomTimeOverlayTarget | undefined,
): ClassroomTimeOverlayTarget | null {
  if (metadata.kind === "timer" || metadata.kind === "pomodoro") return metadata.kind;
  if (metadata.kind !== "dashboard") return null;
  if (activeTarget === "pomodoro" && metadata.panels.pomodoro) return "pomodoro";
  if (activeTarget === "timer" && metadata.panels.timer) return "timer";
  if (metadata.panels.timer) return "timer";
  return metadata.panels.pomodoro ? "pomodoro" : null;
}

export function ClassroomTimeOverlay({
  metadata,
  nowMs,
  activeTarget,
  completionNotice,
  onCommand,
  onConvertToOrdinaryElements,
  onCustomize,
  onDeleteWidget,
  onDismissCompletion,
  onDuplicate,
}: ClassroomTimeOverlayProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const snapshot = materializeClassroomTimeWidgetSnapshot(metadata, nowMs);
  const target = targetFor(metadata, activeTarget);
  const timerSnapshot = target === "timer" ? snapshot.timer : target === "pomodoro" ? snapshot.pomodoro : null;
  const status = timerSnapshot?.status ?? null;
  const menuId = `classroom-time-overlay-menu-${metadata.ownerId}`;
  const phaseLabel = target === "pomodoro" && snapshot.pomodoro
    ? snapshot.pomodoro.phase.replace("-", " ")
    : target === "timer"
      ? "Timer"
      : metadata.kind === "clock"
        ? "Live clock"
        : metadata.kind === "calendar"
          ? "Calendar"
          : "Live widget";

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeAndRestoreFocus = () => {
      setMenuOpen(false);
      moreButtonRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const targetNode = event.target;
      if (!(targetNode instanceof Node)
        || menuRef.current?.contains(targetNode)
        || moreButtonRef.current?.contains(targetNode)) return;
      setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menuOpen]);

  const closeMenuAfter = (callback: () => void) => {
    setMenuOpen(false);
    callback();
    if (moreButtonRef.current?.isConnected) moreButtonRef.current.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  };

  return (
    <aside className="classroom-time-overlay" aria-label={`${titleFor(metadata)} controls`} data-testid="classroom-time-overlay">
      <div className="classroom-time-overlay-summary">
        <strong>{titleFor(metadata)}</strong>
        <span>{phaseLabel}</span>
        {timerSnapshot ? <output aria-label={`${phaseLabel} remaining time`}>{formatRemaining(timerSnapshot.remainingMs)}</output> : null}
      </div>

      {target ? (
        <div className="classroom-time-overlay-controls" aria-label={`${phaseLabel} actions`}>
          {status === "running" ? (
            <button type="button" className="is-primary" onClick={() => onCommand("pause", target)}>Pause</button>
          ) : (
            <button type="button" className="is-primary" onClick={() => onCommand("start", target)}>{status === "completed" ? "Restart" : "Start"}</button>
          )}
          <button type="button" onClick={() => onCommand("reset", target)}>Reset</button>
          <button type="button" aria-label="Add one minute" onClick={() => onCommand("add-minute", target)}>+1 min</button>
          {target === "pomodoro" ? <button type="button" onClick={() => onCommand("skip", target)}>Skip</button> : null}
        </div>
      ) : null}

      <div className="classroom-time-overlay-secondary">
        <button type="button" onClick={onCustomize}>Customize</button>
        <span className="classroom-time-overlay-menu-shell">
          <button
            ref={moreButtonRef}
            type="button"
            aria-label="More classroom time actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              setMenuOpen(true);
            }}
          >•••</button>
          {menuOpen ? (
            <div
              ref={menuRef}
              id={menuId}
              className="classroom-time-overlay-menu"
              role="menu"
              aria-label="Classroom time widget actions"
              onKeyDown={handleMenuKeyDown}
            >
              <button type="button" role="menuitem" onClick={() => closeMenuAfter(onDuplicate)}>Duplicate</button>
              <button type="button" role="menuitem" onClick={() => closeMenuAfter(onConvertToOrdinaryElements)}>Convert to ordinary elements</button>
              <button type="button" role="menuitem" className="is-danger" onClick={() => closeMenuAfter(onDeleteWidget)}>Delete widget</button>
            </div>
          ) : null}
        </span>
      </div>

      {completionNotice ? (
        <div className="classroom-time-overlay-alert" role="alert">
          <strong>Time is up</strong>
          <span>{completionNotice}</span>
          <div className="classroom-time-overlay-alert-actions">
            <button type="button" onClick={onDismissCompletion}>Dismiss</button>
            {target ? <button type="button" className="is-primary" onClick={() => {
              onCommand("reset", target);
              onDismissCompletion();
            }}>Reset</button> : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
