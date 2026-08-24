import { describe, expect, it } from "vitest";
import {
  KEYBOARD_SHORTCUT_GROUPS,
  KEYBOARD_SHORTCUTS,
  bindingsForKeyboardShortcut,
  detectKeyboardShortcutPlatform,
  filterKeyboardShortcuts,
  formatShortcutBinding,
} from "./keyboard-shortcuts";

describe("keyboard shortcut catalogue", () => {
  it("covers every required surface with stable, unique shortcut IDs", () => {
    expect(KEYBOARD_SHORTCUT_GROUPS.map((group) => group.id)).toEqual([
      "patterdraw",
      "tools",
      "view",
      "editing",
      "pdf",
      "slides",
    ]);

    const ids = KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(KEYBOARD_SHORTCUTS.length).toBeGreaterThanOrEqual(75);

    for (const group of KEYBOARD_SHORTCUT_GROUPS) {
      expect(KEYBOARD_SHORTCUTS.some((shortcut) => shortcut.group === group.id)).toBe(true);
    }

    expect(ids).toEqual(expect.arrayContaining([
      "help",
      "clean-fullscreen",
      "save-project",
      "open-project",
      "export-image",
      "slides-start-presentation",
      "slides-collapse-toolbar",
      "pdf-previous-page",
      "pdf-next-page",
      "tool-selection",
      "tool-text",
      "edit-undo",
      "edit-group",
    ]));
    expect(ids).not.toContain("view-theme");
    expect(ids.some((id) => /hyperlink|collaborat|embed/i.test(id))).toBe(false);

    const cleanFullscreen = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "clean-fullscreen");
    const exportImage = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "export-image");
    const startPresentation = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "slides-start-presentation");
    expect(cleanFullscreen?.bindings).toEqual([["Mod", "Shift", "Enter"]]);
    expect(exportImage?.bindings).toEqual([["Mod", "Shift", "E"]]);
    expect(exportImage?.description).toMatch(/local image-export dialog/i);
    expect(startPresentation?.bindings).toEqual([["Mod", "Alt", "Enter"]]);
  });

  it("uses platform-aware modifier names", () => {
    expect(formatShortcutBinding(["Mod", "Shift", "Enter"], "apple"))
      .toEqual(["Cmd", "Shift", "Enter"]);
    expect(formatShortcutBinding(["Mod", "Alt", "C"], "apple"))
      .toEqual(["Cmd", "Option", "C"]);
    expect(formatShortcutBinding(["Mod", "Alt", "Enter"], "apple"))
      .toEqual(["Cmd", "Option", "Enter"]);
    expect(formatShortcutBinding(["Mod", "Shift", "Enter"], "other"))
      .toEqual(["Ctrl", "Shift", "Enter"]);
    expect(formatShortcutBinding(["Mod", "Alt", "C"], "other"))
      .toEqual(["Ctrl", "Alt", "C"]);
    expect(detectKeyboardShortcutPlatform("MacIntel")).toBe("apple");
    expect(detectKeyboardShortcutPlatform("Linux x86_64")).toBe("other");

    const sendToBack = KEYBOARD_SHORTCUTS.find((shortcut) => shortcut.id === "edit-send-to-back");
    if (!sendToBack) throw new Error("Send-to-back shortcut was not catalogued.");
    expect(bindingsForKeyboardShortcut(sendToBack, "apple"))
      .toEqual([["Mod", "Alt", "["]]);
    expect(bindingsForKeyboardShortcut(sendToBack, "other"))
      .toEqual([["Mod", "Shift", "["]]);
  });

  it("searches labels, descriptions, aliases, groups, and formatted keys", () => {
    expect(filterKeyboardShortcuts("bucket colour", "other").map((entry) => entry.id))
      .toEqual(["bucket-fill"]);
    expect(filterKeyboardShortcuts("Cmd Shift Enter", "apple").map((entry) => entry.id))
      .toContain("clean-fullscreen");
    expect(filterKeyboardShortcuts("pdf", "other").map((entry) => entry.id))
      .toEqual(expect.arrayContaining(["pdf-previous-page", "pdf-next-page"]));
    expect(filterKeyboardShortcuts("PNG SVG export", "apple").map((entry) => entry.id))
      .toEqual(["export-image"]);
    expect(filterKeyboardShortcuts("remote collaboration", "other")).toEqual([]);
  });
});
