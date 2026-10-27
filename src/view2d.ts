import { FillRule, unionD } from 'clipper2-ts'
import { AREA_TOL, caseOutline, itemCuts, offset, pathData, place, type Layer } from './geometry'
import { itemSize, type Item, type Project } from './model'

const NS = 'http://www.w3.org/2000/svg'
const MARGIN = 30
const HANDLE = 12 // distance of the rotation handle beyond the item edge
const ZOOM = { min: 0.2, max: 50, speed: 0.0015 }

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
/** Invisible wide stroke over a line that shows `tip` on hover. */
const hit = (d: string, tip: string) => `<path class="hit" data-tip="${esc(tip)}" d="${d}"/>`
const round = (v: number, step: number) => Math.round(v / step) * step

export interface View2DHost {
  select(id: string | null): void
  /** Called after an item was moved or rotated. */
  change(): void
  /** Formats a length in mm for the tooltips. */
  len(mm: number): string
  /** How badly the item's current placement breaks the case wall and safe zones (0 = clear). */
  violation(it: Item): number
}

type Drag =
  | { mode: 'move'; item: Item; dx: number; dy: number }
  | { mode: 'rotate'; item: Item }
  | { mode: 'pan'; x: number; y: number; cx: number; cy: number; scale: number }

/**
 * Top view: drag items to move, drag the handle to rotate (Shift snaps to 15°), hover a line for what it is.
 * Wheel zooms at the pointer, dragging the background (or with the middle button) pans, double-click resets the view.
 */
export class View2D {
  /** Snap positions to `snapStep` (mm) and rotation to 15°. */
  snap = false
  snapStep = 5
  /** Refuse moves that make an item's safe-zone violation worse (so items in conflict can still be pulled out). */
  constrain = false
  private svg = document.createElementNS(NS, 'svg')
  private tooltip = Object.assign(document.createElement('div'), { className: 'tooltip', hidden: true })
  private items: Item[] = []
  private selected: Item | null = null
  private drag: Drag | null = null
  private zoom = 1
  private center = { x: 0, y: 0 }
  private last: Parameters<View2D['render']> | null = null

  constructor(private host: HTMLElement, private ctl: View2DHost) {
    host.append(this.svg, this.tooltip)
    this.svg.addEventListener('pointerdown', e => this.down(e))
    this.svg.addEventListener('pointermove', e => {
      this.move(e)
      this.hover(e)
    })
    this.svg.addEventListener('pointerup', () => (this.drag = null))
    this.svg.addEventListener('pointercancel', () => (this.drag = null))
    this.svg.addEventListener('pointerleave', () => (this.tooltip.hidden = true))
    this.svg.addEventListener('wheel', e => this.zoomAt(e), { passive: false })
    this.svg.addEventListener('dblclick', e => {
      if ((e.target as Element).closest('[data-id], [data-role]')) return
      this.zoom = 1
      this.center = { x: 0, y: 0 }
      this.rerender()
    })
  }

  render(p: Project, selectedId: string | null, layer: Layer | null, conflicts: Set<string>) {
    this.last = [p, selectedId, layer, conflicts]
    const b = p.box
    const w = (Math.max(b.topL, b.bottomL) + 2 * MARGIN) / this.zoom
    const h = (Math.max(b.topW, b.bottomW) + 2 * MARGIN) / this.zoom
    this.svg.setAttribute('viewBox', `${this.center.x - w / 2} ${this.center.y - h / 2} ${w} ${h}`)
    this.items = p.items
    this.selected = p.items.find(it => it.id === selectedId) ?? null

    const outline = (z: number) => pathData([caseOutline(b, z, z) ?? []])
    const parts = [
      `<defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" class="gridline"/></pattern></defs>`,
      `<rect x="-10000" y="-10000" width="20000" height="20000" fill="url(#grid)"/>`,
      `<path class="case-bottom" d="${outline(b.depth)}"/>`,
      hit(outline(b.depth), 'Case floor: inner outline at the bottom (taper and bottom edge radius)'),
      `<path class="case" d="${outline(0)}"/>`,
      hit(outline(0), 'Case rim: inner outline at the top'),
    ]
    // lines and their hover areas go below the items so they never block dragging
    const top = caseOutline(b, 0, 0)
    if (b.safeZone > 0 && top) {
      const d = pathData(offset([top], -b.safeZone))
      parts.push(`<path class="zone" d="${d}"/>`, hit(d, `Safe zone to the wall (${this.ctl.len(b.safeZone)}): cuts must stay inside this line`))
    }
    const footprints = p.items.map(it => unionD(itemCuts(it, -Infinity, b.clearance), FillRule.NonZero))
    if (b.safeZone > 0) {
      p.items.forEach((it, i) => {
        const conflict = conflicts.has(it.id)
        const d = pathData(offset(footprints[i], b.safeZone))
        parts.push(`<path class="zone${conflict ? ' conflict' : ''}" d="${d}"/>`,
          hit(d, `Safe zone of ${it.name} (${this.ctl.len(b.safeZone)}): other cuts and the wall must stay outside${conflict ? ' · VIOLATED' : ''}`))
      })
    }
    const layerPaths = layer ? pathData(layer.paths) : ''
    if (layer) parts.push(hit(layerPaths, `Layer ${layer.index + 1} cut lines · ${layer.material.name}`))
    p.items.forEach((it, i) => {
      const tip = `${it.name}: cut outline incl. clearance and notches · drag to move`
      parts.push(`<path data-id="${it.id}" data-tip="${esc(tip)}" class="item${it === this.selected ? ' selected' : ''}" d="${pathData(footprints[i])}"/>`)
    })
    if (layer) parts.push(`<path class="layer" stroke="${layer.material.color}" d="${layerPaths}"/>`)
    for (const it of p.items) parts.push(`<text class="name" x="${it.x}" y="${it.y}">${esc(it.name)}</text>`)
    if (this.selected) {
      const it = this.selected
      const h = this.handle(it, b.clearance)
      parts.push(`<line class="handle-line" x1="${it.x}" y1="${it.y}" x2="${h.x}" y2="${h.y}"/>`,
        `<circle data-role="rotate" data-tip="Drag to rotate · Shift snaps to 15°" class="handle" cx="${h.x}" cy="${h.y}" r="4"/>`)
    }
    this.svg.innerHTML = parts.join('')
  }

  private rerender() {
    if (this.last) this.render(...this.last)
  }

  private handle(it: Item, clearance: number) {
    return place([{ x: 0, y: -(itemSize(it)[1] / 2 + (it.clearance ?? clearance) + HANDLE) }], it)[0]
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

  private hover(e: PointerEvent) {
    const tip = this.drag ? null : (e.target as Element).closest('[data-tip]')?.getAttribute('data-tip')
    this.tooltip.hidden = !tip
    if (!tip) return
    const r = this.host.getBoundingClientRect()
    this.tooltip.textContent = tip
    this.tooltip.style.left = `${e.clientX - r.left + 14}px`
    this.tooltip.style.top = `${e.clientY - r.top + 14}px`
  }

  private down(e: PointerEvent) {
    const target = e.target as Element
    const id = target.closest('[data-id]')?.getAttribute('data-id') ?? null
    const rotate = target.getAttribute('data-role') === 'rotate'
    if (e.button === 1 || (!id && !rotate)) {
      e.preventDefault()
      if (e.button !== 1) this.ctl.select(null)
      this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, cx: this.center.x, cy: this.center.y, scale: 1 / this.svg.getScreenCTM()!.a }
    } else if (rotate && this.selected) {
      this.drag = { mode: 'rotate', item: this.selected }
    } else {
      const item = this.items.find(it => it.id === id)!
      const p = this.point(e)
      this.drag = { mode: 'move', item, dx: item.x - p.x, dy: item.y - p.y }
      this.ctl.select(id)
    }
    this.svg.setPointerCapture(e.pointerId)
  }

  private move(e: PointerEvent) {
    const d = this.drag
    if (!d) return
    if (d.mode === 'pan') {
      this.center = { x: d.cx - (e.clientX - d.x) * d.scale, y: d.cy - (e.clientY - d.y) * d.scale }
      return this.rerender()
    }
    const p = this.point(e), it = d.item
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
