import { useEffect, useRef } from "react";
import {
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { isEditableKeyboardTarget } from "../lib/keyboard-targets";
import type { LassoGeometrySnapshot, LassoPoint } from "../lib/lasso/stable-element-adapter";
import { resolveLassoSelection, type LassoSelection } from "../lib/lasso/selection";
import { lassoViewportToScenePoint } from "../lib/lasso/coordinates";

export const CLASSROOM_LASSO_TOOL = "classroom-lasso";
const MINIMUM_GESTURE_SIZE_PX = 4;

interface LassoOverlayProps {
  api: ExcalidrawImperativeAPI;
  createGeometrySnapshot: (elements: readonly ExcalidrawElement[]) => LassoGeometrySnapshot;
  editorHost: HTMLDivElement;
  initialSelection: LassoInitialSelection;
  onExit: () => void;
}

export interface LassoInitialSelection extends LassoSelection {
  editingGroupId: string | null;
}

interface ActiveGesture {
  additive: boolean;
  geometry: LassoGeometrySnapshot;
  pointerId: number;
  previousSelection: LassoInitialSelection;
  scenePoints: LassoPoint[];
  viewportPoints: LassoPoint[];
}

export function lassoSelectionSnapshot(appState: AppState): LassoInitialSelection {
  return {
    selectedElementIds: Object.fromEntries(
      Object.entries(appState.selectedElementIds).filter(([, selected]) => selected),
    ) as Record<string, true>,
    selectedGroupIds: Object.fromEntries(
      Object.entries(appState.selectedGroupIds).filter(([, selected]) => selected),
    ) as Record<string, true>,
    editingGroupId: appState.editingGroupId,
  };
}

function pathData(points: readonly LassoPoint[]): string {
  if (!points.length) return "";
  const commands = points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)} ${point[1].toFixed(1)}`);
  if (points.length > 2) commands.push("Z");
  return commands.join(" ");
}

function isSignificantGesture(points: readonly LassoPoint[]): boolean {
  if (points.length < 3) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.max(maxX - minX, maxY - minY) >= MINIMUM_GESTURE_SIZE_PX;
}

export function LassoOverlay({ api, createGeometrySnapshot, editorHost, initialSelection, onExit }: LassoOverlayProps) {
  const pathRef = useRef<SVGPathElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const restoreOnCleanupRef = useRef(true);

  useEffect(() => {
    editorHost.classList.add("is-lasso-active");

    const cancelAnimation = () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };

    const updateTrail = (gesture: ActiveGesture) => {
      pathRef.current?.setAttribute("d", pathData(gesture.viewportPoints));
    };

    const applySelection = (gesture: ActiveGesture) => {
      const appState = api.getAppState();
      const hits = gesture.geometry.getSelectedElementIds(
        gesture.scenePoints,
        5 / appState.zoom.value,
      );
      const selection = resolveLassoSelection(api.getSceneElements(), {
        additive: gesture.additive,
        editingGroupId: gesture.previousSelection.editingGroupId,
        hitElementIds: hits,
        previousSelectedElementIds: gesture.previousSelection.selectedElementIds,
      });
      api.updateScene({
        appState: {
          ...selection,
          selectedLinearElement: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };

    const restoreSelection = (selection: LassoInitialSelection) => {
      api.updateScene({
        appState: {
          selectedElementIds: selection.selectedElementIds,
          selectedGroupIds: selection.selectedGroupIds,
          selectedLinearElement: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };

    const pointForEvent = (event: PointerEvent) => {
      const bounds = editorHost.getBoundingClientRect();
      const scene = lassoViewportToScenePoint(event.clientX, event.clientY, api.getAppState());
      return {
        scene,
        viewport: [event.clientX - bounds.left, event.clientY - bounds.top] as LassoPoint,
      };
    };

    const addPoint = (gesture: ActiveGesture, event: PointerEvent) => {
      const point = pointForEvent(event);
      const previous = gesture.viewportPoints[gesture.viewportPoints.length - 1];
      if (previous && Math.hypot(point.viewport[0] - previous[0], point.viewport[1] - previous[1]) < 1) return;
      gesture.scenePoints.push(point.scene);
      gesture.viewportPoints.push(point.viewport);
      gesture.additive = event.shiftKey;
      updateTrail(gesture);
    };

    const scheduleSelection = (gesture: ActiveGesture) => {
      if (animationFrameRef.current !== null) return;
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        if (gestureRef.current === gesture) applySelection(gesture);
      });
    };

    const finish = (retainSelection: boolean) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      cancelAnimation();
      if (gesture && editorHost.hasPointerCapture?.(gesture.pointerId)) {
        editorHost.releasePointerCapture(gesture.pointerId);
      }
      restoreOnCleanupRef.current = false;
      pathRef.current?.setAttribute("d", "");
      api.resetCursor();
      api.setActiveTool({ type: "selection" });
      if (!retainSelection) restoreSelection(gesture?.previousSelection || initialSelection);
      editorHost.querySelector<HTMLElement>(".excalidraw")?.focus();
      onExit();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof HTMLCanvasElement)) return;
      event.preventDefault();
      event.stopPropagation();
      const point = pointForEvent(event);
      const previousSelection = initialSelection;
      const gesture: ActiveGesture = {
        additive: event.shiftKey,
        geometry: createGeometrySnapshot(api.getSceneElements()),
        pointerId: event.pointerId,
        previousSelection,
        scenePoints: [point.scene],
        viewportPoints: [point.viewport],
      };
      gestureRef.current = gesture;
      try {
        editorHost.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic test events may not register as active browser pointers.
      }
      api.setCursor("crosshair");
      updateTrail(gesture);
      if (!gesture.additive) {
        api.updateScene({
          appState: { selectedElementIds: {}, selectedGroupIds: {}, selectedLinearElement: null },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      addPoint(gesture, event);
      scheduleSelection(gesture);
    };

    const onPointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      addPoint(gesture, event);
      cancelAnimation();
      const significant = isSignificantGesture(gesture.viewportPoints);
      if (significant) applySelection(gesture);
      if (editorHost.hasPointerCapture?.(event.pointerId)) editorHost.releasePointerCapture(event.pointerId);
      finish(significant);
    };

    const onPointerCancel = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };

    editorHost.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
    editorHost.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    editorHost.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
    editorHost.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false });
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      editorHost.classList.remove("is-lasso-active");
      editorHost.removeEventListener("pointerdown", onPointerDown, true);
      editorHost.removeEventListener("pointermove", onPointerMove, true);
      editorHost.removeEventListener("pointerup", onPointerUp, true);
      editorHost.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      cancelAnimation();
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture && editorHost.hasPointerCapture?.(gesture.pointerId)) {
        editorHost.releasePointerCapture(gesture.pointerId);
      }
      if (restoreOnCleanupRef.current) restoreSelection(gesture?.previousSelection || initialSelection);
      api.resetCursor();
    };
  }, [api, createGeometrySnapshot, editorHost, initialSelection, onExit]);

  return (
    <svg
      className="lasso-overlay"
      aria-hidden="true"
      data-testid="lasso-overlay"
      data-initial-selection-count={Object.keys(initialSelection.selectedElementIds).length}
    >
      <path ref={pathRef} />
    </svg>
  );
}
