import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  usePlatform,
  type ConfiguredPrinterModel,
  type Id,
  type PrinterConfigurationForm,
  type PrinterTypeDescriptor,
  type TargetRequest,
} from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PrinterModelSelector } from './PrinterModelSelector';

type ConfigurableType = PrinterTypeDescriptor & { form: PrinterConfigurationForm };

export function PrinterConfigurationDialog({ target, opener, onClose, onSaved }: {
  target: TargetRequest | null;
  opener: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { printers: { service } } = usePlatform();
  const [types, setTypes] = useState<readonly ConfigurableType[]>([]);
  const [typeId, setTypeId] = useState<Id<'printer-type'> | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [printerModel, setPrinterModel] = useState<ConfiguredPrinterModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID() as Id<'request'>);
  const alive = useRef(true);
  const sending = useRef(false);
  const selected = types.find(type => type.id === typeId);

  useEffect(() => {
    let active = true;
    alive.current = true;
    void (async () => {
      const catalogue = await service.listTypes();
      if (!catalogue.ok) throw new Error('Printer types unavailable');
      const available = catalogue.value.flatMap(type => type.manualConfiguration.kind === 'supported'
        ? [{ ...type, form: type.manualConfiguration.constraints }] : []);
      const draft = target ? await service.configurations.read(target) : null;
      if (draft && !draft.ok) throw new Error('Printer configuration unavailable');
      if (!active) return;
      const configuration = draft?.ok ? draft.value : null;
      const initial = configuration ? available.find(type => type.id === configuration.typeId) : available[0];
      setTypes(available);
      setTypeId(initial?.id ?? null);
      setDisplayName(configuration?.displayName ?? '');
      setValues(Object.fromEntries(initial?.form.fields.map(field =>
        [field.key, configuration?.values[field.key] ?? field.defaultValue]) ?? []));
      setPrinterModel(configuration?.printerModel ?? null);
      if (!initial) setError('No available agent supports manual configuration for this printer.');
    })().catch(() => { if (active) setError('Unable to load printer configuration.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; alive.current = false; };
  }, [service, target]);

  function selectType(value: string | null) {
    const next = types.find(type => type.id === value);
    if (!next) return;
    setTypeId(next.id);
    setValues(current => Object.fromEntries(next.form.fields.map(field => [field.key, current[field.key] ?? field.defaultValue])));
    if (!next.form.supportsModelSelection) setPrinterModel(null);
    setError(null);
  }

  async function save() {
    if (!selected || loading || sending.current) return;
    sending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await service.configurations.save({ requestId, target, typeId: selected.id,
        hostId: selected.form.hostId, displayName, values, printerModel: selected.form.supportsModelSelection ? printerModel : null });
      if (!result.ok) throw new Error('Configuration rejected');
      if (alive.current) await onSaved();
    } catch { if (alive.current) setError('Unable to save printer configuration.'); }
    finally { sending.current = false; if (alive.current) setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !sending.current) onClose(); }} disablePointerDismissal>
    <DialogContent finalFocus={opener} className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto" data-testid="device-config-dialog">
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <DialogHeader>
          <DialogTitle>{target ? 'Edit printer' : 'Add printer'}</DialogTitle>
          <DialogDescription>{selected?.description ?? 'Choose an available printer agent.'}</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status">Loading printer configuration…</p> : <fieldset disabled={saving} className="min-w-0">
          <FieldGroup>
            <Field orientation="responsive">
              <FieldLabel className="@md/field-group:w-40! @md/field-group:flex-none!" htmlFor="device-display-name">Display name</FieldLabel>
              <FieldContent className="min-w-0">
                <Input id="device-display-name" data-testid="device-display-name" value={displayName}
                  onChange={event => setDisplayName(event.target.value)} autoFocus required />
              </FieldContent>
            </Field>
            <Field orientation="responsive">
              <FieldLabel className="@md/field-group:w-40! @md/field-group:flex-none!" htmlFor="device-adapter">Adapter</FieldLabel>
              <FieldContent className="min-w-0">
                <Select value={typeId} items={types.map(type => ({ value: type.id, label: type.name }))} onValueChange={selectType}>
                  <SelectTrigger id="device-adapter" className="w-full" data-testid="device-adapter">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>{types.map(type => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectGroup>
                  </SelectContent>
                </Select>
              </FieldContent>
            </Field>
            {selected?.form.supportsModelSelection && <PrinterModelSelector value={printerModel ?? undefined}
              onChange={value => setPrinterModel(value ?? null)} />}
            {selected?.form.fields.map(field => {
              const id = `device-${field.key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
              return <Field key={field.key} orientation="responsive">
                <FieldLabel className="@md/field-group:w-40! @md/field-group:flex-none!" htmlFor={id}>
                  {field.label}{!field.required && field.type !== 'password' && <span className="text-muted-foreground">(optional)</span>}
                </FieldLabel>
                <FieldContent className="min-w-0">
                  <Input id={id} data-testid={id} type={field.type} placeholder={field.placeholder} value={values[field.key] ?? ''}
                    onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                    required={field.required} autoComplete={field.type === 'password' ? 'off' : undefined} />
                </FieldContent>
              </Field>;
            })}
          </FieldGroup>
        </fieldset>}
        {error && <FieldError>{error}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="submit" data-testid="device-save-printer" disabled={loading || saving || !selected}>Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
