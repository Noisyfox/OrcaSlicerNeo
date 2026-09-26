import { describe, expect, it } from 'vitest';
import {
  canRenderPreparePaint,
  isModelInstanceMarkedUnprintable,
  prepareColourForVolume,
  preparePaintMaterialOverlays,
  resolvePrepareMaterial,
  resolveUnprintableMaterial,
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

function volume(volumeIdx: number, instanceId = 30, instanceIdx = 0) {
  return { buffer: {
    objectId: 10, volumeId: 20 + volumeIdx, instanceId,
    objectIdx: 0, volumeIdx, instanceIdx,
  } } as any;
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

  it('uses Orca default semi-transparent black for a model marked unprintable', () => {
    expect(resolveUnprintableMaterial()).toEqual({
      colour: '#000000', opacity: 0.5, transparent: true, depthWrite: false,
    });
    expect(resolveUnprintableMaterial(true)).toEqual({
      colour: '#404040', opacity: 0.5, transparent: true, depthWrite: false,
    });
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

  it('keeps Prepare paint colours in Preview while applying only the transparent shell overlay', () => {
    const twoSlots = {
      ...snapshot,
      slots: [
        { ...snapshot.slots[0], slot: 1, colour: { effective: '#ff0000', provenance: 'user' } },
        { ...snapshot.slots[0], slot: 2, colour: { effective: '#123456', provenance: 'user' } },
      ],
      assignments: {
        ...snapshot.assignments,
        parts: [{ target: 'part', id: 20, objectId: 10, explicitSlot: 2, effectiveSlot: 2, inherited: false }],
      },
    } as unknown as FilamentSessionSnapshot;
    const groups = [
      { stateId: 0, startIndex: 0, indexCount: 3 },
      { stateId: 1, startIndex: 3, indexCount: 3 },
    ];
    const prepare = preparePaintMaterialOverlays(volume(0), groups, structure, twoSlots);
    const preview = preparePaintMaterialOverlays(volume(0), groups, structure, twoSlots, null, false, true);

    expect(preview.map(({ stateId, colour }) => [stateId, colour]))
      .toEqual(prepare.map(({ stateId, colour }) => [stateId, colour]));
    expect(preview).toEqual(prepare.map((material) => ({
      ...material,
      opacity: 0.15,
      transparent: true,
      depthWrite: false,
    })));
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

  it('keeps painted groups when the model moves completely outside every plate', () => {
    const groups = [0, 1].map((stateId) => ({ stateId, startIndex: stateId * 3, indexCount: 3 }));
    const crossing = { instances: [{
      objectIndex: 0, instanceIndex: 0, outOfBounds: true, unprintable: false, member: true,
    }] } as any;
    const fullyOutside = { instances: [{
      objectIndex: 0, instanceIndex: 0, outOfBounds: false, unprintable: true, member: false,
    }] } as any;

    expect(canRenderPreparePaint(volume(0), structure)).toBe(true);
    expect(isModelInstanceMarkedUnprintable(volume(0), structure)).toBe(false);
    const outsideMaterials = preparePaintMaterialOverlays(volume(0), groups, structure, snapshot, fullyOutside);
    expect(outsideMaterials).toEqual(preparePaintMaterialOverlays(volume(0), groups, structure, snapshot, crossing));
    expect(outsideMaterials[0]?.colour).not.toBe(outsideMaterials[1]?.colour);
    expect(preparePaintMaterialOverlays(volume(0), groups, structure, snapshot, fullyOutside, true))
      .toEqual(preparePaintMaterialOverlays(volume(0), groups, structure, snapshot, crossing, true));
  });

  it('uses the single-colour path for an object marked unprintable', () => {
    const unprintableObject = [{ ...structure[0]!, printable: false }];
    expect(canRenderPreparePaint(volume(0), unprintableObject)).toBe(false);
    expect(isModelInstanceMarkedUnprintable(volume(0), unprintableObject)).toBe(true);
  });

  it('uses the native instance printable flag independently of plate status', () => {
    const twoInstances: ModelObjectStructure[] = [{
      ...structure[0]!,
      instanceCount: 2,
      instances: [
        { id: 31, index: 1, printable: false },
        { id: 30, index: 0, printable: true },
      ],
    }];
    expect(canRenderPreparePaint(volume(0, 31, 1), twoInstances)).toBe(false);
    expect(isModelInstanceMarkedUnprintable(volume(0, 31, 1), twoInstances)).toBe(true);
    expect(canRenderPreparePaint(volume(0, 999, 1), twoInstances)).toBe(false);
    expect(canRenderPreparePaint(volume(0, 30, 0), twoInstances)).toBe(true);
  });
});
