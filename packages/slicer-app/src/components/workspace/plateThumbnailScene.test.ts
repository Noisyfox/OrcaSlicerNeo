import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createPlateThumbnailScene } from './plateThumbnailScene';

describe('plate thumbnail scene', () => {
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
