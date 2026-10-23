// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { Result, SavedPrinter } from '@orca/printer-control/domain';
import { DevicePanel } from './DevicePanel';

describe('DevicePanel configuration loading', () => {
  it('does not expose an empty list or allow edits before the repository responds', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let resolveLoad!: (document: Result<readonly SavedPrinter[]>) => void;
    const load = vi.fn(() => new Promise<Result<readonly SavedPrinter[]>>((resolve) => { resolveLoad = resolve; }));
    const platform = {
      preferences: { load: vi.fn(async () => ({ ui: {} })) },
      printers: { service: { listProviders: async () => ({ ok: true, value: [] }), listSaved: load, onSavedChanged: () => () => {} } },
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

      await act(async () => { resolveLoad({ ok: true, value: [] }); });
      expect(container.querySelector('[data-testid="device-loading-list"]')).toBeNull();
      expect(container.querySelector('[data-testid="device-empty-list"]')).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="device-add-printer"]')?.disabled).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
