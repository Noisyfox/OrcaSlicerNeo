// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { StatusBar } from '../../layout/StatusBar';
import { useSliceResult } from './useSliceResult';

function PreviewProbe() {
  useSliceResult();
  return null;
}

describe('useSliceResult', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    useSlicerStore.setState({
      status: 'idle', progress: 0, layers: 0, error: null, resultExported: false, layer: 0, maxLayer: 0,
    });
  });

  it('surfaces a failed preview extraction through the visible slice error state', async () => {
    const runtime = {
      getSliceResult: vi.fn(async () => ({ ok: false, error: 'nozzle context is unavailable' })),
    };
    const platform = {
      runtime,
      chrome: { kind: 'desktop' },
    } as unknown as PlatformCapabilities;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useSlicerStore.setState({ status: 'done' });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <PlatformProvider value={platform}>
          <PreviewProbe />
          <StatusBar />
        </PlatformProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(useSlicerStore.getState()).toMatchObject({
        status: 'error', error: 'preview: nozzle context is unavailable',
      });
    });

    expect(container.querySelector('[data-testid="slicer-status"]')?.textContent).toBe('Error');
    expect(container.querySelector('[data-testid="slicer-error"]')?.textContent)
      .toBe('preview: nozzle context is unavailable');
    expect(consoleError).toHaveBeenCalled();
  });
});
