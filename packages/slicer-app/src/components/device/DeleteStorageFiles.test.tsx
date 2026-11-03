// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { DeleteStorageFiles } from './DeleteStorageFiles';
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.innerHTML = ''; });
async function fixture(phases: D.CommandOperation['phase'][]) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const files = ['first', 'second', 'third'].map(name => ({ name, ref: { printerId: 'printer', routeId: 'route', configurationRevision: 'config', storageId: 'sd', fileId: name } })) as D.RemoteFile[];
  const submit = vi.fn<D.PrinterControls['submit']>(async request => ({ kind: 'recorded', operation: { ...request.target, id: request.command.type === 'files.delete' ? request.command.params.target.fileId as unknown as D.Id<'operation'> : 'bad' as never } }));
  const watch = vi.fn<D.PrinterOperations['watch']>(async function* (ref) {
    yield { kind: 'command', commandType: 'files.delete', ref, requestId: 'request' as D.Id<'request'>, configurationRevision: 'config', revision: 1, updatedAtMs: 0, steps: [], phase: phases.shift()! };
  });
  const service = { controls: { submit }, operations: { watch, find: vi.fn(), get: vi.fn() }, files: { list: vi.fn(), stat: vi.fn() } } as unknown as D.PrinterService;
  const outcome = vi.fn(), close = vi.fn(), element = document.createElement('div'); document.body.append(element); const root = createRoot(element); roots.push(root);
  await act(async () => root.render(<PlatformProvider value={{ printers: { service } } as PlatformCapabilities}><DeleteStorageFiles files={files} printerName="Printer" storageName="SD card" onOutcome={outcome} onClose={close} /></PlatformProvider>));
  const click = async (label: string) => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === label); expect(button).toBeDefined(); await act(async () => button!.click()); };
  return { submit, watch, service, outcome, close, click, root, files };
}
const completed = { kind: 'completed', result: null, confirmation: 'device-result' } as const;
it('confirms once, continues after an explicit isolated failure and reports separate per-file outcomes', async () => {
  const f = await fixture([completed, { kind: 'failed', error: { code: 'device-rejected', message: 'In use.' } }, completed]);
  expect(f.submit).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Printer · SD card · 3 selected files');
  await f.click('Delete files'); expect(f.submit).toHaveBeenCalledTimes(3);
  expect(document.body.textContent).toContain('2 deleted · 1 failed · 0 unconfirmed · 0 not executed');
  expect(f.service.files.list).not.toHaveBeenCalled(); expect(f.service.files.stat).not.toHaveBeenCalled();
  expect(f.outcome.mock.calls.map(call => call[1].state)).toEqual(['deleted', 'failed', 'deleted']);
});
it('pauses remaining files after an uncertain outcome and continues without retrying or querying that file', async () => {
  const f = await fixture([{ kind: 'outcome-unknown', reason: 'Lost response' }, completed, completed]);
  await f.click('Delete files'); expect(f.submit).toHaveBeenCalledTimes(1); expect(document.body.textContent).toContain('Deletion paused.');
  expect(f.service.operations.find).not.toHaveBeenCalled(); expect(f.service.files.list).not.toHaveBeenCalled();
  await f.click('Continue remaining files');
  expect(f.submit.mock.calls.map(([request]) => request.command.type === 'files.delete' && request.command.params.target.fileId)).toEqual(['first', 'second', 'third']);
  expect(document.body.textContent).toContain('2 deleted · 0 failed · 1 unconfirmed · 0 not executed');
});
it('leaves remaining files unexecuted when the user stops a disconnected batch', async () => {
  const f = await fixture([{ kind: 'failed', error: { code: 'transport', message: 'Disconnected.' } }]);
  await f.click('Delete files'); await f.click('Stop batch');
  expect(f.submit).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('0 deleted · 1 failed · 0 unconfirmed · 2 not executed');
});
it('does not look up or resend an uncertain submission', async () => {
  const f = await fixture([]); f.submit.mockResolvedValueOnce({ kind: 'outcome-unknown', lookup: { printerId: 'printer', routeId: 'route', requestId: 'request' } as D.RequestLookup });
  await f.click('Delete files'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.watch).not.toHaveBeenCalled(); expect(f.service.operations.find).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('1 unconfirmed');
});
