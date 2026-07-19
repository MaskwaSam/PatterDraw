# Editor design specification

The accepted implementation reference is [`editor-concept.png`](editor-concept.png), generated as a complete working editor surface rather than a marketing page.

## System

- True white panels and canvas; cool neutral `#f3f5f8` workspace.
- Dark navy text, one muted cobalt action color, amber offline indicator.
- Compact 13–15 px editor chrome, 6–8 px corner radii, thin borders, minimal shadow.
- Top file bar, narrow left slide/page rail, large central canvas, optional right selection inspector, and a 45 px status bar.
- Excalidraw's own toolbar remains the primary drawing control.
- No collaboration avatars, share button, AI/Mermaid controls, external embeds, marketing content, gradients, or decorative card grid.

## Functional state shown

The concept shows an imported PDF worksheet with blue annotations extending beyond its right and lower page edges. This state is the visual acceptance target for the PDF-import workflow, not the initial blank-project state.

## Image generation prompt

The concept was generated with the built-in image generation workflow using a `ui-mockup` brief for a 1440×900 student-safe classroom editor. Required exact labels were “PatterDraw,” “Open,” “Save,” “Export,” “Offline,” “Slides,” “Style,” “Stroke,” “Background,” “Layers,” “Page 2 of 4,” “100%,” and “Present.”

