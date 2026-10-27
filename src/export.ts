import type { PointD } from 'clipper2-ts'
import { contours, svgPath, type Contour } from './curves'
import { offset, type Layer } from './geometry'
import type { Project } from './model'

const GAP = 10
const MARGIN = 5
const FONT = 5
const STROKE = 0.3528 // mm = 1 pt

/** What gets drawn for one layer, in sheet mm (y down): cut lines, object outlines and a label below. */
export interface Piece {
  /** Bounding box of the piece including its label. */
  x: number
  y: number
  w: number
  h: number
  cut: Contour[]
  outlines: Contour[]
  color: string
  label: string
  labelAt: PointD
}

/**
 * All layers side by side, each with its label below.
 * Kerf: the pieces grow by half the kerf (outer edges out, holes in), so they come out at nominal size.
 * Every object also gets its own outline (for engraving or orientation), drawn in the label colour below the cut lines.
 */
export function layout(p: Project, layers: Layer[]) {
  const L = Math.max(p.box.topL, p.box.bottomL) + p.kerf
  const W = Math.max(p.box.topW, p.box.bottomW) + p.kerf
  const pieces = layers.map((layer, i): Piece => {
    const x = MARGIN + i * (L + GAP), cx = x + L / 2, cy = MARGIN + W / 2
    const { name, thickness, color } = layer.material
    return {
      x, y: MARGIN, w: L, h: W + 4 + FONT,
      cut: contours(p.kerf > 0 ? offset(layer.paths, p.kerf / 2) : layer.paths, cx, cy),
      outlines: contours(layer.outlines, cx, cy),
      color,
      label: `${i + 1} · ${name} · ${thickness} mm`,
      labelAt: { x, y: MARGIN + W + 4 + FONT },
    }
  })
  return { width: layers.length * (L + GAP) - GAP + 2 * MARGIN, height: W + FONT + 4 + 2 * MARGIN, pieces, font: FONT, stroke: STROKE }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/** One SVG in mm, cut lines in the material colours. */
export function exportSvg(p: Project, layers: Layer[]): string {
  const { width, height, pieces } = layout(p, layers)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
<g id="outlines" fill="none" stroke="${p.labelColor}" stroke-width="${STROKE}">
${pieces.filter(pc => pc.outlines.length).map(pc => `<path d="${svgPath(pc.outlines)}"/>`).join('\n')}
</g>
<g id="cut" fill="none" stroke-width="${STROKE}">
${pieces.map(pc => `<path stroke="${pc.color}" d="${svgPath(pc.cut)}"/>`).join('\n')}
</g>
<g id="labels" fill="${p.labelColor}" font-family="sans-serif" font-size="${FONT}">
${pieces.map(pc => `<text x="${pc.labelAt.x}" y="${pc.labelAt.y}">${esc(pc.label)}</text>`).join('\n')}
</g>
</svg>
`
}

/** Nearest AutoCAD colour index (DXF R12 has no true colour), against an approximated palette: 1–6 basics, 10–249 hue wheel, 250–255 greys. */
function aci(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  if (Math.max(r, g, b) < 40 || Math.min(r, g, b) > 215) return 7 // black/white: drawn in the contrasting colour
  const palette: [number, number[]][] = [[1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]]]
  for (let i = 10; i < 250; i++) {
    // ACI 10–249: 24 hues in 15° steps; within a hue, even = full / odd = half saturation, value falls in five steps
    const hue = ((i - 10) / 10 | 0) * 15, v = [1, 0.65, 0.5, 0.3, 0.15][((i % 10) / 2) | 0], s = i % 2 ? 0.5 : 1
    const f = (n: number) => {
      const k = (n + hue / 60) % 6
      return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))))
    }
    palette.push([i, [f(5), f(3), f(1)]])
  }
  for (let i = 250; i < 256; i++) palette.push([i, Array(3).fill(Math.round(51 + (i - 250) * 40.8))])
  return palette.reduce((best, [i, c]) => {
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2
    return d < best.d ? { i, d } : best
  }, { i: 7, d: Infinity }).i
}

/**
 * One DXF (R12, mm, y up) with the same content as the SVG: closed polylines with arc bulges,
 * one layer per material (CUT_1_<name> …) in the nearest AutoCAD colour, plus OUTLINES and LABELS.
 */
export function exportDxf(p: Project, layers: Layer[]): string {
  const { height, pieces } = layout(p, layers)
  const out: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES']
  const n = (v: number) => Math.round(v * 1000) / 1000
  const polylines = (cs: Contour[], layer: string, color: number) => {
    for (const c of cs) {
      out.push(0, 'POLYLINE', 8, layer, 62, color, 66, 1, 70, 1)
      // each vertex carries the bulge of the segment leaving it: tan(angle / 4), positive = counter-clockwise (y up)
      const points = [c.start, ...c.segments.slice(0, -1).map(s => s.to)]
      points.forEach((q, i) => {
        const span = c.segments[i].arc?.span ?? 0
        out.push(0, 'VERTEX', 8, layer, 10, n(q.x), 20, n(height - q.y), 42, n(-Math.tan(span / 4)))
      })
      out.push(0, 'SEQEND', 8, layer)
    }
  }
  const label = aci(p.labelColor)
  pieces.forEach((pc, i) => {
    polylines(pc.outlines, 'OUTLINES', label)
    polylines(pc.cut, `CUT_${i + 1}_${layers[i].material.name.replace(/[^\w-]+/g, '_')}`, aci(pc.color))
    out.push(0, 'TEXT', 8, 'LABELS', 62, label, 10, n(pc.labelAt.x), 20, n(height - pc.labelAt.y), 40, FONT, 1, pc.label.replace(/·/g, '-'))
  })
  out.push(0, 'ENDSEC', 0, 'EOF')
  return out.join('\n') + '\n'
}
