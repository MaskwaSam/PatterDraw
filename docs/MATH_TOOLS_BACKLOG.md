# Math tools backlog

This is the implementation checklist for expanding **Math tools** beyond the existing ruler and protractor. Priorities assume a balanced Grades 7–12 mathematics program. Complete shared infrastructure in dependency order, then deliver tools release by release; do not weaken the offline, project, PDF, slide, or full-board export guarantees to ship a tool.

**Implementation status (2026-07-15):** Releases 1–3 and their shared infrastructure are complete. The checked state below is backed by typed catalogue and generator tests, project-safety and round-trip tests, the production offline-safety build check, and the full browser suite covering desktop, 390-by-844 mobile, touch input, autosave, project reopen, full-board export, PDF/slide regressions, and zero external requests.

## Priority and dependency key

- **P0 — foundation:** required by several tools or needed for the first useful release.
- **P1 — core classroom value:** broadly useful across Grades 7–12.
- **P2 — extension:** useful after the core catalogue and interaction model are stable.
- `CAT` — typed catalogue and category UI.
- `CFG` — configurable-tool forms.
- `BATCH` — atomic insertion of independently movable pieces.
- `INTERACT` — wrapper-owned interaction mode.

Catalogue category assignments are fixed for the initial registry: **Instruments** contains ruler, protractor, set squares, geometry stencil, compass, and angle measurer; **Graphs** contains Cartesian plane, number line, unit circle, grid pack, function plotter, and transformation tool; **Manipulatives** contains fraction kit, algebra tiles, integer chips, and probability kit.

## Current baseline

- [x] **P0 — Ruler.** Inserts a movable, rotatable 12-inch/30-centimetre local SVG image at 72 scene points per inch. Metadata records schema version, kind, calibration, natural size, scene scale, and both measurement lengths. Unit tests cover physical dimensions, ticks, labels, captions, and the data URL; browser coverage checks the local preview, keyboard/dialog behavior, insertion on a PDF page, autosave, movement, reload, calibration, mobile layout, and zero external requests.
- [x] **P0 — Protractor.** Inserts a movable, rotatable six-inch semicircular local SVG image with dual 0–180 degree scales and one-degree divisions at 72 scene points per inch. Metadata records schema version, kind, calibration, natural size, scene scale, diameter, angle range, smallest division, and dual-scale mode. Unit tests cover dimensions, arc/tick geometry, labels, centre mark, and the data URL; browser coverage checks insertion on a PDF page, autosave, movement, reload, calibration, and zero external requests.

These two tools establish the current behavior to preserve. Their hard-coded two-card dialog and app-local `Record<string, boolean | number | string>` metadata type are the seams that `CAT` replaces; do not copy that pattern into new tools.

## Requirements shared by every tool

- Generate or load all images from bundled local code/assets. Use SVG for static visual content, run generated SVG through the wrapper-owned sanitizer, and embed it as a local data URL. No remote resources, links, fonts, images, fetches, workers, iframes, embeds, or telemetry.
- Use `72` scene points per inch for physically calibrated tools. Record `calibration: "pdf-points"`, `sceneUnitsPerInch: 72`, and natural dimensions; state in the UI that resizing a calibrated tool changes its measurement scale.
- Insert tools as ordinary selectable board objects. A user must retain standard Excalidraw movement, rotation, resize, duplicate, delete, and lock behavior after insertion. Interactive editing must be an explicit wrapper mode and must return to normal selection cleanly.
- Put a validated, discriminated, schema-versioned record in `customData.classroomMathTool` on every generated tool or piece. Preserve it through autosave, `.patterdraw` encode/decode, imported-project sanitization, and regeneration. Reject or strip invalid metadata at the project boundary rather than trusting arbitrary imported custom data.
- Store user-visible configuration in metadata, not only in rendered SVG or component state. Multi-piece sets must include a stable set ID plus piece type/index on every independently movable piece. Interactive results must retain enough source parameters to re-enter the wrapper editor without depending on transient UI state.
- Include every inserted element and local file in full-board PNG, slide export when inside a frame, annotated PDF export when on a PDF scene, and `.patterdraw` backup. Objects outside a PDF page or overflowing a frame must remain visible under the existing export rules.
- Keep insertion transactional: either all requested files/elements and metadata are committed in one captured update or none are. Restore editor focus, select the inserted object(s), and present an accessible result/error message.
- Use deterministic geometry and bounded inputs. Cap counts, ranges, labels, expression length, generated elements, SVG nodes, and output bounds before inserting anything.
- Keep the catalogue and forms keyboard-operable, focus-trapped, labelled, and usable at a 390-by-844 viewport without horizontal overflow. Do not remount the live Excalidraw editor when changing categories or opening configuration.

## Shared engineering tasks

### Catalogue and configuration

- [x] **P0 `CAT-1` — Add a typed tool catalogue.** Replace the hard-coded ruler/protractor cards and callbacks with a discriminated `MathToolDefinition` registry containing stable kind, category, title, description, preview factory, insertion strategy, calibration notice, configuration schema, and availability state. Define a `ClassroomMathToolMetadata` union with a shared base and per-kind payloads outside `App.tsx`. Reject duplicate kinds and unknown categories.
  - **Unit acceptance:** catalogue tests prove unique IDs/test IDs, complete categories, valid local previews, typed default configuration, and a definition for both baseline tools; metadata validation round-trips every union member and rejects unknown kinds, wrong field types, non-finite numbers, and out-of-bounds values.
  - **Browser acceptance:** ruler and protractor still render, insert, move, rotate, lock/unlock, autosave, reload, and export through the registry with their existing metadata and no external requests.

- [x] **P0 `CAT-2` — Add category navigation.** Provide **Instruments**, **Graphs**, and **Manipulatives** views driven by catalogue data. Remember category only while the dialog is open; preserve the current first-item focus, tab loop, Escape behavior, close-button behavior, and return focus. At mobile widths, use a single-column, vertically scrollable layout with no horizontal overflow.
  - **Unit acceptance:** filtering/order helpers return stable category order, never mutate the registry, and provide a deterministic empty state.
  - **Browser acceptance:** keyboard, pointer, and 390-by-844 viewport tests visit every category, verify accessible selected state and focus behavior, and observe no editor remount or external request.

- [x] **P0 `CFG-1` — Add configurable-tool forms.** Add wrapper-owned forms for coordinate planes and number lines. Use typed defaults, inline validation, explicit **Insert** and **Cancel**, bounded numeric/text fields, and a preview regenerated only from validated local inputs. Preserve field values while moving between the form and its catalogue card during one dialog session.
  - **Unit acceptance:** parsers cover defaults, inclusive limits, reversed ranges, zero/negative steps, excessive labels, non-finite input, and deterministic normalization.
  - **Browser acceptance:** keyboard and touch users can open, edit, validate, cancel, and insert both forms; invalid input never changes the scene; the dialog fits mobile and causes no external request.

### Multi-element and interactive insertion

- [x] **P0 `BATCH-1` — Add batch insertion.** Insert a bounded array of local files and ordinary Excalidraw elements in one captured update. Assign a stable `setId`, deterministic piece indices, and per-piece typed metadata; stagger or grid pieces around the viewport centre without overlap that makes pieces unusable. Select the complete inserted set initially without binding the pieces into one permanently grouped object.
  - **Unit acceptance:** layout tests cover 1, maximum, odd, and mixed-size piece counts; IDs and indices are unique; failure during generation yields no partial result; metadata identifies every piece and its parent set.
  - **Browser acceptance:** a representative mixed set inserts in one action, each piece moves/rotates/locks independently, undo removes the whole insertion, redo restores it, and autosave/reload/export preserve all pieces with no external request.

- [x] **P1 `INTERACT-1` — Add a wrapper-owned math interaction mode.** Introduce explicit modes for compass construction, angle measurement, plotting, and transformations. The wrapper owns prompts, handles, validation, preview, commit/cancel, and source metadata; do not patch Excalidraw or expose its Mermaid/AI dialog. Commit only ordinary Excalidraw elements/local images, then restore the selection tool and normal editor shortcuts.
  - **Unit acceptance:** state-machine tests cover enter, update, commit, cancel, Escape, tool switch, scene switch, invalid geometry, maximum bounds, and teardown without leaked listeners.
  - **Browser acceptance:** pointer, touch, and keyboard tests complete and cancel one workflow, verify ordinary editing afterward, then autosave/reload/export the committed result with no external request.

### Cross-cutting safety and export coverage

- [x] **P0 `SAFE-1` — Centralize math SVG generation and sanitization.** Share UTF-8 data-URL encoding, finite-dimension checks, SVG node/byte limits, paint/element/attribute allowlists, and rejection of links, scripts, event handlers, foreign objects, CSS imports, and external references. Generated assets must pass this boundary even when their source is trusted code.
  - **Unit acceptance:** safe fixtures remain geometrically unchanged; malicious/oversized fixtures are rejected; Unicode labels encode and decode correctly; every catalogue preview and generated tool passes the sanitizer.
  - **Browser acceptance:** the catalogue works under the existing CSP and offline network guard; a test records zero requests outside the launch origin through preview, insertion, reload, and export.

- [x] **P0 `ROUNDTRIP-1` — Add shared math-tool round-trip assertions.** Extend helpers to inspect any discriminated math-tool kind/set, rather than hard-coding ruler/protractor. Cover board scenes, PDF scenes, frames, autosave, `.patterdraw`, full-board PNG, slide/PDF export, and off-page/frame-overflow placement.
  - **Unit acceptance:** project sanitization and encode/decode preserve valid tool metadata/local files and reject unsafe files or invalid metadata without corrupting unrelated scene content.
  - **Browser acceptance:** a representative static tool and multi-piece set survive movement, rotation, locking, scene navigation, reload, project download/reopen, and each applicable export; off-page content remains included and no external request occurs.

## Release 1 — Static instruments

Release gate: `CAT-1`, `CAT-2`, `SAFE-1`, and `ROUNDTRIP-1` are complete. `CFG-1` is additionally required for the Cartesian plane and number line. Static tools insert as one movable SVG image unless their item explicitly says otherwise.

### Instruments

- [x] **P0 — Set squares** (`CAT-1`, `CAT-2`, `SAFE-1`).
  - **Minimum behavior:** offer separate 45-45-90 and 30-60-90 transparent set squares, each with a readable edge scale and angle marks, inserted at physical size for drawing against a PDF page.
  - **Settings/metadata:** variant; leg lengths in inches; metric edge length; smallest scale division; marked angles; `calibration: "pdf-points"`; natural size; `sceneUnitsPerInch: 72`.
  - **Unit acceptance:** assert triangle angles/side ratios, cut-out containment, labelled angles, tick spacing, 72-point calibration, finite SVG bounds, and sanitized local data URLs for both variants.
  - **Browser acceptance:** insert each variant from **Instruments**; verify preview, movement, rotation, resize warning, lock/unlock, autosave/reload, PDF/full-board export, mobile layout, and zero external requests.

- [x] **P1 — Geometry stencil** (`CAT-1`, `CAT-2`, `SAFE-1`).
  - **Minimum behavior:** insert one transparent stencil with labelled cut-outs for circle, triangle, square, rectangle, pentagon, hexagon, and common quadrilateral shapes; the stencil is a visual tracing aid, not a live shape picker.
  - **Settings/metadata:** stencil version; included shape IDs; physical width/height; cut-out sizes; label set; `calibration: "pdf-points"`; natural size; `sceneUnitsPerInch: 72`.
  - **Unit acceptance:** verify the required shape inventory, closed/non-self-intersecting cut-out paths, minimum spacing/wall thickness, labels inside bounds, physical dimensions, and sanitized SVG.
  - **Browser acceptance:** insert, move, rotate, lock/unlock, save/reload, and export the stencil on board/PDF; verify every label remains legible at default size, mobile catalogue fit, and zero external requests.

### Graphs

- [x] **P0 — Cartesian plane** (`CAT-1`, `CAT-2`, `CFG-1`, `SAFE-1`).
  - **Minimum behavior:** configure x/y minimum and maximum, major step, optional minor grid, axes, quadrant labels, and axis labels; insert a single movable plane whose scale is equal on both axes.
  - **Settings/metadata:** x/y ranges; major/minor steps; show-grid/show-axes/show-numbers flags; x/y labels; pixels/scene points per unit; natural size; configuration version. Use `calibration: "logical-units"` unless the requested scale is explicitly tied to physical inches.
  - **Unit acceptance:** verify origin placement, equal unit spacing, major/minor line counts, ticks/labels for negative and non-zero-origin ranges, arrow/axis geometry, bounds caps, label escaping, and sanitized deterministic SVG.
  - **Browser acceptance:** insert default four-quadrant and custom first-quadrant planes; invalid ranges cannot insert; both configurations persist through autosave/project reopen and export; movement/rotation/locking, mobile form, and zero external requests pass.

- [x] **P0 — Number line** (`CAT-1`, `CAT-2`, `CFG-1`, `SAFE-1`).
  - **Minimum behavior:** configure minimum, maximum, major interval, optional minor divisions, endpoint arrows, and labels; support integer, decimal, and simple-fraction label formats without evaluating arbitrary expressions.
  - **Settings/metadata:** range; major step; minor divisions; label format; arrow mode; title/axis label; logical unit spacing; natural size; configuration version.
  - **Unit acceptance:** verify tick count/positions, exact endpoints, negative/decimal/fraction formatting, reduced fractions, arrow geometry, range/count limits, escaping, and sanitized deterministic SVG.
  - **Browser acceptance:** insert integer and fraction examples; invalid/over-dense ranges cannot insert; configuration, movement, rotation, lock state, autosave/project reopen, export, mobile form, and zero external requests pass.

- [x] **P1 — Unit circle** (`CAT-1`, `CAT-2`, `SAFE-1`).
  - **Minimum behavior:** insert a circle with x/y axes and the standard special angles, showing degrees plus exact radian and coordinate values in a legible local SVG.
  - **Settings/metadata:** label mode (`degrees`, `radians`, or `both`); coordinate-label flag; special-angle set version; radius in scene points; natural size; `calibration: "logical-units"`.
  - **Unit acceptance:** verify radius and axis geometry, all required special-angle positions, exact radian/coordinate strings, quadrant signs, label containment/non-overlap thresholds, and sanitized SVG.
  - **Browser acceptance:** insert each label mode, verify readable preview/default size, movement/rotation/locking, autosave/project reopen, export, mobile catalogue fit, and zero external requests.

- [x] **P1 — Grid pack** (`CAT-1`, `CAT-2`, `SAFE-1`).
  - **Minimum behavior:** offer square, isometric, dot, and polar grids as separate catalogue variants with enough area for a classroom construction; grids remain ordinary movable backgrounds and are not automatically locked.
  - **Settings/metadata:** grid variant; rows/columns or rings/rays; major/minor interval; point/line spacing; natural size; physical spacing when calibrated; calibration mode and `sceneUnitsPerInch: 72` only for physical variants.
  - **Unit acceptance:** assert variant inventory, row/column/ring/ray counts, uniform spacing, isometric angles, polar radii, major-line cadence, bounded node counts, dimensions, and sanitized SVGs.
  - **Browser acceptance:** insert all variants, place one behind annotations, lock/unlock it, move/rotate another, save/reload and export both on board/PDF, verify mobile catalogue behavior and zero external requests.

## Release 2 — Multi-piece manipulatives

Release gate: Release 1 plus `BATCH-1`. Each action inserts a bounded set of independently movable ordinary elements. Every piece carries the shared base metadata, `setId`, `pieceIndex`, and the item-specific fields below.

- [x] **P0 — Fraction kit** (`CAT-1`, `CAT-2`, `BATCH-1`, `SAFE-1`).
  - **Minimum behavior:** choose fraction bars or circles and a denominator range; insert one whole plus colour-coded unit-fraction pieces through the selected denominator so pieces can be compared and rearranged independently.
  - **Settings/metadata:** representation; maximum denominator; colour palette version; whole size; numerator/denominator; piece geometry; set ID/index; `calibration: "logical-units"`.
  - **Unit acceptance:** piece areas/lengths sum to one within tolerance for every denominator, labels are reduced/correct, colours are deterministic and distinguishable, counts stay capped, layouts do not fully overlap, and every SVG is sanitized.
  - **Browser acceptance:** insert bar and circle kits, move/rotate/lock individual pieces, undo/redo the atomic set, save/reload/project reopen/export with all pieces, use the form on mobile, and make zero external requests.

- [x] **P0 — Algebra tiles** (`CAT-1`, `CAT-2`, `BATCH-1`, `SAFE-1`).
  - **Minimum behavior:** configure bounded counts of positive/negative unit, x, and x-squared tiles; insert each tile independently with consistent side relationships and sign/colour cues that do not rely on colour alone.
  - **Settings/metadata:** variable symbol from an allowlist; counts by tile/sign; unit side; x length; sign; tile type; palette version; set ID/index; `calibration: "logical-units"`.
  - **Unit acceptance:** verify unit/x/x-squared dimensions and areas, sign marks, accessible contrast/pattern cues, count limits, deterministic layout, escaped labels, and sanitized SVGs.
  - **Browser acceptance:** insert a mixed polynomial set, rearrange/rotate/lock individual tiles, undo/redo atomically, persist configuration and every piece through reload/project reopen/export, verify mobile form and zero external requests.

- [x] **P1 — Integer chips** (`CAT-1`, `CAT-2`, `BATCH-1`, `SAFE-1`).
  - **Minimum behavior:** configure positive and negative chip counts; insert equal-size independent chips with explicit plus/minus marks and contrasting fill/pattern so zero pairs are easy to model.
  - **Settings/metadata:** sign; requested positive/negative counts; chip diameter; palette/pattern version; set ID/index; `calibration: "logical-units"`.
  - **Unit acceptance:** assert equal diameters, correct signs/counts, accessible contrast/pattern distinction, count cap, deterministic paired layout, and sanitized SVGs.
  - **Browser acceptance:** insert unequal counts, form and move zero pairs, rotate/lock pieces, undo/redo the set, save/reload/project reopen/export all chips, verify mobile behavior and zero external requests.

- [x] **P2 — Probability kit** (`CAT-1`, `CAT-2`, `BATCH-1`, `SAFE-1`).
  - **Minimum behavior:** insert a selected local set of six-sided dice faces, two-sided coins, numbered spinner, and/or numbered cards as independent static manipulatives; this release does not simulate random outcomes.
  - **Settings/metadata:** component type; quantity; face/value; spinner sector count/labels; card range; palette version; set ID/index; `calibration: "logical-units"`.
  - **Unit acceptance:** verify dice pip maps, coin sides, unique/bounded card values, equal spinner sectors, label containment, count caps, deterministic layouts, and sanitized SVGs.
  - **Browser acceptance:** insert each component and a mixed kit, manipulate individual pieces, undo/redo atomically, save/reload/project reopen/export, verify mobile selection and zero external requests.

## Release 3 — Interactive tools

Release gate: Releases 1–2 plus `INTERACT-1`. Interactive mode is temporary wrapper UI; committed results must be ordinary Excalidraw elements/local images with typed source metadata and no runtime dependency on the interaction overlay.

- [x] **P1 — Compass** (`CAT-1`, `CAT-2`, `INTERACT-1`).
  - **Minimum behavior:** choose a centre and radius from two board points, preview the circle/arc, optionally choose clockwise/counterclockwise arc extent, and commit an editable ordinary ellipse or arc plus an optional centre mark.
  - **Settings/metadata:** centre; radius in scene units; start/end angle; direction; full-circle flag; centre-mark flag; stroke style; construction version; `calibration: "scene-geometry"`.
  - **Unit acceptance:** state and geometry tests cover radius, full circles, minor/major arcs, direction, angle normalization, zero/huge radius rejection, finite bounds, and regeneration from metadata.
  - **Browser acceptance:** pointer and touch construct/cancel a circle and arc; committed shapes move/rotate/lock and remain editable after mode exit; autosave/project reopen/export, scene switch cleanup, mobile controls, and zero external requests pass.

- [x] **P1 — Angle measurer** (`CAT-1`, `CAT-2`, `INTERACT-1`).
  - **Minimum behavior:** select or place vertex and two rays, display the live interior angle, allow reflex-angle toggle, and optionally commit a local arc/label annotation without modifying the measured source elements.
  - **Settings/metadata:** three points or referenced element IDs plus captured points; interior/reflex mode; precision; unit (`degrees`); commit-annotation flag; measured value; measurement version.
  - **Unit acceptance:** verify acute/right/obtuse/straight/reflex results, rotated/transformed points, precision rounding, coincident-point rejection, no source mutation, annotation geometry, and metadata regeneration.
  - **Browser acceptance:** measure existing and newly placed rays with pointer/touch, toggle reflex, commit/cancel, then move/rotate/lock, save/reload/project reopen/export the annotation; mobile controls and zero external requests pass.

- [x] **P1 — Function plotter** (`CAT-1`, `CAT-2`, `INTERACT-1`, `CFG-1`, `SAFE-1`).
  - **Minimum behavior:** plot a bounded allowlist of explicit functions `y=f(x)` on a configured Cartesian window using a small local parser/evaluator; show validated preview and commit axes plus sampled path as ordinary elements. Do not use `eval`, remote graphing services, or arbitrary JavaScript.
  - **Settings/metadata:** original normalized expression; parser version; x/y window; sample count/tolerance; discontinuity handling; axes/grid flags; style; configuration version; `calibration: "logical-units"`.
  - **Unit acceptance:** parser accepts documented arithmetic/functions/constants and rejects code/property access/assignments/unknown tokens; plotting covers linear, quadratic, absolute, trig, rational discontinuity, non-finite samples, clipping, bounds/sample caps, and deterministic regeneration.
  - **Browser acceptance:** validate/preview/insert representative functions, show a useful error for invalid input, exit cleanly on cancel/scene switch, edit/regenerate from metadata, then move/rotate/lock, save/reload/project reopen/export on desktop/mobile with zero external requests.

- [x] **P2 — Transformation tool** (`CAT-1`, `CAT-2`, `INTERACT-1`).
  - **Minimum behavior:** select ordinary supported elements, preview a translation, rotation about a point, reflection across a line, or dilation about a point, then commit transformed duplicates while leaving originals unchanged by default.
  - **Settings/metadata:** transformation type; vector, angle/centre, mirror-line points, or scale factor as appropriate; source element IDs; copy/in-place policy (initially copy only); transformation version; `calibration: "scene-geometry"`.
  - **Unit acceptance:** matrix tests cover identity, translation, positive/negative rotation, horizontal/vertical/oblique reflection, positive dilation, composed point geometry, text/image handling policy, unsupported-element rejection, finite bounds, and source immutability.
  - **Browser acceptance:** preview/commit/cancel every transformation on the documented supported types; duplicates remain normally editable and source objects stay unchanged; metadata, autosave/project reopen/export, mobile controls, scene-switch teardown, and zero external requests pass.

## Definition of done

A checkbox above may be marked complete only when all of the following are true:

- Generated content is local, sanitized, bounded, and covered by the build-time offline-safety check plus a browser assertion of zero external requests.
- Configuration is validated and preserved in the typed `classroomMathTool` metadata union; imported-project sanitization and `.patterdraw` round trips are covered.
- Every generated object supports the applicable ordinary movement, rotation, resize, duplication, deletion, and locking behavior, and it survives autosave/reload.
- Full-board export includes the complete active board, including off-screen and frame-overflow math content. PDF annotations beyond page edges and slide content behave under the existing export contracts.
- Unit tests verify exact dimensions, geometry, labels, calibration where applicable, input limits, and deterministic local SVG/output generation.
- Browser tests verify catalogue/form insertion, persistence, project reopen, relevant exports, keyboard/touch behavior, 390-by-844 mobile layout, and zero external requests.
- Existing ruler, protractor, PDF page ordering/export, slide navigation/export, project round-trip, full-board export, and offline-safety checks remain passing under `npm run check` and the relevant Playwright suite.
