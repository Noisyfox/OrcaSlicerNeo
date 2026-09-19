// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { MemoryIndicator } from './MemoryIndicator';

describe('MemoryIndicator', () => {
  let root: Root | undefined;
  const performanceMemory = Object.getOwnPropertyDescriptor(performance, 'memory');

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
    if (performanceMemory) Object.defineProperty(performance, 'memory', performanceMemory);
    else delete (performance as Performance & { memory?: unknown }).memory;
  });

  it('shows the host total and refreshes details when its popup opens', async () => {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: { usedJSHeapSize: 2 * 1024 * 1024 },
    });
    const sample = vi.fn(async () => ({
      totalBytes: 8 * 1024 * 1024,
      entries: [{ id: 'electron:GPU', label: 'GPU process', bytes: 3 * 1024 * 1024 }],
    }));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <PlatformProvider value={{
          memory: { sample },
          runtime: { async getRuntimeMemory() { return { jsHeapUsedBytes: 1024 * 1024, wasmLinearMemoryBytes: 4 * 1024 * 1024 }; } },
        } as unknown as PlatformCapabilities}>
          <MemoryIndicator />
        </PlatformProvider>,
      );
      await Promise.resolve();
    });
    const trigger = container.querySelector('[data-testid="memory-indicator"]') as HTMLButtonElement;
    expect(trigger.textContent).toBe('Memory: 8 MiB');
    expect(trigger.className).toContain('hover:bg-muted');
    expect(trigger.className).toContain('hover:text-foreground');

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    expect(sample).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[data-testid="memory-indicator-popup"]')?.textContent)
      .toContain('Platform memory');
    expect(document.body.textContent).toContain('Shared runtime diagnostics');
    expect(document.body.textContent).toContain('Included in total');
  });
});
