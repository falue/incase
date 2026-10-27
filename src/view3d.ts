import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import type { PolyPathD } from 'clipper2-ts'
import { caseSection, roundedRect, stackTotal, type Layer } from './geometry'
import { itemHeight, type CaseDims, type Item, type Project } from './model'

// Plan (x, y) maps to three (x, z); y = 0 is the case top, the case floor is at y = -depth.

const PER_CORNER = 8 // arc segments per corner of the case shell
const CASE_LINE = 2.5 // px

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

/** `top` is the three y of the foam top the item hangs from. */
function ghost(it: Item, top: number, selected: boolean): THREE.Mesh {
  const r = it.d / 2
  const geo =
    it.shape === 'box' ? new THREE.BoxGeometry(it.l, it.h, it.w)
    : it.shape === 'cylinder' ? new THREE.CylinderGeometry(r, r, it.h, 48)
    : it.shape === 'lying' ? new THREE.CylinderGeometry(r, r, it.l, 48).rotateZ(Math.PI / 2)
    : new THREE.SphereGeometry(r, 48, 24)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: selected ? '#3d8bff' : '#ff9a3c', transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }))
  mesh.position.set(it.x, top - it.z - itemHeight(it) / 2, it.y)
  mesh.rotation.y = (-it.rot * Math.PI) / 180
  mesh.userData.id = it.id
  return mesh
}

/** Translucent cavity walls + floor, lofted through rings that follow the taper and the bottom edge radius. */
function caseShell(box: CaseDims): THREE.Object3D[] {
  const R = Math.min(box.bottomRadius, box.depth)
  const depths = R > 0 ? [0, ...Array.from({ length: 7 }, (_, i) => box.depth - R + (R * i) / 6)] : [0, box.depth]
  const rings = depths.map(z => {
    const s = caseSection(box, z)
    return roundedRect(Math.max(s.l, 0.01), Math.max(s.w, 0.01), s.r, PER_CORNER)!.map(p => new THREE.Vector3(p.x, -z, p.y))
  })
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
  const floor = new THREE.ShapeGeometry(new THREE.Shape(rings.at(-1)!.map(p => new THREE.Vector2(p.x, p.z))))
  floor.rotateX(Math.PI / 2).translate(0, -box.depth, 0)

  // top and floor rings plus the vertical lines where the corner arcs start and end
  const lines: THREE.Vector3[] = []
  for (const ring of [rings[0], rings.at(-1)!]) ring.forEach((p, i) => lines.push(p, ring[(i + 1) % n]))
  for (let c = 0; c < 4; c++) {
    for (const i of [c * (PER_CORNER + 1), c * (PER_CORNER + 1) + PER_CORNER]) {
      for (let k = 0; k < rings.length - 1; k++) lines.push(rings[k][i], rings[k + 1][i])
    }
  }

  const surface = () => new THREE.MeshBasicMaterial({ color: '#7f8fa3', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
  return [
    new THREE.Mesh(walls, surface()),
    new THREE.Mesh(floor, surface()),
    new LineSegments2(
      new LineSegmentsGeometry().setPositions(lines.flatMap(p => p.toArray())),
      new LineMaterial({ color: '#7f8fa3', linewidth: CASE_LINE }),
    ),
  ]
}

export class View3D {
  /** Extra vertical gap between layers in mm; the bottom layer stays on the floor. */
  explode = 0
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
  private box: CaseDims | null = null

  constructor(private host: HTMLElement, onSelect: (id: string | null) => void) {
    this.renderer.setPixelRatio(devicePixelRatio)
    const canvas = this.renderer.domElement
    host.append(canvas)
    // a click without dragging selects the object under the pointer
    let down = { x: 0, y: 0 }
    canvas.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }))
    canvas.addEventListener('pointerup', e => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      const r = canvas.getBoundingClientRect()
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera)
      onSelect(ray.intersectObjects(this.ghosts)[0]?.object.userData.id ?? null)
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
    this.applySections()
    this.draw()
  }

  /** Clipping planes for the section ranges; plan y is three z. Ranges at the slider ends add no plane. */
  private applySections() {
    const planes: THREE.Plane[] = []
    for (const [axis, normal] of [['x', new THREE.Vector3(1, 0, 0)], ['y', new THREE.Vector3(0, 0, 1)]] as const) {
      const [from, to] = this.sections[axis], e = this.extent[axis]
      if (from > 0) planes.push(new THREE.Plane(normal.clone(), -(2 * from - 1) * e))
      if (to < 1) planes.push(new THREE.Plane(normal.clone().negate(), (2 * to - 1) * e))
    }
    this.renderer.clippingPlanes = planes
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color)
    this.draw()
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
  }

  update(p: Project, layers: Layer[], selectedId: string | null) {
    this.content.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.content.clear()

    const foamTop = p.box.depth - stackTotal(p)
    const shift = (i: number) => (layers.length - 1 - i) * this.explode
    for (const layer of layers) {
      const shapes: THREE.Shape[] = []
      collectShapes(layer.tree, shapes)
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: layer.b - layer.a, bevelEnabled: false })
      geo.rotateX(Math.PI / 2).translate(0, -(foamTop + layer.a) + shift(layer.index), 0)
      const color = new THREE.Color(layer.material.color).lerp(new THREE.Color('#fff'), 0.35)
      this.content.add(
        new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide })),
        new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: '#222' })),
      )
    }
    this.ghosts = p.items.map(it => {
      // the item moves with the layer its top lies in
      const i = layers.findIndex(l => it.z < l.b)
      return ghost(it, -foamTop + (layers.length ? shift(i < 0 ? layers.length - 1 : i) : 0), it.id === selectedId)
    })
    if (this.ghosts.length) this.content.add(...this.ghosts)
    this.content.add(...caseShell(p.box))
    this.extent = { x: Math.max(p.box.topL, p.box.bottomL) / 2, y: Math.max(p.box.topW, p.box.bottomW) / 2 }
    this.applySections()

    if (!this.box) {
      this.box = p.box
      this.fit()
    }
    this.box = p.box
    this.draw()
  }

  /** Frames the whole case from the front-top. */
  fit() {
    if (!this.box) return
    const box = this.box
    const size = Math.max(box.topL, box.topW, box.depth)
    this.viewHeight = size * 1.3
    const { clientWidth: w, clientHeight: h } = this.host
    this.updateFrustums(h ? w / h : 1)
    for (const cam of [this.perspective, this.orthographic]) cam.position.set(0, size * 0.9, size * 1.1)
    this.orthographic.zoom = 1
    this.orthographic.updateProjectionMatrix()
    this.controls.target.set(0, -box.depth / 2, 0)
    this.controls.update()
    this.draw()
  }
}
