import { areaPathsD, differenceD, FillRule, getBoundsPathsD, minkowskiSumD, simplifyPathsD, unionD, type PathsD } from 'clipper2-ts'
import { caseOutline, itemCuts, offset, wallConflicts, stackTotal } from './geometry'
import type { Item, Project } from './model'

// notches and polygons are asymmetric; boxes and ovals repeat after 180°, round shapes never change
const rotations = (it: Item) =>
  it.notches.length || it.shape === 'polygon' ? [0, 90, 180, 270] : it.shape === 'box' || it.shape === 'lying' || it.d !== it.d2 ? [0, 90] : [it.rot]
const SIMPLIFY = 0.3 // mm; keeps the search fast, covered by MARGIN
const MARGIN = 0.5 // mm added to every gap
const SPREAD = { simplify: 0.5, maxStep: 16, minStep: 0.25, passes: 10 } // mm; even spreading
const DIRECTIONS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)])

type Placement = { x: number; y: number; rot: number }
export interface ArrangeResult { failed: number; placements: (Placement & { id: string })[] }
type Bounds = { left: number; top: number; right: number; bottom: number }

// area swept by the mirrored part along the edges of `paths`: reference positions where the part touches them.
// minkowskiSumD only sweeps the part's outline, so filled copies at every vertex close the gaps inside it.
function sweep(part: PathsD, paths: PathsD) {
  const mirrored = part.map(path => path.map(q => ({ x: -q.x, y: -q.y })))
  return unionD(paths.flatMap(path => [
    ...mirrored.flatMap(m => minkowskiSumD(m, path, true)),
    ...path.flatMap(q => mirrored.map(m => m.map(v => ({ x: v.x + q.x, y: v.y + q.y })))),
  ]), FillRule.NonZero)
}

/** Reference positions where `part` lies inside `bin` and clear of `obstacles` (no-fit polygons). */
export function freePositions(part: PathsD, bin: PathsD, obstacles: PathsD) {
  const inside = differenceD(bin, sweep(part, bin), FillRule.NonZero)
  return obstacles.length ? differenceD(inside, unionD([...sweep(part, obstacles), ...obstacles], FillRule.NonZero), FillRule.NonZero) : inside
}

/**
 * Packs the items into the bin, largest first, using no-fit polygons (the method SVGnest uses):
 * each item goes to the free position and rotation that keeps the bounding box of all placed items smallest.
 * `gap` is the minimum distance between items and to the bin edge.
 */
function pack(p: Project, outline: PathsD, gap: number, tolerance: number) {
  const bin = simplifyPathsD(offset(outline, -gap), tolerance)
  const footprint = (it: Item, rot: number) =>
    simplifyPathsD(unionD(itemCuts({ ...it, x: 0, y: 0, rot }, -Infinity), FillRule.NonZero), tolerance)

  const order = p.items
    .map(it => ({ it, area: Math.abs(areaPathsD(footprint(it, 0))) }))
    .sort((a, b) => b.area - a.area)
  const placements = new Map<Item, Placement>()
  let placed: PathsD = [] // placed footprints grown by the gap
  let box: Bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity } // of the placed footprints

  for (const { it } of order) {
    let best: (Placement & { part: PathsD; score: number }) | null = null
    for (const rot of rotations(it)) {
      const part = footprint(it, rot)
      const free = freePositions(part, bin, placed)
      const b = getBoundsPathsD(part)
      for (const q of free.flat()) {
        const w = Math.max(box.right, q.x + b.right) - Math.min(box.left, q.x + b.left)
        const h = Math.max(box.bottom, q.y + b.bottom) - Math.min(box.top, q.y + b.top)
        const score = w * h + 1e-3 * (q.x + q.y) // ties go to the top-left
        if (!best || score < best.score) best = { x: q.x, y: q.y, rot, part, score }
      }
    }
    if (!best) continue
    const { x, y } = best
    placements.set(it, { x, y, rot: best.rot })
    const at = best.part.map(path => path.map(q => ({ x: q.x + x, y: q.y + y })))
    placed = unionD([...placed, ...offset(at, gap)], FillRule.NonZero)
    const b = getBoundsPathsD(at)
    box = { left: Math.min(box.left, b.left), top: Math.min(box.top, b.top), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) }
  }
  return { placements, box, failed: p.items.length - placements.size }
}

const segmentDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const vx = bx - ax, vy = by - ay, len = vx * vx + vy * vy
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len)) : 0
  return Math.hypot(px - ax - t * vx, py - ay - t * vy)
}

/** Smallest distance between the outlines of two non-overlapping shapes, `b` moved by (dx, dy). */
function outlineDistance(a: PathsD, b: PathsD, dx: number, dy: number) {
  let d = Infinity
  const edges = (from: PathsD, to: PathsD, ox: number, oy: number) => {
    for (const path of from) for (const q of path) {
      for (const t of to) for (let i = 0; i < t.length; i++) {
        const r = t[i], s = t[(i + 1) % t.length]
        d = Math.min(d, segmentDistance(q.x + ox, q.y + oy, r.x, r.y, s.x, s.y))
      }
    }
  }
  edges(a, b.map(path => path.map(q => ({ x: q.x + dx, y: q.y + dy }))), 0, 0)
  edges(b, a, dx, dy)
  return d
}

/**
 * Moves each item in shrinking steps towards the spot where its distance to the nearest item or wall is largest,
 * so space between items and to the case ends up about equal. Steps stay below that distance, so nothing can pass
 * through anything, and no distance ever shrinks below the starting minimum.
 */
function spread(p: Project, outline: PathsD) {
  const parts = p.items.map(it => ({
    it,
    shape: simplifyPathsD(unionD(itemCuts({ ...it, x: 0, y: 0 }, -Infinity), FillRule.NonZero), SPREAD.simplify),
  }))
  const room = (i: number, x: number, y: number) =>
    parts.reduce((c, o, j) => (j === i ? c : Math.min(c, outlineDistance(parts[i].shape, o.shape, o.it.x - x, o.it.y - y))),
      outlineDistance(outline, parts[i].shape, x, y))
  for (let step = SPREAD.maxStep; step >= SPREAD.minStep; step /= 2) {
    for (let pass = 0, moved = true; moved && pass < SPREAD.passes; pass++) {
      moved = false
      parts.forEach(({ it }, i) => {
        const c = room(i, it.x, it.y), d = Math.min(step, c * 0.9)
        let best = { c, x: it.x, y: it.y }
        for (const [ux, uy] of DIRECTIONS) {
          const x = it.x + ux * d, y = it.y + uy * d, nc = room(i, x, y)
          if (nc > best.c + 1e-3) best = { c: nc, x, y }
        }
        if (best.c > c) {
          Object.assign(it, { x: best.x, y: best.y })
          moved = true
        }
      })
    }
  }
}

/**
 * Arranges all items inside the case: packed tightly at the min. wall and centred, or (`even`) packed and then
 * spread so the space between items and to the case is about equal.
 * Items that do not fit stay where they are; returns how many that were.
 */
export function autoArrange(p: Project, even: boolean): number {
  const s = Math.max(p.box.minWall, 0)
  const outline = caseOutline(p.box, p.box.depth - stackTotal(p), p.box.depth) // narrowest section of the stack
  if (!outline) return p.items.length
  const result = pack(p, [outline], s + MARGIN, SIMPLIFY)
  for (const [it, at] of result.placements) Object.assign(it, at)
  if (result.failed) return result.failed

  // centre the group in the case; keep it uncentred if that would break the min. wall
  const b = getBoundsPathsD([outline]), g = result.box
  const dx = (b.left + b.right - g.left - g.right) / 2, dy = (b.top + b.bottom - g.top - g.bottom) / 2
  for (const it of p.items) Object.assign(it, { x: it.x + dx, y: it.y + dy })
  if (wallConflicts(p).size) for (const it of p.items) Object.assign(it, { x: it.x - dx, y: it.y - dy })

  if (even) spread(p, [outline])
  return 0
}
