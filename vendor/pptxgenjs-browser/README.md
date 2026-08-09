# PatterDraw browser PptxGenJS vendor

This package preserves the exact browser ES distribution and TypeScript declarations from the upstream `pptxgenjs@4.0.1` npm package. The copied files are:

Source archive: `https://registry.npmjs.org/pptxgenjs/-/pptxgenjs-4.0.1.tgz` (upstream package version `4.0.1`).

- `dist/pptxgen.es.js` (SHA-256: `05844c5625e2cda3b449eb967c2246dd57ca57341886a7c28eeebca263b29bd4`)
- `types/index.d.ts` (SHA-256: `0726d015dbcb55ccfa75546cb2fd43fe13a0dfeb783d08572f1c62f59193bbe5`)
- `LICENSE` (SHA-256: `7a2bfe96150786ed1908b8e63f98ebab88875c1e79e28faff6649e0f11f77e52`)

The browser ES file has one static import (`jszip`); its Node-only dynamic branches are disabled by the browser aliases in this package and are never executed by PatterDraw. It contains no runtime import of the upstream package's `image-size` dependency (the only `sizeof` reference is a commented, unused Node helper), so PatterDraw uses this offline-safe browser surface without retaining the vulnerable `image-size` package. The local package version `4.0.1-patterdraw.1` identifies this packaging-only change; the upstream implementation is otherwise unchanged.
