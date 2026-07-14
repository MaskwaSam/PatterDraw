import { beforeEach, describe, expect, it, vi } from "vitest";

const parseMermaidToExcalidraw = vi.fn();
vi.mock("@excalidraw/mermaid-to-excalidraw/dist/index.js", () => ({ parseMermaidToExcalidraw }));
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (elements: Array<Record<string, unknown>>) => elements.map((element, index) => ({
    id: `element-${index}`,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    groupIds: [],
    isDeleted: false,
    ...element,
  })),
  getCommonBounds: (elements: Array<{ x: number; y: number; width: number; height: number }>) => [
    Math.min(...elements.map((element) => element.x)),
    Math.min(...elements.map((element) => element.y)),
    Math.max(...elements.map((element) => element.x + element.width)),
    Math.max(...elements.map((element) => element.y + element.height)),
  ],
}));

import { renderMermaidToElements, validateMermaidSource } from "./safe-mermaid";

describe("student-safe Mermaid input", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    "flowchart LR\n  A[Start] --> B[Finish]",
    "sequenceDiagram\n  Student->>Teacher: Question",
    "classDiagram\n  class Student",
    "erDiagram\n  STUDENT ||--o{ COURSE : takes",
    "stateDiagram-v2\n  [*] --> Ready",
  ])("accepts an editable diagram family", (source) => {
    expect(validateMermaidSource(source)).toBe(source);
  });

  it.each([
    ["---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B", /frontmatter/],
    ["%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\nA-->B", /configuration directives/],
    ["flowchart LR\nA-->B\nclick A href https://example.test", /links and callbacks/],
    ["flowchart LR\nA[<img src=x onerror=alert(1)>]", /HTML/],
    ["flowchart LR\nclassDef bad fill:url(https://example.test)", /style directives/],
    ["gantt\n  title Unsafe fallback", /flowchart, sequence, class, ER, or state/],
  ])("rejects unsafe Mermaid source", (source, message) => {
    expect(() => validateMermaidSource(source)).toThrow(message);
  });

  it("strips links and unsafe colors before conversion", async () => {
    parseMermaidToExcalidraw.mockResolvedValueOnce({
      elements: [{
        type: "rectangle",
        x: 0,
        y: 0,
        width: 120,
        height: 60,
        link: "https://example.test",
        strokeColor: "url(https://example.test/paint)",
        bgColor: "#ffffff",
        label: { text: "Safe", color: "javascript:alert(1)" },
      }],
      files: {},
    });

    const result = await renderMermaidToElements("flowchart LR\nA-->B");
    expect(result.elements).toHaveLength(1);
    expect(result.elements.every((element) => element.link === null)).toBe(true);
    expect(parseMermaidToExcalidraw).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ securityLevel: "strict", htmlLabels: false, maxEdges: 180 }),
    );
  });

  it("rejects SVG-image fallback output", async () => {
    parseMermaidToExcalidraw.mockResolvedValueOnce({
      elements: [{ type: "image", x: 0, y: 0, width: 100, height: 100, fileId: "unsafe" }],
      files: { unsafe: { id: "unsafe", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" } },
    });
    await expect(renderMermaidToElements("flowchart LR\nA-->B")).rejects.toThrow(/SVG image fallback/);
  });
});
