import { Camera, DoubleSide, EdgesGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { GLVolume } from '../../GLVolume';
import { matrixFromTransform } from '../../transformDeltaMath';
import { measurePointPickRadius } from '../measure/measureHitTest';

export class CutVertices {
  private readonly points: Vector3[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly material = new MeshBasicMaterial({ side: DoubleSide });
  private readonly ray = new Raycaster();
  private view = '';
  private cells = new Map<string, { point: Vector3; x: number; y: number; depth: number }[]>();
  constructor(volumes: readonly Pick<GLVolume, 'geometry' | 'instanceTransform' | 'volumeTransform'>[]) {
    this.ray.firstHitOnly = true;
    for (const volume of volumes) {
      const matrix = matrixFromTransform(volume.instanceTransform).multiply(matrixFromTransform(volume.volumeTransform));
      const mesh = new Mesh(volume.geometry, this.material);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix); mesh.updateMatrixWorld(true);
      mesh.raycast = acceleratedRaycast; this.meshes.push(mesh);
      const edges = new EdgesGeometry(volume.geometry);
      const attr = edges.getAttribute('position');
      const vertices = new Map<string, { point: Vector3; directions: Vector3[] }>();
      const add = (p: Vector3, q: Vector3) => {
        const key = p.toArray().join(',');
        const vertex = vertices.get(key) ?? { point: p, directions: [] };
        vertex.directions.push(q.clone().sub(p).normalize()); vertices.set(key, vertex);
      };
      for (let i = 0; i < attr.count; i += 2) {
        const a = new Vector3().fromBufferAttribute(attr, i), b = new Vector3().fromBufferAttribute(attr, i + 1);
        add(a,b); add(b,a);
      }
      edges.dispose();
      for (const { point, directions } of vertices.values()) {
        if (directions.length === 2 && directions[0].dot(directions[1]) < -0.99999) continue;
        this.points.push(point.applyMatrix4(matrix));
      }
    }
  }
  pick(event: Pick<PointerEvent, 'clientX' | 'clientY'>, rect: DOMRect, camera: Camera): Vector3 | null {
    if (!rect.width || !rect.height) return null;
    const r = measurePointPickRadius;
    camera.updateMatrixWorld();
    const key = [rect.width,rect.height,...camera.matrixWorld.elements,...camera.projectionMatrix.elements].join(',');
    if (key !== this.view) {
      this.view = key; this.cells.clear();
      for (const point of this.points) {
        const p = point.clone().project(camera);
        if (!Number.isFinite(p.z) || Math.abs(p.z) > 1) continue;
        const x = (1+p.x)*rect.width/2, y = (1-p.y)*rect.height/2;
        const cell = Math.floor(x/r) + ',' + Math.floor(y/r);
        const items = this.cells.get(cell) ?? [];
        items.push({ point, x, y, depth: p.z }); this.cells.set(cell, items);
      }
    }
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const candidates = [];
    for (let i = -1; i <= 1; ++i) for (let j = -1; j <= 1; ++j) {
      const items = this.cells.get((Math.floor(x/r)+i) + ',' + (Math.floor(y/r)+j));
      for (const item of items ?? []) {
        const distance = Math.hypot(item.x-x, item.y-y);
        if (distance <= r) candidates.push({ ...item, distance });
      }
    }
    for (const item of candidates.sort((a,b) => a.distance-b.distance || a.depth-b.depth)) {
      this.ray.setFromCamera(new Vector2(2*item.x/rect.width-1, 1-2*item.y/rect.height), camera);
      const hit = this.ray.intersectObjects(this.meshes, false)[0];
      if (!hit || hit.distance + 1e-4 >= this.ray.ray.origin.distanceTo(item.point)) return item.point;
    }
    return null;
  }
  dispose() { this.material.dispose(); }
}
