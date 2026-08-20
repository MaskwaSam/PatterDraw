# Third-party notices

PatterDraw directly bundles these open-source packages. Production builds copy this notice, PatterDraw's license, and available upstream license texts into `dist/licenses/`.

| Package | Version | License | Project |
|---|---:|---|---|
| `@excalidraw/excalidraw` | 0.18.1 | MIT | <https://github.com/excalidraw/excalidraw> |
| `@excalidraw/common` | 0.18.0-e9c856d | MIT | <https://github.com/excalidraw/excalidraw> |
| `@excalidraw/element` | 0.18.0-e9c856d | MIT | <https://github.com/excalidraw/excalidraw> |
| `@excalidraw/math` | 0.18.0-e9c856d | MIT | <https://github.com/excalidraw/excalidraw> |
| `@excalidraw/mermaid-to-excalidraw` | 2.2.2 | MIT | <https://github.com/excalidraw/mermaid-to-excalidraw> |
| Mermaid | 11.16.1 | MIT | <https://github.com/mermaid-js/mermaid> |
| `@mermaid-js/parser` | 0.6.3 and 1.2.0 | MIT | <https://github.com/mermaid-js/mermaid> |
| DOMPurify | 3.4.13 | MPL-2.0 OR Apache-2.0 | <https://github.com/cure53/DOMPurify> |
| KaTeX | 0.16.47 | MIT | <https://github.com/KaTeX/KaTeX> |
| `pdfjs-dist` | 6.2.108 | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| `pdf-lib` | 1.17.1 | MIT | <https://github.com/Hopding/pdf-lib> |
| `fflate` | 0.8.3 | MIT | <https://github.com/101arrowz/fflate> |
| PptxGenJS | 4.0.1 | MIT | <https://github.com/gitbrent/PptxGenJS> |
| JSZip | 3.10.1 | MIT (selected from MIT OR GPL-3.0-or-later) | <https://github.com/Stuk/jszip> |
| pako | 1.0.11 and 2.0.3 | MIT and Zlib | <https://github.com/nodeca/pako> |
| `idb-keyval` | 6.3.0 | Apache-2.0 | <https://github.com/jakearchibald/idb-keyval> |
| MathJax and MathJax New Computer Modern font data | 4.1.3 | Apache-2.0 | <https://github.com/mathjax/MathJax> |
| `points-on-curve` | 1.0.1 | MIT | <https://github.com/pshihn/bezier-points> |
| `perfect-freehand` | 1.2.0 | MIT | <https://github.com/steveruizok/perfect-freehand> |
| React / React DOM | 18.3.1 | MIT | <https://github.com/facebook/react> |
| 3DGeoGon | 0.2.10 (`386e472`) | GPL-3.0-or-later | <https://github.com/MaskwaSam/3dgeogon> |
| Three.js (bundled by 3DGeoGon) | 0.185.1 | MIT | <https://github.com/mrdoob/three.js> |

PDF.js standard-font data (Foxit/PDFium PFB data and Liberation Sans) is copied
from `pdfjs-dist/standard_fonts/` for offline rendering. The build keeps the
upstream `LICENSE_FOXIT` and `LICENSE_LIBERATION` files beside those assets in
`dist/pdfjs/standard_fonts/`.

## Fonts distributed by Excalidraw

PatterDraw self-hosts the font assets shipped in `@excalidraw/excalidraw@0.18.1` so the editor does not contact a CDN. The build copies the upstream package's Assistant, Liberation Sans, Comic Shanns, Excalifont, Virgil, Lilita, Nunito, Cascadia Code, and Xiaolai font files without modification. These assets retain their upstream copyrights and licenses; Excalidraw's license and this provenance notice are included in every production build.

## Bundled 3DGeoGon subapplication

PatterDraw includes an unmodified, locally loaded copy of 3DGeoGon 0.2.10 from
commit `386e47223740ed9955ae1fe8a022516fea98d57f` under `public/geogon/`.
It is distributed and loaded as a distinct subapplication and remains licensed
under GPL-3.0-or-later; PatterDraw's MIT license does not relicense it. The
unminified 3DGeoGon source, GPL license, upstream notices, and all runtime assets
are shipped together at that path. `public/geogon/PATTERDRAW_VENDOR.md` records
the exact source and the local integrity-verification command.

3DGeoGon bundles a reviewed subset of Three.js 0.185.1 under its upstream MIT
license. Its complete license, source provenance, package integrity, and
per-file hashes are retained in `public/geogon/build/three-0.185.1/`.

GitHub projects listed in `GITHUB_SCAN.md` are research references and are not bundled unless they also appear in the dependency lockfile. In particular, no GPL/AGPL code from OpenBoard or Obsidian Excalidraw is copied into the standalone application.
