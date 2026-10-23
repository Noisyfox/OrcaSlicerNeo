import { PrinterDiscovery } from './PrinterDiscovery';
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
import type { SavedPrinter, PrinterRoute, TargetRequest } from '@orca/printer-control/domain';
import { usePrinterCatalogue } from './usePrinterCatalogue';
import type { PrinterConfiguration } from '@orca/printer-control';
import { normalizePrinterConfiguration, normalizePrinterConfigurationDocument } from '@orca/printer-control';
import { updateUserPreferences, usePlatform, type WebViewHost, type WebViewPanelState } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from 'cn';
import { PrinterMonitor, supportsMonitor } from './PrinterMonitor';

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; printerId: string }
  | { kind: 'delete'; printerId: string; target: TargetRequest }
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

export function panelMessage(state: WebViewPanelState): string | null {
  if (state.status === 'loading') return 'Loading printer console…';
  if (state.status === 'error') return 'The printer console could not be loaded.';
  return null;
}

export interface DevicePanelProps {
  /** Optional test seam; production state always starts from the repository. */
  initialSelection?: string | null;
  sidebarVisible?: boolean;
}

/** Shared, host-neutral lifecycle seam; useful for deterministic fake-host tests. */
export function mountPrinterConsolePanel(
  host: WebViewHost,
  container: HTMLElement,
  printer: Pick<PrinterConfiguration, 'driverId' | 'apiKey'> | null,
  resolvedUrl: string,
  onStateChange: (state: WebViewPanelState) => void,
): () => void {
  let disposed = false;
  const panel = host.mount(container, undefined, {
    onStateChange: (next) => {
      if (!disposed) onStateChange(next);
    },
  });
  onStateChange({ ...panel.state });
  if (printer?.driverId === 'moonraker' && printer.apiKey.length > 0) {
    panel.registerBuiltInScript({ scriptId: 'moonraker-fetch-v1', context: { apiKey: printer.apiKey } });
  }
  panel.load(resolvedUrl);
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

export function DevicePanel({ initialSelection = null, sidebarVisible = true }: DevicePanelProps = {}) {
  const platform = usePlatform();
  const { printers, loaded: configurationLoaded, failed: loadFailed, refresh } = usePrinterCatalogue(platform.printers.service);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(initialSelection);
  const [selectedPage, setSelectedPage] = useState<'web' | 'monitor'>('web');
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
    void updateUserPreferences(platform.preferences, prefs => ({
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

  const selectedPrinter = useMemo(
    () => printers.find((printer) => printer.identity.id === selectedPrinterId) ?? null,
    [printers, selectedPrinterId],
  );

  // Selection is deliberately ephemeral. If an edit or another view removes
  // its record, do not silently select a different printer.
  useEffect(() => {
    if (configurationLoaded && !loadFailed && selectedPrinterId && !selectedPrinter) setSelectedPrinterId(null);
  }, [configurationLoaded, loadFailed, selectedPrinter, selectedPrinterId]);

  const consoleRoute = selectedPrinter?.routes.find(route => route.capabilities.webInterface.kind === 'supported');

  const monitorRoute = selectedPrinter?.routes.find(route => supportsMonitor(route.capabilities));
  const activePage = selectedPage === 'web' && consoleRoute ? 'web' : selectedPage === 'monitor' && monitorRoute ? 'monitor' : consoleRoute ? 'web' : monitorRoute ? 'monitor' : null;

  // Mount without a URL first, register the fixed built-in script, then load
  // the configured URL. This ordering is required for Electron document_start.
  useEffect(() => {
    const container = webviewContainerRef.current;
    if (!container || !selectedPrinter || !consoleRoute) {
      setPanelState({ status: 'idle', url: null, error: null });
      return;
    }

    let active = true;
    let disposePanel: (() => void) | undefined;
    setPanelState({ status: 'loading', url: null, error: null });
    void (async () => {
      const printer = selectedPrinter;
      const route = consoleRoute;
      const launch = await platform.printers.service.webInterfaces.resolve({ target: {
        printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision,
      } });
      if (!launch.ok) throw new Error('Web interface unavailable');
      // Credentials remain in the existing Moonraker form/console adapter seam.
      const document = route.providerId === 'moonraker' ? await platform.printers.configuration.load() : null;
      const configuration = document?.printers.find(value => value.id === printer.identity.id) ?? null;
      if (active) disposePanel = mountPrinterConsolePanel(platform.webview, container, configuration, launch.value.url, setPanelState);
    })().catch(() => { if (active) setPanelState({ status: 'error', url: null, error: 'Console unavailable' }); });
    return () => { active = false; disposePanel?.(); };
  }, [
    platform.webview,
    platform.printers.service,
    platform.printers.configuration,
    selectedPrinter?.identity.id,
    consoleRoute?.id,
    consoleRoute?.configurationRevision,
  ]);

  function beginAdd() {
    setFormError(null);
    setDraft({ ...EMPTY_DRAFT });
    setDialog({ kind: 'add' });
  }

  async function beginEdit(printer: SavedPrinter) {
    try {
      const document = await platform.printers.configuration.load();
      const configuration = document.printers.find(value => value.id === printer.identity.id);
      if (!configuration) return;
      setFormError(null);
      setDraft({ ...configuration });
      setDialog({ kind: 'edit', printerId: printer.identity.id });
    } catch { setFormError('Unable to load this printer configuration.'); }
  }

  function beginDelete(printer: SavedPrinter, route: PrinterRoute) {
    setFormError(null);
    setDialog({ kind: 'delete', printerId: printer.identity.id, target: {
      printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision,
    } });
  }

  function closeDialog() {
    setDialog(null);
    setFormError(null);
  }

  async function saveDraft() {
    const id = dialog?.kind === 'edit' ? dialog.printerId : newPrinterId();
    try {
      const current = await platform.printers.configuration.load();
      const document = savePrinterDraft(current.printers, draft, dialog?.kind === 'edit' ? 'edit' : 'add', id);
      await platform.printers.configuration.save(document);
      await refresh();
      closeDialog();
    } catch {
      // Normalizer messages contain field names only; keep the visible copy
      // generic so malformed input or host errors can never echo a secret.
      setFormError('Unable to save this printer configuration. Check each field and try again.');
    }
  }

  async function confirmDelete() {
    if (dialog?.kind !== 'delete') return;
    try {
      const result = await platform.printers.service.forget(dialog.target);
      if (!result.ok) throw new Error('Forget failed');
      await refresh();
      closeDialog();
    } catch {
      setFormError('Unable to delete this printer configuration. Try again.');
    }
  }

  const dialogPrinter = dialog && dialog.kind !== 'add'
    ? printers.find((printer) => printer.identity.id === dialog.printerId) ?? null
    : null;

  return (
    <section className="flex h-full min-h-0 w-full" data-testid="device-panel">
        <aside
          className={cn('shrink-0 flex-col overflow-hidden rounded-md border bg-card', sidebarVisible ? 'flex' : 'hidden')}
          id="device-sidebar"
          aria-label="Device sidebar"
          hidden={!sidebarVisible}
          style={{
            width: `${sidebarWidth}px`,
            minWidth: `${MIN_DEVICE_SIDEBAR_WIDTH}px`,
            maxWidth: `${MAX_DEVICE_SIDEBAR_WIDTH}px`,
          }}
        >
          <div className="space-y-2 border-b p-3">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-sm font-semibold">Devices</h1>
              <div className="flex items-center gap-1"><PrinterDiscovery saved={printers} />
                <TooltipFor content="Add printer">
                  <Button size="icon-xs" variant="secondary" onClick={beginAdd} disabled={!configurationLoaded} aria-label="Add printer" data-testid="device-add-printer"><Plus /></Button>
                </TooltipFor>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <Select value={selectedPrinterId} onValueChange={value => { setSelectedPrinterId(value); setSelectedPage('web'); }} items={printers.map(printer => ({ value: printer.identity.id, label: printer.identity.displayName }))}>
                <SelectTrigger className="min-w-0 flex-1" disabled={!configurationLoaded || printers.length === 0} aria-label="Select printer" data-testid="device-printer-select">
                  <SelectValue className="truncate" placeholder="Select a printer" />
                </SelectTrigger>
                <SelectContent align="start">
                  {printers.map(printer => <SelectItem key={printer.identity.id} value={printer.identity.id} data-testid={`device-select-${printer.identity.id}`}>{printer.identity.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
              {selectedPrinter && <div className="flex shrink-0 items-center gap-1">
                {selectedPrinter.routes.some(route => route.providerId === 'moonraker' && route.management.configure) && <TooltipFor content={`Edit ${selectedPrinter.identity.displayName}`}>
                  <Button size="icon-xs" variant="ghost" onClick={() => void beginEdit(selectedPrinter)} aria-label={`Edit ${selectedPrinter.identity.displayName}`} data-testid={`device-edit-${selectedPrinter.identity.id}`}><Pencil /></Button>
                </TooltipFor>}
                {selectedPrinter.routes.filter(route => route.management.forget).map(route => <TooltipFor key={route.id} content={`Delete ${selectedPrinter.identity.displayName} (${route.label})`}>
                  <Button size="icon-xs" variant="ghost" onClick={() => beginDelete(selectedPrinter, route)} aria-label={`Delete ${selectedPrinter.identity.displayName} (${route.label})`} data-testid={`device-delete-${selectedPrinter.identity.id}`}><Trash2 /></Button>
                </TooltipFor>)}
              </div>}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loadFailed && printers.length > 0 && <p role="alert" className="p-2 text-xs text-muted-foreground">Unable to refresh printers. Showing the last available list.</p>}
            {!configurationLoaded ? <p data-testid="device-loading-list" className="p-3 text-xs text-muted-foreground">Loading printers…</p>
              : printers.length === 0 ? <p data-testid="device-empty-list" className="p-3 text-xs text-muted-foreground">{loadFailed ? 'No saved printers are available.' : 'No printers configured.'}</p>
              : !selectedPrinter ? <p className="p-3 text-xs text-muted-foreground">Select a printer to view its features.</p>
              : <div role="tablist" aria-label="Printer features" aria-orientation="vertical" className="flex flex-col gap-1" onKeyDown={event => {
                  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                  const index = tabs.indexOf(event.target as HTMLButtonElement);
                  const next = event.key === 'ArrowDown' ? (index + 1) % tabs.length : event.key === 'ArrowUp' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
                  if (next >= 0 && tabs[next]) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
                }}>
                  {([{ id: 'web', label: 'Web Interface', available: !!consoleRoute }, { id: 'monitor', label: 'Monitor', available: !!monitorRoute }] as const).filter(page => page.available).map(page => <button
                    key={page.id} id={`device-tab-${page.id}`} role="tab" aria-selected={activePage === page.id} aria-controls="device-content" tabIndex={activePage === page.id ? 0 : -1}
                    className={cn('rounded-md border px-3 py-2 text-left text-sm', activePage === page.id ? 'border-primary bg-accent/20' : 'border-transparent hover:bg-muted/60')}
                    onClick={() => setSelectedPage(page.id)}>{page.label}</button>)}
                  {!activePage && <p className="p-3 text-xs text-muted-foreground">No supported features are available. Some printer capabilities may not yet be known.</p>}
                </div>}
          </div>
        </aside>

        <div
          hidden={!sidebarVisible}
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
          className={cn(!sidebarVisible && 'hidden', "w-1.5 shrink-0 cursor-ew-resize touch-none self-stretch rounded-full bg-clip-content px-px transition-colors hover:bg-accent/20 focus-visible:bg-accent/30 focus-visible:outline-none")}
        />

        <main className="relative min-w-0 flex-1 overflow-hidden rounded-md border bg-card" id="device-content" role={activePage ? "tabpanel" : undefined} aria-labelledby={activePage ? `device-tab-${activePage}` : undefined} aria-label={activePage ? undefined : "Printer details"}>
          {selectedPrinter && monitorRoute && <div hidden={activePage !== 'monitor'} className="h-full"><PrinterMonitor key={`${selectedPrinter.identity.id}:${monitorRoute.id}:${monitorRoute.configurationRevision}`} printer={selectedPrinter} route={monitorRoute} /></div>}
          <div hidden={activePage !== 'web'} ref={webviewContainerRef} className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full [&>webview]:h-full [&>webview]:w-full" data-testid="device-webview-container" />
          {!selectedPrinter && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-sm text-center text-sm text-muted-foreground" data-testid="device-console-empty">
                <Monitor className="mx-auto mb-3 size-10 opacity-60" />
                <p>{printers.length === 0 ? 'Add a printer to view its console.' : 'Select a printer to view its console.'}</p>
              </div>
            </div>
          )}
          {selectedPrinter && !activePage && (
            <div className="absolute inset-0 flex items-center justify-center p-6" data-testid="device-details">
              <div className="text-center text-sm">
                <p className="font-medium">{selectedPrinter.identity.displayName}</p>
                <p>{[selectedPrinter.identity.manufacturer, selectedPrinter.identity.model].filter(Boolean).join(' · ')}</p>
                <p className="text-muted-foreground">{selectedPrinter.routes.map(route => route.label).join(' · ')}</p>
                <p className="mt-2 text-muted-foreground">This printer does not provide a console.</p>
              </div>
            </div>
          )}
          {selectedPrinter && activePage === 'web' && panelMessage(panelState) && (
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
              <p className="mt-1 text-sm text-muted-foreground">Remove the selected connection for “{dialogPrinter.identity.displayName}” and its saved access details? Other connections will remain.</p>
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
              <Label htmlFor="device-api-base-url">API base URL</Label>
              <Input id="device-api-base-url" data-testid="device-api-base-url" type="url" placeholder="http://printer.local:7125/" value={draft.apiBaseUrl} onChange={(event) => setDraft({ ...draft, apiBaseUrl: event.target.value })} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="device-console-url">Console URL <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="device-console-url" data-testid="device-console-url" type="url" placeholder="Uses API base URL when blank" value={draft.consoleUrl} onChange={(event) => setDraft({ ...draft, consoleUrl: event.target.value })} />
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
