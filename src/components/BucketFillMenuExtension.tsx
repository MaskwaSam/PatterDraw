import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BucketFillIcon } from "./Icons";

interface BucketFillMenuExtensionProps {
  active: boolean;
  editorHost: HTMLDivElement | null;
  onStart: () => void;
}

export function BucketFillMenuExtension({ active, editorHost, onStart }: BucketFillMenuExtensionProps) {
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

  const closeExtraTools = () => editorHost?.querySelector<HTMLButtonElement>(
    ".App-toolbar__extra-tools-trigger",
  )?.click();

  return createPortal(
    <button
      className={`dropdown-menu-item dropdown-menu-item-base classroom-bucket-fill-menu-item ${active ? "is-active" : ""}`}
      type="button"
      data-testid="toolbar-bucket-fill"
      aria-label="Bucket fill"
      title="Bucket fill (B)"
      aria-pressed={active}
      onClick={() => {
        closeExtraTools();
        onStart();
      }}
    >
      <div className="dropdown-menu-item__icon"><BucketFillIcon /></div>
      <div className="dropdown-menu-item__text icon-label">Bucket fill</div>
      <span className="dropdown-menu-item__shortcut">B</span>
    </button>,
    menu,
  );
}
