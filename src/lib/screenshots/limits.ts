export const SCREENSHOT_PREFERRED_SCALE = 2;
export const MAX_SCREENSHOT_EDGE = 2_048;
export const MAX_SCREENSHOT_PIXELS = 4_000_000;
export const MAX_SCREENSHOT_BYTES = 4_000_000;
export const MAX_SCREENSHOT_DATE_MS = 8_640_000_000_000_000;
/**
 * Screenshot selection is limited to the visible viewport and Excalidraw's
 * minimum 10% zoom. This leaves ample room for large displays while rejecting
 * corrupted IndexedDB geometry that can destabilize element bounds math.
 */
export const MAX_SCREENSHOT_SCENE_EDGE = 100_000;
