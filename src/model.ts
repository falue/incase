export type Shape = 'box' | 'cylinder' | 'lying' | 'sphere' | 'polygon'
export type Dim = 'l' | 'w' | 'h' | 'd' | 'd2' | 'r'

export interface Material {
  id: string
  name: string
  thickness: number
  color: string
  /** Sizes of the stock sheets in mm and how many of each are in stock (missing = unlimited); none (or 0) = no size limit. */
  sheets?: { w: number; h: number; count?: number }[]
  /** Auto stack: where this material may go; missing = everywhere. */
  slots?: Slot[]
  /** Auto stack: the top or bottom layer is this material (or another one forced there). */
  forced?: Slot[]
}
export type Slot = 'top' | 'middle' | 'bottom'
export const SLOTS: Slot[] = ['top', 'middle', 'bottom']
export const allows = (m: Material, slot: Slot) => !m.slots || m.slots.includes(slot)
export const forces = (m: Material, slot: Slot) => !!m.forced?.includes(slot)

/** May `m` go into `slot`: only forced materials where any is forced, else the allowed ones. */
export const fits = (materials: Material[], m: Material, slot: Slot) =>
  materials.some(o => forces(o, slot)) ? forces(m, slot) : allows(m, slot)
/**
 * A layer placed by hand on stock sheet number `sheet` (w × h) of its material: its origin (the case centre)
 * in mm from the sheet corner, turned by `rot` degrees clockwise.
 */
export interface SheetPlacement { layer: number; material: string; sheet: number; w: number; h: number; x: number; y: number; rot: number }
/** Finger notch centred on the item's outline at fraction `t` of the way around (see perimeterPoint). */
export interface Notch {
  t: number
  /** Moved by hand; such notches are never re-spread. */
  manual?: boolean
}

/**
 * All dims are kept for every shape so switching shapes is lossless; z is measured from the foam top.
 * Cylinders and spheres are d × d2 (along the object's own X and Y axes); equal = round.
 */
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
  /** Items sharing a group id move, rotate and sink together. */
  group?: string
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
  /** Bottom L and W are edited independently; otherwise (also when missing) one keeps the other at the same taper. */
  taperFree?: boolean
}

/** Case values a preset can fill in. */
export type CaseKey = 'topL' | 'topW' | 'bottomL' | 'bottomW' | 'depth' | 'lidDepth' | 'radius' | 'bottomRadius'

export interface Project {
  box: CaseDims
  materials: Material[]
  /** Material ids, top → bottom. */
  stack: string[]
  stackAuto: boolean
  /** Auto stack: mm of sinking one more layer must save (see suggestStack); missing in older saves. */
  layerCost?: number
  items: Item[]
  /** Layer labels (and sheet titles) in the sheet view and the exports. */
  showLabels: boolean
  labelColor: string
  /** Object names on the top layer and where the objects rest. */
  showNames: boolean
  /** Where the layer above is cut, engraved on the layer an object rests on. */
  showFootprints: boolean
  /** Outlines of the objects themselves in the sheet view and the exports. */
  showOutlines: boolean
  /** Sheet frames in the exports. */
  showFrames: boolean
  outlineColor: string
  /** Width of the cut (laser, mill, knife) in mm; the export offsets cut lines by half of it. */
  kerf: number
  /** mm between pieces on a sheet and to its edge; missing = the min. wall. */
  spacing?: number
  /** Layers placed by hand on the stock sheets; missing in older saves. */
  placements?: SheetPlacement[]
  /** The bottom layer is never cut; objects stand on it. */
  solidBase?: boolean
}


const UNSAVED = 'incase.project' // the unnamed project (before named projects: everything)
const NAMED = 'incase.project:' // + name
const SHARED = 'incase.shared'
const CURRENT = 'incase.current'
/** Settings all projects share; the rest (case, objects, stack, sheet placements) belongs to each project. */
const SHARED_KEYS: string[] = ['materials', 'kerf', 'showLabels', 'labelColor', 'showNames', 'showFootprints', 'showOutlines', 'showFrames', 'outlineColor']
const part = (p: Project, shared: boolean): Partial<Project> => Object.fromEntries(Object.entries(p).filter(([k]) => SHARED_KEYS.includes(k) === shared))
export const sharedPart = (p: Project) => part(p, true)
const storageKey = (name: string) => (name ? NAMED + name : UNSAVED)

export const uid = () => crypto.randomUUID()

export const itemHeight = (it: Item) => (it.shape === 'lying' ? it.d : it.shape === 'sphere' ? Math.min(it.d, it.d2) : it.h)
export const itemBottom = (it: Item) => it.z + itemHeight(it)

/** The item's group (itself if ungrouped). */
export const groupOf = (p: Project, it: Item) => (it.group ? p.items.filter(o => o.group === it.group) : [it])

/** Items split into what moves together: each group, every ungrouped item alone; in order of appearance. */
export function units(items: Item[]): Item[][] {
  const byGroup = new Map<string, Item[]>()
  return items.flatMap(it => {
    if (!it.group) return [[it]]
    const unit = byGroup.get(it.group)
    if (unit) return (unit.push(it), [])
    byGroup.set(it.group, [it])
    return [byGroup.get(it.group)!]
  })
}

/** The member reaching deepest; a group sinks onto a layer boundary by it. */
export const deepest = (unit: Item[]) => unit.reduce((a, b) => (itemBottom(b) > itemBottom(a) ? b : a))

/** Depths the stack should put layer boundaries at: one per group or ungrouped item. */
export const stackBottoms = (p: Project) => units(p.items).map(u => itemBottom(deepest(u)))

/** Footprint bounding box in the item's local frame, before the fit is applied: centre (x, y) and size (l, w). */
export function itemBox(it: Item) {
  if (it.shape === 'box') return { x: 0, y: 0, l: it.l, w: it.w }
  if (it.shape === 'lying') return { x: 0, y: 0, l: it.l, w: it.d }
  if (it.shape === 'polygon') {
    const xs = it.pts.map(p => p.x), ys = it.pts.map(p => p.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, l: x1 - x0, w: y1 - y0 }
  }
  return { x: 0, y: 0, l: it.d, w: it.d2 }
}

/** Sets the footprint size (see itemBox); polygons are scaled about their box centre. */
export function setItemSize(it: Item, l: number, w: number) {
  if (it.shape === 'box') Object.assign(it, { l, w })
  else if (it.shape === 'lying') Object.assign(it, { l, d: w })
  else if (it.shape === 'polygon') {
    const b = itemBox(it), kx = b.l ? l / b.l : 1, ky = b.w ? w / b.w : 1
    it.pts = it.pts.map(p => ({ x: b.x + (p.x - b.x) * kx, y: b.y + (p.y - b.y) * ky }))
  } else Object.assign(it, { d: l, d2: w })
}

/** Polygon corners for an item switched to the polygon shape: its box outline. */
export const boxCorners = (it: Item) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ x: (sx * it.l) / 2, y: (sy * it.w) / 2 }))

/** `notchDepth` is usually the top layer's thickness. */
export function defaultItem(shape: Shape, name: string, offset: number, notchDepth: number): Item {
  return {
    id: uid(), name, shape, x: offset, y: offset, rot: 0, z: 0,
    l: 100, w: 60, h: 40, d: 60, d2: 60, r: 5, fit: 0, notches: [], pts: [], notchD: 25, notchDepth, notchR: 3,
  }
}

const PERIMETER_STEPS = 96 // candidate positions for new notches
const PARAM_SAMPLES = 720 // resolution when mapping a point onto the outline

/** Point at fraction t of the item's outline, starting at the bottom middle (local frame, y down). */
export function perimeterPoint(it: Item, t: number) {
  if (it.shape === 'cylinder' || it.shape === 'sphere') {
    const a = Math.PI / 2 + 2 * Math.PI * t
    return { x: (it.d / 2) * Math.cos(a), y: (it.d2 / 2) * Math.sin(a) }
  }
  const { l, w } = itemBox(it), hx = l / 2, hy = w / 2
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

/**
 * The standard notch position closest to t: eighths of the outline (where new notches go: bottom, top, sides,
 * halfway between), on round items with 3+ notches also their even spread.
 */
export function snapNotch(it: Item, t: number) {
  const n = it.notches.length, round = it.shape === 'sphere' || it.shape === 'cylinder'
  const stops = [...Array.from({ length: 8 }, (_, i) => i / 8), ...(round && n >= 3 ? Array.from({ length: n }, (_, i) => i / n) : [])]
  const gap = (s: number) => Math.min(Math.abs(s - t), 1 - Math.abs(s - t))
  return stops.reduce((best, s) => (gap(s) < gap(best) ? s : best))
}

/** True if cost `a` beats `b`, comparing entries in order. */
const cheaper = (a: number[], b: number[]) => {
  const k = a.findIndex((v, i) => v !== b[i])
  return k >= 0 && a[k] < b[k]
}

export const LAYER_COST = 10

/**
 * Stack for a case `depth` deep, never exceeding it and leaving no gap a sheet would still fit in. Ranked by: fewest
 * layers plus least sinking of the objects (their `bottoms`, from the foam top, should land on layer boundaries) plus
 * the gap under the case rim plus how far objects reaching below the stack stick out (they stand on the case floor),
 * where one more layer is worth it only if it saves more than `layerCost` mm of these in total, then materials earlier
 * in the list.
 * The top, middle and bottom layers use only materials allowed or forced there (see `fits`; ignored if that leaves no stack);
 * with `solidBase`, objects stand on the bottom layer instead of sinking into it.
 * Between the boundaries objects rest on, preferred materials go on top; restricted top and bottom layers stay put.
 */
export function suggestStack(materials: Material[], depth: number, bottoms: number[], layerCost = LAYER_COST, solidBase = false, slots = true): string[] {
  const th = materials.map(m => Math.round(m.thickness * 10))
  const target = Math.max(0, Math.round(depth * 10))
  const bs = bottoms.map(b => Math.round(b * 10)).filter(b => b > 0)
  const [tops, middle, bottomMats] = SLOTS.map(slot => [...th.keys()].filter(i => th[i] > 0 && (!slots || fits(materials, materials[i], slot))))
  const restricted = slots && materials.some(m => m.forced?.length || SLOTS.some(slot => !allows(m, slot)))
  // best[s]: cheapest stack above the bottom layer summing to s, its first layer a top material, the others middle ones;
  // cost = [layers × layerCost + sinking, preference], its last layer spans from..s
  const best: ({ cost: number[]; from: number; mat: number } | undefined)[] = [{ cost: [0, 0], from: 0, mat: -1 }]
  for (let s = 1; s <= target; s++) {
    for (const i of new Set([...tops, ...middle])) {
      const u = th[i]
      const prev = u <= s && (s === u ? tops : middle).includes(i) ? best[s - u] : undefined
      if (!prev) continue
      const sink = bs.reduce((sum, b) => (b > s - u && b <= s ? sum + s - b : sum), 0)
      const cost = [prev.cost[0] + layerCost * 10 + sink, prev.cost[1] + i]
      if (!best[s] || cheaper(cost, best[s]!.cost)) best[s] = { cost, from: s - u, mat: i }
    }
  }
  const thinnest = Math.min(...th.filter(u => u > 0))
  // the stack above s plus its bottom layer j (alone: also the top layer)
  let end = 0, base = -1, endCost = [Infinity]
  best.forEach((b, s) => {
    for (const j of bottomMats) {
      const total = s + th[j]
      if (!b || (s === 0 && !tops.includes(j)) || total > target || target - total >= thinnest) continue
      // objects below s sink into the bottom layer, or stand on it if it is solid
      const floor = solidBase ? s : total
      const below = bs.reduce((sum, x) => sum + (x > s && x <= floor ? floor - x : Math.max(0, x - floor)), 0)
      const cost = [b.cost[0] + layerCost * 10 + target - total + below, b.cost[1] + j, -total]
      if (cheaper(cost, endCost)) [end, base, endCost] = [s, j, cost]
    }
  })
  if (endCost[0] === Infinity) return slots ? suggestStack(materials, depth, bottoms, layerCost, solidBase, false) : []
  const layers: { a: number; i: number; keep: boolean }[] = []
  for (let s = end; s > 0; s = best[s]!.from) {
    const { from, mat } = best[s]!
    layers.unshift({ a: from, i: mat, keep: restricted && from === 0 })
  }
  layers.push({ a: end, i: base, keep: restricted || solidBase })
  const runs: number[][] = [[]]
  for (const { a, i, keep } of layers) {
    if (keep) runs.push([i], [])
    else {
      runs.at(-1)!.push(i)
      if (bs.some(b => b > a && b <= a + th[i])) runs.push([])
    }
  }
  return runs.flatMap(r => r.sort((x, y) => x - y)).map(i => materials[i].id)
}

/** True if every layer of the stack uses a material allowed there (see `fits`). */
export function slotsKept(p: Project) {
  const last = p.stack.length - 1
  return p.stack.every((id, i) => {
    const m = p.materials.find(m => m.id === id)
    const ok = (slot: Slot) => fits(p.materials, m!, slot)
    return !m || ((i > 0 || ok('top')) && (i < last || ok('bottom')) && (i === 0 || i === last || ok('middle')))
  })
}

/** The auto stack for `p`. */
export const autoStack = (p: Project) =>
  suggestStack(p.materials, p.box.depth, stackBottoms(p), p.layerCost, p.solidBase)

function defaultProject(): Project {
  const materials: Material[] = [
    { id: uid(), name: 'Foam 30', thickness: 30, color: '#000000' },
    { id: uid(), name: 'Foam 10', thickness: 10, color: '#ff0000' },
    { id: uid(), name: 'Foam 5', thickness: 5, color: '#0000ff' },
  ]
  // a camera body with its lens sticking out, notches on both sides, and a spare lens standing upright
  const items = [
    { ...defaultItem('box', 'Camera', 0, 0), x: 5, y: 30, l: 130, w: 80, h: 60, r: 8, notches: [{ t: 0.25 }, { t: 0.75 }] },
    { ...defaultItem('lying', 'Lens', 0, 0), x: 4, y: -33.2, rot: 90, z: 5.5, l: 65, d: 60 },
    { ...defaultItem('cylinder', 'Additional lens', 0, 0), x: -97.2, y: -35.9, h: 65, d: 60, d2: 60, fit: -1 },
  ]
  const stack = suggestStack(materials, 80, items.map(itemBottom))
  for (const it of items) it.notchDepth = materials.find(m => m.id === stack[0])!.thickness
  return {
    box: { topL: 300, topW: 200, bottomL: 300, bottomW: 200, depth: 80, radius: 10, bottomRadius: 5, minWall: 5, lidDepth: 20, unknown: [] },
    materials,
    stack,
    stackAuto: true,
    layerCost: LAYER_COST,
    items,
    showLabels: true,
    labelColor: '#ff00ff',
    showNames: true,
    showFootprints: true,
    showOutlines: true,
    showFrames: true,
    outlineColor: '#ffff00',
    kerf: 0,
  }
}

/** Fills in what older saves lack and drops stack layers whose material no longer exists. */
export function normalize(p: Project) {
  for (const it of p.items) it.d2 ??= it.d // saves from before oval cylinders and spheres
  // saves from before labels and outlines could be switched off: both on, outlines in the label colour
  p.showLabels ??= true
  p.showOutlines ??= true
  p.outlineColor ??= p.labelColor
  p.stack = p.stack.filter(id => p.materials.some(m => m.id === id))
  return p
}

export const parseProject = (json: string): Project => normalize(JSON.parse(json))

/** Empty project (no objects) with the case and the shared settings of `from`. */
export function newProject(from: Project): Project {
  const p = { ...defaultProject(), items: [], box: structuredClone(from.box), ...sharedPart(from) }
  return { ...p, stack: autoStack(p) }
}

/** Names of the saved projects, sorted. */
export const projectNames = () =>
  Object.keys(localStorage).filter(k => k.startsWith(NAMED)).map(k => k.slice(NAMED.length)).sort((a, b) => a.localeCompare(b))

/** Name of the open project; '' = the unsaved one. */
export const currentName = () => localStorage.getItem(CURRENT) ?? ''

/** `name`, with " 2", " 3" … appended while a project of that name exists. */
export function uniqueName(name: string) {
  const names = projectNames()
  let n = name
  for (let i = 2; names.includes(n); i++) n = `${name} ${i}`
  return n
}

const read = (key: string) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null // corrupt storage counts as missing
  }
}

/** Opens project `name` (missing parts from the defaults) with the shared settings and makes it the open one. */
export function loadProject(name = currentName()): Project {
  flushSave()
  localStorage.setItem(CURRENT, name)
  return storedProject(name)
}

/** A stored project with the shared settings, without opening it. */
export const storedProject = (name: string): Project => normalize({ ...defaultProject(), ...read(storageKey(name)), ...read(SHARED) })

let saveTimer = 0
let pending: (() => void) | null = null

/** Autosave of the open project and the shared settings, 300 ms after the last change. */
export function saveProject(p: Project, name = currentName()) {
  clearTimeout(saveTimer)
  pending = () => {
    localStorage.setItem(storageKey(name), JSON.stringify(part(p, false)))
    localStorage.setItem(SHARED, JSON.stringify(sharedPart(p)))
  }
  saveTimer = setTimeout(flushSave, 300)
}

export function flushSave() {
  clearTimeout(saveTimer)
  pending?.()
  pending = null
}

/** Stores `p` under the new name `name`; with `open`, it becomes the open project. */
export function nameProject(p: Project, name: string, open = true) {
  flushSave()
  if (open) localStorage.setItem(CURRENT, name)
  saveProject(p, name)
  flushSave()
}

/** True if the unsaved project has no objects. */
export const unsavedEmpty = () => !read(UNSAVED)?.items?.length

/** The case of a stored project (the defaults if missing). */
export const storedCase = (name: string): CaseDims => read(storageKey(name))?.box ?? defaultProject().box

/** Empties the unsaved project (after it got a name). */
export const resetUnsaved = (p: Project) => localStorage.setItem(UNSAVED, JSON.stringify(part(newProject(p), false)))

export function copyProject(from: string, to: string) {
  flushSave()
  localStorage.setItem(storageKey(to), localStorage.getItem(storageKey(from))!)
}

export function renameProject(from: string, to: string) {
  copyProject(from, to)
  localStorage.removeItem(storageKey(from))
  if (currentName() === from) localStorage.setItem(CURRENT, to)
}

export function deleteProject(name: string) {
  flushSave()
  localStorage.removeItem(storageKey(name))
}
