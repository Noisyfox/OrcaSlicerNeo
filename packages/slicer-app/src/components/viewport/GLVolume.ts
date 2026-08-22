import * as THREE from 'three';
import type { ModelObjectBuffer, ModelTransform } from '@slicer/client';
import { normalizeTransform } from './transformDeltaMath';

/** JavaScript equivalent of the native canvas GLVolume. */
export class GLVolume {
  readonly buffer: ModelObjectBuffer;
  readonly geometry: THREE.BufferGeometry;
  readonly id: string;
  instanceTransform: ModelTransform;
  volumeTransform: ModelTransform;

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
