import { describe, expect, it, vi } from 'vitest';
import { createBrowserScreenColorSampler, createScreenColorSession, normalizeScreenColorResult, NO_SCREEN_COLOR, type ScreenColorResult } from './screenColor';

const signal = () => new AbortController().signal;
const picked = { status: 'picked', color: '#12ABEF' } as const;

describe('screen color sessions', () => {
  it('hides sampling when neither source is available', () => {
    expect(createScreenColorSession(NO_SCREEN_COLOR)).toBeNull();
  });
  it('prefers native and only falls back after failure, remembering it for this opening', async () => {
    const native = { pick: vi.fn(async (): Promise<ScreenColorResult> => ({ status: 'failed' })) };
    const browser = { pick: vi.fn(async () => picked) };
    const session = createScreenColorSession({ native, browser })!;
    expect(await session.pick(signal())).toEqual(picked);
    expect(await session.pick(signal())).toEqual(picked);
    expect(native.pick).toHaveBeenCalledTimes(1);
    expect(browser.pick).toHaveBeenCalledTimes(2);
    expect(await createScreenColorSession({ native, browser })!.pick(signal())).toEqual(picked);
    expect(native.pick).toHaveBeenCalledTimes(2);
  });
  it('does not fall back or remember a user cancellation', async () => {
    const native = { pick: vi.fn(async (): Promise<ScreenColorResult> => ({ status: 'cancelled' })) };
    const browser = { pick: vi.fn(async () => picked) };
    const session = createScreenColorSession({ native, browser })!;
    expect(await session.pick(signal())).toEqual({ status: 'cancelled' });
    expect(await session.pick(signal())).toEqual({ status: 'cancelled' });
    expect(native.pick).toHaveBeenCalledTimes(2);
    expect(browser.pick).not.toHaveBeenCalled();
  });
  it('falls back after thrown native errors and retains that choice after browser failures', async () => {
    const native = { pick: vi.fn(async () => { throw new Error('portal unavailable'); }) };
    const browser = { pick: vi.fn(async () => { throw new Error('NotAllowedError'); }) };
    const session = createScreenColorSession({ native, browser })!;
    expect(await session.pick(signal())).toEqual({ status: 'failed' });
    expect(await session.pick(signal())).toEqual({ status: 'failed' });
    expect(native.pick).toHaveBeenCalledTimes(1);
    expect(browser.pick).toHaveBeenCalledTimes(2);
  });
  it('aborts without falling back and rejects concurrent operations', async () => {
    let resolve!: (result: ScreenColorResult) => void;
    const native = { pick: vi.fn(() => new Promise<ScreenColorResult>(done => { resolve = done; })) };
    const browser = { pick: vi.fn(async () => picked) };
    const session = createScreenColorSession({ native, browser })!;
    const request = new AbortController();
    const pending = session.pick(request.signal);
    expect(await session.pick(signal())).toEqual({ status: 'failed' });
    expect(native.pick).toHaveBeenCalledTimes(1);
    request.abort(); resolve({ status: 'failed' });
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(browser.pick).not.toHaveBeenCalled();
    expect(await session.pick(request.signal)).toEqual({ status: 'cancelled' });
  });
  it('treats malformed native results as failure and canonicalizes valid sRGB', async () => {
    expect(normalizeScreenColorResult({ status: 'picked', color: '#abc' })).toEqual({ status: 'failed' });
    expect(normalizeScreenColorResult({ status: 'picked', color: '#11223380' })).toEqual({ status: 'failed' });
    const native = { pick: vi.fn(async () => ({ status: 'picked', color: 'bad' }) as ScreenColorResult) };
    const browser = { pick: vi.fn(async () => ({ status: 'picked' as const, color: '#abcdef' })) };
    expect(await createScreenColorSession({ native, browser })!.pick(signal())).toEqual({ status: 'picked', color: '#ABCDEF' });
  });
});

describe('browser eyedropper', () => {
  it('requires the API and a secure context', () => {
    expect(createBrowserScreenColorSampler({ isSecureContext: true })).toBeNull();
    expect(createBrowserScreenColorSampler({ isSecureContext: false, EyeDropper: class { async open() { return { sRGBHex: '#112233' }; } } })).toBeNull();
  });
  it('opens synchronously in the click call chain and passes the abort signal', async () => {
    const open = vi.fn(async () => ({ sRGBHex: '#12abef' }));
    const sampler = createBrowserScreenColorSampler({ isSecureContext: true, EyeDropper: class { open = open; } })!;
    const request = signal();
    const promise = createScreenColorSession({ native: null, browser: sampler })!.pick(request);
    expect(open).toHaveBeenCalledWith({ signal: request });
    expect(await promise).toEqual(picked);
  });
  it('distinguishes cancellation from operation errors', async () => {
    const open = vi.fn().mockRejectedValueOnce(new DOMException('cancel', 'AbortError')).mockRejectedValueOnce(new DOMException('expired', 'NotAllowedError'));
    const sampler = createBrowserScreenColorSampler({ isSecureContext: true, EyeDropper: class { open = open; } })!;
    expect(await sampler.pick(signal())).toEqual({ status: 'cancelled' });
    expect(await sampler.pick(signal())).toEqual({ status: 'failed' });
    const request = new AbortController(); request.abort();
    expect(await sampler.pick(request.signal)).toEqual({ status: 'cancelled' });
    expect(open).toHaveBeenCalledTimes(2);
  });
});
