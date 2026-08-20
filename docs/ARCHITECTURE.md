# Architecture

## Runtime boundary

The standalone app owns file handling, safety policy, persistence, workspace mode, equation and Mermaid rendering, slide metadata, PDF workspaces, presentation controls, and export. Excalidraw remains an unmodified pinned npm dependency. All integration goes through its public component and imperative APIs.

```text
Local files / Moodle
        |
Project codec + import validation
        |
PatterDraw project model
   |            |             |             |
Scenes       Slide order   PDF page order   Original PDFs
   |            |             |             |
Excalidraw   Presenter     Page rail       PDF.js preview
   |____________|_____________|_____________|
          |             |
 Local renderers    Export adapters
```

## Project format

`.patterdraw` is a ZIP container with a versioned `project.json` manifest and source PDFs under `documents/<id>.pdf`. Legacy `.canvasclassroom` archives use the same validated format and remain importable. Excalidraw image files remain in scene data as local data URLs. Source PDFs are binary entries rather than base64 JSON so projects remain inspectable and do not incur base64 expansion.

The model records:

- Independent scenes, including one scene per imported PDF page.
- Explicit ordered slide entries pointing to ordinary frame IDs.
- Explicit ordered PDF page scene IDs, normalized for legacy v1 files that predate the field.
- PDF page ownership, source page index, display size, rotation, and locked background element ID.
- Source PDF metadata and archive path.

Archive paths are allowlisted, project loads are transactional, and manifests are sanitized before they reach Excalidraw.

## PDF geometry

Each PDF page occupies scene coordinates `(0, 0, pageWidth, pageHeight)`. Annotation bounds are calculated with Excalidraw's own bounds utility so rotated elements, text, line points, and stroke extents follow editor behavior.

Expanded export unions the original page with annotation bounds plus padding. The new PDF media box uses that union while the original page is embedded at its translated location. Annotation PNG coordinates are converted from Excalidraw's top-left/downward axis to PDF's bottom-left/upward axis.

OpenBoard-fit export uses the same union, scales it uniformly into the original page dimensions, and centers the result. Both modes keep one output page per imported page and emit pages in the exact `pdfPageOrder` shown in PDF mode.

`pdfPageOrder` stores scene IDs only. Reordering never changes `pdfPage.pageIndex`: that value remains the immutable lookup into the original source PDF, so its background and annotations cannot detach when a teacher moves the page. Legacy projects derive document-insertion/source-page order once and save the normalized result on the next autosave. The PDF rail uses each scene's locked local background image as its thumbnail, supports before/after drag placement, and exposes move-up/down buttons for keyboard and touch users.

The initial annotation layer is high-resolution transparent raster. Keeping the source page embedded separately preserves its vector/text appearance. A future vector overlay must pass Unicode, bundled-font, transparency, freehand, and image fixture tests before replacing the raster path.

## Slides

Frames remain source-of-truth visual boundaries. `slideOrder` provides stable ordering and titles without inferring order from canvas position after creation. New frames are seeded row-by-row, then drag order is authoritative.

`workspaceMode` is UI-only and defaults to `board`. Turning Slides on reveals the frame rail and presentation/export controls without remounting Excalidraw or changing the scene. Opening a saved project or Excalidraw file returns to board mode; importing a PDF enters PDF mode so its ordered page rail is immediately available.

Presentation focuses frames through a single adapter around Excalidraw's viewport API. Frame chrome and normal editor UI are hidden, but the live canvas remains active. Laser is transient; free-draw ink is stored as ordinary scene elements and therefore participates in autosave and export.

Presentation PDF and PowerPoint export both follow `slideOrder` and render each referenced frame from the current persisted scene. PowerPoint export is a deliberately high-fidelity visual snapshot: each slide contains one locally generated PNG with the PatterDraw slide title stored as alternative text. This preserves Excalidraw appearance without introducing remote assets or translating drawings into an incomplete second object model; the `.patterdraw` file remains the editable source.

A PowerPoint deck has one global page size. Projects set to 4:3 export as 4:3; 16:9, freeform, and legacy projects export as 16:9. Frames with a different shape are proportionally contained on white, never stretched or cropped. The exporter applies stricter PPTX-specific raster limits plus per-slide and per-deck encoded-PNG byte limits before retaining base64 images, preventing high-entropy photos or very large decks from exhausting browser memory. The exact-pinned local `pptxgenjs` package is dynamically imported only when the user chooses **PowerPoint (.pptx)**, keeping its serialization code out of the initial editor bundle.

## Equations

MathJax 4.1.3 is lazy-loaded from local build assets only when the equation editor opens. Validated LaTeX is converted to SVG, sanitized with an explicit SVG allowlist, stored as a local Excalidraw image file, and inserted as an ordinary movable image element. The source expression and renderer version live in `customData.classroomLatex`, allowing a selected equation to be edited and regenerated without inventing a second canvas object model.

The renderer rejects remote links, HTML, external resources, extension loading, Unicode escapes, and user-defined macros before MathJax runs. MathJax's safe extension and a render timeout are defense-in-depth; the final serialized SVG is independently sanitized before it becomes a data URL.

## Mermaid diagrams

AI stays disabled at the Excalidraw component boundary. A wrapper-owned Mermaid dialog performs no work while the user types: **Preview** lazily loads the pinned local converter, validates the source, renders an image preview, and only then enables **Insert**. Flowchart, sequence, class, ER, and state definitions convert to native editable Excalidraw objects.

The source is capped at 10,000 characters and 400 lines. Frontmatter, Mermaid configuration directives, links, callbacks, HTML, custom CSS/style directives, URLs, images, and icons are rejected before parsing. Mermaid is fixed to strict security, local-only settings and conservative edge limits. Converter output is rejected if it contains files or image fallback, unsafe element types, links, non-finite geometry, too many elements, or excessive bounds. Every inserted element stores an inert `customData.classroomMermaid` source record so a selected diagram can be revalidated and edited later.

## 3D GeoGon tool workspace

GeoGon 0.2.10 is copied byte-for-byte from a pinned upstream commit into `public/geogon/` and verified by a per-file hash inventory. A default-off experimental Math Tools card opens it in one wrapper-owned, same-origin dialog with only the sandbox capabilities its local editor and download controls require. Production responses give that local subapplication a separate CSP with `connect-src 'none'` and allow only same-origin framing; the main PatterDraw document remains non-frameable. Because the direct export handoff requires both `allow-scripts` and `allow-same-origin`, GeoGon is trusted, integrity-pinned vendor code rather than a hostile-content isolation boundary; the hash gate and child CSP are the controlling safeguards.

The live editor is not an Excalidraw element and no iframe or editable GeoGon state enters `.patterdraw`. **Insert into PatterDraw** reads the pinned same-origin export API, requires GeoGon's true-vector marker, applies the ordinary SVG resource and size preflight, and stores the result as a local image with inert `customData.classroomGeoGon` provenance. GeoGon's own device-local working state is separate from project persistence. Arbitrary URLs and Excalidraw iframe, embeddable, and magic-frame elements remain blocked at every import, paste, live-scene, library, autosave, and export boundary.

## Full-board export

The primary **Export all** action sends all live, non-deleted elements and local files to Excalidraw's PNG exporter rather than using viewport state. Frame clipping is disabled so objects extending beyond frames remain visible. Output dimensions are scaled, never cropped, to stay within an 8,192-pixel edge and 16-megapixel browser-canvas budget. The PNG embeds editable scene metadata where supported; `.patterdraw` remains the authoritative multi-scene project backup.

## Safety layers

1. Build-time source check rejects direct remote scripts, styles, imports, fetches, live channels, telemetry, collaboration UI, remote-library routing, and every iframe except the exact reviewed local GeoGon dialog.
2. CSP limits connections to the current origin, blocks external frames and objects, and gives the bundled GeoGon response a separate no-connect, same-origin-frame-only policy.
3. Imports strip links and reject iframe/embeddable elements and non-local image sources.
4. Paste and link-open hooks block remote URLs and embedded HTML.
5. PDF.js receives local bytes; the app never instantiates its scripting manager or invokes PDF JavaScript APIs, and the exporter creates a fresh output document.
6. MathJax is self-hosted, receives validated input, and its output passes an independent SVG allowlist before insertion.
7. Mermaid is self-hosted, AI-free, source-allowlisted, and restricted to native editable output with no file/SVG fallback.
8. Capturing navigation and network guards block external anchors as well as fetch/XHR/beacon/window-open paths.
9. Browser tests must assert that no request leaves the launch origin.
