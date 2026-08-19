import { describe, expect, it } from "vitest";
import { inspectLocalImageBlob } from "./image-safety";
import {
  GEOGON_SVG_EXPORT_MARKER,
  geoGonSvgFromClipboardText,
} from "./geogon";

const exportedSvg = `
  <svg width="640" height="480" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 640 480" role="img" aria-label="3DGeoGon viewport image">
    <!-- ${GEOGON_SVG_EXPORT_MARKER} -->
    <g class="layer">
      <title>Layer 1</title>
      <polygon points="20,20 180,40 120,180" fill="#7db3e8" fill-opacity="0.14" stroke="none"/>
      <line x1="20" y1="20" x2="120" y2="180" stroke="#000000"/>
      <path d="M20 20 L180 40" fill="none" stroke="#000000"/>
      <text x="20" y="18">A</text>
    </g>
  </svg>
`;

describe("3DGeoGon clipboard handoff", () => {
  it("recognizes and preflights the site's self-contained vector export", async () => {
    const source = geoGonSvgFromClipboardText(exportedSvg);
    expect(source).toContain(GEOGON_SVG_EXPORT_MARKER);

    await expect(inspectLocalImageBlob(new Blob([source!], { type: "image/svg+xml" })))
      .resolves.toMatchObject({
        mimeType: "image/svg+xml",
        width: 640,
        height: 480,
      });
  });

  it("does not claim arbitrary SVG or prose containing the product name", () => {
    expect(geoGonSvgFromClipboardText('<svg width="10" height="10"></svg>')).toBeNull();
    expect(geoGonSvgFromClipboardText("Created with 3DGeoGon true vector SVG export"))
      .toBeNull();
  });

  it("leaves active or remote resources for the image safety gate to reject", async () => {
    const source = geoGonSvgFromClipboardText(`
      <svg width="10" height="10" xmlns="http://www.w3.org/2000/svg">
        <!-- ${GEOGON_SVG_EXPORT_MARKER} -->
        <image href="https://example.invalid/payload.png"/>
      </svg>
    `);
    expect(source).not.toBeNull();
    await expect(inspectLocalImageBlob(new Blob([source!], { type: "image/svg+xml" })))
      .rejects.toThrow(/external|active/i);
  });
});
