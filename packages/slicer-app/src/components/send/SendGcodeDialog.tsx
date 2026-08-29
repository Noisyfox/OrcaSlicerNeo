import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PrinterControlError,
  PrinterControlService,
  normalizePrinterConfigurationDocument,
  type PrinterConfiguration,
  type PrinterConfigurationDocument,
  type UploadedGcode,
} from '@orca/printer-control';
import { usePlatform, type PlatformCapabilities } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSlicerStore } from '../../stores/useSlicerStore';

export type SendGcodeAction = 'send' | 'send-and-print';
type SendState = 'idle' | 'loading' | 'uploading' | 'starting' | 'success' | 'start-failed-after-upload' | 'error' | 'cancelled';

function safeErrorMessage(error: unknown): string {
  if (error instanceof PrinterControlError) {
    if (error.code === 'aborted') return 'Sending was cancelled.';
    if (error.code === 'start-failed-after-upload') {
      return 'The file was uploaded, but printing did not start. The file remains on the printer.';
    }
    if (error.code === 'protocol') return 'The printer did not accept this operation.';
  }
  // Transport errors are deliberately not rendered. Host/network errors can
  // contain request headers or other sensitive details.
  return 'Could not send G-code. Check the printer configuration and connection.';
}

function fileNameFromPath(path: string): string {
  const candidate = path.split(/[\\/]/).pop() ?? '';
  if (!candidate || candidate === '.' || candidate === '..') return 'output.gcode';
  return candidate.toLowerCase().endsWith('.gcode') ? candidate : `${candidate}.gcode`;
}

function unavailableReason(
  sliceReady: boolean,
  printers: readonly PrinterConfiguration[],
  selected: PrinterConfiguration | null,
): string | null {
  if (!sliceReady) return 'Complete a slice before sending G-code.';
  if (printers.length === 0) return 'Configure a Moonraker printer in Device before sending.';
  if (!selected) return 'Select a printer to send G-code.';
  if (selected.driverId !== 'moonraker') return 'The selected printer driver is not supported.';
  if (!selected.apiBaseUrl) return 'The selected printer is missing a required API base URL.';
  return null;
}

/** Keep the select value stable as the internal id while showing user-facing text. */
function printerLabel(value: unknown, printers: readonly PrinterConfiguration[]): string {
  if (typeof value !== 'string') return '';
  return printers.find((printer) => printer.id === value)?.displayName ?? '';
}

export interface SendGcodeDialogProps {
  open: boolean;
  action: SendGcodeAction;
  onClose: () => void;
  /** Test seam for restoring an in-memory choice; never persisted. */
  initialSelection?: string | null;
  /** Optional seam for focused component tests and host-neutral embedding. */
  platform?: PlatformCapabilities;
  /** Invoked after a successful auto-close when the user selected Device. */
  onNavigateToDevice?: () => void;
}

/**
 * The Send panel owns an ephemeral target selection. It intentionally does
 * not use DevicePanel's selection or write selection to any repository.
 */
export function SendGcodeDialog({ open, action, onClose, initialSelection = null, platform: injectedPlatform, onNavigateToDevice }: SendGcodeDialogProps) {
  const contextPlatform = usePlatform();
  const platform = injectedPlatform ?? contextPlatform;
  const sliceStatus = useSlicerStore((state) => state.status);
  const sliceReady = sliceStatus === 'done';
  const [document, setDocument] = useState<PrinterConfigurationDocument>({ version: 1, printers: [] });
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(initialSelection);
  const [state, setState] = useState<SendState>('idle');
  const [progress, setProgress] = useState<{ loaded: number; total?: number; fraction?: number }>({ loaded: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [closeCountdown, setCloseCountdown] = useState<number | null>(null);
  const [switchToDeviceAfterSend, setSwitchToDeviceAfterSend] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const operationRef = useRef(0);
  const serviceRef = useRef<PrinterControlService | null>(null);
  const uploadedRef = useRef<UploadedGcode | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const selectedPrinter = useMemo(
    () => document.printers.find((printer) => printer.id === selectedPrinterId) ?? null,
    [document.printers, selectedPrinterId],
  );
  const reason = unavailableReason(sliceReady, document.printers, selectedPrinter);
  const busy = state === 'loading' || state === 'uploading' || state === 'starting';
  const controlsDisabled = busy || state === 'success';
  const progressValue = progress.fraction === undefined ? undefined : Math.round(Math.max(0, Math.min(1, progress.fraction)) * 100);

  function clearCloseCountdown(resetState = true) {
    if (closeTimerRef.current !== null) {
      clearInterval(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (resetState) setCloseCountdown(null);
  }

  function startCloseCountdown(shouldNavigateToDevice = switchToDeviceAfterSend) {
    clearCloseCountdown();
    let remaining = 5;
    setCloseCountdown(remaining);
    closeTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCloseCountdown();
        onClose();
        if (shouldNavigateToDevice) onNavigateToDevice?.();
        return;
      }
      setCloseCountdown(remaining);
    }, 1000);
  }

  useEffect(() => {
    if (!open) {
      clearCloseCountdown();
      setSwitchToDeviceAfterSend(false);
      return;
    }
    let active = true;
    setState('loading');
    setMessage(null);
    setProgress({ loaded: 0 });
    uploadedRef.current = null;
    serviceRef.current = null;
    void platform.printers.configuration.load().then((loaded) => {
      if (!active) return;
      try {
        const normalized = normalizePrinterConfigurationDocument(loaded);
        setDocument(normalized);
        // Keep the previous target only when it is still present. Never pick
        // the first record implicitly, since this selection is independent
        // from DevicePanel and intentionally non-persistent.
        setSelectedPrinterId((previous) => previous && normalized.printers.some((printer) => printer.id === previous) ? previous : null);
        setState('idle');
      } catch {
        setDocument({ version: 1, printers: [] });
        setSelectedPrinterId(null);
        setState('error');
        setMessage('Printer configuration is unavailable. Check Device settings.');
      }
    }).catch(() => {
      if (!active) return;
      setDocument({ version: 1, printers: [] });
      setSelectedPrinterId(null);
      setState('error');
      setMessage('Printer configuration is unavailable. Check Device settings.');
    });
    return () => { active = false; };
  }, [open, platform.printers.configuration]);

  useEffect(() => {
    selectedIdRef.current = selectedPrinterId;
  }, [selectedPrinterId]);

  useEffect(() => () => {
    operationRef.current += 1;
    abortRef.current?.abort();
    clearCloseCountdown(false);
  }, []);

  function cancelUpload() {
    if (state === 'uploading' || state === 'loading') {
      operationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setState('cancelled');
      setMessage('Sending was cancelled.');
    }
  }

  function close() {
    clearCloseCountdown();
    cancelUpload();
    onClose();
  }

  function selectPrinter(id: string) {
    clearCloseCountdown();
    if (busy) cancelUpload();
    operationRef.current += 1;
    uploadedRef.current = null;
    serviceRef.current = null;
    setMessage(null);
    setState('idle');
    setSelectedPrinterId(id);
  }

  async function send() {
    if (busy || reason || !selectedPrinter) return;
    const selectedId = selectedPrinter.id;
    const operation = ++operationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setMessage(null);
    setProgress({ loaded: 0 });
    setState('uploading');
    try {
      const exported = await platform.runtime.exportGcode();
      if (!exported.ok) throw new Error('export failed');
      const documentSnapshot = normalizePrinterConfigurationDocument(document);
      const service = new PrinterControlService(documentSnapshot, platform.printers.transport);
      serviceRef.current = service;
      const input = { bytes: exported.bytes, fileName: fileNameFromPath(exported.path) };
      if (action === 'send') {
        uploadedRef.current = await service.uploadOnly(selectedId, input, setProgress, controller.signal);
      } else {
        const result = await service.uploadThenStart(selectedId, input, setProgress, controller.signal);
        uploadedRef.current = result.uploaded;
      }
      if (operation !== operationRef.current || selectedIdRef.current !== selectedId) return;
      setState('success');
      setMessage(action === 'send' ? 'G-code uploaded to the printer.' : 'G-code uploaded and print started.');
      startCloseCountdown();
    } catch (error) {
      if (operation !== operationRef.current || selectedIdRef.current !== selectedId) return;
      if (error instanceof PrinterControlError && error.code === 'start-failed-after-upload') {
        uploadedRef.current = error.uploaded ?? null;
        setState('start-failed-after-upload');
      } else {
        setState(error instanceof PrinterControlError && error.code === 'aborted' ? 'cancelled' : 'error');
      }
      setMessage(safeErrorMessage(error));
    } finally {
      if (operation === operationRef.current) abortRef.current = null;
    }
  }

  async function retryStart() {
    const service = serviceRef.current;
    const uploaded = uploadedRef.current;
    const printerId = selectedPrinterId;
    if (!service || !uploaded || !printerId || busy) return;
    setState('starting');
    setMessage(null);
    try {
      await service.startPrint(printerId, uploaded);
      setState('success');
      setMessage('Print started.');
      startCloseCountdown();
    } catch {
      // Keep the original uploaded file and never call upload again.
      setState('start-failed-after-upload');
      setMessage('The file is uploaded, but printing did not start. The file remains on the printer.');
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="send-gcode-title" data-testid="send-gcode-dialog">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border bg-card p-5 shadow-lg">
        <div>
          <h2 id="send-gcode-title" className="font-semibold">{action === 'send' ? 'Send G-code' : 'Send and print'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose a printer for this operation. This choice is not saved.</p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="send-printer" className="text-sm font-medium">Printer</label>
          <Select value={selectedPrinterId ?? ''} onValueChange={(value) => { if (value) selectPrinter(value); }} disabled={controlsDisabled || document.printers.length === 0}>
            <SelectTrigger id="send-printer" className="w-full" data-testid="send-printer-select" aria-label="Printer">
              <SelectValue placeholder="Select a printer">
                {(value) => printerLabel(value, document.printers)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {document.printers.map((printer) => (
                <SelectItem key={printer.id} value={printer.id} data-testid={`send-printer-${printer.id}`}>{printer.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {reason && <p className="text-sm text-muted-foreground" role="status" data-testid="send-disabled-reason">{reason}</p>}
        {busy && (
          <div className="space-y-2" data-testid="send-progress-status" role="status" aria-live="polite">
            <Progress value={progressValue ?? null} aria-label={state === 'starting' ? 'Starting print' : 'Uploading G-code'} />
            <p className="text-sm text-muted-foreground">{state === 'starting' ? 'Starting print…' : 'Uploading G-code…'}{progressValue === undefined ? '' : ` ${progressValue}%`}</p>
          </div>
        )}
        {message && !busy && <p className={`text-sm ${state === 'error' || state === 'start-failed-after-upload' ? 'text-destructive' : 'text-muted-foreground'}`} role={state === 'error' || state === 'start-failed-after-upload' ? 'alert' : 'status'} data-testid="send-operation-message" data-error-code={state === 'start-failed-after-upload' ? 'start-failed-after-upload' : undefined}>{message}</p>}
        {state === 'success' && closeCountdown !== null && <p className="text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="send-auto-close-countdown">{switchToDeviceAfterSend ? 'Closing and switching to Device' : 'Closing'} in {closeCountdown} second{closeCountdown === 1 ? '' : 's'}…</p>}
        <div className="flex items-center justify-between gap-2" data-testid="send-actions">
          <div className="flex min-w-0 items-center gap-2 text-sm" data-testid="send-switch-to-device-option">
            <Checkbox
              id="send-switch-to-device"
              checked={switchToDeviceAfterSend}
              onCheckedChange={(checked) => setSwitchToDeviceAfterSend(checked === true)}
              disabled={controlsDisabled}
              data-testid="send-switch-to-device"
            />
            <Label htmlFor="send-switch-to-device">Switch to Device page after sending</Label>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="ghost" onClick={close} data-testid="send-close">{busy ? 'Cancel' : 'Close'}</Button>
            {state === 'start-failed-after-upload' && <Button type="button" variant="secondary" onClick={() => void retryStart()} data-testid="send-retry-start">Retry Start Print</Button>}
            <Button type="button" onClick={() => void send()} disabled={busy || Boolean(reason) || state === 'success' || state === 'start-failed-after-upload'} data-testid="send-submit">{action === 'send' ? 'Send' : 'Send & Print'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
