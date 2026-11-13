// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { MediaDescriptor, PrinterMedia } from '@orca/platform-contract';
import { StoredVideoPlayer } from './StoredVideoPlayer';
const playback = vi.hoisted(() => ({ seek: vi.fn(), setRanges: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock('./storedPlayback', () => ({ startStoredPlayback: () => playback }));

it('seeks within the downloaded range using the shared slider keyboard controls', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const descriptor = { acceptsUserActivity: false, ref: { printerId: 'p', routeId: 'r', id: 'video' }, presentation: {
    kind: 'video', live: false, durationSeconds: 20, cachedRanges: [{ startSeconds: 0, endSeconds: 10 }],
    delivery: { transport: 'mse-fmp4', streamId: 'stream', mimeType: 'video/mp4' },
  } } as unknown as MediaDescriptor;
  try {
    await act(async () => root.render(<StoredVideoPlayer descriptor={descriptor} media={{} as PrinterMedia} onError={vi.fn()} />));
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute('aria-label')).toBe('Seek within downloaded video');
    expect(Number(slider.max)).toBeLessThan(10);
    await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(playback.seek).toHaveBeenLastCalledWith(0.1);
  } finally { await act(async () => root.unmount()); container.remove(); }
  expect(playback.stop).toHaveBeenCalledOnce();
});
