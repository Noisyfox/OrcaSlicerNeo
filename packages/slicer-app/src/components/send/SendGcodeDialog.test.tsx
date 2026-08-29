// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { PrinterConfiguration, PrinterTransport, PrinterTransportRequest, PrinterTransportResponse } from '@orca/printer-control';
import { SendGcodeDialog } from './SendGcodeDialog';
import { useSlicerStore } from '../../stores/useSlicerStore';

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

function makePlatform(transport: FixtureTransport, documentValue = { version: 1 as const, printers }) {
  const runtime = { exportGcode: vi.fn(async () => ({ ok: true, path: '/tmp/output.gcode', bytes: new Uint8Array([1, 2, 3]) })) };
  return {
    platform: {
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
  };
}

async function render(platform: PlatformCapabilities, action: 'send' | 'send-and-print', initialSelection: string | null = 'p1') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PlatformProvider value={platform}><SendGcodeDialog open action={action} initialSelection={initialSelection} onClose={() => undefined} /></PlatformProvider>);
  });
  return { container, root };
}

async function click(container: HTMLElement, testId: string) {
  await act(async () => { (container.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click(); });
}

describe('SendGcodeDialog', () => {
  let roots: Root[] = [];
  afterEach(() => {
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
    expect(runtime.exportGcode).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="send-operation-message"]')?.textContent).toContain('uploaded');
    expect((platform.printers.configuration.save as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('shows the printer name for an id selection and sends with that complete configuration', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport);
    const { container, root } = await render(platform, 'send', 'p2');
    roots.push(root);

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

  it('does not auto-select a printer when the previous selection no longer exists', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport, { version: 1, printers: [printers[1]] });
    const { container, root } = await render(platform, 'send', 'p1');
    roots.push(root);
    expect(container.querySelector('[data-testid="send-disabled-reason"]')?.textContent).toContain('Select a printer');
    expect(container.querySelector('[data-testid="send-submit"]')).toHaveProperty('disabled', true);
  });

  it('disables sending and uses a generic message when the API key is missing', async () => {
    useSlicerStore.setState({ status: 'done' });
    const transport = new FixtureTransport();
    const { platform } = makePlatform(transport, { version: 1, printers: [{ ...printers[0], apiKey: '' }] });
    const { container, root } = await render(platform, 'send');
    roots.push(root);
    expect(container.querySelector('[data-testid="send-disabled-reason"]')?.textContent).toContain('missing required');
    expect(container.textContent).not.toContain('secret-key-must-not-render');
    expect(transport.requests).toHaveLength(0);
  });
});
