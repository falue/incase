import { FillRule, pointInPolygonD, PointInPolygonResult, unionD, type PathsD } from 'clipper2-ts'
import { AREA_TOL, caseOutline, itemCuts, objectOutline, offset, pathData, place, resting, type Layer } from './geometry'
import { itemBox, perimeterParam, perimeterPoint, setItemSize, type Item, type Project } from './model'

const NS = 'http://www.w3.org/2000/svg'
const MARGIN = 30
const HANDLE = 12 // distance of the rotation handle beyond the item edge
const ZOOM = { min: 0.2, max: 50, speed: 0.0015 }
const LABEL = { gap: 12, ms: 500 } // size labels: px beyond the edge; how long they stay after a resize
const CURSORS = ['ew', 'nwse', 'ns', 'nesw'] // resize cursors by handle direction, in 45° steps

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
/** Invisible wide stroke over a line that shows `tip` on hover. */
const hit = (d: string, tip: string) => `<path class="hit" data-tip="${esc(tip)}" d="${d}"/>`
const round = (v: number, step: number) => Math.round(v / step) * step

const MIN_CONTRAST = 80 // largest channel difference (0–255) below which a line colour vanishes on the canvas

/** The colour itself, or the text colour if it would vanish on the canvas `el` (e.g. black lines in dark mode). */
export function visibleOn(el: Element, hex: string) {
  const canvas = getComputedStyle(el).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)
  const line = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return Math.max(...line.map((c, i) => Math.abs(c - canvas[i]))) < MIN_CONTRAST ? 'var(--ink)' : hex
}

export interface View2DHost {
  select(id: string | null): void
  /** Called after an item was moved or rotated. */
  change(): void
  /** Formats a length in mm for the tooltips. */
  len(mm: number): string
  /** Display unit: its name and mm per unit. */
  unit(): { name: string; mm: number }
  /** How badly the item's current placement breaks the min. wall (0 = clear). */
  violation(it: Item): number
  /** A polygon was drawn (corner points in plan coordinates). */
  createPolygon(points: Point[]): void
}

type Point = { x: number; y: number }
type Axis = 'x' | 'y'

/**
 * Resize of the selected item by handle (sx, sy) = direction of the dragged edge or corner (0 = that axis is not
 * dragged), plus sizes typed per axis (in the display unit). Pointer `q0` → `q` in the frame of `start`.
 */
interface Sizing {
  item: Item
  start: Item
  sx: number
  sy: number
  q0: Point
  q: Point
  alt: boolean
  shift: boolean
  typed: Partial<Record<Axis, string>>
  axis: Axis // gets the typed digits
  dragging: boolean
  editing: boolean // typing started or a label was clicked: stays until Enter, Esc or a click
  timer: number
}
const CLOSE = 8 // px; clicking this close to the first point closes a drawn polygon
const EDGE_HIT = 6 // px; double-clicking this close to a polygon edge inserts a point

type Drag =
  | { mode: 'move'; item: Item; dx: number; dy: number }
  | { mode: 'rotate'; item: Item }
  | { mode: 'notch'; item: Item; index: number }
  | { mode: 'vertex'; item: Item; index: number }
  | { mode: 'resize' }
  | { mode: 'pan'; x: number; y: number; cx: number; cy: number; scale: number }

/**
 * Top view: drag items to move, drag the handle to rotate (Shift snaps to 15°); lines carry hover help (data-tip).
 * Edge and corner handles resize (Alt: from the centre, Shift: keep proportions); typing sets the size exactly.
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
  private sizing: Sizing | null = null
  private labels = document.createElement('div')

  constructor(host: HTMLElement, private ctl: View2DHost) {
    this.labels.className = 'size-labels'
    host.append(this.svg, this.labels)
    this.svg.addEventListener('pointerdown', e => this.down(e))
    this.svg.addEventListener('pointermove', e => this.move(e))
    this.svg.addEventListener('pointerup', () => this.up())
    this.svg.addEventListener('pointercancel', () => this.up())
    // a click on a size label types into its axis, a click anywhere else accepts the typed size
    this.labels.addEventListener('pointerdown', e => {
      const axis = (e.target as Element).closest('[data-axis]')?.getAttribute('data-axis') as Axis | null
      if (!axis || !this.sizing) return
      clearTimeout(this.sizing.timer)
      Object.assign(this.sizing, { axis, editing: true })
      this.renderLabels()
    })
    addEventListener('pointerdown', e => this.sizing && !this.labels.contains(e.target as Node) && this.endSizing(true), true)
    addEventListener('keydown', e => this.sizingKey(e), true)
    addEventListener('keyup', e => this.sizingKey(e), true)
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
      parts.push(`<path class="layer faint" stroke="${visibleOn(this.svg, l.material.color)}" d="${pathData(l.paths)}"/>`)
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
    if (layer) parts.push(`<path class="layer" stroke="${visibleOn(this.svg, layer.material.color)}" d="${layerPaths}"/>`)
    for (const it of items) parts.push(`<text class="name" x="${it.x}" y="${it.y}">${esc(it.name)}</text>`)
    if (this.selected) {
      const it = this.selected
      const h = this.handle(it)
      parts.push(`<line class="handle-line" x1="${it.x}" y1="${it.y}" x2="${h.x}" y2="${h.y}"/>`,
        `<circle data-role="rotate" data-tip="Drag to rotate · Shift snaps to 15°" class="handle" cx="${h.x}" cy="${h.y}" r="4"/>`)
      parts.push(...this.resizeHandles(it))
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
    this.renderLabels()
  }

  /** Small SVG of one layer piece for the layer strip, framed like the unzoomed top view. */
  thumbnail(p: Project, layer: Layer, margin = 5) {
    const w = Math.max(p.box.topL, p.box.bottomL) + 2 * margin
    const h = Math.max(p.box.topW, p.box.bottomW) + 2 * margin
    const color = visibleOn(this.svg, layer.material.color)
    return `<svg viewBox="${-w / 2} ${-h / 2} ${w} ${h}" style="aspect-ratio:${w}/${h}"><path class="piece" fill-rule="evenodd" fill="${color}" stroke="${color}" d="${pathData(layer.paths)}"/></svg>`
  }

  private rerender() {
    if (this.last) this.render(...this.last)
  }

  private handle(it: Item) {
    const b = itemBox(it)
    return place([{ x: b.x, y: b.y - b.w / 2 - it.fit - HANDLE }], it)[0]
  }

  /**
   * Resize handles on the object's bounding box (polygons: drawn dashed, `pad` px outside so its corners stay free):
   * corners and edge midpoints, round shapes only the edges. Each edge can also be grabbed along its length (round
   * shapes: the quarter of the outline around it).
   */
  private resizeHandles(it: Item, pad = 6) {
    const b = itemBox(it), round = it.shape === 'cylinder' || it.shape === 'sphere'
    const gap = it.shape === 'polygon' ? pad * this.unitsPerPixel() : 0
    const at = (sx: number, sy: number) => ({ x: b.x + sx * (b.l / 2 + gap), y: b.y + sy * (b.w / 2 + gap) })
    const d = (pts: Point[], close = false) => 'M' + place(pts, it).map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + (close ? 'Z' : '')
    const tip = 'Drag to resize · Alt: from the centre · Shift: keep proportions · type a number for an exact size'
    const parts = it.shape === 'polygon' ? [`<path class="bbox" d="${d([at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], true)}"/>`] : []
    const squares: string[] = []
    for (const [sx, sy] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
      const corner = sx && sy
      if (corner && round) continue
      const dir = (Math.atan2(sy, sx) * 180) / Math.PI
      const attrs = `data-role="resize" data-sx="${sx}" data-sy="${sy}" data-tip="${tip}" style="cursor:${CURSORS[(((Math.round((dir + it.rot) / 45)) % 4) + 4) % 4]}-resize"`
      if (!corner) {
        const strip = round
          ? Array.from({ length: 19 }, (_, i) => {
              const a = ((dir - 45 + i * 5) * Math.PI) / 180
              return { x: (Math.cos(a) * b.l) / 2, y: (Math.sin(a) * b.w) / 2 }
            })
          : [at(sx || -1, sy || -1), at(sx || 1, sy || 1)]
        parts.push(`<path class="hit" ${attrs} d="${d(strip)}"/>`)
      }
      const c = place([at(sx, sy)], it)[0]
      squares.push(`<rect class="handle resize" ${attrs} x="${c.x - 2}" y="${c.y - 2}" width="4" height="4" transform="rotate(${it.rot} ${c.x} ${c.y})"/>`)
    }
    return [...parts, ...squares]
  }

  /** Size labels of the item being resized, outside its bottom (L) and right (W) edge; the typed axis is marked. */
  private renderLabels() {
    const s = this.sizing, ctm = this.svg.getScreenCTM()
    if (!s || !ctm) return this.labels.replaceChildren()
    const it = s.item, b = itemBox(it), gap = LABEL.gap * this.unitsPerPixel(), { name, mm } = this.ctl.unit()
    const host = this.labels.getBoundingClientRect()
    const a = (it.rot * Math.PI) / 180
    const label = (axis: Axis, text: string, size: number, local: Point, out: Point) => {
      const p = place([local], it)[0], c = new DOMPoint(p.x, p.y).matrixTransform(ctm)
      // outward direction on screen; shifts the label so it sits beside the edge, not on it
      const ux = out.x * Math.cos(a) - out.y * Math.sin(a), uy = out.x * Math.sin(a) + out.y * Math.cos(a), k = Math.max(Math.abs(ux), Math.abs(uy))
      const typed = s.typed[axis]
      const el = document.createElement('div')
      el.className = `size-label${axis === s.axis ? ' active' : ''}`
      el.textContent = `${text} ${typed === undefined ? (size / mm).toFixed(2) : `${typed}▏`}${name}`
      el.style.cssText = `left:${c.x - host.left}px;top:${c.y - host.top}px;transform:translate(${-50 + (50 * ux) / k}%,${-50 + (50 * uy) / k}%)`
      Object.assign(el.dataset, { axis, tip: 'Click and type a size · Tab: other side · Enter or click: accept · Esc: undo the resize' })
      return el
    }
    this.labels.replaceChildren(
      label('x', 'L', b.l, { x: b.x, y: b.y + b.w / 2 + it.fit + gap }, { x: 0, y: 1 }),
      label('y', it.shape === 'lying' ? 'Ø' : 'W', b.w, { x: b.x + b.l / 2 + it.fit + gap, y: b.y }, { x: 1, y: 0 }),
    )
  }

  private up() {
    this.drag = null
    const s = this.sizing
    if (!s?.dragging) return
    s.dragging = false
    if (!s.editing) s.timer = setTimeout(() => this.endSizing(true), LABEL.ms)
  }

  /** Ends the resize: keeps the new size, or restores the one from before. */
  private endSizing(accept: boolean) {
    const s = this.sizing
    if (!s) return
    clearTimeout(s.timer)
    this.sizing = null
    if (s.dragging) this.drag = null
    if (accept) return this.rerender()
    Object.assign(s.item, structuredClone(s.start))
    this.ctl.change()
  }

  /**
   * Keys while resizing: digits type the size of the marked axis, Tab switches it, Enter accepts, Esc undoes,
   * Shift / Alt switch the drag mode; other keys accept and keep their usual meaning.
   */
  private sizingKey(e: KeyboardEvent) {
    const s = this.sizing
    if (!s) return
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'CapsLock') return
    if (e.key === 'Shift' || e.key === 'Alt') {
      e.preventDefault() // Alt would open the browser menu on some systems
      if (!s.dragging) return
      Object.assign(s, { shift: e.shiftKey, alt: e.altKey })
      return this.resize()
    }
    if (e.type === 'keyup') return
    const typed = s.typed[s.axis]
    if (/^[\d.,]$/.test(e.key) && !e.metaKey && !e.ctrlKey) s.typed[s.axis] = (typed ?? '') + e.key
    else if (e.key === 'Backspace' && typed !== undefined) s.typed[s.axis] = typed.slice(0, -1) || undefined
    else if (e.key === 'Tab') s.axis = s.axis === 'x' ? 'y' : 'x'
    else return e.key === 'Escape' || e.key === 'Enter' ? (e.preventDefault(), e.stopPropagation(), this.endSizing(e.key === 'Enter')) : this.endSizing(true)
    e.preventDefault()
    e.stopPropagation()
    clearTimeout(s.timer)
    s.editing = true
    this.resize()
  }

  /**
   * Applies the size from the pointer and the typed values: snapped to the grid step, the opposite edge staying put
   * (Alt: the centre), proportional with Shift (set by the typed axis, else by the dragged one that changed most).
   */
  private resize() {
    const s = this.sizing!, st = s.start, it = s.item, b = itemBox(st)
    const step = this.snap ? this.snapStep : 0.1, mm = this.ctl.unit().mm
    const full = { x: b.l, y: b.w }, dir = { x: s.sx, y: s.sy }
    const typed = (axis: Axis) => {
      const v = parseFloat(s.typed[axis]?.replace(',', '.') ?? '')
      return Number.isFinite(v) ? Math.max(0.1, v * mm) : undefined
    }
    const t = { x: typed('x'), y: typed('y') }
    const raw = (axis: Axis) => full[axis] + (s.alt ? 2 : 1) * dir[axis] * (s.q[axis] - s.q0[axis])
    const sized = (axis: Axis) => t[axis] ?? (dir[axis] ? Math.max(step, round(raw(axis), step)) : full[axis])
    let size = { x: sized('x'), y: sized('y') }
    if (s.shift) {
      const change = (axis: Axis) => (dir[axis] ? Math.abs(raw(axis) / (full[axis] || 1) - 1) : -1)
      const lead: Axis = t.x !== undefined ? 'x' : t.y !== undefined ? 'y' : change('x') >= change('y') ? 'x' : 'y'
      const k = full[lead] ? size[lead] / full[lead] : 1
      size = lead === 'x' ? { x: size.x, y: full.y * k } : { x: full.x * k, y: size.y }
    }
    // the box centre moves by half the growth towards the dragged side (not at all with Alt or on undragged axes)
    const grow = (axis: Axis) => (s.alt ? 0 : (dir[axis] * (size[axis] - full[axis])) / 2)
    const offset = place([{ x: grow('x'), y: grow('y') }], { ...st, x: 0, y: 0 })[0]
    const before = this.constrain ? this.ctl.violation(it) : 0, prev = structuredClone(it)
    Object.assign(it, structuredClone(st), { x: st.x + offset.x, y: st.y + offset.y })
    setItemSize(it, size.x, size.y)
    if (this.constrain && this.ctl.violation(it) > before + AREA_TOL) Object.assign(it, prev)
    this.ctl.change()
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
    } else if (role === 'resize' && this.selected) {
      const it = this.selected, sx = Number(target.getAttribute('data-sx')), sy = Number(target.getAttribute('data-sy'))
      const q = this.toLocal(it, this.point(e))
      this.sizing = { item: it, start: structuredClone(it), sx, sy, q0: q, q, alt: e.altKey, shift: e.shiftKey, typed: {}, axis: sx ? 'x' : 'y', dragging: true, editing: false, timer: 0 }
      this.drag = { mode: 'resize' }
      this.renderLabels()
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
    if (d.mode === 'resize') {
      this.sizing!.q = this.toLocal(this.sizing!.start, this.point(e))
      Object.assign(this.sizing!, { shift: e.shiftKey, alt: e.altKey })
      return this.resize()
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
