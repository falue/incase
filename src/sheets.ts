import { areaD, areaPathsD, FillRule, getBoundsPathsD, intersectD, simplifyPathsD, type PathsD } from 'clipper2-ts'
import { freePositions } from './arrange'
import { AREA_TOL, numberStrokes, offset, roundedRect, type Layer } from './geometry'
import type { Material, Project, SheetPlacement } from './model'

export const FONT = 5 // mm, sheet titles and piece labels
const LABEL_SIZES = [FONT, 3] // mm; the smaller one is tried where the larger does not fit
const LABEL_MARGIN = 1 // mm of foam around a label at least (else the min. wall)
const SIMPLIFY = 0.3 // mm; keeps the label search fast, covered by LABEL_MARGIN
const MARGIN = 5 // mm around the drawing
const GAP = 10 // mm between sheets
const EPS = 1e-6

export type Bounds = { left: number; top: number; right: number; bottom: number }
type Size = { w: number; h: number; count?: number }

/**
 * A layer on a sheet: where its origin (the case centre) sits, in mm from the sheet corner, turned by `rot`
 * degrees clockwise. `box` is its bounding box around that origin, kerf included.
 */
export interface Piece {
  layer: Layer
  x: number
  y: number
  rot: number
  box: Bounds
  manual: boolean
  /** Closer than the spacing to another piece (only hand-placed ones can be). */
  conflict: boolean
}

export interface Sheet {
  material: Material
  /** Number among the material's sheets, which hand placements refer to; -1 for oversize sheets and materials without a sheet size. */
  index: number
  /** Top-left corner in the drawing. */
  x: number
  y: number
  w: number
  h: number
  /** No sheet size set: one strip as long as needed. */
  unlimited: boolean
  /** Holds one layer larger than the sheet size, grown to fit it. */
  oversize: boolean
  /** One more of its size than in stock. */
  missing: boolean
  /** Empty extra sheet (sheet view only), to drag pieces onto. */
  spare: boolean
  pieces: Piece[]
}

/** Paths turned by `rot` degrees clockwise (y points down) about the origin, then moved by (dx, dy). */
export function turn(paths: PathsD, rot: number, dx = 0, dy = 0): PathsD {
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return paths.map(path => path.map(q => ({ x: dx + q.x * c - q.y * s, y: dy + q.x * s + q.y * c })))
}

/** Bounding box of a layer's piece turned by `rot`, around its origin, kerf included. */
export function turnedBox(p: Project, l: Layer, rot: number): Bounds {
  const b = getBoundsPathsD(turn(l.paths, rot)), k = p.kerf / 2
  return { left: b.left - k, top: b.top - k, right: b.right + k, bottom: b.bottom + k }
}

const width = (b: Bounds) => b.right - b.left
const height = (b: Bounds) => b.bottom - b.top

/** The outer outlines of a layer (not its holes), and its holes turned the same way so unions keep them. */
function split(l: Layer) {
  const area = l.paths.map(path => areaD(path))
  const sign = Math.sign(area.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0))
  return {
    outer: l.paths.filter((_, i) => Math.sign(area[i]) === sign),
    holes: l.paths.filter((_, i) => Math.sign(area[i]) !== sign).map(path => [...path].reverse()),
  }
}

type Rect = { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
const contains = (a: Rect, b: Rect) => b.x >= a.x - EPS && b.y >= a.y - EPS && b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS

/** Free space of a sheet as maximal rectangles (MaxRects); a piece takes its bounding box plus `gap` to the right and below. */
class Free {
  private rects: Rect[]

  constructor(w: number, h: number, private gap: number) {
    this.rects = [{ x: gap, y: gap, w: w - gap, h: h - gap }]
  }

  /** Top-most, then left-most corner for a w × h box, or null. */
  find(w: number, h: number) {
    let best: Rect | null = null
    for (const r of this.rects) {
      if (w + this.gap > r.w + EPS || h + this.gap > r.h + EPS) continue
      if (!best || r.y < best.y - EPS || (r.y < best.y + EPS && r.x < best.x)) best = r
    }
    return best && { x: best.x, y: best.y }
  }

  take(pc: Piece) {
    const t = { x: pc.x + pc.box.left, y: pc.y + pc.box.top, w: width(pc.box) + this.gap, h: height(pc.box) + this.gap }
    const next = this.rects.flatMap(r => {
      if (!overlaps(r, t)) return [r]
      const parts: Rect[] = []
      if (t.x > r.x) parts.push({ ...r, w: t.x - r.x })
      if (t.x + t.w < r.x + r.w) parts.push({ ...r, x: t.x + t.w, w: r.x + r.w - t.x - t.w })
      if (t.y > r.y) parts.push({ ...r, h: t.y - r.y })
      if (t.y + t.h < r.y + r.h) parts.push({ ...r, y: t.y + t.h, h: r.y + r.h - t.y - t.h })
      return parts
    })
    // drop rectangles inside others (of two equal ones, the later)
    this.rects = next.filter((r, i) => !next.some((o, j) => j !== i && contains(o, r) && (j < i || !contains(r, o))))
  }
}

/** True if two pieces on one sheet come closer than `gap`; checked on their outlines where their boxes allow it. */
function tooClose(p: Project, a: Piece, b: Piece, gap: number) {
  const rect = (pc: Piece) => ({ x: pc.x + pc.box.left, y: pc.y + pc.box.top, w: width(pc.box) + gap, h: height(pc.box) + gap })
  if (!overlaps(rect(a), rect(b))) return false
  const shape = (pc: Piece) => turn(p.kerf > 0 ? offset(split(pc.layer).outer, p.kerf / 2) : split(pc.layer).outer, pc.rot, pc.x, pc.y)
  return Math.abs(areaPathsD(intersectD(offset(shape(a), gap - 0.01), shape(b), FillRule.NonZero))) > AREA_TOL
}

/**
 * Lays the layers out on stock sheets: per material (in list order) its own row of sheets, filled with its layers
 * top to bottom. Each goes onto the first sheet with room, top-most, then left-most, turned by 90° if that comes
 * first; if none has room, a new sheet of the smallest size it fits on and still in stock is started (if none is
 * left, of the smallest it fits on, marked missing). Hand placements that still fit their sheet stay. Pieces keep the
 * spacing to each other and to the sheet edge. `spare` adds an empty sheet of every size still in stock; `head` is
 * the room above each sheet for its title.
 */
/** mm between pieces on a sheet and to its edge. */
export const spacing = (p: Project) => Math.max(p.spacing ?? p.box.minWall, 0)

export function planSheets(p: Project, layers: Layer[], { spare = false, head = FONT + 3 } = {}) {
  const gap = spacing(p)
  const sheets: Sheet[] = []
  let top = MARGIN, drawingW = 0
  for (const material of p.materials) {
    const mine = layers.filter(l => l.material.id === material.id && l.paths.length)
    if (!mine.length) continue
    // smallest first; none = no limit: one strip as long as needed
    const sizes = (material.sheets ?? []).filter(s => s.w > 0 && s.h > 0).sort((a, b) => a.w * a.h - b.w * b.h)
    const unlimited = !sizes.length
    const make = (w: number, h: number, more: Partial<Sheet> = {}): Sheet =>
      ({ material, index: -1, x: 0, y: 0, w, h, unlimited, oversize: false, missing: false, spare: false, pieces: [], ...more })
    const regular: Sheet[] = [], free: Free[] = [], oversize: Sheet[] = []
    const used = new Map<Size, number>()
    const inStock = (s: Size) => !s.count || (used.get(s) ?? 0) < s.count
    const open = ({ w, h }: Size) => {
      const size = sizes.find(s => s.w === w && s.h === h)
      regular.push(make(w, h, { index: unlimited ? -1 : regular.length, missing: !!size && !inStock(size) }))
      if (size) used.set(size, (used.get(size) ?? 0) + 1)
      free.push(new Free(w, h, gap))
      return regular.length - 1
    }
    const put = (i: number, piece: Piece) => {
      regular[i].pieces.push(piece)
      free[i].take(piece)
    }
    const fits = (box: Bounds, w: number, h: number) => width(box) + 2 * gap <= w + EPS && height(box) + 2 * gap <= h + EPS

    const auto: Layer[] = [], manual: { layer: Layer; at: SheetPlacement; box: Bounds }[] = []
    for (const layer of mine) {
      const at = unlimited ? undefined : p.placements?.find(s => s.layer === layer.index && s.material === material.id)
      const box = at && turnedBox(p, layer, at.rot)
      const sized = at && sizes.some(s => Math.abs(s.w - at.w) < EPS && Math.abs(s.h - at.h) < EPS)
      if (at && box && sized && at.x + box.left >= gap - EPS && at.y + box.top >= gap - EPS && at.x + box.right <= at.w - gap + EPS && at.y + box.bottom <= at.h - gap + EPS) {
        manual.push({ layer, at, box })
      } else auto.push(layer)
    }
    // sheets of hand placements first, in the order of their numbers
    const opened = new Map<string, number>()
    for (const { layer, at, box } of manual.sort((a, b) => a.at.sheet - b.at.sheet)) {
      const key = `${at.sheet} ${at.w} ${at.h}`
      if (!opened.has(key)) opened.set(key, open(at))
      put(opened.get(key)!, { layer, x: at.x, y: at.y, rot: at.rot, box, manual: true, conflict: false })
    }
    for (const layer of auto) {
      const turns = (unlimited ? [0] : [0, 90]).map(rot => ({ rot, box: turnedBox(p, layer, rot) }))
      /** Best spot on sheet i: top-most, then left-most over all turns. */
      const spot = (i: number) => turns
        .flatMap(t => {
          const at = free[i].find(width(t.box), height(t.box))
          return at ? [{ ...t, ...at }] : []
        })
        .reduce<{ rot: number; box: Bounds; x: number; y: number } | null>((a, b) => (!a || b.y < a.y - EPS || (b.y < a.y + EPS && b.x < a.x - EPS) ? b : a), null)
      let i = 0, at = null
      while (i < free.length && !(at = spot(i))) i++
      if (!at) {
        const fitting = sizes.filter(s => turns.some(t => fits(t.box, s.w, s.h)))
        const size = unlimited ? { w: Infinity, h: Infinity } : fitting.find(inStock) ?? fitting[0]
        if (!size) {
          // larger than every size: a sheet of the largest size, grown to fit
          const box = turnedBox(p, layer, 0), big = sizes.at(-1)!
          const piece: Piece = { layer, x: gap - box.left, y: gap - box.top, rot: 0, box, manual: false, conflict: false }
          oversize.push(make(Math.max(big.w, width(box) + 2 * gap), Math.max(big.h, height(box) + 2 * gap), { oversize: true, pieces: [piece] }))
          continue
        }
        at = spot((i = open(size)))!
      }
      put(i, { layer, x: at.x - at.box.left, y: at.y - at.box.top, rot: at.rot, box: at.box, manual: false, conflict: false })
    }
    if (unlimited) {
      const s = regular[0]
      s.w = Math.max(...s.pieces.map(pc => pc.x + pc.box.right)) + gap
      s.h = Math.max(...s.pieces.map(pc => pc.y + pc.box.bottom)) + gap
    } else if (spare) for (const s of sizes.filter(inStock)) regular.push(make(s.w, s.h, { index: regular.length, spare: true }))

    // one row per material
    let x = MARGIN, rowH = 0
    for (const s of [...regular, ...oversize]) {
      // automatic pieces keep clear of all others
      for (const a of s.pieces) if (a.manual) a.conflict = s.pieces.some(b => b !== a && tooClose(p, a, b, gap))
      Object.assign(s, { x, y: top + head })
      x += s.w + GAP
      rowH = Math.max(rowH, s.h)
      sheets.push(s)
    }
    drawingW = Math.max(drawingW, x - GAP + MARGIN)
    top += head + rowH + GAP
  }
  return { sheets, width: drawingW, height: top - GAP + MARGIN }
}

/** "Foam 10 · 10 mm · 1000 × 600 · sheet 2/3". */
export function sheetTitle(sheets: Sheet[], s: Sheet) {
  const { name, thickness } = s.material
  const size = `${Math.round(s.w * 10) / 10} × ${Math.round(s.h * 10) / 10}`
  if (s.unlimited) return `${name} · ${thickness} mm · no sheet size set - ${size} mm`
  const all = sheets.filter(o => o.material === s.material && !o.spare)
  return `${name} · ${thickness} mm · ${size} · sheet ${all.indexOf(s) + 1}/${all.length}${s.oversize ? ' · larger than every sheet size' : s.missing ? ' · not in stock' : ''}`
}

// layers are rebuilt on every change, so a label is placed once per layer
const labels = new WeakMap<Layer, PathsD>()

/**
 * The layer's label (its number, as open strokes) inside its foam (layer frame), at least `minWall` from every cut line,
 * nearest its bottom-left corner; empty if it fits nowhere.
 */
function layerLabel(l: Layer, minWall: number) {
  if (labels.has(l)) return labels.get(l)!
  const { outer, holes } = split(l)
  const bin = simplifyPathsD(outer, SIMPLIFY), obstacles = simplifyPathsD(holes, SIMPLIFY)
  const b = getBoundsPathsD(l.paths)
  const m = Math.max(minWall, LABEL_MARGIN)
  let label: PathsD = []
  for (const size of LABEL_SIZES) {
    const digits = numberStrokes(l.index + 1, size), g = getBoundsPathsD(digits)
    const w = g.right - g.left + 2 * m, h = g.bottom - g.top + 2 * m
    const box = roundedRect(w, h, 0)!.map(q => ({ x: q.x + (g.left + g.right) / 2, y: q.y + (g.top + g.bottom) / 2 }))
    const free = freePositions([box], bin, obstacles).flat()
    if (free.length) {
      const at = free.reduce((a, q) => (Math.hypot(q.x - b.left, q.y - b.bottom) < Math.hypot(a.x - b.left, a.y - b.bottom) ? q : a))
      label = turn(digits, 0, at.x, at.y)
      break
    }
  }
  labels.set(l, label)
  return label
}

/** Cut lines (kerf applied), object outlines, label, object names (turned by `rot`) and footprints of a piece, in drawing mm. */
export function pieceShapes(p: Project, s: Sheet, pc: Piece) {
  const ox = s.x + pc.x, oy = s.y + pc.y
  return {
    cut: turn(p.kerf > 0 ? offset(pc.layer.paths, p.kerf / 2) : pc.layer.paths, pc.rot, ox, oy),
    outlines: turn(pc.layer.outlines, pc.rot, ox, oy),
    label: turn(layerLabel(pc.layer, p.box.minWall), pc.rot, ox, oy),
    footprints: turn(pc.layer.footprints, pc.rot, ox, oy),
    names: pc.layer.names.map(n => ({ ...turn([[n]], pc.rot, ox, oy)[0][0], rot: pc.rot, text: n.text })),
  }
}
