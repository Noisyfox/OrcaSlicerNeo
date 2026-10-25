import { useEffect, useState, useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { NozzleMappingEditor } from './NozzleMappingEditor';
import { mappingConfirmation, type MappingConfirmationRequest } from './mappingConfirmation';

function ConfirmationDraft({ request }: { request: MappingConfirmationRequest }) {
  const [filamentMap, setFilamentMap] = useState<readonly number[]>(request.snapshot.effective.filamentMap);
  const rack = useFilamentSessionStore(s => s.snapshot);
  const name = usePlateSessionStore(s => s.snapshot?.plates.find(p => p.plateId === request.snapshot.plateId)?.name);
  const valid = filamentMap.every(id => Number.isSafeInteger(id) && request.snapshot.nozzles.some(n => n.id === id));
  return <Dialog open onOpenChange={open => { if (!open) mappingConfirmation.finish(request, null); }}>
    <DialogContent data-testid="mapping-confirmation">
      <DialogTitle>Confirm filament mapping</DialogTitle>
      <DialogDescription>{name ?? 'Plate'} — review the nozzle assignments before slicing.</DialogDescription>
      <div className="max-h-[55vh] overflow-y-auto">
        <NozzleMappingEditor snapshot={request.snapshot} filamentMap={filamentMap} onMapping={setFilamentMap}
          labels={Object.fromEntries(rack?.slots.map(s => [s.slot, s.preset.name]) ?? [])} />
      </div>
      {!valid && <p role="alert" className="text-xs text-destructive">Each filament must reference an available nozzle.</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => mappingConfirmation.finish(request, null)} data-testid="mapping-cancel">Cancel</Button>
        <Button disabled={!valid} onClick={() => mappingConfirmation.finish(request, filamentMap)} data-testid="mapping-confirm">Confirm and slice</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function NozzleMappingConfirmation() {
  const request = useSyncExternalStore(mappingConfirmation.subscribe, mappingConfirmation.getSnapshot, mappingConfirmation.getSnapshot);
  useEffect(() => () => mappingConfirmation.cancel(), []);
  return request ? <ConfirmationDraft key={request.snapshot.plateId + ':' + request.revision} request={request} /> : null;
}
