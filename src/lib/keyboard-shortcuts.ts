export type KeyboardShortcutGroupId =
  | "patterdraw"
  | "tools"
  | "view"
  | "editing"
  | "pdf"
  | "slides";

export type KeyboardShortcutPlatform = "apple" | "other";

export interface KeyboardShortcutGroup {
  id: KeyboardShortcutGroupId;
  label: string;
  description: string;
}

/**
 * A binding is one key chord. Multiple bindings on an entry are alternatives,
 * not a sequence. `Mod` is rendered as Cmd on Apple devices and Ctrl
 * everywhere else.
 */
export type KeyboardShortcutBinding = readonly string[];

export interface KeyboardShortcutDefinition {
  id: string;
  group: KeyboardShortcutGroupId;
  label: string;
  description: string;
  bindings: readonly KeyboardShortcutBinding[];
  appleBindings?: readonly KeyboardShortcutBinding[];
  otherBindings?: readonly KeyboardShortcutBinding[];
  searchTerms?: readonly string[];
}

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  {
    id: "patterdraw",
    label: "PatterDraw",
    description: "Project, classroom display, and PatterDraw navigation commands.",
  },
  {
    id: "tools",
    label: "Drawing tools",
    description: "Switch tools without leaving the canvas.",
  },
  {
    id: "view",
    label: "Canvas view",
    description: "Pan, zoom, and frame the board.",
  },
  {
    id: "editing",
    label: "Editing",
    description: "Select, arrange, and edit board objects.",
  },
  {
    id: "pdf",
    label: "PDF",
    description: "Navigate PDF pages and adjust the page rail.",
  },
  {
    id: "slides",
    label: "Slides presentation",
    description: "Start and control a classroom presentation.",
  },
] as const;

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutDefinition[] = [
  {
    id: "help",
    group: "patterdraw",
    label: "Open keyboard shortcut help",
    description: "Open this searchable shortcut guide.",
    bindings: [["?"]],
    searchTerms: ["help", "settings", "guide"],
  },
  {
    id: "clean-fullscreen",
    group: "patterdraw",
    label: "Toggle clean fullscreen",
    description: "Fill the display with the board and hide the top, bottom, and side toolbars.",
    bindings: [["Mod", "Shift", "Enter"]],
    searchTerms: ["welcome page", "classroom display", "hide chrome", "zen"],
  },
  {
    id: "save-project",
    group: "patterdraw",
    label: "Download project",
    description: "Save a complete local .patterdraw project file.",
    bindings: [["Mod", "S"]],
    searchTerms: ["save", "backup", "download"],
  },
  {
    id: "open-project",
    group: "patterdraw",
    label: "Open project",
    description: "Choose a local PatterDraw project file to open.",
    bindings: [["Mod", "O"]],
    searchTerms: ["load", "file", "import"],
  },
  {
    id: "export-image",
    group: "patterdraw",
    label: "Export image",
    description: "Open Excalidraw's local image-export dialog for the active board.",
    bindings: [["Mod", "Shift", "E"]],
    searchTerms: ["save as image", "png", "svg"],
  },
  {
    id: "find-project",
    group: "patterdraw",
    label: "Find in project",
    description: "Search the board, PDF pages, and slides when Project Find is enabled.",
    bindings: [["Mod", "F"]],
    searchTerms: ["search", "project find"],
  },
  {
    id: "bucket-fill",
    group: "patterdraw",
    label: "Bucket fill",
    description: "Activate PatterDraw's local bucket-fill tool.",
    bindings: [["B"]],
    searchTerms: ["paint", "colour", "color"],
  },
  {
    id: "toggle-navigation",
    group: "patterdraw",
    label: "Show or hide navigation",
    description: "Toggle the PatterDraw navigation bar.",
    bindings: [["Mod", "Shift", "H"]],
    searchTerms: ["top bar", "toolbar", "header", "chrome"],
  },
  {
    id: "toggle-footer",
    group: "patterdraw",
    label: "Show or hide footer",
    description: "Toggle the PatterDraw footer controls.",
    bindings: [["Mod", "Shift", "F"]],
    searchTerms: ["bottom bar", "toolbar", "chrome"],
  },

  {
    id: "tool-selection",
    group: "tools",
    label: "Selection tool",
    description: "Select, move, and resize objects.",
    bindings: [["V"], ["1"]],
    searchTerms: ["pointer", "cursor"],
  },
  {
    id: "tool-rectangle",
    group: "tools",
    label: "Rectangle tool",
    description: "Draw rectangles and squares.",
    bindings: [["R"], ["2"]],
    searchTerms: ["shape", "box", "square"],
  },
  {
    id: "tool-diamond",
    group: "tools",
    label: "Diamond tool",
    description: "Draw diamonds.",
    bindings: [["D"], ["3"]],
    searchTerms: ["shape", "rhombus"],
  },
  {
    id: "tool-ellipse",
    group: "tools",
    label: "Ellipse tool",
    description: "Draw ellipses and circles.",
    bindings: [["O"], ["4"]],
    searchTerms: ["shape", "circle", "oval"],
  },
  {
    id: "tool-arrow",
    group: "tools",
    label: "Arrow tool",
    description: "Draw arrows and connectors.",
    bindings: [["A"], ["5"]],
    searchTerms: ["connector"],
  },
  {
    id: "tool-line",
    group: "tools",
    label: "Line tool",
    description: "Draw straight or multi-point lines.",
    bindings: [["L"], ["6"]],
  },
  {
    id: "tool-draw",
    group: "tools",
    label: "Free draw tool",
    description: "Draw freehand strokes.",
    bindings: [["P"], ["7"]],
    searchTerms: ["pen", "pencil", "ink"],
  },
  {
    id: "tool-text",
    group: "tools",
    label: "Text tool",
    description: "Add editable text.",
    bindings: [["T"], ["8"]],
    searchTerms: ["type", "label"],
  },
  {
    id: "tool-image",
    group: "tools",
    label: "Insert local image",
    description: "Choose a local image to place on the board.",
    bindings: [["9"]],
    searchTerms: ["photo", "picture"],
  },
  {
    id: "tool-eraser",
    group: "tools",
    label: "Eraser tool",
    description: "Erase board objects.",
    bindings: [["E"], ["0"]],
    searchTerms: ["remove"],
  },
  {
    id: "tool-frame",
    group: "tools",
    label: "Frame tool",
    description: "Draw an Excalidraw frame; frames are the slide primitive in Slides mode.",
    bindings: [["F"]],
    searchTerms: ["slide", "presentation"],
  },
  {
    id: "tool-hand",
    group: "tools",
    label: "Hand tool",
    description: "Pan the board without moving objects.",
    bindings: [["H"]],
    searchTerms: ["pan", "move canvas"],
  },
  {
    id: "tool-laser",
    group: "tools",
    label: "Laser pointer",
    description: "Point temporarily without adding a permanent mark.",
    bindings: [["K"]],
    searchTerms: ["present", "pointer"],
  },
  {
    id: "tool-lock-active",
    group: "tools",
    label: "Keep active tool selected",
    description: "Toggle whether the current drawing tool remains active after use.",
    bindings: [["Q"]],
    searchTerms: ["lock tool", "repeat"],
  },
  {
    id: "tool-eyedropper",
    group: "tools",
    label: "Pick a colour from the canvas",
    description: "Activate the eyedropper for stroke or background colour.",
    bindings: [["I"], ["Shift", "S"], ["Shift", "G"]],
    searchTerms: ["eyedropper", "color", "sample"],
  },
  {
    id: "tool-edit-line-points",
    group: "tools",
    label: "Edit line or arrow points",
    description: "Edit the points of the selected line or arrow.",
    bindings: [["Mod", "Enter"]],
    searchTerms: ["vertices", "connector"],
  },
  {
    id: "tool-text-new-line",
    group: "tools",
    label: "Add a line while editing text",
    description: "Insert a new line in the active text editor.",
    bindings: [["Enter"], ["Shift", "Enter"]],
  },
  {
    id: "tool-text-finish",
    group: "tools",
    label: "Finish editing text",
    description: "Leave the active text editor.",
    bindings: [["Esc"], ["Mod", "Enter"]],
  },
  {
    id: "tool-image-crop",
    group: "tools",
    label: "Start image cropping",
    description: "Crop the selected local image.",
    bindings: [["Double-click"], ["Enter"]],
    searchTerms: ["picture", "photo"],
  },
  {
    id: "tool-image-crop-finish",
    group: "tools",
    label: "Finish image cropping",
    description: "Apply the current local image crop.",
    bindings: [["Enter"], ["Esc"]],
    searchTerms: ["picture", "photo"],
  },
  {
    id: "tool-prevent-binding",
    group: "tools",
    label: "Prevent arrow binding",
    description: "Hold the modifier while placing an arrow to prevent binding.",
    bindings: [["Mod"]],
    searchTerms: ["connector", "unbind"],
  },

  {
    id: "view-pan",
    group: "view",
    label: "Pan the canvas",
    description: "Hold Space while dragging, or drag with the middle mouse button.",
    bindings: [["Space", "Drag"], ["Middle mouse drag"]],
    searchTerms: ["move board", "hand"],
  },
  {
    id: "view-zoom-in",
    group: "view",
    label: "Zoom in",
    description: "Increase the canvas zoom level.",
    bindings: [["Mod", "+"]],
  },
  {
    id: "view-zoom-out",
    group: "view",
    label: "Zoom out",
    description: "Decrease the canvas zoom level.",
    bindings: [["Mod", "-"]],
  },
  {
    id: "view-reset-zoom",
    group: "view",
    label: "Reset zoom to 100%",
    description: "Return the canvas to its actual-size zoom level.",
    bindings: [["Mod", "0"]],
    searchTerms: ["actual size"],
  },
  {
    id: "view-fit-all",
    group: "view",
    label: "Zoom to fit all objects",
    description: "Frame every object on the current board.",
    bindings: [["Shift", "1"]],
    searchTerms: ["fit canvas", "show all"],
  },
  {
    id: "view-fit-selection",
    group: "view",
    label: "Zoom to selection",
    description: "Frame the currently selected objects.",
    bindings: [["Shift", "2"]],
    searchTerms: ["fit selected"],
  },
  {
    id: "view-page-vertical",
    group: "view",
    label: "Move canvas up or down",
    description: "Pan the visible canvas by one page vertically.",
    bindings: [["PageUp"], ["PageDown"]],
  },
  {
    id: "view-page-horizontal",
    group: "view",
    label: "Move canvas left or right",
    description: "Pan the visible canvas by one page horizontally.",
    bindings: [["Shift", "PageUp"], ["Shift", "PageDown"]],
  },
  {
    id: "view-zen-mode",
    group: "view",
    label: "Toggle canvas Zen mode",
    description: "Show or hide the native canvas controls without changing browser fullscreen.",
    bindings: [["Alt", "Z"]],
    searchTerms: ["minimal", "hide tools"],
  },
  {
    id: "view-object-snap",
    group: "view",
    label: "Toggle object snapping",
    description: "Turn canvas object snapping on or off.",
    bindings: [["Alt", "S"]],
    searchTerms: ["align", "snap"],
  },
  {
    id: "view-grid",
    group: "view",
    label: "Toggle grid",
    description: "Show or hide the canvas grid.",
    bindings: [["Mod", "'"]],
  },
  {
    id: "view-read-only",
    group: "view",
    label: "Toggle view mode",
    description: "Switch the native canvas between editing and view-only interaction.",
    bindings: [["Alt", "R"]],
    searchTerms: ["read only", "view only"],
  },
  {
    id: "view-stats",
    group: "view",
    label: "Show canvas statistics",
    description: "Open the local canvas diagnostics panel.",
    bindings: [["Alt", "/"]],
    searchTerms: ["stats", "diagnostics"],
  },
  {
    id: "view-command-palette",
    group: "view",
    label: "Open command palette",
    description: "Search available local canvas commands.",
    bindings: [["Mod", "/"], ["Mod", "Shift", "P"]],
    searchTerms: ["actions", "commands"],
  },

  {
    id: "edit-undo",
    group: "editing",
    label: "Undo",
    description: "Undo the last board edit.",
    bindings: [["Mod", "Z"]],
  },
  {
    id: "edit-redo",
    group: "editing",
    label: "Redo",
    description: "Redo the last undone board edit.",
    bindings: [["Mod", "Shift", "Z"], ["Mod", "Y"]],
    appleBindings: [["Mod", "Shift", "Z"]],
  },
  {
    id: "edit-select-all",
    group: "editing",
    label: "Select all",
    description: "Select every object on the active board.",
    bindings: [["Mod", "A"]],
  },
  {
    id: "edit-multi-select",
    group: "editing",
    label: "Add or remove from selection",
    description: "Hold Shift while clicking an object.",
    bindings: [["Shift", "Click"]],
    searchTerms: ["multiple", "multi-select"],
  },
  {
    id: "edit-copy",
    group: "editing",
    label: "Copy",
    description: "Copy the selected objects locally.",
    bindings: [["Mod", "C"]],
  },
  {
    id: "edit-cut",
    group: "editing",
    label: "Cut",
    description: "Cut the selected objects.",
    bindings: [["Mod", "X"]],
  },
  {
    id: "edit-paste",
    group: "editing",
    label: "Paste",
    description: "Paste local clipboard content safely.",
    bindings: [["Mod", "V"]],
  },
  {
    id: "edit-paste-plain-text",
    group: "editing",
    label: "Paste as plain text",
    description: "Paste text without source formatting.",
    bindings: [["Mod", "Shift", "V"]],
  },
  {
    id: "edit-duplicate",
    group: "editing",
    label: "Duplicate selection",
    description: "Create a copy of the selected objects.",
    bindings: [["Mod", "D"], ["Alt", "Drag"]],
  },
  {
    id: "edit-delete",
    group: "editing",
    label: "Delete selection",
    description: "Remove the selected objects.",
    bindings: [["Delete"], ["Backspace"]],
  },
  {
    id: "edit-group",
    group: "editing",
    label: "Group selection",
    description: "Group selected objects so they move together.",
    bindings: [["Mod", "G"]],
  },
  {
    id: "edit-ungroup",
    group: "editing",
    label: "Ungroup selection",
    description: "Separate objects in the selected group.",
    bindings: [["Mod", "Shift", "G"]],
  },
  {
    id: "edit-lock",
    group: "editing",
    label: "Lock or unlock selection",
    description: "Prevent or allow direct editing of selected objects.",
    bindings: [["Mod", "Shift", "L"]],
  },
  {
    id: "edit-send-backward",
    group: "editing",
    label: "Send backward",
    description: "Move the selection back one layer.",
    bindings: [["Mod", "["]],
  },
  {
    id: "edit-bring-forward",
    group: "editing",
    label: "Bring forward",
    description: "Move the selection forward one layer.",
    bindings: [["Mod", "]"]],
  },
  {
    id: "edit-send-to-back",
    group: "editing",
    label: "Send to back",
    description: "Move the selection behind all other objects.",
    bindings: [["Mod", "Shift", "["]],
    appleBindings: [["Mod", "Alt", "["]],
  },
  {
    id: "edit-bring-to-front",
    group: "editing",
    label: "Bring to front",
    description: "Move the selection in front of all other objects.",
    bindings: [["Mod", "Shift", "]"]],
    appleBindings: [["Mod", "Alt", "]"]],
  },
  {
    id: "edit-nudge",
    group: "editing",
    label: "Nudge selection",
    description: "Move selected objects a small distance.",
    bindings: [["Arrow keys"]],
  },
  {
    id: "edit-nudge-large",
    group: "editing",
    label: "Nudge selection farther",
    description: "Move selected objects in a larger step.",
    bindings: [["Shift", "Arrow keys"]],
  },
  {
    id: "edit-copy-style",
    group: "editing",
    label: "Copy object style",
    description: "Copy the appearance of the selected object.",
    bindings: [["Mod", "Alt", "C"]],
    searchTerms: ["colour", "color", "appearance"],
  },
  {
    id: "edit-paste-style",
    group: "editing",
    label: "Paste object style",
    description: "Apply a copied appearance to selected objects.",
    bindings: [["Mod", "Alt", "V"]],
    searchTerms: ["colour", "color", "appearance"],
  },
  {
    id: "edit-copy-as-png",
    group: "editing",
    label: "Copy selection as PNG",
    description: "Copy a local PNG rendering of the selection when the browser supports it.",
    bindings: [["Shift", "Alt", "C"]],
    searchTerms: ["image", "clipboard"],
  },
  {
    id: "edit-deep-select",
    group: "editing",
    label: "Select inside a group",
    description: "Select an object nested inside a group.",
    bindings: [["Mod", "Click"]],
    searchTerms: ["deep select", "nested"],
  },
  {
    id: "edit-deep-box-select",
    group: "editing",
    label: "Box-select inside groups",
    description: "Deep-select objects with a selection rectangle while preventing a drag.",
    bindings: [["Mod", "Drag"]],
    searchTerms: ["deep select", "nested"],
  },
  {
    id: "edit-create-flowchart",
    group: "editing",
    label: "Create a connected flowchart shape",
    description: "Create a connected shape in the chosen direction from the selection.",
    bindings: [["Mod", "Arrow keys"]],
    searchTerms: ["diagram", "connector"],
  },
  {
    id: "edit-navigate-flowchart",
    group: "editing",
    label: "Navigate a flowchart",
    description: "Move the selection through connected flowchart shapes.",
    bindings: [["Alt", "Arrow keys"]],
    searchTerms: ["diagram", "connector"],
  },
  {
    id: "edit-align-top",
    group: "editing",
    label: "Align selection to top",
    description: "Align selected objects along their top edge.",
    bindings: [["Mod", "Shift", "ArrowUp"]],
  },
  {
    id: "edit-align-bottom",
    group: "editing",
    label: "Align selection to bottom",
    description: "Align selected objects along their bottom edge.",
    bindings: [["Mod", "Shift", "ArrowDown"]],
  },
  {
    id: "edit-align-left",
    group: "editing",
    label: "Align selection to left",
    description: "Align selected objects along their left edge.",
    bindings: [["Mod", "Shift", "ArrowLeft"]],
  },
  {
    id: "edit-align-right",
    group: "editing",
    label: "Align selection to right",
    description: "Align selected objects along their right edge.",
    bindings: [["Mod", "Shift", "ArrowRight"]],
  },
  {
    id: "edit-flip-horizontal",
    group: "editing",
    label: "Flip selection horizontally",
    description: "Mirror selected objects across a vertical axis.",
    bindings: [["Shift", "H"]],
  },
  {
    id: "edit-flip-vertical",
    group: "editing",
    label: "Flip selection vertically",
    description: "Mirror selected objects across a horizontal axis.",
    bindings: [["Shift", "V"]],
  },
  {
    id: "edit-show-stroke",
    group: "editing",
    label: "Open stroke colour picker",
    description: "Choose a stroke colour for the selection or active tool.",
    bindings: [["S"]],
    searchTerms: ["color", "outline"],
  },
  {
    id: "edit-show-background",
    group: "editing",
    label: "Open background colour picker",
    description: "Choose a fill colour for the selection or active tool.",
    bindings: [["G"]],
    searchTerms: ["color", "fill"],
  },
  {
    id: "edit-show-fonts",
    group: "editing",
    label: "Open font picker",
    description: "Choose a font for selected or new text.",
    bindings: [["Shift", "F"]],
    searchTerms: ["typeface", "text"],
  },
  {
    id: "edit-decrease-font-size",
    group: "editing",
    label: "Decrease font size",
    description: "Make selected text smaller.",
    bindings: [["Mod", "Shift", "<"]],
    searchTerms: ["text size"],
  },
  {
    id: "edit-increase-font-size",
    group: "editing",
    label: "Increase font size",
    description: "Make selected text larger.",
    bindings: [["Mod", "Shift", ">"]],
    searchTerms: ["text size"],
  },
  {
    id: "edit-enter",
    group: "editing",
    label: "Edit selected object",
    description: "Edit text or points on the selected object.",
    bindings: [["Enter"]],
  },
  {
    id: "edit-cancel",
    group: "editing",
    label: "Finish, deselect, or cancel",
    description: "Leave the current edit, clear selection, or cancel the active tool action.",
    bindings: [["Esc"]],
  },

  {
    id: "pdf-previous-page",
    group: "pdf",
    label: "Previous PDF page",
    description: "Open the preceding PDF page when focus is on the canvas.",
    bindings: [["ArrowLeft"]],
    searchTerms: ["navigate", "page"],
  },
  {
    id: "pdf-next-page",
    group: "pdf",
    label: "Next PDF page",
    description: "Open the following PDF page when focus is on the canvas.",
    bindings: [["ArrowRight"]],
    searchTerms: ["navigate", "page"],
  },
  {
    id: "pdf-resize-rail",
    group: "pdf",
    label: "Resize PDF page rail",
    description: "With the rail resize handle focused, adjust its width; hold Shift for a larger step.",
    bindings: [["ArrowLeft"], ["ArrowRight"], ["Shift", "ArrowLeft"], ["Shift", "ArrowRight"]],
    searchTerms: ["sidebar", "thumbnail width"],
  },
  {
    id: "pdf-resize-rail-limits",
    group: "pdf",
    label: "Set minimum or maximum PDF rail width",
    description: "With the rail resize handle focused, jump to its minimum or maximum width.",
    bindings: [["Home"], ["End"]],
    searchTerms: ["sidebar", "thumbnail width"],
  },

  {
    id: "slides-start-presentation",
    group: "slides",
    label: "Start presentation",
    description: "Present the ordered slide frames from the active slide.",
    bindings: [["Mod", "Alt", "Enter"]],
    searchTerms: ["present", "slideshow", "full screen"],
  },
  {
    id: "slides-collapse-toolbar",
    group: "slides",
    label: "Collapse or expand presentation toolbar",
    description: "Tuck the presentation controls into the bottom-left corner or expand them again.",
    bindings: [["C"]],
    searchTerms: ["hide controls", "bottom left", "presentation controls"],
  },
  {
    id: "slides-next",
    group: "slides",
    label: "Next slide",
    description: "Advance one slide during a presentation.",
    bindings: [["ArrowRight"], ["ArrowDown"], ["PageDown"], ["Space"]],
    searchTerms: ["advance"],
  },
  {
    id: "slides-previous",
    group: "slides",
    label: "Previous slide",
    description: "Go back one slide during a presentation.",
    bindings: [["ArrowLeft"], ["ArrowUp"], ["PageUp"]],
    searchTerms: ["back"],
  },
  {
    id: "slides-first",
    group: "slides",
    label: "First slide",
    description: "Jump to the first slide during a presentation.",
    bindings: [["Home"]],
  },
  {
    id: "slides-last",
    group: "slides",
    label: "Last slide",
    description: "Jump to the final slide during a presentation.",
    bindings: [["End"]],
  },
  {
    id: "slides-exit",
    group: "slides",
    label: "Exit presentation",
    description: "Leave presentation mode and return to the editor.",
    bindings: [["Esc"]],
    searchTerms: ["close", "stop"],
  },
] as const;

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Esc: "Esc",
  PageDown: "Page Down",
  PageUp: "Page Up",
};

export function detectKeyboardShortcutPlatform(
  platformText = typeof navigator === "undefined"
    ? ""
    : `${navigator.platform || ""} ${navigator.userAgent || ""}`,
): KeyboardShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(platformText) ? "apple" : "other";
}

export function formatShortcutKey(
  key: string,
  platform: KeyboardShortcutPlatform,
): string {
  if (key === "Mod") return platform === "apple" ? "Cmd" : "Ctrl";
  if (key === "Alt") return platform === "apple" ? "Option" : "Alt";
  return KEY_LABELS[key] || key;
}

export function formatShortcutBinding(
  binding: KeyboardShortcutBinding,
  platform: KeyboardShortcutPlatform,
): readonly string[] {
  return binding.map((key) => formatShortcutKey(key, platform));
}

export function bindingsForKeyboardShortcut(
  shortcut: KeyboardShortcutDefinition,
  platform: KeyboardShortcutPlatform,
): readonly KeyboardShortcutBinding[] {
  return (platform === "apple" ? shortcut.appleBindings : shortcut.otherBindings)
    || shortcut.bindings;
}

export function shortcutSearchText(
  shortcut: KeyboardShortcutDefinition,
  platform: KeyboardShortcutPlatform,
): string {
  const group = KEYBOARD_SHORTCUT_GROUPS.find((candidate) => candidate.id === shortcut.group);
  return [
    shortcut.label,
    shortcut.description,
    group?.label || "",
    group?.description || "",
    ...(shortcut.searchTerms || []),
    ...bindingsForKeyboardShortcut(shortcut, platform)
      .flatMap((binding) => formatShortcutBinding(binding, platform)),
  ].join(" ").toLocaleLowerCase();
}

export function filterKeyboardShortcuts(
  query: string,
  platform: KeyboardShortcutPlatform,
): readonly KeyboardShortcutDefinition[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return KEYBOARD_SHORTCUTS;
  return KEYBOARD_SHORTCUTS.filter((shortcut) => {
    const haystack = shortcutSearchText(shortcut, platform);
    return terms.every((term) => haystack.includes(term));
  });
}
