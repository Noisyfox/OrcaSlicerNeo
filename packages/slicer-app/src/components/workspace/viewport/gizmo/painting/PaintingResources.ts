import * as THREE from 'three';
import type { PaintingGeometry, PaintingGeometryResult, PaintingSessionMetadata } from '@slicer/client';

export interface PaintingResource {
  source: PaintingGeometry;
  geometry: THREE.BufferGeometry;
  contour: THREE.BufferGeometry;
}
/** Owns only painting buffers. Original-mesh BVHs are borrowed separately. */
export class PaintingResources {
  readonly resources = new Map<string, PaintingResource>();
  update(display: Extract<PaintingGeometryResult, { ok: true }>, session: PaintingSessionMetadata): boolean {
    if (display.sessionId !== session.id || display.revision !== session.revision) return false;
    const active = new Set([...display.parts, ...display.candidates].map((r) => r.resourceId));
    const incoming = new Map(display.resources.map((r) => [r.resourceId, r]));
    // Validate before disposal/publication; a partial manifest cannot blank the view.
    for (const id of active) if (!this.resources.has(id) && !incoming.has(id)) throw new Error(`Missing painting resource ${id}`);
    const created = new Map<string, PaintingResource>();
    try {
      for (const id of active) {
        if (this.resources.has(id)) continue;
        const source = incoming.get(id)!;
        const geometry = new THREE.BufferGeometry(), contour = new THREE.BufferGeometry();
        created.set(id, { source, geometry, contour });
        const buffer = new THREE.InterleavedBuffer(source.vertices, 6);
        geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
        geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
        source.groups.forEach(([, first, count], i) => geometry.addGroup(first, count, i));
        contour.setAttribute('position', new THREE.BufferAttribute(source.contour, 3));
      }
    } catch (error) { for (const r of created.values()) { r.geometry.dispose(); r.contour.dispose(); } throw error; }
    for (const [id, r] of this.resources) if (!active.has(id)) { r.geometry.dispose(); r.contour.dispose(); this.resources.delete(id); }
    created.forEach((r, id) => this.resources.set(id, r));
    return true;
  }
  dispose(): void { for (const r of this.resources.values()) { r.geometry.dispose(); r.contour.dispose(); } this.resources.clear(); }
}

export function paintingPartMatrix(session: PaintingSessionMetadata, volumeId: number): THREE.Matrix4 {
  const part = session.parts.find((p) => p.volumeId === volumeId);
  if (!part) throw new Error('Unknown painting part');
  return new THREE.Matrix4().fromArray(session.instanceTransform).multiply(new THREE.Matrix4().fromArray(part.volumeTransform));
}
