import { useEffect, useId, useRef, useState } from 'react';
import type * as D from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ControlCard } from './PrinterControlCards';
/** Drafts are local intent; only the agent can confirm persistent writes by readback. */
export function DevicePreferencesCard({ service, target, preferences, onSaved }: { service: D.PrinterService; target: D.TargetRequest; preferences: D.DevicePreferences; onSaved(): void }) {
  const fieldId = useId();
  const [draft, setDraft] = useState<Partial<Record<D.DevicePreferenceKey, D.DevicePreferenceValue>>>({});
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false), observer = useRef<AbortController | null>(null);
  useEffect(() => () => observer.current?.abort(), []);
  const changes = preferences.fields.flatMap(field => draft[field.key] === undefined || field.value.kind === 'known' && draft[field.key] === field.value.value ? [] : [{ key: field.key, value: draft[field.key]! }]);
  async function save() {
    if (busy.current || !changes.length) return;
    busy.current = true; setPending(true); setMessage(null);
    const abort = new AbortController(); observer.current = abort;
    try {
      const submission = await service.controls.submit({ target, requestId: crypto.randomUUID() as D.Id<'request'>, command: { type: 'preferences.set', params: { changes } } });
      if (abort.signal.aborted) return;
      if (submission.kind === 'rejected') { setMessage(submission.error.message); return; }
      if (submission.kind !== 'recorded') { setMessage('Save outcome unknown. Your edits have been retained.'); return; }
      for await (const operation of service.operations.watch(submission.operation, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (operation.phase.kind === 'acknowledged' || operation.phase.kind === 'completed') { setDraft({}); setMessage('Printer preferences saved and verified.'); onSaved(); return; }
        if (operation.phase.kind === 'failed') { setMessage(operation.phase.error.message); return; }
        if (operation.phase.kind === 'outcome-unknown') { setMessage(operation.phase.reason); return; }
      }
      if (!abort.signal.aborted) setMessage('Save outcome unknown. Your edits have been retained.');
    } catch { if (!abort.signal.aborted) setMessage('Unable to verify printer preferences. Your edits have been retained.'); }
    finally { busy.current = false; if (!abort.signal.aborted) setPending(false); }
  }
  return <ControlCard title="Printer preferences">
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FieldGroup className="gap-3">{preferences.fields.map(field => {
        const value = draft[field.key] ?? (field.value.kind === 'known' ? field.value.value : undefined);
        const items = field.choices.map(choice => ({ value: String(choice), label: choice === true ? 'On' : choice === false ? 'Off' : String(choice) }));
        const id = `${fieldId}-${field.key}`;
        return <Field key={field.key} orientation="responsive" data-disabled={pending}>
          <FieldLabel htmlFor={id}>{field.label}{field.value.kind === 'known' && field.value.freshness === 'stale' ? ' (stale)' : ''}</FieldLabel>
          <FieldContent className="min-w-0 @md/field-group:flex-none">
            <Select items={items} disabled={pending} value={value === undefined ? null : String(value)} onValueChange={selected => {
              const next = field.choices.find(choice => String(choice) === selected);
              if (next !== undefined) { setDraft(previous => ({ ...previous, [field.key]: next })); setMessage(null); }
            }}>
              <SelectTrigger id={id} aria-label={field.label} className="w-full @md/field-group:min-w-32">
                <SelectValue placeholder="Not reported" />
              </SelectTrigger>
              <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </FieldContent>
        </Field>;
      })}</FieldGroup>
      <Button type="submit" size="sm" className="self-start" disabled={pending || !changes.length}>{pending ? 'Saving…' : 'Save printer preferences'}</Button>
      {message && <FieldDescription role="status">{message}</FieldDescription>}
    </form>
  </ControlCard>;
}
