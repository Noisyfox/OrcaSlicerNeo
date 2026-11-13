import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SceneInteractionController } from '../../SceneInteractionController';
import type { MeasureController } from './MeasureController';
import { applyMeasureScale, type MeasureScaleRequest } from './measureScale';
import { measureNumber } from './measurePresentation';

export function MeasureScaleDialog({ scene, measure, request, onClose }: {
  scene: SceneInteractionController; measure: MeasureController; request: MeasureScaleRequest; onClose(): void;
}) {
  const initial = measureNumber(request.value);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const desired = draft.trim() === '' ? NaN : Number(draft);
    const result = await applyMeasureScale(scene, measure, request, desired, draft !== initial);
    if (result.outcome === 'failed') { setError(result.error); setBusy(false); }
    else if (result.outcome === 'stale') { setError('Measurement changed. Close and try again.'); setBusy(false); }
    else onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-sm" data-testid="measure-scale-dialog">
      <DialogTitle>Edit to scale</DialogTitle>
      <DialogDescription>Enter the desired distance in millimeters.</DialogDescription>
      <form className="space-y-4" onSubmit={event => { void submit(event); }}>
        <Label htmlFor="measure-scale-value">Distance (mm)</Label>
        <Input id="measure-scale-value" data-testid="measure-scale-value" inputMode="decimal" autoFocus value={draft}
          disabled={busy} onChange={event => setDraft(event.target.value)} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Scaling…' : 'Scale'}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
