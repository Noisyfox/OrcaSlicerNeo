// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { usePrinterCommands } from './usePrinterControl';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('retains original operation references across unmounts and never paints a late result onto another printer', async () => {
  let wake: (() => void) | undefined, failed = false;
  const original: D.TargetRequest = { printerId: 'a' as never, routeId: 'route-a' as never, expectedConfigurationRevision: 'cfg-a' };
  const other: D.TargetRequest = { printerId: 'b' as never, routeId: 'route-b' as never, expectedConfigurationRevision: 'cfg-b' };
  const watch = vi.fn<D.PrinterOperations['watch']>(async function* (ref, options) {
    const abort = () => wake?.(); options?.signal?.addEventListener('abort', abort);
    try {
      while (!options?.signal?.aborted) {
        yield { kind: 'command', commandType: 'materials.configure', ref, requestId: 'request' as never, configurationRevision: 'cfg-a', revision: failed ? 2 : 1, updatedAtMs: 1,
          steps: [], phase: failed ? { kind: 'failed', error: { code: 'device-rejected', message: 'Original printer: material rejected, calibration confirmed.' } } : { kind: 'sent' } };
        await new Promise<void>(resolve => { wake = resolve; if (options?.signal?.aborted) resolve(); });
      }
    } finally { options?.signal?.removeEventListener('abort', abort); }
  });
  const submit = vi.fn();
  const service = { operations: { watch }, controls: { submit } } as unknown as D.PrinterService;
  let hook!: ReturnType<typeof usePrinterCommands>;
  function Monitor({ target }: { target: D.TargetRequest }) { hook = usePrinterCommands(service, target, 'cap'); return <p>{hook.feedback}</p>; }
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(<Monitor key="a" target={original} />));
    const originalAccept = hook.acceptSubmission;
    await act(async () => hook.acceptSubmission({ kind: 'recorded', operation: { ...original, id: 'operation-a' as never } }));
    expect(hook.pending).toBe(true);
    await act(async () => root.render(<Monitor key="b" target={other} />));
    expect(hook.pending).toBe(false); expect(element.textContent).toBe('');
    failed = true;
    await act(async () => { wake?.(); originalAccept({ kind: 'recorded', operation: { ...original, id: 'operation-a' as never } }); });
    expect(element.textContent).toBe('');
    await act(async () => root.render(<Monitor key="a-returned" target={original} />));
    expect(element.textContent).toContain('Original printer: material rejected, calibration confirmed.');
    expect(hook.pending).toBe(false); expect(submit).not.toHaveBeenCalled();
    expect(watch.mock.calls.every(([ref]) => ref.printerId === original.printerId)).toBe(true);
  } finally { await act(async () => { wake?.(); root.unmount(); }); element.remove(); }
});

it('reconciles an unknown submission once without retrying the mutation', async () => {
  const find = vi.fn(async () => ({ ok: true, value: { kind: 'unknown', reason: 'not-found' } })), submit = vi.fn();
  const service = { operations: { find }, controls: { submit } } as unknown as D.PrinterService;
  let hook!: ReturnType<typeof usePrinterCommands>;
  const target: D.TargetRequest = { printerId: 'printer' as never, routeId: 'route' as never };
  function Monitor() { hook = usePrinterCommands(service, target, 'cap'); return <p>{hook.feedback}</p>; }
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(<Monitor />));
    await act(async () => hook.acceptSubmission({ kind: 'outcome-unknown', lookup: { ...target, requestId: 'request' as never } }));
    expect(find).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled(); expect(hook.pending).toBe(false);
    expect(element.textContent).toContain('Command outcome unknown');
  } finally { await act(async () => root.unmount()); element.remove(); }
});
