import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SerializedScene } from "../types";
import { renderSlideThumbnail } from "../lib/slide-thumbnail";
import { slidePreviewRevision } from "../lib/slide-render";
import { FrameIcon } from "./Icons";

interface SlidePreviewProps {
  scene: SerializedScene | undefined;
  frameId: string;
}

const PREVIEW_DEBOUNCE_MS = 180;
const PREVIEW_LOAD_MARGIN = "180px 0px";

interface RevisionCache {
  elements: SerializedScene["elements"];
  files: SerializedScene["files"];
  frameId: string;
  revision: string | null;
  scene: SerializedScene;
}

export const SlidePreview = memo(function SlidePreview({ scene, frameId }: SlidePreviewProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const revisionCacheRef = useRef<RevisionCache | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const revision = useMemo(() => {
    if (!isNearViewport || !scene) return null;
    const cached = revisionCacheRef.current;
    if (
      cached
      && cached.scene === scene
      && cached.elements === scene.elements
      && cached.files === scene.files
      && cached.frameId === frameId
    ) {
      return cached.revision;
    }
    const next = slidePreviewRevision(scene, frameId);
    revisionCacheRef.current = {
      elements: scene.elements,
      files: scene.files,
      frameId,
      revision: next,
      scene,
    };
    return next;
  }, [frameId, isNearViewport, scene]);

  useEffect(() => {
    const cached = revisionCacheRef.current;
    if (
      cached
      && (
        cached.scene !== scene
        || cached.elements !== scene?.elements
        || cached.files !== scene?.files
        || cached.frameId !== frameId
      )
    ) {
      revisionCacheRef.current = null;
    }
  }, [frameId, scene]);

  const replaceObjectUrl = useCallback((next: string | null) => {
    const previous = objectUrlRef.current;
    objectUrlRef.current = next;
    setSource(next);
    if (previous && previous !== next) URL.revokeObjectURL(previous);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsNearViewport(entry?.isIntersecting === true);
    }, {
      root: host.closest(".rail-scroll"),
      rootMargin: PREVIEW_LOAD_MARGIN,
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport || !scene || !revision) {
      requestRef.current += 1;
      setIsLoading(false);
      replaceObjectUrl(null);
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
  }, [frameId, isNearViewport, replaceObjectUrl, revision, scene?.id]);

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
});
