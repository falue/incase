# incase

A browser tool for designing foam inserts for hard cases (camera cases and the like).
The insert is a stack of flat foam sheets; incase works out every sheet's outline with the cutouts for your objects
and exports them as SVG or DXF for the laser cutter, or as a PDF to print and cut by hand.

Everything runs locally in the browser: no account, no server, no data leaves your machine.

## Features

- **Guided setup**: a step-by-step dialog for a new project: case, materials and stack, a quick list of objects
  (name, type, size), then arrange.
- **Case**: inner length × width at the top and at the floor (tapered walls), depth, corner radius,
  floor-to-wall radius, lid depth. Search field for presets (Peli Protector, Air and Storm cases from their published
  interior dimensions; Euro pallet with 1–4 wooden collars) and your own presets saved in the browser, via "Brands…" (pick a brand, then a model, or type to search).
  Values a preset has no data for are marked with a red dot.
- **Materials & stack**: a list of foam sheets (name, thickness, cut colour); the stack fills the case depth
  automatically and can be rearranged by drag & drop. The stack rests on the case floor.
- **Objects**: box (rounded corners), standing cylinder, lying cylinder, sphere, or a free polygon
  (click its corners, drag / insert / delete them later, optional corner radius), each with position, rotation,
  depth and fit. Every cutout is open to the top so the object can be lifted out;
  the object rests on the first layer below its cutout.
- **Fit**: how much bigger (+, loose) or smaller (−, tight grip) a cutout is than its object; 0 by default,
  new objects take the last value you set.
- **Min. wall**: minimum foam between two cutouts and between a cutout and the case wall;
  violations are shown in red and listed in the status bar.
- **Finger notches**: a number per object, placed around its edge automatically or dragged by hand,
  with depth, diameter and a fillet where they meet the object.
- **Top view**: drag, rotate, zoom and pan, optional snapping and "keep clear" (refuses moves that break the min. wall),
  step through the layers one by one, Tab through objects stacked under the click.
- **3D view**: foam layers, objects, case and lid; orthographic or perspective, explode, X/Y section sliders,
  objects that reach into the lid show red.
- **Auto-arrange**: spread objects evenly or pack them tightly (no-fit polygons, the method SVGnest uses).
- **Export**: one SVG or DXF in mm with all layers side by side; cut lines in each material's colour as real lines and arcs,
  object outlines and layer labels in a separate label colour, optional kerf compensation (laser, mill or knife).
  PDF with 1:1 templates for cutting by hand: any paper size, layers larger than a sheet are split onto overlapping
  sheets with alignment crosses, plus a scale check square.
- Undo / redo, autosave, project save / load as JSON, mm or inches, dark / light mode.

## Getting started

Requires [Node.js](https://nodejs.org/) 20.19+ or 22.12+ (for Vite).

```sh
npm install
npm run dev      # development server
npm run build    # static build in dist/
```

## Keyboard

| Key | Action |
|---|---|
| B / C / L / S | add box / cylinder / lying cylinder / sphere |
| P | draw a polygon (Enter or click the first corner to finish, Backspace removes the last, Esc cancels) |
| Tab / ⇧Tab | next / previous object under the last click |
| A / ⇧A | arrange evenly / pack tightly |
| Arrows (⇧ ×10) | nudge the selected object |
| Del, ⌘/Ctrl+D, Esc | delete (a selected polygon corner first), duplicate, deselect |
| ⌘/Ctrl+Z, ⇧⌘Z / Ctrl+Y | undo, redo |
| PageUp / PageDown | step through the layers |
| F | fit the 3D view |
| 1 / 2 / 3 | top view / split / 3D |

Drag the label of any number field to scrub its value (⇧ for fine steps).

## Later

- More case presets (other brands and norms)
- SVG upload of object outlines
- Photo tracing (Gemini with your own API key, kept in your browser only; a reference square in the photo
  for scale), then enter the object's height, width and depth
- Nesting of the cut pieces onto material sheets, e.g. [SVGnest](https://github.com/Jack000/SVGnest)
- Other ideas from shadow-board tools as inspiration, not as requirement

## Built with

[Vite](https://vite.dev/), TypeScript, [three.js](https://threejs.org/),
[clipper2-ts](https://github.com/countertype/clipper2-ts) and [jsPDF](https://github.com/parallax/jsPDF).

Peli is a trademark of Pelican Products, Inc.; incase is not affiliated with it.

By [telefabi.ch](https://telefabi.ch).
