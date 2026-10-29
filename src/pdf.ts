import { jsPDF } from 'jspdf'
import type { Contour } from './curves'
import { layout, type Piece } from './export'
import type { Layer } from './geometry'
import type { Project } from './model'

/** Paper sizes in mm, portrait. */
export const PAPERS: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Legal: [215.9, 355.6] }

const MARGIN = 10 // mm; printers cannot print to the edge
const OVERLAP = 15 // mm shared by neighbouring sheets of a split layer, for aligning and gluing
const LINE = 0.2 // mm
const MARK = 4 // mm, arm length of a registration cross
const PT_PER_MM = 72 / 25.4
const TEST = 50 // mm, side of the scale check square

/** Draws contours as lines and Bézier-approximated arcs, shifted by (dx, dy). */
function draw(doc: jsPDF, cs: Contour[], dx: number, dy: number) {
  for (const c of cs) {
    let at = c.start
    doc.moveTo(at.x + dx, at.y + dy)
    for (const { to, arc } of c.segments) {
      if (!arc) doc.lineTo(to.x + dx, to.y + dy)
      else {
        // arcs of up to 90° are drawn as one cubic Bézier each
        const n = Math.ceil(Math.abs(arc.span) / (Math.PI / 2))
        const step = arc.span / n, k = (4 / 3) * Math.tan(step / 4)
        let a = Math.atan2(at.y - arc.y, at.x - arc.x)
        for (let i = 0; i < n; i++, a += step) {
          const [c0, s0, c1, s1] = [Math.cos(a), Math.sin(a), Math.cos(a + step), Math.sin(a + step)]
          const x0 = arc.x + arc.r * c0, y0 = arc.y + arc.r * s0, x3 = arc.x + arc.r * c1, y3 = arc.y + arc.r * s1
          doc.curveTo(x0 - k * arc.r * s0 + dx, y0 + k * arc.r * c0 + dy, x3 + k * arc.r * s1 + dx, y3 - k * arc.r * c1 + dy, x3 + dx, y3 + dy)
        }
      }
      at = to
    }
    doc.close()
  }
  doc.stroke()
}

/** Cut lines, object outlines and label of a piece (those two if switched on), shifted by (dx, dy). */
function drawPiece(doc: jsPDF, p: Project, pc: Piece, dx: number, dy: number, font: number) {
  doc.setLineWidth(LINE)
  doc.setDrawColor(p.outlineColor)
  if (p.showOutlines && pc.outlines.length) draw(doc, pc.outlines, dx, dy)
  doc.setDrawColor(pc.color)
  draw(doc, pc.cut, dx, dy)
  if (!p.showLabels) return
  doc.setTextColor(p.labelColor).setFontSize(font * PT_PER_MM)
  doc.text(pc.label.replace(/·/g, '-'), pc.labelAt.x + dx, pc.labelAt.y + dy)
}

const cross = (doc: jsPDF, x: number, y: number) => {
  doc.line(x - MARK, y, x + MARK, y)
  doc.line(x, y - MARK, x, y + MARK)
}

/**
 * Printable 1:1 templates. Layers that fit on a sheet share sheets (row by row); larger layers are split onto
 * several sheets that overlap by OVERLAP, with registration crosses at the same spots on neighbouring sheets
 * and a dashed line where the next sheet begins. Every sheet is labelled; a cover sheet carries a 50 mm check square.
 */
export function exportPdf(p: Project, layers: Layer[], paper: [number, number]): Blob {
  const { pieces, font } = layout(p, layers)
  const [pw, ph] = paper
  const doc = new jsPDF({ unit: 'mm', format: [pw, ph], orientation: 'portrait' })
  const page = (landscape: boolean) => {
    doc.addPage([pw, ph], landscape ? 'landscape' : 'portrait')
    return landscape ? [ph, pw] : [pw, ph]
  }
  const number = (pc: Piece) => pc.label.split(' · ')[0]

  // cover: how to print and a square to check the scale
  doc.setTextColor('#000000').setFontSize(16).text('incase · foam layer templates', MARGIN, MARGIN + 6)
  doc.setFontSize(10).text([
    'Print at 100 % / "actual size", no "fit to page".',
    `Check the square below: it must measure exactly ${TEST} × ${TEST} mm.`,
    `Layers that are larger than a sheet are split; neighbouring sheets overlap by ${OVERLAP} mm.`,
    'Line up the crosses of neighbouring sheets, then glue or tape them together.',
  ], MARGIN, MARGIN + 16, { lineHeightFactor: 1.5 })
  doc.setDrawColor('#000000').setLineWidth(LINE).rect(MARGIN, MARGIN + 45, TEST, TEST)
  doc.setFontSize(8).text(`${TEST} × ${TEST} mm`, MARGIN + TEST / 2, MARGIN + 45 + TEST / 2, { align: 'center', baseline: 'middle' })
  const footer = (text: string, w: number, h: number) => {
    doc.setTextColor('#000000').setFontSize(8)
    doc.text(text, MARGIN, h - MARGIN / 2)
    doc.text('incase · print at 100 % / actual size', w - MARGIN, h - MARGIN / 2, { align: 'right' })
  }
  const fits = (pc: Piece, w: number, h: number) => pc.w <= w - 2 * MARGIN && pc.h <= h - 2 * MARGIN

  // layers that fit a portrait sheet: packed in rows, several per sheet
  const small = pieces.filter(pc => fits(pc, pw, ph))
  const sheetsSmall: { pc: Piece; x: number; y: number }[][] = []
  let x = MARGIN, y = MARGIN, row = 0
  for (const pc of small) {
    if (x + pc.w > pw - MARGIN) [x, y, row] = [MARGIN, y + row + 5, 0]
    if (!sheetsSmall.length || y + pc.h > ph - MARGIN) {
      sheetsSmall.push([])
      ;[x, y, row] = [MARGIN, MARGIN, 0]
    }
    sheetsSmall.at(-1)!.push({ pc, x, y })
    x += pc.w + 5
    row = Math.max(row, pc.h)
  }
  sheetsSmall.forEach(sheet => {
    const [w, h] = page(false)
    for (const { pc, x, y } of sheet) drawPiece(doc, p, pc, x - pc.x, y - pc.y, font)
    footer(`Layer${sheet.length > 1 ? 's' : ''} ${sheet.map(s => number(s.pc)).join(', ')}`, w, h)
  })

  // larger layers: one landscape sheet if that fits, else split onto as few sheets as possible
  for (const pc of pieces.filter(pc => !fits(pc, pw, ph))) {
    const tiles = (w: number, h: number) => {
      const aw = w - 2 * MARGIN, ah = h - 2 * MARGIN
      return [Math.max(1, Math.ceil((pc.w - OVERLAP) / (aw - OVERLAP))), Math.max(1, Math.ceil((pc.h - OVERLAP) / (ah - OVERLAP)))]
    }
    const [pc0, pr0] = tiles(pw, ph), [lc0, lr0] = tiles(ph, pw)
    const landscape = lc0 * lr0 < pc0 * pr0
    const [cols, rows] = landscape ? [lc0, lr0] : [pc0, pr0]
    const n = number(pc)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const [w, h] = page(landscape)
        const aw = w - 2 * MARGIN, ah = h - 2 * MARGIN, sx = aw - OVERLAP, sy = ah - OVERLAP
        // this sheet shows the piece region starting at (ox, oy)
        const ox = pc.x + c * sx, oy = pc.y + r * sy, dx = MARGIN - ox, dy = MARGIN - oy
        doc.saveGraphicsState()
        doc.rect(MARGIN, MARGIN, aw, ah, null)
        doc.clip()
        doc.discardPath()
        drawPiece(doc, p, pc, dx, dy, font)
        doc.setDrawColor('#000000').setLineWidth(0.1)
        // registration crosses on the sheet grid: neighbours print them at the same spots inside the overlap
        for (let gx = 0; gx <= cols; gx++) for (let gy = 0; gy <= rows; gy++) cross(doc, pc.x + gx * sx + OVERLAP / 2 + dx, pc.y + gy * sy + OVERLAP / 2 + dy)
        doc.restoreGraphicsState()
        // dashed line where the next sheet's printed area begins
        doc.setDrawColor('#888888').setLineWidth(0.1).setLineDashPattern([2, 2], 0)
        if (c < cols - 1) doc.line(MARGIN + sx, MARGIN, MARGIN + sx, MARGIN + ah)
        if (r < rows - 1) doc.line(MARGIN, MARGIN + sy, MARGIN + aw, MARGIN + sy)
        doc.setLineDashPattern([], 0)
        footer(`Layer ${n} · sheet ${r * cols + c + 1} of ${rows * cols} · row ${r + 1}, column ${c + 1} · overlap ${OVERLAP} mm: line up the crosses`, w, h)
      }
    }
  }

  return doc.output('blob')
}
