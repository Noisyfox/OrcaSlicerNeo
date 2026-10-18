export interface PresetComboItem {
  id: string;
  isUser: boolean;
  isProjectEmbedded: boolean;
  name: string;
  label: string;
  modified?: boolean;
  group?: string;
  section?: string;
}

/** Compare only the complete picker projection, preserving native order. Raw
 * profile receipts still publish independently, including non-picker changes.
 */
export function samePresetItems(left: readonly PresetComboItem[], right: readonly PresetComboItem[]) {
  return left === right || (left.length === right.length && left.every((item, index) => {
    const next = right[index];
    return item.id === next.id && item.name === next.name && item.label === next.label &&
      item.isUser === next.isUser && item.isProjectEmbedded === next.isProjectEmbedded &&
      item.modified === next.modified && item.group === next.group && item.section === next.section;
  }));
}

export function presetSections(items: readonly PresetComboItem[], query = '') {
  const search = query.toLocaleLowerCase();
  return ['project', 'user', 'system'].map(origin => ({
    label: origin === 'project' ? 'Project-inside presets' : origin === 'user' ? 'User presets' : 'System presets',
    items: items.filter(item => (item.isProjectEmbedded ? 'project' : item.isUser ? 'user' : 'system') === origin &&
      (!search || item.label.toLocaleLowerCase().includes(search))),
  })).filter(section => section.items.length > 0);
}

export function presetGroups(items: readonly PresetComboItem[], property: 'group' | 'section') {
  const groups = new Map<string, PresetComboItem[]>();
  for (const item of items) {
    const label = item[property] ?? '';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }
  return [...groups].map(([label, items]) => ({ label, items }));
}
