import * as THREE from 'three';
import type { ModelObjectBuffer, ModelTransform, ModelGeometry } from '@slicer/client';
import { matrixFromTransform, normalizeTransform } from './transformDeltaMath';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

/** BufferGeometry with the three-mesh-bvh extensions installed. */
export type BVHBufferGeometry = THREE.BufferGeometry & {
  boundsTree?: unknown;
  computeBoundsTree: typeof computeBoundsTree;
  disposeBoundsTree: typeof disposeBoundsTree;
};

/** Install and build the same BVH used by ordinary model volumes. */
export function attachBoundsTree(geometry: THREE.BufferGeometry): BVHBufferGeometry {
  const bvhGeometry = geometry as BVHBufferGeometry;
  bvhGeometry.computeBoundsTree = computeBoundsTree;
  bvhGeometry.disposeBoundsTree = disposeBoundsTree;
  bvhGeometry.computeBoundsTree();
  return bvhGeometry;
}

/** Release both the BVH and the GPU-side geometry owned by the caller. */
export function disposeBVHGeometry(geometry: BVHBufferGeometry): void {
  geometry.disposeBoundsTree();
  geometry.dispose();
}

export type GeometryOwnership = { kind: 'shared'; key: string } | { kind: 'exclusive' };
type GeometryResource = { geometry: THREE.BufferGeometry; buffer: ModelGeometry; refs: number };
const geometryResources = new Map<string, GeometryResource>();

function buildGeometry(buffer: Pick<ModelObjectBuffer, 'positions' | 'indices'>): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  try {
    geometry.setAttribute('position', new THREE.BufferAttribute(buffer.positions, 3));
    // BVH construction may reorder indices; keep the immutable source untouched.
    geometry.setIndex(new THREE.BufferAttribute(buffer.indices.slice(), 1));
    geometry.computeVertexNormals();
    attachBoundsTree(geometry);
    return geometry;
  } catch (error) { geometry.dispose(); throw error; }
}
function releaseGeometry(key: string): void {
  const resource = geometryResources.get(key);
  if (!resource) throw new Error(`missing owned geometry ${key}`);
  if (--resource.refs === 0) {
    geometryResources.delete(key);
    disposeBVHGeometry(resource.geometry as BVHBufferGeometry);
  }
}
export function retainedGeometry(key: string): ModelGeometry | undefined {
  return geometryResources.get(key)?.buffer;
}
/** Pin exactly the advertised resources across the asynchronous Worker read. */
export function leaseGeometry(keys: readonly string[]): () => void {
  const pinned = [...new Set(keys)];
  for (const key of pinned) if (!geometryResources.has(key)) throw new Error(`missing geometry ${key}`);
  for (const key of pinned) geometryResources.get(key)!.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of pinned) releaseGeometry(key);
  };
}

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

  private disposed = false;

  constructor(buffer: ModelObjectBuffer, readonly ownership: GeometryOwnership) {
    this.buffer = buffer;
    this.id = `${buffer.objectId}:${buffer.volumeId}:${buffer.instanceId}`;
    // Drop a redundant matrix from the bridge on clean transforms so the TRS
    // gizmo path stays cheap; sheared transforms keep the authoritative matrix.
    this.instanceTransform = normalizeTransform(structuredClone(buffer.instanceTransform));
    this.volumeTransform = normalizeTransform(structuredClone(buffer.volumeTransform));
    if (ownership.kind === 'shared') {
      let resource = geometryResources.get(ownership.key);
      if (!resource) {
        resource = { geometry: buildGeometry(buffer), refs: 0,
          buffer: { geometryKey: ownership.key, volumeId: buffer.volumeId,
            positions: buffer.positions, indices: buffer.indices,
            vertexCount: buffer.vertexCount, indexCount: buffer.indexCount } };
        geometryResources.set(ownership.key, resource);
      }
      resource.refs++;
      this.buffer = { ...buffer, positions: resource.buffer.positions, indices: resource.buffer.indices,
        vertexCount: resource.buffer.vertexCount, indexCount: resource.buffer.indexCount };
      this.geometry = resource.geometry;
    } else this.geometry = buildGeometry(buffer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownership.kind === 'shared') releaseGeometry(this.ownership.key);
    else disposeBVHGeometry(this.geometry as BVHBufferGeometry);
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
  listeners: new Set<(volumes: readonly GLVolume[]) => void>(),
  publish() {
    for (const listener of this.listeners) listener(this.volumes);
  },
  subscribe(listener: (volumes: readonly GLVolume[]) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  },
  replace(volumes: GLVolume[], revision?: number) {
    this.volumes.forEach((v) => v.dispose());
    this.volumes = volumes;
    this.revision = revision ?? glVolumeCollection.revision + 1;
    settleRevisionWaiters(this.revision);
    this.publish();
  },
  /** Publish one validated stable-ID patch while retaining untouched meshes. */
  patch(volumes: GLVolume[], revision: number) {
    const retained = new Set(volumes);
    this.volumes.forEach((volume) => {
      if (!retained.has(volume)) volume.dispose();
    });
    this.volumes = volumes;
    this.revision = revision;
    settleRevisionWaiters(revision);
    this.publish();
  },
  clear(revision?: number) { this.replace([], revision); },
};
