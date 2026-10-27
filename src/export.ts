import { offset, pathData, type Layer } from './geometry'
import type { Project } from './model'

const GAP = 10
const MARGIN = 5
const FONT = 5
const STROKE = 0.3528 // mm = 1 pt

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/** All layers side by side in one SVG (mm), cut lines in material colours, labels below each layer.
 * Kerf: the pieces grow by half the kerf (outer edges out, holes in), so they come out at nominal size. */
export function exportSvg(p: Project, layers: Layer[]): string {
  const L = Math.max(p.box.topL, p.box.bottomL)
  const W = Math.max(p.box.topW, p.box.bottomW)
  const width = layers.length * (L + GAP) - GAP + 2 * MARGIN
  const height = W + FONT + 4 + 2 * MARGIN
  const cuts: string[] = []
  const labels: string[] = []
  layers.forEach((layer, i) => {
    const x0 = MARGIN + i * (L + GAP)
    const { name, thickness, color } = layer.material
    const paths = p.kerf > 0 ? offset(layer.paths, p.kerf / 2) : layer.paths
    cuts.push(`<path stroke="${color}" d="${pathData(paths, x0 + L / 2, MARGIN + W / 2)}"/>`)
    labels.push(`<text x="${x0}" y="${MARGIN + W + 4 + FONT}">${esc(`${i + 1} · ${name} · ${thickness} mm`)}</text>`)
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
<g id="cut" fill="none" stroke-width="${STROKE}">
${cuts.join('\n')}
</g>
<g id="labels" fill="${p.labelColor}" font-family="sans-serif" font-size="${FONT}">
${labels.join('\n')}
</g>
</svg>
`
}
