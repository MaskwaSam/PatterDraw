# Release license bundle

These files preserve the upstream license texts for PatterDraw's principal bundled runtime dependencies. `npm run build` copies this directory, PatterDraw's root `LICENSE`, and `THIRD_PARTY_NOTICES.md` into `dist/licenses/`.

The Excalidraw license applies to `@excalidraw/excalidraw`, `@excalidraw/element`, and `@excalidraw/math`. The Excalidraw-distributed font assets are described separately in `THIRD_PARTY_NOTICES.md` and retain their upstream terms. Apache-2.0 coverage for `idb-keyval` and MathJax New Computer Modern is supplied by `mathjax-LICENSE.txt`; the corresponding package-specific attribution remains in `THIRD_PARTY_NOTICES.md`.
