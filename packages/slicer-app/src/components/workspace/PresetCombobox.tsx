import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';
import { SearchInput } from '@/components/ui/search-input';
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
}

/** Shared Orca-style presentation; identity and transition policy stay with the caller. */
export function PresetCombobox({ items, value, onValue, disabled, ariaLabel, testId,
  searchPlaceholder, emptyText, leading, triggerStyle, groupBy, modified }: {
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
}) {
  const [search, setSearch] = useState('');
  const entries = new Map(items.map(item => [item.id, item]));
  const groups = new Map<string, string[]>();
  if (groupBy) for (const item of items) {
    const label = groupBy(item);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item.id);
  }
  const renderItem = (id: string) => <ComboboxItem key={id} value={id} title={entries.get(id)!.name}>
    {entries.get(id)!.label}
  </ComboboxItem>;
  const query = search.toLocaleLowerCase();
  const visibleGroups = [...groups].map(([label, ids]) => ({ label,
    ids: ids.filter(id => entries.get(id)!.label.toLocaleLowerCase().includes(query)),
  })).filter(group => group.ids.length > 0);
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
    <DropdownMenuContent className="min-w-56" aria-label={ariaLabel}>
      <div className="p-1"><SearchInput value={search} onValueChange={setSearch}
        placeholder={searchPlaceholder} aria-label={searchPlaceholder}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')?.focus();
          }
          if (event.key !== 'Escape') event.stopPropagation();
        }} /></div>
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
