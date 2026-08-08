import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { BucketFillOverlay, CLASSROOM_BUCKET_FILL_TOOL } from "./BucketFillOverlay";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "NEVER" },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PointerDownCallback = Parameters<ExcalidrawImperativeAPI["onPointerDown"]>[0];
type PointerUpCallback = Parameters<ExcalidrawImperativeAPI["onPointerUp"]>[0];

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

function pointerEvent(
  type: string,
  pointerId: number,
  pointerType = "touch",
  isPrimary = pointerId === 1,
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    isPrimary: { value: isPrimary },
    button: { value: 0 },
    buttons: { value: type === "pointerup" || type === "pointercancel" ? 0 : 1 },
  });
  return event as PointerEvent;
}

function mountOverlay() {
  const container = document.createElement("div");
  const editorHost = document.createElement("div");
  const canvas = document.createElement("canvas");
  editorHost.append(canvas);
  document.body.append(editorHost, container);

  let pointerDown: PointerDownCallback | null = null;
  let pointerUp: PointerUpCallback | null = null;
  const onFill = vi.fn(() => Promise.resolve());
  const onExit = vi.fn();
  const setActiveTool = vi.fn();
  const activeTool = {
    type: "custom" as const,
    customType: CLASSROOM_BUCKET_FILL_TOOL,
    locked: false,
    lastActiveTool: null,
  };
  const api = {
    getAppState: () => ({
      activeTool,
      currentItemBackgroundColor: "#ffec99",
      currentItemFillStyle: "solid",
      currentItemOpacity: 100,
    }),
    setCursor: vi.fn(),
    resetCursor: vi.fn(),
    setActiveTool,
    updateScene: vi.fn(),
    onPointerDown: (callback: PointerDownCallback) => {
      pointerDown = callback;
      return () => { pointerDown = null; };
    },
    onPointerUp: (callback: PointerUpCallback) => {
      pointerUp = callback;
      return () => { pointerUp = null; };
    },
  } as unknown as ExcalidrawImperativeAPI;
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(BucketFillOverlay, {
    api,
    editorHost,
    onExit,
    onFill,
  })));

  const arm = (
    pointerId: number,
    x: number,
    y: number,
    pointerType = "touch",
    isPrimary = pointerId === 1,
  ) => {
    const event = pointerEvent("pointerdown", pointerId, pointerType, isPrimary);
    canvas.dispatchEvent(event);
    pointerDown?.(activeTool, { origin: { x, y } } as Parameters<PointerDownCallback>[1], event as never);
    return event;
  };
  const release = (pointerId: number) => {
    const event = pointerEvent("pointerup", pointerId);
    window.dispatchEvent(event);
    pointerUp?.(activeTool, {} as Parameters<PointerUpCallback>[1], event);
    return event;
  };
  const recoverMissingPointerUp = (pointerId: number, pointerType = "mouse") => {
    const event = pointerEvent("pointerdown", pointerId, pointerType);
    pointerUp?.(activeTool, {} as Parameters<PointerUpCallback>[1], event);
    return event;
  };

  return { arm, canvas, onExit, onFill, recoverMissingPointerUp, release, setActiveTool };
}

describe("BucketFillOverlay pointer lifecycle", () => {
  it("leaves pointer events available to Excalidraw and fills on its pointer-up callback", async () => {
    const { arm, canvas, onFill, release } = mountOverlay();
    const bubbled = vi.fn();
    canvas.parentElement?.addEventListener("pointerdown", bubbled);

    const down = arm(1, 20, 30);
    expect(down.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    release(1);
    await act(async () => Promise.resolve());

    expect(onFill).toHaveBeenCalledOnce();
    expect(onFill).toHaveBeenCalledWith({ x: 20, y: 30 });
  });

  it("aborts a two-pointer gesture without swallowing either pointer stream", async () => {
    const { arm, onFill, release } = mountOverlay();

    const first = arm(1, 20, 30);
    const second = arm(2, 40, 50);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    release(1);
    release(2);
    await act(async () => Promise.resolve());

    expect(onFill).not.toHaveBeenCalled();
  });

  it.each(["mouse", "pen"])("does not count a held %s pointer as multi-touch", async (pointerType) => {
    const { arm, onFill, release } = mountOverlay();

    arm(1, 10, 10, pointerType);
    arm(2, 60, 70, "touch");
    release(2);
    await act(async () => Promise.resolve());

    expect(onFill).toHaveBeenCalledOnce();
    expect(onFill).toHaveBeenCalledWith({ x: 60, y: 70 });
  });

  it("clears stale pointer state on focus loss so the next tap can fill", async () => {
    const { arm, onFill, release } = mountOverlay();

    arm(1, 20, 30);
    window.dispatchEvent(new Event("blur"));
    arm(2, 60, 70);
    release(2);
    await act(async () => Promise.resolve());

    expect(onFill).toHaveBeenCalledOnce();
    expect(onFill).toHaveBeenCalledWith({ x: 60, y: 70 });
  });

  it("does not fill when Excalidraw recovers a missing pointer-up on the next pointer-down", async () => {
    const { arm, onFill, recoverMissingPointerUp, release } = mountOverlay();

    arm(1, 20, 30, "mouse");
    recoverMissingPointerUp(2);
    release(1);
    await act(async () => Promise.resolve());
    expect(onFill).not.toHaveBeenCalled();

    arm(1, 60, 70, "mouse");
    release(1);
    await act(async () => Promise.resolve());
    expect(onFill).toHaveBeenCalledOnce();
    expect(onFill).toHaveBeenCalledWith({ x: 60, y: 70 });
  });

  it("recovers stale touch membership when the browser starts a new primary touch", async () => {
    const { arm, onFill, recoverMissingPointerUp, release } = mountOverlay();

    arm(1, 20, 30, "touch", true);
    recoverMissingPointerUp(2, "touch");
    arm(3, 60, 70, "touch", true);
    release(3);
    await act(async () => Promise.resolve());

    expect(onFill).toHaveBeenCalledOnce();
    expect(onFill).toHaveBeenCalledWith({ x: 60, y: 70 });
  });

  it("releases the repeat lock when Done exits Bucket Fill", () => {
    const { onExit, setActiveTool } = mountOverlay();
    const done = document.querySelector<HTMLButtonElement>(".bucket-fill-done");
    expect(done).toBeTruthy();

    act(() => done?.click());

    expect(setActiveTool).toHaveBeenCalledWith({ type: "selection", locked: false });
    expect(onExit).toHaveBeenCalledOnce();
  });
});
