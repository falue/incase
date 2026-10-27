import './style.css'
import type { ArrangeResult } from './arrange'
import { AREA_TOL, computeLayers, resting, wallConflicts, wallViolations, stackTotal } from './geometry'
import { exportDxf, exportSvg } from './export'
import { History } from './history'
import { exportPdf, PAPERS } from './pdf'
import { PRESETS, saveUserPresets, userPresets, type Preset } from './presets'
import { boxCorners, defaultItem, itemHeight, LAYER_COST, loadProject, newProject, parseProject, saveProject, setNotchCount, suggestStack, uid, type CaseKey, type Dim, type Item, type Material, type Project, type Shape } from './model'
import { View2D } from './view2d'
import { View3D } from './view3d'

type Section = 'case' | 'materials' | 'items' | 'selection'
type Layout = 'top' | 'split' | '3d'

const SHAPES: Record<Shape, string> = { box: 'Box', cylinder: 'Cylinder', lying: 'Lying cylinder', sphere: 'Sphere', polygon: 'Polygon' }
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
  polygon: [
    ['Depth', 'h', 'How deep the object sinks into the foam'],
    ['Corner R', 'r', 'Rounds every corner of the polygon'],
  ],
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
  polygon: '<path d="M4 18l3-12 9-2 4 9-7 7z"/>',
  even: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>',
  pack: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
}
const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`
const MM_PER_IN = 25.4
const CASE_KEYS: CaseKey[] = ['topL', 'topW', 'bottomL', 'bottomW', 'depth', 'lidDepth', 'radius', 'bottomRadius']

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
    e.preventDefault()
    const row = grip.closest<HTMLElement>('.sortable')!, list = row.parentElement!
    const rows = () => [...list.querySelectorAll<HTMLElement>(':scope > .sortable')]
    const from = rows().indexOf(row)
    row.classList.add('dragging')
    // listen on the window: moving the row in the DOM would drop a pointer capture on the grip
    const move = (m: PointerEvent) => {
      const others = rows().filter(r => r !== row)
      const to = others.filter(r => {
        const b = r.getBoundingClientRect()
        return b.top + b.height / 2 < m.clientY
      }).length
      if (to === rows().indexOf(row)) return
      if (to < others.length) others[to].before(row)
      else others.at(-1)!.after(row)
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      row.classList.remove('dragging')
      const to = rows().indexOf(row)
      if (to !== from) drop(from, to)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
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
  for (const el of document.querySelectorAll<HTMLInputElement>('input')) {
    const get = getters.get(el)
    if (get && el !== document.activeElement) el.value = get()
  }
}

const renderers: Record<Section, () => void> = { case: renderCase, materials: renderMaterials, items: renderItems, selection: renderSelection }

/** Call after every model change; rebuilds the listed panels (structural changes), the rest is synced in place. */
function changed(...rebuild: Section[]) {
  if (project.stackAuto) project.stack = suggestStack(project.materials, project.box.depth, project.items.map(it => it.z + itemHeight(it)), project.layerCost)
  for (const s of new Set(rebuild)) renderers[s]()
  renderStack()
  renderPresetName()
  syncInputs()
  history.record(() => JSON.stringify(project))
  updateChrome()
  saveProject(project)
  scheduleViews()
}

function renderCase() {
  const b = project.box
  /** Case size field; a red dot marks values the chosen preset had no data for, until they are edited. */
  const field = (label: string, key: CaseKey, tip: string, set: (v: number) => void = v => (b[key] = v)) => {
    const unknown = b.unknown.includes(key)
    const assumed = key === 'bottomL' || key === 'bottomW'
    const note = assumed ? 'No data for this preset: assumed equal to the top' : 'No data for this preset: set to 0'
    const el = prop(label, size(() => b[key], v => {
      set(v)
      b.unknown = b.unknown.filter(k => k !== key)
      el.classList.remove('unknown')
      el.dataset.tip = tip
    }), unknown ? `${note} · ${tip}` : tip)
    el.classList.toggle('unknown', unknown)
    return el
  }
  // bottom size follows the top while both are equal (straight walls)
  const linked = (top: 'topL' | 'topW', bottom: 'bottomL' | 'bottomW') => (v: number) => {
    if (b[bottom] === b[top]) b[bottom] = v
    b[top] = v
  }
  $('case').replaceChildren(
    field('Top L', 'topL', 'Inner length of the case at the top opening (the bottom follows while both are equal)', linked('topL', 'bottomL')),
    field('Top W', 'topW', 'Inner width of the case at the top opening (the bottom follows while both are equal)', linked('topW', 'bottomW')),
    field('Bottom L', 'bottomL', 'Inner length at the floor; smaller than the top for tapered walls'),
    field('Bottom W', 'bottomW', 'Inner width at the floor; smaller than the top for tapered walls'),
    field('Depth', 'depth', 'Inner depth of the case; the foam stack rests on its floor'),
    field('Edge R', 'radius', 'Corner radius of the case seen from above'),
    field('Bottom R', 'bottomRadius', 'Radius where the floor meets the walls; makes the lowest layers smaller'),
    prop('Min. wall', size(() => b.minWall, v => (b.minWall = v)), 'Minimum material wall thickness: the least foam left between any two cutouts and between a cutout and the case wall'),
    field('Lid depth', 'lidDepth', 'Inner depth of the lid; case depth + lid depth is the tallest anything may reach'),
    ...(isBorrowed('preset-picker') ? [] : [$('preset-picker')]),
  )
}

/** "Brand - model" (model names are unique only within a brand); your own presets by their name. */
const presetLabel = (p: Preset) => (p.user ? p.name : `${p.group} - ${p.name}`)

/** Shows the applied preset next to the Case title, as long as no case size was changed since. */
function renderPresetName() {
  const p = [...userPresets(), ...PRESETS].find(p => presetLabel(p) === project.box.preset)
  $('case-preset').textContent = p && CASE_KEYS.every(k => project.box[k] === p.values[k]) ? presetLabel(p) : ''
}

/**
 * Presets popup: pick a brand, then a model (Enter or click applies it, undoable); typing searches all brands.
 */
function presetPicker() {
  const search = h('input', { type: 'text', className: 'grow', placeholder: 'Search, e.g. Peli 1500 or 600×400' })
  withTip(search, 'Fills in the case from a preset. Peli is a trademark of Pelican Products, Inc.; RAKO of Georg Utz; not affiliated')
  const list = h('div', { className: 'preset-list' })
  type Entry = { label: string; hint: string; pick: () => void; remove?: () => void }
  let entries: Entry[] = []
  let active = 0
  let brand: string | null = null // brand whose models are listed while the search is empty

  const all = () => [...userPresets(), ...PRESETS]
  const apply = (p: Preset) => {
    Object.assign(project.box, p.values)
    project.box.unknown = [...p.unknown]
    project.box.preset = presetLabel(p)
    search.value = ''
    search.blur()
    changed('case')
  }
  const preset = (p: Preset): Entry => ({
    label: p.name,
    hint: p.user ? 'yours' : p.group,
    pick: () => apply(p),
    remove: p.user ? () => (saveUserPresets(userPresets().filter(u => u.name !== p.name)), show()) : undefined,
  })
  const open = (b: string | null) => () => {
    brand = b
    active = b ? 1 : 0 // a brand opens on its first model, below the way back
    show()
  }
  const show = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length) entries = all().filter(p => words.every(w => `${p.name} ${p.group}`.toLowerCase().includes(w))).map(preset)
    else if (brand) entries = [{ label: '‹ All brands', hint: '', pick: open(null) }, ...all().filter(p => p.group === brand).map(preset)]
    else {
      entries = [...new Set(all().map(p => p.group))].map(b => ({
        label: b === 'yours' ? 'Yours' : b,
        hint: `${all().filter(p => p.group === b).length} ›`,
        pick: open(b),
      }))
    }
    active = Math.min(active, Math.max(0, entries.length - 1))
    list.replaceChildren(...entries.map((entry, i) => {
      const row = h('div', { className: 'preset' + (i === active ? ' active' : '') },
        h('span', { className: 'grow', textContent: entry.label }),
        h('span', { className: 'hint', textContent: entry.hint }))
      row.onmousedown = e => {
        e.preventDefault() // keep the field focused so the popup stays open
        if (!(e.target as Element).closest('.remove')) entry.pick()
      }
      if (entry.remove) {
        row.append(Object.assign(h('button', { className: 'icon remove', textContent: '✕', tip: 'Delete this preset' }), {
          onmousedown: (e: MouseEvent) => (e.preventDefault(), entry.remove!()),
        }))
      }
      return row
    }))
    list.children[active]?.scrollIntoView({ block: 'nearest' })
  }
  search.oninput = () => ((active = 0), show())
  search.onblur = () => ($('presets').hidden = true)
  search.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % Math.max(1, entries.length)
      show()
    } else if (e.key === 'Enter' && entries[active]) entries[active].pick()
    else if (e.key === 'Escape') search.blur()
    else return
    e.preventDefault()
  }
  const save = button('＋', 'Save the current case as your own preset (in this browser)', () => {
    const name = prompt('Name of the preset', search.value || 'My case')?.trim()
    if (!name) return
    const values = Object.fromEntries(CASE_KEYS.map(k => [k, project.box[k]])) as Record<CaseKey, number>
    saveUserPresets([...userPresets().filter(u => u.name !== name), { name, group: 'yours', values, unknown: [...project.box.unknown], user: true }])
  })
  save.className = 'icon'
  save.onmousedown = e => e.preventDefault() // keep the field focused so the popup stays open
  $('presets').replaceChildren(h('div', { className: 'row' }, search, save), list)
  const toggle = $('presets-button')
  toggle.onmousedown = e => e.preventDefault() // keep the field focused, so a click on the button can close the popup
  toggle.onclick = () => {
    if (!$('presets').hidden) return search.blur() // closes it
    $('presets').hidden = false
    search.value = ''
    open(null)()
    search.focus()
  }
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
    ),
  )
}

/** Export settings and buttons. */
function renderExport() {
  $('export').replaceChildren(
    h('div', { className: 'props' },
      prop('Label colour', color(() => project.labelColor, v => (project.labelColor = v)), 'Layer labels and object outlines in the exports; must differ from all material colours'),
      prop('Kerf', size(() => project.kerf, v => (project.kerf = v)), 'Width of the cut (laser beam, mill or knife); exported pieces grow by half of it so they come out at nominal size'),
    ),
    h('div', { className: 'row' },
      h('button', { textContent: 'SVG', tip: 'All layers side by side as one SVG in mm, ready for the laser', onclick: () => download('incase.svg', exportSvg(project, computeLayers(project)), 'image/svg+xml') }),
      h('button', { textContent: 'DXF', tip: 'Same as the SVG, as a DXF (R12, mm) with one layer per material', onclick: () => download('incase.dxf', exportDxf(project, computeLayers(project)), 'application/dxf') }),
      h('button', { textContent: 'PDF', tip: 'Printable 1:1 templates to cut by hand; large layers are split onto several sheets', onclick: pdfDialog }),
    ),
  )
}

/**
 * Trade-off slider for the auto stack; outside #stack so rebuilding the stack does not break a drag.
 * Quadratic from 0 to `max` mm, so small values (where most of the effect is) get most of the travel.
 */
function renderStackWeight(max = 50) {
  const slider = input('range', () => String(Math.sqrt((project.layerCost ?? LAYER_COST) / max)), el => {
    project.layerCost = max * el.valueAsNumber ** 2
    changed()
  })
  Object.assign(slider, { min: '0', max: '1', step: '0.01', className: 'grow' })
  $('stack-weight').replaceChildren(
    h('span', { className: 'hint', textContent: 'Exact fit' }),
    slider,
    h('span', { className: 'hint', textContent: 'Fewer layers' }),
  )
}

function renderStack() {
  const { stack, materials, box } = project
  $('stack-weight').hidden = !project.stackAuto
  const manual = (action: () => void) => () => {
    action()
    project.stackAuto = false
  }
  let z = 0
  const rows = stack.map((id, i) => {
    const m = materials.find(m => m.id === id)!
    const a = z
    z += m.thickness
    const label = (o: Material) => `${o.name} (${fmtLen(o.thickness)} ${unit()})`
    const picker = () => {
      const select = h('select', { className: 'grow' }, ...materials.map(o => h('option', { value: o.id, textContent: label(o) })))
      select.value = id
      select.onchange = () => {
        manual(() => (stack[i] = select.value))()
        changed()
      }
      return select
    }
    // clicking a row shows that layer in the top view
    const showLayer = (e: MouseEvent) => {
      if ((e.target as Element).closest('select, button, .grip')) return
      layerIndex = i
      scheduleViews()
    }
    return h('div', { className: 'row sortable', onclick: showLayer },
      // the auto stack picks and orders the materials itself; the empty span keeps the columns
      project.stackAuto ? h('span') : dragHandle((from, to) => (move(stack, from, to), (project.stackAuto = false), changed())),
      h('span', { className: 'swatch', style: `background:${m.color}` }),
      h('span', { className: 'idx', textContent: String(i + 1), tip: 'Layer number, counted from the top (as on the export labels)' }),
      project.stackAuto ? h('span', { className: 'grow', textContent: label(m) }) : picker(),
      h('span', { className: 'hint range', textContent: `${fmtLen(a)}–${fmtLen(z)}`, tip: 'Depth range of this layer, measured from the foam top' }),
      ...(project.stackAuto ? [] : [iconButton('✕', '', manual(() => stack.splice(i, 1)))]),
    )
  })
  $('stack-head').replaceChildren(
    h('span', {
      className: 'total' + (z > box.depth + 0.01 ? ' off' : ''),
      textContent: `Inner height ${fmtLen(box.depth)} · stack ${fmtLen(z)} ${unit()}`,
      tip: 'A stack lower than the case is fine (it rests on the floor); a taller one does not fit',
    }),
    h('span', { className: 'grow' }),
    Object.assign(
      button('Auto stack', 'When on, the stack builds itself from the material list and the objects and stays updated; editing a layer turns it off', () => (project.stackAuto = !project.stackAuto)),
      { className: 'toggle' + (project.stackAuto ? ' active' : '') },
    ),
  )
  $('stack').replaceChildren(
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

/** New item with the sizes of the last edited one, added to the project. */
function createItem(shape: Shape) {
  const top = project.materials.find(m => m.id === project.stack[0])
  const it = { ...defaultItem(shape, `${SHAPES[shape]} ${project.items.length + 1}`, (project.items.length % 8) * 10, top?.thickness ?? 30), ...template }
  project.items.push(it)
  return it
}

function addItem(shape: Shape) {
  select(createItem(shape).id)
}

function startPolygon() {
  select(null)
  view2d.startDrawing()
  updateChrome()
}

/** Turns drawn corner points (plan coordinates) into a polygon object centred on their bounding box. */
function createPolygon(points: { x: number; y: number }[]) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2
  const top = project.materials.find(m => m.id === project.stack[0])
  const it = { ...defaultItem('polygon', `Polygon ${project.items.length + 1}`, 0, top?.thickness ?? 30), ...template, x, y, r: 0 }
  it.pts = points.map(p => ({ x: p.x - x, y: p.y - y }))
  project.items.push(it)
  select(it.id)
}

function duplicate(it: Item) {
  const copy = { ...structuredClone(it), id: uid(), name: `${it.name} copy`, x: it.x + 10, y: it.y + 10 }
  project.items.push(copy)
  select(copy.id)
}

// --- dialog: locks the UI; Esc closes it ---

/** Opens the dialog with the given content and focuses its first button (so Enter presses it). */
function openDialog(...children: (Node | string)[]) {
  const box = $('dialog-box')
  box.replaceChildren(...children)
  $('dialog').hidden = false
  box.querySelector<HTMLElement>('button.primary')?.focus() // Enter presses the main button, if there is one
}

function closeDialog() {
  arranging?.terminate()
  arranging = null
  giveBack()
  $('dialog').hidden = true
}

// panels the guided setup shows inside the dialog; they go back to their place when it closes
let borrowed: [Element, ParentNode, Node | null][] = []

function borrow(...ids: string[]) {
  return ids.map(id => {
    const el = $(id)
    borrowed.push([el, el.parentNode!, el.nextSibling])
    return el
  })
}

function giveBack() {
  // the old neighbour may be gone if the panel was re-rendered meanwhile
  for (const [el, parent, next] of borrowed.reverse()) parent.insertBefore(el, next?.parentNode === parent ? next : null)
  borrowed = []
}

const isBorrowed = (id: string) => borrowed.some(([el]) => el.id === id)

const SETUP_STEPS = ['Case', 'Materials & stack', 'Objects']

/** Starts a new project and walks through case, materials and objects, then arranges evenly. */
function guidedSetup() {
  project = newProject()
  selectedId = null
  renderAll()
  const step = (i: number) => {
    giveBack()
    const content =
      i === 0 ? [hint('Measure the inside of your case or pick a preset; everything else starts with defaults.'), caseQuick()]
      : i === 1 ? [hint('The foam sheets you have; the stack fills the case depth on its own.'), ...borrow('materials', 'stack')]
      : [hint('One line per object: name, type and size. Position and rotation are left to auto-arrange.'), objectTable()]
    const next = i < 2
      ? h('button', { className: 'primary', textContent: 'Next', onclick: () => step(i + 1) })
      : h('button', { className: 'primary', textContent: 'Done', tip: 'Close and arrange the objects evenly', onclick: () => {
          closeDialog()
          if (project.items.length) arrange(true)
        } })
    openDialog(h('div', { className: 'dialog-form wizard' },
      h('h3', { textContent: `Step ${i + 1} of ${SETUP_STEPS.length} · ${SETUP_STEPS[i]}` }),
      ...content,
      h('div', { className: 'row' }, i ? h('button', { textContent: 'Back', onclick: () => step(i - 1) }) : '', h('span', { className: 'grow' }), next),
    ))
  }
  step(0)
}

const hint = (text: string) => h('p', { className: 'hint', textContent: text })

/** Guided setup, step 1: only the inner size, depth and lid (straight walls), plus the presets. */
function caseQuick() {
  const b = project.box
  const straight = (top: 'topL' | 'topW', bottom: 'bottomL' | 'bottomW') => (v: number) => {
    b[top] = b[bottom] = v
    b.unknown = b.unknown.filter(k => k !== top && k !== bottom)
  }
  return h('div', { className: 'props' },
    prop('Length', size(() => b.topL, straight('topL', 'bottomL')), 'Inner length of the case'),
    prop('Width', size(() => b.topW, straight('topW', 'bottomW')), 'Inner width of the case'),
    prop('Depth', size(() => b.depth, v => (b.depth = v)), 'Inner depth of the case base'),
    prop('Lid depth', size(() => b.lidDepth, v => (b.lidDepth = v)), 'Inner depth of the lid'),
    ...borrow('preset-picker'),
  )
}

/** Size each quick-entry column sets per shape ('' = not used): L / Ø, W, H. */
const QUICK_COLUMNS: Record<Shape, (Dim | '')[]> = {
  box: ['l', 'w', 'h'], cylinder: ['d', '', 'h'], lying: ['l', '', 'd'], sphere: ['d', '', ''], polygon: ['', '', 'h'],
}

/** Quick entry of objects: one row each (name, type, sizes); a new empty row appears once the last one is used. */
function objectTable() {
  const table = h('div', { className: 'object-table' },
    ...['Name', 'Type', 'L / Ø', 'W', 'H', ''].map(textContent => h('span', { className: 'hint', textContent })))
  const toMm = (v: number) => (inches ? v * MM_PER_IN : v)

  const row = (existing?: Item) => {
    let it = existing
    const type = h('select', {}, ...Object.values(SHAPE_KEYS).map(shape => h('option', { value: shape, textContent: SHAPES[shape] })))
    type.value = it?.shape ?? 'box'
    // the empty last row becomes an object as soon as something is entered
    const use = () => {
      if (!it) {
        it = createItem(type.value as Shape)
        if (!name.value) name.value = it.name
        remove.hidden = false
        table.append(row())
      }
      return it
    }
    const name = h('input', { type: 'text', value: it?.name ?? '', placeholder: 'Name' })
    name.oninput = () => {
      use().name = name.value
      changed('items')
    }
    const sizes = QUICK_COLUMNS.box.map((_, col) => {
      const el = h('input', { type: 'number', step: 'any', min: '0' })
      el.oninput = () => {
        const key = QUICK_COLUMNS[type.value as Shape][col]
        if (!key || !Number.isFinite(el.valueAsNumber)) return
        const item = use()
        item[key] = toMm(Math.max(0, el.valueAsNumber))
        remember(item)
        changed()
      }
      return el
    })
    const showSizes = () => QUICK_COLUMNS[type.value as Shape].forEach((key, col) => {
      sizes[col].disabled = !key
      sizes[col].value = key && it ? fmtLen(it[key]) : ''
    })
    type.onchange = () => {
      if (it) it.shape = type.value as Shape
      showSizes()
      changed('items')
    }
    const remove = h('button', { className: 'icon', textContent: '✕', hidden: !it, onclick: () => {
      project.items = project.items.filter(o => o !== it)
      line.remove()
      changed('items', 'selection')
    } })
    showSizes()
    const line = h('div', { className: 'object-row' }, name, type, ...sizes, remove)
    return line
  }

  table.append(...project.items.map(row), row())
  return table
}

const errorDialog = (text: string) =>
  openDialog(h('span', { className: 'error', textContent: text }), h('button', { className: 'primary', textContent: 'OK', onclick: closeDialog }))

// runs in a worker while the dialog shows a spinner; aborting discards the result
let arranging: Worker | null = null

function arrange(even: boolean) {
  if (arranging) return
  const worker = (arranging = new Worker(new URL('./arrange.worker.ts', import.meta.url), { type: 'module' }))
  openDialog(
    h('div', { className: 'spinner' }),
    h('span', { textContent: even ? 'Arranging evenly…' : 'Packing tightly…' }),
    h('button', { textContent: 'Abort', tip: 'Stop and keep the old arrangement (Esc)', onclick: closeDialog }),
  )
  worker.onmessage = (e: MessageEvent<ArrangeResult>) => {
    const { failed, placements } = e.data
    closeDialog()
    for (const { id, ...at } of placements) Object.assign(project.items.find(it => it.id === id)!, at)
    changed()
    if (failed) errorDialog(`${failed} of ${project.items.length} objects don't fit into the case with a min. wall of ${fmtLen(project.box.minWall)} ${unit()}; they were left where they were.`)
  }
  worker.postMessage({ project, even })
}

/** Asks for the paper size, then downloads the printable templates. */
function pdfDialog() {
  let paper = ''
  const custom = PAPERS.A4.map(v => h('input', { type: 'number', min: '50', value: String(v) }))
  const customRow = h('div', { className: 'row center', hidden: true }, 'Width × height', ...custom, 'mm')
  const exportButton = h('button', { className: 'primary', textContent: 'Export', disabled: true, onclick: () => {
    const size = paper === 'Custom' ? (custom.map(el => el.valueAsNumber) as [number, number]) : PAPERS[paper]
    if (!(size[0] >= 50 && size[1] >= 50)) return
    closeDialog()
    download('incase.pdf', exportPdf(project, computeLayers(project), size))
  } })
  const choice = h('div', { className: 'seg' })
  segmented(choice, [...Object.keys(PAPERS), 'Custom'].map((name): [string, string, string] => [name, name, '']), () => paper, v => {
    paper = v
    customRow.hidden = v !== 'Custom'
    exportButton.disabled = false
  })
  openDialog(h('div', { className: 'dialog-form' },
    h('h3', { textContent: 'Print templates (PDF)' }),
    h('p', { className: 'hint', textContent: 'Choose the paper. Layers larger than a sheet are split onto several overlapping sheets with alignment crosses.' }),
    h('div', { className: 'row center' }, choice),
    customRow,
    h('div', { className: 'row' }, h('span', { className: 'grow' }), h('button', { textContent: 'Cancel', onclick: closeDialog }), exportButton),
  ))
}

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
    if (it.shape === 'polygon' && !it.pts.length) it.pts = boxCorners(it)
    changed('items', 'selection')
  }
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
      prop('Fit', len(() => it.fit, v => ((it.fit = v), remember(it))), 'How much bigger (+, loose) or smaller (−, tight grip) the cutout is than the object; new objects take the last value you set'),
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
    diff > 0.01 && `Stack is ${fmtLen(diff)} ${unit()} taller than the case`,
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

function download(name: string, content: string | Blob, type = '') {
  const href = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }))
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
$('setup').onclick = guidedSetup

segmented($('units'), [['mm', 'mm', ''], ['in', 'in', 'Projects and exports stay in mm']], () => unit(), v => {
  inches = v === 'in'
  setPref('units', v)
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
  scheduleViews() // line colours are checked against the new background
}

// --- viewports ---

const view2d = new View2D($('view2d'), { select, change: () => changed(), len: mm => `${fmtLen(mm)} ${unit()}`, violation, createPolygon })
view2d.snapStep = Number(pref('grid') ?? 5)
const showGrid = (on: boolean) => {
  view2d.snap = on
  $('grid-field').hidden = !on // the grid size is only asked for while snapping
}
for (const [key, apply] of [['snap', showGrid], ['constrain', (on: boolean) => (view2d.constrain = on)]] as const) {
  const box = $(key) as HTMLInputElement
  box.checked = pref(key) === '1'
  apply(box.checked)
  box.onchange = () => {
    setPref(key, box.checked ? '1' : '0')
    apply(box.checked)
    scheduleViews()
  }
}

/** Grid size field next to "Snap to grid", in the display unit. */
function renderGridField() {
  $('grid-field').replaceChildren(prop(unit(), size(() => view2d.snapStep, v => {
    view2d.snapStep = Math.max(0.1, v)
    setPref('grid', String(view2d.snapStep))
  }), 'Grid size: snap step and the grid drawn in the top view'))
}
let renderCamera = () => {} // the Ortho | Persp switch, set up below
const view3d = new View3D($('view3d'), select, () => renderCamera())
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
renderCamera = segmented($('camera'), [['ortho', 'Ortho', 'Orthographic: no perspective distortion, sizes compare directly'], ['persp', 'Persp', '']], () => (view3d.isOrthographic ? 'ortho' : 'persp'), v => {
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
  tool('polygon', 'Polygon: click its corners in the top view (P)', startPolygon),
  h('hr'),
  duplicateTool,
  deleteTool,
  tool('even', 'Arrange evenly: largest equal gaps, centred (A)', () => arrange(true)),
  tool('pack', 'Pack tightly at the min. wall, centred (⇧A)', () => arrange(false)),
  h('hr'),
  undoTool,
  redoTool,
)
$('fit-3d').replaceWith(Object.assign(tool('fit', 'Fit the case into the 3D view (F)', () => view3d.fit()), { id: 'fit-3d' }))

function updateChrome() {
  const it = selected()
  duplicateTool.disabled = deleteTool.disabled = !it
  undoTool.disabled = !history.canUndo
  redoTool.disabled = !history.canRedo
  $('hint').textContent = view2d.isDrawing
    ? 'Click to add corners · click the first one, double-click or Enter to finish · Backspace removes the last · Esc cancels'
    : it
    ? 'Drag to move · drag handle to rotate (Shift 15°) · arrows nudge (Shift ×10) · Del delete · ⌘D duplicate · Esc deselect · ⌘Z undo'
    : 'B C L S add · Tab next object under the click · A arrange evenly, ⇧A pack · F fit 3D · PgUp / PgDn layer · 1 / 2 / 3 layout · wheel zoom, drag background to pan · drag a field label to scrub · ⌘Z undo'
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
  renderGridField()
  renderCase()
  presetPicker()
  renderExport()
  renderStackWeight()
  changed('materials', 'items', 'selection')
}

addEventListener('keydown', e => {
  if (!$('dialog').hidden) {
    if (e.key === 'Escape') closeDialog()
    // keys go only to the dialog's own fields and buttons
    if (e.key === 'Escape' || !$('dialog').contains(e.target as Node)) e.preventDefault()
    return
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  const key = e.key.toLowerCase()
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey
  const it = selected()
  const step = (view2d.snap ? view2d.snapStep : 1) * (e.shiftKey ? 10 : 1)
  const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  const mod = e.metaKey || e.ctrlKey
  if (view2d.isDrawing) {
    if (e.key === 'Enter') view2d.finishDrawing()
    else if (e.key === 'Escape') view2d.cancelDrawing()
    else if (e.key === 'Backspace') view2d.undoPoint()
    else return
    updateChrome()
    return e.preventDefault()
  }
  if (mod && key === 'z') restore(e.shiftKey ? history.redo() : history.undo())
  else if (mod && key === 'y') restore(history.redo())
  else if (plain && SHAPE_KEYS[key]) addItem(SHAPE_KEYS[key])
  else if (plain && key === 'a') arrange(!e.shiftKey)
  else if (plain && key === 'p') startPolygon()
  else if (plain && key === 'f') view3d.fit()
  else if (e.key === 'PageUp' || e.key === 'PageDown') stepLayer(e.key === 'PageUp' ? -1 : 1)
  else if (e.key === 'Tab') view2d.cycle(e.shiftKey ? -1 : 1)
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
  } else if (it && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (!view2d.deleteVertex()) remove(it)
  }
  else if (it && e.key === 'Escape') select(null)
  else if (it && (e.metaKey || e.ctrlKey) && key === 'd') duplicate(it)
  else return
  e.preventDefault()
})

renderAll()
