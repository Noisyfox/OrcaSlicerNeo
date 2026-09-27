import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMeshResult } from '@slicer/client';
import {
  capturePreviewFirstCommitPaintMaterials,
  recordModelMeshResponse,
  registerModelLoadingProbeOwner,
  releasePreviewFirstCommitPaintMaterials,
} from './modelLoadingProbe';

describe('model loading E2E probe', () => {
  let target: Window;

  beforeEach(() => {
    target = {} as Window;
    vi.stubGlobal('window', target);
  });

  afterEach(() => {
    delete target.__orcaE2e;
    vi.unstubAllGlobals();
  });

  it('publishes the same model response fields and resets first-commit snapshots per load', () => {
    const unregister = registerModelLoadingProbeOwner();
    const volume = createVolume('old-volume', 1, 2, 3, [0]);
    const group = createPaintGroup(new THREE.MeshStandardMaterial({ color: '#ff0000' }));
    capturePreviewFirstCommitPaintMaterials(volume, group, 1, {});

    const result = {
      ok: true,
      objects: [{
        volumeId: 7,
        objectId: 11,
        instanceId: 13,
        geometryKey: 'geometry-v2',
        paintGeometryKey: 'paint-v4',
      }],
      paintGeometries: [{
        volumeId: 7,
        paintGeometryKey: 'paint-v4',
        indexCount: 6,
        drawGroups: [{ stateId: 0, startIndex: 0, indexCount: 6 }],
      }],
    } as unknown as ModelMeshResult;
    recordModelMeshResponse(result);

    expect(target.__orcaE2e?.modelMeshResponse?.()).toEqual({
      objects: [{
        volumeId: 7,
        objectId: 11,
        instanceId: 13,
        geometryKey: 'geometry-v2',
        paintGeometryKey: 'paint-v4',
      }],
      paintGeometries: [{
        volumeId: 7,
        paintGeometryKey: 'paint-v4',
        indexCount: 6,
        drawGroups: [{ stateId: 0, startIndex: 0, indexCount: 6 }],
      }],
    });
    expect(target.__orcaE2e?.previewFirstCommitPaintMaterialsByVolume).toEqual({});

    unregister();
    group.clear();
  });

  it('keeps first-commit snapshots by volume and releases only the matching owners', () => {
    const unregister = registerModelLoadingProbeOwner();
    const ownerA = {};
    const ownerASecondMount = {};
    const ownerB = {};
    const volumeA = createVolume('volume-a', 4, 5, 6, [0, 2]);
    const volumeB = createVolume('volume-b', 7, 8, 9, [1]);
    const groupA = createPaintGroup([
      new THREE.MeshStandardMaterial({ color: '#ff0000', opacity: 0.15, transparent: true, depthWrite: false }),
      new THREE.MeshStandardMaterial({ color: '#00ff00', opacity: 0.15, transparent: true, depthWrite: false }),
    ]);
    const groupB = createPaintGroup(new THREE.MeshStandardMaterial({ color: '#0000ff' }));

    capturePreviewFirstCommitPaintMaterials(volumeA, groupA, 2, ownerA);
    capturePreviewFirstCommitPaintMaterials(volumeA, createPaintGroup(new THREE.MeshStandardMaterial({ color: '#ffffff' })), 2, ownerASecondMount);
    capturePreviewFirstCommitPaintMaterials(volumeB, groupB, 1, ownerB);

    const snapshots = target.__orcaE2e?.previewFirstCommitPaintMaterialsByVolume;
    expect(snapshots?.['volume-a']).toEqual([
      expect.objectContaining({ id: 'volume-a', objectIndex: 4, volumeIndex: 5, instanceIndex: 6, stateId: 0, colour: '#ff0000' }),
      expect.objectContaining({ id: 'volume-a', objectIndex: 4, volumeIndex: 5, instanceIndex: 6, stateId: 2, colour: '#00ff00' }),
    ]);
    expect(snapshots?.['volume-b']).toEqual([
      expect.objectContaining({ id: 'volume-b', stateId: 1, colour: '#0000ff' }),
    ]);

    releasePreviewFirstCommitPaintMaterials('volume-a', ownerA);
    expect(snapshots?.['volume-a']).toHaveLength(2);
    expect(snapshots?.['volume-b']).toHaveLength(1);
    releasePreviewFirstCommitPaintMaterials('volume-a', ownerASecondMount);
    expect(snapshots?.['volume-a']).toBeUndefined();
    expect(snapshots?.['volume-b']).toHaveLength(1);
    releasePreviewFirstCommitPaintMaterials('volume-b', ownerB);
    expect(snapshots).toEqual({});

    unregister();
    groupA.clear();
    groupB.clear();
  });

  it('keeps the probe registered until its last loader owner unmounts', () => {
    const unrelatedHook = () => 'scene';
    target.__orcaE2e = { sceneProbe: unrelatedHook };
    const unregisterFirst = registerModelLoadingProbeOwner();
    const unregisterSecond = registerModelLoadingProbeOwner();

    unregisterFirst();
    expect(target.__orcaE2e?.modelMeshResponse).toBeTypeOf('function');
    expect(target.__orcaE2e?.sceneProbe).toBe(unrelatedHook);

    unregisterSecond();
    expect(target.__orcaE2e?.modelMeshResponse).toBeUndefined();
    expect(target.__orcaE2e?.previewFirstCommitPaintMaterialsByVolume).toBeUndefined();
    expect(target.__orcaE2e?.sceneProbe).toBe(unrelatedHook);
  });
});

function createVolume(id: string, objectIndex: number, volumeIndex: number, instanceIndex: number, states: number[]) {
  return {
    id,
    buffer: { objectIdx: objectIndex, volumeIdx: volumeIndex, instanceIdx: instanceIndex },
    paintDrawGroups: states.map((stateId) => ({ stateId, startIndex: 0, indexCount: 3 })),
  };
}

function createPaintGroup(material: THREE.Material | THREE.Material[]): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = 'orca-painted-model-display';
  group.add(mesh);
  return group;
}
