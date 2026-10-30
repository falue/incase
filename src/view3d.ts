import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { booleanOpDWithPolyTree, ClipType, FillRule, PolyTreeD, type PolyPathD } from 'clipper2-ts'
import { caseSection, objectOutline, resting, roundedRect, stackTotal, type Layer } from './geometry'
import { deepest, groupOf, itemHeight, type CaseDims, type Item, type Project } from './model'

// Plan (x, y) maps to three (x, z); y = 0 is the case top, the case floor is at y = -depth.

const PER_CORNER = 8 // arc segments per corner of the case shell
const CASE_LINE = 2.5 // px
const FAR = 1e5 // mm, stands in for an open section side
const FIT_MARGIN = 1.1
const CUBE = 56 // px, view cube edge
const TURN_MS = 300 // view cube camera turn
const CURRENT_LINE = 5 // px, edges of the current layer
const OUTLINE = 2.5 // px, around selected objects, also through the foam
const WANTED = { color: '#ffffff', outline: 0.5 } // selected objects where their Z wants them: colour, outline opacity
const SHELL = '#7f8fa3' // case and lid
const OBJECT = '#ff9a3c'
const LID_HIT = '#ff2a2a' // part of an object above the closed lid
const OPACITY = { strong: 0.5, faint: 0.12, editing: 0.25 } // objects; faint: where they are wanted; editing: where they sit, while Z is edited

const HATCH = { mm: 4, px: 16, shade: 0.6 } // section faces: stripe spacing, texture tile size, colour factor
let hatchTexture: THREE.CanvasTexture | null = null

/** Faint (20 % black) diagonal stripes on white, one per tile; tiles seamlessly. */
function hatch() {
  if (hatchTexture) return hatchTexture
  const c = Object.assign(document.createElement('canvas'), { width: HATCH.px, height: HATCH.px }), g = c.getContext('2d')!, n = HATCH.px
  g.fillStyle = '#fff'
  g.fillRect(0, 0, n, n)
  g.strokeStyle = 'rgba(0, 0, 0, 0.2)'
  g.lineWidth = n / 6
  g.beginPath()
  for (const o of [-n, 0, n]) {
    g.moveTo(o, n)
    g.lineTo(o + n, 0)
  }
  g.stroke()
  hatchTexture = new THREE.CanvasTexture(c)
  hatchTexture.wrapS = hatchTexture.wrapT = THREE.RepeatWrapping
  hatchTexture.colorSpace = THREE.SRGBColorSpace
  return hatchTexture
}

/**
 * The faces of `geo` lying in a section plane (three x in `xs`, three z in `zs`), darker and hatched in world mm;
 * null if there are none.
 */
function sectionFaces(geo: THREE.BufferGeometry, xs: number[], zs: number[], color: THREE.Color, eps = 0.01) {
  const pos = geo.toNonIndexed().attributes.position
  const points: number[] = [], uvs: number[] = []
  for (let t = 0; t < pos.count; t += 3) {
    const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, t + k))
    const on = (axis: 'x' | 'z', values: number[]) => values.some(c => v.every(p => Math.abs(p[axis] - c) < eps))
    const alongZ = on('x', xs) // a face across x runs along z
    if (!alongZ && !on('z', zs)) continue
    for (const p of v) {
      points.push(p.x, p.y, p.z)
      uvs.push((alongZ ? p.z : p.x) / HATCH.mm, p.y / HATCH.mm)
    }
  }
  if (!points.length) return null
  const faces = new THREE.BufferGeometry()
  faces.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  faces.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  faces.computeVertexNormals()
  return new THREE.Mesh(faces, new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(HATCH.shade), map: hatch(), roughness: 0.9, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, // in front of the slab's own face
  }))
}

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
function ghost(it: Item, bottom: number, color: string, clippingPlanes: THREE.Plane[], opacity: number): THREE.Mesh {
  const r = it.d / 2
  const geo =
    it.shape === 'box' ? new THREE.BoxGeometry(it.l, it.h, it.w)
    : it.shape === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, it.h, 48).scale(it.d, 1, it.d2)
    : it.shape === 'lying' ? new THREE.CylinderGeometry(r, r, it.l, 48).rotateZ(Math.PI / 2)
    : it.shape === 'polygon' ? polygonGeometry(it)
    : new THREE.SphereGeometry(0.5, 48, 24).scale(it.d, itemHeight(it), it.d2)
  // the polygon offset keeps its bottom face in front of the foam top it stands on (no z-fighting)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, clippingPlanes,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }))
  mesh.position.set(it.x, bottom + itemHeight(it) / 2, it.y)
  mesh.rotation.y = (-it.rot * Math.PI) / 180
  mesh.userData.id = it.id
  return mesh
}

/** Adds a plain copy of `mesh` (same clipping) on layer 1, the mask `drawOutline` rings: red for selected, green for wanted. */
function outlined(mesh: THREE.Mesh, color = 0xff0000) {
  const mask = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
    color, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, clippingPlanes: (mesh.material as THREE.Material).clippingPlanes,
  }))
  mask.layers.set(1)
  mesh.add(mask)
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
  private explode = 0
  private landing = 0 // animation frame of the landing bounce
  private landGap = 0 // extra gap while the layers land
  private shown = 0 // gap as shown: springs after `gap()`, so the layers wobble
  private gapSpeed = 0
  private moving = 0 // animation frame of the explode motion
  /** The Z field is hovered or edited: the wanted position of selected objects is shown strong and outlined, where they sit faint. */
  private editingZ = false
  private accent = '#3d8bff' // set by setTheme
  private renderer = new THREE.WebGLRenderer({ antialias: true })
  private outlining = false // something is selected
  private mask = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })
  private ring = { mask: { value: this.mask.texture }, texel: { value: new THREE.Vector2() }, color: { value: new THREE.Color() }, wanted: { value: new THREE.Color(WANTED.color) } }
  // pixels outside a mask channel but within OUTLINE of it, per channel; where the rings cross, the wanted one lies translucent over the selected
  private outline = new FullScreenQuad(new THREE.ShaderMaterial({
    defines: { R: Math.ceil(OUTLINE * devicePixelRatio), WANTED_ALPHA: WANTED.outline.toFixed(2) },
    uniforms: this.ring,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D mask; uniform vec2 texel; uniform vec3 color; uniform vec3 wanted; varying vec2 vUv;
      void main() {
        vec2 here = texture2D(mask, vUv).rg, near = vec2(0.0);
        for (int x = -R; x <= R; x++) for (int y = -R; y <= R; y++)
          if (x * x + y * y <= R * R) near = max(near, texture2D(mask, vUv + vec2(x, y) * texel).rg);
        vec4 c = near.x > 0.5 && here.x < 0.5 ? vec4(color, 1.0) : vec4(0.0);
        if (near.y > 0.5 && here.y < 0.5) c = vec4(mix(c.rgb, wanted, WANTED_ALPHA / max(c.a, WANTED_ALPHA)), max(c.a, WANTED_ALPHA));
        if (c.a == 0.0) discard;
        gl_FragColor = c;
        #include <colorspace_fragment>
      }`,
    transparent: true, depthTest: false, depthWrite: false,
  }))
  private scene = new THREE.Scene()
  private perspective = new THREE.PerspectiveCamera(35, 1, 1, 50000)
  private orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000)
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.orthographic
  private controls = new OrbitControls(this.camera, this.renderer.domElement)
  private content = new THREE.Group()
  private viewHeight = 400 // orthographic frustum height in mm at zoom 1
  /** Visible range per plan axis as fractions of the case extent (0..1). */
  private sections = { x: [0, 1], y: [0, 1] }
  private inverted = { x: false, y: false } // shows only what is outside the range
  private extent = { x: 0, y: 0 } // half case size per plan axis
  private ghosts: THREE.Mesh[] = []
  private slabs: THREE.Mesh[] = []
  private box: CaseDims | null = null
  private last: Parameters<View3D['update']> | null = null
  private pick: THREE.Ray | null = null // last click, for Tab cycling

  /** Set when a view cube click switched to orthographic; the next rotation switches back to perspective. */
  private autoOrtho = false
  private cube = document.createElement('div')
  private cubeWrap = document.createElement('div')

  /**
   * `onProjection` is called when the camera switches between orthographic and perspective on its own,
   * `onLayer` when a foam layer is clicked; `onSelect` gets `add` for a Shift-click.
   */
  constructor(private host: HTMLElement, private onSelect: (id: string | null, add: boolean) => void, private onProjection: () => void, onLayer: (index: number) => void) {
    this.renderer.setPixelRatio(devicePixelRatio)
    this.renderer.localClippingEnabled = true
    const canvas = this.renderer.domElement
    host.append(canvas, this.viewCube())
    // a click without dragging selects the object under the pointer (Shift: adds or removes it), or shows the clicked layer
    let down = { x: 0, y: 0 }
    canvas.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }))
    canvas.addEventListener('pointermove', e => {
      // a left drag without modifiers rotates: that leaves the side view the cube set up
      const rotating = e.buttons === 1 && !e.shiftKey && !e.ctrlKey && !e.metaKey && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
      if (rotating) this.leaveSideView()
    })
    canvas.addEventListener('pointerup', e => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      const r = canvas.getBoundingClientRect()
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera)
      this.pick = ray.ray.clone()
      const hit = ray.intersectObjects([...this.ghosts, ...this.slabs])[0]?.object.userData
      if (hit?.layer !== undefined) onLayer(hit.layer)
      else if (hit?.id || !e.shiftKey) onSelect(hit?.id ?? null, e.shiftKey)
    })
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(300, 800, 500)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6), sun, this.content)
    this.controls.addEventListener('change', () => this.draw())
    new ResizeObserver(() => this.resize()).observe(host)
  }

  /** Tab: selects the next (`step` 1) or previous object along the last click's ray, through the foam. */
  cycle(step: number) {
    if (!this.pick || !this.last) return
    const selection = this.last[2]
    const ids = [...new Set(new THREE.Raycaster(this.pick.origin, this.pick.direction).intersectObjects(this.ghosts).map(h => h.object.userData.id as string))]
    if (!ids.length) return
    let i = ids.findIndex(id => selection.includes(id))
    if (i < 0) i = -step // none of them selected: start at the nearest
    // skip the rest of a selected group
    for (let k = 0; k < ids.length; k++) {
      i = (i + step + ids.length) % ids.length
      if (!selection.includes(ids[i])) break
    }
    this.onSelect(ids[i], false)
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

  setSection(axis: 'x' | 'y', from: number, to: number, inverted: boolean) {
    this.sections[axis] = [from, to]
    this.inverted[axis] = inverted
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
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    this.mask.setSize(size.x, size.y)
    this.ring.texel.value.set(1 / size.x, 1 / size.y)
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
    if (this.outlining) this.drawOutline()
    // the view cube shows the camera's rotation (three's y-up frame mirrored into CSS's y-down frame)
    const e = new THREE.Matrix4().makeRotationFromQuaternion(this.camera.quaternion).invert().elements
    this.cube.style.transform = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${-e[4]},${e[5]},${-e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`
  }

  /** Rings the selected objects (their masks on layer 1) over the drawn view. */
  private drawOutline() {
    const r = this.renderer, background = this.scene.background
    this.scene.background = null
    this.camera.layers.set(1)
    r.setRenderTarget(this.mask)
    r.render(this.scene, this.camera)
    r.setRenderTarget(null)
    this.camera.layers.set(0)
    this.scene.background = background
    r.autoClear = false
    this.outline.render(r)
    r.autoClear = true
  }

  /** Small cube top right; clicking a face looks at the case from that side. */
  private viewCube(dragSpeed = 0.02 /* rad per px */) {
    const half = CUBE / 2
    const faces: [string, string, THREE.Vector3, number][] = [ // last: brightness, lit from the top front right
      ['Front', `translateZ(${half}px)`, new THREE.Vector3(0, 0, 1), 0.9],
      ['Back', `rotateY(180deg) translateZ(${half}px)`, new THREE.Vector3(0, 0, -1), 0.75],
      ['Right', `rotateY(90deg) translateZ(${half}px)`, new THREE.Vector3(1, 0, 0), 0.82],
      ['Left', `rotateY(-90deg) translateZ(${half}px)`, new THREE.Vector3(-1, 0, 0), 0.78],
      // straight up/down is a pole for the orbit controls: tilt a hair towards the front
      ['Top', `rotateX(90deg) translateZ(${half}px)`, new THREE.Vector3(0, 1, 1e-3), 1],
      ['Bottom', `rotateX(-90deg) translateZ(${half}px)`, new THREE.Vector3(0, -1, 1e-3), 0.68],
    ]
    this.cube.className = 'cube'
    this.cube.append(...faces.map(([label, transform, dir, light]) => {
      const face = Object.assign(document.createElement('div'), { className: 'face', textContent: label, onclick: () => this.viewFrom(dir), style: `transform: ${transform}; filter: brightness(${light})` })
      // corner spots look from that cube corner, 45° between the sides; hovering lights the spots of that corner on all three faces
      const n = dir.clone().round(), up = n.y ? new THREE.Vector3(0, 0, -n.y) : new THREE.Vector3(0, 1, 0), right = up.clone().cross(n)
      face.append(...([['tl', -1, 1], ['tr', 1, 1], ['bl', -1, -1], ['br', 1, -1]] as const).map(([at, x, y]) => {
        const corner = n.clone().addScaledVector(right, x).addScaledVector(up, y)
        const light = (on: boolean) => this.cube.querySelectorAll(`[data-corner="${corner.toArray()}"]`).forEach(c => c.classList.toggle('lit', on))
        const spot = Object.assign(document.createElement('div'), {
          className: `corner ${at}`,
          onclick: (e: MouseEvent) => {
            e.stopPropagation()
            this.viewFrom(corner, false)
          },
          onpointerenter: () => light(true),
          onpointerleave: () => light(false),
        })
        spot.dataset.corner = `${corner.toArray()}`
        return spot
      }))
      return face
    }))
    // dragging the cube orbits the camera; the capture makes the release no click on a face
    let last = { x: 0, y: 0 }
    this.cube.onpointerdown = e => (last = { x: e.clientX, y: e.clientY })
    this.cube.onpointermove = e => {
      if (e.buttons !== 1) return
      const dx = e.clientX - last.x, dy = e.clientY - last.y
      if (!this.cube.hasPointerCapture(e.pointerId)) {
        if (Math.hypot(dx, dy) <= 4) return
        this.cube.setPointerCapture(e.pointerId)
        this.leaveSideView()
      }
      last = { x: e.clientX, y: e.clientY }
      const target = this.controls.target, s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target))
      s.theta -= dx * dragSpeed
      s.phi -= dy * dragSpeed
      this.camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(s.makeSafe()))
      this.controls.update()
    }
    // after a side was chosen, arrows turn the view by 90° to the neighbouring side
    const arrows = (['up', 'down', 'left', 'right'] as const).map(side =>
      Object.assign(document.createElement('button'), { className: `turn ${side}`, onclick: () => this.turn(side) }))
    this.cubeWrap.className = 'viewcube'
    this.cubeWrap.append(this.cube, ...arrows)
    return this.cubeWrap
  }

  /** Looks at the neighbouring side: the one to the right / left / above / below on screen. */
  private turn(side: 'up' | 'down' | 'left' | 'right') {
    const [x, y] = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] }[side]
    const dir = this.axis(x, y)
    if (dir.y) dir.addScaledVector(this.camera.position.clone().sub(this.controls.target).normalize(), 1e-3) // off the pole, towards the old view
    this.viewFrom(dir)
  }

  /** The main axis nearest to the screen direction (`x` right, `y` up). */
  private axis(x: number, y: number) {
    const v = new THREE.Vector3(x, y, 0).applyQuaternion(this.camera.quaternion)
    const parts = [v.x, v.y, v.z], i = parts.reduce((best, c, k) => (Math.abs(c) > Math.abs(parts[best]) ? k : best), 0)
    return new THREE.Vector3().setComponent(i, Math.sign(parts[i]))
  }

  /** The user rotated away from a cube side: hide the arrows, back to perspective if the cube switched to orthographic. */
  private leaveSideView() {
    this.cubeWrap.classList.remove('aligned')
    if (!this.autoOrtho) return
    this.autoOrtho = false
    this.setOrthographic(false)
    this.onProjection()
  }

  /** Turns the camera to look from `dir` (same target and distance); `side`: straight at a cube side, switching to orthographic for it. */
  private viewFrom(dir: THREE.Vector3, side = true) {
    if (!side) this.leaveSideView()
    else this.cubeWrap.classList.add('aligned')
    if (side && !this.isOrthographic) {
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

  /** Sets the explode amount (see `explode`); only moves what is built, so dragging the slider stays fluid. */
  setExplode(v: number) {
    const landed = v === 0 && this.explode > 0
    this.explode = v
    cancelAnimationFrame(this.landing)
    this.landGap = 0
    this.move()
    if (landed) this.land()
  }

  setEditingZ(on: boolean) {
    if (on === this.editingZ) return
    this.editingZ = on
    if (this.last) this.update(...this.last)
  }

  private gap() {
    return this.explode ** 2 * Math.max(this.extent.x, this.extent.y) // squared: fine control at small gaps
  }

  /**
   * Animates the explode: the gap springs after `gap()` (`spring` rad/s, `damping` ratio), so the layers wobble when it stops.
   * Objects are thrown up when their layer slows faster than `gravity` (longer half case sides per s²), which waits `coyote` s after takeoff.
   */
  private move(spring = 30, damping = 0.4, gravity = 90, coyote = 0.17) {
    if (this.moving) return
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000), target = this.gap(), g = gravity * Math.max(this.extent.x, this.extent.y)
      last = now
      if (target === 0) this.shown = this.gapSpeed = 0 // land() bounces instead
      else {
        this.gapSpeed += (spring ** 2 * (target - this.shown) - 2 * damping * spring * this.gapSpeed) * dt
        this.shown += this.gapSpeed * dt
        if (this.shown < 0) [this.shown, this.gapSpeed] = [0, Math.max(0, this.gapSpeed)]
      }
      let flying = false
      for (const o of this.content.children) {
        const d = o.userData // h: height above its layer, v: own speed, air: time since takeoff
        if (d.h === undefined) continue
        const u = d.steps * this.gapSpeed // speed of its layer
        if (d.h === 0 && d.v - g * dt <= u) {
          d.v = u
          d.air = 0
          continue
        }
        d.air += dt
        if (d.air > coyote) d.v -= g * dt
        d.h = Math.max(0, d.h + (d.v - u) * dt)
        flying = true
      }
      this.applyExplode()
      this.draw()
      this.moving = flying || Math.abs(target - this.shown) > 0.01 || Math.abs(this.gapSpeed) > 0.01 ? requestAnimationFrame(step) : 0
    }
    this.moving = requestAnimationFrame(step)
  }

  /** The layers hop back up `hops` times, decaying, for `ms`; `height` is the first hop's gap per layer, as a fraction of the longer half case side. */
  private land(ms = 500, hops = 2, height = 0.03) {
    const start = performance.now(), size = height * Math.max(this.extent.x, this.extent.y)
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      this.landGap = size * Math.abs(Math.sin(hops * Math.PI * t)) * (1 - t) ** 2
      this.applyExplode()
      this.draw()
      if (t < 1) this.landing = requestAnimationFrame(step)
    }
    this.landing = requestAnimationFrame(step)
  }

  /** Lifts every built object by its steps of the gap, the lid split planes of objects along with them. */
  private applyExplode() {
    const gap = this.shown + this.landGap
    for (const o of this.content.children) {
      const { steps, lid, y0, h = 0 } = o.userData as { steps?: number; lid?: [THREE.Plane, THREE.Plane]; y0: number; h?: number }
      if (steps === undefined) continue
      const dy = y0 + steps * gap + h - o.position.y
      o.position.y += dy
      if (lid) {
        lid[0].constant += dy
        lid[1].constant -= dy
      }
    }
  }

  /** `current` is the layer shown in the top view; it is highlighted. */
  update(p: Project, layers: Layer[], selection: string[], current: number) {
    this.last = [p, layers, selection, current]
    this.extent = { x: Math.max(p.box.topL, p.box.bottomL) / 2, y: Math.max(p.box.topW, p.box.bottomW) / 2 }
    const { x: [x0, x1], y: [y0, y1] } = this.sectionBounds()
    const sectioned = [x0, x1, y0, y1].some(Number.isFinite) || this.inverted.x || this.inverted.y
    // the shown part as boxes [x0, x1, y0, y1]: an inverted axis shows both sides outside its range
    const spans = (a: number, b: number, inverted: boolean) => (inverted ? [[-Infinity, a], [b, Infinity]].filter(([s, e]) => s < e) : [[a, b]])
    const boxes = spans(x0, x1, this.inverted.x).flatMap(([a, b]) => spans(y0, y1, this.inverted.y).map(([c, d]) => [a, b, c, d]))
    // foam is cut as real geometry so its section faces are solid; objects use clipping planes (plan y is three z), the case stays whole
    const clamp = (v: number) => Math.max(-FAR, Math.min(FAR, v))
    const rects = boxes.map(([a, b, c, d]) => [{ x: clamp(a), y: clamp(c) }, { x: clamp(b), y: clamp(c) }, { x: clamp(b), y: clamp(d) }, { x: clamp(a), y: clamp(d) }])
    const cut = (v: number, normal: THREE.Vector3Tuple, point: THREE.Vector3Tuple) =>
      Number.isFinite(v) ? [new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...normal), new THREE.Vector3(...point))] : []
    const clips = boxes.map(([a, b, c, d]) => [...cut(a, [1, 0, 0], [a, 0, 0]), ...cut(b, [-1, 0, 0], [b, 0, 0]), ...cut(c, [0, 0, 1], [0, 0, c]), ...cut(d, [0, 0, -1], [0, 0, d])])

    this.content.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.content.clear()

    const foamTop = p.box.depth - stackTotal(p)
    // exploding lifts each object by `steps` gaps (see setExplode); it is built at gap 0
    const steps = (i: number) => layers.length - 1 - i
    const lifted = <T extends THREE.Object3D>(o: T, steps: number, lid?: [THREE.Plane, THREE.Plane]) =>
      (Object.assign(o.userData, { steps, lid, y0: o.position.y }), o)
    const thrown = <T extends THREE.Object3D>(o: T, steps: number, lid?: [THREE.Plane, THREE.Plane]) =>
      (Object.assign(lifted(o, steps, lid).userData, { h: 0, v: 0, air: 0 }), o)
    this.slabs = []
    for (const layer of layers) {
      let tree = layer.tree
      if (sectioned) {
        tree = new PolyTreeD()
        booleanOpDWithPolyTree(ClipType.Intersection, layer.paths, rects, tree, FillRule.EvenOdd, 3)
      }
      const shapes: THREE.Shape[] = []
      collectShapes(tree, shapes)
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: layer.b - layer.a, bevelEnabled: false })
      geo.rotateX(Math.PI / 2).translate(0, -(foamTop + layer.a), 0)
      const color = new THREE.Color(layer.material.color).lerp(new THREE.Color('#fff'), 0.35)
      const edges = new THREE.EdgesGeometry(geo, 30)
      const slab = lifted(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 })), steps(layer.index))
      slab.userData.layer = layer.index
      this.slabs.push(slab)
      const section = sectioned && sectionFaces(geo, [x0, x1].filter(Number.isFinite), [y0, y1].filter(Number.isFinite), color)
      if (section) this.content.add(lifted(section, steps(layer.index)))
      this.content.add(
        slab,
        lifted(layer.index === current
          ? new LineSegments2(new LineSegmentsGeometry().setPositions(edges.attributes.position.array as Float32Array), new LineMaterial({ color: this.accent, linewidth: CURRENT_LINE }))
          : new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: '#222' })), steps(layer.index)),
      )
      if (layer.index === current) edges.dispose()
    }
    const wanted: THREE.Mesh[] = [] // selected objects also where their Z asks for, if they sink or rise from there
    this.ghosts = p.items.flatMap(it => {
      // the item stands on (and explodes with) the layer below its cut, or on the case floor; a group moves with its deepest member
      const { z } = resting(p, it), h = itemHeight(it)
      const { layer } = resting(p, deepest(groupOf(p, it)))
      const bottom = -(foamTop + z + h), n = layer >= 0 ? steps(layer) : 0
      const selected = selection.includes(it.id), color = selected ? this.accent : OBJECT
      const moved = selected && Math.abs(z - it.z) > 0.01
      const opacity = moved && this.editingZ ? OPACITY.editing : OPACITY.strong
      const excess = -(foamTop + z + p.box.lidDepth) // how far it reaches above the closed lid
      // one copy per shown box, clipped to it
      return clips.flatMap(planes => {
        if (moved) {
          const g = ghost(it, -(foamTop + it.z + h), WANTED.color, planes, this.editingZ ? OPACITY.strong : OPACITY.faint)
          if (this.editingZ) outlined(g, 0x00ff00)
          wanted.push(thrown(g, n))
        }
        if (excess <= 0) return [thrown(ghost(it, bottom, color, planes, opacity), n)]
        // split at the lid ceiling (measured on the item, so it also holds in the exploded view): the part above is red
        const lid = bottom + h - excess
        const below = new THREE.Plane(new THREE.Vector3(0, -1, 0), lid), above = new THREE.Plane(new THREE.Vector3(0, 1, 0), -lid)
        return [
          thrown(ghost(it, bottom, color, [...planes, below], opacity), n, [below, above]),
          thrown(ghost(it, bottom, LID_HIT, [...planes, above], opacity), n),
        ]
      })
    })
    const shell = [...caseShell(p.box), ...(p.box.lidDepth > 0 ? lidShell(p.box) : [])]
    for (const g of this.ghosts) if (selection.includes(g.userData.id)) outlined(g)
    this.outlining = selection.length > 0
    this.ring.color.value.set(this.accent)
    this.content.add(...this.ghosts, ...wanted, ...shell)
    this.applyExplode()

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
