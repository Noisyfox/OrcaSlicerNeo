import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { PaintingCursor, PAINTING_RENDER_ORDER } from './PaintingCursor';
import { HeightRangeCursor } from './HeightRangeCursor';

afterEach(() => vi.unstubAllGlobals());
const settings = { state: 1, erase: false, radius: 7, height: 3, angle: 30, gapArea: 0 };
const position = new THREE.Vector3(5, 10, 15), cameraQuaternion = new THREE.Quaternion();
const color = new THREE.Color('#abcdef');
const bounds = new THREE.Box3(new THREE.Vector3(-10, -20, 0), new THREE.Vector3(30, 40, 50));

it.each(['circle', 'sphere'] as const)('draws the production %s cursor last without writing depth', (tool) => {
  vi.stubGlobal('__ORCA_E2E__', false);
  const tree = PaintingCursor({ tool, settings, position, cameraQuaternion, bounds, color, meshes: [] })!;
  const mesh = tree.props.children;
  const [geometry, materialElement] = mesh.props.children;
  const material = new THREE.MeshBasicMaterial(materialElement.props);
  expect(tree.props.position).toBe(position);
  expect(tree.props.renderOrder).toBe(PAINTING_RENDER_ORDER.cursor);
  expect(mesh.props.renderOrder).toBe(PAINTING_RENDER_ORDER.cursor);
  expect(mesh.props.name).toBeUndefined();
  expect(PAINTING_RENDER_ORDER.cursor).toBeGreaterThan(Math.max(PAINTING_RENDER_ORDER.draft, PAINTING_RENDER_ORDER.candidate, PAINTING_RENDER_ORDER.contour));
  expect(material.transparent).toBe(true); expect(material.depthWrite).toBe(false);
  expect(material.depthTest).toBe(tool === 'sphere'); expect(material.opacity).toBe(tool === 'sphere' ? 0.25 : 1);
  expect(material.wireframe).toBe(false); expect(materialElement.props.color).toBe(color); expect(material.color.equals(color)).toBe(true);
  expect(material.side).toBe(tool === 'circle' ? THREE.DoubleSide : THREE.FrontSide);
  if (tool === 'sphere') { expect(geometry.type).toBe('sphereGeometry'); expect(geometry.props.args[0]).toBe(settings.radius); }
  if (tool === 'circle') { expect(mesh.props.quaternion).toBe(cameraQuaternion); expect(geometry.props.args.slice(0, 2)).toEqual([6.79, 7]); }
  material.dispose();
});

it.each(['triangle', 'region', 'gap'] as const)('does not invent a cursor for %s', (tool) => {
  expect(PaintingCursor({ tool, settings, position, cameraQuaternion, bounds, color, meshes: [] })).toBeNull();
});

it('routes Height to original-model world sections independently of filament colour and camera orientation', () => {
  const meshes = [new THREE.Mesh()];
  const tree = PaintingCursor({ tool: 'height', settings, position, cameraQuaternion, bounds, color, meshes })!;
  expect(tree.type).toBe(HeightRangeCursor);
  expect(tree.props).toEqual({ meshes, bounds, hitZ: 15, height: 3, renderOrder: PAINTING_RENDER_ORDER.cursor });
});
