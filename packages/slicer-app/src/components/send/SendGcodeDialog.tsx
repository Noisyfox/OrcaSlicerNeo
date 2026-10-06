import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PrinterControlError,
  PrinterControlService,
  normalizePrinterConfigurationDocument,
  type PrinterConfiguration,
  type PrinterConfigurationDocument,
  type UploadedGcode,
} from '@orca/printer-control';
import { gcodeFilenameBasename, updateUserPreferences, usePlatform, type PlatformCapabilities, type UserPreferences } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { projectFilenameBase, useProjectStore } from '@/stores/useProjectStore';

export type SendGcodeAction = 'send' | 'send-and-print';
type SendState = 'idle' | 'loading' | 'uploading' | 'starting' | 'success' | 'start-failed-after-upload' | 'error' | 'cancelled';

function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)) - 1);
  return `${(bytes / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`;
}

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
  /** Captured plate result for card actions; independent of current-plate navigation. */
  targetReceipt?: import('@slicer/client').SliceResultReceipt;
}

/**
 * The Send panel owns an ephemeral target selection. It intentionally does
 * not use DevicePanel's selection or write selection to any repository.
 */
export function SendGcodeDialog({ open, action, onClose, initialSelection = null, platform: injectedPlatform, onNavigateToDevice, targetReceipt }: SendGcodeDialogProps) {
  const contextPlatform = usePlatform();
  const platform = injectedPlatform ?? contextPlatform;
  const sliceStatus = useSlicerStore((state) => state.status);
  const sliceTarget = useSlicerStore((state) => state.sliceTarget);
  const plateResults = useSlicerStore(s => s.plateResults);
  const cachedReceipt = targetReceipt ? plateResults[targetReceipt.plateId]?.receipt : undefined;
  const activeSliceTarget = useSlicerStore(s => s.activeSliceTarget);
  const sliceReady = activeSliceTarget === null && (targetReceipt ? cachedReceipt?.inputStamp === targetReceipt.inputStamp &&
    cachedReceipt?.resultGeneration === targetReceipt.resultGeneration && cachedReceipt?.sliceTaskId === targetReceipt.sliceTaskId : sliceStatus === 'done');
  const [document, setDocument] = useState<PrinterConfigurationDocument>({ version: 1, printers: [] });
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(initialSelection);
  const [state, setState] = useState<SendState>('idle');
  const [progress, setProgress] = useState<{ loaded: number; total?: number; fraction?: number }>({ loaded: 0 });
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const uploadMeasurementRef = useRef<{ startedAt: number; loaded: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [closeCountdown, setCloseCountdown] = useState<number | null>(null);
  const [switchToDeviceAfterSend, setSwitchToDeviceAfterSend] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const operationRef = useRef(0);
  const serviceRef = useRef<PrinterControlService | null>(null);
  const uploadedRef = useRef<UploadedGcode | null>(null);
  const uploadFilenameRef = useRef<{ receiptKey: string; fileName: string } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const preferenceRef = useRef<UserPreferences | null>(null);
  const preferenceLoadGenerationRef = useRef(0);
  const preferenceRevisionRef = useRef(0);
  const preferenceInteractionRef = useRef(false);
  const preferenceSaveChainRef = useRef(Promise.resolve());

  const selectedPrinter = useMemo(
    () => document.printers.find((printer) => printer.id === selectedPrinterId) ?? null,
    [document.printers, selectedPrinterId],
  );
  const reason = unavailableReason(sliceReady, document.printers, selectedPrinter);
  const busy = state === 'loading' || state === 'uploading' || state === 'starting';
  const controlsDisabled = busy || state === 'success';
  const awaitingConfirmation = state === 'uploading' && progress.fraction !== undefined && progress.fraction >= 1;
  const progressValue = state !== 'uploading' || progress.fraction === undefined
    ? undefined : awaitingConfirmation ? 100 : Math.min(99, Math.round(Math.max(0, progress.fraction) * 100));
  const progressLabel = state === 'starting' ? 'Starting print'
    : awaitingConfirmation ? 'Waiting for printer confirmation' : 'Uploading G-code';

  useEffect(() => {
    if (state !== 'uploading' || awaitingConfirmation) return;
    const timer = setInterval(() => {
      const measurement = uploadMeasurementRef.current;
      if (!measurement) return;
      const elapsed = performance.now() - measurement.startedAt;
      if (elapsed <= 0) return;
      setUploadSpeed(measurement.loaded * 1000 / elapsed);
    }, 500);
    return () => clearInterval(timer);
  }, [state, awaitingConfirmation]);

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
    setUploadSpeed(0);
    uploadMeasurementRef.current = null;
    uploadedRef.current = null;
    uploadFilenameRef.current = null;
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
    if (!open) {
      preferenceLoadGenerationRef.current += 1;
      preferenceInteractionRef.current = false;
      setSwitchToDeviceAfterSend(true);
      return;
    }

    const generation = ++preferenceLoadGenerationRef.current;
    const revision = preferenceRevisionRef.current;
    let active = true;
    preferenceInteractionRef.current = false;
    // Show the application default until the normalized repository value loads.
    setSwitchToDeviceAfterSend(true);
    const pendingSaves = preferenceSaveChainRef.current;
    void pendingSaves.then(() => platform.preferences.load()).then((prefs) => {
      if (!active || generation !== preferenceLoadGenerationRef.current
        || revision !== preferenceRevisionRef.current || preferenceInteractionRef.current) return;
      preferenceRef.current = prefs;
      setSwitchToDeviceAfterSend(prefs.ui.switchToDeviceAfterSend);
    }).catch((error) => {
      if (active && generation === preferenceLoadGenerationRef.current) {
        console.error('send navigation preference load failed; using default', error);
      }
    });
    return () => { active = false; };
  }, [open, platform.preferences]);

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

  function updateSwitchToDeviceAfterSend(checked: boolean) {
    preferenceInteractionRef.current = true;
    preferenceRevisionRef.current += 1;
    setSwitchToDeviceAfterSend(checked);
    preferenceSaveChainRef.current = preferenceSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          preferenceRef.current = await updateUserPreferences(platform.preferences, preferences => ({
            ...preferences, ui: { ...preferences.ui, switchToDeviceAfterSend: checked },
          }));
        } catch (error) {
          // Persistence is best effort; the current dialog still honors the
          // user's choice and the host repository remains the source of truth.
          console.error('send navigation preference save failed; keeping session value', error);
        }
      });
  }

  async function send() {
    if (busy || reason || !selectedPrinter) return;
    const selectedId = selectedPrinter.id;
    const operation = ++operationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setMessage(null);
    setProgress({ loaded: 0 });
    setUploadSpeed(0);
    uploadMeasurementRef.current = null;
    setState('uploading');
    try {
      const currentSession = await platform.runtime.getPlateSessionSnapshot();
      if (!currentSession.ok) throw new Error(currentSession.error);
      if (useSlicerStore.getState().activeSliceTarget) throw new Error('Wait for slicing to finish before sending G-code.');
      usePlateSessionStore.getState().setSnapshot(currentSession);
      const plateId = targetReceipt?.plateId ?? currentSession.currentPlateId;
      const currentRevision = currentSession.inputRevisions?.[plateId];
      if (!targetReceipt && (!sliceTarget || sliceTarget.plateId !== currentSession.currentPlateId ||
          sliceTarget.inputRevision !== currentRevision)
        ) throw new Error('current plate slice result is stale or unavailable');
      const currentPlate = currentSession.plates.find((plate) => plate.plateId === plateId);
      if (!currentPlate || currentPlate.valid === false || !(currentPlate.instanceIds?.length))
        throw new Error(currentPlate?.valid === false ? 'current plate contains an out-of-bounds instance' : 'current plate is empty');
      const liveReceipt = useSlicerStore.getState().plateResults[plateId]?.receipt;
      const receipt = targetReceipt ?? liveReceipt;
      if (!receipt || receipt.inputStamp !== currentRevision || !liveReceipt ||
          receipt.resultGeneration !== liveReceipt.resultGeneration || receipt.sliceTaskId !== liveReceipt.sliceTaskId)
        throw new Error('current plate slice result is stale or unavailable');
      const exported = await platform.runtime.exportGcodePlate({ receipt, filenameBase: projectFilenameBase(useProjectStore.getState()) });
      if (operation !== operationRef.current || selectedIdRef.current !== selectedId) return;
      if (!exported.ok) {
        setState('error');
        setMessage(exported.error);
        return;
      }
      const documentSnapshot = normalizePrinterConfigurationDocument(document);
      const service = new PrinterControlService(documentSnapshot, platform.printers.transport);
      serviceRef.current = service;
      const receiptKey = JSON.stringify([receipt.plateId, receipt.inputStamp, receipt.resultGeneration, receipt.sliceTaskId]);
      if (uploadFilenameRef.current?.receiptKey !== receiptKey) {
        uploadFilenameRef.current = { receiptKey, fileName: gcodeFilenameBasename(exported.fileName) };
      }
      const input = { bytes: exported.bytes, fileName: uploadFilenameRef.current.fileName };
      uploadMeasurementRef.current = { startedAt: performance.now(), loaded: 0 };
      const uploaded = await service.uploadOnly(selectedId, input, (next) => {
        if (operation !== operationRef.current) return;
        uploadMeasurementRef.current!.loaded = next.loaded;
        setProgress(next);
      }, controller.signal);
      uploadedRef.current = uploaded;
      if (operation !== operationRef.current || selectedIdRef.current !== selectedId) return;
      if (action === 'send-and-print') {
        setState('starting');
        try {
          await service.startPrint(selectedId, uploaded);
        } catch (error) {
          throw new PrinterControlError('start-failed-after-upload', 'Print start failed after upload', 'start',
            error instanceof PrinterControlError ? error.status : undefined, uploaded);
        }
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
          <div className="flex flex-col gap-2" data-testid="send-progress-status" role="status" aria-live="polite">
            <Progress value={progressValue ?? null} aria-label={progressLabel} />
            <p className="text-sm text-muted-foreground">{progressLabel}…{progressValue === undefined ? '' : ` ${progressValue}%`}</p>
            {state === 'uploading' && (
              <p className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground tabular-nums" data-testid="send-transfer-stats">
                <span>{formatUploadBytes(progress.loaded)} / {progress.total === undefined ? 'Unknown' : formatUploadBytes(progress.total)}</span>
                <span>{((awaitingConfirmation ? 0 : uploadSpeed) / 1024).toFixed(1)} KiB/s</span>
              </p>
            )}
          </div>
        )}
        {message && !busy && <p className={`text-sm ${state === 'error' || state === 'start-failed-after-upload' ? 'text-destructive' : 'text-muted-foreground'}`} role={state === 'error' || state === 'start-failed-after-upload' ? 'alert' : 'status'} data-testid="send-operation-message" data-error-code={state === 'start-failed-after-upload' ? 'start-failed-after-upload' : undefined}>{message}</p>}
        {state === 'success' && closeCountdown !== null && <p className="text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="send-auto-close-countdown">{switchToDeviceAfterSend ? 'Closing and switching to Device' : 'Closing'} in {closeCountdown} second{closeCountdown === 1 ? '' : 's'}…</p>}
        <div className="flex items-center justify-between gap-2" data-testid="send-actions">
          <div className="flex min-w-0 items-center gap-2 text-sm" data-testid="send-switch-to-device-option">
            <Checkbox
              id="send-switch-to-device"
              checked={switchToDeviceAfterSend}
              onCheckedChange={(checked) => updateSwitchToDeviceAfterSend(checked === true)}
              disabled={controlsDisabled}
              data-testid="send-switch-to-device"
            />
            <Label htmlFor="send-switch-to-device">Switch to Device page after sending</Label>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="ghost" onClick={close} data-testid="send-close">{state === 'uploading' || state === 'loading' ? 'Cancel' : 'Close'}</Button>
            {state === 'start-failed-after-upload' && <Button type="button" variant="secondary" onClick={() => void retryStart()} data-testid="send-retry-start">Retry Start Print</Button>}
            <Button type="button" onClick={() => void send()} disabled={busy || Boolean(reason) || state === 'success' || state === 'start-failed-after-upload'} data-testid="send-submit">{action === 'send' ? 'Send' : 'Send & Print'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
