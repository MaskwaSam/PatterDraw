# PatterDraw

PatterDraw is a separate, offline-first classroom whiteboard built on the official Excalidraw component. It opens as a full-width board, removes hosted collaboration and web-content surfaces, and lets the teacher turn slide controls on only when they are needed. Imported PDF pages become locked backgrounds with writable infinite space around them.

PatterDraw is an independent project and is not affiliated with, endorsed by, or maintained by Excalidraw.

This repository is intentionally independent from PolyPad. Nothing here patches `PolyPadV38` or `mod_polypad`.

![Editor design reference](design/editor-concept.png)

## Current vertical slice

- Locally bundled `@excalidraw/excalidraw@0.18.1` with collaboration, AI, embeds, external links, public-library routing, telemetry, and remote runtime assets excluded or blocked.
- Board-first workspace with an accessible **Slides** toggle. The live editor stays mounted, so switching modes does not discard selections, history, or canvas position.
- Offline LaTeX equations rendered to movable Excalidraw image elements by a locally bundled MathJax 4.1.3. Select an equation and press **Equation** to edit its original LaTeX.
- Offline, no-AI Mermaid diagrams with explicit **Preview** and **Insert** actions. Flowchart, sequence, class, ER, and state diagrams become editable Excalidraw objects and can be reopened from a selected diagram.
- Browser autosave plus portable `.patterdraw` project files containing scene data and original PDF bytes. Existing `.canvasclassroom` files remain supported for import.
- One-click **Export all** downloads every object on the current board as a shareable PNG, including off-screen and off-page content. Editable Excalidraw scene data is embedded when the receiving image workflow preserves PNG metadata.
- A device-wide, locally persisted Excalidraw library supports adding and reusing canvas objects plus importing and exporting standard `.excalidrawlib` files without enabling public-library browsing or publishing.
- A separate device-wide **Screenshot Library** captures exact canvas regions, copies PNGs when browser clipboard access permits, and keeps the newest 50 captures available for click or drag insertion without adding them to project files.
- Tagged, detached slide windows with explicit ordering, one-shot freeform/16:9/4:3 drawing, native grouping, optional Morph transitions, fullscreen presentation, keyboard navigation, transient laser, and persistent live ink. Ordinary Excalidraw frames remain available for content ownership.
- One-workspace-per-page PDF import using a bundled PDF.js worker.
- Toggleable **PDF** mode with real local page thumbnails, drag reordering, accessible move-up/down controls, mixed-document ordering, and Previous/Next navigation that follows the chosen output order.
- Two annotated-PDF exports:
  - **Expand pages** keeps the source scale and enlarges each output page to include off-page writing.
  - **Fit like OpenBoard** keeps the source paper size and scales the visible union to fit.
- Presentation PDF export with one ordered frame per page.
- Source tests for import safety, project round trips, LaTeX validation, full-board export sizing, slide ordering, PDF page ordering, reordered PDF export, and expanded PDF bounds.

The Moodle activity is designed but not yet implemented. See [the Moodle boundary](moodle/mod_patterdraw/README.md) and [roadmap](docs/ROADMAP.md).

## Run locally

Requires Node 22.13 or newer.

```bash
npm install
npm run dev
```

To make the development server available to other devices on the same trusted LAN:

```bash
npm run dev -- --host 0.0.0.0
```

Open the LAN URL printed by Vite from another device. PatterDraw does not provide authentication or TLS, so do not expose this development server to the public internet. For a durable LAN deployment, run `npm run build` and serve `dist/` from an ordinary local HTTP server.

Production verification:

```bash
npm run check
```

The Vite build uses a relative base so `dist/` can be served from a static subdirectory or packaged into Moodle. Browsers still require an HTTP origin for workers and IndexedDB; opening `index.html` directly with `file://` is not a supported launch path.

## Student-safety boundary

- All runtime scripts, fonts, MathJax equation support, PDF support, and workers are bundled locally.
- The page CSP blocks external connections and frames.
- Imported scene links are removed, iframe/embeddable elements are rejected, and remote URL/HTML paste is blocked.
- LaTeX input is length- and complexity-limited, blocks links, HTML, external files, extension loading, external SVG paint values, and custom command definitions, and its generated SVG is reduced to explicit tag, attribute, node-count, and byte-size allowlists.
- Mermaid is wrapper-limited to five editable diagram families and rejects frontmatter, configuration directives, links, callbacks, HTML, custom CSS, remote resources, unsafe geometry, and SVG-image fallback. The heavy converter loads only when Preview is pressed; AI remains disabled.
- PDF files are loaded from local bytes. The importer never invokes PDF scripting APIs, and generated output is a new sanitized document containing the original page appearance plus annotation overlays.
- The package security audit is kept at zero known vulnerabilities with explicit transitive overrides; do not remove those overrides without rerunning `npm audit` and browser tests.

Read [GITHUB_SCAN.md](GITHUB_SCAN.md) for the July 2026 upstream survey and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model and implementation boundaries.

## License

The standalone application is MIT licensed. A future Moodle activity under `moodle/mod_patterdraw` will be GPL-3.0-or-later as required for Moodle plugins. Third-party licenses are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); production builds copy the application and third-party notices into `dist/licenses/`.
