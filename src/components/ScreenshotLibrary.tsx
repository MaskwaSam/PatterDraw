import { useEffect, useMemo } from "react";
import type { StoredScreenshot } from "../lib/screenshots/persistence";
import { ScreenshotIcon } from "./Icons";

export const SCREENSHOT_SIDEBAR_TAB = "screenshots";
export const SCREENSHOT_DRAG_MIME = "application/x-patterdraw-screenshot";

const captureTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface ScreenshotThumbnailProps {
  item: StoredScreenshot;
  onInsert: (item: StoredScreenshot) => void;
}

function ScreenshotThumbnail({ item, onInsert }: ScreenshotThumbnailProps) {
  const imageUrl = useMemo(() => URL.createObjectURL(item.blob), [item.blob]);
  useEffect(() => () => URL.revokeObjectURL(imageUrl), [imageUrl]);
  const captured = captureTimeFormatter.format(new Date(item.createdAt));
  return (
    <button
      type="button"
      className="screenshot-card-thumbnail"
      aria-label={`Insert screenshot captured ${captured}`}
      title="Click to insert. On desktop, drag onto the canvas to place it."
      draggable
      onClick={() => onInsert(item)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(SCREENSHOT_DRAG_MIME, item.id);
        event.dataTransfer.setData("text/plain", item.id);
      }}
    >
      <img src={imageUrl} alt="" draggable={false} />
      <span>{item.width} × {item.height} px</span>
    </button>
  );
}

interface ScreenshotLibraryProps {
  busy: boolean;
  loading: boolean;
  items: readonly StoredScreenshot[];
  onCaptureArea: () => void;
  onCopy: (item: StoredScreenshot) => void;
  onDelete: (item: StoredScreenshot) => void;
  onDownload: (item: StoredScreenshot) => void;
  onInsert: (item: StoredScreenshot) => void;
}

export function ScreenshotLibrary({
  busy,
  loading,
  items,
  onCaptureArea,
  onCopy,
  onDelete,
  onDownload,
  onInsert,
}: ScreenshotLibraryProps) {
  return (
    <section className="screenshot-library" aria-label="Screenshot Library">
      <div className="screenshot-library-heading">
        <div>
          <h2>Screenshot Library</h2>
          <p>Capture canvas content and reuse it on any local project.</p>
        </div>
        <button
          type="button"
          className="screenshot-capture-button"
          onClick={onCaptureArea}
          disabled={busy}
        >
          <ScreenshotIcon />
          {busy ? "Capturing…" : "Capture area"}
        </button>
      </div>
      {loading ? (
        <p className="screenshot-library-message" role="status">Opening saved screenshots…</p>
      ) : items.length === 0 ? (
        <div className="screenshot-library-empty">
          <ScreenshotIcon />
          <strong>No screenshots yet</strong>
          <p>Capture part of this canvas to copy it and keep it available on this device.</p>
        </div>
      ) : (
        <ul className="screenshot-card-list" aria-label="Saved screenshots">
          {items.map((item) => {
            const captured = captureTimeFormatter.format(new Date(item.createdAt));
            return (
              <li className="screenshot-card" key={item.id} data-screenshot-id={item.id}>
                <ScreenshotThumbnail item={item} onInsert={onInsert} />
                <div className="screenshot-card-meta">
                  <time dateTime={new Date(item.createdAt).toISOString()}>{captured}</time>
                  <div className="screenshot-card-actions">
                    <button type="button" onClick={() => onCopy(item)} aria-label={`Copy screenshot captured ${captured}`}>Copy</button>
                    <button type="button" onClick={() => onDownload(item)} aria-label={`Download screenshot captured ${captured}`}>Download</button>
                    <button type="button" onClick={() => onDelete(item)} aria-label={`Delete screenshot captured ${captured}`}>Delete</button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
