import { expect, it, vi } from 'vitest';
import type { BambuBridge } from '../../../shared/bambu';
import { bambuFiles } from './bambuFiles';
import type * as D from '@orca/platform-contract';

it('forwards metadata with a unique cancellation token and discards an aborted late response', async () => {
  let finish!: (value: unknown) => void;
  const control = vi.fn((method: string) => method === 'storage.cancel' ? Promise.resolve({ ok: true, value: null }) : new Promise(resolve => { finish = resolve; }));
  const files = bambuFiles({ control } as unknown as BambuBridge), abort = new AbortController();
  const target = { printerId: 'p', routeId: 'r' } as D.PrinterTarget;
  const pending = files.listStorages(target, { signal: abort.signal });
  const readId = (control.mock.calls[0] as unknown as [string, { readId: string }])[1].readId;
  abort.abort(); expect(control).toHaveBeenLastCalledWith('storage.cancel', { readId });
  finish({ ok: true, value: [] });
  expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(await files.listStorages(target, { signal: abort.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(control).toHaveBeenCalledTimes(2);
});
