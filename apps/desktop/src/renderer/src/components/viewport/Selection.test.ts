import { describe, expect, it } from 'vitest';
import { Selection, instanceKeyOf, type SelectableVolume } from './Selection';

function volume(objectIdx: number, volumeIdx: number, instanceIdx: number): SelectableVolume {
  return {
    id: `${objectIdx}:${volumeIdx}:${instanceIdx}`,
    buffer: { objectIdx, instanceIdx },
  };
}

const collection = [
  volume(0, 0, 0),
  volume(0, 1, 0),
  volume(0, 0, 1),
  volume(0, 1, 1),
  volume(1, 0, 0),
];

describe('Selection', () => {
  it('expands a hit to all GL volumes in its complete instance', () => {
    const selection = new Selection();

    expect(selection.replaceFromHit(collection[1], collection)).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0']);
    expect(selection.volumes(collection)).toEqual([collection[0], collection[1]]);
    expect(selection.instanceKeys(collection)).toEqual(new Set(['0:0']));
  });

  it('replaces on an ordinary hit and reports a no-op for the same instance', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);

    expect(selection.replaceFromHit(collection[1], collection)).toBe(false);
    expect(selection.replaceFromHit(collection[2], collection)).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:1', '0:1:1']);
  });

  it('toggles complete instances while preserving the other selected instances', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);

    expect(selection.toggleFromHit(collection[2], collection)).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0', '0:0:1', '0:1:1']);
    expect(selection.toggleFromHit(collection[1], collection)).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:1', '0:1:1']);
  });

  it('repairs a partial stale instance when it is toggled back in', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);
    selection.prune([collection[0], ...collection.slice(2)]);

    expect(selection.toggleFromHit(collection[1], collection)).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0']);
  });

  it('prunes deleted volumes and can clear the remaining selection', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);

    expect(selection.prune([collection[0], ...collection.slice(2)])).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0']);
    expect(selection.clear()).toBe(true);
    expect(selection.empty).toBe(true);
    expect(selection.clear()).toBe(false);
  });
});

describe('instanceKeyOf', () => {
  it('does not conflate equal instance indexes on different objects', () => {
    expect(instanceKeyOf(collection[0])).toBe('0:0');
    expect(instanceKeyOf(collection[4])).toBe('1:0');
  });
});
