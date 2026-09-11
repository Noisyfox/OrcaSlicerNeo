import * as THREE from 'three';
import type { ModelObjectBuffer, ModelTransform } from '@slicer/client';
import { matrixFromTransform, normalizeTransform } from './transformDeltaMath';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

type RevisionWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const revisionWaiters = new Map<number, Set<RevisionWaiter>>();

/**
 * Wait for the renderer to publish the mesh replacement for one model
 * revision.  History restore uses this instead of guessing when React's
 * loader effect has finished; an older revision is rejected as soon as a
 * newer replacement wins.
 */
export function waitForGLVolumeRevision(revision: number): Promise<void> {
  if (glVolumeCollection.revision === revision) return Promise.resolve();
  if (glVolumeCollection.revision > revision)
    return Promise.reject(new Error(`GL mesh revision ${revision} was superseded`));
  return new Promise<void>((resolve, reject) => {
    const waiters = revisionWaiters.get(revision) ?? new Set<RevisionWaiter>();
    waiters.add({ resolve, reject });
    revisionWaiters.set(revision, waiters);
  });
}

function settleRevisionWaiters(revision: number): void {
  for (const [waitedRevision, waiters] of revisionWaiters) {
    if (waitedRevision > revision) continue;
    revisionWaiters.delete(waitedRevision);
    const error = waitedRevision === revision
      ? null
      : new Error(`GL mesh revision ${waitedRevision} was superseded`);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}

export function rejectGLVolumeRevision(revision: number, error: unknown): void {
  const waiters = revisionWaiters.get(revision);
  if (!waiters) return;
  revisionWaiters.delete(revision);
  const normalized = error instanceof Error ? error : new Error(String(error));
  for (const waiter of waiters) waiter.reject(normalized);
}

/** JavaScript equivalent of the native canvas GLVolume. */
export class GLVolume {
  /** Orca keeps wipe towers in the shared GL volume collection, distinguished
   * only by an identity flag.  Model volumes remain the default. */
  kind: 'model' | 'wipe-tower' = 'model';
  selectable = true;
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

    // Set up BVH for faster raycasting.
    this.geometry.computeBoundsTree = computeBoundsTree;
    this.geometry.disposeBoundsTree = disposeBoundsTree;
    this.geometry.computeBoundsTree();
  }

  dispose(): void {
    this.geometry.disposeBoundsTree();
    this.geometry.dispose();
  }

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
  revision: 0,
  replace(volumes: GLVolume[], revision?: number) {
    this.volumes.forEach((v) => v.dispose());
    this.volumes = volumes;
    this.revision = revision ?? glVolumeCollection.revision + 1;
    settleRevisionWaiters(this.revision);
  },
  clear(revision?: number) { this.replace([], revision); },
};
