import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type { DiscoveryCandidate, Id, ProviderDescriptor, SavedPrinter } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Shared discovery/access UI. Provider-owned callbacks and credentials remain outside the app. */
export function PrinterDiscovery({ saved }: { saved: readonly SavedPrinter[] }) {
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
    void service.listProviders().then(result => { if (live && result.ok) setProviders(result.value.filter(provider => provider.hosts.some(host => host.discovery.kind === 'supported' && host.discovery.constraints.kinds.includes('lan')))); }).catch(() => {});
    return () => { live = false; };
  }, [service]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setCandidates([]); setSelected(null); setCode(''); setError(null);
    const scans = providers.flatMap(provider => provider.hosts.filter(host => host.discovery.kind === 'supported' && host.discovery.constraints.kinds.includes('lan')).map(async host => {
      try {
        for await (const event of service.discover(provider.id, { kind: 'lan', hostId: host.id }, { signal: controller.signal })) {
          if (controller.signal.aborted) return;
          if (event.type === 'upsert') setCandidates(current => [...current.filter(candidate => candidate.id !== event.candidate.id), event.candidate]);
          else if (event.type === 'expired') { setCandidates(current => current.filter(candidate => candidate.id !== event.candidateId)); setSelected(current => current?.id === event.candidateId ? null : current); }
          else if (event.type === 'failed') setError(event.error.message);
        }
      } catch { if (!controller.signal.aborted) setError('Printer discovery is unavailable.'); }
    }));
    void Promise.all(scans);
    return () => { controller.abort(); };
  }, [open, providers, service]);
  const existing = (candidate: DiscoveryCandidate) => saved.find(printer => printer.routes.some(route => route.providerId === candidate.providerId)
    && printer.identity.externalRefs.some(reference => candidate.externalRefs.some(other => other.namespace === reference.namespace && other.value === reference.value)));
  const remembered = selected ? existing(selected)?.routes.some(route => route.providerId === selected.providerId && route.configuration.credentialRef !== null) : false;
  const submit = async () => {
    if (!selected || busy) return;
    const candidate = selected; const accessCode = code;
    setBusy(true); setCode(''); setError(null);
    try {
      const request = { requestId: crypto.randomUUID() as Id<'request'>, candidate, existingPrinterId: existing(candidate)?.identity.id };
      const result = candidate.access === 'access-code' ? await service.authorize({ ...request, accessCode: remembered ? '' : accessCode }) : await service.adopt(request);
      if (!result.ok) setError(result.error.message);
      else { setSelected(null); setCode(''); }
    } catch { setError('The printer could not be added. Please try again.'); }
    finally { setBusy(false); }
  };
  if (!providers.length) return null;
  return <>
    <Button size="icon-xs" variant="secondary" aria-label="Discover printers" data-testid="device-discover" onClick={() => setOpen(true)}><Radar /></Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) setCode(''); } }}>
      <DialogContent data-testid="printer-discovery-dialog" className="max-w-xl">
        <DialogTitle>Discover LAN printers</DialogTitle>
        <p className="text-sm text-muted-foreground">Choose a printer on your local network. Cloud account printers appear automatically in Devices.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!candidates.length && <p role="status" className="text-sm text-muted-foreground">Waiting for printer announcements…</p>}
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
            {busy ? 'Connecting…' : remembered ? 'Verify saved access' : 'Add LAN connection'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
