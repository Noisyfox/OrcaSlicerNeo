import { describe, expect, it } from 'vitest';
import { prepareColourForVolume, resolvePrepareMaterial } from './prepareColourProjection';
import type { FilamentSessionSnapshot, ModelObjectStructure } from '@slicer/client';

const structure: ModelObjectStructure[] = [{
  id: 10, index: 0, name: 'Cube', printable: true, instanceCount: 1,
  volumes: [
    { id: 20, index: 0, name: 'Body', type: 'model_part', isSplittable: false },
    { id: 21, index: 1, name: 'Modifier', type: 'parameter_modifier', isSplittable: false },
  ], instances: [{ id: 30, index: 0, printable: true }],
}];
const snapshot = {
  ok: true, version: 1,
  slots: [{ slot: 2, preset: { id: 'p', name: 'PETG' }, colour: { effective: '#123456', provenance: 'user' } }],
  mappings: { filament: [2], volume: [0], nozzle: [2], filament2: [2], physicalExtruder: [0] },
  flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
  capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
  assignments: {
    objects: [{ target: 'object', id: 10, objectId: 10, explicitSlot: 2, effectiveSlot: 2, inherited: false }],
    parts: [], modifiers: [],
  }, revisions: { session: 1, project: 1, result: 0, plates: {} }, status: { state: 'ready', error: null },
} as unknown as FilamentSessionSnapshot;

function volume(volumeIdx: number) {
  return { buffer: { objectIdx: 0, volumeIdx, instanceIdx: 0 } } as any;
}

describe('Prepare colour projection', () => {
  it('uses effective object assignment colour for printable model parts', () => {
    expect(prepareColourForVolume(volume(0), structure, snapshot)).toBe('#123456');
  });
  it('does not colour modifiers from ordinary printable-volume state', () => {
    expect(prepareColourForVolume(volume(1), structure, snapshot)).toBe('#cbd5e1');
  });
  it('keeps an out-of-bounds overlay distinct from the slot colour', () => {
    const plateSession = { instances: [{ objectIndex: 0, instanceIndex: 0, outOfBounds: true, unprintable: false, member: true }] } as any;
    expect(prepareColourForVolume(volume(0), structure, snapshot, plateSession)).not.toBe('#123456');
  });
  it('brightens the effective filament colour using OrcaSlicer HSL selection rendering', () => {
    expect(resolvePrepareMaterial({ baseColour: '#123456', selected: true }).colour).toBe('#2874bf');
    expect(resolvePrepareMaterial({ baseColour: '#ff0000', selected: true }).colour).toBe('#ff8080');
    expect(resolvePrepareMaterial({ baseColour: '#00ff00', selected: true }).colour).toBe('#80ff80');
  });
  it('lifts pure and very dark colours before brightening them', () => {
    expect(resolvePrepareMaterial({ baseColour: '#000000', selected: true }).colour).toBe('#737373');
    expect(resolvePrepareMaterial({ baseColour: '#1a1a1a', selected: true }).colour).toBe('#737373');
  });
  it('preserves the unselected colour and keeps transparency independent', () => {
    expect(resolvePrepareMaterial({ baseColour: '#123456' }).colour).toBe('#123456');
    expect(resolvePrepareMaterial({ baseColour: '#123456', selected: true, disabled: true, outOfBounds: true, transparent: true })).toEqual({
      colour: '#2874bf', opacity: 0.15, transparent: true, depthWrite: false,
    });
    expect(resolvePrepareMaterial({ baseColour: '#123456', disabled: true })).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
  });
});
