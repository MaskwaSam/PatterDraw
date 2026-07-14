# Roadmap

## Phase 1 — standalone hardening

- Board-first editor, toggleable slide rail, OpenBoard-style PDF page rail/reordering, local LaTeX equation insertion/editing, no-AI Mermaid insertion/editing, and embedded full-board PNG export are implemented.
- Complete automated browser smoke coverage for offline requests, LaTeX edit round trips, scene-embedded PNG reopening, local file round trips, touch/pen input, frame ordering, presentation keyboard behavior, and both PDF export modes.
- Add fixture PDFs covering mixed sizes, rotations, non-zero crop boxes, scanned/vector pages, malformed files, and annotations beyond all four edges.
- Add decoded-pixel and maximum-export-dimension limits plus cancellable PDF worker jobs.
- Move equation conversion into a terminable worker if adversarial classroom testing finds a main-thread stall beyond the current input, nesting, command, SVG-node, SVG-byte, queue, and timeout limits.
- Add cached annotation-aware slide thumbnails; PDF mode currently reuses each page's real local background preview.

## Phase 2 — presentation polish

- Duplicate/hide/delete slide controls, presenter overview, and viewport restoration.
- Optional speaker notes stored outside the Excalidraw scene.
- SVG/vector slide-PDF spike with explicit font and Unicode acceptance fixtures.
- Animated matched-object transitions only after basic navigation and persistent ink remain stable.

## Phase 3 — Moodle 5.2.1 activity

- Implement `mod_excalidrawclassroom` with teacher starter project/PDF, per-user drafts, autosave, submission/resubmission, completion, capabilities, and Moodle file APIs.
- Add privacy provider, backup/restore, event logging limited to Moodle-required activity events, and deterministic plugin packaging.
- Verify fresh install, upgrade, backup/restore, separate student copies, and source/PDF downloads in the target local Moodle stack.

## Phase 4 — writer evaluation

- Compare pdf-lib against LibPDF across the fixture corpus.
- Keep expanded-page and OpenBoard-fit geometry invariant across writer changes.
- Consider native vector annotations only when output remains visually equivalent in PDF.js, macOS Preview, and Acrobat.
