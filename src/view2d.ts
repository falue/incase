import { FillRule, pointInPolygonD, PointInPolygonResult, unionD, type PathsD } from 'clipper2-ts'
import { AREA_TOL, caseOutline, itemCuts, objectOutline, offset, pathData, place, resting, type Layer } from './geometry'
import { itemSize, perimeterParam, perimeterPoint, type Item, type Project } from './model'

const NS = 'http://www.w3.org/2000/svg'
const MARGIN = 30
const HANDLE = 12 // distance of the rotation handle beyond the item edge
const ZOOM = { min: 0.2, max: 50, speed: 0.0015 }

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
/** Invisible wide stroke over a line that shows `tip` on hover. */
const hit = (d: string, tip: string) => `<path class="hit" data-tip="${esc(tip)}" d="${d}"/>`
const round = (v: number, step: number) => Math.round(v / step) * step

const MIN_CONTRAST = 80 // largest channel difference (0–255) below which a line colour vanishes on the canvas

export interface View2DHost {
  select(id: string | null): void
  /** Called after an item was moved or rotated. */
  change(): void
  /** Formats a length in mm for the tooltips. */
  len(mm: number): string
  /** How badly the item's current placement breaks the min. wall (0 = clear). */
  violation(it: Item): number
  /** A polygon was drawn (corner points in plan coordinates). */
  createPolygon(points: Point[]): void
}

type Point = { x: number; y: number }
const CLOSE = 8 // px; clicking this close to the first point closes a drawn polygon
const EDGE_HIT = 6 // px; double-clicking this close to a polygon edge inserts a point

type Drag =
  | { mode: 'move'; item: Item; dx: number; dy: number }
  | { mode: 'rotate'; item: Item }
  | { mode: 'notch'; item: Item; index: number }
  | { mode: 'vertex'; item: Item; index: number }
  | { mode: 'pan'; x: number; y: number; cx: number; cy: number; scale: number }

/**
 * Top view: drag items to move, drag the handle to rotate (Shift snaps to 15°); lines carry hover help (data-tip).
 * Wheel zooms at the pointer, dragging the background (or with the middle button) pans, double-click resets the view.
 * Polygons: drawn point by point (startDrawing), corners of the selected one can be dragged, inserted
 * (double-click near an edge) and deleted (deleteVertex).
 */
export class View2D {
  /** Snap positions to `snapStep` (mm) and rotation to 15°. */
  snap = false
  snapStep = 5
  /** Refuse moves that make an item's min. wall violation worse (so items in conflict can still be pulled out). */
  constrain = false
  private svg = document.createElementNS(NS, 'svg')
  private items: Item[] = []
  private footprints: PathsD[] = []
  private pick: { x: number; y: number } | null = null // last click on an item, for Tab cycling
  private selected: Item | null = null
  private drag: Drag | null = null
  private zoom = 1
  private center = { x: 0, y: 0 }
  private last: Parameters<View2D['render']> | null = null
  private drawing: Point[] | null = null
  private vertex: number | null = null // corner of the selected polygon that was clicked last

  constructor(host: HTMLElement, private ctl: View2DHost) {
    host.append(this.svg)
    this.svg.addEventListener('pointerdown', e => this.down(e))
    this.svg.addEventListener('pointermove', e => this.move(e))
    this.svg.addEventListener('pointerup', () => (this.drag = null))
    this.svg.addEventListener('pointercancel', () => (this.drag = null))
    this.svg.addEventListener('wheel', e => this.zoomAt(e), { passive: false })
    this.svg.addEventListener('dblclick', e => {
      if (this.drawing) return this.finishDrawing()
      if (this.insertVertex(e)) return
      if ((e.target as Element).closest('[data-id], [data-role]')) return
      this.zoom = 1
      this.center = { x: 0, y: 0 }
      this.rerender()
    })
  }

  get isDrawing() {
    return this.drawing !== null
  }

  startDrawing() {
    this.drawing = []
    this.svg.classList.add('drawing')
    this.rerender()
  }

  /** Closes the drawn polygon (3+ points) and hands it over; fewer points just cancel. */
  finishDrawing() {
    const pts = this.drawing?.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 0.5) ?? []
    this.cancelDrawing()
    if (pts.length >= 3) this.ctl.createPolygon(pts)
  }

  cancelDrawing() {
    this.drawing = null
    this.svg.classList.remove('drawing')
    this.rerender()
  }

  /** Removes the last drawn point. */
  undoPoint() {
    this.drawing?.pop()
    this.rerender()
  }

  /** Deletes the last clicked corner of the selected polygon (keeps at least 3); false if there is none. */
  deleteVertex() {
    const it = this.selected
    if (it?.shape !== 'polygon' || this.vertex === null || it.pts.length <= 3) return false
    it.pts.splice(this.vertex, 1)
    this.vertex = null
    this.ctl.change()
    return true
  }

  /** Double-click near an edge of the selected polygon inserts a corner there. */
  private insertVertex(e: MouseEvent) {
    const it = this.selected
    if (it?.shape !== 'polygon') return false
    const q = this.toLocal(it, this.point(e)), n = it.pts.length
    let best = { d: Infinity, i: 0, at: q }
    it.pts.forEach((a, i) => {
      const b = it.pts[(i + 1) % n], vx = b.x - a.x, vy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / (vx * vx + vy * vy || 1)))
      const at = { x: a.x + t * vx, y: a.y + t * vy }, d = Math.hypot(q.x - at.x, q.y - at.y)
      if (d < best.d) best = { d, i, at }
    })
    if (best.d > EDGE_HIT * this.unitsPerPixel()) return false
    it.pts.splice(best.i + 1, 0, best.at)
    this.vertex = best.i + 1
    this.ctl.change()
    return true
  }

  private unitsPerPixel() {
    return 1 / this.svg.getScreenCTM()!.a
  }

  /** Plan point in the item's local frame (undoes its rotation and position). */
  private toLocal(it: Item, p: Point): Point {
    const a = (it.rot * Math.PI) / 180, dx = p.x - it.x, dy = p.y - it.y
    return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) }
  }

  private snapped(p: Point): Point {
    const step = this.snap ? this.snapStep : 0.1
    return { x: round(p.x, step), y: round(p.y, step) }
  }

  /** Shows the cut lines of `layers[index]`, its neighbours faint. */
  render(p: Project, selectedId: string | null, layers: Layer[], index: number, conflicts: Set<string>) {
    this.last = [p, selectedId, layers, index, conflicts]
    const layer = layers[index]
    const b = p.box
    const w = (Math.max(b.topL, b.bottomL) + 2 * MARGIN) / this.zoom
    const h = (Math.max(b.topW, b.bottomW) + 2 * MARGIN) / this.zoom
    this.svg.setAttribute('viewBox', `${this.center.x - w / 2} ${this.center.y - h / 2} ${w} ${h}`)
    // only objects that cut into the shown layer
    const items = (this.items = layer ? p.items.filter(it => itemCuts(it, layer.a, resting(p, it).z).length) : p.items)
    this.selected = items.find(it => it.id === selectedId) ?? null

    const outline = (z: number) => pathData([caseOutline(b, z, z) ?? []])
    const grid = this.snap ? this.snapStep : 10 // drawn grid: the snap grid while snapping
    const parts = [
      `<defs><pattern id="grid" width="${grid}" height="${grid}" patternUnits="userSpaceOnUse"><path d="M${grid} 0H0V${grid}" class="gridline"/></pattern></defs>`,
      `<rect x="-10000" y="-10000" width="20000" height="20000" fill="url(#grid)"/>`,
      `<path class="case-bottom" d="${outline(b.depth)}"/>`,
      hit(outline(b.depth), 'Case floor: inner outline at the bottom (taper and bottom edge radius)'),
      `<path class="case" d="${outline(0)}"/>`,
      hit(outline(0), 'Case rim: inner outline at the top'),
    ]
    // lines and their hover areas go below the items so they never block dragging
    const top = caseOutline(b, 0, 0)
    if (b.minWall > 0 && top) {
      const d = pathData(offset([top], -b.minWall))
      parts.push(`<path class="zone" d="${d}"/>`, hit(d, `Min. wall to the case (${this.ctl.len(b.minWall)}): cuts must stay inside this line`))
    }
    const footprints = (this.footprints = items.map(it => unionD(itemCuts(it, -Infinity), FillRule.NonZero)))
    if (b.minWall > 0) {
      items.forEach((it, i) => {
        const conflict = conflicts.has(it.id)
        const d = pathData(offset(footprints[i], b.minWall))
        parts.push(`<path class="zone${conflict ? ' conflict' : ''}" d="${d}"/>`,
          hit(d, `Min. wall around ${it.name} (${this.ctl.len(b.minWall)}): other cuts and the case must stay outside${conflict ? ' · VIOLATED' : ''}`))
      })
    }
    // neighbouring layers, faint; hovering an object's cut there names it
    for (const [l, where] of [[layers[index - 1], 'above'], [layers[index + 1], 'below']] as const) {
      if (!l) continue
      parts.push(`<path class="layer faint" stroke="${this.visible(l.material.color)}" d="${pathData(l.paths)}"/>`)
      for (const it of p.items) {
        const cut = itemCuts(it, l.a, resting(p, it).z)
        if (cut.length) parts.push(hit(pathData(unionD(cut, FillRule.NonZero)), `Layer ${where}: ${it.name}`))
      }
    }
    const layerPaths = layer ? pathData(layer.paths) : ''
    if (layer) parts.push(hit(layerPaths, `Layer ${layer.index + 1} cut lines · ${layer.material.name}`))
    // the object's own outline; its hover area sits below the items
    const outlines = items.map(it => pathData(objectOutline(it, -Infinity)))
    items.forEach((it, i) => parts.push(hit(outlines[i], `${it.name}: the object itself, without the fit (exported in the label colour)`)))
    items.forEach((it, i) => {
      const tip = `${it.name}: cut outline incl. fit and notches · drag to move`
      parts.push(`<path data-id="${it.id}" data-tip="${esc(tip)}" class="item${it === this.selected ? ' selected' : ''}" d="${pathData(footprints[i])}"/>`)
    })
    // outlines under the cut lines, so with fit 0 the cut line stays visible
    for (const d of outlines) parts.push(`<path class="object-outline" stroke="${p.labelColor}" d="${d}"/>`)
    if (layer) parts.push(`<path class="layer" stroke="${this.visible(layer.material.color)}" d="${layerPaths}"/>`)
    for (const it of items) parts.push(`<text class="name" x="${it.x}" y="${it.y}">${esc(it.name)}</text>`)
    if (this.selected) {
      const it = this.selected
      const h = this.handle(it)
      parts.push(`<line class="handle-line" x1="${it.x}" y1="${it.y}" x2="${h.x}" y2="${h.y}"/>`,
        `<circle data-role="rotate" data-tip="Drag to rotate · Shift snaps to 15°" class="handle" cx="${h.x}" cy="${h.y}" r="4"/>`)
      it.notches.forEach((n, i) => {
        const c = place([perimeterPoint(it, n.t)], it)[0]
        parts.push(`<circle data-role="notch" data-index="${i}" data-tip="Finger notch · drag along the edge" class="handle notch" cx="${c.x}" cy="${c.y}" r="3"/>`)
      })
      if (it.shape === 'polygon') {
        place(it.pts, it).forEach((c, i) => parts.push(
          `<rect data-role="vertex" data-index="${i}" data-tip="Corner · drag to move · Del removes it · double-click an edge to add one" class="handle vertex${i === this.vertex ? ' active' : ''}" x="${c.x - 2.5}" y="${c.y - 2.5}" width="5" height="5"/>`,
        ))
      }
    }
    if (this.drawing?.length) {
      const [first, ...rest] = this.drawing
      parts.push(`<path id="draft" class="draft" d="M${first.x} ${first.y}${rest.map(p => `L${p.x} ${p.y}`).join('')}"/>`,
        `<circle class="handle" cx="${first.x}" cy="${first.y}" r="3" data-tip="Click to close the polygon"/>`)
    }
    this.svg.innerHTML = parts.join('')
  }

  /** Small SVG of one layer piece for the layer strip, framed like the unzoomed top view. */
  thumbnail(p: Project, layer: Layer, margin = 5) {
    const w = Math.max(p.box.topL, p.box.bottomL) + 2 * margin
    const h = Math.max(p.box.topW, p.box.bottomW) + 2 * margin
    const color = this.visible(layer.material.color)
    return `<svg viewBox="${-w / 2} ${-h / 2} ${w} ${h}" style="aspect-ratio:${w}/${h}"><path class="piece" fill-rule="evenodd" fill="${color}" stroke="${color}" d="${pathData(layer.paths)}"/></svg>`
  }

  /** The colour itself, or the text colour if it would vanish on the canvas (e.g. black lines in dark mode). */
  private visible(hex: string) {
    const canvas = getComputedStyle(this.svg).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)
    const line = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    return Math.max(...line.map((c, i) => Math.abs(c - canvas[i]))) < MIN_CONTRAST ? 'var(--ink)' : hex
  }

  private rerender() {
    if (this.last) this.render(...this.last)
  }

  private handle(it: Item) {
    return place([{ x: 0, y: -(itemSize(it)[1] / 2 + it.fit + HANDLE) }], it)[0]
  }

  private point(e: MouseEvent) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(this.svg.getScreenCTM()!.inverse())
  }

  private zoomAt(e: WheelEvent) {
    e.preventDefault()
    const p = this.point(e)
    const zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, this.zoom * Math.exp(-e.deltaY * ZOOM.speed)))
    const k = this.zoom / zoom // keeps the point under the cursor in place
    this.center = { x: p.x + (this.center.x - p.x) * k, y: p.y + (this.center.y - p.y) * k }
    this.zoom = zoom
    this.rerender()
  }

  private down(e: PointerEvent) {
    const target = e.target as Element
    if (this.drawing && e.button === 0) {
      const p = this.snapped(this.point(e)), first = this.drawing[0]
      const closing = this.drawing.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < CLOSE * this.unitsPerPixel()
      if (closing) return this.finishDrawing()
      this.drawing.push(p)
      return this.rerender()
    }
    const id = target.closest('[data-id]')?.getAttribute('data-id') ?? null
    const role = target.getAttribute('data-role')
    if (e.button === 1 || (!id && !role)) {
      e.preventDefault()
      if (e.button !== 1) this.ctl.select(null)
      this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, cx: this.center.x, cy: this.center.y, scale: 1 / this.svg.getScreenCTM()!.a }
    } else if (role === 'rotate' && this.selected) {
      this.drag = { mode: 'rotate', item: this.selected }
    } else if (role === 'notch' && this.selected) {
      this.drag = { mode: 'notch', item: this.selected, index: Number(target.getAttribute('data-index')) }
    } else if (role === 'vertex' && this.selected) {
      this.vertex = Number(target.getAttribute('data-index'))
      this.drag = { mode: 'vertex', item: this.selected, index: this.vertex }
      this.rerender()
    } else {
      const item = this.items.find(it => it.id === id)!
      const p = this.point(e)
      this.pick = { x: p.x, y: p.y }
      this.drag = { mode: 'move', item, dx: item.x - p.x, dy: item.y - p.y }
      this.ctl.select(id)
    }
    this.svg.setPointerCapture(e.pointerId)
  }

  /**
   * Selects the next item (step 1) or previous one (step -1) among those under the last click, topmost first
   * (later items are drawn on top), wrapping around.
   */
  cycle(step: number) {
    const p = this.pick
    if (!p) return
    const hits = this.items
      .filter((_, i) => this.footprints[i].some(path => pointInPolygonD(p, path) !== PointInPolygonResult.IsOutside))
      .reverse()
    if (!hits.length) return
    const at = hits.indexOf(this.selected!)
    this.ctl.select(hits[(at + step + hits.length) % hits.length].id)
  }

  private move(e: PointerEvent) {
    if (this.drawing?.length) {
      // preview of the next edge, without re-rendering the whole view
      const p = this.snapped(this.point(e))
      this.svg.querySelector('#draft')?.setAttribute('d', this.drawing.map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join('') + `L${p.x} ${p.y}`)
      return
    }
    const d = this.drag
    if (!d) return
    if (d.mode === 'pan') {
      this.center = { x: d.cx - (e.clientX - d.x) * d.scale, y: d.cy - (e.clientY - d.y) * d.scale }
      return this.rerender()
    }
    const p = this.point(e), it = d.item
    if (d.mode === 'notch') {
      // pointer in the item's local frame, projected onto its outline
      const q = this.toLocal(it, p)
      Object.assign(it.notches[d.index], { t: perimeterParam(it, q.x, q.y), manual: true })
      return this.ctl.change()
    }
    if (d.mode === 'vertex') {
      it.pts[d.index] = this.toLocal(it, this.snapped(p))
      return this.ctl.change()
    }
    const before = this.constrain ? this.ctl.violation(it) : 0
    // applies a placement and keeps it unless it makes the violation worse
    const attempt = (apply: () => void) => {
      const prev = { x: it.x, y: it.y, rot: it.rot }
      apply()
      if (!this.constrain || this.ctl.violation(it) <= before + AREA_TOL) return true
      Object.assign(it, prev)
      return false
    }
    if (d.mode === 'move') {
      const step = this.snap ? this.snapStep : 0.1
      const x = round(p.x + d.dx, step), y = round(p.y + d.dy, step)
      // when blocked, slide along the obstacle on one axis
      attempt(() => Object.assign(it, { x, y })) || attempt(() => (it.x = x)) || attempt(() => (it.y = y))
    } else {
      const a = (Math.atan2(p.y - it.y, p.x - it.x) * 180) / Math.PI + 90
      const snapped = this.snap || e.shiftKey ? round(a, 15) : round(a, 0.1)
      attempt(() => (it.rot = ((snapped + 540) % 360) - 180))
    }
    this.ctl.change()
  }
}
