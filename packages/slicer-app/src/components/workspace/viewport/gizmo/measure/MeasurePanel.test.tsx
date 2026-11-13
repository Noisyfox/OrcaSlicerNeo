// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeasureSelection, MeasureStatus } from '@slicer/client';
import type { MeasureState } from './MeasureController';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { describeMeasureSelection, measureRows } from './measurePresentation';
import { MeasurePanel } from './MeasurePanel';

const mocked = vi.hoisted(() => ({ state: null as MeasureState | null, reset: vi.fn() }));
vi.mock('./MeasureProvider', () => ({ useMeasureController: () => ({ reset: mocked.reset }), useMeasureState: () => mocked.state }));

const target = { objectId: 1, instanceId: 2, volumeId: 3 };
const edge = { type: 'edge' as const, start: [0, 0, 0] as const, end: [2, 0, 0] as const, length: 2.0004, center: null };
const point = { type: 'point' as const, point: [1, 0, 0] as const };
const first: MeasureSelection = { target, kind: 'feature', source: edge, value: edge };
const second: MeasureSelection = { target, kind: 'midpoint', source: edge, value: point };
const status: MeasureStatus = { ok: true, version: 1, sessionId: 'ms-1', targetRevision: 1, selectionRevision: 1,
  first, second, sameTarget: true, result: {
    angle: { radians: Math.PI / 2, center: [0, 0, 0], edge1: [[0, 0, 0], [1, 0, 0]], edge2: [[0, 0, 0], [0, 1, 0]], radius: 1, coplanar: true },
    infinite: { value: 1.23456, from: [0, 0, 0], to: [1, 0, 0] },
    strict: { value: 1.34567, from: [0, 0, 0], to: [1, 0, 0] }, xyz: [0.1, -0.2, 0.3], showStrict: true, showXyz: true,
  } };

describe('Measure presentation', () => {
  it('labels features and follows native result visibility with three decimals', () => {
    expect(describeMeasureSelection(first)).toBe('Edge (Length: 2.000 mm)');
    expect(describeMeasureSelection(second)).toBe('Midpoint of edge');
    expect(describeMeasureSelection({ ...second, kind: 'center' })).toBe('Center of edge');
    expect(describeMeasureSelection({ ...second, kind: 'pointOnFeature' })).toBe('Point on edge');
    expect(measureRows(status)).toEqual([
      { label: 'Angle', value: '90.000°' }, { label: 'Perpendicular distance', value: '1.235 mm' },
      { label: 'Direct distance', value: '1.346 mm' }, { label: 'Distance XYZ', value: 'X: 0.100, Y: -0.200, Z: 0.300' },
    ]);
    expect(measureRows({ ...status, result: { ...status.result!, showStrict: false, showXyz: false } })).toEqual([
      { label: 'Angle', value: '90.000°' }, { label: 'Distance', value: '1.235 mm' },
    ]);
    expect(measureRows({ ...status, second: null })).toEqual([]);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const scene = { gizmo: 'measure', subscribe: () => () => {}, closeGizmo: vi.fn() } as unknown as SceneInteractionController;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('PointerEvent', MouseEvent);
  mocked.state = { phase: 'idle', targets: [target], status, display: null, planes: new Map(), error: null };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MeasurePanel sceneInteraction={scene} />));
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it('renders preparation, selected features and individual reset/Done actions', async () => {
  mocked.state = { ...mocked.state!, phase: 'opening', status: null }; await render();
  expect(container.textContent).toContain('Preparing measurement');
  expect(button('Reset Selection 1').disabled).toBe(true);
  mocked.state = { ...mocked.state!, phase: 'idle', status }; await render();
  expect(container.textContent).toContain('Edge (Length: 2.000 mm)');
  expect(container.textContent).toContain('Midpoint of edge');
  await act(async () => button('Reset Selection 1').click()); expect(mocked.reset).toHaveBeenCalledWith('first');
  await act(async () => button('Reset Selection 2').click()); expect(mocked.reset).toHaveBeenCalledWith('second');
  await act(async () => button('Close Measure').click()); expect(scene.closeGizmo).toHaveBeenCalledOnce();
});

it('copies Orca-style labels directly from the click and reports failure', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
  vi.stubGlobal('navigator', { clipboard: { writeText } }); await render();
  await act(async () => button('Copy Perpendicular distance').click());
  expect(writeText).toHaveBeenCalledWith('Perpendicular distance: 1.235 mm');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button('Copy Distance XYZ').click());
  expect(writeText).toHaveBeenLastCalledWith('Distance XYZ: X: 0.100, Y: -0.200, Z: 0.300');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not copy');
});
