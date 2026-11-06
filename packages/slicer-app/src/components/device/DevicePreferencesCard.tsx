import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { ControlCard } from './PrinterControlCards';
/** Drafts are local intent; only the agent can confirm persistent writes by readback. */
export function DevicePreferencesCard({ service, target, preferences, onSaved }: { service: D.PrinterService; target: D.TargetRequest; preferences: D.DevicePreferences; onSaved(): void }) {
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
  return <ControlCard title="Printer preferences"><div className="space-y-3">{preferences.fields.map(field => {
    const value = draft[field.key] ?? (field.value.kind === 'known' ? field.value.value : undefined);
    return <label className="flex items-center justify-between gap-3 text-sm" key={field.key}><span>{field.label}{field.value.kind === 'known' && field.value.freshness === 'stale' ? ' (stale)' : ''}</span>
      <select aria-label={field.label} className="rounded border bg-background p-1" disabled={pending} value={value === undefined ? '' : String(value)} onChange={event => {
        const next = field.choices.find(choice => String(choice) === event.target.value);
        if (next !== undefined) { setDraft(previous => ({ ...previous, [field.key]: next })); setMessage(null); }
      }}><option value="" disabled>Not reported</option>{field.choices.map(choice => <option key={String(choice)} value={String(choice)}>{choice === true ? 'On' : choice === false ? 'Off' : choice}</option>)}</select></label>;
  })}<Button size="sm" disabled={pending || !changes.length} onClick={() => void save()}>{pending ? 'Saving…' : 'Save printer preferences'}</Button>{message && <p role="status" className="text-sm">{message}</p>}</div></ControlCard>;
}
