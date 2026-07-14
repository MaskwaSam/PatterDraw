import { useCallback, useEffect, useRef, useState } from "react";
import type { SerializedScene } from "../types";
import { renderSlideThumbnail } from "../lib/slide-thumbnail";
import { slidePreviewRevision } from "../lib/slide-render";
import { FrameIcon } from "./Icons";

interface SlidePreviewProps {
  scene: SerializedScene | undefined;
  frameId: string;
}

const PREVIEW_DEBOUNCE_MS = 180;

export function SlidePreview({ scene, frameId }: SlidePreviewProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const [isVisible, setIsVisible] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const revision = scene ? slidePreviewRevision(scene, frameId) : null;

  const replaceObjectUrl = useCallback((next: string | null) => {
    const previous = objectUrlRef.current;
    objectUrlRef.current = next;
    setSource(next);
    if (previous && previous !== next) URL.revokeObjectURL(previous);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "180px 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || !scene || !revision) {
      if (isVisible && (!scene || !revision)) replaceObjectUrl(null);
      return;
    }

    const requestId = ++requestRef.current;
    let cancelled = false;
    setIsLoading(true);

    const timer = window.setTimeout(() => {
      void renderSlideThumbnail(scene, frameId)
        .then((blob) => {
          if (cancelled || requestRef.current !== requestId) return;
          if (!blob) {
            replaceObjectUrl(null);
            return;
          }

          const next = URL.createObjectURL(blob);
          if (cancelled || requestRef.current !== requestId) {
            URL.revokeObjectURL(next);
            return;
          }
          replaceObjectUrl(next);
        })
        .catch(() => {
          if (!cancelled && requestRef.current === requestId) replaceObjectUrl(null);
        })
        .finally(() => {
          if (!cancelled && requestRef.current === requestId) setIsLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  // `revision` already captures every frame-local element/file change. Avoid
  // regenerating all previews when unrelated project or viewport state changes.
  }, [frameId, isVisible, replaceObjectUrl, revision, scene?.id]);

  useEffect(() => () => {
    requestRef.current += 1;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  return (
    <span
      ref={hostRef}
      className={`slide-preview${isLoading ? " is-loading" : ""}`}
      data-preview-revision={revision || undefined}
    >
      {source ? (
        <img src={source} alt="" draggable={false} decoding="async" />
      ) : (
        <span className="slide-preview-placeholder" aria-hidden="true">
          <FrameIcon />
        </span>
      )}
    </span>
  );
}
