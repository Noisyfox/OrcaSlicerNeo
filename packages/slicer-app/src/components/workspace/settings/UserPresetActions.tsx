import { useEffect, useId, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { UserPresetInfo, UserPresetKind, UserPresetMutation, UserPresetRequest } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { waitForConfigurationMutations, commitUserPresetMutation, commitScopedConfigurationMutation } from './configurationActions';

export function UserPresetActions({ kind, canonicalName, disabled = false, onPendingChange, onCommitted }: {
  kind: UserPresetKind; canonicalName: string; disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onCommitted?: (result: UserPresetMutation) => Promise<void> | void;
}) {
  const platform = usePlatform();
  const revision = useHistoryRestoreStore(state => state.revision);
  const [info, setInfo] = useState<UserPresetInfo | null>(null);
  const [dialog, setDialog] = useState<'save-as' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const inputId = useId();
  useEffect(() => { setDialog(null); setError(null); }, [kind, canonicalName]);
  useEffect(() => {
    let current = true;
    setInfo(null);
    void (async () => {
      try {
        const result = await platform.runtime.getUserPresetInfo(kind, canonicalName);
        if (current && result.ok) setInfo(result);
      } catch { /* Runtime startup/replacement owns its error surface. */ }
    })();
    return () => { current = false; };
  }, [platform.runtime, kind, canonicalName, revision, pending]);

  const submit = async (action: UserPresetRequest['action'] | 'reset-preset') => {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setPending(true); onPendingChange?.(true); setError(null);
    try {
      // A parameter blur can precede this click. Read the revision after that
      // edit has committed, so Save includes the value the user just entered.
      await waitForConfigurationMutations();
      const fresh = await platform.runtime.getUserPresetInfo(kind, canonicalName);
      if (!fresh.ok) throw new Error(fresh.error);
      if (action === 'reset-preset') {
        await commitScopedConfigurationMutation(platform, { version: 1, operation: 'reset-all', targets: [{ scope: 'project' }] });
        return;
      }
      const result = await commitUserPresetMutation(platform, { action, kind, canonicalName,
        expectedRevision: fresh.revision, ...(action === 'save-as' ? { action: 'save-as', name } : {}) } as UserPresetRequest);
      if (!result.ok) throw new Error(result.error);
      await onCommitted?.(result);
      setDialog(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pendingRef.current = false; setPending(false); onPendingChange?.(false); }
  };
  const locked = disabled || pending || !info;
  return <>
    <div className="flex items-center gap-1" aria-label="User preset actions">
      {info?.canSave && <Button size="xs" variant="outline" disabled={locked} onClick={() => void submit('save')}>Save</Button>}
      <Button size="xs" variant="outline" disabled={locked} onClick={() => { setName(''); setError(null); setDialog('save-as'); }}>Save as…</Button>
      {info?.canDelete && <Button size="xs" variant="ghost" disabled={locked} onClick={() => { setError(null); setDialog('delete'); }}>Delete</Button>}
      {kind === 'print' && info?.canReset && <Button size="xs" variant="outline" disabled={locked} onClick={() => void submit('reset-preset')}>Reset preset</Button>}
    </div>
    {error && !dialog && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !pending) setDialog(null); }}>
      <DialogContent>
        <DialogTitle>{dialog === 'delete' ? 'Delete user preset' : 'Save preset as'}</DialogTitle>
        <DialogDescription>{dialog === 'delete'
          ? `Delete “${info?.label ?? canonicalName}”? Undo can restore its project settings, but will not restore the preset file.`
          : 'Choose an unused name for the new user preset.'}</DialogDescription>
        <form onSubmit={event => { event.preventDefault(); if (dialog) void submit(dialog); }} className="flex flex-col gap-4">
          {dialog === 'save-as' && <FieldGroup><Field data-invalid={!!error}>
            <FieldLabel htmlFor={inputId}>Preset name</FieldLabel>
            <Input id={inputId} autoFocus value={name} disabled={pending} aria-invalid={!!error}
              onChange={event => setName(event.target.value)} />
          </Field></FieldGroup>}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" variant={dialog === 'delete' ? 'destructive' : 'default'} disabled={pending || (dialog === 'save-as' && !name.trim())}>
              {pending ? 'Saving…' : dialog === 'delete' ? 'Delete preset' : 'Save preset'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
