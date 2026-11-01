// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { SkipObjects } from './SkipObjects';

const target = { printerId: 'p' as D.Id<'printer'>, routeId: 'r' as D.Id<'route'>, expectedConfigurationRevision: 'v1' };
const known = <T,>(value: T): D.Reading<T> => ({ kind: 'known', freshness: 'fresh', sourceRouteId: target.routeId, observedAtMs: 1, receivedAtMs: 1, value });
const initial: D.PrintObjectSnapshot = { contextRef: { printerId: target.printerId, routeId: target.routeId, configurationRevision: 'v1', taskId: 'task' as D.Id<'device-task'>, token: 'token' as D.Id<'print-object-context'> },
  objects: [1, 2, 3].map(n => ({ id: `o${n}` as D.Id<'print-object'>, name: `Part ${n}` })), skippedObjectIds: known([]), availability: { kind: 'available' },
  pickingImage: { kind: 'unsupported', layer: 'route', reason: 'No image' } };
async function fixture() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const feedback = vi.fn(), submit = vi.fn(async (_request: D.CommandRequest): Promise<D.Submission> => ({ kind: 'recorded', operation: { printerId: target.printerId, routeId: target.routeId, id: 'op' as D.Id<'operation'> } }));
  const evaluate = vi.fn(async () => ({ ok: true, value: { availability: { kind: 'available' }, basis: { capabilityRevision: 'cap' } } }));
  const read = vi.fn(async () => ({ ok: true, value: { target, configurationRevision: 'v1', values: { printObjects: known(initial) } } }));
  const service = { observations: { read }, media: { readPrintObjectMap: vi.fn() }, controls: { submit, evaluate }, operations: { watch: async function* (_ref: unknown, options: D.ReadOptions) {
    await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
  } } } as unknown as D.PrinterService;
  let props = { service, target, printerName: 'Workshop', capability: { kind: 'supported', constraints: { maxObjects: 64 } } as D.CommandCapabilities['jobs.skipObjects'], capabilityRevision: 'cap', phase: 'printing' as D.PrintPhase,
    taskId: 'task' as D.Id<'device-task'>, fresh: true, observed: known(initial), onFeedback: feedback };
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const render = async (patch: Partial<typeof props> = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<SkipObjects {...props} />)); };
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text || b.getAttribute('aria-label') === text)!;
  const click = async (text: string) => act(async () => button(text).click());
  const select = async (n: number) => act(async () => { [...document.querySelectorAll('label')].find(l => l.textContent?.includes(`Part ${n}`))!.querySelector<HTMLInputElement>('input')!.click(); });
  const dialog = () => document.querySelector('[role="dialog"]');
  await render();
  return { render, click, select, button, dialog, submit, evaluate, read, feedback, close: async () => { await act(async () => root.unmount()); element.remove(); } };
}
it('requires a second confirmation, closes on recording and admits a second batch while the first remains pending', async () => {
  const f = await fixture(); try {
    await f.click('Skip Objects'); await f.select(1); await f.click('Review selection');
    expect(f.dialog()?.textContent).toContain('Skipping cannot be undone');
    expect(f.dialog()?.textContent).toContain('Workshop'); expect(f.dialog()?.textContent).toContain('1 selected object');
    expect(f.submit).not.toHaveBeenCalled();
    await f.click('Confirm skip'); expect(f.dialog()).toBeNull();
    expect(f.evaluate).toHaveBeenCalledWith({ printerId: target.printerId, routeId: target.routeId }, expect.anything());
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ command: { type: 'jobs.skipObjects', params: { contextRef: initial.contextRef, objectIds: ['o1'], intent: 'skip-selected' } } }));
    expect(document.body.textContent).toContain('0 skipped');
    await f.click('Skip Objects'); await f.select(2); await f.click('Review selection'); await f.click('Confirm skip');
    expect(f.submit).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
it('keeps rejected submissions open and sends explicit stop intent for all remaining objects', async () => {
  const f = await fixture(); try {
    f.submit.mockResolvedValueOnce({ kind: 'rejected', error: { code: 'stale-context', message: 'Selection rejected' } });
    await f.click('Skip Objects'); await f.click('Select all remaining'); await f.click('Review selection');
    expect(f.dialog()?.textContent).toContain('This will stop the entire print');
    await f.click('Confirm stop print'); expect(f.dialog()?.textContent).toContain('Selection rejected');
    expect(f.submit.mock.calls[0][0].command).toMatchObject({ type: 'jobs.skipObjects', params: { intent: 'cancel-print', objectIds: ['o1', 'o2', 'o3'] } });
  } finally { await f.close(); }
});
it('retains selection across stale recovery and removes externally skipped objects while invalidating confirmation', async () => {
  const f = await fixture(); try {
    await f.click('Skip Objects'); await f.select(1); await f.select(2); await f.click('Review selection');
    await f.render({ fresh: false });
    expect(f.dialog()?.textContent).toContain('2 selected'); expect(f.button('Review selection').disabled).toBe(true);
    await f.render({ fresh: true }); expect(f.button('Review selection').disabled).toBe(false);
    await f.click('Review selection');
    await f.render({ observed: known({ ...initial, skippedObjectIds: known(['o1' as D.Id<'print-object'>]) }) });
    expect(f.dialog()?.textContent).toContain('1 skipped · 1 selected');
    expect(f.button('Confirm skip')).toBeUndefined();
    expect([...document.querySelectorAll<HTMLInputElement>('input')].filter(i => i.checked)).toHaveLength(1);
    await f.click('Review selection'); await f.click('Confirm skip');
    expect(f.submit.mock.calls[0][0].command).toMatchObject({ params: { objectIds: ['o2'], intent: 'skip-selected' } });
  } finally { await f.close(); }
});
it('closes on task changes and prevents a confirmation waiting on evaluation from being submitted', async () => {
  const f = await fixture(); try {
    let complete!: (value: Awaited<ReturnType<typeof f.evaluate>>) => void;
    f.evaluate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await f.click('Skip Objects'); await f.select(1); await f.click('Review selection'); await f.click('Confirm skip');
    await f.render({ taskId: 'different' as D.Id<'device-task'> }); expect(f.dialog()).toBeNull();
    await act(async () => complete({ ok: true, value: { availability: { kind: 'available' }, basis: { capabilityRevision: 'cap' } } }));
    expect(f.submit).not.toHaveBeenCalled(); expect(f.feedback).toHaveBeenCalledWith(expect.stringContaining('selection was discarded'));
  } finally { await f.close(); }
});
it('hides unsupported entry, disables unknown support and explains list fallback', async () => {
  const f = await fixture(); try {
    await f.click('Skip Objects'); expect(f.dialog()?.textContent).toContain('graphical view is unavailable'); await f.click('Close');
    await f.render({ capability: { kind: 'unknown', reason: 'Waiting' } }); expect(f.button('Skip Objects').disabled).toBe(true);
    await f.render({ capability: { kind: 'unsupported', layer: 'device', reason: 'Unavailable' } }); expect(f.button('Skip Objects')).toBeUndefined();
  } finally { await f.close(); }
});

it('does not submit after the owning Monitor is unmounted during evaluation', async () => {
  const f = await fixture();
  let complete!: (value: Awaited<ReturnType<typeof f.evaluate>>) => void;
  f.evaluate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await f.click('Skip Objects'); await f.select(1); await f.click('Review selection'); await f.click('Confirm skip');
  await f.close();
  await act(async () => complete({ ok: true, value: { availability: { kind: 'available' }, basis: { capabilityRevision: 'cap' } } }));
  expect(f.submit).not.toHaveBeenCalled();
});
