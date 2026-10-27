import { areaPathsD, booleanOpDWithPolyTree, ClipType, differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, PolyTreeD, polyTreeToPathsD, type PathD, type PathsD, type PointD } from 'clipper2-ts'
import { itemHeight, type CaseDims, type Item, type Material, type Project } from './model'

const TOL = 0.02 // max chord deviation of arcs in mm
const EPS = 1e-6

const segments = (r: number, angle: number) => Math.max(3, Math.ceil(angle / (2 * Math.acos(Math.max(0, 1 - TOL / r)))))

// All shapes run in the same rotational direction so NonZero unions never cancel out.
export function circle(r: number): PathD | null {
  if (r <= 0) return null
  const n = Math.max(12, segments(r, 2 * Math.PI))
  return Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }))
}

/** `perCorner` fixes the arc segment count (for lofting); by default it follows the chord tolerance. */
export function roundedRect(l: number, w: number, r: number, perCorner?: number): PathD | null {
  const hx = l / 2, hy = w / 2
  if (hx <= 0 || hy <= 0) return null
  r = Math.min(Math.max(r, 0), hx, hy)
  const corners = [[hx - r, hy - r], [-hx + r, hy - r], [-hx + r, -hy + r], [hx - r, -hy + r]]
  const n = perCorner ?? (r < TOL ? 0 : segments(r, Math.PI / 2))
  const path: PathD = []
  corners.forEach(([cx, cy], k) => {
    for (let i = 0; i <= n; i++) {
      const t = ((k + (n ? i / n : 0)) * Math.PI) / 2
      path.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
    }
  })
  return path
}

const translate = (path: PathD, dx: number, dy: number) => path.map(p => ({ x: p.x + dx, y: p.y + dy }))

/** Local item frame → plan: rotate by item.rot (degrees, clockwise on screen since y points down), then move. */
export function place(path: PathD, it: Item): PathD {
  const a = (it.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return path.map((p: PointD) => ({ x: it.x + p.x * c - p.y * s, y: it.y + p.x * s + p.y * c }))
}

/** Cutouts of an item (incl. notches) for the foam slab starting at depth a (from the foam top).
 * Every slab from the foam top down to the item's bottom is cut, so the item can be lifted out. */
export function itemCuts(it: Item, a: number, globalClearance: number): PathsD {
  const c = it.clearance ?? globalClearance
  const out: PathsD = []
  if (a < it.z + itemHeight(it) - EPS) {
    let shape: PathD | null
    if (it.shape === 'box') shape = roundedRect(it.l + 2 * c, it.w + 2 * c, it.r + c)
    else if (it.shape === 'cylinder') shape = circle(it.d / 2 + c)
    else {
      // full width above the centre, below it the widest section is at the slab top
      const r = it.d / 2
      const dz = Math.max(0, a - (it.z + r))
      const half = Math.sqrt(Math.max(0, r * r - dz * dz))
      shape = it.shape === 'sphere' ? circle(half + c) : roundedRect(it.l + 2 * c, 2 * (half + c), 0)
    }
    if (shape) out.push(shape)
  }
  for (const n of it.notches) {
    const s = a < n.depth - EPS ? circle(n.d / 2) : null
    if (s) out.push(translate(s, n.dx, n.dy))
  }
  return out.map(p => place(p, it))
}

const sizeAt = (box: CaseDims, z: number) => {
  const t = box.depth > 0 ? Math.min(Math.max(z / box.depth, 0), 1) : 0
  return [box.topL + (box.bottomL - box.topL) * t, box.topW + (box.bottomW - box.topW) * t]
}

/** How far the bottom edge radius pulls the wall inwards at depth z (from the case top). */
const insetAt = (box: CaseDims, z: number) => {
  const R = box.bottomRadius, d = Math.max(0, box.depth - z)
  return d < R ? R - Math.sqrt(R * R - (R - d) ** 2) : 0
}

/** Cavity cross-section at depth z (from the case top). */
export function caseSection(box: CaseDims, z: number) {
  const [l, w] = sizeAt(box, z), inset = insetAt(box, z)
  return { l: l - 2 * inset, w: w - 2 * inset, r: box.radius - inset }
}

/** Case cavity outline for the slab between a and b (from the case top): the narrowest section of the slab. */
export function caseOutline(box: CaseDims, a: number, b: number): PathD | null {
  const [la, wa] = sizeAt(box, a), [lb, wb] = sizeAt(box, b), inset = insetAt(box, b)
  return roundedRect(Math.min(la, lb) - 2 * inset, Math.min(wa, wb) - 2 * inset, box.radius - inset)
}

export const stackTotal = (p: Project) => p.stack.reduce((sum, id) => sum + (p.materials.find(m => m.id === id)?.thickness ?? 0), 0)

/** Grows (+) or shrinks (−) shapes by `delta` with round corners. */
export const offset = (paths: PathsD, delta: number) => inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon)

export interface Layer {
  index: number
  material: Material
  a: number
  b: number
  tree: PolyTreeD
  paths: PathsD
}

/** Foam slabs top → bottom; a and b are measured from the foam top, the stack rests on the case floor. */
function slabs(p: Project) {
  const foamTop = p.box.depth - stackTotal(p)
  let a = 0
  return p.stack.flatMap(id => {
    const material = p.materials.find(m => m.id === id)
    if (!material) return []
    const b = a + material.thickness
    const slab = { material, a, b, outline: caseOutline(p.box, foamTop + a, foamTop + b) }
    a = b
    return [slab]
  })
}

export function computeLayers(p: Project): Layer[] {
  return slabs(p).map(({ material, a, b, outline }, index) => {
    const tree = new PolyTreeD()
    if (outline) {
      const cuts = p.items.flatMap(it => itemCuts(it, a, p.box.clearance))
      booleanOpDWithPolyTree(ClipType.Difference, [outline], cuts, tree, FillRule.NonZero, 3)
    }
    return { index, material, a, b, tree, paths: polyTreeToPathsD(tree) }
  })
}

const AREA_TOL = 0.01 // mm², ignores rounding slivers

/** Ids of items whose cuts come closer than the safe zone to another item's cuts or to the case wall, in any layer. */
export function safeZoneConflicts(p: Project): Set<string> {
  const s = p.box.safeZone
  const conflicts = new Set<string>()
  if (s <= 0) return conflicts
  for (const { a, outline } of slabs(p)) {
    const cuts = p.items.map(it => itemCuts(it, a, p.box.clearance))
    const inner = outline ? offset([outline], -s) : []
    p.items.forEach((it, i) => {
      if (!cuts[i].length) return
      if (Math.abs(areaPathsD(differenceD(cuts[i], inner, FillRule.NonZero))) > AREA_TOL) conflicts.add(it.id)
      const zone = offset(cuts[i], s)
      cuts.forEach((other, j) => {
        if (j !== i && other.length && Math.abs(areaPathsD(intersectD(zone, other, FillRule.NonZero))) > AREA_TOL) conflicts.add(it.id)
      })
    })
  }
  return conflicts
}

export const pathData = (paths: PathsD, dx = 0, dy = 0) =>
  paths.map(p => 'M' + p.map(q => `${(q.x + dx).toFixed(2)} ${(q.y + dy).toFixed(2)}`).join('L') + 'Z').join('')
