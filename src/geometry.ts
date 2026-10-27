import { booleanOpDWithPolyTree, ClipType, FillRule, PolyTreeD, polyTreeToPathsD, type PathD, type PathsD, type PointD } from 'clipper2-ts'
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

export function roundedRect(l: number, w: number, r: number): PathD | null {
  const hx = l / 2, hy = w / 2
  if (hx <= 0 || hy <= 0) return null
  r = Math.min(Math.max(r, 0), hx, hy)
  const corners = [[hx - r, hy - r], [-hx + r, hy - r], [-hx + r, -hy + r], [hx - r, -hy + r]]
  const n = r < TOL ? 0 : segments(r, Math.PI / 2)
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

/** Cutouts of an item (incl. notches) for the foam slab between depths a and b (from the top). */
export function itemCuts(it: Item, a: number, b: number, globalClearance: number): PathsD {
  const c = it.clearance ?? globalClearance
  const top = it.z
  const out: PathsD = []
  if (top < b - EPS && top + itemHeight(it) > a + EPS) {
    let shape: PathD | null
    if (it.shape === 'box') shape = roundedRect(it.l + 2 * c, it.w + 2 * c, it.r + c)
    else if (it.shape === 'cylinder') shape = circle(it.d / 2 + c)
    else {
      // widest cross-section within the slab
      const r = it.d / 2, zc = top + r
      const dz = Math.min(Math.max(zc, a), b) - zc
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

/** Case cavity outline for the slab between a and b: the narrowest section of the slab (taper + bottom edge radius). */
export function caseOutline(box: CaseDims, a: number, b: number): PathD | null {
  const lerp = (top: number, bottom: number, z: number) => {
    const t = box.depth > 0 ? Math.min(Math.max(z / box.depth, 0), 1) : 0
    return top + (bottom - top) * t
  }
  const R = box.bottomRadius, d = Math.max(0, box.depth - b)
  const inset = d < R ? R - Math.sqrt(R * R - (R - d) ** 2) : 0
  const l = Math.min(lerp(box.topL, box.bottomL, a), lerp(box.topL, box.bottomL, b))
  const w = Math.min(lerp(box.topW, box.bottomW, a), lerp(box.topW, box.bottomW, b))
  return roundedRect(l - 2 * inset, w - 2 * inset, box.radius - inset)
}

export interface Layer {
  index: number
  material: Material
  a: number
  b: number
  tree: PolyTreeD
  paths: PathsD
}

export function computeLayers(p: Project): Layer[] {
  const layers: Layer[] = []
  let a = 0
  for (const id of p.stack) {
    const material = p.materials.find(m => m.id === id)
    if (!material) continue
    const b = a + material.thickness
    const outline = caseOutline(p.box, a, b)
    const tree = new PolyTreeD()
    if (outline) {
      const cuts = p.items.flatMap(it => itemCuts(it, a, b, p.box.clearance))
      booleanOpDWithPolyTree(ClipType.Difference, [outline], cuts, tree, FillRule.NonZero, 3)
    }
    layers.push({ index: layers.length, material, a, b, tree, paths: polyTreeToPathsD(tree) })
    a = b
  }
  return layers
}

export const pathData = (paths: PathsD, dx = 0, dy = 0) =>
  paths.map(p => 'M' + p.map(q => `${(q.x + dx).toFixed(2)} ${(q.y + dy).toFixed(2)}`).join('L') + 'Z').join('')
