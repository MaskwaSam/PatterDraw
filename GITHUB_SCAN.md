# GitHub scan: Excalidraw slides, PDF workflows, and classroom safety

Snapshot date: **2026-07-12**. Repository activity and star counts are point-in-time indicators, not permanent guarantees.

## Decision

No reviewed repository is a safe drop-in. Build a new wrapper around the official [`@excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) component and reuse only narrowly compatible MIT-licensed ideas.

The official package supplies the right low-level primitives—frames, frame-aware export, laser, scene/files APIs, and viewport navigation—but no complete slide manager or PDF import workflow. Pin [`0.18.1`](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1): it is the security patch release that backports the Mermaid XSS mitigation. The associated advisory is [GHSA-39h7-pwv7-rc3x](https://github.com/excalidraw/excalidraw/security/advisories/GHSA-39h7-pwv7-rc3x).

## Slide and presentation projects

| Project | July 2026 snapshot | Useful ideas | Decision |
|---|---:|---|---|
| [Excalidraw](https://github.com/excalidraw/excalidraw) | ~127k stars; active | Official frames, frame export, laser, `scrollToContent`, `updateFrameRendering`, scene/files APIs | Foundation |
| [Excalihub](https://github.com/AykutSarac/excalihub) | 12 stars; updated 2026-03 | Frame rail, drag ordering, keyboard/fullscreen navigation, viewport restoration | UX/code reference only |
| [Excalidraw Smart Presentation](https://github.com/excalidraw-smart-presentation/excalidraw-smart-presentation.github.io) | 95 stars; branch updated 2025-07 | Frame-to-slide mode and matched-object transitions | Animation research only |
| [mukeshsoni/excalidraw-presentation](https://github.com/mukeshsoni/excalidraw-presentation) | 3 stars; updated 2024-11 | Wrapper proof of concept, thumbnails, ordering, PDF/PPTX raster export | Do not depend on it |
| [Obsidian Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | ~7.3k stars; active | Strong slideshow UX, laser, path views, PDF workflows | Clean-room UX reference; AGPL |
| [Excalideck](https://github.com/excalideck/excalideck) | 193 stars; last default-branch commit 2021 | Explicit deck schema and thumbnail caching | Too old for a base |
| [excalidraw-slides](https://github.com/scastiel/excalidraw-slides) | 170 stars; last default-branch commit 2020 | Minimal multi-scene slide model | Obsolete Excalidraw API |

Official frame APIs arrived in [PR #7205](https://github.com/excalidraw/excalidraw/pull/7205), with frame-aware export in [PR #7210](https://github.com/excalidraw/excalidraw/pull/7210). Excalihub's compact [`presentation.ts`](https://github.com/AykutSarac/excalihub/blob/main/src/presentation.ts) is the best reference for fullscreen, keyboard handling, focus restoration, and resize behavior, but its browser-extension bridge and hosted AI permissions are out of scope.

The chosen model is one live Excalidraw scene containing normal frames plus app-owned ordered metadata. Presentation keeps the editor live so laser and persistent ink work; most existing wrappers switch to a raster or view-only presentation and cannot supply that behavior.

## PDF and OpenBoard findings

Excalidraw itself has no released PDF import workflow. [PDF import #7727](https://github.com/excalidraw/excalidraw/issues/7727) and [PDF annotation #10658](https://github.com/excalidraw/excalidraw/issues/10658) remain open. The open [PDF export PR #10854](https://github.com/excalidraw/excalidraw/pull/10854) explores jsPDF plus svg2pdf.js but does not solve imported multipage ownership or off-page annotations.

OpenBoard's behavior was verified in source:

- [`UBImportPDF.cpp`](https://github.com/OpenBoard-org/OpenBoard/blob/master/src/adaptors/UBImportPDF.cpp) imports each PDF page as the locked background of a scene.
- The [official OpenBoard manual](https://openboard.ch/download/Tutoriel_OpenBoard_1.6EN.pdf) documents direct mouse/stylus thumbnail reordering in the Board-mode Flatplan, while the [Documents-mode guide](https://openboard.ch/download/OpenBoard1.6_Mode_Doc_in_1_pageEN.pdf) documents moving selected pages at an insertion point.
- [`UBDocumentThumbnailWidget.cpp`](https://github.com/OpenBoard-org/OpenBoard/blob/master/src/gui/UBDocumentThumbnailWidget.cpp) implements the current before/after drop marker used during page rearrangement.
- [`UBGraphicsScene.cpp`](https://github.com/OpenBoard-org/OpenBoard/blob/master/src/domain/UBGraphicsScene.cpp) computes visible-content bounds including off-page annotations.
- [`UBExportFullPDF.cpp`](https://github.com/OpenBoard-org/OpenBoard/blob/master/src/adaptors/UBExportFullPDF.cpp) merges the source PDF page beneath an annotation overlay.
- [OpenBoard PR #649](https://github.com/OpenBoard-org/OpenBoard/pull/649) confirms that overflow is scaled into the original paper dimensions.

That corrects an easy misconception: OpenBoard does **not** enlarge the PDF paper. Canvas Classroom therefore exposes two explicit modes. “Expand pages” implements the requested preserve-scale behavior; “Fit like OpenBoard” reproduces the observed OpenBoard geometry independently without copying GPL source.

Recommended v1 architecture:

- [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) reads local bytes and renders rebuildable page previews.
- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) is isolated behind the PDF exporter for the initial writer implementation.
- A project-owned `pdfPageOrder` stores the ordered PDF scene IDs. The PDF workspace shows the real locked backgrounds as thumbnails, with mouse/stylus drag plus keyboard/touch move controls. Navigation, autosave, project files, and export consume the same order.
- Original source bytes remain in the project. Export embeds original page content beneath a high-resolution transparent annotation layer.
- New output PDFs intentionally omit source JavaScript, attachments, forms, top-level links, and other interactive document behavior. pdf-lib's limitation around retained links is tracked in [issue #1362](https://github.com/Hopding/pdf-lib/issues/1362).

Future writer candidates include active but beta [LibPDF](https://github.com/LibPDF-js/core) and a jsPDF/svg2pdf.js vector-overlay path. The active [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer) project is attractive only if the product later becomes a native PDF editor rather than an Excalidraw canvas.

## LaTeX findings

Excalidraw 0.18.1 exposes image/file and scene APIs but no built-in equation tool or LaTeX conversion API. Canvas Classroom therefore renders equations in its wrapper and inserts the result as an ordinary Excalidraw image, retaining the source LaTeX in element metadata for later editing. The relevant official surfaces are the [v0.18.1 exports](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/index.tsx), [imperative API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api), and [element skeleton API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton).

[MathJax 4.1.3](https://www.npmjs.com/package/mathjax) was selected over KaTeX because MathJax directly produces standalone SVG suitable for an Excalidraw image element. It is self-hosted according to MathJax's [local hosting guidance](https://docs.mathjax.org/en/latest/web/hosting.html), uses local font ranges, and follows MathJax's [untrusted-input guidance](https://docs.mathjax.org/en/latest/web/typeset.html). No remote equation service or CDN is used.

## Mermaid without AI

Mermaid is useful independently of AI, but Excalidraw's native dialog previews continuously and can fall back to generated SVG images. Canvas Classroom therefore keeps `aiEnabled={false}` and uses a wrapper-owned explicit Preview/Insert dialog around pinned `@excalidraw/mermaid-to-excalidraw` 2.2.2 and Mermaid 11.16.0. The converter is loaded locally only on Preview, and only diagram families that produce native editable Excalidraw objects are accepted.

The version choice includes Excalidraw's [Mermaid conversion XSS patch](https://github.com/excalidraw/excalidraw/security/advisories/GHSA-39h7-pwv7-rc3x). Mermaid's documented default `securityLevel: "strict"` encodes HTML and disables click behavior, but the wrapper also rejects diagram-authored configuration, HTML, links, styles, URLs, and SVG-image fallback rather than relying on that single setting.

## Student safety and Moodle

Additional Excalidraw advisories reinforce blocking web content: embedded-webpage XSS [GHSA-m64q-4jqh-f72f](https://github.com/excalidraw/excalidraw/security/advisories/GHSA-m64q-4jqh-f72f) and link XSS [GHSA-v7v8-gjv7-ffmr](https://github.com/excalidraw/excalidraw/security/advisories/GHSA-v7v8-gjv7-ffmr). The wrapper disables AI, validates embeds as false, renders no embeds, intercepts link opening, sanitizes imported scenes, bundles assets, and enforces a restrictive CSP.

No maintained Moodle Excalidraw activity was found. Moodle's [`mod_whiteboard`](https://moodle.org/plugins/mod_whiteboard) embeds external Miro or Conceptboard services and explicitly carries external-provider data implications. [Hyperchalk](https://github.com/Hyperchalk/Hyperchalk) is an older Django/Redis/LTI platform rather than a Moodle plugin and does not match the local-first requirement.

The clean Moodle direction is a new `mod_excalidrawclassroom`: Moodle-native capabilities, local file APIs, per-user work, teacher templates, completion/submission, backup/restore, and a privacy provider, with no LTI or external service.

## Reuse rules

- MIT snippets require retained license notices and should be rewritten around the current official API rather than copied wholesale.
- GPL/AGPL projects—including OpenBoard and Obsidian Excalidraw—are behavioral research only for the MIT standalone app.
- Hide the current Excalidraw viewport call behind an app adapter because upstream master is evolving beyond `scrollToContent`.
- Do not introduce a hosted share, collaboration backend, remote library, analytics package, or embed allowlist into the student distribution.
