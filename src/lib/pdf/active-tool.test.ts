import { describe, expect, it } from "vitest";
import type { PdfActiveTool } from "./active-tool";
import { retainedPdfActiveTool } from "./active-tool";

function tool(type: PdfActiveTool["type"], locked = false): PdfActiveTool {
  return {
    type,
    customType: null,
    lastActiveTool: null,
    locked,
  } as PdfActiveTool;
}

describe("PDF active tool retention", () => {
  it.each([
    "arrow",
    "diamond",
    "ellipse",
    "eraser",
    "freedraw",
    "line",
    "rectangle",
    "text",
  ] as const)("keeps the %s annotation tool armed", (type) => {
    expect(retainedPdfActiveTool(tool(type))).toMatchObject({ type, locked: true });
  });

  it.each(["selection", "hand", "image", "laser"] as const)(
    "does not repeat the %s utility tool",
    (type) => {
      expect(retainedPdfActiveTool(tool(type, true))).toMatchObject({ type, locked: false });
    },
  );

  it("does not carry a wrapper-owned custom tool into another PDF page", () => {
    expect(retainedPdfActiveTool({
      type: "custom",
      customType: "classroom-bucket-fill",
      lastActiveTool: null,
      locked: true,
    } as PdfActiveTool)).toBeNull();
  });

  it("returns a detached tool record", () => {
    const source = tool("rectangle");
    const retained = retainedPdfActiveTool(source);
    expect(retained).not.toBe(source);
    expect(source.locked).toBe(false);
    expect(retained?.locked).toBe(true);
  });
});
