import * as THREE from 'three';
import type { ModelMeshResult } from '@slicer/client';
import type { GLVolume } from '../components/workspace/viewport/GLVolume';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

declare const __ORCA_E2E__: boolean;

export type PreviewFirstCommitPaintMaterial = {
  id: string;
  objectIndex: number;
  volumeIndex: number;
  instanceIndex: number;
  stateId: number;
  colour: string;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
};

type PreviewProbeVolume = {
  id: GLVolume['id'];
  buffer: Pick<GLVolume['buffer'], 'objectIdx' | 'volumeIdx' | 'instanceIdx'>;
  paintDrawGroups: ReadonlyArray<Pick<GLVolume['paintDrawGroups'][number], 'stateId'>>;
};
type ModelMeshResponseSnapshot = {
  objects: Array<{
    volumeId: number;
    objectId: number;
    instanceId: number;
    geometryKey: string;
    paintGeometryKey: string | null;
  }>;
  paintGeometries: Array<{
    volumeId: number;
    paintGeometryKey: string;
    indexCount: number;
    drawGroups: ModelMeshResult['paintGeometries'][number]['drawGroups'];
  }>;
};

const previewFirstCommitPaintMaterialsByVolume: Record<string, PreviewFirstCommitPaintMaterial[]> = {};
const snapshotOwnersByVolume = new Map<string, Set<object>>();
let currentModelMeshResponse: (() => ModelMeshResponseSnapshot) | undefined;
let activeProbeOwners = 0;
let unregisterModelLoadingOwner: (() => void) | undefined;

function clearPreviewSnapshots(): void {
  for (const volumeId of Object.keys(previewFirstCommitPaintMaterialsByVolume)) {
    delete previewFirstCommitPaintMaterialsByVolume[volumeId];
  }
  snapshotOwnersByVolume.clear();
}

function registerModelLoadingOwner(): void {
  unregisterModelLoadingOwner = registerOrcaE2eOwner('model-loading', {
    modelMeshResponse: () => currentModelMeshResponse?.() ?? null,
    previewFirstCommitPaintMaterialsByVolume,
  });
}

/** Register the shared model-loading probe for a mounted viewport loader. */
export function registerModelLoadingProbeOwner(): () => void {
  if (!__ORCA_E2E__) return () => {};

  activeProbeOwners += 1;
  if (activeProbeOwners === 1) {
    clearPreviewSnapshots();
    currentModelMeshResponse = undefined;
    registerModelLoadingOwner();
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    activeProbeOwners -= 1;
    if (activeProbeOwners !== 0) return;

    clearPreviewSnapshots();
    currentModelMeshResponse = undefined;
    unregisterModelLoadingOwner?.();
    unregisterModelLoadingOwner = undefined;
  };
}

/** Preserve the full model response's test-visible protocol summary. */
export function recordModelMeshResponse(result: ModelMeshResult): void {
  if (!__ORCA_E2E__ || activeProbeOwners === 0) return;

  clearPreviewSnapshots();
  currentModelMeshResponse = () => ({
    objects: result.objects.map((object) => ({
      volumeId: object.volumeId,
      objectId: object.objectId,
      instanceId: object.instanceId,
      geometryKey: object.geometryKey,
      paintGeometryKey: object.paintGeometryKey,
    })),
    paintGeometries: result.paintGeometries.map((paint) => ({
      volumeId: paint.volumeId,
      paintGeometryKey: paint.paintGeometryKey,
      indexCount: paint.indexCount,
      drawGroups: paint.drawGroups,
    })),
  });
}

/**
 * Capture the real Three.js materials during the Preview component's first
 * committed layout. Each mounted volume owns only its own volume-keyed entry.
 */
export function capturePreviewFirstCommitPaintMaterials(
  volume: PreviewProbeVolume,
  volumeGroup: THREE.Group | null,
  expectedMaterialCount: number,
  owner: object,
): void {
  if (!__ORCA_E2E__ || activeProbeOwners === 0 || !volumeGroup || expectedMaterialCount === 0) return;

  const existing = previewFirstCommitPaintMaterialsByVolume[volume.id];
  if (existing) {
    const owners = snapshotOwnersByVolume.get(volume.id) ?? new Set<object>();
    owners.add(owner);
    snapshotOwnersByVolume.set(volume.id, owners);
    return;
  }

  const paintMesh = volumeGroup.getObjectByName('orca-painted-model-display') as THREE.Mesh | undefined;
  if (!paintMesh) return;
  const materials = Array.isArray(paintMesh.material) ? paintMesh.material : [paintMesh.material];
  const snapshot = materials.flatMap((material, materialIndex) => {
    if (!(material instanceof THREE.MeshStandardMaterial)) return [];
    return [{
      id: volume.id,
      objectIndex: volume.buffer.objectIdx,
      volumeIndex: volume.buffer.volumeIdx,
      instanceIndex: volume.buffer.instanceIdx,
      stateId: volume.paintDrawGroups[materialIndex]?.stateId ?? 0,
      colour: `#${material.color.getHexString()}`,
      opacity: material.opacity,
      transparent: material.transparent,
      depthWrite: material.depthWrite,
    }];
  });
  if (snapshot.length !== expectedMaterialCount) return;

  previewFirstCommitPaintMaterialsByVolume[volume.id] = snapshot;
  snapshotOwnersByVolume.set(volume.id, new Set([owner]));
}

/** Remove only this mounted volume's ownership of its first-commit snapshot. */
export function releasePreviewFirstCommitPaintMaterials(volumeId: string, owner: object): void {
  if (!__ORCA_E2E__) return;

  const owners = snapshotOwnersByVolume.get(volumeId);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size !== 0) return;

  snapshotOwnersByVolume.delete(volumeId);
  delete previewFirstCommitPaintMaterialsByVolume[volumeId];
}
