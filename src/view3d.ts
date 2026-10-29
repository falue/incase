import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { booleanOpDWithPolyTree, ClipType, FillRule, PolyTreeD, type PolyPathD } from 'clipper2-ts'
import { caseSection, objectOutline, resting, roundedRect, stackTotal, type Layer } from './geometry'
import { itemHeight, type CaseDims, type Item, type Project } from './model'

// Plan (x, y) maps to three (x, z); y = 0 is the case top, the case floor is at y = -depth.

const PER_CORNER = 8 // arc segments per corner of the case shell
const CASE_LINE = 2.5 // px
const FAR = 1e5 // mm, stands in for an open section side
const FIT_MARGIN = 1.1
const CUBE = 56 // px, view cube edge
const TURN_MS = 300 // view cube camera turn
const CURRENT_LINE = 5 // px, edges of the current layer
const SHELL = '#7f8fa3' // case and lid
const OBJECT = '#ff9a3c'
const LID_HIT = '#ff2a2a' // part of an object above the closed lid

function collectShapes(node: PolyPathD, out: THREE.Shape[]) {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i)
    const shape = new THREE.Shape(outer.poly!.map(p => new THREE.Vector2(p.x, p.y)))
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j)
      shape.holes.push(new THREE.Path(hole.poly!.map(p => new THREE.Vector2(p.x, p.y))))
      collectShapes(hole, out)
    }
    out.push(shape)
  }
}

/** Polygon item extruded to its depth, centred vertically like the other primitives. */
function polygonGeometry(it: Item) {
  const outline = objectOutline({ ...it, x: 0, y: 0, rot: 0 }, -Infinity)
  return new THREE.ExtrudeGeometry(outline.map(p => new THREE.Shape(p.map(q => new THREE.Vector2(q.x, q.y)))), { depth: it.h, bevelEnabled: false })
    .rotateX(Math.PI / 2)
    .translate(0, it.h / 2, 0)
}

/** `bottom` is the three y the item stands on. */
function ghost(it: Item, bottom: number, color: string, clippingPlanes: THREE.Plane[]): THREE.Mesh {
  const r = it.d / 2
  const geo =
    it.shape === 'box' ? new THREE.BoxGeometry(it.l, it.h, it.w)
    : it.shape === 'cylinder' ? new THREE.CylinderGeometry(r, r, it.h, 48)
    : it.shape === 'lying' ? new THREE.CylinderGeometry(r, r, it.l, 48).rotateZ(Math.PI / 2)
    : it.shape === 'polygon' ? polygonGeometry(it)
    : new THREE.SphereGeometry(r, 48, 24)
  // the polygon offset keeps its bottom face in front of the foam top it stands on (no z-fighting)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, clippingPlanes,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }))
  mesh.position.set(it.x, bottom + itemHeight(it) / 2, it.y)
  mesh.rotation.y = (-it.rot * Math.PI) / 180
  mesh.userData.id = it.id
  return mesh
}

/** Translucent walls lofted through `rings` (equal point counts, from roundedRect with PER_CORNER), closed by a flat cap
 * at the last ring, with lines along the first and last ring and where the corner arcs start and end. */
function shell(rings: THREE.Vector3[][], opacity: number, lineWidth: number): THREE.Object3D[] {
  const n = rings[0].length
  const walls = new THREE.BufferGeometry().setFromPoints(rings.flat())
  const index: number[] = []
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const a = k * n + i, b = k * n + ((i + 1) % n)
      index.push(a, b, a + n, b, b + n, a + n)
    }
  }
  walls.setIndex(index)
  const last = rings.at(-1)!
  const cap = new THREE.ShapeGeometry(new THREE.Shape(last.map(p => new THREE.Vector2(p.x, p.z))))
  cap.rotateX(Math.PI / 2).translate(0, last[0].y, 0)

  const lines: THREE.Vector3[] = []
  for (const ring of [rings[0], last]) ring.forEach((p, i) => lines.push(p, ring[(i + 1) % n]))
  for (let c = 0; c < 4; c++) {
    for (const i of [c * (PER_CORNER + 1), c * (PER_CORNER + 1) + PER_CORNER]) {
      for (let k = 0; k < rings.length - 1; k++) lines.push(rings[k][i], rings[k + 1][i])
    }
  }

  const surface = () => new THREE.MeshBasicMaterial({ color: SHELL, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })
  return [
    new THREE.Mesh(walls, surface()),
    new THREE.Mesh(cap, surface()),
    new LineSegments2(new LineSegmentsGeometry().setPositions(lines.flatMap(p => p.toArray())), new LineMaterial({ color: SHELL, linewidth: lineWidth })),
  ]
}

/** Case cavity: rings follow the taper and the bottom edge radius down to the floor. */
function caseShell(box: CaseDims) {
  const R = Math.min(box.bottomRadius, box.depth)
  const depths = R > 0 ? [0, ...Array.from({ length: 7 }, (_, i) => box.depth - R + (R * i) / 6)] : [0, box.depth]
  const rings = depths.map(z => {
    const s = caseSection(box, z)
    return roundedRect(Math.max(s.l, 0.01), Math.max(s.w, 0.01), s.r, PER_CORNER)!.map(p => new THREE.Vector3(p.x, -z, p.y))
  })
  return shell(rings, 0.12, CASE_LINE)
}

/** Closed lid above the rim: straight walls up to the lid depth, fainter than the case. */
function lidShell(box: CaseDims) {
  const s = caseSection(box, 0)
  const ring = (y: number) => roundedRect(Math.max(s.l, 0.01), Math.max(s.w, 0.01), s.r, PER_CORNER)!.map(p => new THREE.Vector3(p.x, y, p.y))
  return shell([ring(0), ring(box.lidDepth)], 0.05, CASE_LINE / 2)
}

export class View3D {
  /** Extra vertical gap between layers, 0–1; at 1 it is half the longer case side; the bottom layer stays on the floor. */
  explode = 0
  private accent = '#3d8bff' // set by setTheme
  private renderer = new THREE.WebGLRenderer({ antialias: true })
  private scene = new THREE.Scene()
  private perspective = new THREE.PerspectiveCamera(35, 1, 1, 50000)
  private orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000)
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.orthographic
  private controls = new OrbitControls(this.camera, this.renderer.domElement)
  private content = new THREE.Group()
  private viewHeight = 400 // orthographic frustum height in mm at zoom 1
  /** Visible range per plan axis as fractions of the case extent (0..1). */
  private sections = { x: [0, 1], y: [0, 1] }
  private extent = { x: 0, y: 0 } // half case size per plan axis
  private ghosts: THREE.Mesh[] = []
  private slabs: THREE.Mesh[] = []
  private box: CaseDims | null = null
  private last: Parameters<View3D['update']> | null = null

  /** Set when a view cube click switched to orthographic; the next rotation switches back to perspective. */
  private autoOrtho = false
  private cube = document.createElement('div')
  private cubeWrap = document.createElement('div')

  /**
   * `onProjection` is called when the camera switches between orthographic and perspective on its own,
   * `onLayer` when a foam layer is clicked.
   */
  constructor(private host: HTMLElement, onSelect: (id: string | null) => void, private onProjection: () => void, onLayer: (index: number) => void) {
    this.renderer.setPixelRatio(devicePixelRatio)
    this.renderer.localClippingEnabled = true
    const canvas = this.renderer.domElement
    host.append(canvas, this.viewCube())
    // a click without dragging selects the object under the pointer, or shows the clicked layer
    let down = { x: 0, y: 0 }
    canvas.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }))
    canvas.addEventListener('pointermove', e => {
      // a left drag without modifiers rotates: that leaves the side view the cube set up
      const rotating = e.buttons === 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
      if (rotating && this.cubeWrap.classList.contains('aligned')) this.leaveSideView()
    })
    canvas.addEventListener('pointerup', e => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      const r = canvas.getBoundingClientRect()
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera)
      const hit = ray.intersectObjects([...this.ghosts, ...this.slabs])[0]?.object.userData
      if (hit?.layer !== undefined) onLayer(hit.layer)
      else onSelect(hit?.id ?? null)
    })
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(300, 800, 500)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6), sun, this.content)
    this.controls.addEventListener('change', () => this.draw())
    new ResizeObserver(() => this.resize()).observe(host)
  }

  get isOrthographic() {
    return this.camera === this.orthographic
  }

  /** Switches the camera and keeps the framing: the orthographic zoom matches the perspective view height at the target. */
  setOrthographic(on: boolean) {
    if (on === this.isOrthographic) return
    const target = this.controls.target
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2))
    const from = this.camera, to = on ? this.orthographic : this.perspective
    to.quaternion.copy(from.quaternion)
    if (on) {
      to.position.copy(from.position)
      this.orthographic.zoom = this.viewHeight / (from.position.distanceTo(target) * k)
    } else {
      const dist = this.viewHeight / this.orthographic.zoom / k
      to.position.copy(from.position).sub(target).setLength(dist).add(target)
    }
    to.updateProjectionMatrix()
    this.camera = to
    this.controls.object = to
    this.controls.update()
    this.draw()
  }

  setSection(axis: 'x' | 'y', from: number, to: number) {
    this.sections[axis] = [from, to]
    if (this.last) this.update(...this.last)
  }

  /** Section bounds in plan mm per axis; ±Infinity where the slider sits at its end. */
  private sectionBounds() {
    const range = (axis: 'x' | 'y') => {
      const [from, to] = this.sections[axis], e = this.extent[axis]
      return [from > 0 ? (2 * from - 1) * e : -Infinity, to < 1 ? (2 * to - 1) * e : Infinity]
    }
    return { x: range('x'), y: range('y') }
  }

  /** Theme colours: the view background and the accent of the current layer and the selected object. */
  setTheme(background: string, accent: string) {
    this.scene.background = new THREE.Color(background)
    this.accent = accent
    if (this.last) this.update(...this.last)
    else this.draw()
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host
    if (!w || !h) return // hidden pane
    this.renderer.setSize(w, h)
    this.updateFrustums(w / h)
    this.draw()
  }

  private updateFrustums(aspect: number) {
    const o = this.orthographic, half = this.viewHeight / 2
    Object.assign(o, { left: -half * aspect, right: half * aspect, top: half, bottom: -half })
    o.updateProjectionMatrix()
    this.perspective.aspect = aspect
    this.perspective.updateProjectionMatrix()
  }

  private draw() {
    this.renderer.render(this.scene, this.camera)
    // the view cube shows the camera's rotation (three's y-up frame mirrored into CSS's y-down frame)
    const e = new THREE.Matrix4().makeRotationFromQuaternion(this.camera.quaternion).invert().elements
    this.cube.style.transform = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`
  }

  /** Small cube top right; clicking a face looks at the case from that side. */
  private viewCube() {
    const half = CUBE / 2
    const faces: [string, string, THREE.Vector3][] = [
      ['Front', `translateZ(${half}px)`, new THREE.Vector3(0, 0, 1)],
      ['Back', `rotateY(180deg) translateZ(${half}px)`, new THREE.Vector3(0, 0, -1)],
      ['Right', `rotateY(90deg) translateZ(${half}px)`, new THREE.Vector3(1, 0, 0)],
      ['Left', `rotateY(-90deg) translateZ(${half}px)`, new THREE.Vector3(-1, 0, 0)],
      // straight up/down is a pole for the orbit controls: tilt a hair towards the front
      ['Top', `rotateX(90deg) translateZ(${half}px)`, new THREE.Vector3(0, 1, 1e-3)],
      ['Bottom', `rotateX(-90deg) translateZ(${half}px)`, new THREE.Vector3(0, -1, 1e-3)],
    ]
    this.cube.className = 'cube'
    this.cube.append(...faces.map(([label, transform, dir]) =>
      Object.assign(document.createElement('div'), { className: 'face', textContent: label, onclick: () => this.viewFrom(dir), style: `transform: ${transform}` })))
    // after a side was chosen, arrows turn the view by 90° to the neighbouring side
    const arrows = (['up', 'down', 'left', 'right'] as const).map(side =>
      Object.assign(document.createElement('button'), { className: `turn ${side}`, onclick: () => this.turn(side) }))
    this.cubeWrap.className = 'viewcube'
    this.cubeWrap.append(this.cube, ...arrows)
    return this.cubeWrap
  }

  /** Looks at the neighbouring side: the one to the right / left / above / below on screen. */
  private turn(side: 'up' | 'down' | 'left' | 'right') {
    const screen = side === 'up' || side === 'down' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const v = screen.applyQuaternion(this.camera.quaternion).multiplyScalar(side === 'down' || side === 'left' ? -1 : 1)
    // snap to the nearest main axis
    const parts = [v.x, v.y, v.z], i = parts.reduce((best, c, k) => (Math.abs(c) > Math.abs(parts[best]) ? k : best), 0)
    const dir = new THREE.Vector3().setComponent(i, Math.sign(parts[i]))
    if (i === 1) dir.addScaledVector(this.camera.position.clone().sub(this.controls.target).normalize(), 1e-3) // off the pole, towards the old view
    this.viewFrom(dir)
  }

  /** The user rotated away from a cube side: hide the arrows, back to perspective if the cube switched to orthographic. */
  private leaveSideView() {
    this.cubeWrap.classList.remove('aligned')
    if (!this.autoOrtho) return
    this.autoOrtho = false
    this.setOrthographic(false)
    this.onProjection()
  }

  /** Turns the camera to look from `dir` (same target and distance), switching to orthographic for the view. */
  private viewFrom(dir: THREE.Vector3) {
    this.cubeWrap.classList.add('aligned')
    if (!this.isOrthographic) {
      this.setOrthographic(true)
      this.autoOrtho = true
      this.onProjection()
    }
    const target = this.controls.target, cam = this.camera
    const dist = cam.position.distanceTo(target)
    const from = cam.position.clone().sub(target).normalize()
    const turn = new THREE.Quaternion().setFromUnitVectors(from, dir.clone().normalize())
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TURN_MS), k = t * t * (3 - 2 * t)
      cam.position.copy(target).addScaledVector(from.clone().applyQuaternion(new THREE.Quaternion().slerp(turn, k)), dist)
      this.controls.update()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  /** `current` is the layer shown in the top view; it is highlighted. */
  update(p: Project, layers: Layer[], selectedId: string | null, current: number) {
    this.last = [p, layers, selectedId, current]
    this.extent = { x: Math.max(p.box.topL, p.box.bottomL) / 2, y: Math.max(p.box.topW, p.box.bottomW) / 2 }
    const { x: [x0, x1], y: [y0, y1] } = this.sectionBounds()
    const sectioned = [x0, x1, y0, y1].some(Number.isFinite)
    // foam is cut as real geometry so its section faces are solid; objects use clipping planes (plan y is three z), the case stays whole
    const clamp = (v: number) => Math.max(-FAR, Math.min(FAR, v))
    const rect = [{ x: clamp(x0), y: clamp(y0) }, { x: clamp(x1), y: clamp(y0) }, { x: clamp(x1), y: clamp(y1) }, { x: clamp(x0), y: clamp(y1) }]
    const cut = (v: number, normal: THREE.Vector3Tuple, point: THREE.Vector3Tuple) =>
      Number.isFinite(v) ? [new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...normal), new THREE.Vector3(...point))] : []
    const planes = [...cut(x0, [1, 0, 0], [x0, 0, 0]), ...cut(x1, [-1, 0, 0], [x1, 0, 0]), ...cut(y0, [0, 0, 1], [0, 0, y0]), ...cut(y1, [0, 0, -1], [0, 0, y1])]

    this.content.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.content.clear()

    const foamTop = p.box.depth - stackTotal(p)
    const gap = this.explode ** 2 * Math.max(this.extent.x, this.extent.y) // squared: fine control at small gaps
    const shift = (i: number) => (layers.length - 1 - i) * gap
    this.slabs = []
    for (const layer of layers) {
      let tree = layer.tree
      if (sectioned) {
        tree = new PolyTreeD()
        booleanOpDWithPolyTree(ClipType.Intersection, layer.paths, [rect], tree, FillRule.EvenOdd, 3)
      }
      const shapes: THREE.Shape[] = []
      collectShapes(tree, shapes)
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: layer.b - layer.a, bevelEnabled: false })
      geo.rotateX(Math.PI / 2).translate(0, -(foamTop + layer.a) + shift(layer.index), 0)
      const color = new THREE.Color(layer.material.color).lerp(new THREE.Color('#fff'), 0.35)
      const edges = new THREE.EdgesGeometry(geo, 30)
      const slab = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 }))
      slab.userData.layer = layer.index
      this.slabs.push(slab)
      this.content.add(
        slab,
        layer.index === current
          ? new LineSegments2(new LineSegmentsGeometry().setPositions(edges.attributes.position.array as Float32Array), new LineMaterial({ color: this.accent, linewidth: CURRENT_LINE }))
          : new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: '#222' })),
      )
      if (layer.index === current) edges.dispose()
    }
    this.ghosts = p.items.flatMap(it => {
      // the item stands on (and explodes with) the layer below its cut, or on the case floor
      const { z, layer } = resting(p, it)
      const h = itemHeight(it)
      const bottom = layer >= 0 ? -(foamTop + layers[layer].a) + shift(layer) : -(foamTop + z + h)
      const color = it.id === selectedId ? this.accent : OBJECT
      const excess = -(foamTop + z + p.box.lidDepth) // how far it reaches above the closed lid
      if (excess <= 0) return [ghost(it, bottom, color, planes)]
      // split at the lid ceiling (measured on the item, so it also holds in the exploded view): the part above is red
      const lid = bottom + h - excess
      return [
        ghost(it, bottom, color, [...planes, new THREE.Plane(new THREE.Vector3(0, -1, 0), lid)]),
        ghost(it, bottom, LID_HIT, [...planes, new THREE.Plane(new THREE.Vector3(0, 1, 0), -lid)]),
      ]
    })
    const shell = [...caseShell(p.box), ...(p.box.lidDepth > 0 ? lidShell(p.box) : [])]
    this.content.add(...this.ghosts, ...shell)

    if (!this.box) {
      this.box = p.box
      this.fit()
    }
    this.box = p.box
    this.draw()
  }

  /**
   * Frames the whole case so it fits both the width and the height of the view: from the front-right corner, or
   * (`keepAngle`) from the direction the camera looks now.
   */
  fit(keepAngle = false) {
    if (!this.box) return
    const b = this.box
    const L = Math.max(b.topL, b.bottomL), W = Math.max(b.topW, b.bottomW)
    const target = new THREE.Vector3(0, (b.lidDepth - b.depth) / 2, 0) // middle of case + lid
    // seen from the front-right corner: 45° around the vertical axis, ~40° above the horizon
    const dir = keepAngle
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(1.1 * Math.SQRT1_2, 0.9, 1.1 * Math.SQRT1_2).normalize()
    const o = this.orthographic
    o.position.copy(target).addScaledVector(dir, Math.max(L, W, b.depth) * 2)
    if (keepAngle) o.quaternion.copy(this.camera.quaternion) // also keeps the roll of straight-down views
    else o.lookAt(target)
    o.updateMatrixWorld()
    // half extents of the case box as seen from the camera
    let halfW = 0, halfH = 0
    for (const x of [-L / 2, L / 2]) for (const y of [b.lidDepth, -b.depth]) for (const z of [-W / 2, W / 2]) {
      const v = new THREE.Vector3(x, y, z).applyMatrix4(o.matrixWorldInverse)
      halfW = Math.max(halfW, Math.abs(v.x))
      halfH = Math.max(halfH, Math.abs(v.y))
    }
    const { clientWidth: w, clientHeight: h } = this.host
    const aspect = h ? w / h : 1
    this.viewHeight = 2 * Math.max(halfH, halfW / aspect) * FIT_MARGIN
    this.updateFrustums(aspect)
    o.zoom = 1
    o.updateProjectionMatrix()
    // perspective: same direction, far enough that the same height fits (near corners appear larger, hence the margin)
    const dist = (this.viewHeight * FIT_MARGIN) / (2 * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2)))
    this.perspective.position.copy(target).addScaledVector(dir, dist)
    this.perspective.quaternion.copy(o.quaternion)
    this.controls.target.copy(target)
    this.controls.update()
    this.draw()
  }
}
