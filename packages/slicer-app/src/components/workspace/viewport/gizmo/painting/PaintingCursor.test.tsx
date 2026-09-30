import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
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
  const materialProps = tool === 'circle' ? mesh.props : mesh.props.children[1].props;
  const { color: materialColor, transparent, opacity, side, depthTest, depthWrite } = materialProps;
  const material = new THREE.MeshBasicMaterial({ color: materialColor, transparent, opacity, side, depthTest, depthWrite });
  expect(tree.props.position).toBe(position);
  expect(tree.props.renderOrder).toBe(PAINTING_RENDER_ORDER.cursor);
  expect(mesh.props.renderOrder).toBe(PAINTING_RENDER_ORDER.cursor);
  expect(mesh.props.name).toBeUndefined();
  expect(PAINTING_RENDER_ORDER.cursor).toBeGreaterThan(Math.max(PAINTING_RENDER_ORDER.draft, PAINTING_RENDER_ORDER.candidate, PAINTING_RENDER_ORDER.contour));
  expect(material.transparent).toBe(true); expect(material.depthWrite).toBe(false);
  expect(material.depthTest).toBe(tool === 'sphere'); expect(material.opacity).toBe(tool === 'sphere' ? 0.25 : 1);
  expect(material.wireframe).toBe(false); expect(materialProps.color).toBe(color); expect(material.color.equals(color)).toBe(true);
  expect(material.side).toBe(tool === 'circle' ? THREE.DoubleSide : THREE.FrontSide);
  if (tool === 'sphere') { const geometry = mesh.props.children[0]; expect(geometry.type).toBe('sphereGeometry'); expect(geometry.props.args[0]).toBe(settings.radius); }
  if (tool === 'circle') {
    expect(mesh.type).toBe(Line); expect(mesh.props.quaternion).toBe(cameraQuaternion);
    expect(mesh.props.scale).toBe(settings.radius); expect(mesh.props.worldUnits).toBe(false);
    expect(mesh.props.lineWidth).toBe(2);
    for (const [x, y, z] of mesh.props.points) { expect(Math.hypot(x, y)).toBeCloseTo(1); expect(z).toBe(0); }
    expect(mesh.props.points.at(-1)[0]).toBeCloseTo(mesh.props.points[0][0]);
    expect(mesh.props.points.at(-1)[1]).toBeCloseTo(mesh.props.points[0][1]);
  }
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
