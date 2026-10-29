import { svgLines } from './curves'
import { pathData, type Layer } from './geometry'
import type { Project, SheetPlacement } from './model'
import { FONT, pieceShapes, planSheets, sheetTitle, spacing, turn, turnedBox, type Piece, type Sheet } from './sheets'
import { visibleOn } from './view2d'

const NS = 'http://www.w3.org/2000/svg'
const PAD = 10 // mm around the drawing
const STEP = 0.5 // mm; hand placements snap to it
const HANDLE = 24 // px from the piece edge to its rotation handle
const HANDLE_R = 5 // px
const ZOOM = { max: 50, speed: 0.0015 } // from the fitted view (1) in

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
const round = (v: number, step: number) => Math.round(v / step) * step

export interface SheetViewHost {
  /** A piece was moved or turned by hand; `sheets` is the layout it was moved in. */
  place(sheets: Sheet[], piece: Piece, to: SheetPlacement): void
}

type Hit = { sheet: Sheet; piece: Piece }
type Drag =
  | (Hit & { mode: 'move'; el: SVGGElement; x: number; y: number; moved: boolean })
  | (Hit & { mode: 'rotate'; rot: number })
  | { mode: 'pan'; x: number; y: number; cx: number; cy: number; scale: number }

/**
 * The stock sheets with their pieces, fitted into the view. Click a piece to select it; drag it to move it, also onto
 * another sheet of its material (an empty spare one is offered); drag its handle to turn it (Ctrl snaps to 15°);
 * double-click or `rotateHovered` turns it by 90°. Pieces of materials without a sheet size and oversize pieces stay put.
 * Wheel zooms at the pointer, dragging the background (or with the middle button) pans, double-clicking it fits the view.
 */
export class SheetView {
  private svg = document.createElementNS(NS, 'svg')
  private last: [Project, Layer[]] | null = null
  private sheets: Sheet[] = []
  private selected: number | null = null // layer index
  private hovered: number | null = null // layer index of the piece under the pointer
  private drag: Drag | null = null
  private zoom = 1
  private center: { x: number; y: number } | null = null // null: the drawing's centre

  constructor(host: HTMLElement, private ctl: SheetViewHost) {
    host.append(this.svg)
    this.svg.addEventListener('pointerdown', e => this.down(e))
    this.svg.addEventListener('contextmenu', e => e.preventDefault()) // Ctrl+click on macOS would open it
    this.svg.addEventListener('pointermove', e => this.move(e))
    this.svg.addEventListener('pointerup', e => this.up(e))
    this.svg.addEventListener('pointercancel', () => this.cancel())
    this.svg.addEventListener('pointerleave', () => (this.hovered = null))
    this.svg.addEventListener('wheel', e => this.zoomAt(e), { passive: false })
    this.svg.addEventListener('dblclick', e => {
      const hit = this.hit(e)
      if (hit) this.turnBy90(hit)
      else if (!(e.target as Element).closest('.piece, [data-role]')) {
        this.zoom = 1
        this.center = null
        this.rerender()
      }
    })
  }

  render(p: Project, layers: Layer[]) {
    this.last = [p, layers]
    // titles grow with the sheets so they stay readable
    const head = Math.max(FONT + 3, 0.05 * Math.max(p.box.topL, p.box.topW, ...p.materials.flatMap(m => (m.sheets ?? []).flatMap(s => [s.w, s.h]))))
    const { sheets, width, height } = planSheets(p, layers, { spare: true, head })
    this.sheets = sheets
    const w = (width + 2 * PAD) / this.zoom, h = (height + 2 * PAD) / this.zoom
    const c = this.center ?? { x: width / 2, y: height / 2 }
    this.svg.setAttribute('viewBox', `${c.x - w / 2} ${c.y - h / 2} ${w} ${h}`)
    const label = visibleOn(this.svg, p.labelColor), outline = visibleOn(this.svg, p.outlineColor)
    const parts = sheets.flatMap((s, i) => {
      const fill = s.pieces.reduce((sum, pc) => sum + (pc.box.right - pc.box.left) * (pc.box.bottom - pc.box.top), 0) / (s.w * s.h)
      const title = s.spare ? `Empty ${s.w} × ${s.h} sheet: drag pieces here` : `${sheetTitle(sheets, s)}${s.unlimited ? '' : ` · ${Math.round(fill * 100)} % used`}`
      return [
        `<rect style="--frame:${outline}" class="sheet${s.spare ? ' spare' : ''}${s.unlimited ? ' unlimited' : ''}${s.oversize ? ' oversize' : ''}${s.missing ? ' missing' : ''}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"/>`,
        `<text class="title" x="${s.x}" y="${s.y - head * 0.3}" font-size="${head * 0.6}">${esc(title)}</text>`,
        ...s.pieces.map((pc, j) => {
          const { cut, outlines, footprints, label: l, names } = pieceShapes(p, s, pc)
          const color = visibleOn(this.svg, pc.layer.material.color)
          const fixed = s.index < 0
          const tip = fixed ? 'Placed automatically' : 'Click to select · drag to move, also onto another sheet · drag the handle to turn (Ctrl 15°) · double-click or R turns by 90°'
          const cls = `piece${pc.conflict || s.oversize ? ' conflict' : ''}${fixed ? ' fixed' : ''}${pc.layer.index === this.selected ? ' selected' : ''}`
          return `<g class="${cls}" data-sheet="${i}" data-piece="${j}" data-tip="${esc(`Layer ${pc.layer.index + 1} · ${tip}`)}">`
            + `<path class="cut" stroke="${color}" fill="${color}" d="${pathData(cut)}"/>`
            + (p.showOutlines ? `<path class="outline" stroke="${outline}" d="${pathData(outlines)}"/>` : '')
            + (p.showFootprints ? `<path class="label" stroke="${label}" d="${pathData(footprints)}"/>` : '')
            + (p.showLabels ? `<path class="label" stroke="${pc.layer.index ? label : outline}" d="${svgLines(l)}"/>` : '')
            + (p.showLabels ? names.map(t => `<text class="name" fill="${pc.layer.index ? outline : label}" font-size="${FONT}" x="${t.x}" y="${t.y}" transform="rotate(${t.rot} ${t.x} ${t.y})">${esc(t.text)}</text>`).join('') : '')
            + '</g>'
        }),
      ]
    })
    const sel = this.find(this.selected)
    if (sel) {
      // beyond the piece's top edge (unturned), turned with it
      const upp = 1 / (this.svg.getScreenCTM()?.a || 1)
      const { sheet: s, piece: pc } = sel, cx = s.x + pc.x, cy = s.y + pc.y
      const h = turn([[{ x: 0, y: turnedBox(p, pc.layer, 0).top - HANDLE * upp }]], pc.rot, cx, cy)[0][0]
      parts.push(`<g id="handle"><line class="handle-line" x1="${cx}" y1="${cy}" x2="${h.x}" y2="${h.y}"/>`
        + `<circle data-role="rotate" data-tip="Drag to turn · Ctrl snaps to 15°" class="handle" cx="${h.x}" cy="${h.y}" r="${HANDLE_R * upp}"/></g>`)
    } else this.selected = null
    this.svg.innerHTML = parts.join('')
  }

  /** Turns the piece under the pointer (or else the selected one) by 90°. */
  rotateHovered() {
    const hit = this.find(this.hovered ?? this.selected)
    if (hit && !this.drag) this.turnBy90(hit)
  }

  private rerender() {
    if (this.last) this.render(...this.last)
  }

  /** Movable piece of the given layer. */
  private find(layer: number | null): Hit | null {
    const sheet = this.sheets.find(s => s.index >= 0 && s.pieces.some(pc => pc.layer.index === layer))
    return sheet ? { sheet, piece: sheet.pieces.find(pc => pc.layer.index === layer)! } : null
  }

  private point(e: MouseEvent) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(this.svg.getScreenCTM()!.inverse())
  }

  /** Movable piece under the pointer. */
  private hit(e: Event): Hit | null {
    const el = (e.target as Element).closest<SVGGElement>('.piece')
    if (!el) return null
    const sheet = this.sheets[Number(el.dataset.sheet)]
    return sheet.index >= 0 ? { sheet, piece: sheet.pieces[Number(el.dataset.piece)] } : null
  }

  private pieceEl({ piece }: Hit) {
    const sheet = this.sheets.findIndex(s => s.pieces.includes(piece))
    return this.svg.querySelector<SVGGElement>(`.piece[data-sheet="${sheet}"][data-piece="${this.sheets[sheet].pieces.indexOf(piece)}"]`)!
  }

  private zoomAt(e: WheelEvent) {
    e.preventDefault()
    const p = this.point(e), b = this.svg.viewBox.baseVal
    const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    const zoom = Math.min(ZOOM.max, Math.max(1, this.zoom * Math.exp(-e.deltaY * ZOOM.speed)))
    const k = this.zoom / zoom // keeps the point under the cursor in place
    this.center = zoom === 1 ? null : { x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k }
    this.zoom = zoom
    this.rerender()
  }

  private pan(e: PointerEvent) {
    e.preventDefault()
    const b = this.svg.viewBox.baseVal
    this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, cx: b.x + b.width / 2, cy: b.y + b.height / 2, scale: 1 / this.svg.getScreenCTM()!.a }
    this.svg.setPointerCapture(e.pointerId)
  }

  private down(e: PointerEvent) {
    if (e.button === 1) return this.pan(e)
    if (e.button !== 0) return
    const sel = this.find(this.selected)
    if (sel && (e.target as Element).getAttribute('data-role') === 'rotate') {
      this.drag = { ...sel, mode: 'rotate', rot: sel.piece.rot }
    } else {
      const hit = this.hit(e)
      const layer = hit?.piece.layer.index ?? null
      if (layer !== this.selected) {
        this.selected = layer
        this.rerender()
      }
      if (!hit) {
        if (!(e.target as Element).closest('.piece')) this.pan(e)
        return
      }
      const p = this.point(e)
      this.drag = { ...this.find(layer)!, mode: 'move', el: this.pieceEl(this.find(layer)!), x: p.x, y: p.y, moved: false }
    }
    this.svg.setPointerCapture(e.pointerId)
  }

  private move(e: PointerEvent) {
    const d = this.drag
    if (!d) {
      this.hovered = this.hit(e)?.piece.layer.index ?? null
      return
    }
    if (d.mode === 'pan') {
      this.center = { x: d.cx - (e.clientX - d.x) * d.scale, y: d.cy - (e.clientY - d.y) * d.scale }
      return this.rerender()
    }
    const p = this.point(e)
    if (d.mode === 'move') {
      d.moved = true
      const t = `translate(${p.x - d.x} ${p.y - d.y})`
      d.el.setAttribute('transform', t)
      this.svg.querySelector('#handle')?.setAttribute('transform', t)
      return
    }
    // preview: the piece and its handle turned about its origin
    const cx = d.sheet.x + d.piece.x, cy = d.sheet.y + d.piece.y
    const a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90
    d.rot = (round(a, e.ctrlKey ? 15 : 0.1) + 360) % 360
    const t = `rotate(${d.rot - d.piece.rot} ${cx} ${cy})`
    this.pieceEl(d).setAttribute('transform', t)
    this.svg.querySelector('#handle')!.setAttribute('transform', t)
  }

  /** Drops a moved piece on the sheet of its material under the pointer (elsewhere it snaps back), or applies a turn. */
  private up(e: PointerEvent) {
    const d = this.drag
    this.drag = null
    if (d?.mode === 'rotate') {
      if (d.rot === d.piece.rot || !this.place(d.sheet, d.piece, d.piece.x, d.piece.y, d.rot)) this.rerender()
      return
    }
    if (d?.mode !== 'move' || !d.moved) return
    const p = this.point(e)
    const to = this.sheets.find(s => s.material === d.sheet.material && s.index >= 0 && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h)
    const { sheet, piece } = d
    if (!to || !this.place(to, piece, sheet.x + piece.x + p.x - d.x - to.x, sheet.y + piece.y + p.y - d.y - to.y, piece.rot)) this.rerender()
  }

  private cancel() {
    if (this.drag && this.drag.mode !== 'pan') this.rerender()
    this.drag = null
  }

  private turnBy90({ sheet, piece }: Hit) {
    this.place(sheet, piece, piece.x, piece.y, (piece.rot + 90) % 360)
  }

  /**
   * Hands a placement to the host, snapped and kept inside the sheet;
   * false (and nothing happens) if the piece does not fit the sheet turned that way.
   */
  private place(s: Sheet, piece: Piece, x: number, y: number, rot: number) {
    const [p] = this.last!
    const g = spacing(p), box = turnedBox(p, piece.layer, rot)
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, round(v, STEP)))
    const [minX, maxX, minY, maxY] = [g - box.left, s.w - g - box.right, g - box.top, s.h - g - box.bottom]
    if (minX > maxX + 1e-6 || minY > maxY + 1e-6) return false
    this.ctl.place(this.sheets, piece, { layer: piece.layer.index, material: s.material.id, sheet: s.index, w: s.w, h: s.h, x: clamp(x, minX, maxX), y: clamp(y, minY, maxY), rot })
    return true
  }
}
