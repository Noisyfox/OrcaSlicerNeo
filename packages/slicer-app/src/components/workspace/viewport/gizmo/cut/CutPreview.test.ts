import { expect, it, vi } from 'vitest';
import { BoxGeometry, OrthographicCamera, Vector3 } from 'three';
import type { CutSectionRequest, CutSectionResult, ModelTransform } from '@slicer/client';
import { CutSectionQueue } from './CutSectionQueue';
import { CutVertices } from './CutVertices';

it('coalesces a drag, a reversal and a session exit without publishing stale sections', async () => {
  const pending: ((r: CutSectionResult) => void)[] = [];
  const compute = vi.fn(() => new Promise<CutSectionResult>(resolve => pending.push(resolve)));
  const publish = vi.fn(), queue = new CutSectionQueue(compute, publish);
  const request: CutSectionRequest = { objectId: 1, instanceId: 2, revision: 3, center: [0,0,0], rotation: [1,0,0,0,1,0,0,0,1] };
  const result: CutSectionResult = { ok: true, loops: [], xy: new Float32Array() };
  for (const z of [1,2,-1]) queue.request({ ...request, center: [0,0,z] }, String(z));
  expect(compute).toHaveBeenCalledTimes(1);
  pending.shift()!(result); await Promise.resolve();
  expect(compute).toHaveBeenLastCalledWith({ ...request, center: [0,0,-1] });
  expect(publish).not.toHaveBeenCalled();
  pending.shift()!(result); await Promise.resolve();
  expect(publish).toHaveBeenCalledWith('-1', result);
  queue.request(request, 'old session'); queue.clear(); pending.shift()!(result); await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(1);
});

it('picks the front boundary endpoint within the same CSS radius after zoom', () => {
  const transform: ModelTransform = { offset: [0,0,0], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] };
  const geometry = new BoxGeometry(2,2,2);
  const vertices = new CutVertices([{ geometry, volumeTransform: transform, instanceTransform: transform }]);
  const camera = new OrthographicCamera(-4,4,4,-4,0.1,100);
  camera.position.set(0,0,10); camera.lookAt(0,0,0); camera.updateMatrixWorld();
  const rect = { left: 30, top: 50, width: 400, height: 400 } as DOMRect;
  for (const zoom of [1,2]) {
    camera.zoom = zoom; camera.updateProjectionMatrix();
    const p = new Vector3(1,1,1).project(camera);
    const x = rect.left + 200 * (1+p.x), y = rect.top + 200 * (1-p.y);
    expect(vertices.pick({ clientX: x+8, clientY: y }, rect, camera)?.toArray()).toEqual([1,1,1]);
    expect(vertices.pick({ clientX: x+10, clientY: y }, rect, camera)).toBeNull();
    expect(vertices.pick({ clientX: 230, clientY: 250 }, rect, camera)).toBeNull();
  }
  geometry.dispose(); vertices.dispose();
});
