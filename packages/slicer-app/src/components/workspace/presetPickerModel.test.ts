import { expect, it } from 'vitest';
import { samePresetItems, type PresetComboItem } from './presetPickerModel';

it('retains equivalent picker projections but detects every visible change and native ordering', () => {
  const item: Required<PresetComboItem> = { id: 'a', name: 'A', label: 'A label', isUser: false,
    isProjectEmbedded: false, modified: false, group: 'Vendor', section: 'Compatible' };
  expect(samePresetItems([item], [{ ...item }])).toBe(true);
  for (const key of Object.keys(item) as Array<keyof PresetComboItem>) {
    const value = typeof item[key] === 'boolean' ? !item[key] : `${item[key]} changed`;
    expect(samePresetItems([item], [{ ...item, [key]: value }]), key).toBe(false);
  }
  const other = { ...item, id: 'b' };
  expect(samePresetItems([item, other], [other, item])).toBe(false);
  expect(samePresetItems([item], [])).toBe(false);
});
