import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled):not([type=\"hidden\"])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

type FocusRef = RefObject<HTMLElement>;

interface UseModalDialogOptions {
  initialFocusRef?: FocusRef;
  onClose: () => void;
  open?: boolean;
  restoreFocus?: boolean | (() => boolean);
  returnFocusRef?: FocusRef;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => (
      element.getClientRects().length > 0
      && !element.closest("[aria-hidden=\"true\"], [inert]")
    ));
}

export function useModalDialog<T extends HTMLElement>({
  initialFocusRef,
  onClose,
  open = true,
  restoreFocus = true,
  returnFocusRef,
}: UseModalDialogOptions) {
  const dialogRef = useRef<T>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const initialFocusRefRef = useLatest(initialFocusRef);
  const onCloseRef = useLatest(onClose);
  const restoreFocusRef = useLatest(restoreFocus);
  const returnFocusRefRef = useLatest(returnFocusRef);

  useLayoutEffect(() => {
    if (!open) return;
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }

    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    if (!dialog.contains(document.activeElement)) {
      const requestedInitialFocus = initialFocusRefRef.current?.current;
      const initialFocus = requestedInitialFocus && dialog.contains(requestedInitialFocus)
        ? requestedInitialFocus
        : focusableElements(dialog)[0] || dialog;
      initialFocus.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const controls = focusableElements(dialog);
      if (!controls.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || active === dialog) {
        event.preventDefault();
        event.stopImmediatePropagation();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        event.stopImmediatePropagation();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopImmediatePropagation();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      const shouldRestore = typeof restoreFocusRef.current === "function"
        ? restoreFocusRef.current()
        : restoreFocusRef.current;
      if (!shouldRestore) return;

      const requestedReturnFocus = returnFocusRefRef.current?.current;
      const returnFocus = requestedReturnFocus?.isConnected
        ? requestedReturnFocus
        : previouslyFocused?.isConnected
          ? previouslyFocused
          : null;
      if (!returnFocus) return;
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        if (returnFocus.isConnected) returnFocus.focus();
      });
    };
  }, [open]);

  return dialogRef;
}
