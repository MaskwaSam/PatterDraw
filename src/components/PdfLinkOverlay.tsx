import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import { hitElementBoundText, hitElementItself } from "@excalidraw/element";
import type { ExcalidrawElement as GeometryElement } from "@excalidraw/element/types";
import { DEFAULT_COLLISION_THRESHOLD } from "@excalidraw/common";
import { pointFrom, type GlobalPoint } from "@excalidraw/math";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { PdfPageWorkspace } from "../types";
import type { PdfPageLink } from "../lib/pdf/page-links";
import { rotatePdfPagePoint } from "../lib/pdf/page-rotation";
import { openPdfWebLink } from "../lib/offline-network";

interface Props {
  api: ExcalidrawImperativeAPI;
  workspace: PdfPageWorkspace;
  bytes: Uint8Array;
  enabled: boolean;
}

/** Display-only links never enter Excalidraw, project history, or exported artwork. */
export function PdfLinkOverlay({ api, workspace, bytes, enabled }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<PdfPageLink[]>([]);
  const { width, height, viewRotation = 0, backgroundElementId } = workspace;

  useEffect(() => {
    const controller = new AbortController();
    setLinks([]);
    void import("../lib/pdf/page-links")
      .then(({ extractPdfPageLinks }) => extractPdfPageLinks(bytes, workspace.pageIndex, { signal: controller.signal }))
      .then((result) => { if (!controller.signal.aborted) setLinks(result); })
      .catch(() => { /* Unreadable annotations must not interrupt the imported page. */ });
    return () => controller.abort();
  }, [bytes, workspace.pageIndex]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host) return;
    let spaceDown = false;
    let gesture: { pointerId: number; x: number; y: number; link: PdfPageLink } | null = null;
    let hoveredCanvas: HTMLCanvasElement | null = null;
    const clearHover = () => {
      hoveredCanvas?.classList.remove("is-pdf-link-hovered");
      hoveredCanvas = null;
    };
    const available = () => {
      const state = api.getAppState();
      return enabled && !spaceDown && state.activeTool.type === "selection"
        && !state.editingTextElement && !state.resizingElement
        && !state.openDialog && !state.selectedElementsAreBeingDragged;
    };
    const bounds = links.map((link) => {
      const a = rotatePdfPagePoint([link.x, link.y], width, height, viewRotation);
      const b = rotatePdfPagePoint([link.x + link.width, link.y + link.height], width, height, viewRotation);
      return { link, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
    });
    const sync = () => {
      const active = available();
      root.hidden = !active;
      if (!active) clearHover();
      const state = api.getAppState();
      const hostRect = host.getBoundingClientRect();
      bounds.forEach((rect, index) => {
        const button = root.children[index] as HTMLElement | undefined;
        if (!button) return;
        const p = sceneCoordsToViewportCoords({ sceneX: rect.x, sceneY: rect.y }, state);
        button.style.left = `${p.x - hostRect.left}px`;
        button.style.top = `${p.y - hostRect.top}px`;
        button.style.width = `${rect.width * state.zoom.value}px`;
        button.style.height = `${rect.height * state.zoom.value}px`;
      });
    };
    const hit = (event: MouseEvent) => {
      if (!available() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
      if (!(event.target instanceof HTMLCanvasElement) || !host.contains(event.target)) return null;
      const state = api.getAppState();
      const p = viewportCoordsToSceneCoords(event, state);
      const rect = bounds.find((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);
      if (!rect) return null;
      // Only actual shapes and labels cover links, not empty space in their bounds.
      // Like the lasso adapter, use the pinned geometry package read-only with
      // stable-editor elements; their binding metadata types differ.
      const elements = api.getSceneElements() as unknown as readonly GeometryElement[];
      const elementsMap = new Map(elements.map((element) => [element.id, element]));
      const point = pointFrom<GlobalPoint>(p.x, p.y);
      const threshold = DEFAULT_COLLISION_THRESHOLD / state.zoom.value;
      const covered = elements.some((element) => {
        if (element.id === backgroundElementId || element.isDeleted) return false;
        if (element.type === "text" && element.containerId) return false;
        return hitElementItself({ point, element, threshold, elementsMap })
          || hitElementBoundText(point, element, elementsMap);
      });
      return covered ? null : rect.link;
    };
    const down = (event: PointerEvent) => {
      clearHover();
      if (gesture || !event.isPrimary || event.button !== 0) { gesture = null; return; }
      const link = hit(event);
      gesture = link ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, link } : null;
    };
    const move = (event: PointerEvent) => {
      if (gesture && (event.pointerId !== gesture.pointerId || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5)) gesture = null;
      clearHover();
      if (!event.buttons && hit(event)) {
        hoveredCanvas = event.target as HTMLCanvasElement;
        hoveredCanvas.classList.add("is-pdf-link-hovered");
      }
    };
    const cancel = () => { gesture = null; clearHover(); };
    const click = (event: MouseEvent) => {
      const pending = gesture;
      gesture = null;
      if (!pending || !available() || event.button !== 0 || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 5) return;
      if (hit(event) !== pending.link) return;
      event.preventDefault();
      event.stopPropagation();
      openPdfWebLink(pending.link.url, event);
    };
    const key = (event: KeyboardEvent) => {
      if (event.code === "Space") { spaceDown = event.type === "keydown"; cancel(); sync(); }
    };
    const blur = () => { spaceDown = false; cancel(); sync(); };
    const unsubscribe = api.onChange(sync);
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    host.addEventListener("pointerdown", down, true);
    host.addEventListener("pointermove", move, true);
    host.addEventListener("pointercancel", cancel, true);
    host.addEventListener("pointerleave", cancel);
    host.addEventListener("click", click, true);
    host.addEventListener("wheel", cancel, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    window.addEventListener("blur", blur);
    sync();
    return () => {
      unsubscribe(); observer.disconnect(); cancel();
      host.removeEventListener("pointerdown", down, true);
      host.removeEventListener("pointermove", move, true);
      host.removeEventListener("pointercancel", cancel, true);
      host.removeEventListener("pointerleave", cancel);
      host.removeEventListener("click", click, true);
      host.removeEventListener("wheel", cancel, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
      window.removeEventListener("blur", blur);
    };
  }, [api, links, width, height, viewRotation, backgroundElementId, enabled]);

  return <div ref={rootRef} className="pdf-link-overlay" data-testid="pdf-link-overlay" hidden>
    {links.map((link, index) => <button
      key={index}
      type="button"
      className="pdf-page-link"
      title={`Open ${new URL(link.url).hostname} in a new tab`}
      aria-label={`Open PDF link ${index + 1}: ${new URL(link.url).hostname} (new tab)`}
      data-pdf-link-url={link.url}
      onClick={(event) => {
        // Pointer clicks pass through to the live canvas; this handles keyboard activation.
        if (enabled && api.getAppState().activeTool.type === "selection" && event.detail === 0) {
          event.stopPropagation();
          openPdfWebLink(link.url, event.nativeEvent);
        }
      }}
    />)}
  </div>;
}
