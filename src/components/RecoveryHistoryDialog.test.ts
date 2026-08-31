import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutosaveHistorySummary } from "../lib/autosave-history";
import { RecoveryHistoryDialog } from "./RecoveryHistoryDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const sha = (character: string) => character.repeat(64);

function summary(
  snapshotId: string,
  title: string,
  capturedAt: string,
  pdfCount = 0,
): AutosaveHistorySummary {
  return {
    schemaVersion: 1,
    snapshotId,
    projectId: `project-${title}`,
    title,
    capturedAt,
    projectUpdatedAt: capturedAt,
    manifestSha256: sha("a"),
    manifestBytes: 2_048,
    logicalBytes: 3_145_728,
    pdfReferences: Array.from({ length: pdfCount }, (_, index) => ({
      sha256: sha(String(index + 1)),
      byteLength: 1_024,
    })),
  };
}

const entries = [
  summary("newest", "Tuesday lesson", "2026-08-30T18:00:00.000Z", 1),
  summary("middle", "Periodic table", "2026-08-29T18:00:00.000Z"),
  summary("oldest", "Monday lesson", "2026-08-28T18:00:00.000Z"),
];

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button ${label} was not rendered.`);
  return match;
}

function mount(overrides: Partial<Parameters<typeof RecoveryHistoryDialog>[0]> = {}) {
  const callbacks = {
    onClearAll: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onRecover: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(RecoveryHistoryDialog, {
    entries,
    ...callbacks,
    ...overrides,
  })));
  return { callbacks, container };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);
});

afterEach(() => {
  act(() => {
    while (roots.length) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RecoveryHistoryDialog recovery management", () => {
  it("lists and selects every retained copy, including a known damaged copy", () => {
    const { callbacks, container } = mount({
      damagedSnapshotIds: new Set(["middle"]),
    });

    expect(container.querySelectorAll('input[name="recovery-history-copy"]')).toHaveLength(3);
    expect(container.textContent).toContain("3 of 6 copies");
    expect(container.textContent).toContain("Tuesday lesson");
    expect(container.textContent).toContain("Periodic table");
    expect(container.textContent).toContain("Monday lesson");
    expect(container.textContent).toContain("Damaged or incomplete");
    expect(document.activeElement).toBe(button(container, "Close"));

    const oldest = container.querySelector<HTMLInputElement>('input[value="oldest"]');
    act(() => oldest?.click());
    act(() => button(container, "Recover selected").click());
    expect(callbacks.onRecover).toHaveBeenCalledWith("oldest");
  });

  it("requires a second explicit confirmation before deleting one copy", () => {
    const { callbacks, container } = mount();

    act(() => button(container, "Delete selected…").click());
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Your current board");
    expect(document.activeElement).toBe(button(container, "Keep recovery copies"));

    act(() => button(container, "Delete recovery copy").click());
    expect(callbacks.onDelete).toHaveBeenCalledOnce();
    expect(callbacks.onDelete).toHaveBeenCalledWith("newest");
  });

  it("requires exact clear-all confirmation and keeps copies when cancelled", () => {
    const { callbacks, container } = mount();

    act(() => button(container, "Delete all…").click());
    expect(callbacks.onClearAll).not.toHaveBeenCalled();
    expect(container.textContent).toContain("permanently removes all 3 protected copies");
    act(() => button(container, "Keep recovery copies").click());
    expect(callbacks.onClearAll).not.toHaveBeenCalled();

    act(() => button(container, "Delete all…").click());
    act(() => button(container, "Delete all 3 copies").click());
    expect(callbacks.onClearAll).toHaveBeenCalledOnce();
  });

  it("renders an accessible empty state and disables destructive actions", () => {
    const { container } = mount({ entries: [] });

    expect(container.textContent).toContain("No protected copies");
    expect(button(container, "Delete selected…").disabled).toBe(true);
    expect(button(container, "Delete all…").disabled).toBe(true);
    expect(button(container, "Recover selected").disabled).toBe(true);
  });

  it("offers an explicit store-wide repair when a damaged index cannot be listed", () => {
    const { callbacks, container } = mount({ entries: [], unreadableHistory: true });

    expect(container.textContent).toContain("Recovery history cannot be listed");
    expect(button(container, "Delete all…").disabled).toBe(false);
    act(() => button(container, "Delete all…").click());
    expect(container.textContent).toContain("unlisted remnants");
    expect(callbacks.onClearAll).not.toHaveBeenCalled();
    act(() => button(container, "Delete all recovery data").click());
    expect(callbacks.onClearAll).toHaveBeenCalledOnce();
  });
});
