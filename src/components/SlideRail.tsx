import { useState } from "react";
import type { ClassroomProject, ClassroomSlide, SlideFrameAspectRatio } from "../types";
import {
  MAX_SLIDE_MORPH_DURATION_MS,
  MIN_SLIDE_MORPH_DURATION_MS,
  SLIDE_MORPH_DURATION_STEP_MS,
} from "../lib/slide-transition";
import { DragIcon, EyeIcon, EyeOffIcon, FrameIcon, MorphIcon, PlusIcon, TrashIcon } from "./Icons";
import { SlidePreview } from "./SlidePreview";

interface SlideRailProps {
  project: ClassroomProject;
  activeSlideId: string | null;
  onAddSlide: () => void;
  onDrawFrame: () => void;
  onOpenSlide: (slide: ClassroomSlide) => void;
  onMoveSlide: (slideId: string, targetId: string) => void;
  onDeleteSlide: (slide: ClassroomSlide) => void;
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
  onDrawFrame,
  onOpenSlide,
  onMoveSlide,
  onDeleteSlide,
  framesVisible,
  onToggleFrames,
  frameAspectRatio,
  onFrameAspectRatioChange,
  morphEnabled,
  morphDurationMs,
  onToggleMorph,
  onMorphDurationChange,
}: SlideRailProps) {
  const [frameAspectOptionsOpen, setFrameAspectOptionsOpen] = useState(false);
  const morphDurationSeconds = `${Number((morphDurationMs / 1_000).toFixed(2))} s`;
  const chooseFrameAspectRatio = (aspectRatio: Exclude<SlideFrameAspectRatio, "freeform">) => {
    onFrameAspectRatioChange(frameAspectRatio === aspectRatio ? "freeform" : aspectRatio);
    onDrawFrame();
  };
  return (
    <aside id="slide-rail" className="slide-rail" aria-label="Slides">
      <div className="rail-heading">
        <div>
          <span className="rail-kicker">Presentation</span>
          <h2>Slides</h2>
        </div>
        <span
          className="slide-count"
          aria-label={`${project.slideOrder.length} slide${project.slideOrder.length === 1 ? "" : "s"}`}
        >
          {project.slideOrder.length}
        </span>
      </div>
      <div className="slide-rail-actions" role="group" aria-label="Slide controls">
        <button className="new-slide-button" type="button" onClick={onAddSlide}>
          <PlusIcon /> Add slide
        </button>
        <button
          className="draw-frame-button"
          type="button"
          aria-expanded={frameAspectOptionsOpen}
          aria-controls="slide-frame-aspect-options"
          onClick={() => {
            setFrameAspectOptionsOpen((open) => !open);
            onDrawFrame();
          }}
        >
          <FrameIcon /> Draw around content
        </button>
        {frameAspectOptionsOpen ? (
          <div id="slide-frame-aspect-options" className="slide-frame-aspect-options">
            <div className="slide-frame-aspect-heading">
              <strong>Frame shape</strong>
              <span>{frameAspectRatio === "freeform" ? "Freeform" : frameAspectRatio}</span>
            </div>
            <div className="slide-frame-aspect-buttons" role="group" aria-label="Frame shape">
              <button
                className={frameAspectRatio === "16:9" ? "is-active" : ""}
                type="button"
                aria-pressed={frameAspectRatio === "16:9"}
                onClick={() => chooseFrameAspectRatio("16:9")}
              >
                <span className="aspect-ratio-preview is-widescreen" aria-hidden="true" />
                <span><strong>16:9</strong><small>1080p and 4K</small></span>
              </button>
              <button
                className={frameAspectRatio === "4:3" ? "is-active" : ""}
                type="button"
                aria-pressed={frameAspectRatio === "4:3"}
                onClick={() => chooseFrameAspectRatio("4:3")}
              >
                <span className="aspect-ratio-preview is-standard" aria-hidden="true" />
                <span><strong>4:3</strong><small>Old TVs and smartboards</small></span>
              </button>
            </div>
            <small className="slide-frame-aspect-help">Select the active shape again to return to freeform.</small>
          </div>
        ) : null}
        <div className="slide-display-actions">
          <button
            className="toggle-frames-button"
            type="button"
            onClick={onToggleFrames}
            aria-label={framesVisible ? "Hide slide frames" : "Show slide frames"}
            aria-pressed={framesVisible}
          >
            {framesVisible ? <EyeOffIcon /> : <EyeIcon />}
            {framesVisible ? "Hide frames" : "Show frames"}
          </button>
          <button
            className={`toggle-morph-button ${morphEnabled ? "is-active" : ""}`}
            type="button"
            onClick={onToggleMorph}
            aria-label="Morph"
            aria-pressed={morphEnabled}
            title={morphEnabled ? "Disable Morph slide transition" : "Enable Morph slide transition"}
          >
            <MorphIcon /> Morph
          </button>
        </div>
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
      </div>
      <div className="rail-scroll">
        {project.slideOrder.length ? project.slideOrder.map((slide, index) => {
          const selected = slide.id === activeSlideId;
          return (
            <div className="slide-thumbnail-wrap" key={slide.id}>
              <button
                type="button"
                className={`slide-thumbnail ${selected ? "is-selected" : ""}`}
                draggable
                aria-current={selected ? "page" : undefined}
                aria-label={`Open slide ${index + 1}: ${slide.title}`}
                onDragStart={(event) => event.dataTransfer.setData("text/plain", slide.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onMoveSlide(event.dataTransfer.getData("text/plain"), slide.id)}
                onClick={() => onOpenSlide(slide)}
              >
                <span className="slide-number" aria-hidden="true">{index + 1}</span>
                <span className="slide-thumbnail-content">
                  <SlidePreview scene={project.scenes[slide.sceneId]} frameId={slide.frameId} />
                  <span className="slide-caption">{slide.title}</span>
                </span>
                <DragIcon className="drag-handle" />
              </button>
              {selected ? (
                <button
                  className="thumbnail-delete-button slide-thumbnail-delete"
                  type="button"
                  aria-label="Delete selected slide"
                  title="Delete selected slide"
                  onClick={() => onDeleteSlide(slide)}
                >
                  <TrashIcon />
                </button>
              ) : null}
            </div>
          );
        }) : (
          <div className="rail-empty">
            <FrameIcon className="rail-empty-icon" />
            <strong>No slides yet</strong>
            <p>Add a blank slide, or draw around content that is already on your board.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
