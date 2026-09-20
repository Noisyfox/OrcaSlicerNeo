// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type UserPreferences } from '@orca/platform-contract';
import type { PrinterConfiguration, PrinterTransport, PrinterTransportRequest, PrinterTransportResponse } from '@orca/printer-control';
import { SendGcodeDialog } from './SendGcodeDialog';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';

// jsdom does not provide PointerEvent, while Base UI's checkbox click path
// constructs one to preserve pointer modifiers.
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

const printers: PrinterConfiguration[] = [
  { id: 'p1', displayName: 'Workshop', driverId: 'moonraker', consoleUrl: 'http://console.local/', apiBaseUrl: 'http://printer.local:7125/', apiKey: 'secret-key-must-not-render' },
  { id: 'p2', displayName: 'Office', driverId: 'moonraker', consoleUrl: 'http://office-console.local/', apiBaseUrl: 'http://office.local:7125/', apiKey: 'another-secret' },
];

class FixtureTransport implements PrinterTransport {
  requests: PrinterTransportRequest[] = [];
  responses: unknown[] = [];
  statuses: number[] = [];
  pending = false;
  async request(request: PrinterTransportRequest): Promise<PrinterTransportResponse> {
    this.requests.push(request);
    request.onUploadProgress?.({ loaded: 5, total: 10 });
    if (this.pending) {
      await new Promise<void>((resolve, reject) => {
        const signal = request.signal;
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { signal?.removeEventListener('abort', abort); reject(new DOMException('aborted', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const response = this.responses.shift() ?? { result: { item: { path: 'gcodes/output.gcode' } } };
    return { status: this.statuses.shift() ?? 200, json: async () => response };
  }
}

function makePlatform(
  transport: FixtureTransport,
  documentValue = { version: 1 as const, printers },
  preferenceValue: UserPreferences = { version: 1, selectedProfiles: {}, ui: {} },
) {
  let preferences = preferenceValue;
  const runtime = {
    getPlateSessionSnapshot: vi.fn(async () => usePlateSessionStore.getState().snapshot!),
    exportGcodePlate: vi.fn(async () => ({ ok: true, path: '/tmp/output.gcode', bytes: new Uint8Array([1, 2, 3]) })),
  };
  return {
    platform: {
      preferences: {
        load: vi.fn(async () => preferences),
        save: vi.fn(async (next) => { preferences = next; }),
      },
      printers: {
        configuration: {
          load: vi.fn(async () => documentValue),
          save: vi.fn(async () => undefined),
        },
        transport,
      },
      runtime,
    } as unknown as PlatformCapabilities,
    runtime,
    preferences: () => preferences,
  };
}

async function render(
  platform: PlatformCapabilities,
  action: 'send' | 'send-and-print',
  initialSelection: string | null = 'p1',
  onClose: () => void = () => undefined,
  onNavigateToDevice: () => void = () => undefined,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PlatformProvider value={platform}><SendGcodeDialog open action={action} initialSelection={initialSelection} onClose={onClose} onNavigateToDevice={onNavigateToDevice} /></PlatformProvider>);
  });
  return { container, root };
}

async function click(container: HTMLElement, testId: string) {
  await act(async () => { (container.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click(); });
}

async function choosePrinter(container: HTMLElement, id: string) {
  await act(async () => {
    (container.querySelector('[data-testid="send-printer-select"]') as HTMLElement).click();
  });
  const item = document.querySelector(`[data-testid="send-printer-${id}"]`) as HTMLElement;
  await act(async () => {
    item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
}

describe('SendGcodeDialog', () => {
  let roots: Root[] = [];
  beforeEach(() => {
    const receipt = { plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' };
    usePlateSessionStore.getState().setSnapshot({ ok: true, version: 1, currentPlateId: 'plate-1',
      plates: [{ plateId: 'plate-1', displayIndex: 0, name: 'Plate 1', origin: [0, 0, 0], instanceIds: [1] }],
      instances: [{ instanceId: 1, objectId: 1, objectIndex: 0, instanceIndex: 0,
        plateId: 'plate-1', member: true, unprintable: false, outOfBounds: false }],
      inputRevisions: { 'plate-1': 1 } });
    useSlicerStore.setState({ sliceTarget: { plateId: 'plate-1', inputRevision: 1 },
      plateResults: { 'plate-1': { target: { plateId: 'plate-1', inputRevision: 1 }, receipt, warnings: [] } } });
  });
  afterEach(() => {
    vi.useRealTimers();
    roots.forEach((root) => root.unmount());
    roots = [];
    document.body.innerHTML = '';
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null, resultExported: false });
  });

  it('uses upload-only for Send and keeps target selection independent and ephemeral', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform, runtime } = makePlatform(transport);
    const { container, root } = await render(platform, 'send');
    roots.push(root);
    expect(container.textContent).not.toContain('secret-key-must-not-render');
    await click(container, 'send-submit');
    expect(transport.requests.map((request) => request.url)).toEqual(['http://printer.local:7125/server/files/upload']);
    expect(runtime.exportGcodePlate).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="send-operation-message"]')?.textContent).toContain('uploaded');
    expect((platform.printers.configuration.save as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('shows the printer name after choosing an id and sends with that complete configuration', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const { container, root } = await render(platform, 'send', null);
    roots.push(root);

    await choosePrinter(container, 'p2');

    const trigger = container.querySelector('[data-testid="send-printer-select"]') as HTMLElement;
    expect(trigger.textContent).toContain('Office');
    expect(trigger.textContent).not.toContain('p2');
    expect(container.querySelector('[data-testid="send-disabled-reason"]')).toBeNull();

    await click(container, 'send-submit');
    expect(transport.requests[0]).toMatchObject({
      url: 'http://office.local:7125/server/files/upload',
      headers: { 'X-Api-Key': 'another-secret' },
    });
  });

  it('uploads then starts for Send & Print and reports a start failure without retrying upload', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    transport.statuses.push(200, 500);
    const { platform } = makePlatform(transport);
    const { container, root } = await render(platform, 'send-and-print');
    roots.push(root);
    await click(container, 'send-submit');
    expect(transport.requests.map((request) => request.url)).toEqual([
      'http://printer.local:7125/server/files/upload',
      'http://printer.local:7125/printer/print/start',
    ]);
    expect(container.querySelector('[data-testid="send-operation-message"]')?.textContent).toContain('file remains on the printer');
    expect(container.querySelector('[data-testid="send-retry-start"]')).not.toBeNull();
  });

  it('shows upload progress and cancels the in-flight upload', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    transport.pending = true;
    const { platform } = makePlatform(transport);
    const { container, root } = await render(platform, 'send');
    roots.push(root);
    await act(async () => { (container.querySelector('[data-testid="send-submit"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="send-progress-status"]')?.textContent).toContain('50%');
    await click(container, 'send-close');
    expect(container.querySelector('[data-testid="send-operation-message"]')?.textContent).toContain('cancelled');
    expect(transport.requests[0].signal?.aborted).toBe(true);
  });

  it('keeps the switch option in the action row and disables editable controls while uploading', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    transport.pending = true;
    const { platform } = makePlatform(transport);
    const { container, root } = await render(platform, 'send', 'p1');
    roots.push(root);

    const option = container.querySelector('[data-testid="send-switch-to-device-option"]') as HTMLElement;
    expect(option.closest('[data-testid="send-actions"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="send-printer-select"]') as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { (container.querySelector('[data-testid="send-submit"]') as HTMLElement).click(); });
    expect((container.querySelector('[data-testid="send-printer-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="send-switch-to-device"]')?.getAttribute('aria-disabled')).toBe('true');
    expect((container.querySelector('[data-testid="send-close"]') as HTMLButtonElement).disabled).toBe(false);
    await click(container, 'send-close');
  });

  it('defaults the switch option on, persists changes, and restores them on reopen', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform, preferences } = makePlatform(transport);
    const { container, root } = await render(platform, 'send', 'p1');
    roots.push(root);

    const option = container.querySelector('[data-testid="send-switch-to-device"]') as HTMLElement;
    expect(option.getAttribute('aria-checked')).toBe('true');
    await click(container, 'send-switch-to-device');
    expect(option.getAttribute('aria-checked')).toBe('false');
    await act(async () => { await Promise.resolve(); });
    expect((platform.preferences.save as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      ui: expect.objectContaining({ switchToDeviceAfterSend: false }),
    }));

    await act(async () => {
      root.render(<PlatformProvider value={platform}><SendGcodeDialog open={false} action="send" onClose={() => undefined} /></PlatformProvider>);
      root.render(<PlatformProvider value={platform}><SendGcodeDialog open action="send" onClose={() => undefined} /></PlatformProvider>);
    });
    expect((container.querySelector('[data-testid="send-switch-to-device"]') as HTMLElement).getAttribute('aria-checked')).toBe('false');
    expect(preferences().ui.switchToDeviceAfterSend).toBe(false);
  });

  it('keeps the default and session behavior when preference storage is unavailable', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    platform.preferences.load = vi.fn(async () => { throw new Error('storage unavailable'); });
    platform.preferences.save = vi.fn(async () => { throw new Error('storage unavailable'); });
    const { container, root } = await render(platform, 'send', 'p1');
    roots.push(root);

    const option = container.querySelector('[data-testid="send-switch-to-device"]') as HTMLElement;
    expect(option.getAttribute('aria-checked')).toBe('true');
    await click(container, 'send-switch-to-device');
    expect(option.getAttribute('aria-checked')).toBe('false');
  });

  it('disables editable controls after a successful send while keeping Close available', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const { container, root } = await render(platform, 'send', 'p1');
    roots.push(root);

    await click(container, 'send-submit');
    expect((container.querySelector('[data-testid="send-printer-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="send-switch-to-device"]')?.getAttribute('aria-disabled')).toBe('true');
    expect((container.querySelector('[data-testid="send-close"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not auto-select a printer when the previous selection no longer exists', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport, { version: 1, printers: [printers[1]] });
    const { container, root } = await render(platform, 'send', 'p1');
    roots.push(root);
    expect(container.querySelector('[data-testid="send-disabled-reason"]')?.textContent).toContain('Select a printer');
    expect(container.querySelector('[data-testid="send-submit"]')).toHaveProperty('disabled', true);
  });

  it('allows sending without an API key and leaves the authentication header absent', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport, { version: 1, printers: [{ ...printers[0], apiKey: '' }] });
    const { container, root } = await render(platform, 'send');
    roots.push(root);
    expect(container.textContent).not.toContain('secret-key-must-not-render');
    expect(container.querySelector('[data-testid="send-disabled-reason"]')).toBeNull();
    await click(container, 'send-submit');
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].headers).toEqual({});
  });

  it('allows keyless Send & Print and omits authentication from both requests', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport, { version: 1, printers: [{ ...printers[0], apiKey: '' }] });
    const { container, root } = await render(platform, 'send-and-print');
    roots.push(root);
    await click(container, 'send-submit');
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.map((request) => request.headers)).toEqual([{}, { 'Content-Type': 'application/json' }]);
    expect(container.querySelector('[data-testid="send-operation-message"]')?.textContent).toContain('uploaded and print started');
  });

  it.each(['send', 'send-and-print'] as const)('counts down for five seconds after successful %s and then closes the dialog', async (action) => {
    vi.useFakeTimers();
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const onClose = vi.fn();
    const { container, root } = await render(platform, action, 'p1', onClose);
    roots.push(root);

    await click(container, 'send-submit');
    expect(container.querySelector('[data-testid="send-auto-close-countdown"]')?.textContent).toContain('5 seconds');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(container.querySelector('[data-testid="send-auto-close-countdown"]')?.textContent).toContain('1 second');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="send-auto-close-countdown"]')).toBeNull();
  });

  it('closes and switches to Device after five seconds when selected', async () => {
    vi.useFakeTimers();
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const onClose = vi.fn();
    const onNavigateToDevice = vi.fn();
    const { container, root } = await render(platform, 'send', 'p1', onClose, onNavigateToDevice);
    roots.push(root);

    expect((container.querySelector('[data-testid="send-switch-to-device"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    await click(container, 'send-submit');
    expect(container.querySelector('[data-testid="send-auto-close-countdown"]')?.textContent).toContain('Closing and switching to Device in 5 seconds');

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onNavigateToDevice).toHaveBeenCalledOnce();
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onNavigateToDevice.mock.invocationCallOrder[0]);
  });

  it('does not switch to Device when a selected success is manually closed', async () => {
    vi.useFakeTimers();
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const onClose = vi.fn();
    const onNavigateToDevice = vi.fn();
    const { container, root } = await render(platform, 'send', 'p1', onClose, onNavigateToDevice);
    roots.push(root);

    await click(container, 'send-submit');
    await click(container, 'send-close');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onNavigateToDevice).not.toHaveBeenCalled();
  });

  it('does not switch to Device after a start failure', async () => {
    vi.useFakeTimers();
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    transport.statuses.push(200, 500);
    const { platform } = makePlatform(transport);
    const onNavigateToDevice = vi.fn();
    const { container, root } = await render(platform, 'send-and-print', 'p1', () => undefined, onNavigateToDevice);
    roots.push(root);

    await click(container, 'send-submit');
    expect(container.querySelector('[data-testid="send-retry-start"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onNavigateToDevice).not.toHaveBeenCalled();
  });

  it('clears the success close timer when manually closed or unmounted', async () => {
    vi.useFakeTimers();
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const onClose = vi.fn();
    const { container, root } = await render(platform, 'send', 'p1', onClose);
    roots.push(root);

    await click(container, 'send-submit');
    await click(container, 'send-close');
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onClose).toHaveBeenCalledOnce();

    const secondClose = vi.fn();
    const second = await render(platform, 'send', 'p1', secondClose);
    await click(second.container, 'send-submit');
    second.root.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(secondClose).not.toHaveBeenCalled();
  });

  it('clears the timer when the dialog is reopened', async () => {
    vi.useFakeTimers();
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const onClose = vi.fn();
    const { container, root } = await render(platform, 'send', 'p1', onClose);
    roots.push(root);

    await click(container, 'send-submit');
    await act(async () => {
      root.render(<PlatformProvider value={platform}><SendGcodeDialog open={false} action="send" onClose={onClose} /></PlatformProvider>);
    });
    await act(async () => {
      root.render(<PlatformProvider value={platform}><SendGcodeDialog open action="send" onClose={onClose} /></PlatformProvider>);
    });
    expect((container.querySelector('[data-testid="send-switch-to-device"]') as HTMLElement).getAttribute('aria-checked')).toBe('true');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onClose).not.toHaveBeenCalled();
  });
});
