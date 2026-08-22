import * as THREE from 'three';
import type { ModelObjectBuffer, ModelTransform } from '@slicer/client';
import { matrixFromTransform, normalizeTransform } from './transformDeltaMath';

/** JavaScript equivalent of the native canvas GLVolume. */
export class GLVolume {
  readonly buffer: ModelObjectBuffer;
  readonly geometry: THREE.BufferGeometry;
  readonly id: string;
  instanceTransform: ModelTransform;
  volumeTransform: ModelTransform;

  // World-space AABB (tight over the actual transformed vertices) cached by
  // the composing matrix, OrcaSlicer-style. Recomputed only when the
  // instance/volume transform actually changes.
  private worldBoundsCache: { matrix: THREE.Matrix4; bounds: THREE.Box3 } | null = null;

  constructor(buffer: ModelObjectBuffer) {
    this.buffer = buffer;
    this.id = `${buffer.objectIdx}:${buffer.volumeIdx}:${buffer.instanceIdx}`;
    // Drop a redundant matrix from the bridge on clean transforms so the TRS
    // gizmo path stays cheap; sheared transforms keep the authoritative matrix.
    this.instanceTransform = normalizeTransform(structuredClone(buffer.instanceTransform));
    this.volumeTransform = normalizeTransform(structuredClone(buffer.volumeTransform));
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(buffer.positions, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(buffer.indices, 1));
    this.geometry.computeVertexNormals();
  }

  dispose(): void { this.geometry.dispose(); }

  /**
   * Tight world-space AABB over the actual transformed vertices.
   *
   * This mirrors OrcaSlicer's `Selection::get_bounding_box_in_reference_system`
   * (World reference system): every mesh vertex is transformed into world space
   * by the instance·volume matrix and the axis-aligned min/max is accumulated.
   * Unlike transforming the 8 corners of the local bounding box, the result
   * snaps to the rotated model instead of over-approximating around it. The
   * box stays axis-aligned with the world axes (it never rotates with the
   * model). Cached until the composing matrix changes.
   */
  getWorldBounds(): THREE.Box3 {
    const matrix = matrixFromTransform(this.instanceTransform)
      .multiply(matrixFromTransform(this.volumeTransform));
    const cached = this.worldBoundsCache;
    if (cached && cached.matrix.equals(matrix)) return cached.bounds;

    const position = this.geometry.getAttribute('position');
    const bounds = new THREE.Box3().makeEmpty();
    const vertex = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
      bounds.expandByPoint(vertex);
    }
    this.worldBoundsCache = { matrix, bounds };
    return bounds;
  }
}

/** Renderer-only plate state. It is synchronized to WASM only before slice. */
export const glVolumeCollection = {
  volumes: [] as GLVolume[],
  replace(volumes: GLVolume[]) {
    this.volumes.forEach((v) => v.dispose());
    this.volumes = volumes;
  },
  clear() { this.replace([]); },
};
