import { useEffect, useRef, useState } from "react";
import {
  persistExperimentalFeaturesPreference,
  readExperimentalFeaturesPreference,
  subscribeToExperimentalFeaturesPreference,
} from "../lib/experimental-features";
import type {
  FeaturePreferenceKey,
  FeaturePreferences,
} from "../lib/feature-preferences";
import type { ThemePreference } from "../lib/theme-preference";
import { SettingsIcon } from "./Icons";
import { useModalDialog } from "./useModalDialog";

interface SettingsMenuProps {
  preferences: FeaturePreferences;
  themePreference: ThemePreference;
  onPreferenceChange: (key: FeaturePreferenceKey, enabled: boolean) => void;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onRestoreDefaults: () => void;
}

interface SettingsToggleProps {
  checked: boolean;
  description: string;
  label: string;
  onChange: (enabled: boolean) => void;
}

const WORKSPACE_TOGGLES: ReadonlyArray<{
  key: FeaturePreferenceKey;
  label: string;
  description: string;
}> = [
  { key: "slides", label: "Slides", description: "Frame-based presentations" },
  { key: "pdf", label: "PDF", description: "Page rail and annotation workspace" },
];

const TOOL_TOGGLES: ReadonlyArray<{
  key: FeaturePreferenceKey;
  label: string;
  description: string;
}> = [
  { key: "insert", label: "Insert tools", description: "Equations and Mermaid diagrams" },
  { key: "mathTools", label: "Math tools", description: "Classroom instruments and manipulatives" },
  { key: "library", label: "Library", description: "Personal shapes and screenshots" },
  { key: "sizePosition", label: "Size & Position", description: "Exact coordinates, dimensions, and rotation" },
  { key: "projectFind", label: "Project Find", description: "Search Board, PDF pages, and Slides" },
];

const DRAWING_TOGGLES: ReadonlyArray<{
  key: FeaturePreferenceKey;
  label: string;
  description: string;
}> = [
  { key: "penOnly", label: "Pen-only mode", description: "Ignore touch while drawing with a stylus" },
  { key: "showGrid", label: "Show grid", description: "Show and snap drawing to the canvas grid" },
  { key: "snapToObjects", label: "Snap to objects", description: "Align shapes to nearby objects" },
];

function SettingsToggle({ checked, description, label, onChange }: SettingsToggleProps) {
  return (
    <label className="settings-toggle">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function SettingsMenu({
  preferences,
  themePreference,
  onPreferenceChange,
  onThemePreferenceChange,
  onRestoreDefaults,
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [experimentalFeaturesEnabled, setExperimentalFeaturesEnabled] = useState(
    readExperimentalFeaturesPreference,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog<HTMLElement>({
    onClose: () => setOpen(false),
    open,
    returnFocusRef: triggerRef,
  });

  useEffect(() => subscribeToExperimentalFeaturesPreference(setExperimentalFeaturesEnabled), []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  const setExperimentalFeatures = (enabled: boolean) => {
    setExperimentalFeaturesEnabled(enabled);
    persistExperimentalFeaturesPreference(enabled);
  };

  const restoreDefaults = () => {
    onRestoreDefaults();
    setExperimentalFeatures(false);
  };

  return (
    <div ref={menuRef} className={`settings-menu ${open ? "is-open" : ""}`}>
      <button
        ref={triggerRef}
        className="settings-trigger"
        type="button"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="settings-popover"
        title="Settings"
        onClick={() => setOpen((current) => !current)}
      >
        <SettingsIcon />
      </button>
      {open ? (
        <section
          ref={dialogRef}
          id="settings-popover"
          className="settings-popover"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
          tabIndex={-1}
        >
          <div className="settings-heading">
            <div>
              <h2 id="settings-title">Settings</h2>
              <p>Choose what appears in your workspace.</p>
            </div>
            <span>On this device</span>
          </div>

          <div className="settings-group" role="group" aria-labelledby="workspace-settings-label">
            <h3 id="workspace-settings-label">Workspaces</h3>
            {WORKSPACE_TOGGLES.map((toggle) => (
              <SettingsToggle
                key={toggle.key}
                checked={preferences[toggle.key]}
                description={toggle.description}
                label={toggle.label}
                onChange={(enabled) => onPreferenceChange(toggle.key, enabled)}
              />
            ))}
          </div>

          <div className="settings-group" role="group" aria-labelledby="tool-settings-label">
            <h3 id="tool-settings-label">Tools</h3>
            {TOOL_TOGGLES.map((toggle) => (
              <SettingsToggle
                key={toggle.key}
                checked={preferences[toggle.key]}
                description={toggle.description}
                label={toggle.label}
                onChange={(enabled) => onPreferenceChange(toggle.key, enabled)}
              />
            ))}
          </div>

          <div className="settings-group" role="group" aria-labelledby="drawing-settings-label">
            <h3 id="drawing-settings-label">Drawing</h3>
            {DRAWING_TOGGLES.map((toggle) => (
              <SettingsToggle
                key={toggle.key}
                checked={preferences[toggle.key]}
                description={toggle.description}
                label={toggle.label}
                onChange={(enabled) => onPreferenceChange(toggle.key, enabled)}
              />
            ))}
          </div>

          <div className="settings-group" role="group" aria-labelledby="display-settings-label">
            <h3 id="display-settings-label">Display</h3>
            <SettingsToggle
              checked={preferences.footer}
              description="Page, zoom, history, and fullscreen controls"
              label="Status bar"
              onChange={(enabled) => onPreferenceChange("footer", enabled)}
            />
            <SettingsToggle
              checked={preferences.iconOnlyControls}
              description="Hide written labels where a control already has an icon"
              label="Icon-only controls"
              onChange={(enabled) => onPreferenceChange("iconOnlyControls", enabled)}
            />
            <label className="settings-select">
              <span>
                <strong>Theme</strong>
                <small>Light, dark, or match this device</small>
              </span>
              <select
                aria-label="Theme"
                value={themePreference}
                onChange={(event) => onThemePreferenceChange(event.target.value as ThemePreference)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </label>
          </div>

          <div className="settings-group" role="group" aria-labelledby="advanced-settings-label">
            <h3 id="advanced-settings-label">Advanced</h3>
            <SettingsToggle
              checked={experimentalFeaturesEnabled}
              description="Developing math and selection tools"
              label="Experimental math tools"
              onChange={setExperimentalFeatures}
            />
          </div>

          <div className="settings-footer">
            <span>Preferences stay on this device.</span>
            <button type="button" onClick={restoreDefaults}>Restore defaults</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
