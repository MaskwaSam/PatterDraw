import { useEffect, useRef, useState } from "react";
import type { ClassroomProject, ClassroomSlide, SlideFrameAspectRatio } from "../types";
import {
  MAX_SLIDE_MORPH_DURATION_MS,
  MIN_SLIDE_MORPH_DURATION_MS,
  SLIDE_MORPH_DURATION_STEP_MS,
} from "../lib/slide-transition";
import {
  DownIcon,
  DragIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  HidePanelIcon,
  MoreIcon,
  MorphIcon,
  PlusIcon,
  TrashIcon,
  UpIcon,
} from "./Icons";
import { SlidePreview } from "./SlidePreview";
import { useModalDialog } from "./useModalDialog";

const SLIDE_DRAG_MIME = "application/x-patterdraw-slide";

type SlideDropTarget = {
  slideId: string;
  position: "before" | "after";
};

interface SlideRailProps {
  project: ClassroomProject;
  activeSlideId: string | null;
  onAddSlide: () => void;
  frameDrawingActive: boolean;
  onToggleFrameDrawing: () => void;
  onOpenSlide: (slide: ClassroomSlide) => void;
  onMoveSlide: (slideId: string, targetId: string) => void;
  onDeleteSlide: (slide: ClassroomSlide) => void;
  onHide: () => void;
  framesVisible: boolean;
  onToggleFrames: () => void;
  frameAspectRatio: SlideFrameAspectRatio;
  onFrameAspectRatioChange: (aspectRatio: SlideFrameAspectRatio) => void;
  morphEnabled: boolean;
  morphDurationMs: number;
  onToggleMorph: () => void;
  onMorphDurationChange: (durationMs: number) => void;
}

export function SlideRail({
  project,
  activeSlideId,
  onAddSlide,
  frameDrawingActive,
  onToggleFrameDrawing,
  onOpenSlide,
  onMoveSlide,
  onDeleteSlide,
  onHide,
  framesVisible,
  onToggleFrames,
  frameAspectRatio,
  onFrameAspectRatioChange,
  morphEnabled,
  morphDurationMs,
  onToggleMorph,
  onMorphDurationChange,
}: SlideRailProps) {
  const railRef = useRef<HTMLElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const actionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [announcement, setAnnouncement] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionSlideId, setActionSlideId] = useState<string | null>(null);
  const [draggingSlideId, setDraggingSlideId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<SlideDropTarget | null>(null);
  const morphDurationSeconds = `${Number((morphDurationMs / 1_000).toFixed(2))} s`;
  const settingsDialogRef = useModalDialog<HTMLDivElement>({
    onClose: () => setSettingsOpen(false),
    open: settingsOpen,
    returnFocusRef: settingsButtonRef,
  });
  const chooseFrameAspectRatio = (aspectRatio: SlideFrameAspectRatio) => {
    onFrameAspectRatioChange(
      aspectRatio !== "freeform" && frameAspectRatio === aspectRatio ? "freeform" : aspectRatio,
    );
  };
  const focusActionButton = (slideId: string) => actionButtonRefs.current.get(slideId)?.focus();
  const closeActionMenu = (slideId: string, restoreFocus = false) => {
    if (restoreFocus) focusActionButton(slideId);
    setActionSlideId(null);
  };
  const slideDropTarget = (movingId: string, targetId: string): SlideDropTarget | null => {
    const movingIndex = project.slideOrder.findIndex((slide) => slide.id === movingId);
    const targetIndex = project.slideOrder.findIndex((slide) => slide.id === targetId);
    if (movingIndex < 0 || targetIndex < 0 || movingIndex === targetIndex) return null;
    return { slideId: targetId, position: movingIndex < targetIndex ? "after" : "before" };
  };

  useEffect(() => {
    if (!settingsOpen && !actionSlideId) return;
    const closeFloatingPanels = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        settingsOpen
        && !settingsDialogRef.current?.contains(target)
        && !settingsButtonRef.current?.contains(target)
      ) setSettingsOpen(false);
      if (
        actionSlideId
        && (!(target instanceof Element) || !target.closest(".slide-thumbnail-menu, .slide-thumbnail-menu-button"))
      ) setActionSlideId(null);
    };
    document.addEventListener("pointerdown", closeFloatingPanels, true);
    return () => document.removeEventListener("pointerdown", closeFloatingPanels, true);
  }, [actionSlideId, settingsOpen]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen || actionSlideId) {
        event.preventDefault();
        setSettingsOpen(false);
        if (actionSlideId) closeActionMenu(actionSlideId, true);
        return;
      }
      if (window.matchMedia("(max-width: 640px)").matches) {
        event.preventDefault();
        onHide();
      }
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [actionSlideId, onHide, settingsOpen]);

  const shiftSlide = (slide: ClassroomSlide, index: number, direction: -1 | 1) => {
    const target = project.slideOrder[index + direction];
    if (!target) return;
    focusActionButton(slide.id);
    onMoveSlide(slide.id, target.id);
    setActionSlideId(null);
    setAnnouncement(`Moved ${slide.title} to slide position ${index + direction + 1}.`);
  };

  const toggleSettings = () => {
    setActionSlideId(null);
    setSettingsOpen((open) => !open);
  };

  return (
    <aside id="slide-rail" ref={railRef} className="slide-rail" aria-label="Slides">
      <div className="rail-heading slide-rail-heading">
        <div className="slide-rail-title">
          <h2>Slides</h2>
          <span
            className="slide-count"
            aria-label={`${project.slideOrder.length} slide${project.slideOrder.length === 1 ? "" : "s"}`}
          >
            {project.slideOrder.length}
          </span>
        </div>
        <div className="slide-rail-heading-actions">
          <button className="icon-button slide-add-button" type="button" aria-label="Add slide" title="Add slide" onClick={onAddSlide}>
            <PlusIcon />
          </button>
          <button
            ref={settingsButtonRef}
            className={`icon-button slide-settings-button ${settingsOpen ? "is-active" : ""}`}
            type="button"
            aria-label="Slide settings"
            title="Slide settings"
            aria-expanded={settingsOpen}
            aria-controls="slide-settings-popover"
            onClick={toggleSettings}
          >
            <MoreIcon />
          </button>
          <button className="icon-button slide-rail-hide" type="button" aria-label="Hide slide navigator" title="Hide slide navigator" onClick={onHide}>
            <HidePanelIcon />
          </button>
        </div>
      </div>

      {settingsOpen ? (
        <div
          id="slide-settings-popover"
          ref={settingsDialogRef}
          className="slide-settings-popover"
          role="dialog"
          aria-label="Slide settings"
          tabIndex={-1}
        >
          <div className="slide-settings-heading">
            <strong>Presentation settings</strong>
            <span>Local to this project</span>
          </div>
          <section className="slide-settings-section" aria-labelledby="slide-shape-heading">
            <div id="slide-shape-heading" className="slide-settings-label">
              <span>New slide</span>
              <output>{frameAspectRatio === "freeform" ? "Freeform" : frameAspectRatio}</output>
            </div>
            <button
              className={`draw-frame-button ${frameDrawingActive ? "is-active" : ""}`}
              type="button"
              aria-pressed={frameDrawingActive}
              aria-expanded={frameDrawingActive}
              aria-controls="slide-frame-aspect-options"
              aria-label="Draw slide"
              title={frameDrawingActive ? "Cancel drawing slide" : "Draw slide"}
              onClick={() => {
                onToggleFrameDrawing();
                if (window.matchMedia("(max-width: 640px)").matches) {
                  setSettingsOpen(false);
                  onHide();
                }
              }}
            >
              <FrameIcon />
              <span>{frameDrawingActive ? "Cancel drawing" : "Draw slide"}</span>
            </button>
            {frameDrawingActive ? (
              <div id="slide-frame-aspect-options" className="slide-frame-aspect-options">
                <div className="slide-settings-label slide-frame-aspect-heading">
                  <span>Slide shape</span>
                  <output>{frameAspectRatio === "freeform" ? "Freeform" : frameAspectRatio}</output>
                </div>
                <div className="slide-aspect-segments slide-frame-aspect-buttons" role="group" aria-label="Slide shape">
                  {(["16:9", "4:3", "freeform"] as const).map((aspectRatio) => (
                    <button
                      key={aspectRatio}
                      className={frameAspectRatio === aspectRatio ? "is-active" : ""}
                      type="button"
                      aria-label={aspectRatio === "16:9"
                        ? "16:9 — 1080p and 4K"
                        : aspectRatio === "4:3"
                          ? "4:3 — Old TVs and smartboards"
                          : "Freeform"}
                      aria-pressed={frameAspectRatio === aspectRatio}
                      onClick={() => chooseFrameAspectRatio(aspectRatio)}
                    >
                      {aspectRatio === "freeform" ? "Free" : aspectRatio}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
          <section className="slide-settings-section" aria-label="Slide display">
            <button
              className="slide-settings-toggle toggle-frames-button"
              type="button"
              onClick={onToggleFrames}
              aria-label={framesVisible ? "Hide slide frames" : "Show slide frames"}
              aria-pressed={framesVisible}
            >
              {framesVisible ? <EyeOffIcon /> : <EyeIcon />}
              <span>{framesVisible ? "Hide frames" : "Show frames"}</span>
            </button>
            <button
              className={`slide-settings-toggle toggle-morph-button ${morphEnabled ? "is-active" : ""}`}
              type="button"
              onClick={onToggleMorph}
              aria-label="Morph"
              aria-pressed={morphEnabled}
            >
              <MorphIcon />
              <span>Morph</span>
              <strong>{morphEnabled ? "On" : "Off"}</strong>
            </button>
            {morphEnabled ? (
              <label className="morph-duration-control">
                <span>Duration</span>
                <input
                  type="range"
                  aria-label="Morph duration"
                  aria-valuetext={morphDurationSeconds}
                  min={MIN_SLIDE_MORPH_DURATION_MS}
                  max={MAX_SLIDE_MORPH_DURATION_MS}
                  step={SLIDE_MORPH_DURATION_STEP_MS}
                  value={morphDurationMs}
                  onChange={(event) => onMorphDurationChange(Number(event.currentTarget.value))}
                />
                <output>{morphDurationSeconds}</output>
              </label>
            ) : null}
          </section>
        </div>
      ) : null}

      <div className="slide-draw-status-slot">
        {frameDrawingActive ? (
          <div className="slide-draw-status" role="status">
            <FrameIcon />
            <span>Drawing {frameAspectRatio === "freeform" ? "freeform" : frameAspectRatio} slide</span>
            <button type="button" onClick={onToggleFrameDrawing}>Cancel</button>
          </div>
        ) : null}
      </div>

      <div className="rail-scroll">
        {project.slideOrder.length ? project.slideOrder.map((slide, index) => {
          const selected = slide.id === activeSlideId;
          const actionsOpen = actionSlideId === slide.id;
          return (
            <div
              className={`slide-thumbnail-wrap ${dropTarget?.slideId === slide.id ? `is-drop-target is-drop-${dropTarget.position}` : ""} ${actionsOpen ? "has-open-actions" : ""}`}
              key={slide.id}
              data-drop-target={dropTarget?.slideId === slide.id ? "true" : undefined}
              data-drop-position={dropTarget?.slideId === slide.id ? dropTarget.position : undefined}
            >
              <button
                type="button"
                className={`slide-thumbnail ${selected ? "is-selected" : ""}`}
                draggable
                aria-current={selected ? "page" : undefined}
                aria-label={`Open slide ${index + 1}: ${slide.title}`}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(SLIDE_DRAG_MIME, slide.id);
                  event.dataTransfer.setData("text/plain", slide.id);
                  setDraggingSlideId(slide.id);
                  setActionSlideId(null);
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  const movingId = draggingSlideId
                    || event.dataTransfer.getData(SLIDE_DRAG_MIME)
                    || event.dataTransfer.getData("text/plain");
                  setDropTarget(slideDropTarget(movingId, slide.id));
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const movingId = draggingSlideId
                    || event.dataTransfer.getData(SLIDE_DRAG_MIME)
                    || event.dataTransfer.getData("text/plain");
                  setDropTarget(slideDropTarget(movingId, slide.id));
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) {
                    setDropTarget((target) => target?.slideId === slide.id ? null : target);
                  }
                }}
                onDragEnd={() => {
                  setDraggingSlideId(null);
                  setDropTarget(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDraggingSlideId(null);
                  setDropTarget(null);
                  const movingId = event.dataTransfer.getData(SLIDE_DRAG_MIME)
                    || event.dataTransfer.getData("text/plain");
                  if (movingId && movingId !== slide.id) {
                    const movingSlide = project.slideOrder.find((candidate) => candidate.id === movingId);
                    onMoveSlide(movingId, slide.id);
                    setAnnouncement(`Moved ${movingSlide?.title || "slide"} to slide position ${index + 1}.`);
                  }
                }}
                onClick={() => {
                  setActionSlideId(null);
                  onOpenSlide(slide);
                }}
              >
                <span className="slide-number" aria-hidden="true">{index + 1}</span>
                <span className="slide-thumbnail-content">
                  <SlidePreview scene={project.scenes[slide.sceneId]} frameId={slide.frameId} />
                  <span className="slide-caption">{slide.title}</span>
                </span>
                <DragIcon className="drag-handle" />
              </button>
              <button
                ref={(node) => {
                  if (node) actionButtonRefs.current.set(slide.id, node);
                  else actionButtonRefs.current.delete(slide.id);
                }}
                className="slide-thumbnail-menu-button"
                type="button"
                aria-label={`Slide ${index + 1} actions: ${slide.title}`}
                title="Slide actions"
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                aria-controls={`slide-actions-${slide.id}`}
                onClick={() => {
                  setSettingsOpen(false);
                  setActionSlideId((current) => current === slide.id ? null : slide.id);
                }}
              >
                <MoreIcon />
              </button>
              {actionsOpen ? (
                <div id={`slide-actions-${slide.id}`} className="slide-thumbnail-menu" role="menu" aria-label={`Slide ${index + 1} actions`}>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={index === 0}
                    onClick={() => shiftSlide(slide, index, -1)}
                  >
                    <UpIcon /><span>Move earlier</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={index === project.slideOrder.length - 1}
                    onClick={() => shiftSlide(slide, index, 1)}
                  >
                    <DownIcon /><span>Move later</span>
                  </button>
                  <button
                    className="is-danger"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setActionSlideId(null);
                      onDeleteSlide(slide);
                    }}
                  >
                    <TrashIcon /><span>Delete slide</span>
                  </button>
                </div>
              ) : null}
            </div>
          );
        }) : (
          <div className="rail-empty">
            <FrameIcon className="rail-empty-icon" />
            <strong>No slides yet</strong>
            <p>Add a blank slide, or draw a movable slide window anywhere on your board.</p>
            <button type="button" onClick={onAddSlide}><PlusIcon /> Add first slide</button>
          </div>
        )}
      </div>
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
    </aside>
  );
}
