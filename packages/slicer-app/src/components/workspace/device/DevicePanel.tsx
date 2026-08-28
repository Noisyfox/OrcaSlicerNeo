import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Pencil, Plus, Trash2, Monitor } from 'lucide-react';
import type { PrinterConfiguration } from '@orca/printer-control';
import { normalizePrinterConfiguration, normalizePrinterConfigurationDocument } from '@orca/printer-control';
import { usePlatform, type WebViewHost, type WebViewPanelState } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; printerId: string }
  | { kind: 'delete'; printerId: string }
  | null;

export type PrinterDraft = Omit<PrinterConfiguration, 'id'> & { id?: string };

const EMPTY_DRAFT: PrinterDraft = {
  displayName: '',
  driverId: 'moonraker',
  consoleUrl: '',
  apiBaseUrl: '',
  apiKey: '',
};

const DEFAULT_DEVICE_SIDEBAR_WIDTH = 288;
const MIN_DEVICE_SIDEBAR_WIDTH = 220;
const MAX_DEVICE_SIDEBAR_WIDTH = 560;

function clampDeviceSidebarWidth(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DEVICE_SIDEBAR_WIDTH;
  return Math.min(MAX_DEVICE_SIDEBAR_WIDTH, Math.max(MIN_DEVICE_SIDEBAR_WIDTH, value!));
}

let printerIdSequence = 0;
function newPrinterId(): string {
  // Stable IDs are generated locally and never exposed to the console page.
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto);
  printerIdSequence += 1;
  return `printer-${Date.now().toString(36)}-${printerIdSequence.toString(36)}`;
}

export function panelMessage(state: WebViewPanelState): string {
  if (state.status === 'loading') return 'Loading printer console…';
  if (state.status === 'loaded') return 'Printer console loaded';
  if (state.status === 'error') return 'The printer console could not be loaded.';
  return 'Select a printer to open its console.';
}

export interface DevicePanelProps {
  /** Optional test seam; production state always starts from the repository. */
  initialSelection?: string | null;
}

/** Shared, host-neutral lifecycle seam; useful for deterministic fake-host tests. */
export function mountPrinterConsolePanel(
  host: WebViewHost,
  container: HTMLElement,
  printer: PrinterConfiguration,
  onStateChange: (state: WebViewPanelState) => void,
): () => void {
  let disposed = false;
  const panel = host.mount(container, undefined, {
    onStateChange: (next) => {
      if (!disposed) onStateChange(next);
    },
  });
  onStateChange({ ...panel.state });
  if (printer.driverId === 'moonraker' && printer.apiKey.length > 0) {
    panel.registerBuiltInScript({ scriptId: 'moonraker-fetch-v1', context: { apiKey: printer.apiKey } });
  }
  panel.load(printer.consoleUrl);
  return () => {
    if (disposed) return;
    disposed = true;
    panel.dispose();
  };
}

export function savePrinterDraft(
  printers: readonly PrinterConfiguration[],
  draft: PrinterDraft,
  mode: 'add' | 'edit',
  printerId = newPrinterId(),
) {
  const normalized = normalizePrinterConfiguration({ ...draft, id: printerId });
  const next = mode === 'edit'
    ? printers.map((printer) => printer.id === printerId ? normalized : printer)
    : [...printers, normalized];
  return normalizePrinterConfigurationDocument({ version: 1, printers: next });
}

export function removePrinter(printers: readonly PrinterConfiguration[], printerId: string) {
  return normalizePrinterConfigurationDocument({
    version: 1,
    printers: printers.filter((printer) => printer.id !== printerId),
  });
}

export function DevicePanel({ initialSelection = null }: DevicePanelProps = {}) {
  const platform = usePlatform();
  const [printers, setPrinters] = useState<PrinterConfiguration[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(initialSelection);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [draft, setDraft] = useState<PrinterDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [panelState, setPanelState] = useState<WebViewPanelState>({ status: 'idle', url: null, error: null });
  const webviewContainerRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_DEVICE_SIDEBAR_WIDTH);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizeActiveRef = useRef(false);
  const stopResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    void platform.preferences.load().then((prefs) => {
      if (!active) return;
      const width = clampDeviceSidebarWidth(prefs.ui.deviceSidebarWidth);
      sidebarWidthRef.current = width;
      setSidebarWidth(width);
    });
    return () => {
      active = false;
      stopResizeRef.current?.();
    };
  }, [platform.preferences]);

  function persistDeviceSidebarWidth(width: number) {
    void platform.preferences.load().then((prefs) => platform.preferences.save({
      ...prefs,
      ui: { ...prefs.ui, deviceSidebarWidth: width },
    })).catch(() => undefined);
  }

  function beginResize(clientX: number) {
    if (resizeActiveRef.current) return;
    resizeActiveRef.current = true;
    const startX = clientX;
    const startWidth = sidebarWidthRef.current;
    let active = true;

    const applyClientX = (nextClientX: number) => {
      if (!active) return;
      const nextWidth = Math.min(
        MAX_DEVICE_SIDEBAR_WIDTH,
        Math.max(MIN_DEVICE_SIDEBAR_WIDTH, startWidth + nextClientX - startX),
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };
    const onPointerMove = (event: PointerEvent) => applyClientX(event.clientX);
    const onMouseMove = (event: MouseEvent) => applyClientX(event.clientX);
    const stop = () => {
      if (!active) return;
      active = false;
      stopResizeRef.current = null;
      resizeActiveRef.current = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('pointercancel', stop);
      persistDeviceSidebarWidth(sidebarWidthRef.current);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    stopResizeRef.current = stop;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('mouseup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    if (typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Some test/jsdom environments do not implement pointer capture.
      }
    }
    beginResize(event.clientX);
  }

  function handleResizeMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    beginResize(event.clientX);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -16 : 16;
    const nextWidth = Math.min(
      MAX_DEVICE_SIDEBAR_WIDTH,
      Math.max(MIN_DEVICE_SIDEBAR_WIDTH, sidebarWidthRef.current + delta),
    );
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    persistDeviceSidebarWidth(nextWidth);
  }

  useEffect(() => {
    let active = true;
    void platform.printers.configuration.load().then((document) => {
      if (!active) return;
      try {
        const normalized = normalizePrinterConfigurationDocument(document);
        setPrinters(normalized.printers);
        setLoadFailed(false);
      } catch {
        // An invalid repository document must not prevent the rest of the app
        // from being usable. It is intentionally represented as an empty list.
        setPrinters([]);
        setLoadFailed(true);
      }
    }).catch(() => {
      if (!active) return;
      setPrinters([]);
      setLoadFailed(true);
    });
    return () => { active = false; };
  }, [platform.printers.configuration]);

  const selectedPrinter = useMemo(
    () => printers.find((printer) => printer.id === selectedPrinterId) ?? null,
    [printers, selectedPrinterId],
  );

  // Selection is deliberately ephemeral. If an edit or another view removes
  // its record, do not silently select a different printer.
  useEffect(() => {
    if (selectedPrinterId && !selectedPrinter) setSelectedPrinterId(null);
  }, [selectedPrinter, selectedPrinterId]);

  // Mount without a URL first, register the fixed built-in script, then load
  // the configured URL. This ordering is required for Electron document_start.
  useEffect(() => {
    const container = webviewContainerRef.current;
    if (!container || !selectedPrinter || !selectedPrinter.consoleUrl) {
      setPanelState({ status: 'idle', url: null, error: null });
      return;
    }

    const disposePanel = mountPrinterConsolePanel(platform.webview, container, selectedPrinter, setPanelState);

    return () => {
      disposePanel();
    };
  }, [
    platform.webview,
    selectedPrinter?.id,
    selectedPrinter?.consoleUrl,
    selectedPrinter?.apiKey,
    selectedPrinter?.driverId,
  ]);

  function beginAdd() {
    setFormError(null);
    setDraft({ ...EMPTY_DRAFT });
    setDialog({ kind: 'add' });
  }

  function beginEdit(printer: PrinterConfiguration) {
    setFormError(null);
    setDraft({ ...printer });
    setDialog({ kind: 'edit', printerId: printer.id });
  }

  function beginDelete(printerId: string) {
    setDialog({ kind: 'delete', printerId });
  }

  function closeDialog() {
    setDialog(null);
    setFormError(null);
  }

  async function saveDraft() {
    const id = dialog?.kind === 'edit' ? dialog.printerId : newPrinterId();
    try {
      const document = savePrinterDraft(printers, draft, dialog?.kind === 'edit' ? 'edit' : 'add', id);
      await platform.printers.configuration.save(document);
      setPrinters(document.printers);
      closeDialog();
    } catch {
      // Normalizer messages contain field names only; keep the visible copy
      // generic so malformed input or host errors can never echo a secret.
      setFormError('Unable to save this printer configuration. Check each field and try again.');
    }
  }

  async function confirmDelete() {
    if (dialog?.kind !== 'delete') return;
    const deletingId = dialog.printerId;
    try {
      const document = removePrinter(printers, deletingId);
      await platform.printers.configuration.save(document);
      setPrinters(document.printers);
      if (selectedPrinterId === deletingId) setSelectedPrinterId(null);
      closeDialog();
    } catch {
      setFormError('Unable to delete this printer configuration. Try again.');
    }
  }

  const dialogPrinter = dialog && dialog.kind !== 'add'
    ? printers.find((printer) => printer.id === dialog.printerId) ?? null
    : null;

  return (
    <section className="flex h-full min-h-0 w-full gap-1" data-testid="device-panel">
        <aside
          className="flex shrink-0 flex-col overflow-hidden rounded-md border bg-card"
          aria-label="Saved printers"
          style={{
            width: `${sidebarWidth}px`,
            minWidth: `${MIN_DEVICE_SIDEBAR_WIDTH}px`,
            maxWidth: `${MAX_DEVICE_SIDEBAR_WIDTH}px`,
          }}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <h1 className="text-sm font-semibold">Devices</h1>
              <p className="text-xs text-muted-foreground">Printer consoles</p>
            </div>
            <Button size="icon-xs" variant="secondary" onClick={beginAdd} title="Add printer" aria-label="Add printer" data-testid="device-add-printer">
              <Plus />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {printers.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="device-empty-list">
                {loadFailed ? 'No saved printers are available.' : 'No printers configured.'}
              </p>
            ) : (
              <div className="flex flex-col gap-1" role="list" aria-label="Printers">
                {printers.map((printer) => (
                  <div
                    key={printer.id}
                    role="listitem"
                    className={cn(
                      'group flex items-center gap-1 rounded-md border px-2 py-1.5',
                      selectedPrinterId === printer.id ? 'border-primary bg-accent/20' : 'border-transparent hover:bg-muted/60',
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-sm"
                      aria-pressed={selectedPrinterId === printer.id}
                      onClick={() => setSelectedPrinterId(printer.id)}
                      data-testid={`device-select-${printer.id}`}
                    >
                      {printer.displayName}
                    </button>
                    <Button size="icon-xs" variant="ghost" onClick={() => beginEdit(printer)} title={`Edit ${printer.displayName}`} aria-label={`Edit ${printer.displayName}`} data-testid={`device-edit-${printer.id}`}>
                      <Pencil />
                    </Button>
                    <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => beginDelete(printer.id)} title={`Delete ${printer.displayName}`} aria-label={`Delete ${printer.displayName}`} data-testid={`device-delete-${printer.id}`}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize device sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_DEVICE_SIDEBAR_WIDTH}
          aria-valuemax={MAX_DEVICE_SIDEBAR_WIDTH}
          tabIndex={0}
          data-testid="device-sidebar-resizer"
          onPointerDown={handleResizePointerDown}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
          className="w-1.5 shrink-0 cursor-ew-resize touch-none self-stretch rounded-full bg-clip-content px-px transition-colors hover:bg-accent/20 focus-visible:bg-accent/30 focus-visible:outline-none"
        />

        <main className="relative min-w-0 flex-1 overflow-hidden rounded-md border bg-card" aria-label="Printer console">
          <div ref={webviewContainerRef} className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full [&>webview]:h-full [&>webview]:w-full" data-testid="device-webview-container" />
          {(!selectedPrinter || !selectedPrinter.consoleUrl) && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-sm text-center text-sm text-muted-foreground" data-testid="device-console-empty">
                <Monitor className="mx-auto mb-3 size-10 opacity-60" />
                <p>{printers.length === 0 ? 'Add a printer to view its console.' : 'Select a printer to view its console.'}</p>
              </div>
            </div>
          )}
          {selectedPrinter && selectedPrinter.consoleUrl && panelState.status !== 'idle' && (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/85 px-2 py-1 text-xs text-muted-foreground" data-testid="device-console-status" role={panelState.status === 'error' ? 'alert' : undefined}>
              {panelMessage(panelState)}
            </div>
          )}
        </main>
      {dialog?.kind === 'delete' && dialogPrinter && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="device-delete-title" data-testid="device-delete-dialog">
          <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-5 shadow-lg">
            <div>
              <h2 id="device-delete-title" className="font-semibold">Delete printer?</h2>
              <p className="mt-1 text-sm text-muted-foreground">Remove “{dialogPrinter.displayName}” and its saved connection details?</p>
            </div>
            {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeDialog}>Cancel</Button>
              <Button variant="destructive" onClick={() => void confirmDelete()} data-testid="device-confirm-delete">Delete</Button>
            </div>
          </div>
        </div>
      )}

      {(dialog?.kind === 'add' || dialog?.kind === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="device-config-title" data-testid="device-config-dialog">
          <form className="flex w-full max-w-lg flex-col gap-4 rounded-lg border bg-card p-5 shadow-lg" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
            <div>
              <h2 id="device-config-title" className="font-semibold">{dialog.kind === 'add' ? 'Add printer' : 'Edit printer'}</h2>
              <p className="mt-1 text-sm text-muted-foreground">Configure the printer console and Moonraker API separately.</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-display-name">Display name</Label>
              <Input id="device-display-name" data-testid="device-display-name" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} autoFocus required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-adapter">Adapter</Label>
              <Select value={draft.driverId} onValueChange={(value) => setDraft({ ...draft, driverId: value as PrinterConfiguration['driverId'] })}>
                <SelectTrigger id="device-adapter" className="w-full" data-testid="device-adapter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="moonraker">Moonraker</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-console-url">Console URL</Label>
              <Input id="device-console-url" data-testid="device-console-url" type="url" placeholder="https://printer.local/" value={draft.consoleUrl} onChange={(event) => setDraft({ ...draft, consoleUrl: event.target.value })} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-api-base-url">API base URL</Label>
              <Input id="device-api-base-url" data-testid="device-api-base-url" type="url" placeholder="http://printer.local:7125/" value={draft.apiBaseUrl} onChange={(event) => setDraft({ ...draft, apiBaseUrl: event.target.value })} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-api-key">API key</Label>
              <Input id="device-api-key" data-testid="device-api-key" type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
            </div>
            {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeDialog}>Cancel</Button>
              <Button type="submit" data-testid="device-save-printer">Save</Button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
