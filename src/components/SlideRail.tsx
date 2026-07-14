import type { ClassroomProject, ClassroomSlide } from "../types";
import { DragIcon, EyeIcon, EyeOffIcon, FrameIcon, PlusIcon, TrashIcon } from "./Icons";
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
}: SlideRailProps) {
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
      <div className="slide-rail-actions" role="group" aria-label="Add slides">
        <button className="new-slide-button" type="button" onClick={onAddSlide}>
          <PlusIcon /> Add slide
        </button>
        <button className="draw-frame-button" type="button" onClick={onDrawFrame}>
          <FrameIcon /> Draw around content
        </button>
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
