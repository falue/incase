export type Shape = 'box' | 'cylinder' | 'lying' | 'sphere'
export type Dim = 'l' | 'w' | 'h' | 'd' | 'r'

export interface Material { id: string; name: string; thickness: number; color: string }
/** Circle cut from the foam top down to `depth`, offset (dx, dy) in the item's local frame. */
export interface Notch {
  dx: number
  dy: number
  d: number
  depth: number
  /** Placed by the app (may be re-spread when notches are added); cleared once moved by hand. */
  auto?: boolean
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
  clearance: number | null
  notches: Notch[]
}

export interface CaseDims {
  topL: number
  topW: number
  bottomL: number
  bottomW: number
  depth: number
  radius: number
  bottomRadius: number
  clearance: number
  /** Minimum foam between any two cuts and between cuts and the case wall. */
  safeZone: number
}

export interface Project {
  box: CaseDims
  materials: Material[]
  /** Material ids, top → bottom. */
  stack: string[]
  stackAuto: boolean
  items: Item[]
  labelColor: string
  /** Laser kerf in mm; the export offsets cut lines by half of it. */
  kerf: number
}

const KEY = 'incase.project'

export const uid = () => crypto.randomUUID()

export const itemHeight = (it: Item) => (it.shape === 'box' || it.shape === 'cylinder' ? it.h : it.d)

/** Footprint extent [x, y] in the item's local frame, without clearance. */
export function itemSize(it: Item): [number, number] {
  if (it.shape === 'box') return [it.l, it.w]
  if (it.shape === 'lying') return [it.l, it.d]
  return [it.d, it.d]
}

export function defaultItem(shape: Shape, name: string, offset: number): Item {
  return {
    id: uid(), name, shape, x: offset, y: offset, rot: 0, z: 0,
    l: 100, w: 60, h: 40, d: 60, r: 5, clearance: null, notches: [],
  }
}

const PERIMETER_STEPS = 96 // candidate notch positions around an item

/** Point at fraction t of the item's outline, starting at the bottom middle (local frame, y down). */
function perimeterPoint(it: Item, t: number) {
  if (it.shape === 'cylinder' || it.shape === 'sphere') {
    const r = it.d / 2, a = Math.PI / 2 + 2 * Math.PI * t
    return { x: r * Math.cos(a), y: r * Math.sin(a) }
  }
  const [l, w] = itemSize(it), hx = l / 2, hy = w / 2
  const corners = [[0, hy], [hx, hy], [hx, -hy], [-hx, -hy], [-hx, hy], [0, hy]]
  let s = t * 2 * (l + w)
  for (let i = 1; i < corners.length; i++) {
    const [x0, y0] = corners[i - 1], [x1, y1] = corners[i]
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (s <= len) return { x: x0 + ((x1 - x0) * s) / len, y: y0 + ((y1 - y0) * s) / len }
    s -= len
  }
  return { x: 0, y: hy }
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Adds a notch; `depth` is usually the top layer's thickness. On a sphere or standing cylinder whose notches were all placed by the app,
 * all notches are re-spread evenly around it (bottom, then top, then 120° apart, ...); otherwise the new notch goes
 * where it is farthest (along the outline) from the existing ones.
 */
export function addNotch(it: Item, depth: number) {
  const round = it.shape === 'sphere' || it.shape === 'cylinder'
  if (!round || !it.notches.every(n => n.auto)) return void it.notches.push(nextNotch(it, depth))
  it.notches.push({ dx: 0, dy: 0, d: 25, depth, auto: true })
  const r = it.d / 2, count = it.notches.length
  it.notches.forEach((n, k) => {
    const a = Math.PI / 2 + (2 * Math.PI * k) / count
    Object.assign(n, { dx: r2(r * Math.cos(a)), dy: r2(r * Math.sin(a)) })
  })
}

function nextNotch(it: Item, depth: number): Notch {
  const n = PERIMETER_STEPS
  const points = Array.from({ length: n }, (_, i) => perimeterPoint(it, i / n))
  const taken = it.notches.map(nb => {
    const dist = points.map(q => Math.hypot(q.x - nb.dx, q.y - nb.dy))
    return dist.indexOf(Math.min(...dist))
  })
  let best = 0
  if (taken.length) {
    const gap = (i: number) => Math.min(...taken.map(j => Math.min(Math.abs(i - j), n - Math.abs(i - j))))
    for (let i = 1; i < n; i++) if (gap(i) > gap(best)) best = i
  }
  return { dx: r2(points[best].x), dy: r2(points[best].y), d: 25, depth, auto: true }
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
  const camera = { ...defaultItem('box', 'Camera', 0), l: 130, w: 80, h: 60, r: 8 }
  addNotch(camera, materials.find(m => m.id === stack[0])!.thickness)
  return {
    box: { topL: 300, topW: 200, bottomL: 300, bottomW: 200, depth: 80, radius: 10, bottomRadius: 5, clearance: 1, safeZone: 5 },
    materials,
    stack,
    stackAuto: true,
    items: [camera],
    labelColor: '#ff00ff',
    kerf: 0,
  }
}

/** Parses a saved project, filling fields added in later versions. */
export function parseProject(json: string): Project {
  const p: Project = JSON.parse(json)
  p.box.safeZone ??= 5
  p.kerf ??= 0
  return p
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
