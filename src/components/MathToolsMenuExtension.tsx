import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MathToolsIcon } from "./Icons";

interface MathToolsMenuExtensionProps {
  editorHost: HTMLDivElement | null;
  onOpen: () => void;
}

export function MathToolsMenuExtension({ editorHost, onOpen }: MathToolsMenuExtensionProps) {
  const [menu, setMenu] = useState<Element | null>(null);

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

  if (!menu) return null;

  return createPortal(
    <button
      className="dropdown-menu-item dropdown-menu-item-base classroom-math-tools-menu-item"
      type="button"
      data-testid="toolbar-math-tools"
      aria-label="Math tools"
      title="Math tools"
      onClick={() => {
        const trigger = editorHost?.querySelector<HTMLButtonElement>(
          ".App-toolbar__extra-tools-trigger",
        );
        trigger?.click();
        onOpen();
      }}
    >
      <div className="dropdown-menu-item__icon"><MathToolsIcon /></div>
      <div className="dropdown-menu-item__text">Math tools</div>
    </button>,
    menu,
  );
}
