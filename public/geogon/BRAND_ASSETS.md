# Brand and Example Provenance

The current 3DGeoGon visual identity and public examples were created specifically for this repository. No external logo, icon set, screenshot, exam-paper artwork, or branded example source file is incorporated.

`TriPatterson` remains only as a compatibility alias for older locally-authored embeds, shortcodes, saved browser state, and legacy routes. Those identifiers carry no legacy logo, artwork, or visible product branding; every route displays the current 3DGeoGon interface.

## Visual identity

The mark uses two offset five-sided outlines and their projection guides to suggest viewing one polygonal solid from multiple positions. It deliberately avoids the generic wireframe-cube mark used by the earlier private prototype.

| Token | Colour | Use |
| --- | --- | --- |
| Deep ink | `#10283a` | Mark background |
| Geometry teal | `#56d6c1` | Rear polygon |
| Geometry coral | `#ff806e` | Front polygon |
| Guide lavender | `#b9acf7` | Projection edges |
| Vertex amber | `#ffd166` | Selected vertices |

The SVG paths are project-local, code-authored geometry with no external image references or embedded font files:

- `images/3DGeoGon-logo.svg` — application wordmark.
- `images/3DGeoGon-icon.svg` — PWA and browser icon.
- `moodle-plugins/tiny/threedgeogon/pix/icon.svg` — monochrome TinyMCE toolbar adaptation.

## Screenshot

`images/screenshot.png` is a browser capture of the real application at 1200 by 630 pixels. Rebuild it with:

```bash
npm run capture:screenshot
```

The capture starts a local server, creates a pentagonal prism using 3DGeoGon itself, checks for browser errors, and records the actual rendered interface. It is not a generated mock-up and contains no user, course, or student data.

## Public examples

The built-in diagrams are generic states generated from a blank 3DGeoGon canvas. They use only project primitives and do not reproduce named exam-board questions.

The Moodle Formulas example is an original storage-crate volume prompt. Its compressed state was produced from a documented JSON snapshot containing a cuboid and three variable edge labels. It contains no third-party URL, personal information, or copied question text.

## License

These project-specific assets and examples are distributed under GPL-3.0-or-later with the rest of 3DGeoGon. The separately bundled Three.js code remains under its upstream MIT license.
