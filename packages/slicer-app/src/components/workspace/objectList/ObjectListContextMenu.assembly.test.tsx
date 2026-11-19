// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { ModelObjectStructure } from '@slicer/client';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ObjectListContextMenu } from './ObjectListContextMenu';
import { useObjectListStore } from './useObjectListStore';
import { assembleObjectsInList } from './structuralActions';

vi.mock('./structuralActions', async importOriginal => ({
  ...await importOriginal<typeof import('./structuralActions')>(),
  assembleObjectsInList: vi.fn(async () => ({ ok: true })),
}));
const a: ModelObjectStructure = {
  id: 1, index: 0, name: 'A', printable: true, autoDrop: true, isCut: false, instanceCount: 3,
  volumes: [{ id: 10, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
  instances: [20, 21, 22].map((id, index) => ({ id, index, printable: true })),
};
const b: ModelObjectStructure = { ...a, id: 2, index: 1, name: 'B', instanceCount: 1,
  volumes: [{ ...a.volumes[0], id: 11 }], instances: [{ id: 23, index: 0, printable: true }] };
let root: Root | undefined;
const runtime = {};
async function render(target: Parameters<typeof ObjectListContextMenu>[0]['target'], objectIds: number[], instanceIds: number[], volumeIds: number[] = [], structure: ModelObjectStructure[] = [a, b]) {
  useObjectListStore.setState({ structure, projection: {
    objectIds: new Set(objectIds), instanceIds: new Set(instanceIds), volumeIds: new Set(volumeIds),
  } });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(
    <PlatformProvider value={{ runtime } as unknown as PlatformCapabilities}>
      <ContextMenu open><ContextMenuTrigger><div /></ContextMenuTrigger>
        <ObjectListContextMenu target={target} onClose={() => undefined} />
      </ContextMenu>
    </PlatformProvider>,
  ));
}
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks();
});
describe('instance-aware Assemble menu', () => {
  it('assembles a selected instance together with a whole object from the instance menu', async () => {
    await render({ kind: 'instance', object: a, instance: a.instances[1] }, [2], [21]);
    const item = document.querySelector<HTMLElement>('[data-testid="objectlist-assemble"]');
    expect(item).not.toBeNull();
    await act(async () => item!.click());
    expect(assembleObjectsInList).toHaveBeenCalledWith(runtime,
      [{ objectId: 1, instanceIds: [21] }, { objectId: 2, instanceIds: [23] }], null);
  });
  it.each(['object', 'instances', 'partial-instances'] as const)('hides Assemble for one owning object through %s selection', async kind => {
    await render({ kind: 'object', object: a }, kind === 'object' ? [1] : [], kind === 'instances' ? [20, 21, 22] : kind === 'partial-instances' ? [20, 21] : []);
    expect(document.querySelector('[data-testid="objectlist-assemble"]')).toBeNull();
  });
  it.each(['object', 'instances'] as const)('assembles every selected instance across two owners through %s highlighting', async kind => {
    await render({ kind: 'object', object: b }, kind === 'object' ? [1, 2] : [2], kind === 'instances' ? [20, 21, 22] : []);
    const item = document.querySelector<HTMLElement>('[data-testid="objectlist-assemble"]');
    expect(item).not.toBeNull(); await act(async () => item!.click());
    expect(assembleObjectsInList).toHaveBeenCalledWith(runtime,
      [{ objectId: 1, instanceIds: [20, 21, 22] }, { objectId: 2, instanceIds: [23] }], null);
  });
  it.each(['object', 'instance', 'list'] as const)('hides Assemble for a selected cut object in the %s menu', async kind => {
    const cut = { ...a, isCut: true };
    const target = kind === 'object' ? { kind, object: b } : kind === 'instance'
      ? { kind, object: cut, instance: cut.instances[1] } : { kind };
    await render(target, [2], [21], [], [cut, b]);
    expect(document.querySelector('[data-testid="objectlist-assemble"]')).toBeNull();
    expect(assembleObjectsInList).not.toHaveBeenCalled();
  });
  it('keeps Assemble available when a cut object is not selected', async () => {
    const cut = { ...a, id: 3, index: 2, isCut: true, volumes: [{ ...a.volumes[0], id: 13 }], instances: [{ id: 24, index: 0, printable: true }], instanceCount: 1 };
    await render({ kind: 'object', object: b }, [1, 2], [], [], [a, b, cut]);
    expect(document.querySelector('[data-testid="objectlist-assemble"]')).not.toBeNull();
  });
  it('hides Assemble when a complete selected object carries cut metadata', async () => {
    const cut = { ...a, isCut: true };
    await render({ kind: 'object', object: cut }, [1, 2], [], [], [cut, b]);
    expect(document.querySelector('[data-testid="objectlist-assemble"]')).toBeNull();
  });
  it.each([
    { objects: [], instances: [21], parts: [] },
    { objects: [2], instances: [], parts: [] },
    { objects: [2], instances: [21], parts: [10] },
  ])('hides Assemble for one complete instance or an invalid part mixture: %j', async selection => {
    await render({ kind: 'object', object: b }, selection.objects, selection.instances, selection.parts);
    expect(document.querySelector('[data-testid="objectlist-assemble"]')).toBeNull();
  });
});
