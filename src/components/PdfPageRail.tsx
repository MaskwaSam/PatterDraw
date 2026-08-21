import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import type { ClassroomProject, SceneId, SerializedScene } from "../types";
import type { PdfPageDropEdge } from "../lib/pdf/page-order";
import { ChevronDownIcon, DownIcon, DragIcon, HidePanelIcon, PdfIcon, PlusIcon, TrashIcon, UpIcon } from "./Icons";

const PDF_PAGE_DRAG_TYPE = "application/x-patterdraw-pdf-page";
export const PDF_RAIL_MIN_WIDTH = 180;
export const PDF_RAIL_MAX_WIDTH = 420;
export const PDF_RAIL_DEFAULT_WIDTH = 224;

// Scene objects are immutable snapshots. Weak caches keep unchanged pages
// from repeatedly walking their full element arrays when another page edits.
const thumbnailDataUrlCache = new WeakMap<SerializedScene, string | null>();
const annotationCountCache = new WeakMap<SerializedScene, number>();

interface PdfPageRailProps {
  project: ClassroomProject;
  pages: readonly SerializedScene[];
  activeSceneId: SceneId;
  thumbnailDataUrls?: Readonly<Partial<Record<SceneId, string>>>;
  onOpenPage: (sceneId: SceneId) => void;
  onMovePage: (movingId: SceneId, targetId: SceneId, edge: PdfPageDropEdge) => void;
  onShiftPage: (sceneId: SceneId, direction: -1 | 1) => void;
  onAddBlankPage: () => void;
  onInsertPdfPages: () => void;
  addPageTriggerRef?: MutableRefObject<HTMLButtonElement | null>;
  onDeletePage: (sceneId: SceneId) => void;
  width: number;
  onWidthChange: (width: number) => void;
  onHide: () => void;
}

function clampRailWidth(width: number): number {
  return Math.min(PDF_RAIL_MAX_WIDTH, Math.max(PDF_RAIL_MIN_WIDTH, Math.round(width)));
}

function thumbnailDataUrl(scene: SerializedScene): string | null {
  if (thumbnailDataUrlCache.has(scene)) return thumbnailDataUrlCache.get(scene) ?? null;
  const backgroundId = scene.pdfPage?.backgroundElementId;
  const background = scene.elements.find((element) => element.id === backgroundId);
  const fileId = background && typeof background.fileId === "string" ? background.fileId : null;
  const dataURL = fileId ? scene.files[fileId]?.dataURL : null;
  const result = typeof dataURL === "string" ? dataURL : null;
  thumbnailDataUrlCache.set(scene, result);
  return result;
}

function annotationCount(scene: SerializedScene): number {
  const cached = annotationCountCache.get(scene);
  if (cached !== undefined) return cached;
  let count = 0;
  for (const element of scene.elements) {
    if (element.id !== scene.pdfPage?.backgroundElementId && element.isDeleted !== true) count += 1;
  }
  annotationCountCache.set(scene, count);
  return count;
}

export function PdfPageRail({
  project,
  pages,
  activeSceneId,
  thumbnailDataUrls,
  onOpenPage,
  onMovePage,
  onShiftPage,
  onAddBlankPage,
  onInsertPdfPages,
  addPageTriggerRef,
  onDeletePage,
  width,
  onWidthChange,
  onHide,
}: PdfPageRailProps) {
  const [draggingId, setDraggingId] = useState<SceneId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: SceneId; edge: PdfPageDropEdge } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ pointerId: number; clientX: number; width: number } | null>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      addMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const closeFromOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (addMenuRef.current?.contains(target) || addButtonRef.current?.contains(target)) return;
      setAddMenuOpen(false);
    };
    const closeFromEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setAddMenuOpen(false);
      window.requestAnimationFrame(() => addButtonRef.current?.focus());
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    window.addEventListener("keydown", closeFromEscape, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeFromOutside, true);
      window.removeEventListener("keydown", closeFromEscape, true);
    };
  }, [addMenuOpen]);

  function handleAddMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      if (event.key === "Tab") setAddMenuOpen(false);
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % items.length;
    items[nextIndex].focus();
  }

  function dragEdge(event: DragEvent<HTMLLIElement>): PdfPageDropEdge {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    let nextWidth = width;
    if (event.key === "ArrowLeft") nextWidth -= event.shiftKey ? 40 : 16;
    else if (event.key === "ArrowRight") nextWidth += event.shiftKey ? 40 : 16;
    else if (event.key === "Home") nextWidth = PDF_RAIL_MIN_WIDTH;
    else if (event.key === "End") nextWidth = PDF_RAIL_MAX_WIDTH;
    else return;
    event.preventDefault();
    onWidthChange(clampRailWidth(nextWidth));
  }

  return (
    <aside id="pdf-page-rail" className="slide-rail pdf-page-rail" aria-label="PDF pages">
      <div className="rail-heading pdf-rail-heading">
        <div>
          <span className="rail-kicker">Document</span>
          <h2>PDF pages</h2>
        </div>
        <div className="pdf-rail-heading-actions">
          <span className="pdf-page-total" aria-label={`${pages.length} PDF pages`}>{pages.length}</span>
          <button className="icon-button pdf-rail-hide" type="button" onClick={onHide} aria-label="Hide PDF pages" title="Hide PDF pages">
            <HidePanelIcon />
          </button>
        </div>
      </div>
      <p className="pdf-rail-help">Drag pages to reorder them. Export follows this order.</p>
      <ol className="rail-scroll pdf-page-list">
        {pages.map((scene, index) => {
          const workspace = scene.pdfPage;
          if (!workspace) return null;
          const source = project.pdfDocuments[workspace.documentId];
          const darkThumbnail = thumbnailDataUrls?.[scene.id];
          const thumbnail = darkThumbnail || thumbnailDataUrl(scene);
          const notes = annotationCount(scene);
          const sourceName = workspace.sourceName || source?.name || "Imported PDF";
          const isBlankPage = sourceName === "Blank page";
          const label = isBlankPage
            ? "Blank page"
            : `${sourceName}, original page ${workspace.pageIndex + 1}`;
          const targetClass = dropTarget?.id === scene.id ? ` is-drop-${dropTarget.edge}` : "";
          return (
            <li
              key={scene.id}
              className={`pdf-page-item${scene.id === activeSceneId ? " is-selected" : ""}${targetClass}`}
              onDragOver={(event) => {
                if (!draggingId || draggingId === scene.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({ id: scene.id, edge: dragEdge(event) });
              }}
              onDrop={(event) => {
                event.preventDefault();
                const movingId = event.dataTransfer.getData(PDF_PAGE_DRAG_TYPE)
                  || event.dataTransfer.getData("text/plain")
                  || draggingId;
                const edge = dragEdge(event);
                if (movingId && movingId !== scene.id) {
                  onMovePage(movingId, scene.id, edge);
                  setAnnouncement(`Moved a PDF page ${edge} output page ${index + 1}.`);
                }
                setDraggingId(null);
                setDropTarget(null);
              }}
            >
              <button
                className="pdf-page-open"
                type="button"
                aria-current={scene.id === activeSceneId ? "page" : undefined}
                aria-label={`Open output page ${index + 1}: ${label}`}
                onClick={() => onOpenPage(scene.id)}
              >
                <span className="pdf-output-position">{index + 1}</span>
                <span className="page-sheet">
                  {thumbnail
                    ? <img className={darkThumbnail ? "pdf-page-dark-thumbnail" : undefined} src={thumbnail} alt="" loading="lazy" decoding="async" />
                    : <span className="page-lines" />}
                  {notes > 0 ? <span className="pdf-annotation-count">{notes}</span> : null}
                </span>
                <span className="pdf-page-label">
                  <strong>{isBlankPage ? "Blank page" : sourceName}</strong>
                  <span>{isBlankPage ? "Added page" : `Original page ${workspace.pageIndex + 1}`}</span>
                </span>
              </button>
              {scene.id === activeSceneId ? (
                <button
                  className="thumbnail-delete-button pdf-page-delete"
                  type="button"
                  aria-label="Delete selected page"
                  title="Delete selected page"
                  onClick={() => onDeletePage(scene.id)}
                >
                  <TrashIcon />
                </button>
              ) : null}
              <div className="pdf-page-actions" aria-label={`Actions for output page ${index + 1}`}>
                <button
                  type="button"
                  disabled={index === 0}
                  aria-label={`Move output page ${index + 1} earlier`}
                  title="Move earlier"
                  onClick={() => {
                    onShiftPage(scene.id, -1);
                    setAnnouncement(`Moved ${label} to output position ${index}.`);
                  }}
                >
                  <UpIcon />
                </button>
                <span
                  className="pdf-drag-handle"
                  draggable
                  title="Drag to reorder"
                  onDragStart={(event) => {
                    setDraggingId(scene.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(PDF_PAGE_DRAG_TYPE, scene.id);
                    event.dataTransfer.setData("text/plain", scene.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropTarget(null);
                  }}
                >
                  <DragIcon />
                </span>
                <button
                  type="button"
                  disabled={index === pages.length - 1}
                  aria-label={`Move output page ${index + 1} later`}
                  title="Move later"
                  onClick={() => {
                    onShiftPage(scene.id, 1);
                    setAnnouncement(`Moved ${label} to output position ${index + 2}.`);
                  }}
                >
                  <DownIcon />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="pdf-rail-actions">
        <button
          ref={(button) => {
            addButtonRef.current = button;
            if (addPageTriggerRef) addPageTriggerRef.current = button;
          }}
          className={`pdf-add-page ${addMenuOpen ? "is-open" : ""}`}
          type="button"
          aria-label="Add page"
          title="Add page"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          aria-controls="pdf-add-page-menu"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setAddMenuOpen(true);
          }}
          onClick={() => setAddMenuOpen((open) => !open)}
        >
          <PlusIcon /><span className="icon-label">Add page</span><ChevronDownIcon className="pdf-add-page-chevron" />
        </button>
        {addMenuOpen ? (
          <div
            id="pdf-add-page-menu"
            ref={addMenuRef}
            className="pdf-add-page-menu"
            role="menu"
            aria-label="Add page"
            onKeyDown={handleAddMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAddMenuOpen(false);
                onAddBlankPage();
                window.requestAnimationFrame(() => addButtonRef.current?.focus());
              }}
            ><PlusIcon /><span><strong>Blank page</strong><small>Add an empty writing page</small></span></button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAddMenuOpen(false);
                onInsertPdfPages();
              }}
            ><PdfIcon /><span><strong>Insert PDF pages…</strong><small>Choose one or more PDFs</small></span></button>
          </div>
        ) : null}
      </div>
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
      <div
        className="pdf-rail-resize-handle"
        role="separator"
        aria-label="Resize PDF pages"
        aria-orientation="vertical"
        aria-valuemin={PDF_RAIL_MIN_WIDTH}
        aria-valuemax={PDF_RAIL_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize PDF pages"
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => onWidthChange(PDF_RAIL_DEFAULT_WIDTH)}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          resizeStartRef.current = { pointerId: event.pointerId, clientX: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          const start = resizeStartRef.current;
          if (!start || start.pointerId !== event.pointerId) return;
          onWidthChange(clampRailWidth(start.width + event.clientX - start.clientX));
        }}
        onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
          if (resizeStartRef.current?.pointerId === event.pointerId) resizeStartRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { resizeStartRef.current = null; }}
      />
    </aside>
  );
}
