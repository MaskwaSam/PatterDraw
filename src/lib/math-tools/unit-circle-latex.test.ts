import { describe, expect, it, vi } from "vitest";

const { renderLatexToSvgMock } = vi.hoisted(() => ({
  renderLatexToSvgMock: vi.fn(),
}));

vi.mock("../latex/render-latex", () => ({
  renderLatexToSvg: renderLatexToSvgMock,
}));

import { createUnitCircleMathJaxAsset } from "./unit-circle-latex";

describe("unit-circle MathJax assets", () => {
  it("loads the local renderer on demand and reuses the cached variant", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><path d="M0 0h2v1H0z"/></svg>';
    renderLatexToSvgMock.mockImplementation(async (source: string) => ({
      source,
      svg,
      dataUrl: "data:image/svg+xml;base64,",
      width: 2,
      height: 1,
    }));

    const first = await createUnitCircleMathJaxAsset("degrees", false);

    expect(renderLatexToSvgMock).toHaveBeenCalledTimes(16);
    expect(first.asset.svg).toContain('data-label-renderer="mathjax"');
    expect(first.asset.svg).toContain('viewBox="0 0 2 1"');
    expect(first.metadata.labelMode).toBe("degrees");
    expect(first.metadata.showCoordinates).toBe(false);

    const cached = await createUnitCircleMathJaxAsset("degrees", false);
    expect(cached).toBe(first);
    expect(renderLatexToSvgMock).toHaveBeenCalledTimes(16);
  });
});
