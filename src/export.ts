import type { PointD } from 'clipper2-ts'
import { contours, svgPath, type Contour } from './curves'
import { offset, type Layer } from './geometry'
import type { Project } from './model'
import { FONT, pieceShapes, planSheets, sheetTitle } from './sheets'

const GAP = 10
const MARGIN = 5
const STROKE = 0.3528 // mm = 1 pt
const TITLE_RAISE = 3 // mm from a sheet title's baseline to its sheet

/** An object name, centred on (x, y), turned by `rot` degrees clockwise. */
type Name = { x: number; y: number; rot: number; text: string; color: string }

/** Names are engraved on the top layer; where objects rest they are for reference only. */
const nameColor = (p: Project, l: Layer) => (l.index ? p.outlineColor : p.labelColor)

/** What gets drawn for one layer, in sheet mm (y down): cut lines, object outlines, footprints, object names and a label below. */
export interface Piece {
  /** Bounding box of the piece including its label. */
  x: number
  y: number
  w: number
  h: number
  cut: Contour[]
  outlines: Contour[]
  footprints: Contour[]
  color: string
  label: string
  /** The top layer's label is in the outline colour, as its face stays visible. */
  labelColor: string
  labelAt: PointD
  names: Name[]
}

/**
 * All layers side by side, each with its label below.
 * Kerf: the pieces grow by half the kerf (outer edges out, holes in), so they come out at nominal size.
 * Every object also gets its own outline (for engraving or orientation), drawn in the outline colour below the cut lines.
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
      footprints: contours(layer.footprints, cx, cy),
      color,
      labelColor: layer.index ? p.labelColor : p.outlineColor,
      label: `${i + 1} · ${name} · ${thickness} mm`,
      labelAt: { x, y: MARGIN + W + 4 + FONT },
      names: layer.names.map(n => ({ x: n.x + cx, y: n.y + cy, rot: 0, text: n.text, color: nameColor(p, layer) })),
    }
  })
  return { width: layers.length * (L + GAP) - GAP + 2 * MARGIN, height: W + FONT + 4 + 2 * MARGIN, pieces, font: FONT, stroke: STROKE }
}

/**
 * Everything to draw, in mm (y down). On sheets: the stock sheets (frames and titles) and on them every layer's cut
 * lines (kerf applied), object outlines, footprints, object names and label; sheet frames in the outline colour.
 * Otherwise all layers side by side (see layout), each label below its layer.
 * Labels, titles and object names, the footprints and the object outlines are left out when switched off.
 */
function drawing(p: Project, layers: Layer[], onSheets: boolean) {
  const all = drawn(p, layers, onSheets)
  return {
    ...all,
    titles: p.showLabels ? all.titles : [],
    pieces: all.pieces.map(pc => ({ ...pc, outlines: p.showOutlines ? pc.outlines : [], footprints: p.showFootprints ? pc.footprints : [], label: p.showLabels ? pc.label : [], names: p.showLabels ? pc.names : [] })),
  }
}

function drawn(p: Project, layers: Layer[], onSheets: boolean) {
  if (!onSheets) {
    const { width, height, pieces } = layout(p, layers)
    return {
      width,
      height,
      frames: [] as Contour[],
      titles: pieces.map(pc => ({ ...pc.labelAt, text: pc.label, color: pc.labelColor })),
      pieces: pieces.map((pc, i) => ({ layer: layers[i], cut: pc.cut, outlines: pc.outlines, footprints: pc.footprints, label: [] as Contour[], names: pc.names })),
    }
  }
  const { sheets, width, height } = planSheets(p, layers)
  const frame = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }): Contour =>
    ({ start: { x, y }, segments: [{ to: { x: x + w, y } }, { to: { x: x + w, y: y + h } }, { to: { x, y: y + h } }, { to: { x, y } }] })
  return {
    width,
    height,
    frames: sheets.map(frame),
    titles: sheets.map(s => ({ x: s.x, y: s.y - TITLE_RAISE, text: sheetTitle(sheets, s), color: p.labelColor })),
    pieces: sheets.flatMap(s => s.pieces.map(pc => {
      const { cut, outlines, footprints, label, names } = pieceShapes(p, s, pc)
      return { layer: pc.layer, cut: contours(cut), outlines: contours(outlines), footprints: contours(footprints), label: contours(label), names: names.map(n => ({ ...n, color: nameColor(p, pc.layer) })) }
    })),
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/**
 * One SVG in mm (see drawing), cut lines in the material colours; piece labels are outlines, turned with their piece.
 * The top layer's label is in the outline colour, as its face stays visible; object names are centred text (see nameColor).
 */
export function exportSvg(p: Project, layers: Layer[], onSheets: boolean): string {
  const { width, height, frames, titles, pieces } = drawing(p, layers, onSheets)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
<g id="sheets" fill="none" stroke="${p.outlineColor}" stroke-width="${STROKE}">
${frames.length ? `<path d="${svgPath(frames)}"/>` : ''}
</g>
<g id="outlines" fill="none" stroke="${p.outlineColor}" stroke-width="${STROKE}">
${pieces.filter(pc => pc.outlines.length).map(pc => `<path d="${svgPath(pc.outlines)}"/>`).join('\n')}
</g>
<g id="cut" fill="none" stroke-width="${STROKE}">
${pieces.map(pc => `<path stroke="${pc.layer.material.color}" d="${svgPath(pc.cut)}"/>`).join('\n')}
</g>
<g id="labels" fill="${p.labelColor}" font-family="sans-serif" font-size="${FONT}">
${titles.map(t => `<text x="${t.x}" y="${t.y}"${t.color === p.labelColor ? '' : ` fill="${t.color}"`}>${esc(t.text)}</text>`).join('\n')}
${pieces.flatMap(pc => pc.names).map(t => `<text x="${t.x}" y="${t.y + 0.35 * FONT}"${t.color === p.labelColor ? '' : ` fill="${t.color}"`} text-anchor="middle" transform="rotate(${t.rot} ${t.x} ${t.y})">${esc(t.text)}</text>`).join('\n')}
${pieces.filter(pc => pc.footprints.length).map(pc => `<path fill="none" stroke="${p.labelColor}" stroke-width="${STROKE}" d="${svgPath(pc.footprints)}"/>`).join('\n')}
${pieces.filter(pc => pc.label.length).map(pc => `<path fill="none" stroke="${pc.layer.index ? p.labelColor : p.outlineColor}" stroke-width="${STROKE}" d="${svgPath(pc.label)}"/>`).join('\n')}
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
 * one layer per foam layer (CUT_1_<material> …) in the nearest AutoCAD colour, plus SHEETS, OUTLINES and LABELS
 * (the top layer's label goes to OUTLINES, as in the SVG).
 */
export function exportDxf(p: Project, layers: Layer[], onSheets: boolean): string {
  const { height, frames, titles, pieces } = drawing(p, layers, onSheets)
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
  polylines(frames, 'SHEETS', aci(p.outlineColor))
  for (const t of titles) {
    const top = t.color !== p.labelColor
    out.push(0, 'TEXT', 8, top ? 'OUTLINES' : 'LABELS', 62, aci(t.color), 10, n(t.x), 20, n(height - t.y), 40, FONT, 1, t.text.replace(/·/g, '-'))
  }
  for (const pc of pieces) {
    polylines(pc.outlines, 'OUTLINES', aci(p.outlineColor))
    for (const t of pc.names) {
      // centred (72 = 1) on the middle (73 = 2) of the alignment point (11, 21)
      const x = n(t.x), y = n(height - t.y)
      const ref = t.color !== p.labelColor
      out.push(0, 'TEXT', 8, ref ? 'OUTLINES' : 'LABELS', 62, aci(t.color), 10, x, 20, y, 40, FONT, 1, t.text.replace(/·/g, '-'), 50, n(-t.rot), 72, 1, 11, x, 21, y, 73, 2)
    }
    polylines(pc.cut, `CUT_${pc.layer.index + 1}_${pc.layer.material.name.replace(/[^\w-]+/g, '_')}`, aci(pc.layer.material.color))
    polylines(pc.footprints, 'LABELS', label)
    if (pc.layer.index) polylines(pc.label, 'LABELS', label)
    else polylines(pc.label, 'OUTLINES', aci(p.outlineColor))
  }
  out.push(0, 'ENDSEC', 0, 'EOF')
  return out.join('\n') + '\n'
}
