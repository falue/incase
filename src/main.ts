import './style.css'
import { computeLayers } from './geometry'
import { exportSvg } from './export'
import { defaultItem, defaultNotch, itemHeight, loadProject, saveProject, suggestStack, uid, type Dim, type Item, type Project, type Shape } from './model'
import { View2D } from './view2d'
import { View3D } from './view3d'

type Section = 'materials' | 'items' | 'selection'

const SHAPES: Record<Shape, string> = { box: 'Box', cylinder: 'Cylinder', lying: 'Lying cylinder', sphere: 'Sphere' }
const DIMS: Record<Shape, [string, Dim][]> = {
  box: [['Length', 'l'], ['Width', 'w'], ['Depth', 'h'], ['Corner radius', 'r']],
  cylinder: [['Diameter', 'd'], ['Depth', 'h']],
  lying: [['Diameter', 'd'], ['Length', 'l']],
  sphere: [['Diameter', 'd']],
}
const PALETTE = ['#000000', '#ff0000', '#0000ff', '#00a000', '#ff8000', '#00a0a0', '#a000a0', '#808000']

let project: Project = loadProject()
let selectedId: string | null = null
let layerIndex = -1 // -1 = no layer overlay

const $ = (id: string) => document.getElementById(id)!
const fmt = (v: number) => String(Math.round(v * 100) / 100)
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

// Inputs remember their getter so values changed elsewhere (dragging, linked fields) can be synced in place.
const getters = new WeakMap<HTMLInputElement, () => string>()

function input(type: string, get: () => string, onInput: (el: HTMLInputElement) => void) {
  const el = h('input', { type, step: 'any', value: get(), oninput: () => onInput(el) })
  getters.set(el, get)
  return el
}

const num = (get: () => number, set: (v: number) => void, ...rebuild: Section[]) =>
  input('number', () => String(get()), el => {
    if (Number.isFinite(el.valueAsNumber)) {
      set(el.valueAsNumber)
      changed(...rebuild)
    }
  })

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

const field = (label: string, el: HTMLElement) => h('label', { className: 'field' }, h('span', { textContent: label }), el)

const button = (label: string, title: string, action: () => void, ...rebuild: Section[]) =>
  h('button', { textContent: label, title, onclick: () => (action(), changed(...rebuild)) })

function syncInputs() {
  for (const el of $('sidebar').querySelectorAll('input')) {
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
  renderWarnings()
  syncInputs()
  saveProject(project)
  scheduleViews()
}

function renderCase() {
  const b = project.box
  // bottom size follows the top while both are equal (straight walls)
  const linked = (top: 'topL' | 'topW', bottom: 'bottomL' | 'bottomW') =>
    num(() => b[top], v => {
      if (b[bottom] === b[top]) b[bottom] = v
      b[top] = v
    })
  $('case').replaceChildren(
    field('Top length', linked('topL', 'bottomL')),
    field('Top width', linked('topW', 'bottomW')),
    field('Bottom length', num(() => b.bottomL, v => (b.bottomL = v))),
    field('Bottom width', num(() => b.bottomW, v => (b.bottomW = v))),
    field('Depth', num(() => b.depth, v => (b.depth = v))),
    field('Clearance (+ loose, − tight)', num(() => b.clearance, v => (b.clearance = v))),
    field('Edge radius', num(() => b.radius, v => (b.radius = v))),
    field('Bottom edge radius', num(() => b.bottomRadius, v => (b.bottomRadius = v))),
  )
}

function renderMaterials() {
  const ms = project.materials
  const nextColor = () => PALETTE.find(c => c !== project.labelColor && !ms.some(m => m.color === c)) ?? '#808080'
  $('materials').replaceChildren(
    ...ms.map((m, i) =>
      h('div', { className: 'row' },
        color(() => m.color, v => (m.color = v)),
        text(() => m.name, v => (m.name = v)),
        num(() => m.thickness, v => (m.thickness = v)),
        'mm',
        button('↑', 'Move up (more preferred)', () => swap(ms, i, i - 1), 'materials'),
        button('↓', 'Move down', () => swap(ms, i, i + 1), 'materials'),
        button('✕', 'Remove material', () => {
          ms.splice(i, 1)
          project.stack = project.stack.filter(id => id !== m.id)
        }, 'materials'),
      ),
    ),
    button('+ Material', 'Add material', () => ms.push({ id: uid(), name: `Foam ${ms.length + 1}`, thickness: 5, color: nextColor() }), 'materials'),
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
    const select = h('select', {}, ...materials.map(o => h('option', { value: o.id, textContent: `${o.name} (${fmt(o.thickness)} mm)` })))
    select.value = id
    select.onchange = () => {
      manual(() => (stack[i] = select.value))()
      changed()
    }
    return h('div', { className: 'row' },
      h('span', { className: 'swatch', style: `background:${m.color}` }),
      h('span', { className: 'idx', textContent: String(i + 1) }),
      select,
      h('span', { className: 'hint', textContent: `${fmt(a)}–${fmt(z)}` }),
      button('↑', 'Move up', manual(() => swap(stack, i, i - 1))),
      button('↓', 'Move down', manual(() => swap(stack, i, i + 1))),
      button('✕', 'Remove layer', manual(() => stack.splice(i, 1))),
    )
  })
  $('stack').replaceChildren(
    h('div', { className: 'row' },
      h('span', { className: 'total' + (Math.abs(z - box.depth) > 0.01 ? ' off' : ''), textContent: `${fmt(z)} / ${fmt(box.depth)} mm` }),
      project.stackAuto
        ? h('span', { className: 'hint', textContent: '· auto-filled, edit to customise' })
        : button('Auto-fill', 'Refill from the material list', () => (project.stackAuto = true)),
    ),
    ...rows,
    button('+ Layer', 'Add layer at the bottom', manual(() => materials.length && stack.push(stack.at(-1) ?? materials[0].id))),
  )
}

function renderItems() {
  $('items').replaceChildren(
    h('div', { className: 'row' },
      ...(Object.entries(SHAPES) as [Shape, string][]).map(([shape, label]) =>
        button(`+ ${label}`, `Add ${label.toLowerCase()}`, () => {
          const it = defaultItem(shape, `${label} ${project.items.length + 1}`, (project.items.length % 8) * 10)
          project.items.push(it)
          selectedId = it.id
        }, 'items', 'selection'),
      ),
    ),
    ...project.items.map(it =>
      h('button', {
        className: 'item' + (it.id === selectedId ? ' selected' : ''),
        textContent: `${it.name} · ${SHAPES[it.shape]}`,
        onclick: () => select(it.id),
      }),
    ),
  )
}

function select(id: string | null) {
  selectedId = id
  changed('items', 'selection')
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
  const clearance = input('number', () => String(it.clearance ?? ''), el => {
    if (el.value === '') it.clearance = null
    else if (Number.isFinite(el.valueAsNumber)) it.clearance = el.valueAsNumber
    else return
    changed()
  })
  clearance.placeholder = `global (${fmt(project.box.clearance)})`

  $('selection').replaceChildren(
    h('div', { className: 'grid' },
      field('Name', text(() => it.name, v => (it.name = v), 'items')),
      field('Shape', shape),
      field('X', num(() => it.x, v => (it.x = v))),
      field('Y', num(() => it.y, v => (it.y = v))),
      field('Rotation °', num(() => it.rot, v => (it.rot = v))),
      field('Z from top', num(() => it.z, v => (it.z = v))),
      ...DIMS[it.shape].map(([label, k]) => field(label, num(() => it[k], v => (it[k] = v)))),
      field('Clearance', clearance),
    ),
    h('h3', { textContent: 'Finger notches' }),
    ...it.notches.map((n, i) =>
      h('div', { className: 'row' },
        field('dx', num(() => n.dx, v => (n.dx = v))),
        field('dy', num(() => n.dy, v => (n.dy = v))),
        field('Ø', num(() => n.d, v => (n.d = v))),
        field('Depth', num(() => n.depth, v => (n.depth = v))),
        button('✕', 'Remove notch', () => it.notches.splice(i, 1), 'selection'),
      ),
    ),
    h('div', { className: 'row' },
      button('+ Notch', 'Add finger notch', () => it.notches.push(defaultNotch(it)), 'selection'),
      h('button', { textContent: 'Duplicate', title: '⌘/Ctrl+D', onclick: () => duplicate(it) }),
      h('button', { textContent: 'Delete', title: 'Del', onclick: () => remove(it) }),
    ),
  )
}

function download(name: string, content: string, type: string) {
  const href = URL.createObjectURL(new Blob([content], { type }))
  h('a', { href, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(href))
}

function renderExport() {
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true })
  file.onchange = async () => {
    const f = file.files?.[0]
    file.value = ''
    if (!f) return
    try {
      project = JSON.parse(await f.text())
    } catch {
      return alert('Not a valid project file.')
    }
    selectedId = null
    renderAll()
  }
  $('export').replaceChildren(
    h('div', { className: 'row' }, color(() => project.labelColor, v => (project.labelColor = v)), 'Label colour'),
    h('div', { className: 'row' },
      h('button', { className: 'primary', textContent: 'Export SVG', onclick: () => download('incase.svg', exportSvg(project, computeLayers(project)), 'image/svg+xml') }),
      h('button', { textContent: 'Save project', onclick: () => download('incase.json', JSON.stringify(project, null, 2), 'application/json') }),
      h('button', { textContent: 'Load project', onclick: () => file.click() }),
      file,
    ),
  )
}

function renderWarnings() {
  const total = project.stack.reduce((sum, id) => sum + (project.materials.find(m => m.id === id)?.thickness ?? 0), 0)
  const diff = total - project.box.depth
  const colors = project.materials.map(m => m.color.toLowerCase())
  const warnings = [
    Math.abs(diff) > 0.01 && `Stack is ${fmt(Math.abs(diff))} mm ${diff < 0 ? 'lower' : 'taller'} than the case depth.`,
    ...project.items.map(it => it.z + itemHeight(it) > total + 0.01 && `${it.name} reaches below the stack.`),
    colors.includes(project.labelColor.toLowerCase()) && 'Label colour equals a material colour.',
    new Set(colors).size < colors.length && 'Two materials share a line colour.',
  ].filter((w): w is string => !!w)
  $('warnings').replaceChildren(...warnings.map(textContent => h('li', { textContent })))
}

const view2d = new View2D($('view2d'), select, () => changed())
const view3d = new View3D($('view3d'))
const layerSelect = $('layer-select') as HTMLSelectElement
layerSelect.onchange = () => {
  layerIndex = Number(layerSelect.value)
  scheduleViews()
}
const explode = $('explode') as HTMLInputElement
explode.oninput = () => {
  view3d.explode = explode.valueAsNumber
  scheduleViews()
}

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme
  view3d.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--view3d').trim())
}
applyTheme(localStorage.getItem('incase.theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
$('theme').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('incase.theme', theme)
  applyTheme(theme)
}

let frame = 0
function scheduleViews() {
  frame ||= requestAnimationFrame(() => {
    frame = 0
    const layers = computeLayers(project)
    if (layerIndex >= layers.length) layerIndex = -1
    layerSelect.replaceChildren(
      h('option', { value: '-1', textContent: 'No layer overlay' }),
      ...layers.map((l, i) => h('option', { value: String(i), textContent: `Layer ${i + 1} · ${l.material.name}` })),
    )
    layerSelect.value = String(layerIndex)
    view2d.render(project, selectedId, layers[layerIndex] ?? null)
    view3d.update(project, layers)
  })
}

function renderAll() {
  renderCase()
  renderExport()
  changed('materials', 'items', 'selection')
}

addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  const it = selected()
  if (!it) return
  const step = e.shiftKey ? 10 : 1
  const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  if (nudge[e.key]) {
    it.x += nudge[e.key][0]
    it.y += nudge[e.key][1]
    changed()
  } else if (e.key === 'Delete' || e.key === 'Backspace') remove(it)
  else if (e.key === 'Escape') select(null)
  else if ((e.metaKey || e.ctrlKey) && e.key === 'd') duplicate(it)
  else return
  e.preventDefault()
})

renderAll()
