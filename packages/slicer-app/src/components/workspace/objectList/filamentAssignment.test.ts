import { describe, expect, it } from 'vitest';
import { assignmentTargetsForSelection } from './filamentAssignment';
import { EMPTY_PROJECTION } from './projection';

describe('filament assignment targets', () => {
  it('uses the homogeneous selected object set once', () => {
    const targets = assignmentTargetsForSelection({ kind: 'object', id: 10 }, {
      objectIds: new Set([10, 11]), volumeIds: new Set(), instanceIds: new Set(),
    });
    expect(targets).toEqual([{ kind: 'object', id: 10 }, { kind: 'object', id: 11 }]);
  });

  it('does not invent a second selection model for a focused part', () => {
    expect(assignmentTargetsForSelection({ kind: 'part', id: 21 }, EMPTY_PROJECTION))
      .toEqual([{ kind: 'model-part', id: 21 }]);
  });
});
