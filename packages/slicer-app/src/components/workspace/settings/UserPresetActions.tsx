import { useEffect, useId, useRef, useState } from 'react';
import { SaveIcon } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type { UserPresetInfo, UserPresetKind, UserPresetMutation, UserPresetRequest } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { waitForConfigurationMutations, commitUserPresetMutation } from './configurationActions';

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
  const [overwriteTarget, setOverwriteTarget] = useState<UserPresetInfo | null>(null);
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

  useEffect(() => {
    let current = true;
    setOverwriteTarget(null);
    if (dialog === 'save-as' && name && name !== info?.overwriteName) {
      void platform.runtime.getUserPresetInfo(kind, name).then(result => {
        if (current && result.ok && result.overwriteName === name) setOverwriteTarget(result);
      }).catch(() => { /* Submission performs authoritative validation. */ });
    }
    return () => { current = false; };
  }, [platform.runtime, kind, name, dialog, info?.overwriteName, revision]);

  const submit = async (action: 'save-as' | 'delete') => {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setPending(true); onPendingChange?.(true); setError(null);
    try {
      // A parameter blur can precede this click. Read the revision after that
      // edit has committed, so Save includes the value the user just entered.
      await waitForConfigurationMutations();
      const fresh = await platform.runtime.getUserPresetInfo(kind, canonicalName);
      if (!fresh.ok) throw new Error(fresh.error);
      let confirmOverwrite = false;
      if (action === 'save-as' && name !== fresh.overwriteName) {
        const destination = await platform.runtime.getUserPresetInfo(kind, name);
        if (destination.ok && destination.overwriteName === name) {
          // Fast Enter must not commit before the asynchronous warning appeared.
          if (overwriteTarget?.overwriteName !== name || overwriteTarget.compatible !== destination.compatible) {
            setOverwriteTarget(destination);
            return;
          }
          confirmOverwrite = true;
        }
      }
      const result = await commitUserPresetMutation(platform, { action, kind, canonicalName,
        expectedRevision: fresh.revision, ...(action === 'save-as' ? { action: 'save-as', name, confirmOverwrite } : {}) } as UserPresetRequest);
      if (!result.ok) throw new Error(result.error);
      await onCommitted?.(result);
      setDialog(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pendingRef.current = false; setPending(false); onPendingChange?.(false); }
  };
  const locked = disabled || pending || !info;
  return <>
    <div className="flex items-center gap-1" aria-label="User preset actions">
      <TooltipFor content="Save as…" disabled={locked}>
        <Button size="icon-sm" variant="ghost" aria-label="Save as…" disabled={locked}
          onClick={() => { setName(info?.defaultSaveAsName ?? ''); setError(null); setDialog('save-as'); }}>
          <SaveIcon aria-hidden="true" data-icon="inline-start" />
        </Button>
      </TooltipFor>
      {info?.canDelete && <Button size="xs" variant="ghost" disabled={locked} onClick={() => { setError(null); setDialog('delete'); }}>Delete</Button>}
    </div>
    {error && !dialog && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !pending) setDialog(null); }}>
      <DialogContent>
        <DialogTitle>{dialog === 'delete' ? 'Delete user preset' : 'Save preset as'}</DialogTitle>
        <DialogDescription>{dialog === 'delete'
          ? `Delete “${info?.label ?? canonicalName}”? Undo can restore its project settings, but will not restore the preset file.`
          : 'Keep the user preset name to save changes, or choose another name to save a copy.'}</DialogDescription>
        <form onSubmit={event => { event.preventDefault(); if (dialog) void submit(dialog); }} className="flex flex-col gap-4">
          {dialog === 'save-as' && <FieldGroup><Field data-invalid={!!error}>
            <FieldLabel htmlFor={inputId}>Preset name</FieldLabel>
            <Input id={inputId} autoFocus value={name} disabled={pending} aria-invalid={!!error}
              onChange={event => setName(event.target.value)} />
          </Field></FieldGroup>}
          {dialog === 'save-as' && overwriteTarget && <Alert><AlertDescription>
            Preset “{name}” already exists{overwriteTarget.compatible ? '' : ' and is incompatible with the current printer'}.
            Saving will overwrite this preset.
          </AlertDescription></Alert>}
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
