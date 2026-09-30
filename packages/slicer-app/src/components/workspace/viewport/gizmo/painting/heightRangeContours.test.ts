import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { heightRangeContours, heightRangePlanes } from './heightRangeContours';

const owned: THREE.BufferGeometry[] = [];
afterEach(() => { owned.forEach((g) => g.dispose()); owned.length = 0; vi.restoreAllMocks(); });
function mesh(geometry: THREE.BufferGeometry, matrix = new THREE.Matrix4()) {
  owned.push(geometry); (geometry as THREE.BufferGeometry & { boundsTree: MeshBVH }).boundsTree = new MeshBVH(geometry);
  const result = new THREE.Mesh(geometry); result.matrix.copy(matrix); return result;
}
function sections(meshes: THREE.Mesh[], bounds: THREE.Box3, planes: readonly [number, number]) {
  const geometry = heightRangeContours(meshes, bounds, planes); owned.push(geometry);
  const p = geometry.getAttribute('position');
  return Array.from({ length: p.count / 2 }, (_, i) => [new THREE.Vector3().fromBufferAttribute(p, i * 2), new THREE.Vector3().fromBufferAttribute(p, i * 2 + 1)]);
}
function frustum(bottom: number, top: number) {
  const data: number[] = [];
  const corners = [[-1,-1], [1,-1], [1,1], [-1,1]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const a = [...corners[i].map((v) => v * bottom), 0], b = [...corners[j].map((v) => v * bottom), 0];
    const c = [...corners[j].map((v) => v * top), 8], d = [...corners[i].map((v) => v * top), 8];
    data.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(data, 3));
}
const bounds = new THREE.Box3(new THREE.Vector3(-3,-3,0), new THREE.Vector3(3,3,8));
it('cuts tapered and hollow walls at actual section sizes, keeping both disconnected inner and outer loops', () => {
  const parts = [mesh(frustum(3, 1)), mesh(frustum(1, 1))];
  const lines = sections(parts, bounds, [4, 6]);
  for (const z of [4, 6]) {
    const outer = 3 - z / 4;
    const atZ = lines.filter(([a]) => a.z === z);
    let length = 0;
    for (const [a,b] of atZ) {
      expect(b.z).toBe(z); expect(a.distanceTo(b)).toBeGreaterThan(0);
      expect([1, outer].some((r) =>
        Math.abs(a.x) === r && Math.abs(b.x) === r || Math.abs(a.y) === r && Math.abs(b.y) === r)).toBe(true);
      length += a.distanceTo(b);
    }
    expect(length).toBeCloseTo(8 * outer + 8, 6);
  }
});
it('cuts multiple reflected, rotated, nonuniformly scaled solids in world Z, including disconnected sections', () => {
  const matrix = new THREE.Matrix4().makeTranslation(20, 30, 10).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).multiply(new THREE.Matrix4().makeScale(-4, 2, 3));
  const second = new THREE.Matrix4().makeTranslation(-10, 0, 10).multiply(new THREE.Matrix4().makeScale(2, 2, 4));
  const parts = [mesh(new THREE.BoxGeometry(2,2,2), matrix), mesh(new THREE.BoxGeometry(2,2,2), second)];
  const box = new THREE.Box3(new THREE.Vector3(-12,-2,6), new THREE.Vector3(23,32,14));
  const lines = sections(parts, box, [9, 11]);
  for (const z of [9,11]) {
    let length = 0;
    for (const [a,b] of lines.filter(([a]) => a.z === z)) {
      expect(b.z).toBe(z);
      const [xmin,xmax,ymin,ymax] = a.x > 0 ? [17,23,28,32] : [-12,-8,-2,2];
      expect(a.x).toBeGreaterThanOrEqual(xmin); expect(a.x).toBeLessThanOrEqual(xmax);
      expect(a.y).toBeGreaterThanOrEqual(ymin); expect(a.y).toBeLessThanOrEqual(ymax);
      expect((Math.abs(a.x-xmin)<1e-6 && Math.abs(b.x-xmin)<1e-6) || (Math.abs(a.x-xmax)<1e-6 && Math.abs(b.x-xmax)<1e-6) ||
        (Math.abs(a.y-ymin)<1e-6 && Math.abs(b.y-ymin)<1e-6) || (Math.abs(a.y-ymax)<1e-6 && Math.abs(b.y-ymax)<1e-6)).toBe(true);
      length += a.distanceTo(b);
    }
    expect(length).toBeCloseTo(36, 6);
  }
});
it('handles shared coplanar edges, vertices and faces without duplicate or zero length segments', () => {
  const part = mesh(new THREE.BoxGeometry(2,2,2, 2,2,2));
  const box = new THREE.Box3(new THREE.Vector3(-1,-1,-1), new THREE.Vector3(1,1,1));
  const lines = sections([part,part], box, [0,0]);
  expect(lines.reduce((sum,[a,b])=>sum+a.distanceTo(b),0)).toBeCloseTo(8,6);
  expect(lines.every(([a,b])=>a.distanceTo(b)>0)).toBe(true);
  const keys = lines.map((line)=>line.map((p)=>p.toArray().join(',')).sort().join('|'));
  expect(new Set(keys).size).toBe(lines.length);
});
it('clamps the world hit upwards and omits global end planes, with no invented box edge', () => {
  const part = mesh(frustum(3,1));
  expect(heightRangePlanes(bounds,-10,3)).toEqual([0,3]);
  expect(heightRangePlanes(bounds,7,3)).toEqual([7,8]);
  expect(heightRangePlanes(bounds,20,3)).toEqual([8,8]);
  expect(heightRangePlanes(bounds,8-1e-14,3)).toEqual([8,8]);
  expect(sections([part],bounds,[0,8])).toEqual([]);
  expect(sections([part],bounds,[7,8]).every(([a,b])=>a.z===7 && b.z===7)).toBe(true);
});
it('matches native top-edge ownership at an individual part cap inside the global height range', () => {
  const part = mesh(new THREE.BoxGeometry(2,2,2,2,2,1));
  const box = new THREE.Box3(new THREE.Vector3(-1,-1,-2),new THREE.Vector3(1,1,2));
  const lines = sections([part],box,[-1,1]);
  expect(lines.every(([a,b])=>a.z===1 && b.z===1)).toBe(true);
  expect(lines.reduce((sum,[a,b])=>sum+a.distanceTo(b),0)).toBeCloseTo(8,6);
});
it('uses original BVH bounds to prune a distant high-triangle solid', () => {
  const part = mesh(new THREE.SphereGeometry(1,64,32));
  const tree = (part.geometry as THREE.BufferGeometry & { boundsTree: MeshBVH }).boundsTree;
  const original = tree.shapecast.bind(tree);
  let triangles = 0;
  const spy = vi.spyOn(tree,'shapecast').mockImplementation((callbacks) => original({ ...callbacks,
    intersectsTriangle: (...args) => { triangles++; return callbacks.intersectsTriangle!(...args); },
  }));
  const box = new THREE.Box3(new THREE.Vector3(-2,-2,-2),new THREE.Vector3(2,2,20));
  expect(sections([part],box,[10,11])).toEqual([]);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(triangles).toBe(0);
  expect(spy.mock.calls[0][0].intersectsBounds!(new THREE.Box3(new THREE.Vector3(-1,-1,-1), new THREE.Vector3(1,1,1)),false,0,0,0)).toBe(false);
  sections([part],box,[0,0]);
  expect(triangles).toBeGreaterThan(0);
  expect(triangles).toBeLessThan(part.geometry.index!.count / 6);
});
