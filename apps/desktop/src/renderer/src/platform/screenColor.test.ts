import { expect, it, vi } from 'vitest';
import { createElectronScreenColorSources } from './screenColor';

it('uses the startup loading result without probing native support on click', () => {
  const host = { available: vi.fn(), pick: vi.fn(), cancel: vi.fn() };
  expect(createElectronScreenColorSources(host, false).native).toBeNull();
  expect(createElectronScreenColorSources(host, true).native).not.toBeNull();
  expect(host.available).not.toHaveBeenCalled();
});

it('sends bounded opaque request ids and cancels exactly the outstanding operation', async () => {
  let resolve!: (value: { status: 'picked'; color: string }) => void;
  const host = { available: vi.fn(), pick: vi.fn((_id: string) => new Promise<{ status: 'picked'; color: string }>(done => { resolve = done; })), cancel: vi.fn(async () => {}) };
  const native = createElectronScreenColorSources(host, true).native!;
  const controller = new AbortController();
  const pending = native.pick(controller.signal);
  const id = host.pick.mock.calls[0][0];
  expect(id).toMatch(/^screen-color-[\da-f-]+$/);
  controller.abort();
  expect(host.cancel).toHaveBeenCalledWith(id);
  resolve({ status: 'picked', color: '#abcdef' });
  expect(await pending).toEqual({ status: 'cancelled' });
  expect(await native.pick(controller.signal)).toEqual({ status: 'cancelled' });
  expect(host.pick).toHaveBeenCalledOnce();
});
