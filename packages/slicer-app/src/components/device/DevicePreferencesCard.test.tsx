// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { DevicePreferencesCard } from './DevicePreferencesCard';
it('preserves edited fields after verification failure and saves only explicit changes on manual retry', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const target = { printerId: 'p', routeId: 'r' } as D.PrinterTarget;
  let success = false;
  const submit = vi.fn(async () => ({ kind: 'recorded', operation: { ...target, id: 'op' } }));
  const service = { controls: { submit }, operations: { watch: async function* () { yield { phase: success ? { kind: 'acknowledged' } : { kind: 'failed', error: { message: 'Readback mismatch' } } }; } } } as unknown as D.PrinterService;
  const preferences: D.DevicePreferences = { fields: [{ key: 'autoRefill', label: 'Auto-refill', choices: [false, true], value: { kind: 'known', value: false, freshness: 'fresh', sourceRouteId: target.routeId, observedAtMs: null, receivedAtMs: 1 } }] };
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element), saved = vi.fn();
  try {
    await act(async () => root.render(<DevicePreferencesCard service={service} target={target} preferences={preferences} onSaved={saved} />));
    await act(async () => { const select = element.querySelector('select')!; select.value = 'true'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => element.querySelector('button')!.click());
    expect(element.textContent).toContain('Readback mismatch'); expect(element.querySelector('select')!.value).toBe('true'); expect(saved).not.toHaveBeenCalled();
    success = true; await act(async () => element.querySelector('button')!.click());
    expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[0]?.[0]).toMatchObject({ command: { type: 'preferences.set', params: { changes: [{ key: 'autoRefill', value: true }] } } });
    expect(element.textContent).toContain('saved and verified'); expect(saved).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); element.remove(); }
});
