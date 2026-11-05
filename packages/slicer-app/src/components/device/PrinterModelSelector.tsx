import { useMemo, useState } from 'react';
import type { ConfiguredPrinterModel } from '@orca/printer-control/domain';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem,
  ComboboxList, ComboboxTrigger } from '@/components/ui/combobox';

const unspecified = 'unspecified';
const keyOf = ({ vendorId, model }: ConfiguredPrinterModel) => JSON.stringify([vendorId, model]);

/** Uses enabled system profiles only; opening this field never installs profiles. */
export function PrinterModelSelector({ value, onChange }: {
  value: ConfiguredPrinterModel | undefined;
  onChange(value: ConfiguredPrinterModel | undefined): void;
}) {
  const printers = useSettingsStore(s => s.printers);
  const [search, setSearch] = useState('');
  const models = useMemo(() => {
    const entries = new Map<string, ConfiguredPrinterModel>();
    for (const printer of printers) {
      // Frozen project copies can inherit a system picker classification, but
      // do not own its resource vendor. They are not system model choices.
      if (!printer.is_visible || printer.is_default || printer.is_user || printer.is_project_embedded ||
          !printer.vendor_id || !printer.model) continue;
      const model = { vendorId: printer.vendor_id, model: printer.model };
      entries.set(keyOf(model), model);
    }
    return entries;
  }, [printers]);
  const items = useMemo(() => [unspecified, ...models.keys()], [models]);
  const label = (key: string) => {
    const model = models.get(key);
    return model ? [model.vendorId, model.model].filter(Boolean).join(' · ') : 'Not specified';
  };
  const selectedLabel = value ? [value.vendorId, value.model].filter(Boolean).join(' · ') : 'Not specified';
  return <Field orientation="responsive">
    <FieldLabel className="@md/field-group:w-40! @md/field-group:flex-none!" htmlFor="device-printer-model">Printer model <span className="text-muted-foreground">(optional)</span></FieldLabel>
    <FieldContent className="min-w-0">
      <Combobox items={items} value={value ? keyOf(value) : unspecified} itemToStringLabel={label}
        inputValue={search} onInputValueChange={setSearch} onOpenChange={open => { if (!open) setSearch(''); }}
        onValueChange={key => { if (key !== null) onChange(models.get(key)); }}>
        <ComboboxTrigger id="device-printer-model" aria-label="Printer model" data-testid="device-printer-model"
          aria-describedby="device-printer-model-description" title={selectedLabel}
          className="w-full justify-between" render={<Button variant="outline" />}>
          <span className="min-w-0 truncate">{selectedLabel}</span>
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput aria-label="Search printer models" placeholder="Search printer models…" showTrigger={false}
            searchValue={search} onClearSearch={() => setSearch('')} />
          <ComboboxGroup>
            <ComboboxList>{(key: string) => <ComboboxItem key={key} value={key} title={label(key)}><span className="min-w-0 truncate">{label(key)}</span></ComboboxItem>}</ComboboxList>
          </ComboboxGroup>
          <ComboboxEmpty>No matching printer models.</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      <FieldDescription id="device-printer-model-description">Not specified allows any project printer model.</FieldDescription>
    </FieldContent>
  </Field>;
}
