import type { ReactNode } from 'react';
import { Box } from 'lucide-react';
import type { PrintStatus } from '@orca/printer-control/domain';
import { ControlCard, display, valueOf } from './PrinterControlCards';
import './PrinterMonitor.css';

/** Shared presentation only; providers retain their own reads, previews and command lifetimes. */
export function PrinterMonitorLayout({ title, subtitle, status, toolbar, notices, camera, progress, controls, materials, hardware, testId }: {
  title: string; subtitle: string; status?: ReactNode; toolbar?: ReactNode; notices?: ReactNode;
  camera?: ReactNode; progress: ReactNode; controls: ReactNode; materials?: ReactNode; hardware?: ReactNode; testId: string;
}) {
  return <div className="printer-monitor h-full overflow-y-auto" data-testid={testId}>
    <header className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">{title}</h2><p className="text-xs text-muted-foreground">{subtitle}</p></div><div className="flex items-center gap-3">{status}{toolbar}</div></header>
    {notices}
    <div className="printer-monitor-layout">
      <div className="printer-print-column">
        {camera}
        {progress}
      </div>
      <div className="printer-control-column">{controls}{materials}{hardware}</div>
    </div>
  </div>;
}

export function PrintProgressCard({ status, preview, details, children }: { status?: PrintStatus; preview?: string | null; details?: ReactNode; children: ReactNode }) {
  const progress = valueOf(status?.progressFraction);
  return <ControlCard title="Printing progress">
    <div className="printer-print-overview">
      <div className="printer-print-preview" aria-label="Print preview">{preview ? <img src={preview} alt="Current print preview" /> : <div className="printer-preview-empty"><Box size={32} strokeWidth={1} /><span>No preview available</span></div>}</div>
      <div className="printer-print-details">
        <div className="printer-print-summary"><strong title={valueOf(status?.name) ?? undefined}>{display(status?.name, name => name ?? 'No active print')}</strong><span>{display(status?.phase)}</span></div>
        <div className="printer-print-progress" role="progressbar" aria-label="Print progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress === undefined ? undefined : Math.round(progress * 100)}><span style={{ width: `${Math.max(0, Math.min(100, (progress ?? 0) * 100))}%` }} /></div>
        <dl className="printer-print-facts"><dt>Progress</dt><dd>{display(status?.progressFraction, value => `${Math.round(value * 100)}%`)}</dd><dt>Remaining</dt><dd>{display(status?.remainingSeconds, value => `${Math.ceil(value / 60)} min`)}</dd>{details}</dl>
      </div>
    </div>
    <div className="printer-print-actions">{children}</div>
  </ControlCard>;
}
