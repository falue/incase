import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PolyPathD } from 'clipper2-ts'
import type { Layer } from './geometry'
import { itemHeight, type Item, type Project } from './model'

// Plan (x, y) maps to three (x, z); depth from the foam top goes down along -y.

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

function ghost(it: Item): THREE.Mesh {
  const r = it.d / 2
  const geo =
    it.shape === 'box' ? new THREE.BoxGeometry(it.l, it.h, it.w)
    : it.shape === 'cylinder' ? new THREE.CylinderGeometry(r, r, it.h, 48)
    : it.shape === 'lying' ? new THREE.CylinderGeometry(r, r, it.l, 48).rotateZ(Math.PI / 2)
    : new THREE.SphereGeometry(r, 48, 24)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#ff9a3c', transparent: true, opacity: 0.5, depthWrite: false }))
  mesh.position.set(it.x, -(it.z + itemHeight(it) / 2), it.y)
  mesh.rotation.y = (-it.rot * Math.PI) / 180
  return mesh
}

export class View3D {
  /** Extra vertical gap between layers in mm. */
  explode = 0
  private renderer = new THREE.WebGLRenderer({ antialias: true })
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 20000)
  private controls = new OrbitControls(this.camera, this.renderer.domElement)
  private content = new THREE.Group()
  private fitted = false

  constructor(private host: HTMLElement) {
    this.renderer.setPixelRatio(devicePixelRatio)
    host.append(this.renderer.domElement)
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(300, 800, 500)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6), sun, this.content)
    this.controls.addEventListener('change', () => this.draw())
    new ResizeObserver(() => this.resize()).observe(host)
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color)
    this.draw()
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.draw()
  }

  private draw() {
    this.renderer.render(this.scene, this.camera)
  }

  update(p: Project, layers: Layer[]) {
    this.content.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    this.content.clear()

    for (const layer of layers) {
      const shapes: THREE.Shape[] = []
      collectShapes(layer.tree, shapes)
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: layer.b - layer.a, bevelEnabled: false })
      geo.rotateX(Math.PI / 2).translate(0, -layer.a - layer.index * this.explode, 0)
      const color = new THREE.Color(layer.material.color).lerp(new THREE.Color('#fff'), 0.35)
      this.content.add(
        new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 })),
        new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: '#222' })),
      )
    }
    for (const it of p.items) this.content.add(ghost(it))

    if (!this.fitted) {
      this.fitted = true
      const size = Math.max(p.box.topL, p.box.topW)
      this.camera.position.set(0, size * 0.9, size * 1.1)
      this.controls.target.set(0, -p.box.depth / 2, 0)
      this.controls.update()
    }
    this.draw()
  }
}
