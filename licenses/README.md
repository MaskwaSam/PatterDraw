# Release license bundle

These files preserve the upstream license texts for PatterDraw's principal bundled runtime dependencies. `npm run build` copies this directory, PatterDraw's root `LICENSE`, and `THIRD_PARTY_NOTICES.md` into `dist/licenses/`.

The Excalidraw license applies to `@excalidraw/excalidraw`, `@excalidraw/common`, `@excalidraw/element`, and `@excalidraw/math`. The Excalidraw-distributed font assets are described separately in `THIRD_PARTY_NOTICES.md` and retain their upstream terms. Apache-2.0 coverage for `idb-keyval` and MathJax New Computer Modern is supplied by `mathjax-LICENSE.txt`; the corresponding package-specific attribution remains in `THIRD_PARTY_NOTICES.md`. PatterDraw uses JSZip under its MIT option; the bundled pako copies use their permissive upstream terms.

The separate, locally bundled 3DGeoGon subapplication remains
GPL-3.0-or-later. Its complete license is copied here as
`3dgeogon-GPL-3.0-or-later.txt` and also travels beside its unminified source as
`geogon/LICENSE`. The Three.js 0.185.1 subset used by 3DGeoGon retains its MIT
license in `three-LICENSE.txt` and beside the vendored Three.js files.
