import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaptureUpdateAction,
  newElementWith,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

type StrokeWidthExtensionsProps = {
  api: ExcalidrawImperativeAPI;
  editorHost: HTMLDivElement | null;
  strokeWidth: number;
};

const EXTENDED_STROKE_WIDTHS = [
  { value: 0.5, title: "Extra fine", testId: "strokeWidth-extraFine", iconWidth: 0.75 },
  { value: 3, title: "Heavy", testId: "strokeWidth-heavy", iconWidth: 3.125 },
] as const;

export function StrokeWidthExtensions({ api, editorHost, strokeWidth }: StrokeWidthExtensionsProps) {
  const [buttonList, setButtonList] = useState<Element | null>(null);

  useEffect(() => {
    if (!editorHost) return;
    const findButtonList = () => {
      const next = editorHost
        .querySelector('[data-testid="strokeWidth-thin"]')
        ?.closest(".buttonList") || null;
      setButtonList((current) => current === next ? current : next);
    };
    findButtonList();
    const observer = new MutationObserver(findButtonList);
    observer.observe(editorHost, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [editorHost]);

  if (!buttonList) return null;

  const selectWidth = (width: number) => {
    const appState = api.getAppState();
    const selectedElementIds = appState.selectedElementIds;
    const elements = api.getSceneElements().map((element) => selectedElementIds[element.id]
      ? newElementWith(element, {
          strokeWidth: width as ExcalidrawElement["strokeWidth"],
        })
      : element);
    api.updateScene({
      elements,
      appState: {
        currentItemStrokeWidth: width as AppState["currentItemStrokeWidth"],
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  return createPortal(
    <>
      {EXTENDED_STROKE_WIDTHS.map((option) => (
        <label
          className={strokeWidth === option.value ? "active extended-stroke-width" : "extended-stroke-width"}
          title={option.title}
          key={option.value}
        >
          <input
            type="radio"
            name="stroke-width"
            data-testid={option.testId}
            checked={strokeWidth === option.value}
            onChange={() => selectWidth(option.value)}
          />
          <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" fill="none" stroke="currentColor">
            <path
              d="M5 10h10"
              stroke="currentColor"
              strokeWidth={option.iconWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </label>
      ))}
    </>,
    buttonList,
  );
}
