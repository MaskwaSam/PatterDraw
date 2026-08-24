import { useMemo, useRef, useState, type RefObject } from "react";
import {
  KEYBOARD_SHORTCUT_GROUPS,
  bindingsForKeyboardShortcut,
  detectKeyboardShortcutPlatform,
  filterKeyboardShortcuts,
  formatShortcutBinding,
  type KeyboardShortcutBinding,
  type KeyboardShortcutPlatform,
} from "../lib/keyboard-shortcuts";
import { useModalDialog } from "./useModalDialog";

export interface KeyboardShortcutsDialogProps {
  onClose: () => void;
  platform?: KeyboardShortcutPlatform;
  returnFocusRef?: RefObject<HTMLElement>;
}

function ShortcutKeys({
  bindings,
  platform,
}: {
  bindings: readonly KeyboardShortcutBinding[];
  platform: KeyboardShortcutPlatform;
}) {
  return (
    <span className="keyboard-shortcut-bindings">
      {bindings.map((binding, bindingIndex) => {
        const labels = formatShortcutBinding(binding, platform);
        return (
          <span className="keyboard-shortcut-binding" key={binding.join("+")}>
            {bindingIndex > 0 ? <span className="keyboard-shortcut-or">or</span> : null}
            <span
              className="keyboard-shortcut-chord"
              aria-label={labels.join(" plus ")}
            >
              {labels.map((label, keyIndex) => (
                <span key={`${binding[keyIndex]}-${keyIndex}`}>
                  {keyIndex > 0 ? <span aria-hidden="true" className="keyboard-shortcut-plus">+</span> : null}
                  <kbd>{label}</kbd>
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function KeyboardShortcutsDialog({
  onClose,
  platform = detectKeyboardShortcutPlatform(),
  returnFocusRef,
}: KeyboardShortcutsDialogProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog<HTMLElement>({
    initialFocusRef: searchRef,
    onClose,
    returnFocusRef,
  });
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => filterKeyboardShortcuts(query, platform),
    [platform, query],
  );
  const visibleGroups = useMemo(() => KEYBOARD_SHORTCUT_GROUPS.map((group) => ({
    ...group,
    shortcuts: filtered.filter((shortcut) => shortcut.group === group.id),
  })).filter((group) => group.shortcuts.length > 0), [filtered]);
  const resultMessage = query.trim()
    ? `${filtered.length} shortcut${filtered.length === 1 ? "" : "s"} found`
    : `${filtered.length} shortcuts`;

  return (
    <div
      className="modal-backdrop keyboard-shortcuts-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="keyboard-shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        aria-describedby="keyboard-shortcuts-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading keyboard-shortcuts-heading">
          <div>
            <span className="dialog-kicker">Help</span>
            <h2 id="keyboard-shortcuts-title">Keyboard shortcuts</h2>
          </div>
          <button
            className="dialog-close"
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            ×
          </button>
        </div>

        <p id="keyboard-shortcuts-description" className="keyboard-shortcuts-description">
          Search PatterDraw and canvas commands. Shortcuts pause while you are typing in a field or using a dialog.
        </p>

        <div className="keyboard-shortcuts-search-row">
          <label htmlFor="keyboard-shortcuts-search">Search shortcuts</label>
          <div className="keyboard-shortcuts-search-control">
            <input
              ref={searchRef}
              id="keyboard-shortcuts-search"
              type="search"
              value={query}
              placeholder="Try fullscreen, PDF, undo, or Cmd"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button type="button" onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}>
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <p className="keyboard-shortcuts-result-count" role="status" aria-live="polite">
          {resultMessage}
        </p>

        <div className="keyboard-shortcuts-groups">
          {visibleGroups.map((group) => (
            <section
              className="keyboard-shortcuts-group"
              key={group.id}
              aria-labelledby={`keyboard-shortcuts-group-${group.id}`}
            >
              <header>
                <h3 id={`keyboard-shortcuts-group-${group.id}`}>{group.label}</h3>
                <p>{group.description}</p>
              </header>
              <dl>
                {group.shortcuts.map((shortcut) => (
                  <div className="keyboard-shortcut-row" key={shortcut.id}>
                    <dt>
                      <strong>{shortcut.label}</strong>
                      <span>{shortcut.description}</span>
                    </dt>
                    <dd>
                      <ShortcutKeys
                        bindings={bindingsForKeyboardShortcut(shortcut, platform)}
                        platform={platform}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          {filtered.length === 0 ? (
            <div className="keyboard-shortcuts-empty">
              <strong>No shortcuts found</strong>
              <p>Try a tool, action, key, or workspace name.</p>
              <button type="button" onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}>
                Show all shortcuts
              </button>
            </div>
          ) : null}
        </div>

        <div className="dialog-actions keyboard-shortcuts-actions">
          <button className="dialog-primary" type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
