# Repository notes

## Product boundary

- This is an offline-first classroom editor powered by the Excalidraw npm component.
- Keep collaboration, hosted sharing, public libraries, web embeds, AI, telemetry, and remote asset loading out of the student build.
- Treat imported PDF pages as locked local backgrounds. Drawing outside a page must remain visible and must be included in PDF export.
- Excalidraw frames are the slide primitive. Slide order is explicit project metadata rather than inferred from element order.
- Keep the full-width board as the default workspace. Slides are an optional UI mode and must not remount or replace the live Excalidraw editor.
- Keep PDF mode separate from frame slides. `pdfPageOrder` is authoritative for the thumbnail rail, navigation, autosave, and annotated export; never rewrite an imported page's immutable source `pageIndex` when reordering.
- Render student LaTeX only through the pinned local MathJax assets and preserve both input validation and SVG sanitization.
- Keep AI disabled. Mermaid must go through the wrapper-owned explicit Preview/Insert flow, its editable-type allowlist, and post-conversion validation; do not expose Excalidraw's live-preview Mermaid/AI dialog.
- Keep **Export all** scoped to every object on the active board, including off-screen and frame-overflow content; `.patterdraw` remains the complete multi-scene backup and legacy `.canvasclassroom` archives remain importable.

## Architecture

- Prefer wrapper changes under `src/`; do not patch files in `node_modules/`.
- Keep the static build portable by using Vite's relative `base` and bundled workers/assets.
- Put Moodle integration in `moodle/mod_patterdraw`; do not couple it to `mod_polypad`.
- Preserve imported source PDF bytes in the classroom project so PDF export can embed original pages instead of rasterizing them.

## Verification

- Run `npm run check` before handing off changes.
- Any new URL, fetch, worker, iframe, or embed path must be covered by the offline-safety check.
- Add browser coverage for slide navigation, PDF page reordering, project round trips, and off-page PDF annotations.
