// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { PrinterConfigurationDocument } from '@orca/printer-control';
import { DevicePanel } from './DevicePanel';

describe('DevicePanel configuration loading', () => {
  it('does not expose an empty list or allow edits before the repository responds', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let resolveLoad!: (document: PrinterConfigurationDocument) => void;
    const load = vi.fn(() => new Promise<PrinterConfigurationDocument>((resolve) => { resolveLoad = resolve; }));
    const platform = {
      preferences: { load: vi.fn(async () => ({ ui: {} })) },
      printers: { configuration: { load, save: vi.fn() } },
    } as unknown as PlatformCapabilities;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>);
      });
      expect(load).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-testid="device-loading-list"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="device-empty-list"]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="device-add-printer"]')?.disabled).toBe(true);

      await act(async () => { resolveLoad({ version: 1, printers: [] }); });
      expect(container.querySelector('[data-testid="device-loading-list"]')).toBeNull();
      expect(container.querySelector('[data-testid="device-empty-list"]')).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="device-add-printer"]')?.disabled).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
