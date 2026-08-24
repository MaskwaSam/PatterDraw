import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEATURE_PREFERENCES } from "../lib/feature-preferences";
import { DEFAULT_PDF_PREFERENCES } from "../lib/pdf/pdf-preferences";
import { SettingsMenu } from "./SettingsMenu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("SettingsMenu PDF preferences", () => {
  it("exposes the visual fallback as an offer with per-export confirmation", () => {
    const onPdfPreferenceChange = vi.fn();
    const onOpenShortcutHelp = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(createElement(SettingsMenu, {
      preferences: { ...DEFAULT_FEATURE_PREFERENCES },
      pdfPreferences: { ...DEFAULT_PDF_PREFERENCES },
      themePreference: "light",
      onPreferenceChange: vi.fn(),
      onPdfPreferenceChange,
      onThemePreferenceChange: vi.fn(),
      onOpenShortcutHelp,
      onRestorePdfDefaults: vi.fn(),
      onRestoreDefaults: vi.fn(),
    })));

    const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
    act(() => settings?.click());
    const fallback = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')]
      .find((input) => input.getAttribute("aria-label") === "Offer visual PDF fallback");
    expect(fallback?.checked).toBe(true);
    expect(container.textContent).toContain(
      "When vector export is unavailable, offer a visual PDF; confirmation is required every time",
    );
    const fallbackDescriptionId = fallback?.getAttribute("aria-describedby");
    expect(fallbackDescriptionId).toBeTruthy();
    expect(document.getElementById(fallbackDescriptionId || "")?.textContent).toBe(
      "When vector export is unavailable, offer a visual PDF; confirmation is required every time",
    );

    act(() => fallback?.click());
    expect(onPdfPreferenceChange).toHaveBeenCalledWith("offerVisualPdfFallback", false);

    const pdfGroup = container.querySelector('[aria-labelledby="pdf-settings-label"]');
    expect([...(pdfGroup?.querySelectorAll<HTMLInputElement>('input[role="switch"]') ?? [])]
      .map((input) => input.getAttribute("aria-label"))).toEqual([
        "Dark PDF preview",
        "Sharper active PDF page",
        "Offer visual PDF fallback",
      ]);

    const shortcutHelp = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Keyboard shortcuts"));
    expect(shortcutHelp?.textContent).toContain("?");
    act(() => shortcutHelp?.click());
    expect(onOpenShortcutHelp).toHaveBeenCalledOnce();
    expect(onOpenShortcutHelp).toHaveBeenCalledWith(settings);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
