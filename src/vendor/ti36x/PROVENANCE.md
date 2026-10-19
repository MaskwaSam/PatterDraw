# TI-36X Pro calculator source

Copied from Sam Patterson's local `/Users/sam/Desktop/Ti36X Pro/src` on 2026-10-19. Original sources are unchanged. `upstream-sha256.json` records original bytes. No upstream license file was supplied.

`runtime.js` concatenates engine, editor, render, state, math-drill, app, display-copy and recorder in the original build.js order. Adaptations: local module namespace instead of window.TI; PatterDraw storage key; calculator-root keyboard binding and teardown; keypad pointer presses focus the calculator; blink timer teardown; recorder focus restoration uses its own Document/ShadowRoot active element rather than document-level shadow-host retargeting. The engine, scientific functions, MathPrint, memory, screen copy and recorder are retained.

`markup.html` contains the original calculator and recorder body. Standalone title, guide and external guidebook link are omitted. `style.css` replaces :root with :host and adds compact panel layout overrides. All runtime code and assets are under src, covered by the offline source scan. No iframe, script injection or remote dependency is used.
