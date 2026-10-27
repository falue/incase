import './style.css'
import type { ArrangeResult } from './arrange'
import { AREA_TOL, computeLayers, resting, wallConflicts, wallViolations, stackTotal } from './geometry'
import { exportSvg } from './export'
import { History } from './history'
import { defaultItem, itemHeight, loadProject, parseProject, saveProject, setNotchCount, suggestStack, uid, type Dim, type Item, type Project, type Shape } from './model'
import { View2D } from './view2d'
import { View3D } from './view3d'

type Section = 'materials' | 'items' | 'selection'
type Layout = 'top' | 'split' | '3d'

const SHAPES: Record<Shape, string> = { box: 'Box', cylinder: 'Cylinder', lying: 'Lying cylinder', sphere: 'Sphere' }
const SHAPE_KEYS: Record<string, Shape> = { b: 'box', c: 'cylinder', l: 'lying', s: 'sphere' }
const LAYOUT_KEYS: Record<string, Layout> = { 1: 'top', 2: 'split', 3: '3d' }
/** Sizes in panel order, ending with the one that sets how deep the object sinks; corner R goes after rotation. */
const DIMS: Record<Shape, [string, Dim, string][]> = {
  box: [
    ['Width', 'w', "Size along the object's own Y axis (before rotation)"],
    ['Length', 'l', "Size along the object's own X axis (before rotation)"],
    ['Depth', 'h', 'Height of the box, i.e. how deep it sinks into the foam'],
    ['Corner R', 'r', 'Corner radius of the box seen from above'],
  ],
  cylinder: [
    ['Diameter', 'd', ''],
    ['Depth', 'h', 'Height of the cylinder, i.e. how deep it sinks into the foam'],
  ],
  lying: [
    ['Length', 'l', ''],
    ['Diameter', 'd', 'Diameter of the lying cylinder; also how deep it sinks into the foam'],
  ],
  sphere: [['Diameter', 'd', 'Diameter of the sphere; the cut stays full width above its centre so it can be lifted out']],
}
const PALETTE = ['#000000', '#ff0000', '#0000ff', '#00a000', '#ff8000', '#00a0a0', '#a000a0', '#808000']
const ICONS = {
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/>',
  lying: '<ellipse cx="6" cy="12" rx="2.5" ry="7"/><path d="M6 5h12c1.4 0 2.5 3.1 2.5 7s-1.1 7-2.5 7H6"/>',
  sphere: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  delete: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  even: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>',
  pack: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
}
const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`
const MM_PER_IN = 25.4

// per-viewer UI preferences
const pref = (key: string) => localStorage.getItem(`incase.${key}`)
const setPref = (key: string, value: string) => localStorage.setItem(`incase.${key}`, value)

let project: Project = loadProject()
let selectedId: string | null = null
let layerIndex = 0 // layer shown in the top view, 0 = topmost
let inches = pref('units') === 'in' // display only, the model is always mm
const history = new History(JSON.stringify(project))

const $ = (id: string) => document.getElementById(id)!
/** Display format: at most 4 decimals. */
const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)
const fmtLen = (mm: number) => fmt(inches ? mm / MM_PER_IN : mm)
const unit = () => (inches ? 'in' : 'mm')
const snapStep = () => (inches ? MM_PER_IN / 8 : 5)
const selected = () => project.items.find(it => it.id === selectedId)

/** Creates an element; `tip` becomes its hover help (see the tooltip below). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, { tip, ...props }: Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const el = document.createElement(tag)
  Object.assign(el, props)
  if (tip) el.dataset.tip = String(tip)
  el.append(...children)
  return el
}

const withTip = <T extends HTMLElement>(el: T, tip: string) => ((el.dataset.tip = tip), el)

// Inputs remember their getter so values changed elsewhere (dragging, scrubbing) can be synced in place.
const getters = new WeakMap<HTMLInputElement, () => string>()

function input(type: string, get: () => string, onInput: (el: HTMLInputElement) => void) {
  const el = h('input', { type, step: 'any', value: get(), oninput: () => onInput(el) })
  getters.set(el, get)
  return el
}

/** Number input; `scrub` is the value change per pixel when dragging its label; values below `min` are clamped. */
function num(get: () => number, set: (v: number) => void, scrub = 1, min = -Infinity) {
  const el = input('number', () => fmt(get()), el => {
    if (Number.isFinite(el.valueAsNumber)) {
      set(Math.max(min, el.valueAsNumber))
      changed()
    }
  })
  el.dataset.scrub = String(scrub)
  if (min > -Infinity) el.min = String(min)
  el.onchange = () => (el.value = fmt(get())) // show the clamped value after typing
  return el
}

/** Length input: shown in the display unit, stored in mm. */
const len = (get: () => number, set: (mm: number) => void, min = -Infinity) =>
  num(() => (inches ? get() / MM_PER_IN : get()), v => set(inches ? v * MM_PER_IN : v), inches ? 0.02 : 0.5, min)

/** Length that cannot go negative (sizes, radii, depths). */
const size = (get: () => number, set: (mm: number) => void) => len(get, set, 0)

const text = (get: () => string, set: (v: string) => void, ...rebuild: Section[]) =>
  input('text', get, el => {
    set(el.value)
    changed(...rebuild)
  })

const color = (get: () => string, set: (v: string) => void) =>
  input('color', get, el => {
    set(el.value)
    changed()
  })

/** Labelled field with hover help; dragging the label of a number field scrubs its value (Shift = fine). */
function prop(label: string, el: HTMLInputElement | HTMLSelectElement, tip: string, className = '') {
  const name = h('span', { textContent: label })
  if (el instanceof HTMLInputElement && el.dataset.scrub) {
    name.className = 'scrub'
    name.onpointerdown = e => {
      const start = e.clientX, base = el.valueAsNumber || 0, step = Number(el.dataset.scrub)
      name.setPointerCapture(e.pointerId)
      name.onpointermove = m => {
        el.value = fmt(base + Math.round((m.clientX - start) / (m.shiftKey ? 10 : 1)) * step)
        el.dispatchEvent(new Event('input'))
      }
      name.onpointerup = () => (name.onpointermove = null)
    }
  }
  return h('div', { className: `prop ${className}`, tip }, name, el)
}

const button = (label: string, tip: string, action: () => void, ...rebuild: Section[]) =>
  h('button', { textContent: label, tip, onclick: () => (action(), changed(...rebuild)) })

const iconButton = (label: string, tip: string, action: () => void, ...rebuild: Section[]) =>
  Object.assign(button(label, tip, action, ...rebuild), { className: 'icon' })

const move = <T>(a: T[], from: number, to: number) => a.splice(to, 0, ...a.splice(from, 1))

/** Grip for reordering `.sortable` rows by dragging; rows move live, `drop(from, to)` commits the new order. */
function dragHandle(drop: (from: number, to: number) => void) {
  const grip = h('span', { className: 'grip', textContent: '⠿', tip: 'Drag to reorder' })
  grip.onpointerdown = e => {
    const row = grip.closest<HTMLElement>('.sortable')!, list = row.parentElement!
    const rows = () => [...list.querySelectorAll<HTMLElement>(':scope > .sortable')]
    const from = rows().indexOf(row)
    grip.setPointerCapture(e.pointerId)
    row.classList.add('dragging')
    grip.onpointermove = m => {
      const others = rows().filter(r => r !== row)
      const to = others.filter(r => {
        const b = r.getBoundingClientRect()
        return b.top + b.height / 2 < m.clientY
      }).length
      if (to < others.length) others[to].before(row)
      else others.at(-1)?.after(row)
    }
    grip.onpointerup = () => {
      grip.onpointermove = null
      row.classList.remove('dragging')
      const to = rows().indexOf(row)
      if (to !== from) drop(from, to)
    }
  }
  return grip
}

/** Segmented control with one active option; returns its re-render function. */
function segmented<T extends string>(host: HTMLElement, options: [T, string, string][], get: () => T, set: (v: T) => void) {
  const render = () =>
    host.replaceChildren(...options.map(([value, textContent, tip]) =>
      h('button', { textContent, tip, className: value === get() ? 'active' : '', onclick: () => (set(value), render()) })))
  render()
  return render
}

function syncInputs() {
  for (const el of document.querySelectorAll<HTMLInputElement>('aside input')) {
    const get = getters.get(el)
    if (get && el !== document.activeElement) el.value = get()
  }
}

const renderers: Record<Section, () => void> = { materials: renderMaterials, items: renderItems, selection: renderSelection }

/** Call after every model change; rebuilds the listed panels (structural changes), the rest is synced in place. */
function changed(...rebuild: Section[]) {
  if (project.stackAuto) project.stack = suggestStack(project.materials, project.box.depth)
  for (const s of new Set(rebuild)) renderers[s]()
  renderStack()
  syncInputs()
  history.record(() => JSON.stringify(project))
  updateChrome()
  saveProject(project)
  scheduleViews()
}

function renderCase() {
  const b = project.box
  // bottom size follows the top while both are equal (straight walls)
  const linked = (top: 'topL' | 'topW', bottom: 'bottomL' | 'bottomW') =>
    size(() => b[top], v => {
      if (b[bottom] === b[top]) b[bottom] = v
      b[top] = v
    })
  $('case').replaceChildren(
    prop('Top L', linked('topL', 'bottomL'), 'Inner length of the case at the top opening (the bottom follows while both are equal)'),
    prop('Top W', linked('topW', 'bottomW'), 'Inner width of the case at the top opening (the bottom follows while both are equal)'),
    prop('Bottom L', size(() => b.bottomL, v => (b.bottomL = v)), 'Inner length at the floor; smaller than the top for tapered walls'),
    prop('Bottom W', size(() => b.bottomW, v => (b.bottomW = v)), 'Inner width at the floor; smaller than the top for tapered walls'),
    prop('Depth', size(() => b.depth, v => (b.depth = v)), 'Inner depth of the case; the foam stack rests on its floor'),
    prop('Fit', len(() => b.fit, v => (b.fit = v)), 'How much bigger (+, loose) or smaller (−, tight grip) the cutouts are than the objects. Objects can override it'),
    prop('Edge R', size(() => b.radius, v => (b.radius = v)), 'Corner radius of the case seen from above'),
    prop('Bottom R', size(() => b.bottomRadius, v => (b.bottomRadius = v)), 'Radius where the floor meets the walls; makes the lowest layers smaller'),
    prop('Min. wall', size(() => b.minWall, v => (b.minWall = v)), 'Minimum material wall thickness: the least foam left between any two cutouts and between a cutout and the case wall'),
    prop('Lid depth', size(() => b.lidDepth, v => (b.lidDepth = v)), 'Inner depth of the lid; case depth + lid depth is the tallest anything may reach'),
  )
}

function renderMaterials() {
  const ms = project.materials
  const nextColor = () => PALETTE.find(c => c !== project.labelColor && !ms.some(m => m.color === c)) ?? '#808080'
  $('materials').replaceChildren(
    ...ms.map((m, i) =>
      h('div', { className: 'row sortable' },
        dragHandle((from, to) => (move(ms, from, to), changed('materials'))),
        withTip(color(() => m.color, v => (m.color = v)), 'Cut line colour of this material in the exported SVG'),
        withTip(Object.assign(text(() => m.name, v => (m.name = v)), { className: 'grow' }), 'Material name, shown on the layer labels'),
        prop(unit(), size(() => m.thickness, v => (m.thickness = v)), 'Sheet thickness', 'short'),
        iconButton('✕', 'Also removes its layers from the stack', () => {
          ms.splice(i, 1)
          project.stack = project.stack.filter(id => id !== m.id)
        }, 'materials'),
      ),
    ),
    h('div', { className: 'row' },
      button('+ Material', '', () => ms.push({ id: uid(), name: `Foam ${ms.length + 1}`, thickness: 5, color: nextColor() }), 'materials'),
      h('span', { className: 'grow' }),
      withTip(color(() => project.labelColor, v => (project.labelColor = v)), 'Colour of the layer labels in the export; must differ from all material colours'),
      h('span', { className: 'hint', textContent: 'Label colour' }),
    ),
    h('div', { className: 'props' },
      prop('Laser kerf', size(() => project.kerf, v => (project.kerf = v)), 'Width of the laser cut; exported pieces grow by half of it so they come out at nominal size', 'wide')),
  )
}

function renderStack() {
  const { stack, materials, box } = project
  const manual = (action: () => void) => () => {
    action()
    project.stackAuto = false
  }
  let z = 0
  const rows = stack.map((id, i) => {
    const m = materials.find(m => m.id === id)!
    const a = z
    z += m.thickness
    const select = h('select', { className: 'grow' }, ...materials.map(o => h('option', { value: o.id, textContent: `${o.name} (${fmtLen(o.thickness)} ${unit()})` })))
    select.value = id
    select.onchange = () => {
      manual(() => (stack[i] = select.value))()
      changed()
    }
    // clicking a row shows that layer in the top view
    const showLayer = (e: MouseEvent) => {
      if ((e.target as Element).closest('select, button, .grip')) return
      layerIndex = i
      scheduleViews()
    }
    return h('div', { className: 'row sortable', onclick: showLayer },
      dragHandle((from, to) => (move(stack, from, to), (project.stackAuto = false), changed())),
      h('span', { className: 'swatch', style: `background:${m.color}` }),
      h('span', { className: 'idx', textContent: String(i + 1), tip: 'Layer number, counted from the top (as on the export labels)' }),
      select,
      h('span', { className: 'hint range', textContent: `${fmtLen(a)}–${fmtLen(z)}`, tip: 'Depth range of this layer, measured from the foam top' }),
      iconButton('✕', '', manual(() => stack.splice(i, 1))),
    )
  })
  $('stack').replaceChildren(
    h('div', { className: 'row' },
      h('span', { className: 'total' + (Math.abs(z - box.depth) > 0.01 ? ' off' : ''), textContent: `${fmtLen(z)} / ${fmtLen(box.depth)} ${unit()}`, tip: 'Stack height / case depth' }),
      h('span', { className: 'grow' }),
      project.stackAuto
        ? h('span', { className: 'hint', textContent: 'auto-filled', tip: 'The stack refills itself from the material list until you edit it' })
        : button('Auto-fill', 'Refill from the material list', () => (project.stackAuto = true)),
    ),
    ...rows,
    button('+ Layer', "Adds it at the bottom, using the last layer's material", manual(() => materials.length && stack.push(stack.at(-1) ?? materials[0].id))),
  )
}

function renderItems() {
  if (!project.items.length) return $('items').replaceChildren(h('span', { className: 'hint', textContent: 'Add objects with the tools on the left (B, C, L, S).' }))
  $('items').replaceChildren(
    ...project.items.map(it =>
      h('button', { className: it.id === selectedId ? 'selected' : '', onclick: () => select(it.id) },
        h('span', { innerHTML: icon(it.shape) }),
        h('span', { className: 'grow', textContent: it.name }),
        h('span', { className: 'hint', textContent: SHAPES[it.shape] }),
      ),
    ),
  )
}

function select(id: string | null) {
  selectedId = id
  changed('items', 'selection')
}

// sizes of the last edited object; new objects start with them
const INHERITED = ['l', 'w', 'h', 'd', 'r', 'fit', 'notchD', 'notchDepth', 'notchR'] as const
let template: Partial<Item> = {}
const remember = (it: Item) => (template = Object.fromEntries(INHERITED.map(k => [k, it[k]])))

function addItem(shape: Shape) {
  const top = project.materials.find(m => m.id === project.stack[0])
  const it = { ...defaultItem(shape, `${SHAPES[shape]} ${project.items.length + 1}`, (project.items.length % 8) * 10, top?.thickness ?? 30), ...template }
  project.items.push(it)
  select(it.id)
}

function duplicate(it: Item) {
  const copy = { ...structuredClone(it), id: uid(), name: `${it.name} copy`, x: it.x + 10, y: it.y + 10 }
  project.items.push(copy)
  select(copy.id)
}

// runs in a worker while an overlay locks the UI; aborting discards the result
let arranging: Worker | null = null

function arrange(even: boolean) {
  if (arranging) return
  const worker = (arranging = new Worker(new URL('./arrange.worker.ts', import.meta.url), { type: 'module' }))
  $('busy-text').textContent = even ? 'Arranging evenly…' : 'Packing tightly…'
  $('busy').hidden = false
  worker.onmessage = (e: MessageEvent<ArrangeResult>) => {
    stopArranging()
    for (const { id, ...at } of e.data.placements) Object.assign(project.items.find(it => it.id === id)!, at)
    changed()
    if (e.data.failed) $('hint').textContent = `${e.data.failed} object(s) did not fit and were left in place`
  }
  worker.postMessage({ project, even })
}

function stopArranging() {
  arranging?.terminate()
  arranging = null
  $('busy').hidden = true
}
$('busy-abort').onclick = stopArranging

/** Min. wall violation of one item for the "keep clear" option (0 = clear). */
const violation = (it: Item) => wallViolations(project, it).get(it.id) ?? 0

function restore(state: string | null) {
  if (state === null) return
  project = parseProject(state)
  if (!selected()) selectedId = null
  renderAll()
}

function remove(it: Item) {
  project.items = project.items.filter(o => o !== it)
  select(null)
}

function renderSelection() {
  const it = selected()
  $('selection-section').hidden = !it
  if (!it) return $('selection').replaceChildren()

  const shape = h('select', {}, ...(Object.entries(SHAPES) as [Shape, string][]).map(([value, textContent]) => h('option', { value, textContent })))
  shape.value = it.shape
  shape.onchange = () => {
    it.shape = shape.value as Shape
    changed('items', 'selection')
  }
  const fit = input('number', () => (it.fit === null ? '' : fmtLen(it.fit)), el => {
    if (el.value === '') it.fit = null
    else if (Number.isFinite(el.valueAsNumber)) it.fit = inches ? el.valueAsNumber * MM_PER_IN : el.valueAsNumber
    else return
    remember(it)
    changed()
  })
  fit.placeholder = `global ${fmtLen(project.box.fit)}`
  fit.dataset.scrub = inches ? '0.02' : '0.5'
  const dims = DIMS[it.shape]
  const dimProp = ([label, k, tip]: [string, Dim, string]) => prop(label, size(() => it[k], v => ((it[k] = v), remember(it))), tip)

  $('selection').replaceChildren(
    h('div', { className: 'props' },
      prop('Name', text(() => it.name, v => (it.name = v), 'items'), '', 'wide'),
      prop('Shape', shape, 'Shape of the object; sizes are kept when switching', 'wide'),
      ...dims.filter(([, k]) => k !== 'r').map(dimProp),
      prop('Z from top', len(() => it.z, v => (it.z = v)), "How far below the foam top the object's top sits; the cut stays open above it"),
      prop('X', len(() => it.x, v => (it.x = v)), "Position of the object's centre, right of the case centre"),
      prop('Y', len(() => it.y, v => (it.y = v)), "Position of the object's centre, below the case centre (top view)"),
      prop('Rotation °', num(() => it.rot, v => (it.rot = v)), 'Rotation in the top view, clockwise'),
      ...dims.filter(([, k]) => k === 'r').map(dimProp),
      prop('Fit', fit, 'Overrides the global fit for this object (+ loose, − tight grip); leave empty to use the global one'),
    ),
    h('div', { className: 'row' },
      h('h4', { className: 'grow', textContent: 'Finger notches', tip: 'Round cutouts on the edge so you can grab the object' }),
      iconButton('−', '', () => setNotchCount(it, it.notches.length - 1), 'selection'),
      h('span', { className: 'count', textContent: String(it.notches.length) }),
      iconButton('+', '', () => setNotchCount(it, it.notches.length + 1), 'selection'),
    ),
    h('div', { className: 'props' },
      prop('Ø', size(() => it.notchD, v => ((it.notchD = v), remember(it))), 'Diameter of all finger notches of this object'),
      prop('Depth', size(() => it.notchDepth, v => ((it.notchDepth = v), remember(it))), 'How deep the notches go, measured from the foam top'),
      prop('Fillet R', size(() => it.notchR, v => ((it.notchR = v), remember(it))), 'Rounds the corners where notches meet the object or each other', 'wide'),
    ),
    it.notches.length ? h('p', { className: 'hint', textContent: 'Drag the dots in the top view to move notches along the edge.' }) : '',
  )
}

const LID_MARGIN = 2 // mm; closer than this to the closed lid counts as touching

/** Warning if the item's top reaches the closed lid (case depth + lid depth above the floor), or comes very close. */
function lidWarning(it: Item) {
  const room = project.box.depth - stackTotal(project) + resting(project, it).z + project.box.lidDepth // from its top to the lid
  if (room < 0) return `${it.name} is ${fmtLen(-room)} ${unit()} too tall for case + lid`
  return room < LID_MARGIN && `${it.name} almost touches the lid (${fmtLen(room)} ${unit()} left)`
}

function renderWarnings(conflicts: Set<string>) {
  const total = stackTotal(project)
  const diff = total - project.box.depth
  const colors = project.materials.map(m => m.color.toLowerCase())
  const warnings = [
    Math.abs(diff) > 0.01 && `Stack is ${fmtLen(Math.abs(diff))} ${unit()} ${diff < 0 ? 'lower' : 'taller'} than the case depth`,
    ...project.items.map(it => it.z + itemHeight(it) > total + 0.01 && `${it.name} reaches below the stack`),
    ...project.items.map(lidWarning),
    ...project.items.map(it => conflicts.has(it.id) && `${it.name} breaks the min. wall`),
    colors.includes(project.labelColor.toLowerCase()) && 'Label colour equals a material colour',
    new Set(colors).size < colors.length && 'Two materials share a line colour',
  ].filter((w): w is string => !!w)
  const el = $('warnings')
  el.textContent = warnings.length ? `⚠ ${warnings.join(' · ')}` : ''
  el.dataset.tip = warnings.join(' · ')
}

function download(name: string, content: string, type: string) {
  const href = URL.createObjectURL(new Blob([content], { type }))
  h('a', { href, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(href))
}

// --- hover help: any element with data-tip, after the usual title delay; hidden while a button is held ---

const TOOLTIP_DELAY = 500 // ms, like native title tooltips
const tooltip = h('div', { className: 'tooltip', hidden: true })
document.body.append(tooltip)
let tipTarget: Element | null = null
let tipTimer = 0
let pointer = { x: 0, y: 0 }

function placeTooltip() {
  const { offsetWidth: w, offsetHeight: ht } = tooltip
  tooltip.style.left = `${Math.min(pointer.x + 14, innerWidth - w - 8)}px`
  tooltip.style.top = `${pointer.y + 18 + ht > innerHeight ? pointer.y - ht - 10 : pointer.y + 18}px`
}

function hideTooltip() {
  clearTimeout(tipTimer)
  tipTarget = null
  tooltip.hidden = true
}

addEventListener('pointermove', e => {
  pointer = { x: e.clientX, y: e.clientY }
  const target = e.buttons ? null : (e.target as Element).closest('[data-tip]')
  if (target !== tipTarget) {
    hideTooltip()
    tipTarget = target
    if (target) {
      tipTimer = setTimeout(() => {
        tooltip.textContent = target.getAttribute('data-tip')
        tooltip.hidden = false
        placeTooltip()
      }, TOOLTIP_DELAY)
    }
  } else if (!tooltip.hidden) placeTooltip()
})
addEventListener('pointerdown', hideTooltip)
document.documentElement.addEventListener('pointerleave', hideTooltip)

// --- top bar ---

const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true })
document.body.append(file)
file.onchange = async () => {
  const f = file.files?.[0]
  file.value = ''
  if (!f) return
  try {
    project = parseProject(await f.text())
  } catch {
    return alert('Not a valid project file.')
  }
  selectedId = null
  renderAll()
}
$('save').onclick = () => download('incase.json', JSON.stringify(project, null, 2), 'application/json')
$('load').onclick = () => file.click()
$('export-svg').onclick = () => download('incase.svg', exportSvg(project, computeLayers(project)), 'image/svg+xml')

segmented($('units'), [['mm', 'mm', ''], ['in', 'in', 'Projects and exports stay in mm']], () => unit(), v => {
  inches = v === 'in'
  setPref('units', v)
  view2d.snapStep = snapStep()
  renderAll()
})

const viewports = $('viewports')
let layout = (pref('layout') ?? 'split') as Layout
function setLayout(v: Layout) {
  layout = v
  setPref('layout', v)
  viewports.className = `layout-${v}`
}
setLayout(layout)
const renderLayout = segmented($('layout'), [['top', 'Top', 'Top view only (1)'], ['split', 'Split', 'Top view and 3D side by side (2)'], ['3d', '3D', '3D view only (3)']], () => layout, setLayout)

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme
  view3d.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--view3d').trim())
}
$('theme').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  setPref('theme', theme)
  applyTheme(theme)
}

// --- viewports ---

const view2d = new View2D($('view2d'), { select, change: () => changed(), len: mm => `${fmtLen(mm)} ${unit()}`, violation })
view2d.snapStep = snapStep()
for (const [key, apply] of [['snap', (on: boolean) => (view2d.snap = on)], ['constrain', (on: boolean) => (view2d.constrain = on)]] as const) {
  const box = $(key) as HTMLInputElement
  box.checked = pref(key) === '1'
  apply(box.checked)
  box.onchange = () => {
    setPref(key, box.checked ? '1' : '0')
    apply(box.checked)
  }
}
const view3d = new View3D($('view3d'), select)
applyTheme(pref('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))

const splitter = $('splitter')
function setSplit(f: number) {
  const v = Math.min(0.85, Math.max(0.15, f))
  viewports.style.setProperty('--left', `minmax(0, ${v}fr)`)
  viewports.style.setProperty('--right', `minmax(0, ${1 - v}fr)`)
  setPref('split', String(v))
}
setSplit(Number(pref('split') ?? 0.5))
splitter.onpointerdown = e => {
  const r = viewports.getBoundingClientRect()
  splitter.setPointerCapture(e.pointerId)
  splitter.classList.add('dragging')
  splitter.onpointermove = m => setSplit((m.clientX - r.left) / r.width)
  splitter.onpointerup = () => {
    splitter.onpointermove = null
    splitter.classList.remove('dragging')
  }
}
splitter.ondblclick = () => setSplit(0.5)

const stepLayer = (step: number) => {
  layerIndex += step // clamped when the views render
  scheduleViews()
}
const layerUp = $('layer-up') as HTMLButtonElement
const layerDown = $('layer-down') as HTMLButtonElement
layerUp.onclick = () => stepLayer(-1)
layerDown.onclick = () => stepLayer(1)

const explode = $('explode') as HTMLInputElement
const setExplode = () => {
  view3d.explode = explode.valueAsNumber
  scheduleViews()
}
explode.oninput = setExplode
explode.ondblclick = () => {
  explode.value = '0'
  setExplode()
}

for (const axis of ['x', 'y'] as const) {
  const slider = $(`section-${axis}`)
  const [from, to] = slider.querySelectorAll('input')
  const update = (moved?: HTMLInputElement) => {
    // handles may not cross: the moved one stops at the other
    if (from.valueAsNumber > to.valueAsNumber) moved!.value = (moved === from ? to : from).value
    view3d.setSection(axis, from.valueAsNumber / 1000, to.valueAsNumber / 1000)
  }
  from.oninput = () => update(from)
  to.oninput = () => update(to)
  const reset = () => {
    from.value = '0'
    to.value = '1000'
    update()
  }
  slider.ondblclick = reset
  $(`reset-${axis}`).onclick = reset
}

view3d.setOrthographic(pref('camera') !== 'persp')
segmented($('camera'), [['ortho', 'Ortho', 'Orthographic: no perspective distortion, sizes compare directly'], ['persp', 'Persp', '']], () => (view3d.isOrthographic ? 'ortho' : 'persp'), v => {
  view3d.setOrthographic(v === 'ortho')
  setPref('camera', v)
})

// --- tool strip & status bar ---

const tool = (name: keyof typeof ICONS, tip: string, onclick: () => void) => h('button', { className: 'tool', tip, innerHTML: icon(name), onclick })
const duplicateTool = tool('duplicate', 'Duplicate (⌘/Ctrl+D)', () => {
  const it = selected()
  if (it) duplicate(it)
})
const deleteTool = tool('delete', 'Delete (Del)', () => {
  const it = selected()
  if (it) remove(it)
})
const undoTool = tool('undo', 'Undo (⌘/Ctrl+Z)', () => restore(history.undo()))
const redoTool = tool('redo', 'Redo (⇧⌘Z / Ctrl+Y)', () => restore(history.redo()))
$('toolbar').replaceChildren(
  ...(Object.entries(SHAPE_KEYS) as [string, Shape][]).map(([key, shape]) => tool(shape, `${SHAPES[shape]} (${key.toUpperCase()})`, () => addItem(shape))),
  h('hr'),
  duplicateTool,
  deleteTool,
  tool('even', 'Arrange evenly: largest equal gaps, centred (A)', () => arrange(true)),
  tool('pack', 'Pack tightly at the min. wall, centred (⇧A)', () => arrange(false)),
  h('hr'),
  undoTool,
  redoTool,
  h('hr'),
  tool('fit', 'Fit 3D view (F)', () => view3d.fit()),
)

function updateChrome() {
  const it = selected()
  duplicateTool.disabled = deleteTool.disabled = !it
  undoTool.disabled = !history.canUndo
  redoTool.disabled = !history.canRedo
  $('hint').textContent = it
    ? 'Drag to move · drag handle to rotate (Shift 15°) · arrows nudge (Shift ×10) · Del delete · ⌘D duplicate · Esc deselect · ⌘Z undo'
    : 'B C L S add · A arrange evenly, ⇧A pack · F fit 3D · PgUp / PgDn layer · 1 / 2 / 3 layout · wheel zoom, drag background to pan · drag a field label to scrub · ⌘Z undo'
}

let frame = 0
function scheduleViews() {
  frame ||= requestAnimationFrame(() => {
    frame = 0
    const layers = computeLayers(project)
    const conflicts = wallConflicts(project)
    renderWarnings(conflicts)
    layerIndex = Math.max(0, Math.min(layerIndex, layers.length - 1))
    const layer = layers[layerIndex]
    $('layer-label').textContent = layer
      ? `Layer ${layerIndex + 1}/${layers.length} · ${layer.material.name} · ${fmtLen(layer.a)}–${fmtLen(layer.b)} ${unit()}`
      : 'No layers'
    layerUp.disabled = layerIndex <= 0
    layerDown.disabled = layerIndex >= layers.length - 1
    $('stack').querySelectorAll('.sortable').forEach((row, i) => row.classList.toggle('current', i === layerIndex))
    view2d.render(project, selectedId, layers, layerIndex, conflicts)
    view3d.update(project, layers, selectedId, layerIndex)
  })
}

function renderAll() {
  renderCase()
  changed('materials', 'items', 'selection')
}

addEventListener('keydown', e => {
  if (arranging) {
    if (e.key === 'Escape') stopArranging()
    return e.preventDefault()
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  const key = e.key.toLowerCase()
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey
  const it = selected()
  const step = (view2d.snap ? snapStep() : 1) * (e.shiftKey ? 10 : 1)
  const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  const mod = e.metaKey || e.ctrlKey
  if (mod && key === 'z') restore(e.shiftKey ? history.redo() : history.undo())
  else if (mod && key === 'y') restore(history.redo())
  else if (plain && SHAPE_KEYS[key]) addItem(SHAPE_KEYS[key])
  else if (plain && key === 'a') arrange(!e.shiftKey)
  else if (plain && key === 'f') view3d.fit()
  else if (e.key === 'PageUp' || e.key === 'PageDown') stepLayer(e.key === 'PageUp' ? -1 : 1)
  else if (plain && LAYOUT_KEYS[key]) {
    setLayout(LAYOUT_KEYS[key])
    renderLayout()
  } else if (it && nudge[e.key]) {
    const [dx, dy] = nudge[e.key]
    const before = violation(it)
    it.x += dx
    it.y += dy
    if (view2d.constrain && violation(it) > before + AREA_TOL) {
      it.x -= dx
      it.y -= dy
    }
    changed()
  } else if (it && (e.key === 'Delete' || e.key === 'Backspace')) remove(it)
  else if (it && e.key === 'Escape') select(null)
  else if (it && (e.metaKey || e.ctrlKey) && key === 'd') duplicate(it)
  else return
  e.preventDefault()
})

renderAll()
