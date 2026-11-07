// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { PrinterConfigurationDialog } from './PrinterConfigurationDialog';

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; });

async function fixture(target: D.TargetRequest | null = null) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const typeId = 'independent-printer-type' as D.Id<'printer-type'>;
  const read = vi.fn(async () => ({ ok: true, value: { typeId, displayName: 'Existing printer',
    values: { endpoint: 'https://printer.local/', token: 'existing-secret', queue: 'custom' }, printerModel: null } }));
  const save = vi.fn(async () => ({ ok: true, value: null }));
  const service = {
    listTypes: vi.fn(async () => ({ ok: true, value: [
      { id: 'discovery-only', providerId: 'discovery-agent', name: 'Discovery only', description: 'Added through discovery',
        manualConfiguration: { kind: 'unsupported', layer: 'adapter', reason: 'Use discovery' } },
      { id: typeId, providerId: 'independent-agent', name: 'Independent agent', description: 'Configure its endpoint and queue.',
        manualConfiguration: { kind: 'supported', constraints: { hostId: 'custom-host', supportsModelSelection: false, fields: [
          { key: 'endpoint', label: 'Agent endpoint', type: 'url', required: true, placeholder: 'https://printer.local/', defaultValue: '' },
          { key: 'token', label: 'Access token', type: 'password', required: false, placeholder: '', defaultValue: '' },
          { key: 'queue', label: 'Queue', type: 'text', required: true, placeholder: '', defaultValue: 'default' },
        ] } } },
    ] })),
    configurations: { read, save },
  } as unknown as D.PrinterService;
  // No shared configuration repository is supplied. The agent owns all values.
  const platform = { printers: { service } } as unknown as PlatformCapabilities;
  const onSaved = vi.fn(async () => {}), onClose = vi.fn();
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<PlatformProvider value={platform}><PrinterConfigurationDialog target={target}
    opener={createRef<HTMLButtonElement>()} onClose={onClose} onSaved={onSaved} /></PlatformProvider>); });
  return { service, save, read, onSaved, onClose };
}

function input(id: string) { return document.querySelector<HTMLInputElement>(`[data-testid="device-${id}"]`)!; }
function setInput(id: string, value: string) {
  const element = input(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

it('adds an arbitrary agent using its declared fields, defaults and persistence', async () => {
  const f = await fixture();
  expect(document.querySelector('[data-testid="device-adapter"]')?.textContent).toContain('Independent agent');
  expect(input('api-base-url')).toBeNull();
  expect(document.querySelector('[data-testid="device-printer-model"]')).toBeNull();
  expect(input('queue').value).toBe('default');
  expect(input('token').type).toBe('password');
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="device-adapter"]')!.click(); });
  expect([...document.querySelectorAll('[role="option"]')].map(element => element.textContent)).toEqual(['Independent agent']);
  await act(async () => { document.querySelector<HTMLElement>('[role="option"]')!.click(); });
  await act(async () => { setInput('display-name', 'My printer'); setInput('endpoint', 'https://custom.local/'); setInput('token', 'new-secret'); });
  await act(async () => { input('save-printer').click(); });
  expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ target: null, typeId: 'independent-printer-type', hostId: 'custom-host',
    displayName: 'My printer', values: { endpoint: 'https://custom.local/', token: 'new-secret', queue: 'default' }, printerModel: null }));
  expect(f.read).not.toHaveBeenCalled();
  expect(f.onSaved).toHaveBeenCalledOnce();
});

it('reads and edits through the agent even when no shared configuration record exists', async () => {
  const target = { printerId: 'custom-device', routeId: 'custom-route', expectedConfigurationRevision: 'revision' } as D.TargetRequest;
  const f = await fixture(target);
  expect(f.read).toHaveBeenCalledWith(target);
  expect(input('display-name').value).toBe('Existing printer');
  expect(input('token').value).toBe('existing-secret');
  await act(async () => { setInput('queue', 'updated'); });
  await act(async () => { input('save-printer').click(); });
  expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ target, values: {
    endpoint: 'https://printer.local/', token: 'existing-secret', queue: 'updated',
  } }));
  expect(f.onSaved).toHaveBeenCalledOnce();
});

it('retains form edits and displays a generic error when agent persistence rejects', async () => {
  const f = await fixture();
  vi.mocked(f.service.configurations.save).mockResolvedValue({ ok: false, error: { code: 'invalid-request', message: 'private-secret' } });
  await act(async () => { setInput('display-name', 'My printer'); setInput('endpoint', 'https://custom.local/'); });
  await act(async () => { input('save-printer').click(); });
  expect(document.body.textContent).toContain('Unable to save printer configuration.');
  expect(document.body.textContent).not.toContain('private-secret');
  expect(input('endpoint').value).toBe('https://custom.local/');
  expect(f.onSaved).not.toHaveBeenCalled();
});
