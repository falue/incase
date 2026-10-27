import { FillRule, unionD } from 'clipper2-ts'
import { caseOutline, itemCuts, offset, pathData, place, type Layer } from './geometry'
import { itemSize, type Item, type Project } from './model'

const NS = 'http://www.w3.org/2000/svg'
const MARGIN = 30
const HANDLE = 12 // distance of the rotation handle beyond the item edge

/** Top view: drag items to move, drag the handle to rotate (Shift snaps to 15°). */
export class View2D {
  private svg = document.createElementNS(NS, 'svg')
  private items: Item[] = []
  private selected: Item | null = null
  private drag: { mode: 'move' | 'rotate'; item: Item; dx: number; dy: number } | null = null

  constructor(host: HTMLElement, private onSelect: (id: string | null) => void, private onChange: () => void) {
    host.append(this.svg)
    this.svg.addEventListener('pointerdown', e => this.down(e))
    this.svg.addEventListener('pointermove', e => this.move(e))
    this.svg.addEventListener('pointerup', () => (this.drag = null))
    this.svg.addEventListener('pointercancel', () => (this.drag = null))
  }

  render(p: Project, selectedId: string | null, layer: Layer | null, conflicts: Set<string>) {
    const b = p.box
    const L = Math.max(b.topL, b.bottomL), W = Math.max(b.topW, b.bottomW)
    this.svg.setAttribute('viewBox', `${-L / 2 - MARGIN} ${-W / 2 - MARGIN} ${L + 2 * MARGIN} ${W + 2 * MARGIN}`)
    this.items = p.items
    this.selected = p.items.find(it => it.id === selectedId) ?? null

    const outline = (z: number) => pathData([caseOutline(b, z, z) ?? []])
    const parts = [
      `<defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" class="gridline"/></pattern></defs>`,
      `<rect x="${-L / 2 - MARGIN}" y="${-W / 2 - MARGIN}" width="${L + 2 * MARGIN}" height="${W + 2 * MARGIN}" fill="url(#grid)"/>`,
      `<path class="case-bottom" d="${outline(b.depth)}"/>`,
      `<path class="case" d="${outline(0)}"/>`,
    ]
    const top = caseOutline(b, 0, 0)
    if (b.safeZone > 0 && top) parts.push(`<path class="zone" d="${pathData(offset([top], -b.safeZone))}"/>`)
    for (const it of p.items) {
      const footprint = unionD(itemCuts(it, -Infinity, b.clearance), FillRule.NonZero)
      if (b.safeZone > 0) parts.push(`<path class="zone${conflicts.has(it.id) ? ' conflict' : ''}" d="${pathData(offset(footprint, b.safeZone))}"/>`)
      parts.push(`<path data-id="${it.id}" class="item${it === this.selected ? ' selected' : ''}" d="${pathData(footprint)}"/>`)
    }
    if (layer) parts.push(`<path class="layer" stroke="${layer.material.color}" d="${pathData(layer.paths)}"/>`)
    for (const it of p.items) parts.push(`<text class="name" x="${it.x}" y="${it.y}">${it.name.replace(/[&<>]/g, '')}</text>`)
    if (this.selected) {
      const it = this.selected
      const h = this.handle(it, b.clearance)
      parts.push(`<line class="handle-line" x1="${it.x}" y1="${it.y}" x2="${h.x}" y2="${h.y}"/>`, `<circle data-role="rotate" class="handle" cx="${h.x}" cy="${h.y}" r="4"/>`)
    }
    this.svg.innerHTML = parts.join('')
  }

  private handle(it: Item, clearance: number) {
    return place([{ x: 0, y: -(itemSize(it)[1] / 2 + (it.clearance ?? clearance) + HANDLE) }], it)[0]
  }

  private point(e: PointerEvent) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(this.svg.getScreenCTM()!.inverse())
  }

  private down(e: PointerEvent) {
    const target = e.target as Element
    const p = this.point(e)
    if (target.getAttribute('data-role') === 'rotate' && this.selected) {
      this.drag = { mode: 'rotate', item: this.selected, dx: 0, dy: 0 }
    } else {
      const id = target.closest('[data-id]')?.getAttribute('data-id') ?? null
      const item = this.items.find(it => it.id === id)
      this.drag = item ? { mode: 'move', item, dx: item.x - p.x, dy: item.y - p.y } : null
      this.onSelect(id)
    }
    if (this.drag) this.svg.setPointerCapture(e.pointerId)
  }

  private move(e: PointerEvent) {
    if (!this.drag) return
    const p = this.point(e), it = this.drag.item
    if (this.drag.mode === 'move') {
      it.x = Math.round((p.x + this.drag.dx) * 2) / 2
      it.y = Math.round((p.y + this.drag.dy) * 2) / 2
    } else {
      const a = (Math.atan2(p.y - it.y, p.x - it.x) * 180) / Math.PI + 90
      const snapped = e.shiftKey ? Math.round(a / 15) * 15 : Math.round(a * 10) / 10
      it.rot = ((snapped + 540) % 360) - 180
    }
    this.onChange()
  }
}
