// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ArrangementEditBoundary } from './ArrangementEditBoundary';
import { useArrangementStore } from '@/stores/useArrangementStore';
import { enqueueProjectMutationOperation } from '@/history/projectMutationGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { useArrangementStore.setState({ active: false }); });

it('blocks portal edits, shortcuts, and queued mutations while allowing camera pointers and cancel controls', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const portal = document.createElement('button'); document.body.append(portal);
  const root = createRoot(host);
  const edit = vi.fn(), camera = vi.fn(), cancel = vi.fn(), shortcut = vi.fn();
  portal.addEventListener('click', edit);
  document.addEventListener('keydown', shortcut);
  await act(async () => root.render(<ArrangementEditBoundary><input /><canvas /></ArrangementEditBoundary>));
  const canvas = host.querySelector('canvas')!;
  canvas.addEventListener('pointerdown', camera);
  const cancelButton = document.createElement('button'); cancelButton.dataset.arrangementAllowed = '';
  cancelButton.addEventListener('click', cancel); document.body.append(cancelButton);
  await act(async () => useArrangementStore.setState({ active: true }));
  expect(host.querySelector('fieldset')!.disabled).toBe(true);
  portal.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  canvas.dispatchEvent(new Event('pointerdown', { bubbles: true })); cancelButton.click();
  expect(edit).not.toHaveBeenCalled(); expect(shortcut).not.toHaveBeenCalled();
  expect(camera).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  await expect(enqueueProjectMutationOperation(async () => edit())).rejects.toThrow('arrangement_busy');
  await act(async () => useArrangementStore.setState({ active: false }));
  portal.click(); expect(edit).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  host.remove(); portal.remove(); cancelButton.remove(); document.removeEventListener('keydown', shortcut);
});
