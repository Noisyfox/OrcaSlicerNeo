import { expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import type { BambuBridge, BambuChange } from '../../../shared/bambu';
import { bambuOperations } from './bambuControls';

it.each(['accepted', 'acknowledged'] as const)('ends accepted streams but keeps %s evidence distinct from completion', async kind => {
  const listeners = new Set<(change: BambuChange) => void>();
  const ref = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'>, id: 'op' as D.Id<'operation'> };
  let operation: D.CommandOperation = { kind: 'command', commandType: 'motion.jog', ref, requestId: 'request' as D.Id<'request'>,
    configurationRevision: 'r1', revision: 1, updatedAtMs: 0, phase: { kind } };
  const control = vi.fn(async () => ({ ok: true, value: { kind: 'found', operation } }));
  const bridge = { control, onChanged: (listener: (change: BambuChange) => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } } as unknown as BambuBridge;
  const abort = new AbortController();
  const stream = bambuOperations(bridge).watch(ref, { signal: abort.signal })[Symbol.asyncIterator]();
  try {
    expect((await stream.next()).value).toEqual(operation);
    if (kind === 'accepted') {
      expect((await stream.next()).done).toBe(true);
      expect(control).toHaveBeenCalledOnce();
    } else {
      const next = stream.next();
      operation = { ...operation, revision: 2, phase: { kind: 'completed', result: null, confirmation: 'observed-state' } };
      listeners.forEach(listener => listener('control'));
      expect((await next).value).toEqual(operation);
      expect((await stream.next()).done).toBe(true);
    }
    expect(listeners.size).toBe(0);
  } finally { abort.abort(); await stream.return?.(); }
});
