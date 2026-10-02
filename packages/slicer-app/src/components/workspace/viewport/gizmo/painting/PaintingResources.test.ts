import { describe, expect, it, vi } from 'vitest';
import type { PaintingGeometry, PaintingGeometryResult, PaintingSessionMetadata } from '@slicer/client';
import { PaintingResources, paintingPartMatrix } from './PaintingResources';
import { paintingCursorMeshes } from './PaintingGizmoBase';
import type { LoadedObject } from '@/components/workspace/viewport/useModelLoader';
import * as THREE from 'three';
const identity = new THREE.Matrix4().toArray();
const session: PaintingSessionMetadata = { id: 'ps-1', historySessionId: 'hs-1', revision: 1, objectId: 1, instanceId: 2, phase: 'idle', strokeId: null, channel: 'mmu', instanceTransform: identity, parts: [{ volumeId: 3, volumeTransform: identity, sourceTriangleCount: 1, annotationTimestamp: 0, draftResourceId: 'a', facetCounts: [] }] };
function resource(id: string, kind: 'draft' | 'region' | 'gap' = 'draft'): PaintingGeometry { return { resourceId: id, volumeId: 3, kind, vertices: new Float32Array(18), groups: [[0, 0, 3]], contour: new Float32Array(kind === 'region' ? 6 : 0) }; }
function display(resources: PaintingGeometry[], draft: string, candidates: string[] = [], revision = 1): Extract<PaintingGeometryResult, { ok: true }> { return { ok: true, version: 1, channel: 'mmu' as const, sessionId: 'ps-1', revision, parts: [{ volumeId: 3, resourceId: draft }], candidates: candidates.map((id) => ({ volumeId: 3, resourceId: id, kind: 'region' })), resources }; }
describe('painting display resources', () => {
  it('reuses unchanged geometry, replaces changed parts in full and disposes dropped candidate buffers', () => {
    const cache = new PaintingResources(); cache.update(display([resource('a'), resource('c', 'region')], 'a', ['c']), session);
    const original = cache.resources.get('a')!, candidate = cache.resources.get('c')!;
    const candidateGeometry = vi.spyOn(candidate.geometry, 'dispose'), contour = vi.spyOn(candidate.contour, 'dispose');
    cache.update(display([], 'a'), session);
    expect(cache.resources.get('a')).toBe(original); expect(candidateGeometry).toHaveBeenCalledTimes(1); expect(contour).toHaveBeenCalledTimes(1);
    const old = vi.spyOn(original.geometry, 'dispose'); cache.update(display([resource('b')], 'b'), session);
    expect(old).toHaveBeenCalledTimes(1); expect(cache.resources.has('a')).toBe(false);
    expect(cache.resources.get('b')!.geometry).not.toHaveProperty('boundsTree');
    const final = vi.spyOn(cache.resources.get('b')!.geometry, 'dispose'); cache.dispose(); cache.dispose(); expect(final).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong channel/session/revision and missing resource atomically', () => {
    const cache = new PaintingResources(); cache.update(display([resource('a')], 'a'), session); const original = cache.resources.get('a');
    expect(cache.update(display([resource('b')], 'b', [], 2), session)).toBe(false);
    expect(cache.update({ ...display([resource('b')], 'b'), sessionId: 'ps-2' }, session)).toBe(false);
    expect(cache.update({ ...display([resource('b')], 'b'), channel: 'support' }, session)).toBe(false);
    expect(() => cache.update(display([], 'missing'), session)).toThrow('Missing painting resource'); expect(cache.resources.get('a')).toBe(original); cache.dispose();
  });
  it('retains native NONE/same-color candidate membership independently of groups', () => {
    const cache = new PaintingResources(); cache.update(display([resource('a'), resource('c', 'region')], 'a', ['c']), session);
    expect(cache.resources.get('c')!.source.groups).toEqual([[0, 0, 3]]); expect(cache.resources.size).toBe(2); cache.dispose();
  });
  it('composes native instance and volume matrices including mirrored nonuniform transforms', () => {
    const instance = new THREE.Matrix4().makeTranslation(20, 30, 40).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    const volume = new THREE.Matrix4().makeScale(-2, 3, 4);
    const transformed = { ...session, instanceTransform: instance.toArray(), parts: [{ ...session.parts[0], volumeTransform: volume.toArray() }] };
    expect(new THREE.Vector3(1, 2, 3).applyMatrix4(paintingPartMatrix(transformed, 3)).toArray()).toEqual([14, 28, 52]);
  });
});


describe('borrowed painting cursor geometry and transform identity', () => {
  it('retains cursor meshes and bounds dependencies across value-equal RGB/config metadata reads, and replaces only changed transforms/geometry', () => {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 2, 0, 0], 3));
    const material = new THREE.MeshBasicMaterial();
    const source = { geometry, buffer: { objectId: 1, instanceId: 2, volumeId: 3 } } as unknown as LoadedObject;
    const original = paintingCursorMeshes([], [source], session, material);
    // This is the exact dependency used by the height cursor's tight-bounds
    // memo and by the pointer listener effect. Palette/config RPCs reconstruct
    // all arrays but cannot trigger a new vertex scan or listener teardown.
    const equivalent = { ...session, revision: 9, instanceTransform: [...session.instanceTransform], parts: session.parts.map((p) => ({ ...p, volumeTransform: [...p.volumeTransform] })) };
    expect(paintingCursorMeshes(original, [source], equivalent, material)).toBe(original);
    const transformed = { ...equivalent, instanceTransform: new THREE.Matrix4().makeTranslation(5, 6, 7).toArray() };
    const moved = paintingCursorMeshes(original, [source], transformed, material);
    expect(moved).not.toBe(original); expect(moved[0]).not.toBe(original[0]); expect(moved[0].geometry).toBe(geometry);
    expect(original[0].matrix.elements).toEqual(identity); expect(moved[0].matrix.elements.slice(12, 15)).toEqual([5, 6, 7]);
    expect(paintingCursorMeshes(moved, [source], { ...transformed, instanceTransform: [...transformed.instanceTransform] }, material)).toBe(moved);
    const replacement = geometry.clone();
    const changed = paintingCursorMeshes(moved, [{ ...source, geometry: replacement } as LoadedObject], transformed, material);
    expect(changed[0].geometry).toBe(replacement); expect(changed).not.toBe(moved);
    expect(paintingCursorMeshes(changed, [], undefined, material)).toEqual([]);
    expect(geometry.getAttribute('position').count).toBe(3); geometry.dispose(); replacement.dispose(); material.dispose();
  });
});
