# PatterDraw GeoGon vendor record

PatterDraw distributes this directory as a distinct, locally loaded 3DGeoGon
subapplication. The upstream application remains licensed under
GPL-3.0-or-later; PatterDraw's MIT license does not relicense these files.

- Upstream project: <https://github.com/MaskwaSam/3dgeogon>
- Upstream version: `0.2.10`
- Pinned commit: `386e47223740ed9955ae1fe8a022516fea98d57f`
- Upstream license: `LICENSE`
- Upstream third-party notices: `THIRD_PARTY_NOTICES.md`
- Bundled Three.js version: `0.185.1`
- Integrity check: `npm run check:geogon-vendor` from the PatterDraw repository

The 28 upstream files recorded by `scripts/verify-geogon-vendor.mjs` are copied
byte-for-byte from that commit. They include the unminified application source,
styles, HTML, geometry modules, all referenced images, the complete local
Three.js runtime subset with its license and vendor manifest, and the upstream
license and provenance documents required to understand and modify the app.

PatterDraw-owned integration code is kept outside the upstream inventory. This
record is the only PatterDraw-authored file in the packaged `geogon/` directory;
adding another integration file requires an explicit reviewed hash in both the
source and release verifiers.
