import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
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
  searchPlaceholder, emptyText, leading, triggerStyle }: {
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
}) {
  const [search, setSearch] = useState('');
  const entries = new Map(items.map(item => [item.id, item]));
  return <Combobox inputValue={search} onInputValueChange={setSearch}
    value={value || null} onValueChange={id => id !== null && onValue(id)}
    items={items.map(item => item.id)} itemToStringLabel={id => entries.get(id)!.label}
    disabled={disabled}>
    <div className="flex min-w-0 flex-1 gap-1">
      {leading}
      <ComboboxTrigger variant="sidebar" className="min-w-0 flex-1"
        aria-label={ariaLabel} title={entries.get(value)?.name} data-testid={testId}
        disabled={disabled} style={triggerStyle} render={<Button variant="ghost" size="sm" />}>
        <span className="min-w-0 flex-1 truncate text-left"><ComboboxValue placeholder="— select —" /></span>
      </ComboboxTrigger>
    </div>
    <ComboboxContent>
      {/* The trigger lives outside the popup so Base UI retains its anchor. */}
      <ComboboxInput placeholder={searchPlaceholder} showTrigger={false}
        searchValue={search} onClearSearch={() => setSearch('')} />
      {/* Collection children render Base UI's filtered items, not the full catalogue. */}
      <ComboboxList>{id => <ComboboxItem key={id} value={id} title={entries.get(id)!.name}>
        {entries.get(id)!.label}
      </ComboboxItem>}</ComboboxList>
      <ComboboxEmpty>{emptyText}</ComboboxEmpty>
    </ComboboxContent>
  </Combobox>;
}
