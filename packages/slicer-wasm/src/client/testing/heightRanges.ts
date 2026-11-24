import type { HeightRangeBounds, HeightRangeCommand, HeightRangeRow } from '../types';

export function editMockRanges(current: HeightRangeRow[], command: HeightRangeCommand, parentHeight: string,
  nextRevision: () => number) {
  const rows = structuredClone(current);
  const same = (a: HeightRangeBounds, b: HeightRangeBounds) => a.min === b.min && a.max === b.max;
  const defaults = () => ({ layer_height: parentHeight, extruder: '0' });
  function add(min: number, max: number, values: Record<string, string>) {
    const old = rows.findIndex(row => same(row, { min, max }));
    if (old >= 0) rows.splice(old, 1);
    const row = { min, max, values: { ...values }, revision: nextRevision() };
    rows.push(row);
    return row;
  }
  let selection: HeightRangeBounds[] = [];
  if (command.operation === 'initialize') {
    if (!rows.length) add(0, 2, defaults());
  } else if (command.operation === 'paste') {
    for (const row of command.rows)
      if (!rows.some(existing => same(existing, row))) selection.push(add(row.min, row.max, row.values));
  } else {
    const targets = command.targets.map(target => {
      const row = rows.find(row => same(row, target) && row.revision === target.revision);
      if (!row) throw new Error('Height range changed since selection');
      return row;
    });
    if (!targets.length) throw new Error('Select at least one height range');
    selection = targets;
    const row = targets[0];
    switch (command.operation) {
      case 'append': {
        const next = rows[rows.indexOf(row) + 1];
        if (next && next.min < row.max) throw new Error('Insufficient gap after this height range');
        let end = next?.min ?? row.max + 2;
        if (next && next.min === row.max) {
          if (next.max - next.min < 0.1) throw new Error('Height range is too short to split');
          end = (next.min + next.max) / 2;
          rows.splice(rows.indexOf(next), 1);
          add(end, next.max, next.values);
        }
        selection = [add(row.max, end, defaults())];
        break;
      }
      case 'min':
      case 'max': {
        if (!Number.isFinite(command.value) || command.value < 0 || (command.operation === 'max' && command.value < row.min))
          throw new Error('Invalid height range endpoint');
        const min = command.operation === 'min' ? command.value : row.min;
        const max = command.operation === 'max' ? command.value : min >= row.max ? min + 0.5 : row.max;
        rows.splice(rows.indexOf(row), 1);
        selection = [add(min, max, row.values)];
        break;
      }
      case 'remove':
        for (const target of targets) rows.splice(rows.indexOf(target), 1);
        selection = [];
        break;
      case 'set':
      case 'reset':
        for (const target of targets) {
          const value = command.operation === 'set' ? String(command.value) : defaults()[command.key as keyof ReturnType<typeof defaults>];
          if (value === target.values[command.key]) continue;
          if (value === undefined) delete target.values[command.key];
          else target.values[command.key] = value;
          target.revision = nextRevision();
        }
        break;
    }
  }
  rows.sort((a, b) => a.min - b.min || a.max - b.max);
  return { rows, selection: selection.map(({ min, max }) => ({ min, max })), changed: JSON.stringify(current) !== JSON.stringify(rows) };
}
