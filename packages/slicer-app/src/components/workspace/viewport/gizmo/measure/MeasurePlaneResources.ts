import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { MeasurePlane } from '@slicer/client';
import { attachBoundsTree, disposeBVHGeometry, type BVHBufferGeometry } from '../../GLVolume';

export interface MeasurePlaneResource {
  readonly geometry: BVHBufferGeometry;
  readonly matrix: THREE.Matrix4;
  readonly pick: THREE.Mesh;
}

/** The binary lease was copied by the client. These renderer-owned BVHs borrow
 * that array and are released whenever the corresponding plane disappears. */
export class MeasurePlaneResources {
  private readonly entries = new Map<string, MeasurePlaneResource>();
  private readonly material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

  sync(planes: ReadonlyMap<string, MeasurePlane>): void {
    for (const [id, entry] of this.entries) if (!planes.has(id)) {
      disposeBVHGeometry(entry.geometry); this.entries.delete(id);
    }
    for (const [id, plane] of planes) {
      if (this.entries.has(id)) continue;
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(plane.vertices, 3));
      const indexed = attachBoundsTree(geometry);
      const matrix = new THREE.Matrix4().fromArray(plane.transform);
      const pick = new THREE.Mesh(indexed, this.material);
      pick.matrixAutoUpdate = false; pick.matrix.copy(matrix); pick.updateMatrixWorld(true); pick.raycast = acceleratedRaycast;
      this.entries.set(id, { geometry: indexed, matrix, pick });
    }
  }

  get(id: string): MeasurePlaneResource | undefined { return this.entries.get(id); }
  dispose(): void {
    for (const entry of this.entries.values()) disposeBVHGeometry(entry.geometry);
    this.entries.clear(); this.material.dispose();
  }
}
