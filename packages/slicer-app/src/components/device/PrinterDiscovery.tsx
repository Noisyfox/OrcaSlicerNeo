import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type { DiscoveryCandidate, Id, ProviderDescriptor, SavedPrinter } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Shared discovery/access UI. Provider-owned callbacks and credentials remain outside the app. */
export function PrinterDiscovery({ saved, target, onAuthorized }: { saved: readonly SavedPrinter[]; target?: SavedPrinter; onAuthorized?(): void }) {
  const { printers: { service } } = usePlatform();
  const [providers, setProviders] = useState<readonly ProviderDescriptor[]>([]);
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<readonly DiscoveryCandidate[]>([]);
  const [selected, setSelected] = useState<DiscoveryCandidate | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void service.listProviders().then(result => { if (live && result.ok) setProviders(result.value.filter(provider =>
      (!target || target.routes.some(route => route.providerId === provider.id)) && provider.hosts.some(host => host.discovery.kind === 'supported' && host.discovery.constraints.kinds.includes('lan')))); }).catch(() => {});
    return () => { live = false; };
  }, [service, target]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setCandidates([]); setSelected(null); setCode(''); setError(null);
    const scans = providers.flatMap(provider => provider.hosts.filter(host => host.discovery.kind === 'supported' && host.discovery.constraints.kinds.includes('lan') &&
      (!target || target.routes.some(route => route.providerId === provider.id && route.configuration.hostId === host.id))).map(async host => {
      try {
        for await (const event of service.discover(provider.id, { kind: 'lan', hostId: host.id }, { signal: controller.signal })) {
          if (controller.signal.aborted) return;
          if (event.type === 'upsert') {
            const candidate = event.candidate;
            if (target && (!target.routes.some(route => route.providerId === candidate.providerId && route.configuration.hostId === candidate.configuration.hostId) ||
              !target.identity.externalRefs.some(ref => candidate.externalRefs.some(other => ref.namespace === other.namespace && ref.value === other.value)))) continue;
            setCandidates(current => [...current.filter(value => value.id !== candidate.id), candidate]);
          }
          else if (event.type === 'expired') { setCandidates(current => current.filter(candidate => candidate.id !== event.candidateId)); setSelected(current => current?.id === event.candidateId ? null : current); }
          else if (event.type === 'failed') setError(event.error.message);
        }
      } catch { if (!controller.signal.aborted) setError('Printer discovery is unavailable.'); }
    }));
    void Promise.all(scans);
    return () => { controller.abort(); };
  }, [open, providers, service, target]);
  const existing = (candidate: DiscoveryCandidate) => saved.find(printer => printer.routes.some(route => route.providerId === candidate.providerId)
    && printer.identity.externalRefs.some(reference => candidate.externalRefs.some(other => other.namespace === reference.namespace && other.value === reference.value)));
  // Recovery explicitly replaces missing/invalid access; the normal discovery flow can verify a saved credential.
  const remembered = !target && selected ? existing(selected)?.routes.some(route => route.providerId === selected.providerId && route.configuration.credentialRef !== null) : false;
  const submit = async () => {
    if (!selected || busy) return;
    const candidate = selected; const accessCode = code;
    setBusy(true); setCode(''); setError(null);
    try {
      const request = { requestId: crypto.randomUUID() as Id<'request'>, candidate, existingPrinterId: target?.identity.id ?? existing(candidate)?.identity.id };
      const result = candidate.access === 'access-code' ? await service.authorize({ ...request, accessCode: remembered ? '' : accessCode }) : await service.adopt(request);
      if (!result.ok) setError(result.error.message);
      else if (target && result.value.identity.id !== target.identity.id) setError('The authorized printer does not match this Storage view.');
      else { setSelected(null); setCode(''); if (target) { setOpen(false); onAuthorized?.(); } }
    } catch { setError('The printer could not be added. Please try again.'); }
    finally { setBusy(false); }
  };
  if (!providers.length) return null;
  return <>
    <Button size={target ? 'sm' : 'icon-xs'} variant="secondary" aria-label={target ? 'Authorize storage access' : 'Discover printers'} data-testid="device-discover" onClick={() => setOpen(true)}>
      <Radar />{target && 'Authorize storage access'}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) setCode(''); } }}>
      <DialogContent data-testid="printer-discovery-dialog" className="max-w-xl">
        <DialogTitle>{target ? `Authorize ${target.identity.displayName}` : 'Discover LAN printers'}</DialogTitle>
        <p className="text-sm text-muted-foreground">{target ? 'Storage needs authorized access on your local network. Only announcements matching this printer are shown; use the access code displayed on the printer.' : 'Choose a printer on your local network. Cloud account printers appear automatically in Devices.'}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!candidates.length && <p role="status" className="text-sm text-muted-foreground">{target ? 'Waiting for this printer on the local network. Check that it is powered on and connected to the same network.' : 'Waiting for printer announcements…'}</p>}
        <div className="max-h-64 space-y-2 overflow-auto">
          {candidates.map(candidate => <button key={candidate.id} type="button" disabled={busy} aria-pressed={selected?.id === candidate.id}
            className="block w-full rounded border px-3 py-2 text-left text-sm aria-pressed:border-primary" onClick={() => { setSelected(candidate); setCode(''); setError(null); }}>
            <span className="block font-medium">{candidate.displayName}</span><span className="text-xs text-muted-foreground">{candidate.configuration.address}</span>
          </button>)}
        </div>
        {selected?.access === 'access-code' && !remembered && <div className="space-y-2">
          <Label htmlFor="printer-access-code">Access code</Label>
          <Input id="printer-access-code" data-testid="printer-access-code" type="password" autoComplete="off" value={code} disabled={busy} onChange={event => setCode(event.target.value)} />
          <p className="text-xs text-muted-foreground">Use the access code shown on the printer. It will be remembered on this computer.</p>
        </div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false); setCode(''); }}>Close</Button>
          <Button disabled={!selected || busy || (selected.access === 'access-code' && !remembered && !code)} onClick={() => void submit()}>
            {busy ? 'Connecting…' : target ? 'Authorize access' : remembered ? 'Verify saved access' : 'Add LAN connection'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
