import { memo, useEffect, useRef, useState } from "react";
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

const SCREENSHOT_LOAD_MARGIN = "240px 0px";

const ScreenshotThumbnail = memo(function ScreenshotThumbnail({
  item,
  onInsert,
}: ScreenshotThumbnailProps) {
  const hostRef = useRef<HTMLButtonElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsNearViewport(entry?.isIntersecting === true);
    }, {
      root: host.closest(".screenshot-library"),
      rootMargin: SCREENSHOT_LOAD_MARGIN,
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport) {
      setImageUrl(null);
      return;
    }

    const next = URL.createObjectURL(item.blob);
    setImageUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [isNearViewport, item.blob]);

  const captured = captureTimeFormatter.format(new Date(item.createdAt));
  return (
    <button
      ref={hostRef}
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
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="screenshot-card-image-placeholder" aria-hidden="true">
          <ScreenshotIcon />
        </span>
      )}
      <span className="screenshot-card-dimensions">{item.width} × {item.height} px</span>
    </button>
  );
});

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
          aria-label={loading ? "Opening saved screenshots" : busy ? "Capturing area" : "Capture area"}
          title={loading ? "Opening saved screenshots" : busy ? "Capturing area" : "Capture area"}
          onClick={onCaptureArea}
          disabled={busy || loading}
        >
          <ScreenshotIcon />
          <span className="icon-label">{loading ? "Opening…" : busy ? "Capturing…" : "Capture area"}</span>
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
                    <button type="button" onClick={() => onCopy(item)} disabled={busy} aria-label={`Copy screenshot captured ${captured}`}>Copy</button>
                    <button type="button" onClick={() => onDownload(item)} disabled={busy} aria-label={`Download screenshot captured ${captured}`}>Download</button>
                    <button type="button" onClick={() => onDelete(item)} disabled={busy} aria-label={`Delete screenshot captured ${captured}`}>Delete</button>
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
