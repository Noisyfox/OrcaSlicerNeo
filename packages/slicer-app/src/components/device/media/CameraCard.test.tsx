// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { CameraCard } from './CameraCard';
vi.mock('./MediaPlayer', () => ({ MediaPlayer: ({ descriptor, onError }: { descriptor: D.MediaDescriptor; onError(message: string): void }) =>
  <button data-testid="fake-player" onClick={() => onError('Decoder failed')}>{descriptor.ref.id}:{descriptor.revision}</button> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const target = { printerId: 'p', routeId: 'r', expectedConfigurationRevision: 'c' } as D.TargetRequest;
const capability: D.CameraMediaCapability = { cameraId: 'c' as D.Id<'camera'>, liveView: { kind: 'supported', constraints: { transports: ['jpeg-frames'], profiles: [], maxConcurrentViews: 1, requestIdRetentionMs: 300000 } }, snapshot: { kind: 'unknown', reason: 'Unknown' } };
const descriptor = (id = 'm', expiresAtMs: number | null = null): D.MediaDescriptor => ({ ref: { ...target, id } as D.MediaRef, source: { kind: 'camera', cameraId: capability.cameraId }, configurationRevision: 'c', revision: 1, expiresAtMs, acceptsUserActivity: false,
  presentation: { kind: 'video', delivery: { transport: 'jpeg-frames', streamId: 's' as D.Id<'media-stream'>, mimeType: 'image/jpeg' }, profile: null, codecId: 'jpeg', live: true, seekable: false, durationSeconds: null } });
async function mount(overrides: Partial<D.PrinterMedia> = {}) {
  let count = 0;
  const open = vi.fn<D.PrinterMedia['open']>(async () => ({ ok: true as const, value: descriptor(`m${++count}`) }));
  const close = vi.fn(async () => ({ ok: true as const, value: null }));
  const media = { open, close, watch: async function* (_ref, { signal } = {}) { await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true })); }, ...overrides } as D.PrinterMedia;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const render = async (visible = true, key = 'p', cap = capability) => act(async () => { root.render(<CameraCard key={key} name="Camera" media={media} target={{ ...target, printerId: key as D.Id<'printer'> }} capability={cap} visible={visible} disabled={false} />); });
  const click = async (text: string) => act(async () => { [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!.click(); });
  await render();
  return { open, close, media, element, render, click, dispose: async () => { await act(async () => root.unmount()); element.remove(); } };
}
it('opens only on Play, releases hidden views, resumes intent and keeps explicit Stop stopped', async () => {
  const view = await mount();
  try {
    expect(view.open).not.toHaveBeenCalled(); await view.click('Play camera'); expect(view.open).toHaveBeenCalledOnce();
    expect(view.open.mock.calls[0][0]).toMatchObject({ source: { kind: 'camera', cameraId: 'c' }, target, client: { video: expect.any(Array) } });
    await view.render(false); expect(view.close).toHaveBeenCalledOnce();
    await view.render(true); expect(view.open).toHaveBeenCalledTimes(2);
    await view.click('Stop camera'); expect(view.close).toHaveBeenCalledTimes(2);
    await view.render(false); await view.render(true); expect(view.open).toHaveBeenCalledTimes(2);
  } finally { await view.dispose(); }
});

it('reports activity for an advertised resource independently of its video transport and coalesces in-flight notifications', async () => {
  const current = descriptor();
  if (current.presentation.kind !== 'video') throw new Error('Fixture');
  current.acceptsUserActivity = true;
  current.presentation.delivery = { transport: 'webrtc', negotiationId: 'negotiation' as D.Id<'negotiation'>, offerer: 'agent', iceServers: [] };
  let complete!: (result: D.Result<null>) => void;
  const interact = vi.fn<D.PrinterMedia['interact']>(() => new Promise(resolve => { complete = resolve; }));
  const view = await mount({ open: async () => ({ ok: true, value: current }), interact });
  const activity = async () => act(async () => { view.element.querySelector('[data-testid="camera-card"]')!.dispatchEvent(new Event('pointermove', { bubbles: true })); });
  try {
    await view.click('Play camera'); await activity(); await activity();
    expect(interact).toHaveBeenCalledTimes(1);
    expect(interact).toHaveBeenCalledWith(current.ref, { signal: expect.any(AbortSignal) });
    await act(async () => complete({ ok: true, value: null })); await activity();
    expect(interact).toHaveBeenCalledTimes(2);
    await act(async () => complete({ ok: false, error: { code: 'transport', message: 'Activity unavailable' } }));
    await view.click('Stop camera'); await activity();
    expect(interact).toHaveBeenCalledTimes(2);
  } finally { await view.dispose(); }
});
it('keeps user activity local when the resource does not accept notifications', async () => {
  const interact = vi.fn(async () => ({ ok: true as const, value: null }));
  const view = await mount({ interact });
  try {
    await view.click('Play camera');
    await act(async () => { view.element.querySelector('[data-testid="camera-card"]')!.dispatchEvent(new Event('pointermove', { bubbles: true })); });
    expect(interact).not.toHaveBeenCalled();
  } finally { await view.dispose(); }
});
it('retires an old activity notification when a new view opens', async () => {
  const completions: ((value: D.Result<null>) => void)[] = [];
  const interact = vi.fn<D.PrinterMedia['interact']>(() => new Promise(resolve => { completions.push(resolve); }));
  let id = 0;
  const view = await mount({ open: async () => ({ ok: true, value: { ...descriptor(`active-${++id}`), acceptsUserActivity: true } }), interact });
  const activity = async () => act(async () => { view.element.querySelector('[data-testid="camera-card"]')!.dispatchEvent(new Event('pointermove', { bubbles: true })); });
  try {
    await view.click('Play camera'); await activity();
    await view.click('Stop camera'); await view.click('Play camera'); await activity();
    expect(interact).toHaveBeenCalledTimes(2);
    expect(interact.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => completions[0]({ ok: true, value: null })); await activity();
    expect(interact).toHaveBeenCalledTimes(2);
    await act(async () => completions[1]({ ok: true, value: null })); await activity();
    expect(interact).toHaveBeenCalledTimes(3);
  } finally { await view.dispose(); }
});
it('closes a late open after Stop before another viewer can open', async () => {
  let resolve!: (value: D.Result<D.MediaDescriptor>) => void;
  const open = vi.fn(() => new Promise<D.Result<D.MediaDescriptor>>(done => { resolve = done; }));
  const view = await mount({ open });
  try {
    await view.click('Play camera'); await view.click('Stop camera'); await view.click('Play camera');
    expect(open).toHaveBeenCalledOnce();
    await act(async () => resolve({ ok: true, value: descriptor('late') }));
    expect(view.close).toHaveBeenCalledWith(expect.objectContaining({ id: 'late' })); expect(open).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ ok: true, value: descriptor('next') }));
  } finally { await view.dispose(); }
});
it('device change clears viewing intent and document hiding releases the resource', async () => {
  let state = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state as DocumentVisibilityState);
  const view = await mount();
  try {
    await view.click('Play camera');
    await act(async () => { state = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    expect(view.close).toHaveBeenCalledOnce();
    await act(async () => { state = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    expect(view.open).toHaveBeenCalledTimes(2);
    await view.render(true, 'new-device'); expect(view.close).toHaveBeenCalledTimes(2); expect(view.open).toHaveBeenCalledTimes(2);
  } finally { await view.dispose(); }
});
it('renewal updates the same resource, then a playback failure requires explicit Retry', async () => {
  vi.useFakeTimers();
  const original = descriptor('lease', Date.now() + 10000);
  const renew = vi.fn(async () => ({ ok: true as const, value: { ...original, revision: 2, expiresAtMs: Date.now() + 300000 } }));
  const view = await mount({ open: vi.fn(async () => ({ ok: true as const, value: original })), renew });
  try {
    await view.click('Play camera'); await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(renew).toHaveBeenCalledOnce(); expect(view.element.textContent).toContain('lease:2'); expect(view.close).not.toHaveBeenCalled();
    await act(async () => view.element.querySelector<HTMLElement>('[data-testid="fake-player"]')!.click());
    expect(view.close).toHaveBeenCalledOnce(); expect(view.element.textContent).toContain('Decoder failed');
    await act(async () => vi.advanceTimersByTimeAsync(60000)); await view.render(false); await view.render(true); expect(view.media.open).toHaveBeenCalledOnce();
    await view.click('Retry camera'); expect(view.media.open).toHaveBeenCalledTimes(2);
  } finally { await view.dispose(); }
});
it('unknown or disabled protocol does not allocate a view', async () => {
  const view = await mount();
  try {
    await view.render(true, 'p', { ...capability, liveView: { kind: 'unknown', reason: 'Not reported' } });
    expect(view.element.textContent).toContain('Not reported'); expect(view.element.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    await view.render(true, 'p', { ...capability, liveView: { kind: 'unsupported', layer: 'device', reason: 'Camera disabled' } });
    expect(view.element.textContent).toContain('Camera disabled'); expect(view.media.open).not.toHaveBeenCalled();
  } finally { await view.dispose(); }
});
