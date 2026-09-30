// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { HeightRangeCursor, heightCursorMaterial } from './HeightRangeCursor';
import * as contours from './heightRangeContours';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('draws opaque white lines with normal occlusion, no depth writes or filled material', () => {
  const material = heightCursorMaterial();
  expect(material).toBeInstanceOf(THREE.LineBasicMaterial);
  expect(material.color.getHexString()).toBe('ffffff');
  expect(material.transparent).toBe(true); expect(material.opacity).toBe(1);
  expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(false); expect(material.linewidth).toBe(1);
  material.dispose();
});
it('reuses sections for XY-equivalent and native publications, replaces cuts only on clamped Z/target change and releases owned buffers', async () => {
  vi.stubGlobal('__ORCA_E2E__', false);
  vi.spyOn(console,'error').mockImplementation((message: unknown) => {
    if (!/incorrect casing|unrecognized|does not recognize|non-boolean attribute/.test(String(message))) throw new Error(String(message));
  });
  const source = new THREE.BoxGeometry(2,2,2);
  source.boundsTree = new MeshBVH(source);
  const meshes = [new THREE.Mesh(source)], bounds = new THREE.Box3(new THREE.Vector3(-1,-1,-1),new THREE.Vector3(1,1,1));
  const spy = vi.spyOn(contours,'heightRangeContours');
  const dispose = vi.spyOn(THREE.BufferGeometry.prototype,'dispose'), materialDispose = vi.spyOn(THREE.Material.prototype,'dispose');
  const container = document.createElement('div'), root = createRoot(container);
  const render = (hitZ: number, height = 0.5, target = meshes) => act(async () => root.render(<HeightRangeCursor meshes={target} bounds={bounds} hitZ={hitZ} height={height} renderOrder={4} />));
  await render(0); const originalLine = container.querySelector('linesegments');
  await render(0); expect(spy).toHaveBeenCalledTimes(1);
  await render(0.25); expect(spy).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelector('linesegments')).toBe(originalLine);
  await render(2); await render(3); expect(spy).toHaveBeenCalledTimes(3);
  const replacement = new THREE.Mesh(source); replacement.matrix.makeTranslation(0.5,0,0);
  await render(0,0.5,[replacement]); expect(spy).toHaveBeenCalledTimes(4);
  await act(async()=>root.unmount());
  expect(dispose).toHaveBeenCalledTimes(4); expect(materialDispose).toHaveBeenCalledTimes(1);
  expect(dispose.mock.instances).not.toContain(source); source.dispose();
});
