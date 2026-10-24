// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MediaDescriptor, PrinterMedia } from '@orca/printer-control/domain';
import { MediaPlayer } from './MediaPlayer';
import { startMediaPlayback } from './playback';
vi.mock('./playback', () => ({ startMediaPlayback: vi.fn() }));
beforeEach(() => {
  vi.mocked(startMediaPlayback).mockReset().mockImplementation(({ signal }) => {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    signal?.addEventListener('abort', finish, { once: true });
    return { done, stop: vi.fn(finish), setExpiresAt: vi.fn(), play: vi.fn(async () => {}) };
  });
});
it('renews expiry without reattaching the binary stream; new delivery and unmount release playback', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const descriptor = { ref: { printerId: 'p', routeId: 'r', id: 'm' }, expiresAtMs: 10000, revision: 1,
    presentation: { kind: 'video', delivery: { transport: 'jpeg-frames', streamId: 's', mimeType: 'image/jpeg' } } } as MediaDescriptor;
  const media = { readStream: vi.fn() } as unknown as PrinterMedia;
  const root = createRoot(document.createElement('div'));
  const render = async (value: MediaDescriptor) => act(async () => { root.render(<MediaPlayer descriptor={value} media={media} onError={vi.fn()} />); });
  await render(descriptor);
  const playback = vi.mocked(startMediaPlayback).mock.results[0].value;
  await render({ ...descriptor, revision: 2, expiresAtMs: 30000 });
  expect(startMediaPlayback).toHaveBeenCalledOnce(); expect(playback.setExpiresAt).toHaveBeenLastCalledWith(30000); expect(playback.stop).not.toHaveBeenCalled();
  await render({ ...descriptor, ref: { ...descriptor.ref, id: 'new' as never } });
  expect(startMediaPlayback).toHaveBeenCalledTimes(2); expect(playback.stop).toHaveBeenCalledOnce();
  await act(async () => root.unmount()); expect(vi.mocked(startMediaPlayback).mock.results[1].value.stop).toHaveBeenCalledOnce();
});


it('does not consume or close a camera stream during StrictMode effect replay', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const descriptor = { ref: { printerId: 'p', routeId: 'r', id: 'm' }, expiresAtMs: null, revision: 1,
    presentation: { kind: 'video', delivery: { transport: 'jpeg-frames', streamId: 's', mimeType: 'image/jpeg' } } } as MediaDescriptor;
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<StrictMode><MediaPlayer descriptor={descriptor} media={{ readStream: vi.fn() }} onError={vi.fn()} /></StrictMode>));
    expect(startMediaPlayback).toHaveBeenCalledOnce();
    const playback = vi.mocked(startMediaPlayback).mock.results[0].value;
    expect(playback.stop).not.toHaveBeenCalled();
    expect(vi.mocked(startMediaPlayback).mock.calls[0][0].signal?.aborted).toBe(false);
  } finally { await act(async () => root.unmount()); }
  expect(vi.mocked(startMediaPlayback).mock.results.at(-1)!.value.stop).toHaveBeenCalledOnce();
});

it('retains a renewed remote URL after the previous real player finishes asynchronous cleanup', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const actual = await vi.importActual<typeof import('./playback')>('./playback');
  vi.mocked(startMediaPlayback).mockImplementation(options => {
    // jsdom has no media decoder; use the production lifecycle with inert
    // playback methods, while keeping real element attributes and promises.
    Object.assign(options.video, { pause: () => {}, load: () => {}, play: async () => {},
      canPlayType: () => 'probably', requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} });
    return actual.startMediaPlayback(options);
  });
  const descriptor = (url: string): MediaDescriptor => ({ ref: { printerId: 'p', routeId: 'r', id: 'm' }, expiresAtMs: null, revision: 1,
    presentation: { kind: 'video', delivery: { transport: 'progressive-http', url, mimeType: 'video/mp4', credentials: 'same-origin' }, live: true } } as MediaDescriptor);
  const element = document.createElement('div'), root = createRoot(element);
  const media = { readStream: vi.fn() } as unknown as PrinterMedia, onError = vi.fn();
  const render = async (url: string) => act(async () => root.render(<MediaPlayer descriptor={descriptor(url)} media={media} onError={onError} />));
  try {
    await render('https://agent.test/old.mp4');
    expect(element.querySelector('video')!.getAttribute('src')).toBe('https://agent.test/old.mp4');
    await render('https://agent.test/renewed.mp4');
    expect(element.querySelector('video')!.getAttribute('src')).toBe('https://agent.test/renewed.mp4');
    expect(onError).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
