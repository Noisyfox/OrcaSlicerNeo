import { describe, expect, it } from 'vitest';
import {
  canRenderPreparePaint,
  prepareColourForVolume,
  preparePaintMaterialOverlays,
  resolvePrepareMaterial,
} from './prepareColourProjection';
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
  it('retains imported eight-digit filament colours and alpha', () => {
    const imported = {
      ...snapshot,
      slots: [{ ...snapshot.slots[0], colour: { effective: '#E72F1DFF', provenance: 'user' } }],
    } as FilamentSessionSnapshot;
    expect(prepareColourForVolume(volume(0), structure, imported)).toBe('#E72F1DFF');
    expect(resolvePrepareMaterial({ baseColour: '#F4C032FF' }).colour).toBe('#f4c032');
    expect(resolvePrepareMaterial({ baseColour: '#F4C032FF' })).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
    expect(resolvePrepareMaterial({ baseColour: '#F4C03280' })).toMatchObject({ colour: '#f4c032', opacity: 128 / 255, transparent: true, depthWrite: false });
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
  it('lifts pure and very dark colours for both ordinary and selected rendering', () => {
    expect(resolvePrepareMaterial({ baseColour: '#000000' }).colour).toBe('#333333');
    expect(resolvePrepareMaterial({ baseColour: '#1a1a1a' }).colour).toBe('#333333');
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

  it('resolves painted states through the effective part assignment and numbered slots', () => {
    const twoSlots = {
      ...snapshot,
      slots: [
        { ...snapshot.slots[0], slot: 1, colour: { effective: '#ff0000', provenance: 'user' } },
        { ...snapshot.slots[0], slot: 2, colour: { effective: '#123456', provenance: 'user' } },
      ],
      assignments: {
        ...snapshot.assignments,
        objects: [{ ...snapshot.assignments.objects[0]!, effectiveSlot: 1 }],
        parts: [{ target: 'part', id: 20, objectId: 10, explicitSlot: 2, effectiveSlot: 2, inherited: false }],
      },
    } as unknown as FilamentSessionSnapshot;
    const overlays = preparePaintMaterialOverlays(
      volume(0),
      [0, 1, 2, 4].map((stateId) => ({ stateId, startIndex: stateId * 3, indexCount: 3 })),
      structure,
      twoSlots,
    );

    expect(overlays.map(({ stateId, colour }) => [stateId, colour])).toEqual([
      [0, '#123456'], // state 0 follows the part assignment rather than the object fallback
      [1, '#ff0000'],
      [2, '#123456'],
      [4, '#ff0000'], // missing slots display slot 1 without changing native state
    ]);
  });

  it('applies selection and out-of-bounds overlays to every paint group', () => {
    const groups = [
      { stateId: 0, startIndex: 0, indexCount: 3 },
      { stateId: 1, startIndex: 3, indexCount: 3 },
    ];
    const outOfBounds = { instances: [{
      objectIndex: 0, instanceIndex: 0, outOfBounds: true, unprintable: false, member: true,
    }] } as any;
    const unselected = preparePaintMaterialOverlays(volume(0), groups, structure, snapshot, outOfBounds);
    const selected = preparePaintMaterialOverlays(volume(0), groups, structure, snapshot, outOfBounds, true);

    expect(unselected[0]?.colour).not.toBe('#123456');
    expect(unselected[1]?.colour).not.toBe('#cbd5e1');
    expect(selected[0]?.colour).not.toBe(unselected[0]?.colour);
    expect(selected[1]?.colour).not.toBe(unselected[1]?.colour);
    expect(selected[0]?.colour).not.toBe(selected[1]?.colour);
  });

  it('uses the single-colour path for unprintable painted instances', () => {
    const unprintable = { instances: [{
      objectIndex: 0, instanceIndex: 0, outOfBounds: false, unprintable: true, member: true,
    }] } as any;
    expect(canRenderPreparePaint(volume(0), structure, unprintable)).toBe(false);
    expect(canRenderPreparePaint(volume(0), [{ ...structure[0]!, printable: false }], null)).toBe(false);
    expect(canRenderPreparePaint(volume(0), structure, {
      instances: [{ objectIndex: 0, instanceIndex: 0, outOfBounds: false, unprintable: false, member: false }],
    } as any)).toBe(true);
  });
});
