import * as THREE from 'three';
import type { FilamentSessionSnapshot, ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import type { GLVolume } from './viewport/GLVolume';
import { matrixFromTransform } from './viewport/transformDeltaMath';
import { canRenderPreparePaint, isModelInstanceMarkedUnprintable, prepareColourForVolume, preparePaintMaterialOverlays, resolvePrepareMaterial } from './viewport/prepareColourProjection';

export interface PlateThumbnailPart {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  materials: ReturnType<typeof resolvePrepareMaterial>[];
}

/** Local matrices make harmless native grid reflow independent of image identity. */
export function projectPlateThumbnail(plateId: string, volumes: readonly GLVolume[], structure: readonly ModelObjectStructure[],
  session: PlateSessionSnapshot, filaments: FilamentSessionSnapshot | null) {
  const plate = session.plates.find(p => p.plateId === plateId);
  const parts: PlateThumbnailPart[] = [];
  if (plate) for (const volume of volumes) {
    const object = structure.find(o => o.id === volume.buffer.objectId);
    const part = object?.volumes.find(v => v.id === volume.buffer.volumeId);
    const member = session.instances?.find(i => i.instanceId === volume.buffer.instanceId);
    if (volume.kind !== 'model' || part?.type !== 'model_part' || isModelInstanceMarkedUnprintable(volume, structure)
      || !member?.member || member.plateId !== plateId || member.outOfBounds || member.unprintable) continue;
    const matrix = new THREE.Matrix4().makeTranslation(-plate.origin[0], -plate.origin[1], -plate.origin[2])
      .multiply(matrixFromTransform(volume.instanceTransform)).multiply(matrixFromTransform(volume.volumeTransform));
    const painted = volume.paintGeometry && canRenderPreparePaint(volume, structure);
    parts.push({ geometry: painted ? volume.paintGeometry! : volume.geometry, matrix,
      materials: painted ? preparePaintMaterialOverlays(volume, volume.paintDrawGroups, structure, filaments, session)
        : [resolvePrepareMaterial({ baseColour: prepareColourForVolume(volume, structure, filaments, session) })] });
  }
  const key = JSON.stringify(parts.map(p => [p.geometry.uuid, p.matrix.elements, p.materials]));
  return { parts, key };
}

/** Owns only materials and scene objects, never the shared model geometry. */
export function createPlateThumbnailScene(parts: readonly PlateThumbnailPart[]) {
  const scene = new THREE.Scene();
  const materials: THREE.Material[] = [];
  const bounds = new THREE.Box3();
  for (const part of parts) {
    const resolved = part.materials.map(m => {
      const material = new THREE.MeshStandardMaterial({ color: m.colour, opacity: m.opacity, transparent: m.transparent,
        depthWrite: m.depthWrite, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.1, flatShading: true });
      materials.push(material);
      return material;
    });
    const mesh = new THREE.Mesh(part.geometry, resolved.length === 1 && !part.geometry.groups.length ? resolved[0] : resolved);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(part.matrix);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
    bounds.expandByObject(mesh, true);
  }
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  const centre = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  const size = bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : bounds.getSize(new THREE.Vector3());
  const distance = Math.max(1, size.length()) * 3;
  // Native Camera::set_default_orientation: zenith 45°, azimuth 45°.
  camera.position.copy(centre).add(new THREE.Vector3(-0.5, -0.5, Math.SQRT1_2).multiplyScalar(distance));
  camera.lookAt(centre);
  camera.far = distance * 3;
  camera.updateMatrixWorld(true);
  const projected = new THREE.Box3();
  if (!bounds.isEmpty()) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y])
    for (const z of [bounds.min.z, bounds.max.z]) projected.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
  const extent = projected.isEmpty() ? 1 : Math.max(projected.max.x - projected.min.x, projected.max.y - projected.min.y, 0.01) * 1.06;
  const px = projected.isEmpty() ? 0 : (projected.min.x + projected.max.x) / 2;
  const py = projected.isEmpty() ? 0 : (projected.min.y + projected.max.y) / 2;
  camera.left = px - extent / 2; camera.right = px + extent / 2;
  camera.bottom = py - extent / 2; camera.top = py + extent / 2;
  camera.updateProjectionMatrix();
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.copy(camera.position); light.target.position.copy(centre);
  scene.add(light, light.target);
  return { scene, camera, dispose: () => materials.forEach(m => m.dispose()) };
}
