import { describe, expect, it } from 'vitest';
import { assignmentTargetsForSelection } from './filamentAssignment';
import { EMPTY_PROJECTION } from './projection';
import type { ModelObjectStructure } from '@slicer/client';

const structure: Pick<ModelObjectStructure, 'volumes'>[] = [{ volumes: [
  { id: 21, index: 0, name: 'Part', type: 'model_part', isSplittable: false },
  { id: 22, index: 1, name: 'Modifier', type: 'parameter_modifier', isSplittable: false },
  { id: 23, index: 2, name: 'Negative', type: 'negative_volume', isSplittable: false },
  { id: 24, index: 3, name: 'Blocker', type: 'support_blocker', isSplittable: false },
  { id: 25, index: 4, name: 'Enforcer', type: 'support_enforcer', isSplittable: false },
] }];

describe('filament assignment targets', () => {
  it('uses the homogeneous selected object set once', () => {
    const targets = assignmentTargetsForSelection({ kind: 'object', id: 10 }, {
      objectIds: new Set([10, 11]), volumeIds: new Set(), instanceIds: new Set(),
    }, structure);
    expect(targets).toEqual([{ kind: 'object', id: 10 }, { kind: 'object', id: 11 }]);
  });

  it('does not invent a second selection model for a focused part', () => {
    expect(assignmentTargetsForSelection({ kind: 'part', id: 21 }, EMPTY_PROJECTION, structure))
      .toEqual([{ kind: 'model-part', id: 21 }]);
  });
  it('addresses a focused modifier through its native assignment kind', () => {
    expect(assignmentTargetsForSelection({ kind: 'part', id: 22 }, EMPTY_PROJECTION, structure))
      .toEqual([{ kind: 'parameter-modifier', id: 22 }]);
  });
  it('assigns mixed parts and modifiers while excluding negative/support/unknown volumes', () => {
    expect(assignmentTargetsForSelection({ kind: 'part', id: 22 }, {
      ...EMPTY_PROJECTION, volumeIds: new Set([21, 22, 23, 24, 25, 999]),
    }, structure)).toEqual([{ kind: 'model-part', id: 21 }, { kind: 'parameter-modifier', id: 22 }]);
  });
});
