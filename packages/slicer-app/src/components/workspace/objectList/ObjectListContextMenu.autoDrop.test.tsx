// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelObjectStructure } from '@slicer/client';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ObjectListContextMenu } from './ObjectListContextMenu';
import { useObjectListStore } from './useObjectListStore';
import { setObjectsAutoDropInList } from './actions';

vi.mock('./actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('./actions')>(),
  setObjectsAutoDropInList: vi.fn(async () => ({ ok: true })),
}));

const objects: ModelObjectStructure[] = [true, false].map((autoDrop, index) => ({
  id: index + 1, index, name: `Object ${index}`, printable: true, autoDrop, instanceCount: 1,
  volumes: [{ id: 10 + index, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
  instances: [{ id: 20 + index, index: 0, printable: true }],
}));

afterEach(() => { document.body.innerHTML = ''; useObjectListStore.getState().clear(); vi.clearAllMocks(); });

it('enables all owning objects when a mixed selection is toggled', async () => {
  useObjectListStore.setState({ structure: objects, projection: {
    objectIds: new Set([1]), instanceIds: new Set([21]), volumeIds: new Set(),
  } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const runtime = {};
  await act(async () => root.render(<PlatformProvider value={{ runtime } as unknown as PlatformCapabilities}>
    <ContextMenu open><ContextMenuTrigger><div /></ContextMenuTrigger>
      <ObjectListContextMenu target={{ kind: 'object', object: objects[0] }} onClose={() => undefined} />
    </ContextMenu>
  </PlatformProvider>));
  const item = document.querySelector('[data-testid="objectlist-auto-drop"]') as HTMLElement;
  expect(item.getAttribute('aria-checked')).toBe('false');
  await act(async () => item.click());
  expect(setObjectsAutoDropInList).toHaveBeenCalledWith(runtime, [1, 2], true, undefined);
  await act(async () => root.unmount());
});
