Three.js and addons for 3DGeoGon
=================================

Upstream project: https://github.com/mrdoob/three.js
Package: three
Version: 0.185.1 (revision 185)
Source archive: https://registry.npmjs.org/three/-/three-0.185.1.tgz
License: MIT; see LICENSE in this directory.

Acquisition and reproduction
----------------------------

1. Download the exact npm package with `npm pack three@0.185.1`.
2. Verify the package integrity against the `integrity` value in
   `vendor-manifest.json`.
3. Copy these unmodified distribution files:
   - `LICENSE`
   - `build/three.core.js`
   - `build/three.module.js`
   - `examples/jsm/controls/OrbitControls.js`
   - `examples/jsm/lines/Line2.js`
   - `examples/jsm/lines/LineGeometry.js`
   - `examples/jsm/lines/LineMaterial.js`
   - `examples/jsm/lines/LineSegments2.js`
   - `examples/jsm/lines/LineSegmentsGeometry.js`
4. Place the addon files in the matching `controls/` and `lines/` directories.
5. Run `node scripts/three-vendor.mjs` from the repository root. It verifies
   the pinned version, source, integrity metadata, exact file list, and SHA-256
   digest of every vendored upstream file.

No source transformation or minification is applied by 3DGeoGon. This
readme is project metadata and is not an upstream Three.js file.
