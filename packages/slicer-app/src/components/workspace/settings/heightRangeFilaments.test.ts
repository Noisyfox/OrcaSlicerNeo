import { expect, it } from 'vitest';
import type { HeightRangeRow, FilamentRoutingProjection, OptionMetadata } from '@slicer/client';
import { rangeFilamentFields, rangeOverrideKeys } from './heightRangeEditor';

const route: FilamentRoutingProjection = { target: 'object', id: 7, objectId: 7, selector: 'outer-wall',
  explicitSlot: 2, effectiveSlot: 2, inherited: false, defaulted: false };
const rack = { assignments: { objects: [], parts: [], modifiers: [] }, routing: [
  route, { ...route, target: 'model-part' as const, id: 11, explicitSlot: 4, effectiveSlot: 4 },
] };
function outer(...values: HeightRangeRow['values'][]) {
  const rows = values.map((config, i) => ({ min: i, max: i + 1, revision: i + 1, values: config }));
  return rangeFilamentFields(7, rows, {}, rack).find(field => field.key === 'outer_wall_filament_id');
}
it('displays the object selector on inheritance and the range base for explicit Default', () => {
  expect(outer({ extruder: '3' })).toMatchObject({ local: false, value: '2', filamentRoute: { effectiveSlot: 2 } });
  expect(outer({ extruder: '3', outer_wall_filament_id: '0' })).toMatchObject({
    local: true, value: '0', filamentRoute: { effectiveSlot: 3 },
  });
});
it('keeps distinct Default and inherited selections when editing sibling ranges', () => {
  expect(outer({ extruder: '3' }, { extruder: '3', outer_wall_filament_id: '0' })).toMatchObject({
    mixed: true, resettable: true, filamentRoute: { effectiveSlot: null },
  });
});

it('marks only editable range overrides relative to the current parent layer height', () => {
  const metadata: OptionMetadata = { layer_height: { type: 'float' }, wall_loops: { type: 'int', scopes: ['part'] } };
  const row = { min: 2, max: 4, revision: 3, values: { layer_height: '0.20', extruder: '0', imported_unknown: '7' } };
  expect(rangeOverrideKeys(row, metadata, '0.2')).toEqual([]);
  expect(rangeOverrideKeys(row, metadata, '0.16')).toEqual(['layer_height']);
  const edited = { ...row, values: { ...row.values, extruder: '2', wall_loops: '4', outer_wall_filament_id: '0' } };
  expect(rangeOverrideKeys(edited, metadata, '0.2')).toEqual(['extruder', 'wall_loops', 'outer_wall_filament_id']);
  metadata.wall_loops.readonly = true;
  expect(rangeOverrideKeys(edited, metadata, '0.2')).toEqual(['extruder', 'outer_wall_filament_id']);
});
