// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
vi.mock('../workspace/actions/sliceActions', () => ({ exportGcode: vi.fn(), sliceModel: vi.fn() }));
vi.mock('../send/SendGcodeDialog', () => ({
  SendGcodeDialog: ({ onNavigateToDevice }: { onNavigateToDevice?: () => void }) => (
    <button type="button" data-testid="mock-send-navigate" onClick={onNavigateToDevice}>Trigger send navigation</button>
  ),
}));
import { Toolbar } from './Toolbar';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

function makePlatform() {
  return {
    platform: {
      printers: {
        configuration: {
          load: vi.fn(async () => ({
            version: 1 as const,
            printers: [{
              id: 'p1', displayName: 'Workshop', driverId: 'moonraker',
              consoleUrl: 'http://console.local/', apiBaseUrl: 'http://printer.local:7125/', apiKey: '',
            }],
          })),
          save: vi.fn(async () => undefined),
        },
        transport: {
          request: vi.fn(async () => ({ status: 200, json: async () => ({ result: { item: { path: 'gcodes/output.gcode' } } }) })),
        },
      },
      runtime: { exportGcode: vi.fn(async () => ({ ok: true, path: '/tmp/output.gcode', bytes: new Uint8Array([1, 2, 3]) })) },
    } as unknown as PlatformCapabilities,
  };
}

describe('Toolbar send navigation', () => {
  let root: Root | undefined;

  afterEach(() => {
    vi.useRealTimers();
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
    useSettingsStore.setState({ modelLoaded: false });
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null, resultExported: false });
  });

  it('passes the app-level Device callback through to the send dialog', async () => {
    useSlicerStore.setState({ status: 'done' });
    const { platform } = makePlatform();
    const navigateToDevice = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab="prepare" onNavigateToDevice={navigateToDevice} /></PlatformProvider>);
    });
    await act(async () => { (container.querySelector('[data-testid="mock-send-navigate"]') as HTMLElement).click(); });

    expect(navigateToDevice).toHaveBeenCalledOnce();
  });

  it.each(['home', 'device'] as const)('hides slice/export/send actions on %s', async (activeTab) => {
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab={activeTab} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="toolbar-actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-export"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send-and-print"]')).toBeNull();
  });

  it.each(['prepare', 'preview'] as const)('shows slice/export/send actions on %s', async (activeTab) => {
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab={activeTab} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="toolbar-actions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-export"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-send"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-send-and-print"]')).not.toBeNull();
  });

  it('disables Slice after a valid result while keeping export and send available', async () => {
    useSettingsStore.setState({ modelLoaded: true });
    useSlicerStore.setState({ status: 'done' });
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab="prepare" /></PlatformProvider>);
    });

    expect((container.querySelector('[data-testid="btn-slice"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="btn-export"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="btn-send"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="btn-send-and-print"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
