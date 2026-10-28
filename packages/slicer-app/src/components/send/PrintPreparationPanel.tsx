import { useEffect } from 'react';
import type * as D from '@orca/printer-control/domain';
import type { SliceResultReceipt } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
import { usePrintPreparation } from './usePrintPreparation';

export function PrintPreparationPanel({ platform, printer, route, receipt, onClose, onBusyChange }: {
  platform: PlatformCapabilities; printer: D.SavedPrinter; route: D.PrinterRoute; receipt?: SliceResultReceipt;
  onClose(): void; onBusyChange(busy: boolean): void;
}) {
  const state = usePrintPreparation(platform, printer, route, receipt, () => {
    useDeviceSelectionStore.getState().showPrinter(printer.identity.id); onClose();
  });
  const { requirements, prepared, operation, confirmation } = state;
  useEffect(() => { onBusyChange(state.active); }, [state.active, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  return <div className="flex flex-col gap-4" data-testid="print-preparation">
    {!requirements && !state.error && <p role="status">Reading the current slice…</p>}
    {requirements && <>
      <p className="text-sm text-muted-foreground">{requirements.printerModel} · {requirements.weightGrams.toFixed(1)} g · {Math.ceil(requirements.durationSeconds / 60)} min</p>
      <fieldset disabled={state.active || operation?.phase === 'unknown'} className="flex flex-col gap-3">
        <legend className="mb-2 font-medium">Material mapping</legend>
        {requirements.materials.map(material => {
          const value = state.bindings.find(b => b.materialKey === material.key)?.pathId ?? '';
          const candidates = prepared?.candidates.filter(c => c.materialKey === material.key) ?? [];
          return <label key={material.key} className="grid grid-cols-2 items-center gap-3 text-sm">
            <span className="flex items-center gap-2"><span className="h-4 w-4 shrink-0 rounded border" style={{ background: /^#[\da-f]{6}([\da-f]{2})?$/i.test(material.color) ? material.color : 'transparent' }} />{material.index + 1}. {material.type} · Tool {material.toolIndex + 1}</span>
            <select className="min-w-0 rounded border bg-background p-2" aria-label={`Material ${material.index + 1} source`} value={value} onChange={event => state.changeBinding(material.key, event.target.value)}>
              <option value="">Select source</option>
              {value && !candidates.some(c => c.pathId === value) && <option value={value}>Previous source unavailable</option>}
              {candidates.map(c => <option key={c.pathId} value={c.pathId}>{c.label} · {c.materialType ?? 'Unknown material'}{c.color ? ` · ${c.color}` : ''}</option>)}
            </select>
          </label>;
        })}
        {prepared?.optionDescriptors.map(option => <label key={option.key} className="flex items-center justify-between gap-3 text-sm">
          <span>{option.label}</span>
          <select className="rounded border bg-background p-2" aria-label={option.label} disabled={!option.enabled} value={String(prepared.options[option.key])} onChange={event => {
            const choice = option.choices.find(c => String(c.value) === event.target.value); if (choice) state.changeOption(option.key, choice.value);
          }}>{option.choices.map(choice => <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}</select>
        </label>)}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.allowAbnormal} onChange={event => state.changeAbnormal(event.target.checked)} />Allow printing with abnormal storage</label>
      </fieldset>
    </>}
    {prepared && <p className="text-sm text-muted-foreground" data-testid="print-delivery-route">Delivery: {prepared.route?.toUpperCase() ?? 'Unavailable'}</p>}
    {prepared?.issues.map(issue => <p key={issue.id} role={issue.severity === 'block' ? 'alert' : 'status'} className={`text-sm ${issue.severity === 'block' ? 'text-destructive' : 'text-muted-foreground'}`}>{issue.message}</p>)}
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.saveError && <p role="alert" className="text-sm text-destructive">Print preferences could not be saved. Adjust the option again to retry.</p>}
    {operation && <div role="status" className="flex flex-col gap-2 text-sm"><p>{operation.message}</p>{state.active && <Progress value={operation.progress === null ? null : operation.progress * 100} aria-label="Sending print" />}</div>}
    {confirmation && <div className="flex flex-col gap-3 rounded border p-3" role="group" aria-label="Confirm print warnings">
      <p className="font-medium">Review before printing</p>
      {confirmation.issues.filter(i => i.severity === 'warning').map(issue => <p key={issue.id} className="text-sm">{issue.message}</p>)}
      {confirmation.recordingSpace?.status === 'insufficient' && <label className="flex flex-col gap-2 text-sm">Recording space is insufficient.
        <select aria-label="Recording space action" value={state.recordingAction ?? ''} onChange={event => state.setRecordingAction(event.target.value as D.PrintSubmissionRequest['recordingSpaceAction'])}>
          <option value="">Choose an action</option><option value="disable-timelapse">Disable timelapse for this print</option>
          {confirmation.recordingSpace.canClean && <option value="clean-oldest">Delete oldest timelapse recordings</option>}
        </select>
      </label>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={state.active} onClick={state.dismissConfirmation}>Back</Button><Button disabled={!state.canPrint || confirmation.recordingSpace?.status === 'insufficient' && !state.recordingAction} onClick={() => void state.send(true)}>Confirm and print</Button></div>
    </div>}
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose} disabled={state.active}>Close</Button>
      {operation?.phase === 'unknown' && <Button variant="secondary" onClick={() => { useDeviceSelectionStore.getState().showPrinter(printer.identity.id); onClose(); }}>View printer</Button>}
      {operation?.canCancel && <Button variant="secondary" onClick={() => void state.cancel()}>Cancel sending</Button>}
      {!confirmation && <Button disabled={!state.canPrint} onClick={() => void state.send()} data-testid="print-submit">{operation?.phase === 'failed' ? 'Retry' : 'Print'}</Button>}
    </div>
  </div>;
}
