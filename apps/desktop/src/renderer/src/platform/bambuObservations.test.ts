import { expect, it, vi } from 'vitest';
import type { BambuBridge, BambuChange } from '../../../shared/bambu';
import { bambuObservations } from './bambuObservations';
const target = { printerId: 'bambu:a' as never, routeId: 'bambu:a:agent' as never };
it('opens before reading, wakes on invalidation, and releases only its token on abort', async () => {
  const listeners = new Set<(change: BambuChange) => void>();
  const control = vi.fn(async (method: string) => ({ ok: true, value: method === 'read' ? { target, configurationRevision: 'r1', values: { status: { kind: 'unknown', reason: 'not-reported' } } } : null }));
  const bridge = { control, onChanged: (listener: (change: BambuChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as BambuBridge;
  const abort = new AbortController(); const stream = bambuObservations(bridge).watch({ target, topics: ['status'] }, { signal: abort.signal })[Symbol.asyncIterator]();
  const first = await stream.next(); expect(first.value).toMatchObject({ type: 'snapshot', snapshot: { target } });
  expect(control.mock.calls.map(call => call[0])).toEqual(['observe', 'read']);
  const pending = stream.next(); listeners.forEach(listener => listener('control')); expect((await pending).done).toBe(false);
  const ended = stream.next(); abort.abort(); expect((await ended).done).toBe(true);
  expect(control.mock.calls.at(-1)).toEqual(['release', (control.mock.calls[0] as unknown[])[1] && { token: ((control.mock.calls[0] as unknown[])[1] as { token: string }).token }]);
  expect(listeners.size).toBe(0);
});
it('cancels a read result without issuing physical operation cancellation', async () => {
  const abort = new AbortController(); const control = vi.fn(async () => { abort.abort(); return { ok: true, value: {} }; });
  const bridge = { control } as unknown as BambuBridge;
  expect(await bambuObservations(bridge).read({ target, topics: ['status'], source: 'device' }, { signal: abort.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(control).toHaveBeenCalledOnce();
});
