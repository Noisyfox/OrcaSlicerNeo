import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createPlateThumbnailScene, projectPlateThumbnail } from './plateThumbnailScene';
import type { GLVolume } from './viewport/GLVolume';
import type { ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';

describe('plate thumbnail scene', () => {
  it('filters auxiliary/unprintable/outside parts and preserves image identity through plate grid reflow', () => {
    const transform = { offset: [10, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    const geometry = new THREE.BoxGeometry();
    const volume = { kind: 'model', buffer: { objectId: 1, volumeId: 2, instanceId: 3, objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
      geometry, paintGeometry: null, instanceTransform: transform, volumeTransform: { ...transform, offset: [0, 0, 0] } } as unknown as GLVolume;
    const structure = [{ id: 1, index: 0, printable: true, volumes: [{ id: 2, type: 'model_part' }], instances: [{ id: 3, index: 0, printable: true }] }] as unknown as ModelObjectStructure[];
    const session = { plates: [{ plateId: 'a', origin: [0, 0, 0] }], instances: [{ instanceId: 3, objectIndex: 0, instanceIndex: 0, member: true, plateId: 'a' }] } as unknown as PlateSessionSnapshot;
    const first = projectPlateThumbnail('a', [volume], structure, session, null);
    expect(first.parts).toHaveLength(1);
    const moved = { ...volume, instanceTransform: { ...transform, offset: [274, 20, 0] } } as GLVolume;
    const reflowed = { ...session, plates: [{ ...session.plates[0], origin: [264, 0, 0] }] } as PlateSessionSnapshot;
    expect(projectPlateThumbnail('a', [moved], structure, reflowed, null).key).toBe(first.key);
    expect(projectPlateThumbnail('a', [{ ...volume, kind: 'wipe-tower' } as GLVolume], structure, session, null).parts).toHaveLength(0);
    expect(projectPlateThumbnail('a', [volume], structure, { ...session, instances: [{ ...session.instances![0], outOfBounds: true }] }, null).parts).toHaveLength(0);
    const modifier = [{ ...structure[0], volumes: [{ ...structure[0].volumes[0], type: 'parameter_modifier' as const }] }];
    expect(projectPlateThumbnail('a', [volume], modifier, session, null).parts).toHaveLength(0);
    geometry.dispose();
  });
  it('fits rotated, scaled geometry in an independent orthographic camera without owning its geometry', () => {
    const geometry = new THREE.BoxGeometry(10, 20, 30);
    const dispose = vi.spyOn(geometry, 'dispose');
    const matrix = new THREE.Matrix4().makeRotationZ(0.7).scale(new THREE.Vector3(2, 1, 1)).setPosition(300, 200, 10);
    const projection = createPlateThumbnailScene([{ geometry, matrix, materials: [{ colour: '#ffffff', opacity: 1, transparent: false, depthWrite: true }] }]);
    expect(projection.camera.isOrthographicCamera).toBe(true);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix).project(projection.camera);
      expect(Math.abs(point.x)).toBeLessThan(1);
      expect(Math.abs(point.y)).toBeLessThan(1);
      expect(Math.abs(point.z)).toBeLessThan(1);
    }
    const mesh = projection.scene.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
    const materialDispose = vi.spyOn(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material, 'dispose');
    projection.dispose();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    geometry.dispose();
  });
});
