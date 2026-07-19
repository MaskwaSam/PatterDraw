# Architecture

## Runtime boundary

The standalone app owns file handling, safety policy, persistence, workspace mode, equation and Mermaid rendering, slide metadata, PDF workspaces, presentation controls, and export. Excalidraw remains an unmodified pinned npm dependency. All integration goes through its public component and imperative APIs.

```text
Local files / Moodle
        |
Project codec + import validation
        |
Classroom project model
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

## Equations

MathJax 4.1.3 is lazy-loaded from local build assets only when the equation editor opens. Validated LaTeX is converted to SVG, sanitized with an explicit SVG allowlist, stored as a local Excalidraw image file, and inserted as an ordinary movable image element. The source expression and renderer version live in `customData.classroomLatex`, allowing a selected equation to be edited and regenerated without inventing a second canvas object model.

The renderer rejects remote links, HTML, external resources, extension loading, Unicode escapes, and user-defined macros before MathJax runs. MathJax's safe extension and a render timeout are defense-in-depth; the final serialized SVG is independently sanitized before it becomes a data URL.

## Mermaid diagrams

AI stays disabled at the Excalidraw component boundary. A wrapper-owned Mermaid dialog performs no work while the user types: **Preview** lazily loads the pinned local converter, validates the source, renders an image preview, and only then enables **Insert**. Flowchart, sequence, class, ER, and state definitions convert to native editable Excalidraw objects.

The source is capped at 10,000 characters and 400 lines. Frontmatter, Mermaid configuration directives, links, callbacks, HTML, custom CSS/style directives, URLs, images, and icons are rejected before parsing. Mermaid is fixed to strict security, local-only settings and conservative edge limits. Converter output is rejected if it contains files or image fallback, unsafe element types, links, non-finite geometry, too many elements, or excessive bounds. Every inserted element stores an inert `customData.classroomMermaid` source record so a selected diagram can be revalidated and edited later.

## Full-board export

The primary **Export all** action sends all live, non-deleted elements and local files to Excalidraw's PNG exporter rather than using viewport state. Frame clipping is disabled so objects extending beyond frames remain visible. Output dimensions are scaled, never cropped, to stay within an 8,192-pixel edge and 16-megapixel browser-canvas budget. The PNG embeds editable scene metadata where supported; `.patterdraw` remains the authoritative multi-scene project backup.

## Safety layers

1. Build-time source check rejects direct remote scripts, styles, imports, fetches, live channels, telemetry, iframes, collaboration UI, and remote-library routing.
2. CSP limits connections to the current origin and blocks frames, objects, and external navigation helpers.
3. Imports strip links and reject iframe/embeddable elements and non-local image sources.
4. Paste and link-open hooks block remote URLs and embedded HTML.
5. PDF.js receives local bytes; the app never instantiates its scripting manager or invokes PDF JavaScript APIs, and the exporter creates a fresh output document.
6. MathJax is self-hosted, receives validated input, and its output passes an independent SVG allowlist before insertion.
7. Mermaid is self-hosted, AI-free, source-allowlisted, and restricted to native editable output with no file/SVG fallback.
8. Capturing navigation and network guards block external anchors as well as fetch/XHR/beacon/window-open paths.
9. Browser tests must assert that no request leaves the launch origin.
