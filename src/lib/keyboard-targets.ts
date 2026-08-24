/**
 * Return whether a keyboard event originated in a field that owns text input.
 *
 * Use the nearest contenteditable declaration so an explicit
 * `contenteditable="false"` island inside an editable surface remains
 * non-editable. Empty and `plaintext-only` declarations are editable.
 */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;

  const contentEditable = target.closest("[contenteditable]");
  if (contentEditable) {
    return contentEditable.getAttribute("contenteditable")?.trim().toLowerCase() !== "false";
  }
  return Boolean(target.closest('[role="textbox"]'));
}
