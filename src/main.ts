import './style.css'
import type { ArrangeResult } from './arrange'
import { alignItems, AREA_TOL, computeLayers, resting, wallConflicts, wallViolations, stackTotal, type Align, type Layer } from './geometry'
import { exportDxf, exportSvg } from './export'
import { History } from './history'
import { exportPdf, PAPERS } from './pdf'
import { PRESETS, saveUserPresets, userPresets, type Preset } from './presets'
import { boxCorners, copyProject, currentName, defaultItem, deleteProject, itemHeight, LAYER_COST, loadProject, nameProject, newProject, parseProject, projectNames, normalize, renameProject, resetUnsaved, saveProject, storedCase, storedProject, unsavedEmpty, setNotchCount, sharedPart, suggestStack, uid, uniqueName, type CaseDims, type CaseKey, type Dim, type Item, type Material, type Project, type SheetPlacement, type Shape } from './model'
import { planSheets, type Piece, type Sheet } from './sheets'
import { View2D } from './view2d'
import { View3D } from './view3d'
import { SheetView } from './viewSheets'

type Section = 'case' | 'materials' | 'export' | 'items' | 'selection'
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
    ['Width', 'd2', "Size along the object's own Y axis (before rotation); equal to the length = round"],
    ['Length', 'd', "Size along the object's own X axis (before rotation); the width follows while both are equal"],
    ['Depth', 'h', 'Height of the cylinder, i.e. how deep it sinks into the foam'],
  ],
  lying: [
    ['Length', 'l', ''],
    ['Diameter', 'd', 'Diameter of the lying cylinder; also how deep it sinks into the foam'],
  ],
  sphere: [
    ['Width', 'd2', "Size along the object's own Y axis (before rotation); equal to the length = round"],
    ['Length', 'd', "Size along the object's own X axis (before rotation); the width follows while both are equal. Its height is the smaller of both; the cut stays full width above its centre so it can be lifted out"],
  ],
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
  align: '<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>',
  left: '<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>',
  centerX: '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>',
  right: '<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4" rx="1"/><rect x="10" y="14" width="7" height="4" rx="1"/>',
  top: '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12" rx="1"/><rect x="14" y="7" width="4" height="7" rx="1"/>',
  centerY: '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>',
  bottom: '<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12" rx="1"/><rect x="14" y="10" width="4" height="7" rx="1"/>',
  distributeX: '<path d="M3 4v16M21 4v16"/><rect x="6" y="8" width="3" height="8" rx="1"/><rect x="15" y="8" width="3" height="8" rx="1"/><rect x="10.5" y="8" width="3" height="8" rx="1"/>',
  distributeY: '<path d="M4 3h16M4 21h16"/><rect x="8" y="6" width="8" height="3" rx="1"/><rect x="8" y="15" width="8" height="3" rx="1"/><rect x="8" y="10.5" width="8" height="3" rx="1"/>',
  first: '<rect x="3" y="3" width="10" height="10" rx="1"/><rect x="11" y="11" width="10" height="10" rx="1" stroke-dasharray="2 2"/><path d="M8 8l8 8"/>',
  chain: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  chainBroken: '<path d="M15 9l3-3a3 3 0 0 0-4.2-4.2l-3 3M9 15l-3 3a3 3 0 0 0 4.2 4.2l3-3M4 8h3M8 4v3M20 16h-3M16 20v-3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>',
}
const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`
const MM_PER_IN = 25.4
const CASE_KEYS: CaseKey[] = ['topL', 'topW', 'bottomL', 'bottomW', 'depth', 'lidDepth', 'radius', 'bottomRadius']

// per-viewer UI preferences
const pref = (key: string) => localStorage.getItem(`incase.${key}`)
const setPref = (key: string, value: string) => localStorage.setItem(`incase.${key}`, value)

let project: Project = loadProject()
let selection: string[] = [] // selected item ids, in the order they were selected
let layerIndex = 0 // layer shown in the top view, 0 = topmost
let inches = pref('units') === 'in' // display only, the model is always mm
let history = new History(JSON.stringify(project))

const $ = (id: string) => document.getElementById(id)!
/** Display format: at most 4 decimals. */
const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)
const fmtLen = (mm: number) => fmt(inches ? mm / MM_PER_IN : mm)
const unit = () => (inches ? 'in' : 'mm')
/** The selected item if exactly one is selected. */
const selected = () => (selection.length === 1 ? project.items.find(it => it.id === selection[0]) : undefined)
const selectedItems = () => selection.map(id => project.items.find(it => it.id === id)!)

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

const color = (get: () => string, set: (v: string) => void, ...rebuild: Section[]) =>
  input('color', get, el => {
    set(el.value)
    changed(...rebuild)
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

/** Labelled checkbox; `set` gets the new state, then the listed panels are rebuilt. */
const checkbox = (label: string, tip: string, checked: boolean, set: (on: boolean) => void, ...rebuild: Section[]) =>
  h('label', { className: 'check', tip }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => (set((e.target as HTMLInputElement).checked), changed(...rebuild)) }), label)

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

const renderers: Record<Section, () => void> = { case: renderCase, materials: renderMaterials, export: renderExport, items: renderItems, selection: renderSelection }

/** Call after every model change; rebuilds the listed panels (structural changes), the rest is synced in place. */
function changed(...rebuild: Section[]) {
  if (project.stackAuto) project.stack = suggestStack(project.materials, project.box.depth, project.items.map(it => it.z + itemHeight(it)), project.layerCost)
  for (const s of new Set(rebuild)) renderers[s]()
  renderStack()
  renderPresetName()
  renderProjects()
  syncInputs()
  history.record(() => JSON.stringify(project))
  updateChrome()
  saveProject(project)
  scheduleViews()
}

let taperedOn = false // keeps the bottom fields open while they still equal the top

function renderCase() {
  const b = project.box
  const tapered = taperedOn || b.bottomL !== b.topL || b.bottomW !== b.topW
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
  const wide = <T extends HTMLElement>(el: T) => (el.classList.add('wide'), el)
  $('case').replaceChildren(
    field('L', 'topL', 'Inner length of the case at the top opening (the bottom follows while both are equal)', linked('topL', 'bottomL')),
    field('W', 'topW', 'Inner width of the case at the top opening (the bottom follows while both are equal)', linked('topW', 'bottomW')),
    field('H', 'depth', 'Inner depth of the case; the foam stack rests on its floor'),
    field('Corner rad.', 'radius', 'Corner radius of the case seen from above'),
    field('Bottom rad.', 'bottomRadius', 'Radius where the floor meets the walls; makes the lowest layers smaller'),
    field('Lid depth', 'lidDepth', 'Inner depth of the lid; case depth + lid depth is the tallest anything may reach'),
    ...(isBorrowed('preset-picker') ? [] : [$('preset-picker')]),
    wide(checkbox('Tapered walls', 'Walls lean inwards: the floor is smaller than the top opening', tapered, on => {
      taperedOn = on
      if (on) return
      b.bottomL = b.topL
      b.bottomW = b.topW
      b.unknown = b.unknown.filter(k => k !== 'bottomL' && k !== 'bottomW')
    }, 'case')),
    ...(tapered ? [h('div', { className: 'row wide' },
      field('Bottom L', 'bottomL', 'Inner length at the floor; smaller than the top for tapered walls', v => {
        if (!b.taperFree) b.bottomW = Math.max(0, b.topW - (b.topL - v))
        b.bottomL = v
      }),
      h('button', {
        className: 'icon chain', innerHTML: icon(b.taperFree ? 'chainBroken' : 'chain'),
        tip: b.taperFree ? 'Bottom L and W are set separately · click to keep them at the same taper' : 'Changing one bottom size keeps the same taper on all sides · click to set them separately',
        onclick: () => ((b.taperFree = !b.taperFree), changed('case')),
      }),
      field('Bottom W', 'bottomW', 'Inner width at the floor; smaller than the top for tapered walls', v => {
        if (!b.taperFree) b.bottomL = Math.max(0, b.topL - (b.topW - v))
        b.bottomW = v
      }),
    )] : []),
  )
}

/** "Brand - model" (model names are unique only within a brand); your own presets by their name. */
const presetLabel = (p: Preset) => (p.user ? p.name : `${p.group} - ${p.name}`)

/** The preset the case was filled from, as long as no case size was changed since; '' if none. */
function casePreset(box: CaseDims) {
  const p = [...userPresets(), ...PRESETS].find(p => presetLabel(p) === box.preset)
  return p && CASE_KEYS.every(k => box[k] === p.values[k]) ? presetLabel(p) : ''
}

/** Shows the applied preset next to the Case title. */
const renderPresetName = () => ($('case-preset').textContent = casePreset(project.box))

/** The case by its preset, else by its inner size. */
const caseName = (box: CaseDims) => casePreset(box).replace(' - ', ' · ') || `${fmtLen(box.topL)}×${fmtLen(box.topW)}×${fmtLen(box.depth)} ${unit()}`

/**
 * Presets popup: pick a brand, then a model (Enter or click applies it, undoable); typing searches all brands.
 */
function presetPicker() {
  const search = h('input', { type: 'text', className: 'grow', placeholder: 'Search, e.g. Peli 1500 or 600×400' })
  withTip(search, 'Fills in the case from a preset. Peli is a trademark of Pelican Products, Inc.; RAKO of Georg Utz; not affiliated')
  const list = h('div', { className: 'preset-list' })
  type Entry = { label: string; hint: string; pick: () => void; remove?: () => void; web?: string }
  const SEARCH_AS: Record<string, string> = { Peli: 'pelicase' } // brand as people search for it
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
    web: p.user ? undefined : `https://www.google.com/search?${new URLSearchParams({ q: `${SEARCH_AS[p.group] ?? p.group} ${p.name}` })}`,
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
        h('span', { className: 'hint', textContent: entry.hint }),
        ...(entry.web ? [h('a', { className: 'web', href: entry.web, target: '_blank', rel: 'noopener', innerHTML: icon('globe'), tip: 'Search the web for this case' })] : []))
      row.onmousedown = e => {
        e.preventDefault() // keep the field focused so the popup stays open
        if (!(e.target as Element).closest('.remove, .web')) entry.pick()
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
    $('presets').style.top = `${toggle.offsetTop + toggle.offsetHeight + 4}px` // right below the button, wherever it sits in the grid
    search.value = ''
    open(null)()
    search.focus()
  }
}

function renderMaterials() {
  const ms = project.materials
  const nextColor = () => PALETTE.find(c => c !== project.labelColor && c !== project.outlineColor && !ms.some(m => m.color === c)) ?? '#808080'
  $('materials').replaceChildren(
    ...ms.map((m, i) =>
      h('div', { className: 'row sortable' },
        dragHandle((from, to) => (move(ms, from, to), changed('materials'))),
        withTip(color(() => m.color, v => (m.color = v), 'export'), 'Cut line colour of this material in the exported SVG'),
        withTip(Object.assign(text(() => m.name, v => (m.name = v), 'export'), { className: 'grow' }), 'Material name, shown on the layer labels'),
        prop(unit(), size(() => m.thickness, v => (m.thickness = v)), 'Sheet thickness', 'short'),
        iconButton('✕', 'Also removes its layers from the stack', () => {
          ms.splice(i, 1)
          project.stack = project.stack.filter(id => id !== m.id)
        }, 'materials'),
      ),
    ),
    h('div', { className: 'row' },
      button('+ Material', 'Starts with the sheet sizes of the first material that has any', () => {
        const sheets = structuredClone(ms.find(m => m.sheets?.some(s => s.w && s.h))?.sheets)
        ms.push({ id: uid(), name: `Foam ${ms.length + 1}`, thickness: 5, color: nextColor(), sheets })
      }, 'materials'),
      h('span', { className: 'grow' }),
      prop('Min. wall', size(() => project.box.minWall, v => (project.box.minWall = v)), 'Minimum material wall thickness: the least foam left between any two cutouts and between a cutout and the case wall', 'short'),
    ),
  )
  renderExport() // lists the materials
}

/**
 * The stock sheet sizes of a material: its name with + to add a size, then one row per size (W, H, count in stock;
 * an empty row while it has none = no limit). A value entered in the first row is filled in for the materials that
 * have only that one row with it empty.
 */
function sheetSizes(m: Material) {
  const rows = () => (m.sheets?.length ? m.sheets : (m.sheets = [{ w: 0, h: 0 }]))
  const field = (i: number, key: 'w' | 'h', label: string, tip: string) => {
    const el = input('number', () => (m.sheets?.[i]?.[key] ? fmtLen(m.sheets[i][key]) : ''), el => {
      rows()[i][key] = el.valueAsNumber > 0 ? (inches ? el.valueAsNumber * MM_PER_IN : el.valueAsNumber) : 0
      changed()
    })
    el.min = '0'
    el.placeholder = '∞'
    if (!i) {
      el.onchange = () => {
        for (const o of project.materials) if (!o.sheets || o.sheets.length <= 1) (o.sheets ??= [{ w: 0, h: 0 }])[0][key] ||= rows()[0][key]
        changed()
      }
    }
    return prop(label, el, tip, 'short')
  }
  const count = (i: number) => {
    const el = input('number', () => String(m.sheets?.[i]?.count ?? ''), el => {
      rows()[i].count = el.valueAsNumber >= 1 ? Math.round(el.valueAsNumber) : undefined
      changed()
    })
    Object.assign(el, { min: '1', step: '1', placeholder: '∞' })
    return prop('×', el, 'How many of these sheets you have; empty = as many as needed', 'count')
  }
  const sizes = m.sheets?.length ? m.sheets : [null]
  return [
    h('div', { className: 'row' },
      h('span', { className: 'swatch', style: `background:${m.color}` }),
      h('span', { className: 'grow', textContent: m.name }),
      iconButton('+', 'Add another sheet size; the smallest one a layer fits on (and still in stock) is used first', () => rows().push({ w: 0, h: 0 }), 'export'),
    ),
    ...sizes.map((_, i) => h('div', { className: 'row size' },
      field(i, 'w', 'W', `Width of these ${m.name} sheets${i ? '' : '; entering it fills it in for materials without one'}`),
      field(i, 'h', 'H', `Height of these ${m.name} sheets${i ? '' : '; entering it fills it in for materials without one'}`),
      count(i),
      sizes.length > 1 ? iconButton('✕', 'Remove this sheet size', () => m.sheets!.splice(i, 1), 'export') : h('span', { className: 'icon-space' }),
    )),
  ]
}

/** Export settings and buttons. */
function renderExport() {
  $('export').replaceChildren(
    h('div', { className: 'row' },
      checkbox('Labels', 'Layer labels on the sheets and in the exports', project.showLabels, on => (project.showLabels = on)),
      withTip(color(() => project.labelColor, v => (project.labelColor = v)), 'Colour of the labels; must differ from all material colours'),
    ),
    h('div', { className: 'row' },
      checkbox('Object outlines', 'Outlines of the objects themselves (for engraving or orientation) on the sheets and in the exports', project.showOutlines, on => (project.showOutlines = on)),
      withTip(color(() => project.outlineColor, v => (project.outlineColor = v)), 'Colour of the object outlines and sheet frames, also in the top view; must differ from all material colours'),
    ),
    h('div', { className: 'props' },
      prop('Kerf', size(() => project.kerf, v => (project.kerf = v)), 'Width of the cut (laser beam, mill or knife); exported pieces grow by half of it so they come out at nominal size'),
    ),
    h('h4', { textContent: 'Sheet sizes', tip: 'Sizes of your stock sheets per material (laser, CNC, waterjet …); the layers are laid out on them, keeping the min. wall apart. Empty = no limit' }),
    ...project.materials.flatMap(sheetSizes),
    h('h4', { textContent: 'Export sheets' }),
    h('div', { className: 'row' },
      h('button', { className: 'primary', textContent: 'SVG', tip: 'All layers on the stock sheets of their material, as one SVG in mm', onclick: () => download('incase.svg', exportSvg(project, computeLayers(project), true), 'image/svg+xml') }),
      h('button', { className: 'primary', textContent: 'DXF', tip: 'Same as the SVG, as a DXF (R12, mm) with one layer per foam layer', onclick: () => download('incase.dxf', exportDxf(project, computeLayers(project), true), 'application/dxf') }),
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

/** `starMm`: mm of misfit (objects off a layer top, stack short of the case) that cost one of the 5 stars. */
function renderStack(starMm = 5) {
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
  Object.assign($('stack-total'), {
    className: z > box.depth + 0.01 ? 'total off' : '',
    textContent: `Inner height ${fmtLen(box.depth)} · stack ${fmtLen(z)} ${unit()}`,
  })
  // how far each object's cut misses a layer boundary, and the stack the case depth
  const off = project.items.map(it => ({ name: it.name, d: Math.abs(resting(project, it).z - it.z) })).filter(o => o.d > 0.01)
  const worst = off.reduce((w, o) => (o.d > w.d ? o : w), { name: '', d: 0 })
  const short = box.depth - z
  const total = off.reduce((sum, o) => sum + o.d, 0)
  const misses = [
    off.length && `objects off by ${fmtLen(total)} ${unit()} in total (most: ${worst.name}, ${fmtLen(worst.d)})`,
    short > 0.01 && `stack ${fmtLen(short)} ${unit()} short of the case depth`,
  ].filter(Boolean)
  const score = Math.max(0, 5 - Math.floor((total + (short > 0.01 ? short : 0)) / starMm))
  $('stack-head').replaceChildren(
    h('span', { tip: `Fit ${score}/5: ${misses.length ? misses.join(' · ') : 'every object sits right on a layer top and the stack fills the case'}. One star less per ${fmtLen(starMm)} ${unit()} off` },
      'Stack fit: ', h('span', { id: 'stack-score' }, ...[0, 1, 2, 3, 4].map(i => h('span', { className: i < score ? '' : 'miss', textContent: '★' })))),
    h('span', { className: 'grow' }),
    checkbox('Auto stack', 'When on, the stack builds itself from the material list and the objects and stays updated; editing a layer turns it off', project.stackAuto, on => (project.stackAuto = on)),
  )
  $('stack').replaceChildren(
    ...rows,
    ...(project.stackAuto ? [] : [button('+ Layer', "Adds it at the bottom, using the last layer's material", manual(() => materials.length && stack.push(stack.at(-1) ?? materials[0].id)))]),
  )
}

function renderItems() {
  if (!project.items.length) return $('items').replaceChildren(h('span', { className: 'hint', textContent: 'Add objects with the tools on the left (B, C, L, S).' }))
  $('items').replaceChildren(
    ...project.items.map(it =>
      h('button', { className: selection.includes(it.id) ? 'selected' : '', onclick: (e: MouseEvent) => select(it.id, e.shiftKey) },
        h('span', { innerHTML: icon(it.shape) }),
        h('span', { className: 'grow', textContent: it.name }),
        h('span', { className: 'hint', textContent: SHAPES[it.shape] }),
      ),
    ),
  )
}

/** Selects only `id` (null: nothing); `add` (Shift-click) adds it to the selection or removes it. */
function select(id: string | null, add = false) {
  selection = !id ? [] : !add ? [id] : selection.includes(id) ? selection.filter(s => s !== id) : [...selection, id]
  changed('items', 'selection')
}

// sizes of the last edited object; new objects start with them
const INHERITED = ['l', 'w', 'h', 'd', 'd2', 'r', 'fit', 'notchD', 'notchDepth', 'notchR'] as const
let template: Partial<Item> = {}
const remember = (it: Item) => (template = Object.fromEntries(INHERITED.map(k => [k, it[k]])))

/** Sets a size; the second diameter follows the first while both are equal (round stays round). */
function setDim(it: Item, k: Dim, v: number) {
  if (k === 'd' && it.d2 === it.d) it.d2 = v
  it[k] = v
  remember(it)
}

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

/** Copies the items 10 mm down right and selects the copies. */
function duplicate(items: Item[]) {
  const copies = items.map(it => ({ ...structuredClone(it), id: uid(), name: `${it.name} copy`, x: it.x + 10, y: it.y + 10 }))
  project.items.push(...copies)
  selection = copies.map(c => c.id)
  changed('items', 'selection')
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
  startNew()
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
  box: ['l', 'w', 'h'], cylinder: ['d', 'd2', 'h'], lying: ['l', '', 'd'], sphere: ['d', 'd2', ''], polygon: ['', '', 'h'],
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
        setDim(item, key, toMm(Math.max(0, el.valueAsNumber)))
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
  selection = selection.filter(id => project.items.some(it => it.id === id))
  renderAll()
}

function remove(items: Item[]) {
  project.items = project.items.filter(o => !items.includes(o))
  select(null)
}

function renderSelection() {
  const it = selected()
  $('selection-section').hidden = !selection.length
  if (selection.length > 1) {
    return $('selection').replaceChildren(h('p', { className: 'hint', textContent: `${selection.length} objects selected: drag, nudge, align, duplicate or delete them together; select one to edit it.` }))
  }
  if (!it) return $('selection').replaceChildren()

  const shape = h('select', {}, ...(Object.entries(SHAPES) as [Shape, string][]).map(([value, textContent]) => h('option', { value, textContent })))
  shape.value = it.shape
  shape.onchange = () => {
    it.shape = shape.value as Shape
    if (it.shape === 'polygon' && !it.pts.length) it.pts = boxCorners(it)
    changed('items', 'selection')
  }
  const dims = DIMS[it.shape]
  const dimProp = ([label, k, tip]: [string, Dim, string]) => prop(label, size(() => it[k], v => setDim(it, k, v)), tip)

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
    it.notches.length ? h('p', { className: 'hint', textContent: 'Drag the dots in the top view to move notches along the edge; Ctrl snaps them to the standard positions.' }) : '',
  )
}

const LID_MARGIN = 2 // mm; closer than this to the closed lid counts as touching

/** Warning if the item's top reaches the closed lid (case depth + lid depth above the floor), or comes very close. */
function lidWarning(it: Item) {
  const room = project.box.depth - stackTotal(project) + resting(project, it).z + project.box.lidDepth // from its top to the lid
  if (room < 0) return `${it.name} is ${fmtLen(-room)} ${unit()} too tall for case + lid`
  return room < LID_MARGIN && `${it.name} almost touches the lid (${fmtLen(room)} ${unit()} left)`
}

function renderWarnings(conflicts: Set<string>, sheets: Sheet[]) {
  const missing = new Map<string, number>()
  for (const s of sheets.filter(s => s.missing)) {
    const what = `${s.material.name} sheets of ${fmtLen(s.w)} × ${fmtLen(s.h)} ${unit()}`
    missing.set(what, (missing.get(what) ?? 0) + 1)
  }
  const total = stackTotal(project)
  const diff = total - project.box.depth
  const colors = project.materials.map(m => m.color.toLowerCase())
  const warnings = [
    diff > 0.01 && `Stack is ${fmtLen(diff)} ${unit()} taller than the case`,
    ...project.items.map(it => it.z + itemHeight(it) > total + 0.01 && `${it.name} reaches below the stack`),
    ...project.items.map(lidWarning),
    ...project.items.map(it => conflicts.has(it.id) && `${it.name} breaks the min. wall`),
    colors.includes(project.labelColor.toLowerCase()) && 'Label colour equals a material colour',
    colors.includes(project.outlineColor.toLowerCase()) && 'Outline colour equals a material colour',
    new Set(colors).size < colors.length && 'Two materials share a line colour',
    ...[...missing].map(([what, n]) => `${n} more ${what} needed than in stock`),
    ...sheets.filter(s => s.oversize).map(s => `Layer ${s.pieces[0].layer.index + 1} is larger than every ${s.material.name} sheet size`),
    ...sheets.flatMap(s => s.pieces.filter(pc => pc.conflict).map(pc => `Layer ${pc.layer.index + 1} is closer than the min. wall to another piece on its sheet`)),
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

// projects: the unsaved one and named ones, kept in this browser; autosave goes to the open one

/** Opens project `name` ('' = the unsaved one) with a fresh undo history. */
function openProject(name: string) {
  project = loadProject(name)
  history = new History(JSON.stringify(project))
  selection = []
  layerIndex = 0
  renderAll()
}

/** Starts an empty unsaved project; undo brings the previous unsaved one back. */
function startNew() {
  if (currentName()) openProject('')
  project = newProject(project)
  selection = []
  renderAll()
}

/** Inline name field: Enter calls `done` with a name no other project has, Esc or leaving it calls `cancel`. */
function nameField(value: string, done: (name: string) => void, cancel: () => void) {
  const el = h('input', { type: 'text', value, placeholder: 'Project name', className: 'name-field' })
  el.onkeydown = e => {
    const name = el.value.trim()
    if (!(e.key === 'Enter' && name) && e.key !== 'Escape') return
    e.preventDefault()
    el.onblur = null // removing the field blurs it
    if (e.key === 'Enter' && name !== value) done(uniqueName(name))
    else cancel()
  }
  el.onblur = cancel
  return el
}

const projects = $('projects') as HTMLDetailsElement

/** Name and case of the open project; the list of projects is built while it is open (it reads them all). */
function renderProjects() {
  const current = currentName()
  const label = (name: string, box: CaseDims) => [name || 'Unsaved', h('span', { className: 'hint', textContent: ` · ${caseName(box)}` })]
  $('project-name').replaceChildren(...label(current, project.box))
  $('save').hidden = !!current
  if (!projects.open) return
  const entry = (name: string) => {
    const open = h('button', { className: 'grow', onclick: () => {
      projects.open = false
      if (name !== current) openProject(name)
    } }, ...label(name, name === current ? project.box : storedCase(name)))
    const rename = () => {
      const field = nameField(name, to => (renameProject(name, to), renderProjects()), renderProjects)
      open.replaceWith(field)
      field.focus()
    }
    // plain buttons: changed() would rebuild the list (and drop a rename field)
    const icon = (textContent: string, tip: string, onclick: () => void) => h('button', { className: 'icon', textContent, tip, onclick })
    return h('div', { className: `row${name === current ? ' active' : ''}` }, open, ...(name ? [
      icon('✎', 'Rename', rename),
      icon('⧉', 'Copy (opens nothing, adds the copy to this list)', () => (copyProject(name, uniqueName(`${name.replace(/ copy( \d+)?$/, '')} copy`)), renderProjects())),
      icon('✕', 'Delete this project from the browser', () => {
        if (!confirm(`Delete the project "${name}"? This cannot be undone.`)) return
        if (name === current) openProject('')
        deleteProject(name)
        renderProjects()
      }),
    ] : []))
  }
  // the unsaved project is listed while it is open or holds something
  $('project-menu').replaceChildren(...(!current || !unsavedEmpty() ? [entry('')] : []), ...projectNames().map(entry))
}

$('save').onclick = () => {
  const save = $('save'), field = nameField('', name => {
    nameProject(project, name)
    resetUnsaved(project)
    field.replaceWith(save)
    renderProjects()
  }, () => field.replaceWith(save))
  save.replaceWith(field)
  field.focus()
}
$('new').onclick = startNew
projects.ontoggle = renderProjects

const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true })
document.body.append(file)
// a project file becomes a new named project; its materials join the shared ones (the same by id, else by name and thickness, are reused)
// a file holds one project, or all of them ({ projects: [{ name, project }] }, see exportJson)
file.onchange = async () => {
  const f = file.files?.[0]
  file.value = ''
  if (!f) return
  let loaded: { name: string; project: Project }[]
  try {
    const data = JSON.parse(await f.text())
    loaded = data.projects ?? [{ name: f.name.replace(/\.json$/i, '') || 'Loaded', project: data }]
    for (const l of loaded) normalize(l.project)
  } catch {
    return alert('Not a valid project file.')
  }
  const first = loaded.map(({ name, project: p }) => importProject(p, name))[0]
  openProject(first)
}

/** Adds `p` as a new named project; returns its name. */
function importProject(p: Project, name: string) {
  const ms = project.materials
  const ids = new Map(p.materials.map(m => {
    const same = ms.find(o => o.id === m.id) ?? ms.find(o => o.name === m.name && o.thickness === m.thickness)
    if (!same) ms.push(m)
    return [m.id, (same ?? m).id]
  }))
  const unique = uniqueName(name)
  nameProject({
    ...p,
    ...sharedPart(project),
    stack: p.stack.map(id => ids.get(id)!),
    placements: p.placements?.map(pl => ({ ...pl, material: ids.get(pl.material) ?? pl.material })),
  }, unique)
  return unique
}

/** JSON of the open project, or (asked when there are more) of all: the named ones and the unsaved one if it has objects. */
function exportJson() {
  const current = currentName()
  const one = () => download(`${current || 'incase'}.json`, JSON.stringify(project, null, 2), 'application/json')
  const names = [...(!current || !unsavedEmpty() ? [''] : []), ...projectNames()]
  if (names.length < 2) return one()
  const all = () => {
    const projects = names.map(name => ({ name: name || 'Unsaved', project: name === current ? project : storedProject(name) }))
    download('incase-projects.json', JSON.stringify({ projects }, null, 2), 'application/json')
  }
  openDialog(
    h('span', { textContent: `Export all ${names.length} projects, or just the current one?` }),
    h('button', { className: 'primary', textContent: 'Everything', onclick: () => (closeDialog(), all()) }),
    h('button', { textContent: 'Current project', onclick: () => (closeDialog(), one()) }),
  )
}
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
  setExporting(false)
}
const renderLayout = segmented($('layout'), [['top', 'Top', 'Top view only (1)'], ['split', 'Split', 'Top view and 3D side by side (2)'], ['3d', '3D', '3D view only (3)']], () => layout, setLayout)

let exporting = false
/** Export mode: the stock sheets fill the view and the left column holds only the export settings; the design is out of reach. */
function setExporting(on: boolean) {
  exporting = on
  document.body.classList.toggle('export-mode', on)
  if (on && view2d.isDrawing) view2d.cancelDrawing()
  if (on) selection = []
  changed('items', 'selection')
}
$('to-export').onclick = () => setExporting(true)
$('back').onclick = () => setExporting(false)

// plain export: all layers side by side, no stock sheets; label colour and kerf as set in the export mode
const plainExport = $('plain-export') as HTMLDetailsElement
const plainItem = (textContent: string, tip: string, action: () => void) =>
  h('button', { textContent, tip, onclick: () => ((plainExport.open = false), action()) })
$('plain-export-menu').replaceChildren(
  plainItem('SVG', 'All layers side by side as one SVG in mm', () => download('incase.svg', exportSvg(project, computeLayers(project), false), 'image/svg+xml')),
  plainItem('DXF', 'Same as the SVG, as a DXF (R12, mm) with one layer per foam layer', () => download('incase.dxf', exportDxf(project, computeLayers(project), false), 'application/dxf')),
  plainItem('PDF', 'Printable 1:1 templates to cut by hand; large layers are split onto several sheets', pdfDialog),
  plainItem('JSON', 'The project incl. materials as a file (or all projects in one), to keep or share; Load opens it again', exportJson),
)
addEventListener('pointerdown', e => {
  for (const menu of [plainExport, projects, alignMenu]) if (!menu.contains(e.target as Node)) menu.open = false
})

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme
  const css = getComputedStyle(document.documentElement)
  view3d.setTheme(css.getPropertyValue('--view3d').trim(), css.getPropertyValue('--accent').trim())
}
$('theme').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  setPref('theme', theme)
  applyTheme(theme)
  scheduleViews() // line colours are checked against the new background
}

// --- viewports ---

const view2d = new View2D($('view2d'), { select, change: () => changed(), len: mm => `${fmtLen(mm)} ${unit()}`, unit: () => ({ name: unit(), mm: inches ? MM_PER_IN : 1 }), violation, createPolygon })
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
const view3d = new View3D($('view3d'), select, () => renderCamera(), i => {
  layerIndex = i
  scheduleViews()
})
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
    view3d.fit(true)
  }
}
splitter.ondblclick = () => {
  setSplit(0.5)
  view3d.fit(true)
}

/** Hand placement from the sheet view; every other piece is fixed where it is, so nothing else moves. */
function placePiece(sheets: Sheet[], moved: Piece, to: SheetPlacement) {
  project.placements = sheets.flatMap(s => (s.index < 0 ? [] : s.pieces.map(pc =>
    pc === moved ? to : { layer: pc.layer.index, material: s.material.id, sheet: s.index, w: s.w, h: s.h, x: pc.x, y: pc.y, rot: pc.rot })))
  changed()
}
const sheetView = new SheetView($('view-sheets'), { place: placePiece })
$('repack').onclick = () => {
  project.placements = []
  changed()
}

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
  view3d.explode = explode.valueAsNumber / 100
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
const duplicateTool = tool('duplicate', 'Duplicate (⌘/Ctrl+D)', () => duplicate(selectedItems()))
const deleteTool = tool('delete', 'Delete (Del)', () => remove(selectedItems()))

// align: one tool with a menu beside it; needs 2+ selected objects (distribute 3+)
const alignMenu = h('details', { className: 'dropdown flyout' })
const ALIGNS: [Align, string, string][] = [
  ['left', 'Left', 'Left edges onto the leftmost'],
  ['centerX', 'Center X', 'Centres onto the middle of the selection, left to right'],
  ['right', 'Right', 'Right edges onto the rightmost'],
  ['top', 'Top', 'Top edges onto the topmost'],
  ['centerY', 'Center Y', 'Centres onto the middle of the selection, top to bottom'],
  ['bottom', 'Bottom', 'Bottom edges onto the lowest'],
  ['distributeX', 'Distribute X', 'Equal gaps left to right; the outermost stay (3+ objects)'],
  ['distributeY', 'Distribute Y', 'Equal gaps top to bottom; the outermost stay (3+ objects)'],
  ['first', 'Center on first', 'Centres onto the centre of the first selected object'],
]
const renderAlignMenu = () => alignMenu.replaceChildren(
  h('summary', { className: 'tool', innerHTML: icon('align'), tip: 'Align the selected objects (by their outlines, without fit)' }),
  h('div', { className: 'menu' }, ...ALIGNS.map(([how, label, tip]) => h('button', {
    innerHTML: `${icon(how)}<span>${label}</span>`, tip, disabled: selection.length < (how.startsWith('distribute') ? 3 : 2),
    onclick: () => {
      alignMenu.open = false
      alignItems(selectedItems(), how)
      changed()
    },
  }))),
)
alignMenu.ontoggle = () => alignMenu.open && renderAlignMenu()
renderAlignMenu()
const undoTool = tool('undo', 'Undo (⌘/Ctrl+Z)', () => restore(history.undo()))
const redoTool = tool('redo', 'Redo (⇧⌘Z / Ctrl+Y)', () => restore(history.redo()))
$('toolbar').replaceChildren(
  ...(Object.entries(SHAPE_KEYS) as [string, Shape][]).map(([key, shape]) => tool(shape, `${SHAPES[shape]} (${key.toUpperCase()})`, () => addItem(shape))),
  tool('polygon', 'Polygon: click its corners in the top view (P)', startPolygon),
  h('hr'),
  duplicateTool,
  alignMenu,
  tool('even', 'Arrange evenly: largest equal gaps, centred (A)', () => arrange(true)),
  tool('pack', 'Pack tightly at the min. wall, centred (⇧A)', () => arrange(false)),
  h('hr'),
  undoTool,
  redoTool,
  Object.assign(deleteTool, { className: 'tool bottom' }),
)
$('fit-3d').replaceWith(Object.assign(tool('fit', 'Fit the case into the 3D view (F)', () => view3d.fit()), { id: 'fit-3d' }))

function updateChrome() {
  const it = selected()
  duplicateTool.disabled = deleteTool.disabled = !selection.length
  undoTool.disabled = !history.canUndo
  redoTool.disabled = !history.canRedo
  $('hint').textContent = exporting
    ? 'Drag a piece to move it, also onto another sheet · drag its handle to turn it (Ctrl 15°), double-click or R by 90° · Re-pack lays all out again · ⌘Z undo · Esc back to the design'
    : view2d.isDrawing
    ? 'Click to add corners · click the first one, double-click or Enter to finish · Backspace removes the last · Esc cancels'
    : selection.length > 1
    ? 'Drag one to move them all · Shift-click adds or removes · align them with the align tool · arrows nudge (Shift ×10) · Del delete · ⌘D duplicate · Esc deselect · ⌘Z undo'
    : it
    ? 'Drag to move · Shift-click selects more · Ctrl snaps · drag handle to rotate (Ctrl 15°) · arrows nudge (Shift ×10) · Del delete · ⌘D duplicate · Esc deselect · ⌘Z undo'
    : 'B C L S add · Tab next object under the click · A arrange evenly, ⇧A pack · F fit 3D · PgUp / PgDn layer · 1 / 2 / 3 layout · wheel zoom, drag background to pan · drag a field label to scrub · ⌘Z undo'
}

let frame = 0
function scheduleViews() {
  frame ||= requestAnimationFrame(() => {
    frame = 0
    const layers = computeLayers(project)
    const conflicts = wallConflicts(project)
    renderWarnings(conflicts, planSheets(project, layers).sheets)
    if (exporting) return sheetView.render(project, layers)
    layerIndex = Math.max(0, Math.min(layerIndex, layers.length - 1))
    const layer = layers[layerIndex]
    $('layer-label').textContent = layer
      ? `Layer ${layerIndex + 1}/${layers.length} · ${layer.material.name} · ${fmtLen(layer.a)}–${fmtLen(layer.b)} ${unit()}`
      : 'No layers'
    layerUp.disabled = layerIndex <= 0
    layerDown.disabled = layerIndex >= layers.length - 1
    $('stack').querySelectorAll('.sortable').forEach((row, i) => row.classList.toggle('current', i === layerIndex))
    view2d.render(project, selection, layers, layerIndex, conflicts)
    renderLayerStrip(layers)
    view3d.update(project, layers, selection, layerIndex)
  })
}

const strip = $('layer-strip')
let stripIndex = -1 // layer the strip was last scrolled to

/** Thumbnails of all layers below the top view; click one to show it, the shown one is centred when it changes. */
function renderLayerStrip(layers: Layer[]) {
  strip.replaceChildren(...layers.map((l, i) => {
    const tip = `Layer ${i + 1}/${layers.length} · ${l.material.name} · ${fmtLen(l.a)}–${fmtLen(l.b)} ${unit()}`
    const thumb = h('button', { className: 'thumb' + (i === layerIndex ? ' current' : ''), tip, innerHTML: view2d.thumbnail(project, l), onclick: () => {
      layerIndex = i
      scheduleViews()
    } })
    thumb.append(h('span', { textContent: `${i + 1} · ${l.material.name}` }))
    return thumb
  }))
  const current = strip.children[layerIndex] as HTMLElement | undefined
  if (current && stripIndex !== layerIndex) {
    strip.scrollTo({ left: current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2, behavior: 'smooth' })
    stripIndex = layerIndex
  }
}

function renderAll() {
  renderGridField()
  renderCase()
  presetPicker()
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
  const it = selected(), items = selectedItems()
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
  if (plain && key === 'e') setExporting(!exporting)
  // the design is out of reach while exporting
  else if (exporting && !mod && !LAYOUT_KEYS[key]) {
    if (plain && key === 'r') sheetView.rotateHovered()
    else if (e.key === 'Escape') setExporting(false)
    else return
  }
  else if (mod && key === 'z') restore(e.shiftKey ? history.redo() : history.undo())
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
  } else if (items.length && nudge[e.key]) {
    // keep clear: the whole nudge is refused if it makes any violation worse
    const [dx, dy] = nudge[e.key]
    const before = items.map(violation)
    const by = (k: number) => items.forEach(o => Object.assign(o, { x: o.x + k * dx, y: o.y + k * dy }))
    by(1)
    if (view2d.constrain && items.some((o, i) => violation(o) > before[i] + AREA_TOL)) by(-1)
    changed()
  } else if (items.length && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (!(it && view2d.deleteVertex())) remove(items)
  }
  else if (items.length && e.key === 'Escape') select(null)
  else if (items.length && (e.metaKey || e.ctrlKey) && key === 'd') duplicate(items)
  else return
  e.preventDefault()
})

setLayout(layout)
renderAll()
