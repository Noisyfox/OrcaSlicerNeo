import { expect, it, vi } from 'vitest';
import { hidesWipeTowers, InstanceHider, visibleToolVolumes } from './InstanceHider';

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
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toBe(volumes);
  const lease = hider.acquire(first);
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toEqual(volumes.slice(0, 2));
  expect(hider.isVisible(volumes[2])).toBe(false);
  expect(hider.isVisible(volumes[3])).toBe(false);
  lease.update(second);
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toEqual([volumes[2]]);
  lease.release();
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toBe(volumes);
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

it('isolates specific volumes across instances and objects while keeping towers visible', () => {
  const hider = new InstanceHider();
  const targets = [{ ...volumes[0].buffer }, { ...volumes[2].buffer }, { ...volumes[3].buffer }];
  const lease = hider.acquire({ kind: 'volumes', volumes: targets });
  const snapshot = hider.getSnapshot();
  expect(visibleToolVolumes(volumes, snapshot)).toEqual([volumes[0], volumes[2], volumes[3]]);
  expect(volumes.map(volume => hider.isVisible(volume))).toEqual([true, false, true, true]);
  expect(hidesWipeTowers(snapshot)).toBe(false);

  // Equivalent target sets do not invalidate React's external-store snapshot,
  // and later changes to the caller's data cannot change the active scope.
  lease.update({ kind: 'volumes', volumes: [targets[2], targets[0], targets[1], targets[0]] });
  expect(hider.getSnapshot()).toBe(snapshot);
  targets[0].volumeId = 99;
  expect(hider.isVisible(volumes[0])).toBe(true);

  lease.update({ kind: 'volumes', volumes: [volumes[1].buffer] });
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toEqual([volumes[1]]);
  lease.release();
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toBe(volumes);
});

it('preserves lease ownership and tower behavior when switching isolation kinds', () => {
  const hider = new InstanceHider(), changed = vi.fn(); hider.subscribe(changed);
  const oldTool = hider.acquire(first);
  expect(hidesWipeTowers(hider.getSnapshot())).toBe(true);
  const nextTool = hider.acquire({ kind: 'volumes', volumes: [volumes[3].buffer] });
  oldTool.update(second); oldTool.release();
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toEqual([volumes[3]]);
  expect(hidesWipeTowers(hider.getSnapshot())).toBe(false);
  nextTool.update(second);
  expect(visibleToolVolumes(volumes, hider.getSnapshot())).toEqual([volumes[2]]);
  expect(hidesWipeTowers(hider.getSnapshot())).toBe(true);
  nextTool.release();
  expect(hidesWipeTowers(hider.getSnapshot())).toBe(false);
  expect(changed).toHaveBeenCalledTimes(4);
});
