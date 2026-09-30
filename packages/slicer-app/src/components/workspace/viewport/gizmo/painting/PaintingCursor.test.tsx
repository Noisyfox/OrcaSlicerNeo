import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaintingCursor, PAINTING_RENDER_ORDER, circleCursorSteps } from './PaintingCursor';
import { HeightRangeCursor } from './HeightRangeCursor';

vi.mock('@react-three/drei', () => ({ Line: vi.fn(() => null) }));
vi.mock('@react-three/fiber', () => ({ useThree: () => ({ camera, size: { height: 600 } }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const settings = { state: 1, erase: false, radius: 7, height: 3, angle: 30, gapArea: 0 };
const position = new THREE.Vector3(5, 10, 15), cameraQuaternion = new THREE.Quaternion();
const color = new THREE.Color('#abcdef');
const bounds = new THREE.Box3(new THREE.Vector3(-10, -20, 0), new THREE.Vector3(30, 40, 50));
const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
camera.position.z = 45; camera.updateMatrixWorld();

it.each(['circle', 'sphere'] as const)('draws the production %s cursor last without writing depth', (tool) => {
  vi.stubGlobal('__ORCA_E2E__', false);
  const tree = PaintingCursor({ tool, settings, position, cameraQuaternion, bounds, color, meshes: [] })!;
  const mesh = tree.props.children;
  if (tool === 'circle') renderToStaticMarkup(mesh);
  const drawProps = tool === 'circle' ? vi.mocked(Line).mock.lastCall![0] : mesh.props;
  const materialProps = tool === 'circle' ? drawProps : mesh.props.children[1].props;
  const { color: materialColor, transparent, opacity, side, depthTest, depthWrite } = materialProps;
  const material = new THREE.MeshBasicMaterial({ color: materialColor, transparent, opacity, side, depthTest, depthWrite });
  expect(tree.props.position).toBe(position);
  expect(tree.props.renderOrder).toBe(PAINTING_RENDER_ORDER.cursor);
  expect(drawProps.renderOrder).toBe(PAINTING_RENDER_ORDER.cursor);
  expect(drawProps.name).toBeUndefined();
  expect(PAINTING_RENDER_ORDER.cursor).toBeGreaterThan(Math.max(PAINTING_RENDER_ORDER.draft, PAINTING_RENDER_ORDER.candidate, PAINTING_RENDER_ORDER.contour));
  expect(material.transparent).toBe(true); expect(material.depthWrite).toBe(false);
  expect(material.depthTest).toBe(tool === 'sphere'); expect(material.opacity).toBe(tool === 'sphere' ? 0.25 : 1);
  expect(material.wireframe).toBe(false); expect(materialProps.color).toBe(color); expect(material.color.equals(color)).toBe(true);
  expect(material.side).toBe(tool === 'circle' ? THREE.DoubleSide : THREE.FrontSide);
  if (tool === 'sphere') { const geometry = mesh.props.children[0]; expect(geometry.type).toBe('sphereGeometry'); expect(geometry.props.args[0]).toBe(settings.radius); }
  if (tool === 'circle') {
    expect(drawProps.quaternion).toBe(cameraQuaternion);
    expect(drawProps.scale).toBe(settings.radius); expect(drawProps.worldUnits).toBe(false);
    expect(drawProps.lineWidth).toBe(2); expect(drawProps.segments).toBe(true);
    // This perspective camera gives 10 pixels/mm at the hit: 26 intervals,
    // 13 separate dashes and 13 equally-sized gaps, including the closing gap.
    const points = drawProps.points as [number, number, number][];
    expect(points).toHaveLength(26);
    for (let i = 0; i < points.length; i++) {
      const [x, y, z] = points[i]; expect(Math.hypot(x, y)).toBeCloseTo(1); expect(z).toBe(0);
      const [nx, ny] = points[(i + 1) % points.length];
      expect(Math.atan2(x * ny - y * nx, x * nx + y * ny)).toBeCloseTo(2 * Math.PI / 26);
    }
  }
  material.dispose();
});

it.each([[0, 6], [1, 8], [10, 26], [100, 208], [250, 512], [1000, 512]])('matches Orca dash density at %s pixels/mm', (zoom, steps) => {
  expect(circleCursorSteps(zoom)).toBe(steps);
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
