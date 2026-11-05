import { expect, it, vi } from 'vitest';
import { InstanceHider, visibleInstanceVolumes } from './InstanceHider';

const first = { objectId: 10, instanceId: 20 };
const second = { objectId: 10, instanceId: 21 };
const volumes = [
  { buffer: { ...first, volumeId: 30 } },
  { buffer: { ...first, volumeId: 31 } },
  { buffer: { ...second, volumeId: 30 } },
  { buffer: { objectId: 11, instanceId: 22, volumeId: 32 } },
];

it('projects every Part of one instance without changing or disposing the loaded collection', () => {
  const hider = new InstanceHider();
  expect(visibleInstanceVolumes(volumes, hider.getSnapshot())).toBe(volumes);
  const lease = hider.acquire(first);
  expect(visibleInstanceVolumes(volumes, hider.getSnapshot())).toEqual(volumes.slice(0, 2));
  expect(hider.isVisible(volumes[2])).toBe(false);
  expect(hider.isVisible(volumes[3])).toBe(false);
  lease.update(second);
  expect(visibleInstanceVolumes(volumes, hider.getSnapshot())).toEqual([volumes[2]]);
  lease.release();
  expect(visibleInstanceVolumes(volumes, hider.getSnapshot())).toBe(volumes);
  expect(volumes).toHaveLength(4);
});

it('keeps the snapshot stable across equivalent tool receipts and owns a copy of the target', () => {
  const hider = new InstanceHider(), changed = vi.fn();
  const unsubscribe = hider.subscribe(changed);
  const target = { ...first }, lease = hider.acquire(target), snapshot = hider.getSnapshot();
  target.instanceId = 99;
  lease.update({ ...first });
  expect(hider.getSnapshot()).toBe(snapshot);
  expect(hider.getSnapshot()).toEqual(first);
  expect(changed).toHaveBeenCalledTimes(1);
  unsubscribe();
  lease.release();
  expect(changed).toHaveBeenCalledTimes(1);
});

it('ignores an old tool cleanup or target update after a successor acquires isolation', () => {
  const hider = new InstanceHider(), changed = vi.fn(); hider.subscribe(changed);
  const oldTool = hider.acquire(first), nextTool = hider.acquire(second);
  oldTool.update(first); oldTool.release(); oldTool.release();
  expect(hider.getSnapshot()).toEqual(second);
  expect(changed).toHaveBeenCalledTimes(2);
  nextTool.release(); nextTool.release(); nextTool.update(first);
  expect(hider.getSnapshot()).toBeNull();
  expect(changed).toHaveBeenCalledTimes(3);
});
