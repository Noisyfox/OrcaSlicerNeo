import * as THREE from 'three';
import type { ModelObjectBuffer, ModelTransform } from '@slicer/client';

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
    this.instanceTransform = structuredClone(buffer.instanceTransform);
    this.volumeTransform = structuredClone(buffer.volumeTransform);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(buffer.positions, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(buffer.indices, 1));
    this.geometry.computeVertexNormals();
  }

  setInstanceOffset(offset: [number, number, number]): void {
    this.instanceTransform.offset = [...offset] as [number, number, number];
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
