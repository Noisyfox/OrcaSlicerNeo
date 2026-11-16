// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MovePanel } from './MovePanel';
import { RotatePanel } from './RotatePanel';
import { ScalePanel } from './ScalePanel';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
function controller(gizmo: 'move' | 'rotate' | 'scale', multi = false) {
  return {
    gizmo, scaleSpace: 'world', selectionInstanceCount: multi ? 2 : 1, hasWipeTowerSelection: false,
    subscribe: () => () => undefined,
    selectionPivot: () => new THREE.Vector3(10, 10, 10),
    selectionBounds: () => new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(20, 20, 20)),
    selectedVolumes: () => [{ instanceTransform: transform, buffer: { instanceTransform: transform } }],
    moveSelectionToPivot: vi.fn(() => false), rotateSelectionBy: vi.fn(() => false),
    scaleSelectionBy: vi.fn(() => false), scaleSelectionToSize: vi.fn(() => false),
  };
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe(value);
  await act(async () => input.blur());
}

describe('transform input drafts', () => {
  it.each([
    ['move', 'move-z', '25', '10.000', 'moveSelectionToPivot'],
    ['rotate', 'rotate-x', '45', '0.0', 'rotateSelectionBy'],
    ['scale', 'scale-factor-x', '200', '100.0', 'scaleSelectionBy'],
    ['scale', 'scale-size-x', '40', '20.000', 'scaleSelectionToSize'],
  ] as const)('restores %s input when the same object is still settling', async (gizmo, testId, entered, expected, method) => {
    const scene = controller(gizmo);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const sceneInteraction = scene as unknown as SceneInteractionController;
    await act(async () => root.render(gizmo === 'move' ? <MovePanel sceneInteraction={sceneInteraction} />
      : gizmo === 'rotate' ? <RotatePanel sceneInteraction={sceneInteraction} />
        : <ScalePanel sceneInteraction={sceneInteraction} />));
    const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
    await enter(input, entered);
    expect(scene[method]).toHaveBeenCalledOnce();
    expect(input.value).toBe(expected);
    await act(async () => root.unmount()); host.remove();
  });

  it('restores the neutral percentage after a relative multi-selection edit', async () => {
    const scene = controller('scale', true);
    scene.scaleSelectionBy.mockReturnValue(true);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<ScalePanel sceneInteraction={scene as unknown as SceneInteractionController} />));
    const input = host.querySelector<HTMLInputElement>('[data-testid="scale-factor-x"]')!;
    await enter(input, '150');
    expect(scene.scaleSelectionBy).toHaveBeenCalledOnce();
    expect(input.value).toBe('100.0');
    await act(async () => root.unmount()); host.remove();
  });
});
