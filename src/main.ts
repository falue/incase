import './style.css'
import { computeLayers, safeZoneConflicts, stackTotal } from './geometry'
import { exportSvg } from './export'
import { defaultItem, defaultNotch, itemHeight, loadProject, parseProject, saveProject, suggestStack, uid, type Dim, type Item, type Project, type Shape } from './model'
import { View2D } from './view2d'
import { View3D } from './view3d'

type Section = 'materials' | 'items' | 'selection'
type Layout = 'top' | 'split' | '3d'

const SHAPES: Record<Shape, string> = { box: 'Box', cylinder: 'Cylinder', lying: 'Lying cylinder', sphere: 'Sphere' }
const SHAPE_KEYS: Record<string, Shape> = { b: 'box', c: 'cylinder', l: 'lying', s: 'sphere' }
const LAYOUT_KEYS: Record<string, Layout> = { 1: 'top', 2: 'split', 3: '3d' }
const DIMS: Record<Shape, [string, Dim][]> = {
  box: [['Length', 'l'], ['Width', 'w'], ['Depth', 'h'], ['Corner R', 'r']],
  cylinder: [['Diameter', 'd'], ['Depth', 'h']],
  lying: [['Diameter', 'd'], ['Length', 'l']],
  sphere: [['Diameter', 'd']],
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
}
const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`
const MM_PER_IN = 25.4

// per-viewer UI preferences
const pref = (key: string) => localStorage.getItem(`incase.${key}`)
const setPref = (key: string, value: string) => localStorage.setItem(`incase.${key}`, value)

let project: Project = loadProject()
let selectedId: string | null = null
let layerIndex = -1 // -1 = no layer overlay
let inches = pref('units') === 'in' // display only, the model is always mm

const $ = (id: string) => document.getElementById(id)!
/** Display format: at most 4 decimals. */
const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)
const fmtLen = (mm: number) => fmt(inches ? mm / MM_PER_IN : mm)
const unit = () => (inches ? 'in' : 'mm')
const selected = () => project.items.find(it => it.id === selectedId)
const swap = <T>(a: T[], i: number, j: number) => {
  if (j >= 0 && j < a.length) [a[i], a[j]] = [a[j], a[i]]
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const el = document.createElement(tag)
  Object.assign(el, props)
  el.append(...children)
  return el
}

// Inputs remember their getter so values changed elsewhere (dragging, scrubbing) can be synced in place.
const getters = new WeakMap<HTMLInputElement, () => string>()

function input(type: string, get: () => string, onInput: (el: HTMLInputElement) => void) {
  const el = h('input', { type, step: 'any', value: get(), oninput: () => onInput(el) })
  getters.set(el, get)
  return el
}

/** Number input; `scrub` is the value change per pixel when dragging its label. */
function num(get: () => number, set: (v: number) => void, scrub = 1) {
  const el = input('number', () => fmt(get()), el => {
    if (Number.isFinite(el.valueAsNumber)) {
      set(el.valueAsNumber)
      changed()
    }
  })
  el.dataset.scrub = String(scrub)
  return el
}

/** Length input: shown in the display unit, stored in mm. */
const len = (get: () => number, set: (mm: number) => void) =>
  num(() => (inches ? get() / MM_PER_IN : get()), v => set(inches ? v * MM_PER_IN : v), inches ? 0.02 : 0.5)

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

/** Labelled field; dragging the label of a number field scrubs its value (Shift = fine). */
function prop(label: string, el: HTMLInputElement | HTMLSelectElement, className = '') {
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
  return h('div', { className: `prop ${className}` }, name, el)
}

const button = (label: string, title: string, action: () => void, ...rebuild: Section[]) =>
  h('button', { textContent: label, title, onclick: () => (action(), changed(...rebuild)) })

const iconButton = (label: string, title: string, action: () => void, ...rebuild: Section[]) =>
  Object.assign(button(label, title, action, ...rebuild), { className: 'icon' })

/** Segmented control with one active option; returns its re-render function. */
function segmented<T extends string>(host: HTMLElement, options: [T, string][], get: () => T, set: (v: T) => void) {
  const render = () =>
    host.replaceChildren(...options.map(([value, textContent]) =>
      h('button', { textContent, className: value === get() ? 'active' : '', onclick: () => (set(value), render()) })))
  render()
  return render
}

function syncInputs() {
  for (const el of $('panel').querySelectorAll('input')) {
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
  updateChrome()
  saveProject(project)
  scheduleViews()
}

function renderCase() {
  const b = project.box
  // bottom size follows the top while both are equal (straight walls)
  const linked = (top: 'topL' | 'topW', bottom: 'bottomL' | 'bottomW') =>
    len(() => b[top], v => {
      if (b[bottom] === b[top]) b[bottom] = v
      b[top] = v
    })
  $('case').replaceChildren(
    prop('Top L', linked('topL', 'bottomL')),
    prop('Top W', linked('topW', 'bottomW')),
    prop('Bottom L', len(() => b.bottomL, v => (b.bottomL = v))),
    prop('Bottom W', len(() => b.bottomW, v => (b.bottomW = v))),
    prop('Depth', len(() => b.depth, v => (b.depth = v))),
    prop('Clearance', len(() => b.clearance, v => (b.clearance = v))),
    prop('Edge R', len(() => b.radius, v => (b.radius = v))),
    prop('Bottom R', len(() => b.bottomRadius, v => (b.bottomRadius = v))),
    prop('Safe zone', len(() => b.safeZone, v => (b.safeZone = v)), 'wide'),
  )
}

function renderMaterials() {
  const ms = project.materials
  const nextColor = () => PALETTE.find(c => c !== project.labelColor && !ms.some(m => m.color === c)) ?? '#808080'
  $('materials').replaceChildren(
    ...ms.map((m, i) =>
      h('div', { className: 'row' },
        color(() => m.color, v => (m.color = v)),
        Object.assign(text(() => m.name, v => (m.name = v)), { className: 'grow' }),
        prop(unit(), len(() => m.thickness, v => (m.thickness = v)), 'short'),
        iconButton('↑', 'Move up (more preferred)', () => swap(ms, i, i - 1), 'materials'),
        iconButton('↓', 'Move down', () => swap(ms, i, i + 1), 'materials'),
        iconButton('✕', 'Remove material', () => {
          ms.splice(i, 1)
          project.stack = project.stack.filter(id => id !== m.id)
        }, 'materials'),
      ),
    ),
    h('div', { className: 'row' },
      button('+ Material', 'Add material', () => ms.push({ id: uid(), name: `Foam ${ms.length + 1}`, thickness: 5, color: nextColor() }), 'materials'),
      h('span', { className: 'grow' }),
      color(() => project.labelColor, v => (project.labelColor = v)),
      h('span', { className: 'hint', textContent: 'Label colour' }),
    ),
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
    return h('div', { className: 'row' },
      h('span', { className: 'swatch', style: `background:${m.color}` }),
      h('span', { className: 'idx', textContent: String(i + 1) }),
      select,
      h('span', { className: 'hint', textContent: `${fmtLen(a)}–${fmtLen(z)}` }),
      iconButton('↑', 'Move up', manual(() => swap(stack, i, i - 1))),
      iconButton('↓', 'Move down', manual(() => swap(stack, i, i + 1))),
      iconButton('✕', 'Remove layer', manual(() => stack.splice(i, 1))),
    )
  })
  $('stack').replaceChildren(
    h('div', { className: 'row' },
      h('span', { className: 'total' + (Math.abs(z - box.depth) > 0.01 ? ' off' : ''), textContent: `${fmtLen(z)} / ${fmtLen(box.depth)} ${unit()}` }),
      h('span', { className: 'grow' }),
      project.stackAuto
        ? h('span', { className: 'hint', textContent: 'auto-filled' })
        : button('Auto-fill', 'Refill from the material list', () => (project.stackAuto = true)),
    ),
    ...rows,
    button('+ Layer', 'Add layer at the bottom', manual(() => materials.length && stack.push(stack.at(-1) ?? materials[0].id))),
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

function addItem(shape: Shape) {
  const it = defaultItem(shape, `${SHAPES[shape]} ${project.items.length + 1}`, (project.items.length % 8) * 10)
  project.items.push(it)
  select(it.id)
}

function duplicate(it: Item) {
  const copy = { ...structuredClone(it), id: uid(), name: `${it.name} copy`, x: it.x + 10, y: it.y + 10 }
  project.items.push(copy)
  select(copy.id)
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
  const clearance = input('number', () => (it.clearance === null ? '' : fmtLen(it.clearance)), el => {
    if (el.value === '') it.clearance = null
    else if (Number.isFinite(el.valueAsNumber)) it.clearance = inches ? el.valueAsNumber * MM_PER_IN : el.valueAsNumber
    else return
    changed()
  })
  clearance.placeholder = `global ${fmtLen(project.box.clearance)}`
  clearance.dataset.scrub = inches ? '0.02' : '0.5'

  $('selection').replaceChildren(
    h('div', { className: 'props' },
      prop('Name', text(() => it.name, v => (it.name = v), 'items'), 'wide'),
      prop('Shape', shape, 'wide'),
      prop('X', len(() => it.x, v => (it.x = v))),
      prop('Y', len(() => it.y, v => (it.y = v))),
      prop('Rotation °', num(() => it.rot, v => (it.rot = v))),
      prop('Z from top', len(() => it.z, v => (it.z = v))),
      ...DIMS[it.shape].map(([label, k]) => prop(label, len(() => it[k], v => (it[k] = v)))),
      prop('Clearance', clearance),
    ),
    h('h4', { textContent: 'Finger notches' }),
    ...it.notches.map((n, i) =>
      h('div', { className: 'row' },
        prop('dx', len(() => n.dx, v => (n.dx = v))),
        prop('dy', len(() => n.dy, v => (n.dy = v))),
        prop('Ø', len(() => n.d, v => (n.d = v))),
        prop('Depth', len(() => n.depth, v => (n.depth = v))),
        iconButton('✕', 'Remove notch', () => it.notches.splice(i, 1), 'selection'),
      ),
    ),
    button('+ Notch', 'Add finger notch', () => it.notches.push(defaultNotch(it)), 'selection'),
  )
}

function renderWarnings(conflicts: Set<string>) {
  const total = stackTotal(project)
  const diff = total - project.box.depth
  const colors = project.materials.map(m => m.color.toLowerCase())
  const warnings = [
    Math.abs(diff) > 0.01 && `Stack is ${fmtLen(Math.abs(diff))} ${unit()} ${diff < 0 ? 'lower' : 'taller'} than the case depth`,
    ...project.items.map(it => it.z + itemHeight(it) > total + 0.01 && `${it.name} reaches below the stack`),
    ...project.items.map(it => conflicts.has(it.id) && `${it.name} is inside the safe zone`),
    colors.includes(project.labelColor.toLowerCase()) && 'Label colour equals a material colour',
    new Set(colors).size < colors.length && 'Two materials share a line colour',
  ].filter((w): w is string => !!w)
  const el = $('warnings')
  el.textContent = warnings.length ? `⚠ ${warnings.join(' · ')}` : ''
  el.title = warnings.join('\n')
}

function download(name: string, content: string, type: string) {
  const href = URL.createObjectURL(new Blob([content], { type }))
  h('a', { href, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(href))
}

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

segmented($('units'), [['mm', 'mm'], ['in', 'in']], () => unit(), v => {
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
const renderLayout = segmented($('layout'), [['top', 'Top'], ['split', 'Split'], ['3d', '3D']], () => layout, setLayout)

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

const view2d = new View2D($('view2d'), select, () => changed(), mm => `${fmtLen(mm)} ${unit()}`)
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

const layerSelect = $('layer-select') as HTMLSelectElement
layerSelect.onchange = () => {
  layerIndex = Number(layerSelect.value)
  scheduleViews()
}

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

const sectionResets: (() => void)[] = []
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
  sectionResets.push(reset)
}
$('section-reset').onclick = () => sectionResets.forEach(reset => reset())

view3d.setOrthographic(pref('camera') !== 'persp')
segmented($('camera'), [['ortho', 'Ortho'], ['persp', 'Persp']], () => (view3d.isOrthographic ? 'ortho' : 'persp'), v => {
  view3d.setOrthographic(v === 'ortho')
  setPref('camera', v)
})

// --- tool strip & status bar ---

const tool = (name: keyof typeof ICONS, title: string, onclick: () => void) => h('button', { className: 'tool', title, innerHTML: icon(name), onclick })
const duplicateTool = tool('duplicate', 'Duplicate (⌘/Ctrl+D)', () => {
  const it = selected()
  if (it) duplicate(it)
})
const deleteTool = tool('delete', 'Delete (Del)', () => {
  const it = selected()
  if (it) remove(it)
})
$('toolbar').replaceChildren(
  ...(Object.entries(SHAPE_KEYS) as [string, Shape][]).map(([key, shape]) => tool(shape, `${SHAPES[shape]} (${key.toUpperCase()})`, () => addItem(shape))),
  h('hr'),
  duplicateTool,
  deleteTool,
  h('hr'),
  tool('fit', 'Fit 3D view (F)', () => view3d.fit()),
)

function updateChrome() {
  const it = selected()
  duplicateTool.disabled = deleteTool.disabled = !it
  $('hint').textContent = it
    ? 'Drag to move · drag handle to rotate (Shift 15°) · arrows nudge (Shift ×10) · Del delete · ⌘D duplicate · Esc deselect'
    : 'B box · C cylinder · L lying · S sphere · F fit 3D · 1 / 2 / 3 layout · drag a field label to scrub'
}

let frame = 0
function scheduleViews() {
  frame ||= requestAnimationFrame(() => {
    frame = 0
    const layers = computeLayers(project)
    const conflicts = safeZoneConflicts(project)
    renderWarnings(conflicts)
    if (layerIndex >= layers.length) layerIndex = -1
    layerSelect.replaceChildren(
      h('option', { value: '-1', textContent: 'No layer overlay' }),
      ...layers.map((l, i) => h('option', { value: String(i), textContent: `Layer ${i + 1} · ${l.material.name}` })),
    )
    layerSelect.value = String(layerIndex)
    view2d.render(project, selectedId, layers[layerIndex] ?? null, conflicts)
    view3d.update(project, layers, selectedId)
  })
}

function renderAll() {
  renderCase()
  changed('materials', 'items', 'selection')
}

addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  const key = e.key.toLowerCase()
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey
  const it = selected()
  const step = e.shiftKey ? 10 : 1
  const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  if (plain && SHAPE_KEYS[key]) addItem(SHAPE_KEYS[key])
  else if (plain && key === 'f') view3d.fit()
  else if (plain && LAYOUT_KEYS[key]) {
    setLayout(LAYOUT_KEYS[key])
    renderLayout()
  } else if (it && nudge[e.key]) {
    it.x += nudge[e.key][0]
    it.y += nudge[e.key][1]
    changed()
  } else if (it && (e.key === 'Delete' || e.key === 'Backspace')) remove(it)
  else if (it && e.key === 'Escape') select(null)
  else if (it && (e.metaKey || e.ctrlKey) && key === 'd') duplicate(it)
  else return
  e.preventDefault()
})

renderAll()
