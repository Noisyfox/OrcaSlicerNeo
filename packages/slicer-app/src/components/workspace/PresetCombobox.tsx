import { memo, useLayoutEffect, useRef, useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';
import { SearchInput } from '@/components/ui/search-input';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from '@/components/ui/select';
import { cn } from 'cn';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuGroup,
  DropdownMenuLabel
} from '@/components/ui/dropdown-menu';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection
} from '@/components/ui/combobox';

/** Shared Orca-style presentation; identity and transition policy stay with the caller. */
export const PresetCombobox = memo(function PresetCombobox({ items, value, onValue, disabled, ariaLabel, testId,
  searchPlaceholder, emptyText, leading, trailing, prependItems, triggerStyle, modified, mode = 'combobox' }: {
  /** Select uses the same opening, focus and item navigation as option editors. */
  mode?: 'combobox' | 'select' | 'grouped';
  modified: boolean;
  items: readonly PresetComboItem[];
  value: string;
  onValue: (id: string) => void;
  disabled: boolean;
  ariaLabel: string;
  testId?: string;
  searchPlaceholder: string;
  emptyText: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  prependItems?: (query: string) => ReactNode;
  triggerStyle?: CSSProperties;
}) {
  const [search, setSearch] = useState('');
  const entries = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const selectItems = useMemo(() => mode === 'select' ? items.map(item => ({ value: item.id, label: item.label })) : [], [items, mode]);
  const sections = useMemo(() => presetSections(items).map(section => ({ label: section.label, items: section.items.map(item => item.id) })), [items]);
  const itemLabel = useCallback((id: string) => entries.get(id)!.label, [entries]);
  const renderItem = useCallback((id: string) => <ComboboxItem key={id} value={id} title={entries.get(id)!.name}>
    <span className={cn(entries.get(id)!.modified && 'config-override-label')}>{entries.get(id)!.label}</span>
  </ComboboxItem>, [entries]);
  if (mode === 'select') {
    return <Select value={value || null} onValueChange={id => id !== null && onValue(id)}
      items={selectItems} disabled={disabled}
      onOpenChange={open => { if (!open) setSearch(''); }}>
      <div className="flex min-w-0 flex-1 gap-1">
        {leading}
        <SelectTrigger variant="sidebar" className="min-w-0 flex-1" aria-label={ariaLabel}
          title={entries.get(value)?.name} data-testid={testId} style={triggerStyle}>
          <span className={cn('min-w-0 flex-1 truncate text-left', modified && 'config-override-label')}>
            {entries.get(value)?.label ?? '— select —'}
          </span>
          {trailing}
        </SelectTrigger>
      </div>
      <SelectContent align="start" aria-label={ariaLabel}
        className="max-h-[min(60vh,32rem)] max-w-[min(var(--available-width),calc(100vw-1rem))] min-w-[max(var(--anchor-width),14rem)]"
        header={<div className="p-1"><SearchInput value={search} onValueChange={setSearch}
          placeholder={searchPlaceholder} aria-label={searchPlaceholder}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              event.currentTarget.closest('[data-slot="select-content"]')?.querySelector<HTMLElement>('[role="option"]')?.focus();
            }
            if (event.key !== 'Escape') event.stopPropagation();
          }} /></div>}>
        <PresetSelectOptions items={items} search={search} emptyText={emptyText} />
      </SelectContent>
    </Select>;
  }
  if (mode === 'grouped') return <DropdownMenu onOpenChange={open => { if (!open) setSearch(''); }}>
    <div className="flex min-w-0 flex-1 gap-1">
      {leading}
      <DropdownMenuTrigger disabled={disabled} render={<Button variant="ghost" size="sm" />}
        className="sidebar-dropdown min-w-0 flex-1 text-foreground" aria-label={ariaLabel}
        title={entries.get(value)?.name} data-testid={testId} style={triggerStyle}>
        <span className={cn('min-w-0 flex-1 truncate text-left', modified && 'config-override-label')}>{entries.get(value)?.label ?? '— select —'}</span>
        {trailing}
        <ChevronDown className="sidebar-dropdown-arrow" />
      </DropdownMenuTrigger>
    </div>
    <DropdownMenuContent className="flex max-h-[min(60vh,32rem)] min-w-56 flex-col overflow-hidden" aria-label={ariaLabel}>
      <div className="shrink-0 p-1"><SearchInput value={search} onValueChange={setSearch}
        placeholder={searchPlaceholder} aria-label={searchPlaceholder}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [data-slot="dropdown-menu-sub-trigger"]')?.focus();
          }
          if (event.key !== 'Escape') event.stopPropagation();
        }} /></div>
      <div data-slot="preset-menu-list" className="min-h-0 overflow-y-auto">
      <PresetMenuOptions items={items} search={search} emptyText={emptyText} value={value} onValue={onValue} prependItems={prependItems} />
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
  return <Combobox inputValue={search} onInputValueChange={setSearch}
    value={value || null} onValueChange={id => id !== null && onValue(id)}
    items={sections} itemToStringLabel={itemLabel}
    disabled={disabled}>
    <div className="flex min-w-0 flex-1 gap-1">
      {leading}
      <ComboboxTrigger variant="sidebar" className="min-w-0 flex-1"
        aria-label={ariaLabel} title={entries.get(value)?.name} data-testid={testId}
        disabled={disabled} style={triggerStyle} render={<Button variant="ghost" size="sm" />}>
        <span className={cn('min-w-0 flex-1 truncate text-left', modified && 'config-override-label')}><ComboboxValue placeholder="— select —" /></span>
        {trailing}
      </ComboboxTrigger>
    </div>
    <ComboboxContent>
      {/* The trigger lives outside the popup so Base UI retains its anchor. */}
      <ComboboxInput placeholder={searchPlaceholder} showTrigger={false}
        searchValue={search} onClearSearch={() => setSearch('')} />
      {/* Collection children render Base UI's filtered items, not the full catalogue. */}
      <ComboboxList>{(section: { label: string; items: string[] }) =>
        <ComboboxGroup key={section.label} items={section.items}>
          <ComboboxLabel className="flex items-center gap-2">{heading(section.label)}</ComboboxLabel>
          <ComboboxCollection>{renderItem}</ComboboxCollection>
        </ComboboxGroup>}
      </ComboboxList>
      <ComboboxEmpty>{emptyText}</ComboboxEmpty>
    </ComboboxContent>
  </Combobox>;
}, (previous, next) => samePresetItems(previous.items, next.items) &&
  [...new Set([...Object.keys(previous), ...Object.keys(next)])].every(key => key === 'items' ||
    previous[key as keyof typeof previous] === next[key as keyof typeof next]));

function heading(label: string) { return <><span className="shrink-0">{label}</span>
  <Separator className="min-w-8 flex-1" aria-hidden="true" /></>; }

// These components execute beneath the existing Portal. Closing transitions and
// focus restoration retain Base UI's lifecycle; a closed popup builds no rows.
const PresetSelectOptions = memo(function PresetSelectOptions({ items, search, emptyText }: {
  items: readonly PresetComboItem[]; search: string; emptyText: string;
}) {
  const visibleSections = useMemo(() => presetSections(items, search), [items, search]);
  return <>
        {visibleSections.map(section => <SelectGroup key={section.label}>
          <SelectLabel className="flex items-center gap-2">{heading(section.label)}</SelectLabel>
          {presetGroups(section.items, 'section').map(({ label, items: groupedItems }) => <SelectGroup key={label}>
            {label && <SelectLabel>{label}</SelectLabel>}
            {groupedItems.map(item => <SelectItem key={item.id} value={item.id} title={item.name}>
              <span className={cn('truncate', item.modified && 'config-override-label')}>
                {item.label}
              </span>
            </SelectItem>)}
          </SelectGroup>)}
        </SelectGroup>)}
        {visibleSections.length === 0 &&
          <div className="px-2 py-1 text-xs text-muted-foreground">{emptyText}</div>}
  </>;
});

const PresetMenuOptions = memo(function PresetMenuOptions({ items, search, emptyText, value, onValue, prependItems }: {
  items: readonly PresetComboItem[]; search: string; emptyText: string; value: string; onValue: (id: string) => void; prependItems?: (query: string) => ReactNode;
}) {
  const visibleSections = useMemo(() => presetSections(items, search), [items, search]);
  const prepended = prependItems?.(search);
  return <>
      {prepended}
      {visibleSections.map(section => <DropdownMenuGroup key={section.label}>
        <DropdownMenuLabel className="flex items-center gap-2">{heading(section.label)}</DropdownMenuLabel>
        {presetGroups(section.items, 'group').map(({ label, items: groupedItems }) => <DropdownMenuSub key={label}>
          <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-[min(32rem,calc(100vw-1rem))]" aria-label={label}>
            <PresetVendorOptions items={groupedItems} value={value} onValue={onValue} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>)}
      </DropdownMenuGroup>)}
      {visibleSections.length === 0 && !prepended &&
        <div className="px-2 py-1 text-xs text-muted-foreground">{emptyText}</div>}
  </>;
});

const PresetVendorOptions = memo(function PresetVendorOptions({ items, value, onValue }: {
  items: readonly PresetComboItem[]; value: string; onValue: (id: string) => void;
}) {
  return <DropdownMenuRadioGroup value={value} onValueChange={onValue}>
    {items.map(item => <DropdownMenuRadioItem key={item.id} value={item.id} title={item.name} closeOnClick>
      <span className="truncate">{item.label}</span>
    </DropdownMenuRadioItem>)}
  </DropdownMenuRadioGroup>;
});

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

/** Stable event identity, always dispatching to the latest committed render. */
export function useCommittedCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
