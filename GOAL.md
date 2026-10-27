# incase

Browser tool that generates "sliced" SVGs of foam case padding for expensive things like cameras.
The padding is a stack of flat foam sheets; each sheet is laser cut with the case outline and the object cutouts at its height.
This tool is for me first. Any API key (e.g. Gemini) is entered by me and stays local — never transferred or saved for others.

## MVP spec

**Tech:** Vite + TypeScript, three.js (3D preview), clipper2-ts (offsets/booleans). Static build, no backend.
Autosave to browser storage, plus JSON export/import of the project.

**Case (inner cavity)**
- L × W at the top and L × W at the bottom (tapered walls; layer outlines interpolated), depth
- edge radius (corners in top view)
- bottom edge radius (floor-to-wall curve; lowest layers get smaller)
- global clearance ("puffer"): + = loose, − = tight grip

**Materials & stack**
- editable list: name, thickness, line colour (RGB, used as cut colour in the export); list order = preference
- stack is auto-suggested to fill the case depth, then editable (reorder / swap / add / remove layers)

**Objects**
- shapes: box (optional rounded corners), standing cylinder, lying cylinder, sphere
- position X/Y, free rotation around Z (with snapping), Z position measured from the top
- lying cylinder and sphere get a different cutout per layer
- per-object clearance override
- finger notches attached to an object (move/rotate with it)

**Editor:** 2D top view for dragging/rotating plus typed exact values; 3D view beside it shows the result.

**Export:** one SVG, real mm, all layers side by side.
Outlines only (case + cutouts), each layer in its material colour.
Each layer gets a label (number + material) outside its cutting area, all labels in one colour distinct from all material colours.

## Later
- kerf compensation (keep it easy to add)
- SVG upload of object outlines
- photo tracing (Gemini, own key; reference square for scale as in the video), user enters height/width/depth
- nesting of pieces onto sheets, e.g. https://github.com/Jack000/SVGnest
- other tools from the video as inspiration, not as requirement
