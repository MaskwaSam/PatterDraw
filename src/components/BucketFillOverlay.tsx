import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  DEFAULT_BUCKET_FILL_COLOR,
  effectiveBucketFillColor,
  effectiveBucketFillOpacity,
  effectiveBucketFillStyle,
} from "../lib/bucket-fill/settings";

export const CLASSROOM_BUCKET_FILL_TOOL = "classroom-bucket-fill";

const COLOR_PICKS = ["#ffffff", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"] as const;

interface BucketFillOverlayProps {
  api: ExcalidrawImperativeAPI;
  editorHost: HTMLDivElement;
  onExit: () => void;
  onFill: (point: { x: number; y: number }) => Promise<void>;
}

type ArmedFill = {
  pointerId: number;
  scenePoint: { x: number; y: number };
};

function isBucketFillTool(tool: ReturnType<ExcalidrawImperativeAPI["getAppState"]>["activeTool"]): boolean {
  return tool.type === "custom" && tool.customType === CLASSROOM_BUCKET_FILL_TOOL;
}

function colorInputValue(color: string): string {
  const effective = effectiveBucketFillColor(color);
  return /^#[0-9a-f]{6}$/i.test(effective) ? effective : DEFAULT_BUCKET_FILL_COLOR;
}

export function BucketFillOverlay({ api, editorHost, onExit, onFill }: BucketFillOverlayProps) {
  const initialState = api.getAppState();
  const [backgroundColor, setBackgroundColor] = useState(
    effectiveBucketFillColor(initialState.currentItemBackgroundColor),
  );
  const [fillStyle, setFillStyle] = useState<ExcalidrawElement["fillStyle"]>(
    effectiveBucketFillStyle(initialState.currentItemFillStyle),
  );
  const [opacity, setOpacity] = useState(
    effectiveBucketFillOpacity(initialState.currentItemOpacity),
  );
  const armedRef = useRef<ArmedFill | null>(null);
  const activeTouchPointersRef = useRef(new Set<number>());
  const gestureAbortedRef = useRef(false);
  const busyRef = useRef(false);

  const updateStyle = (updates: {
    currentItemBackgroundColor?: string;
    currentItemFillStyle?: ExcalidrawElement["fillStyle"];
    currentItemOpacity?: number;
  }) => {
    const current = api.getAppState();
    api.updateScene({
      appState: {
        currentItemBackgroundColor: effectiveBucketFillColor(
          updates.currentItemBackgroundColor ?? current.currentItemBackgroundColor,
        ),
        currentItemFillStyle: effectiveBucketFillStyle(
          updates.currentItemFillStyle ?? current.currentItemFillStyle,
        ),
        currentItemOpacity: effectiveBucketFillOpacity(
          updates.currentItemOpacity ?? current.currentItemOpacity,
        ),
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  useEffect(() => {
    editorHost.classList.add("is-bucket-fill-active");
    api.setCursor("crosshair");

    const cancelGesture = () => {
      armedRef.current = null;
      gestureAbortedRef.current = true;
    };

    const resetInteraction = () => {
      armedRef.current = null;
      activeTouchPointersRef.current.clear();
      gestureAbortedRef.current = false;
    };

    // Observe pointer membership without consuming the event. Excalidraw must
    // receive the original stream so its shared pinch/pan/long-press lifecycle
    // keeps working while this wrapper-owned custom tool is selected.
    const observePointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0
        || event.pointerType !== "touch"
        || !(event.target instanceof HTMLCanvasElement)
      ) return;
      if (event.isPrimary) {
        // A primary touch begins a new browser gesture. Clear any pointer IDs
        // left behind when the previous gesture lost its pointer-up event.
        activeTouchPointersRef.current.clear();
        gestureAbortedRef.current = false;
      }
      activeTouchPointersRef.current.add(event.pointerId);
      if (activeTouchPointersRef.current.size > 1) {
        cancelGesture();
      }
    };

    const observePointerRelease = (event: PointerEvent) => {
      activeTouchPointersRef.current.delete(event.pointerId);
      if (event.type === "pointercancel") cancelGesture();
      if (activeTouchPointersRef.current.size === 0) {
        // Excalidraw installs its pointer-up listener after pointer-down. Keep
        // the abort flag through this event dispatch, then reset for the next
        // independent gesture.
        queueMicrotask(() => {
          if (activeTouchPointersRef.current.size === 0) {
            gestureAbortedRef.current = false;
          }
        });
      }
    };

    const unsubscribePointerDown = api.onPointerDown((activeTool, pointerDownState, event) => {
      if (!isBucketFillTool(activeTool) || gestureAbortedRef.current || busyRef.current) return;
      armedRef.current = {
        pointerId: event.pointerId,
        scenePoint: {
          x: pointerDownState.origin.x,
          y: pointerDownState.origin.y,
        },
      };
    });

    const unsubscribePointerUp = api.onPointerUp((activeTool, _pointerDownState, event) => {
      const armed = armedRef.current;
      if (event.type !== "pointerup") {
        // Excalidraw invokes this callback with the next pointer-down when it
        // recovers a missing pointer-up. That event is cleanup only, and its
        // pointer ID may differ from the stale gesture's ID.
        armedRef.current = null;
        return;
      }
      const shouldFill =
        armed?.pointerId === event.pointerId
        && isBucketFillTool(activeTool)
        && !gestureAbortedRef.current;
      if (armed?.pointerId === event.pointerId) armedRef.current = null;
      if (!shouldFill || busyRef.current) return;
      busyRef.current = true;
      void onFill(armed.scenePoint).finally(() => {
        busyRef.current = false;
      });
    });

    const handleLostPointerCapture = () => resetInteraction();
    const handleContextMenu = () => cancelGesture();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") resetInteraction();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      api.setActiveTool({ type: "selection", locked: false });
      onExit();
    };

    editorHost.addEventListener("pointerdown", observePointerDown, { capture: true, passive: true });
    window.addEventListener("pointerup", observePointerRelease, { capture: true, passive: true });
    window.addEventListener("pointercancel", observePointerRelease, { capture: true, passive: true });
    editorHost.addEventListener("lostpointercapture", handleLostPointerCapture, true);
    editorHost.addEventListener("contextmenu", handleContextMenu, true);
    window.addEventListener("blur", resetInteraction);
    window.addEventListener("pagehide", resetInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    editorHost.addEventListener("keydown", handleKeyDown, true);
    return () => {
      editorHost.classList.remove("is-bucket-fill-active");
      unsubscribePointerDown();
      unsubscribePointerUp();
      editorHost.removeEventListener("pointerdown", observePointerDown, true);
      window.removeEventListener("pointerup", observePointerRelease, true);
      window.removeEventListener("pointercancel", observePointerRelease, true);
      editorHost.removeEventListener("lostpointercapture", handleLostPointerCapture, true);
      editorHost.removeEventListener("contextmenu", handleContextMenu, true);
      window.removeEventListener("blur", resetInteraction);
      window.removeEventListener("pagehide", resetInteraction);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      editorHost.removeEventListener("keydown", handleKeyDown, true);
      resetInteraction();
      api.resetCursor();
    };
  }, [api, editorHost, onExit, onFill]);

  return (
    <div
      className="bucket-fill-settings"
      role="toolbar"
      aria-label="Bucket fill settings"
      data-testid="bucket-fill-settings"
    >
      <strong>Bucket fill</strong>
      <div className="bucket-fill-color-picks" role="group" aria-label="Fill colour">
        {COLOR_PICKS.map((color) => (
          <button
            key={color}
            type="button"
            className={backgroundColor.toLowerCase() === color ? "is-selected" : ""}
            aria-label={`Use ${color}`}
            aria-pressed={backgroundColor.toLowerCase() === color}
            style={{ backgroundColor: color }}
            onClick={() => {
              setBackgroundColor(color);
              updateStyle({ currentItemBackgroundColor: color });
            }}
          />
        ))}
        <label className="bucket-fill-custom-color" title="Custom fill colour">
          <span className="sr-only">Custom fill colour</span>
          <input
            type="color"
            aria-label="Custom fill colour"
            value={colorInputValue(backgroundColor)}
            onChange={(event) => {
              setBackgroundColor(event.target.value);
              updateStyle({ currentItemBackgroundColor: event.target.value });
            }}
          />
        </label>
      </div>
      <label>
        <span>Style</span>
        <select
          aria-label="Bucket fill style"
          value={fillStyle}
          onChange={(event) => {
            const next = event.target.value as ExcalidrawElement["fillStyle"];
            setFillStyle(next);
            updateStyle({ currentItemFillStyle: next });
          }}
        >
          <option value="solid">Solid</option>
          <option value="hachure">Hachure</option>
          <option value="cross-hatch">Cross-hatch</option>
          <option value="zigzag">Zigzag</option>
        </select>
      </label>
      <label className="bucket-fill-opacity">
        <span>Opacity {opacity}%</span>
        <input
          type="range"
          aria-label="Bucket fill opacity"
          min="10"
          max="100"
          step="10"
          value={opacity}
          onChange={(event) => {
            const next = Number(event.target.value);
            setOpacity(next);
            updateStyle({ currentItemOpacity: next });
          }}
        />
      </label>
      <button
        type="button"
        className="bucket-fill-done"
        onClick={() => {
          api.setActiveTool({ type: "selection", locked: false });
          onExit();
        }}
      >
        Done
      </button>
    </div>
  );
}
