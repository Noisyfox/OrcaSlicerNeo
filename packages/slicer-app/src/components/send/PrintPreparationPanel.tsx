import { useEffect, type ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { MaterialSourcePicker } from './MaterialSourcePicker';
import { PrintJobSummary } from './PrintJobSummary';
import type * as D from '@orca/printer-control/domain';
import type { SliceResultReceipt } from '@slicer/client';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
import { usePrintPreparation } from './usePrintPreparation';

export function PrintPreparationPanel({ platform, printer, route, receipt, onClose, onBusyChange, printerControl }: {
  platform: PlatformCapabilities; printer: D.SavedPrinter; route: D.PrinterRoute; receipt?: SliceResultReceipt;
  onClose(): void; onBusyChange(busy: boolean): void; printerControl?: ReactNode;
}) {
  const state = usePrintPreparation(platform, printer, route, receipt, () => {
    useDeviceSelectionStore.getState().showPrinter(printer.identity.id); onClose();
  });
  const { requirements, prepared, operation, confirmation } = state;
  useEffect(() => { onBusyChange(state.active); }, [state.active, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  return <div className="flex flex-col gap-4" data-testid="print-preparation">
    {!requirements && !state.error && <p role="status">Reading the current slice…</p>}
    <PrintJobSummary requirements={requirements} printer={printer} printerControl={printerControl} name={state.jobName}
      onNameChange={state.setJobName} disabled={state.active || operation?.phase === 'unknown'} onRefresh={() => void state.refresh()} route={prepared?.route} />
    {requirements && <fieldset disabled={state.active || operation?.phase === 'unknown'} className="min-w-0 space-y-4">
      <legend className="mb-3 flex w-full items-center gap-2 text-sm text-muted-foreground">Filament<span className="h-px flex-1 bg-border" /></legend>
      <div className={`grid gap-4 ${requirements.nozzleDiameters.length > 1 ? 'sm:grid-cols-2' : ''}`} data-testid="print-nozzle-groups">
        {requirements.nozzleDiameters.map((_, toolIndex) => <section key={toolIndex} className="min-w-0 bg-control-background/50 p-3" aria-label={prepared?.nozzleLabels[toolIndex] ?? `Nozzle ${toolIndex + 1}`}>
          {requirements.nozzleDiameters.length > 1 && <h3 className="mb-3 text-sm font-semibold">{prepared?.nozzleLabels[toolIndex] ?? `Nozzle ${toolIndex + 1}`}</h3>}
          <div className="flex flex-wrap gap-3">
            {requirements.materials.filter(material => material.toolIndex === toolIndex).map(material => {
              const value = state.bindings.find(b => b.materialKey === material.key)?.pathId ?? '';
              const candidates = prepared?.candidates.filter(c => c.materialKey === material.key) ?? [];
              return <MaterialSourcePicker key={material.key} material={material} sources={candidates} value={value}
                disabled={state.active || operation?.phase === 'unknown'} onChange={pathId => state.changeBinding(material.key, pathId)} />;
            })}
            {!requirements.materials.some(material => material.toolIndex === toolIndex) && <p className="text-xs text-muted-foreground">Not used</p>}
          </div>
        </section>)}
      </div>
    </fieldset>}
    {requirements && state.refreshing && <p role="status" className="text-sm text-muted-foreground">Loading printer information…</p>}
    {!state.refreshing && !state.error && prepared?.issues.map(issue => <p key={issue.id} role={issue.severity === 'block' ? 'alert' : 'status'} className={`text-sm ${issue.severity === 'block' ? 'text-destructive' : issue.severity === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{issue.message}</p>)}
    {prepared && <fieldset disabled={state.active || operation?.phase === 'unknown'} className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-3 border-t pt-5 sm:grid-cols-2" aria-label="Print options">
      {[...prepared.optionDescriptors].sort((a, b) => optionOrder.indexOf(a.key) - optionOrder.indexOf(b.key)).map(option => <div key={option.key} className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 text-xs" title={option.label}>{option.label}</span>
        <ToggleGroup aria-label={option.label} value={[String(prepared.options[option.key])]} disabled={!option.enabled || state.active || operation?.phase === 'unknown'} spacing={0} size="sm" className="shrink-0 rounded-sm bg-control-background p-0.5" onValueChange={values => {
          const choice = option.choices.find(c => String(c.value) === values[0]); if (choice) state.changeOption(option.key, choice.value);
        }}>{option.choices.map(choice => <ToggleGroupItem key={String(choice.value)} value={String(choice.value)} aria-label={choice.label} className="h-6 min-w-10 rounded-sm! px-2 text-xs transition-none aria-pressed:bg-background aria-pressed:text-primary aria-pressed:shadow-[inset_0_0_0_1px_var(--primary)]">{choice.label}</ToggleGroupItem>)}</ToggleGroup>
      </div>)}
    </fieldset>}
    {state.error && (!requirements || !state.refreshing) && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.saveError && <p role="alert" className="text-sm text-destructive">Print preferences could not be saved. You can still print with the current options. Adjust an option to retry saving.</p>}
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
      {!confirmation && <Button disabled={!state.canPrint} onClick={() => void state.send()} className="min-w-24" data-testid="print-submit">{operation?.phase === 'failed' ? 'Retry' : 'Send'}</Button>}
    </div>
  </div>;
}

const optionOrder: readonly (keyof D.PrintOptions)[] = ['timelapse', 'bedLeveling', 'flowCalibration', 'nozzleOffsetCalibration', 'sharedPressureAdvance', 'timelapseStorage', 'externalChangeAssist'];
