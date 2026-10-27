export type Shape = 'box' | 'cylinder' | 'lying' | 'sphere' | 'polygon'
export type Dim = 'l' | 'w' | 'h' | 'd' | 'r'

export interface Material { id: string; name: string; thickness: number; color: string }
/** Finger notch centred on the item's outline at fraction `t` of the way around (see perimeterPoint). */
export interface Notch {
  t: number
  /** Moved by hand; such notches are never re-spread. */
  manual?: boolean
}

/** All dims are kept for every shape so switching shapes is lossless; z is measured from the foam top. */
export interface Item extends Record<Dim, number> {
  id: string
  name: string
  shape: Shape
  x: number
  y: number
  rot: number
  z: number
  /** How much bigger (+, loose) or smaller (−, tight grip) the cutout is than the object. */
  fit: number
  notches: Notch[]
  /** Corner points of a polygon item in its local frame (empty for other shapes). */
  pts: { x: number; y: number }[]
  /** Diameter and depth (from the foam top) of all notches. */
  notchD: number
  notchDepth: number
  /** Fillet radius where notches meet the object or each other. */
  notchR: number
}

export interface CaseDims {
  topL: number
  topW: number
  bottomL: number
  bottomW: number
  depth: number
  radius: number
  bottomRadius: number
  /** Minimum material wall thickness: least foam between any two cuts and between cuts and the case wall. */
  minWall: number
  /** Inner depth of the lid; case depth + lid depth is the tallest anything may reach. */
  lidDepth: number
  /** Values a preset had no data for (0 or assumed); cleared per field once edited. */
  unknown: CaseKey[]
  /** Label ("Brand - model") of the preset last applied, shown while the values still match it. */
  preset?: string
}

/** Case values a preset can fill in. */
export type CaseKey = 'topL' | 'topW' | 'bottomL' | 'bottomW' | 'depth' | 'lidDepth' | 'radius' | 'bottomRadius'

export interface Project {
  box: CaseDims
  materials: Material[]
  /** Material ids, top → bottom. */
  stack: string[]
  stackAuto: boolean
  items: Item[]
  labelColor: string
  /** Width of the cut (laser, mill, knife) in mm; the export offsets cut lines by half of it. */
  kerf: number
}

const KEY = 'incase.project'

export const uid = () => crypto.randomUUID()

export const itemHeight = (it: Item) => (it.shape === 'lying' || it.shape === 'sphere' ? it.d : it.h)

/** Footprint extent [x, y] in the item's local frame, before the fit is applied. */
export function itemSize(it: Item): [number, number] {
  if (it.shape === 'box') return [it.l, it.w]
  if (it.shape === 'lying') return [it.l, it.d]
  if (it.shape === 'polygon') {
    const xs = it.pts.map(p => p.x), ys = it.pts.map(p => p.y)
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
  }
  return [it.d, it.d]
}

/** Polygon corners for an item switched to the polygon shape: its box outline. */
export const boxCorners = (it: Item) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ x: (sx * it.l) / 2, y: (sy * it.w) / 2 }))

/** `notchDepth` is usually the top layer's thickness. */
export function defaultItem(shape: Shape, name: string, offset: number, notchDepth: number): Item {
  return {
    id: uid(), name, shape, x: offset, y: offset, rot: 0, z: 0,
    l: 100, w: 60, h: 40, d: 60, r: 5, fit: 0, notches: [], pts: [], notchD: 25, notchDepth, notchR: 3,
  }
}

const PERIMETER_STEPS = 96 // candidate positions for new notches
const PARAM_SAMPLES = 720 // resolution when mapping a point onto the outline

/** Point at fraction t of the item's outline, starting at the bottom middle (local frame, y down). */
export function perimeterPoint(it: Item, t: number) {
  if (it.shape === 'cylinder' || it.shape === 'sphere') {
    const r = it.d / 2, a = Math.PI / 2 + 2 * Math.PI * t
    return { x: r * Math.cos(a), y: r * Math.sin(a) }
  }
  const [l, w] = itemSize(it), hx = l / 2, hy = w / 2
  const corners = it.shape === 'polygon'
    ? [...it.pts, it.pts[0]].map(p => [p.x, p.y])
    : [[0, hy], [hx, hy], [hx, -hy], [-hx, -hy], [-hx, hy], [0, hy]]
  const total = corners.slice(1).reduce((sum, [x, y], i) => sum + Math.hypot(x - corners[i][0], y - corners[i][1]), 0)
  let s = (((t % 1) + 1) % 1) * total
  for (let i = 1; i < corners.length; i++) {
    const [x0, y0] = corners[i - 1], [x1, y1] = corners[i]
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (s <= len) return { x: x0 + ((x1 - x0) * s) / len, y: y0 + ((y1 - y0) * s) / len }
    s -= len
  }
  return { x: corners[0][0], y: corners[0][1] }
}

/** Fraction of the way around the outline closest to the local point (x, y). */
export function perimeterParam(it: Item, x: number, y: number) {
  let best = 0, bestDist = Infinity
  for (let i = 0; i < PARAM_SAMPLES; i++) {
    const q = perimeterPoint(it, i / PARAM_SAMPLES), d = Math.hypot(q.x - x, q.y - y)
    if (d < bestDist) [best, bestDist] = [i / PARAM_SAMPLES, d]
  }
  return best
}

/**
 * Adds or removes notches until there are `count`. New ones go where they are farthest (along the outline) from the
 * others: bottom, top, right, left, then halfway between. Round items whose notches were all placed by the app
 * get them re-spread evenly (bottom, then top, then 120° apart, ...). Removing drops the newest.
 */
export function setNotchCount(it: Item, count: number) {
  it.notches.length = Math.min(it.notches.length, Math.max(0, count))
  while (it.notches.length < count) {
    const gap = (t: number) => Math.min(...it.notches.map(n => Math.min(Math.abs(t - n.t), 1 - Math.abs(t - n.t))))
    let best = 0
    for (let i = 1; i < PERIMETER_STEPS; i++) if (gap(i / PERIMETER_STEPS) > gap(best)) best = i / PERIMETER_STEPS
    it.notches.push({ t: best })
  }
  if ((it.shape === 'sphere' || it.shape === 'cylinder') && !it.notches.some(n => n.manual)) {
    it.notches.forEach((n, k) => (n.t = k / it.notches.length))
  }
}

/** Fills `depth` with as few layers as possible, preferring materials earlier in the list; never exceeds depth. */
export function suggestStack(materials: Material[], depth: number): string[] {
  const units = materials.map(m => Math.round(m.thickness * 10))
  const target = Math.max(0, Math.round(depth * 10))
  // best[s] = [layer count, preference cost, last material index] of the cheapest combination summing to s
  const best: ([number, number, number] | undefined)[] = [[0, 0, -1]]
  for (let s = 1; s <= target; s++) {
    units.forEach((u, i) => {
      const prev = u > 0 && u <= s ? best[s - u] : undefined
      if (!prev) return
      const cur = best[s]
      const cand: [number, number, number] = [prev[0] + 1, prev[1] + i, i]
      if (!cur || cand[0] < cur[0] || (cand[0] === cur[0] && cand[1] < cur[1])) best[s] = cand
    })
  }
  let s = target
  while (s > 0 && !best[s]) s--
  const picks: number[] = []
  for (; s > 0; s -= units[best[s]![2]]) picks.push(best[s]![2])
  return picks.sort((a, b) => a - b).map(i => materials[i].id)
}

function defaultProject(): Project {
  const materials: Material[] = [
    { id: uid(), name: 'Foam 30', thickness: 30, color: '#000000' },
    { id: uid(), name: 'Foam 10', thickness: 10, color: '#ff0000' },
    { id: uid(), name: 'Foam 5', thickness: 5, color: '#0000ff' },
  ]
  const stack = suggestStack(materials, 80)
  const camera = { ...defaultItem('box', 'Camera', 0, materials.find(m => m.id === stack[0])!.thickness), l: 130, w: 80, h: 60, r: 8 }
  setNotchCount(camera, 1)
  return {
    box: { topL: 300, topW: 200, bottomL: 300, bottomW: 200, depth: 80, radius: 10, bottomRadius: 5, minWall: 5, lidDepth: 20, unknown: [] },
    materials,
    stack,
    stackAuto: true,
    items: [camera],
    labelColor: '#ff00ff',
    kerf: 0,
  }
}

export const parseProject = (json: string): Project => JSON.parse(json)

/** Empty project for the guided setup: default case and materials, no objects. */
export function newProject(): Project {
  return { ...defaultProject(), items: [] }
}

export function loadProject(): Project {
  const raw = localStorage.getItem(KEY)
  if (raw) {
    try {
      return parseProject(raw)
    } catch {
      // corrupt storage: fall back to defaults
    }
  }
  return defaultProject()
}

let saveTimer = 0
export function saveProject(p: Project) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(p)), 300)
}
