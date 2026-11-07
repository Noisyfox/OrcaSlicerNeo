// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { MaterialMetadataDialog } from './MaterialMetadataDialog';
it('edits metadata without a catalogue/model and retains the draft after device rejection', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let succeeds = false;
  const submit = vi.fn(async (_request: D.CommandRequest) => ({ kind: 'recorded', operation: { id: 'op', printerId: 'p', routeId: 'r' } }));
  const service = { controls: { submit }, operations: { watch: async function* () { yield { phase: succeeds ? { kind: 'acknowledged' } : { kind: 'failed', error: { message: 'Printer refused metadata' } } }; } } } as unknown as D.PrinterService;
  const query = vi.fn(), platform = { runtime: { getDeviceMaterialCatalogue: query }, preferences: { load: async () => DEFAULT_USER_PREFERENCES } } as unknown as PlatformCapabilities;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element), close = vi.fn();
  try {
    await act(async () => root.render(<PlatformProvider value={platform}><MaterialMetadataDialog service={service} target={{ printerId: 'p' as never, routeId: 'r' as never }} slot={{ id: 'slot' as never, unitId: 'holder' as never, name: 'Filament 1' }} fields={['manufacturer', 'materialType', 'color']} onClose={close} /></PlatformProvider>));
    async function input(id: string, value: string) { await act(async () => { const field = document.getElementById(id) as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
    await input('material-brand', 'Generic'); await input('material-type', 'PLA-Silk');
    const save = () => act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Save material information')!.click());
    await save(); expect(query).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('Printer refused metadata');
    expect((document.getElementById('material-type') as HTMLInputElement).value).toBe('PLA-Silk');
    succeeds = true; await save(); expect(close).toHaveBeenCalledOnce();
    expect(submit.mock.calls[1][0].command).toMatchObject({ type: 'materials.writeMetadata', params: { patch: { manufacturer: 'Generic', materialType: 'PLA-Silk' } } });
  } finally { await act(async () => root.unmount()); element.remove(); }
});
