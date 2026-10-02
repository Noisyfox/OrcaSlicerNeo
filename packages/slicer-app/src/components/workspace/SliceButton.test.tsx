// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
vi.mock('./actions/sliceActions', () => ({ exportGcode: vi.fn(), sliceModel: vi.fn(), cancelSlice: vi.fn(async () => true) }));
import { cancelSlice, exportGcode, sliceModel } from './actions/sliceActions';
vi.mock('../send/SendGcodeDialog', () => ({
  SendGcodeDialog: ({ onNavigateToDevice }: { onNavigateToDevice?: () => void }) => (
    <button type="button" data-testid="mock-send-navigate" onClick={onNavigateToDevice}>Trigger send navigation</button>
  ),
}));
import { SliceButton } from './SliceButton';

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
      runtime: {
        exportGcode: vi.fn(async () => ({ ok: true, path: '/tmp/output.gcode', bytes: new Uint8Array([1, 2, 3]) })),
        getRuntimeExecutionState: vi.fn(() => ({ threaded: true, sliceActive: false, serialSliceActive: false, serialTerminalEpoch: '0' })),
      },
    } as unknown as PlatformCapabilities,
  };
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('SliceButton send navigation', () => {
  let root: Root | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
    useSettingsStore.setState({ modelLoaded: false });
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null, resultExported: false });
    useHistoryNavigationStore.getState().reset();
    useHistoryRestoreStore.getState().reset();
  });

  it('passes the app-level Device callback through to the send dialog', async () => {
    useSlicerStore.setState({ status: 'done' });
    const { platform } = makePlatform();
    const navigateToDevice = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><SliceButton activeTab="prepare" onNavigateToDevice={navigateToDevice} /></PlatformProvider>);
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
      root?.render(<PlatformProvider value={platform}><SliceButton activeTab={activeTab} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="toolbar-actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-export"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send-and-print"]')).toBeNull();
  });

  it.each(['prepare', 'preview'] as const)('shows one Slice action and an output selector on %s', async (activeTab) => {
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><SliceButton activeTab={activeTab} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="toolbar-actions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="output-mode-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-export"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send"]')).toBeNull();
  });

  async function renderButton() {
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><SliceButton activeTab="prepare" /></PlatformProvider>); });
    return container;
  }

  it('executes Slice before completion and Export afterwards', async () => {
    useSettingsStore.setState({ modelLoaded: true });
    const container = await renderButton();
    await act(async () => { (container.querySelector('[data-testid="btn-slice"]') as HTMLElement).click(); });
    expect(sliceModel).toHaveBeenCalledOnce();
    await act(async () => { useSlicerStore.setState({ status: 'done' }); });
    expect(container.querySelector('[data-testid="btn-slice"]')).toBeNull();
    await act(async () => { (container.querySelector('[data-testid="btn-export"]') as HTMLElement).click(); });
    expect(exportGcode).toHaveBeenCalledOnce();
  });

  it.each([['Send', 'send'], ['Send & Print', 'send-and-print']] as const)('selects %s without executing it', async (label, mode) => {
    useSlicerStore.setState({ status: 'done' });
    const container = await renderButton();
    await act(async () => { (container.querySelector('[data-testid="output-mode-select"]') as HTMLElement).click(); });
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent?.includes(label));
    expect(option).toBeDefined();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(container.querySelector(`[data-testid="btn-${mode}"]`)?.textContent).toBe(label);
    expect(exportGcode).not.toHaveBeenCalled();
    expect(sliceModel).not.toHaveBeenCalled();
  });

  it('shows live progress and requests cancellation once until terminal completion', async () => {
    useSlicerStore.setState({ status: 'slicing', progress: 45 });
    const container = await renderButton();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('45');
    expect(container.textContent).toContain('Slicing');
    expect(container.querySelector('[data-testid="output-mode-select"]')).toBeNull();
    const cancel = container.querySelector('[data-testid="btn-cancel-slice"]') as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    expect(cancelSlice).toHaveBeenCalledOnce();
    expect(cancel.disabled).toBe(true);
    expect(container.textContent).toContain('Cancelling');
    await act(async () => { useSlicerStore.setState({ status: 'idle' }); });
    expect(container.querySelector('[data-testid="btn-cancel-slice"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).not.toBeNull();
  });

  it('allows another cancellation attempt when runtime rejects the request', async () => {
    vi.mocked(cancelSlice).mockResolvedValueOnce(false);
    useSlicerStore.setState({ status: 'slicing', progress: 12 });
    const container = await renderButton();
    const cancel = container.querySelector('[data-testid="btn-cancel-slice"]') as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    expect(cancel.disabled).toBe(false);
    expect(container.textContent).toContain('Slicing');
  });
});
