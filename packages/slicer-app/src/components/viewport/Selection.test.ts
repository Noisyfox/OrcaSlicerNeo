import { describe, expect, it } from 'vitest';
import { Selection, instanceKeyOf, type SelectableVolume } from './Selection';

function volume(objectIdx: number, volumeIdx: number, instanceIdx: number): SelectableVolume {
  return {
    id: `${objectIdx}:${volumeIdx}:${instanceIdx}`,
    buffer: { objectIdx, volumeIdx, instanceIdx },
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

  it('replaces the selection with exactly the given volume IDs', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);

    expect(selection.replaceIds(['0:0:1', '0:1:1', '1:0:0'])).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:1', '0:1:1', '1:0:0']);
    expect(selection.replaceIds(['0:0:1', '0:1:1', '1:0:0'])).toBe(false);
    expect(selection.replaceIds([])).toBe(true);
    expect(selection.empty).toBe(true);
  });

  it('unions volume IDs additively without touching the existing selection', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);

    expect(selection.addIds(['0:0:1', '0:1:1'])).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0', '0:0:1', '0:1:1']);
    expect(selection.addIds(['0:0:1'])).toBe(false);
    expect([...selection.ids]).toHaveLength(4);
  });
});

describe('Selection expansion modes', () => {
  it('object mode expands a hit to every volume of the object', () => {
    const selection = new Selection();
    expect(selection.replaceFromHit(collection[1], collection, 'object')).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0', '0:0:1', '0:1:1']);
  });

  it('volume mode anchors the part to the clicked instance (Orca)', () => {
    const selection = new Selection();
    expect(selection.replaceFromHit(collection[1], collection, 'volume')).toBe(true);
    expect([...selection.ids]).toEqual(['0:1:0']);
  });

  it('toggleFromHit respects the expansion mode', () => {
    const selection = new Selection();
    selection.replaceFromHit(collection[0], collection);
    expect(selection.toggleFromHit(collection[4], collection, 'object')).toBe(true);
    // Object 0 (instance toggle) then object 1 added: ids for both objects
    const a = [...selection.ids];
    expect(a).toEqual(['0:0:0', '0:1:0', '1:0:0']);
  });

  it('replaceComposite selects an object, a volume, or an instance by width', () => {
    const selection = new Selection();
    expect(selection.replaceComposite(collection, { objectIdx: 0 })).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0', '0:0:1', '0:1:1']);

    expect(selection.replaceComposite(collection, { objectIdx: 0, volumeIdx: 1 })).toBe(true);
    // A part target is anchored to one instance (default 0 when not given).
    expect([...selection.ids]).toEqual(['0:1:0']);

    expect(selection.replaceComposite(collection, { objectIdx: 0, instanceIdx: 0 })).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0']);
  });

  it('toggleComposite toggles a target group', () => {
    const selection = new Selection();
    selection.replaceComposite(collection, { objectIdx: 0 });
    expect(selection.toggleComposite(collection, { objectIdx: 1 })).toBe(true);
    const all = [...selection.ids];
    expect(all).toEqual(['0:0:0', '0:1:0', '0:0:1', '0:1:1', '1:0:0']);
    expect(selection.toggleComposite(collection, { objectIdx: 1 })).toBe(true);
    expect([...selection.ids]).toEqual(['0:0:0', '0:1:0', '0:0:1', '0:1:1']);
  });
});

describe('instanceKeyOf', () => {
  it('does not conflate equal instance indexes on different objects', () => {
    expect(instanceKeyOf(collection[0])).toBe('0:0');
    expect(instanceKeyOf(collection[4])).toBe('1:0');
  });
});
