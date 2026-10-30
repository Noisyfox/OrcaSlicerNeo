import { useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
type Alert = D.PrinterObservationMap['alerts'][number];

/** Agent-issued error episodes drive presentation; no vendor codes or commands enter the shared UI. */
export function PrinterAlerts({ alerts, printerName, visible, disabled, feedback, onInvoke }: {
  alerts: readonly Alert[]; printerName: string; visible: boolean; disabled: boolean; feedback: string | null;
  onInvoke(action: D.PrinterAction): void;
}) {
  const [dismissed, setDismissed] = useState<D.Id<'alert'> | null>(null);
  const alert = alerts.find(item => item.dialog);
  const dialog = alert?.dialog;
  const close = () => {
    if (!alert || !dialog?.dismissible) return;
    setDismissed(alert.id);
    if (!disabled && dialog.dismissAction?.availability.kind === 'available') void onInvoke(dialog.dismissAction);
  };
  const invoke = (item: Alert, action: D.PrinterAction) => {
    if (disabled || action.availability.kind !== 'available') return;
    onInvoke(action);
    if (!action.keepDialogOpen) setDismissed(item.id);
  };
  const actions = (item: Alert) => item.actions.map(action => <Button key={action.actionRef.token} size="sm" variant="secondary"
    disabled={disabled || action.availability.kind !== 'available'} onClick={() => void invoke(item, action)}>{action.label}</Button>);
  return <>
    {alerts.map(item => <section key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/40 p-3 text-sm">
      <span>{item.message} <span className="text-muted-foreground">{item.code}</span></span>
      <div className="flex gap-2">{item.dialog ? <Button size="sm" variant="secondary" onClick={() => setDismissed(null)}>View error details</Button> : actions(item)}</div>
    </section>)}
    {alert && dialog && <Dialog modal={false} disablePointerDismissal open={visible && dismissed !== alert.id}
      onOpenChange={open => { if (!open) close(); }}>
      <DialogContent showOverlay={false} className="max-h-[85vh] overflow-y-auto" aria-label={`${printerName}: ${dialog.title}`}>
        <DialogTitle>{printerName}: {dialog.title}</DialogTitle>
        <p className="text-sm text-muted-foreground">{printerName} · {alert.code}</p>
        <DialogDescription className="whitespace-pre-wrap text-sm">{alert.message}</DialogDescription>
        <div className="flex flex-col gap-2">{actions(alert)}</div>
        {feedback && <p role="status" className="text-sm text-destructive">{feedback}</p>}
        {dialog.dismissible && <Button variant="ghost" onClick={close}>Close</Button>}
      </DialogContent>
    </Dialog>}
  </>;
}
