import { describe, expect, it } from "vitest";
import {
  AUTOSAVE_LARGE_PROJECT_BYTES,
  AUTOSAVE_MAX_RECOVERY_MS,
  AUTOSAVE_MEDIUM_PROJECT_BYTES,
  getAutosaveCooldownMs,
  getAutosaveFollowupDelayMs,
  shouldDeferFreehandPersistence,
} from "./autosave-policy";

describe("autosave policy", () => {
  it("defers timer serialization only while a native freehand stroke is active", () => {
    expect(shouldDeferFreehandPersistence({ newElement: { type: "freedraw" } })).toBe(true);
    expect(shouldDeferFreehandPersistence({ newElement: null })).toBe(false);
    expect(shouldDeferFreehandPersistence({})).toBe(false);
    expect(shouldDeferFreehandPersistence({ newElement: { type: "rectangle" } })).toBe(false);
  });
  it("allows interrupted ink to save despite a stale native newElement, but defers the next stroke", () => {
    expect(shouldDeferFreehandPersistence({ newElement: { type: "freedraw", id: "cancelled" } }, "cancelled")).toBe(false);
    expect(shouldDeferFreehandPersistence({ newElement: { type: "freedraw", id: "next" } }, "cancelled")).toBe(true);
  });
  it("keeps small projects immediate", () => {
    expect(getAutosaveCooldownMs(AUTOSAVE_MEDIUM_PROJECT_BYTES - 1)).toBe(0);
  });

  it("spaces out complete saves as project memory pressure grows", () => {
    expect(getAutosaveCooldownMs(AUTOSAVE_MEDIUM_PROJECT_BYTES)).toBe(1_500);
    expect(getAutosaveCooldownMs(AUTOSAVE_LARGE_PROJECT_BYTES)).toBe(4_000);
  });

  it("accounts for time already spent in the current save", () => {
    expect(getAutosaveFollowupDelayMs(1, 200)).toBe(500);
    expect(getAutosaveFollowupDelayMs(AUTOSAVE_LARGE_PROJECT_BYTES, 3_750)).toBe(250);
    expect(getAutosaveFollowupDelayMs(AUTOSAVE_LARGE_PROJECT_BYTES, 5_000)).toBe(0);
  });

  it("gives a slow device recovery time in proportion to its last save", () => {
    expect(getAutosaveCooldownMs(1, 1_000)).toBe(4_000);
    expect(getAutosaveFollowupDelayMs(1, 2_500, 1_000)).toBe(1_500);
    expect(getAutosaveCooldownMs(1, 60_000)).toBe(
      60_000 + AUTOSAVE_MAX_RECOVERY_MS,
    );
    expect(getAutosaveFollowupDelayMs(1, 60_000, 60_000))
      .toBe(AUTOSAVE_MAX_RECOVERY_MS);
  });
});
