export type Shape = 'box' | 'cylinder' | 'lying' | 'sphere'
export type Dim = 'l' | 'w' | 'h' | 'd' | 'r'

export interface Material { id: string; name: string; thickness: number; color: string }
/** Circle cut from the foam top down to `depth`, offset (dx, dy) in the item's local frame. */
export interface Notch { dx: number; dy: number; d: number; depth: number }

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
}

export interface Project {
  box: CaseDims
  materials: Material[]
  /** Material ids, top → bottom. */
  stack: string[]
  stackAuto: boolean
  items: Item[]
  labelColor: string
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

export function defaultNotch(it: Item): Notch {
  const side = it.notches.length % 2 ? -1 : 1
  return { dx: 0, dy: (side * itemSize(it)[1]) / 2, d: 25, depth: Math.round(it.z + itemHeight(it) * 0.75) }
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
  const camera = { ...defaultItem('box', 'Camera', 0), l: 130, w: 80, h: 60, r: 8 }
  camera.notches.push(defaultNotch(camera))
  return {
    box: { topL: 300, topW: 200, bottomL: 300, bottomW: 200, depth: 80, radius: 10, bottomRadius: 5, clearance: 1 },
    materials,
    stack: suggestStack(materials, 80),
    stackAuto: true,
    items: [camera],
    labelColor: '#ff00ff',
  }
}

export function loadProject(): Project {
  const raw = localStorage.getItem(KEY)
  if (raw) {
    try {
      return JSON.parse(raw)
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
