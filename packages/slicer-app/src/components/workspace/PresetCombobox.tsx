import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';
import { SearchInput } from '@/components/ui/search-input';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from '@/components/ui/select';
import { cn } from 'cn';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem,
  ComboboxList, ComboboxTrigger, ComboboxValue,
} from '@/components/ui/combobox';

export interface PresetComboItem {
  id: string;
  /** Complete canonical profile name, also used for tooltips. */
  name: string;
  /** Native display label (model or alias). */
  label: string;
  /** Nonempty preset overrides, when the caller exposes draft state. */
  modified?: boolean;
}

/** Shared Orca-style presentation; identity and transition policy stay with the caller. */
export function PresetCombobox({ items, value, onValue, disabled, ariaLabel, testId,
  searchPlaceholder, emptyText, leading, triggerStyle, groupBy, sectionBy, modified, mode = 'combobox' }: {
  /** Select uses the same opening, focus and item navigation as option editors. */
  mode?: 'combobox' | 'select';
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
  triggerStyle?: CSSProperties;
  groupBy?: (item: PresetComboItem) => string;
  /** Flat labelled sections, preserving the caller's candidate order. */
  sectionBy?: (item: PresetComboItem) => string;
}) {
  const [search, setSearch] = useState('');
  const entries = new Map(items.map(item => [item.id, item]));
  const groups = new Map<string, string[]>();
  if (sectionBy || groupBy) for (const item of items) {
    const label = (sectionBy ?? groupBy)!(item);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item.id);
  }
  const renderItem = (id: string) => <ComboboxItem key={id} value={id} title={entries.get(id)!.name}>
    <span className={cn(entries.get(id)!.modified && 'config-override-label')}>{entries.get(id)!.label}</span>
  </ComboboxItem>;
  const query = search.toLocaleLowerCase();
  const visibleGroups = [...groups].map(([label, ids]) => ({ label,
    ids: ids.filter(id => entries.get(id)!.label.toLocaleLowerCase().includes(query)),
  })).filter(group => group.ids.length > 0);
  if (mode === 'select') {
    const sections = sectionBy ? visibleGroups : [{ label: '', ids: items
      .filter(item => item.label.toLocaleLowerCase().includes(query)).map(item => item.id) }];
    return <Select value={value || null} onValueChange={id => id !== null && onValue(id)}
      items={items.map(item => ({ value: item.id, label: item.label }))} disabled={disabled}
      onOpenChange={open => { if (!open) setSearch(''); }}>
      <div className="flex min-w-0 flex-1 gap-1">
        {leading}
        <SelectTrigger variant="sidebar" className="min-w-0 flex-1" aria-label={ariaLabel}
          title={entries.get(value)?.name} data-testid={testId} style={triggerStyle}>
          <span className={cn('min-w-0 flex-1 truncate text-left', modified && 'config-override-label')}>
            {entries.get(value)?.label ?? '— select —'}
          </span>
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
        {sections.map(({ label, ids }) => <SelectGroup key={label}>
          {label && <SelectLabel className="flex items-center gap-2">
            <span className="shrink-0">{label}</span>
            <Separator className="min-w-8 flex-1" aria-hidden="true" />
          </SelectLabel>}
          {ids.map(id => <SelectItem key={id} value={id} title={entries.get(id)!.name}>
            <span className={cn('truncate', entries.get(id)!.modified && 'config-override-label')}>
              {entries.get(id)!.label}
            </span>
          </SelectItem>)}
        </SelectGroup>)}
        {sections.every(section => section.ids.length === 0) &&
          <div className="px-2 py-1 text-xs text-muted-foreground">{emptyText}</div>}
      </SelectContent>
    </Select>;
  }
  if (groupBy) return <DropdownMenu onOpenChange={open => { if (!open) setSearch(''); }}>
    <div className="flex min-w-0 flex-1 gap-1">
      {leading}
      <DropdownMenuTrigger disabled={disabled} render={<Button variant="ghost" size="sm" />}
        className="sidebar-dropdown min-w-0 flex-1 text-foreground" aria-label={ariaLabel}
        title={entries.get(value)?.name} data-testid={testId} style={triggerStyle}>
        <span className={cn('min-w-0 flex-1 truncate text-left', modified && 'config-override-label')}>{entries.get(value)?.label ?? '— select —'}</span>
        <ChevronDown className="sidebar-dropdown-arrow" />
      </DropdownMenuTrigger>
    </div>
    <DropdownMenuContent className="flex max-h-[min(60vh,32rem)] min-w-56 flex-col overflow-hidden" aria-label={ariaLabel}>
      <div className="shrink-0 p-1"><SearchInput value={search} onValueChange={setSearch}
        placeholder={searchPlaceholder} aria-label={searchPlaceholder}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitemradio"], [data-slot="dropdown-menu-sub-trigger"]')?.focus();
          }
          if (event.key !== 'Escape') event.stopPropagation();
        }} /></div>
      <div data-slot="preset-menu-list" className="min-h-0 overflow-y-auto">
      {visibleGroups.map(({ label, ids }) => <DropdownMenuSub key={label}>
          <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-[min(32rem,calc(100vw-1rem))]" aria-label={label}>
            <DropdownMenuRadioGroup value={value} onValueChange={onValue}>
              {ids.map(id => <DropdownMenuRadioItem key={id} value={id} title={entries.get(id)!.name} closeOnClick>
                  <span className="truncate">{entries.get(id)!.label}</span>
                </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>)}
      {visibleGroups.length === 0 &&
        <div className="px-2 py-1 text-xs text-muted-foreground">{emptyText}</div>}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
  return <Combobox inputValue={search} onInputValueChange={setSearch}
    value={value || null} onValueChange={id => id !== null && onValue(id)}
    items={items.map(item => item.id)} itemToStringLabel={id => entries.get(id)!.label}
    disabled={disabled}>
    <div className="flex min-w-0 flex-1 gap-1">
      {leading}
      <ComboboxTrigger variant="sidebar" className="min-w-0 flex-1"
        aria-label={ariaLabel} title={entries.get(value)?.name} data-testid={testId}
        disabled={disabled} style={triggerStyle} render={<Button variant="ghost" size="sm" />}>
        <span className={cn('min-w-0 flex-1 truncate text-left', modified && 'config-override-label')}><ComboboxValue placeholder="— select —" /></span>
      </ComboboxTrigger>
    </div>
    <ComboboxContent>
      {/* The trigger lives outside the popup so Base UI retains its anchor. */}
      <ComboboxInput placeholder={searchPlaceholder} showTrigger={false}
        searchValue={search} onClearSearch={() => setSearch('')} />
      {/* Collection children render Base UI's filtered items, not the full catalogue. */}
      <ComboboxList>{renderItem}</ComboboxList>
      <ComboboxEmpty>{emptyText}</ComboboxEmpty>
    </ComboboxContent>
  </Combobox>;
}
