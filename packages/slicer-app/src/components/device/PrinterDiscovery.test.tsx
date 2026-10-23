// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { DiscoveryCandidate, PrinterService, SavedPrinter } from '@orca/printer-control/domain';
import { PrinterDiscovery } from './PrinterDiscovery';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ''; });
const candidate = { id: 'candidate', providerId: 'provider', displayName: 'LAN printer', externalRefs: [{ namespace: 'fixture', value: 'serial' }],
  expiresAtMs: Date.now() + 60_000, access: 'access-code', configuration: { channel: 'lan', hostId: 'host', address: '192.0.2.1' }, capabilities: {} } as unknown as DiscoveryCandidate;
async function render(remembered = false, failure = false) {
  const stopped = vi.fn(); const authorize = vi.fn(async () => failure ? { ok: false as const, error: { code: 'permission-denied', message: 'Incorrect access code.' } } : { ok: true as const, value: {} });
  const service = {
    listProviders: async () => ({ ok: true, value: [{ id: 'provider', name: 'Provider', hosts: [{ id: 'host', discovery: { kind: 'supported', constraints: { kinds: ['lan'] } } }] }] }),
    discover: async function* (_provider: unknown, _scope: unknown, options: { signal: AbortSignal }) {
      yield { type: 'upsert', candidate };
      await new Promise<void>(resolve => { options.signal.addEventListener('abort', () => { stopped(); resolve(); }, { once: true }); });
    }, authorize,
  } as unknown as PrinterService;
  const saved = remembered ? [{ identity: { id: 'printer', externalRefs: candidate.externalRefs }, routes: [{ providerId: 'provider', configuration: { channel: 'lan', credentialRef: 'opaque-reference' } }] }] as unknown as SavedPrinter[] : [];
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<PlatformProvider value={{ printers: { service } } as unknown as PlatformCapabilities}><PrinterDiscovery saved={saved} /></PlatformProvider>));
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="device-discover"]')!.click());
  const select = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('LAN printer'))!;
  await act(async () => select.click());
  return { authorize, stopped };
}
async function click(text: string) { const button = [...document.querySelectorAll('button')].find(button => button.textContent === text)!; expect(button).toBeDefined(); await act(async () => button.click()); }
async function enterCode() {
  const input = document.querySelector<HTMLInputElement>('#printer-access-code')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ABCDEFGH'); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('submits transient masked access input through the common provider API and releases discovery on close', async () => {
  const f = await render(); expect(document.querySelector<HTMLInputElement>('#printer-access-code')!.type).toBe('password');
  await enterCode(); await click('Add LAN connection');
  expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ candidate, accessCode: 'ABCDEFGH' }));
  expect(document.querySelector('#printer-access-code')).toBeNull(); await click('Close'); expect(f.stopped).toHaveBeenCalledOnce();
});
it('reuses a host-owned credential reference without returning a saved code to the form', async () => {
  const f = await render(true); expect(document.querySelector('#printer-access-code')).toBeNull(); await click('Verify saved access');
  expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ existingPrinterId: 'printer', accessCode: '' }));
});
it('shows a safe authentication failure and clears the submitted code for a retry', async () => {
  await render(false, true); await enterCode(); await click('Add LAN connection');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Incorrect access code.');
  expect(document.querySelector<HTMLInputElement>('#printer-access-code')!.value).toBe('');
});
