import type { PathsD, PointD } from 'clipper2-ts'

// Clipper works on polygons; for the export, runs of points that lie on a common circle become real SVG arcs again.
const FIT_TOL = 0.05 // mm, max distance of a point from its fitted arc
const MAX_SAGITTA = 0.1 // mm; segments of generated arcs bulge 0.02 mm, longer chords are real straight edges
const MAX_RADIUS = 1e4 // mm; flatter runs stay lines
const MAX_SPAN = (300 * Math.PI) / 180 // longer arcs are split in two (SVG cannot draw a full circle in one arc)
const MERGE = 0.05 // mm; nearly coincident points (e.g. from offsetting) make circle fits unstable

type Circle = { x: number; y: number; r: number }

function circleThrough(a: PointD, b: PointD, c: PointD): Circle | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  return { x, y, r: Math.hypot(a.x - x, a.y - y) }
}

/** Circle through pts[i..j] if they form one smooth arc, else null. */
function fit(pts: PointD[], i: number, j: number): Circle | null {
  // a run around a whole closed path ends where it started; that point cannot define the circle twice
  const end = pts[j].x === pts[i].x && pts[j].y === pts[i].y ? j - 1 : j
  const c = circleThrough(pts[i], pts[(i + end) >> 1], pts[end])
  if (!c || c.r > MAX_RADIUS) return null
  for (let k = i; k <= j; k++) {
    if (Math.abs(Math.hypot(pts[k].x - c.x, pts[k].y - c.y) - c.r) > FIT_TOL) return null
    if (k === j) break
    const half = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y) / 2
    if (half >= c.r || c.r - Math.sqrt(c.r * c.r - half * half) > MAX_SAGITTA) return null
  }
  return c
}

const num = (v: number) => String(Math.round(v * 1000) / 1000)
const pt = (p: PointD) => `${num(p.x)} ${num(p.y)}`

/** SVG arc commands along circle `c` from pts[i] to pts[j]. */
function arc(pts: PointD[], i: number, j: number, c: Circle): string {
  let span = 0 // signed; positive = clockwise on screen (y points down) = SVG sweep flag 1
  for (let k = i; k < j; k++) {
    const a0 = Math.atan2(pts[k].y - c.y, pts[k].x - c.x), a1 = Math.atan2(pts[k + 1].y - c.y, pts[k + 1].x - c.x)
    span += Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
  }
  if (Math.abs(span) > MAX_SPAN) {
    const m = (i + j) >> 1
    return arc(pts, i, m, c) + arc(pts, m, j, c)
  }
  return `A${num(c.r)} ${num(c.r)} 0 ${Math.abs(span) > Math.PI ? 1 : 0} ${span > 0 ? 1 : 0} ${pt(pts[j])}`
}

/** Closed SVG path data with lines and circular arcs, moved by (dx, dy). */
export function curveData(paths: PathsD, dx = 0, dy = 0): string {
  return paths.map(raw => {
    const path = raw.filter((p, k) => {
      const prev = raw[(k + raw.length - 1) % raw.length]
      return k === 0 || Math.hypot(p.x - prev.x, p.y - prev.y) >= MERGE
    })
    // start at a corner (a point not inside a smooth arc) so no arc is split at the start
    const n = path.length, at = (k: number) => path[(k + n) % n]
    const start = Math.max(0, path.findIndex((_, k) => !fit([at(k - 1), at(k), at(k + 1)], 0, 2)))
    const pts = [...path.slice(start), ...path.slice(0, start + 1)].map(p => ({ x: p.x + dx, y: p.y + dy }))
    let d = `M${pt(pts[0])}`
    for (let i = 0; i < pts.length - 1;) {
      // grow an arc from i as far as the points stay on one circle (at least two segments)
      let j = i, c: Circle | null = null
      for (let k = i + 2; k < pts.length; k++) {
        const next = fit(pts, i, k)
        if (!next) break
        j = k
        c = next
      }
      if (c) {
        d += arc(pts, i, j, c)
        i = j
      } else d += `L${pt(pts[++i])}`
    }
    return d + 'Z'
  }).join('')
}
