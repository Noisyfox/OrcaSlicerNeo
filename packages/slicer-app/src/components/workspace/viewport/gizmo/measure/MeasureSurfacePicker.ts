import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { GLVolume } from '../../GLVolume';
import { matrixFromTransform } from '../../transformDeltaMath';

/** Borrow original source geometry without trusting renderer face indices or
 * material culling. The native press always confirms the actual hit. */
export class MeasureSurfacePicker {
  private readonly material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  private readonly meshes = new Map<GLVolume, THREE.Mesh>();
  private readonly ray = new THREE.Raycaster();

  constructor() { this.ray.firstHitOnly = true; }

  hits(event: Pick<PointerEvent, 'clientX' | 'clientY'>, rect: DOMRect, camera: THREE.Camera,
    volumes: readonly GLVolume[], planes: readonly THREE.Mesh[]): boolean {
    if (!rect.width || !rect.height) return true;
    const current = new Set(volumes);
    for (const volume of this.meshes.keys()) if (!current.has(volume)) this.meshes.delete(volume);
    const models: THREE.Mesh[] = [];
    for (const volume of volumes) {
      if (!volume.geometry.boundsTree) return true;
      let mesh = this.meshes.get(volume);
      if (!mesh) {
        mesh = new THREE.Mesh(volume.geometry, this.material); mesh.matrixAutoUpdate = false; mesh.raycast = acceleratedRaycast;
        this.meshes.set(volume, mesh);
      }
      mesh.matrix.copy(matrixFromTransform(volume.instanceTransform).multiply(matrixFromTransform(volume.volumeTransform)));
      if (!mesh.matrix.elements.every(Number.isFinite) || mesh.matrix.determinant() === 0) return true;
      mesh.updateMatrixWorld(true); models.push(mesh);
    }
    camera.updateMatrixWorld();
    this.ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2), camera);
    return this.ray.intersectObjects([...models, ...planes], false).length > 0;
  }

  dispose(): void { this.meshes.clear(); this.material.dispose(); }
}
