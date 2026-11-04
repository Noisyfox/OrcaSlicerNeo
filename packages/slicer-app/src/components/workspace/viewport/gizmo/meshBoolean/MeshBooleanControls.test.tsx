// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MeshBooleanWait } from './MeshBooleanControls';
import { useMeshBooleanStore } from '@/stores/useMeshBooleanStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  useMeshBooleanStore.setState({ busy: false });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  useMeshBooleanStore.setState({ busy: false }); vi.unstubAllGlobals();
});

it('keeps a non-dismissible indeterminate modal and blocks keyboard, camera and navigation input until publication ends', async () => {
  const navigated = vi.fn(), keyboard = vi.fn(), wheel = vi.fn();
  await act(async () => root.render(<><button data-testid="navigation" onClick={navigated}>Home</button><MeshBooleanWait /></>));
  const navigation = container.querySelector('[data-testid="navigation"]')!;
  window.addEventListener('keydown', keyboard); window.addEventListener('wheel', wheel);
  await act(async () => useMeshBooleanStore.setState({ busy: true }));
  const popup = document.querySelector('[data-testid="mesh-boolean-wait"]')!;
  expect(popup).not.toBe(null);
  expect(popup.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
  expect(popup.querySelector('button')).toBe(null);
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(escape);
  navigation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }));
  expect(escape.defaultPrevented).toBe(true);
  expect(keyboard).not.toHaveBeenCalled(); expect(wheel).not.toHaveBeenCalled(); expect(navigated).not.toHaveBeenCalled();
  expect(useMeshBooleanStore.getState().busy).toBe(true);
  await act(async () => useMeshBooleanStore.setState({ busy: false }));
  await act(async () => navigation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(navigated).toHaveBeenCalledOnce();
  window.removeEventListener('keydown', keyboard); window.removeEventListener('wheel', wheel);
});
