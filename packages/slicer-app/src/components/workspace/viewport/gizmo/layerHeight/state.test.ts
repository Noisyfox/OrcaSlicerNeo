import { saveProject, saveProjectAs } from '@/projectActions';
import { sliceModel } from '../../../actions/sliceActions';
import { afterEach, expect, it, vi } from 'vitest';
import { closeLayerHeightForSlice, registerLayerHeightScene, useLayerHeight } from './state';

afterEach(() => useLayerHeight.setState({ busy: false }));
it('ignores Slice while brushing and closes only an idle layer-height editor', () => {
  const scene = { gizmo: 'layer-height', closeGizmo: vi.fn(() => true) };
  const dispose = registerLayerHeightScene(scene);
  try {
    useLayerHeight.setState({ busy: true });
    expect(closeLayerHeightForSlice()).toBe(false);
    expect(scene.closeGizmo).not.toHaveBeenCalled();
    useLayerHeight.setState({ busy: false });
    expect(closeLayerHeightForSlice()).toBe(true);
    expect(scene.closeGizmo).toHaveBeenCalledTimes(1);
    scene.gizmo = 'move';
    expect(closeLayerHeightForSlice()).toBe(true);
    expect(scene.closeGizmo).toHaveBeenCalledTimes(1);
  } finally { dispose(); }
});

it('rejects Save, Save As and Slice at command admission without queuing work', async () => {
  const forbidden = new Proxy({}, { get() { throw new Error('Unexpected platform access during stroke'); } }) as never;
  useLayerHeight.setState({ busy: true });
  expect(await saveProject(forbidden)).toEqual({ status: 'cancelled' });
  expect(await saveProjectAs(forbidden)).toEqual({ status: 'cancelled' });
  await sliceModel(forbidden);
  useLayerHeight.setState({ busy: false });
  await Promise.resolve();
});
