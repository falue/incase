# incase

A browser tool for designing foam inserts for hard cases (camera cases and the like).
The insert is a stack of flat foam sheets; incase works out every sheet's outline with the cutouts for your objects
and exports them as one SVG, ready for the laser cutter.

Everything runs locally in the browser: no account, no server, no data leaves your machine.

## Features

- **Case**: inner length × width at the top and at the floor (tapered walls), depth, corner radius,
  floor-to-wall radius, lid depth.
- **Materials & stack**: a list of foam sheets (name, thickness, cut colour); the stack fills the case depth
  automatically and can be rearranged by drag & drop. The stack rests on the case floor.
- **Objects**: box (rounded corners), standing cylinder, lying cylinder, sphere, each with position, rotation,
  depth and an optional fit override. Every cutout is open to the top so the object can be lifted out;
  the object rests on the first layer below its cutout.
- **Fit**: how much bigger (+, loose) or smaller (−, tight grip) a cutout is than its object.
- **Min. wall**: minimum foam between two cutouts and between a cutout and the case wall;
  violations are shown in red and listed in the status bar.
- **Finger notches**: a number per object, placed around its edge automatically or dragged by hand,
  with depth, diameter and a fillet where they meet the object.
- **Top view**: drag, rotate, zoom and pan, optional snapping and "keep clear" (refuses moves that break the min. wall),
  step through the layers one by one.
- **3D view**: foam layers, objects, case and lid; orthographic or perspective, explode, X/Y section sliders,
  objects that reach into the lid show red.
- **Auto-arrange**: spread objects evenly or pack them tightly (no-fit polygons, the method SVGnest uses).
- **Export**: one SVG in mm with all layers side by side; cut lines in each material's colour as real lines and arcs,
  object outlines and layer labels in a separate label colour, optional laser kerf compensation.
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
| A / ⇧A | arrange evenly / pack tightly |
| Arrows (⇧ ×10) | nudge the selected object |
| Del, ⌘/Ctrl+D, Esc | delete, duplicate, deselect |
| ⌘/Ctrl+Z, ⇧⌘Z / Ctrl+Y | undo, redo |
| PageUp / PageDown | step through the layers |
| F | fit the 3D view |
| 1 / 2 / 3 | top view / split / 3D |

Drag the label of any number field to scrub its value (⇧ for fine steps).

## Later

- Case presets, e.g. Pelican cases with their published interior dimensions
- SVG upload of object outlines
- Photo tracing (Gemini with your own API key, kept in your browser only; a reference square in the photo
  for scale), then enter the object's height, width and depth
- Nesting of the cut pieces onto material sheets, e.g. [SVGnest](https://github.com/Jack000/SVGnest)
- Other ideas from shadow-board tools as inspiration, not as requirement

## Built with

[Vite](https://vite.dev/), TypeScript, [three.js](https://threejs.org/) and
[clipper2-ts](https://github.com/countertype/clipper2-ts).

By [telefabi.ch](https://telefabi.ch).
