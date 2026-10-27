import { areaPathsD, booleanOpDWithPolyTree, ClipType, differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, PolyTreeD, polyTreeToPathsD, unionD, type PathD, type PathsD, type PointD } from 'clipper2-ts'
import { itemHeight, perimeterPoint, type CaseDims, type Item, type Material, type Project } from './model'

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

/** Cutouts of an item (incl. notches) for the foam slab starting at depth a (from the foam top), with the item's top
 * at depth `z` (see resting). Every slab from the foam top down to the item's bottom is cut, so it can be lifted out. */
export function itemCuts(it: Item, a: number, globalFit: number, z = it.z): PathsD {
  const c = it.fit ?? globalFit
  const out: PathsD = []
  if (a < z + itemHeight(it) - EPS) {
    let shape: PathD | null
    if (it.shape === 'box') shape = roundedRect(it.l + 2 * c, it.w + 2 * c, it.r + c)
    else if (it.shape === 'cylinder') shape = circle(it.d / 2 + c)
    else {
      // full width above the centre, below it the widest section is at the slab top
      const r = it.d / 2
      const dz = Math.max(0, a - (z + r))
      const half = Math.sqrt(Math.max(0, r * r - dz * dz))
      shape = it.shape === 'sphere' ? circle(half + c) : roundedRect(it.l + 2 * c, 2 * (half + c), 0)
    }
    if (shape) out.push(shape)
  }
  const notch = a < it.notchDepth - EPS && it.notches.length ? circle(it.notchD / 2) : null
  if (notch) {
    for (const n of it.notches) {
      const c = perimeterPoint(it, n.t)
      out.push(translate(notch, c.x, c.y))
    }
  }
  const placed = out.map(p => place(p, it))
  // grow then shrink: rounds the inner corners where notches meet the body or each other, keeps outer corners
  return notch && it.notchR > 0 ? offset(offset(placed, it.notchR), -it.notchR) : placed
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

/**
 * Where an item really sits: its cut ends on a layer boundary, so it sinks onto the layer below its cut.
 * Returns its top depth (from the foam top) and the index of the layer it rests on (-1 = the case floor).
 * Items reaching below the stack stand on the case floor.
 */
export function resting(p: Project, it: Item): { z: number; layer: number } {
  const h = itemHeight(it)
  const thickness = p.stack.map(id => p.materials.find(m => m.id === id)?.thickness ?? 0)
  let b = 0
  for (let i = 0; i < thickness.length; i++) {
    b += thickness[i]
    if (b >= it.z + h - EPS) return { z: b - h, layer: i + 1 < thickness.length ? i + 1 : -1 }
  }
  return { z: b - h, layer: -1 }
}

export interface Layer {
  index: number
  material: Material
  a: number
  b: number
  tree: PolyTreeD
  paths: PathsD
  /** Outlines of the objects themselves (no fit, no notches). */
  outlines: PathsD
}

/** The object's own outline in a slab (or its footprint for a = -Infinity), without fit and notches. */
export const objectOutline = (it: Item, a: number, z = it.z) =>
  unionD(itemCuts({ ...it, fit: 0, notches: [] }, a, 0, z), FillRule.NonZero)

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
      const cuts = p.items.flatMap(it => itemCuts(it, a, p.box.fit, resting(p, it).z))
      booleanOpDWithPolyTree(ClipType.Difference, [outline], cuts, tree, FillRule.NonZero, 3)
    }
    const outlines = unionD(p.items.flatMap(it => objectOutline(it, a, resting(p, it).z)), FillRule.NonZero)
    return { index, material, a, b, tree, paths: polyTreeToPathsD(tree), outlines }
  })
}

export const AREA_TOL = 0.01 // mm², ignores rounding slivers

/**
 * How badly items break the min. wall, summed over all layers (mm²): the area of their cuts closer than it to the case
 * plus the area of other items' cuts closer than it to them. 0 = clear. `only` limits the work to one item.
 */
export function wallViolations(p: Project, only?: Item): Map<string, number> {
  const s = Math.max(p.box.minWall, 0)
  const result = new Map<string, number>()
  const area = (paths: PathsD) => Math.abs(areaPathsD(paths))
  const zs = p.items.map(it => resting(p, it).z)
  for (const { a, outline } of slabs(p)) {
    const cuts = p.items.map((it, i) => itemCuts(it, a, p.box.fit, zs[i]))
    const inner = outline ? (s ? offset([outline], -s) : [outline]) : []
    p.items.forEach((it, i) => {
      if (!cuts[i].length || (only && it !== only)) return
      const zone = s ? offset(cuts[i], s) : cuts[i]
      let v = area(differenceD(cuts[i], inner, FillRule.NonZero))
      cuts.forEach((other, j) => {
        if (j !== i && other.length) v += area(intersectD(zone, other, FillRule.NonZero))
      })
      result.set(it.id, (result.get(it.id) ?? 0) + v)
    })
  }
  return result
}

/** Ids of items whose cuts leave the case or come closer than the min. wall to another item's cuts or the case, in any layer. */
export const wallConflicts = (p: Project) =>
  new Set([...wallViolations(p)].filter(([, v]) => v > AREA_TOL).map(([id]) => id))

export const pathData = (paths: PathsD, dx = 0, dy = 0) =>
  paths.map(p => 'M' + p.map(q => `${(q.x + dx).toFixed(2)} ${(q.y + dy).toFixed(2)}`).join('L') + 'Z').join('')
