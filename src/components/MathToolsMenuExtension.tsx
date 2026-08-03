import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LassoIcon, MathToolsIcon } from "./Icons";
import {
  readExperimentalFeaturesPreference,
  subscribeToExperimentalFeaturesPreference,
} from "../lib/experimental-features";

interface MathToolsMenuExtensionProps {
  editorHost: HTMLDivElement | null;
  onOpen: () => void;
  onPrepareLasso: () => void;
  onStartLasso: () => void;
}

export function MathToolsMenuExtension({ editorHost, onOpen, onPrepareLasso, onStartLasso }: MathToolsMenuExtensionProps) {
  const [menu, setMenu] = useState<Element | null>(null);
  const [experimentalFeaturesEnabled, setExperimentalFeaturesEnabled] = useState(readExperimentalFeaturesPreference);

  useEffect(() => {
    if (!editorHost) return;
    const findMenu = () => {
      const next = editorHost.querySelector(
        ".App-toolbar__extra-tools-dropdown .dropdown-menu-container",
      );
      setMenu((current) => current === next ? current : next);
    };
    findMenu();
    const observer = new MutationObserver(findMenu);
    observer.observe(editorHost, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [editorHost]);

  useEffect(() => subscribeToExperimentalFeaturesPreference(setExperimentalFeaturesEnabled), []);

  useEffect(() => {
    if (!editorHost || !experimentalFeaturesEnabled) return;
    const prepareFromTrigger = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".App-toolbar__extra-tools-trigger")) {
        onPrepareLasso();
      }
    };
    editorHost.addEventListener("pointerdown", prepareFromTrigger, true);
    return () => editorHost.removeEventListener("pointerdown", prepareFromTrigger, true);
  }, [editorHost, experimentalFeaturesEnabled, onPrepareLasso]);

  if (!menu) return null;

  const closeExtraTools = () => editorHost?.querySelector<HTMLButtonElement>(
    ".App-toolbar__extra-tools-trigger",
  )?.click();

  return createPortal(
    <>
      <button
        className="dropdown-menu-item dropdown-menu-item-base classroom-math-tools-menu-item"
        type="button"
        data-testid="toolbar-math-tools"
        aria-label="Math tools"
        title="Math tools"
        onClick={() => {
          closeExtraTools();
          onOpen();
        }}
      >
        <div className="dropdown-menu-item__icon"><MathToolsIcon /></div>
        <div className="dropdown-menu-item__text icon-label">Math tools</div>
      </button>
      {experimentalFeaturesEnabled ? (
        <button
          className="dropdown-menu-item dropdown-menu-item-base classroom-lasso-menu-item"
          type="button"
          data-testid="toolbar-lasso"
          aria-label="Lasso selection"
          title="Lasso selection"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onStartLasso();
            closeExtraTools();
          }}
          onClick={() => {
            closeExtraTools();
            void onStartLasso();
          }}
        >
          <div className="dropdown-menu-item__icon"><LassoIcon /></div>
          <div className="dropdown-menu-item__text icon-label">Lasso selection</div>
        </button>
      ) : null}
    </>,
    menu,
  );
}
