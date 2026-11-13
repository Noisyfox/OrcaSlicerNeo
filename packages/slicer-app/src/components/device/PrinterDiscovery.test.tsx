// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type DiscoveryCandidate, type PrinterService, type SavedPrinter } from '@orca/platform-contract';
import { PrinterDiscovery } from './PrinterDiscovery';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ''; });
const candidate = { id: 'candidate', providerId: 'provider', displayName: 'LAN printer', externalRefs: [{ namespace: 'fixture', value: 'serial' }],
  expiresAtMs: Date.now() + 60_000, access: 'access-code', configuration: { channel: 'lan', hostId: 'host', address: '192.0.2.1' }, capabilities: {} } as unknown as DiscoveryCandidate;
async function render(remembered = false, failure = false, recovery = false) {
  const stopped = vi.fn(); const authorize = vi.fn(async () => failure ? { ok: false as const, error: { code: 'permission-denied', message: 'Incorrect access code.' } } : { ok: true as const, value: { identity: { id: 'printer' } } });
  const service = {
    listProviders: async () => ({ ok: true, value: [{ id: 'provider', name: 'Provider', hosts: [{ id: 'host', discovery: { kind: 'supported', constraints: { kinds: ['lan'] } } }] }] }),
    discover: async function* (_provider: unknown, _scope: unknown, options: { signal: AbortSignal }) {
      if (recovery) yield { type: 'upsert', candidate: { ...candidate, id: 'other', displayName: 'Another printer', externalRefs: [{ namespace: 'fixture', value: 'different' }] } };
      yield { type: 'upsert', candidate };
      await new Promise<void>(resolve => { options.signal.addEventListener('abort', () => { stopped(); resolve(); }, { once: true }); });
    }, authorize,
  } as unknown as PrinterService;
  const existing = [{ identity: { id: 'printer', displayName: 'Selected printer', externalRefs: candidate.externalRefs }, routes: [{ providerId: 'provider', configuration: { hostId: 'host', channel: 'automatic', credentialRef: remembered ? 'opaque-reference' : null } }] }] as unknown as SavedPrinter[];
  let saved = remembered || recovery ? existing : [];
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const authorized = vi.fn();
  const mount = async () => { await act(async () => root.render(<PlatformProvider value={{ printers: { service } } as unknown as PlatformCapabilities}><PrinterDiscovery saved={saved} target={recovery ? saved[0] : undefined} onAuthorized={authorized} /></PlatformProvider>)); };
  await mount();
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="device-discover"]')!.click());
  const select = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('LAN printer'))!;
  if (select) await act(async () => select.click());
  return { authorize, stopped, authorized, existing, updateSaved: async (next: SavedPrinter[]) => { saved = next; await mount(); } };
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
it('hides an already added LAN printer instead of offering to verify saved access', async () => {
  const f = await render(true);
  expect(document.querySelector('button[aria-pressed]')).toBeNull();
  expect(document.querySelector('#printer-access-code')).toBeNull();
  expect(f.authorize).not.toHaveBeenCalled();
});
it.each(['cloud', 'lan'])('removes a selected candidate when it is added through %s and shows it again after forgetting', async channel => {
  const f = await render(); await enterCode();
  const saved = structuredClone(f.existing); saved[0].routes[0].configuration.channel = channel as 'cloud' | 'lan';
  await f.updateSaved(saved);
  expect(document.querySelector('button[aria-pressed]')).toBeNull();
  expect(document.querySelector('#printer-access-code')).toBeNull();
  expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Add LAN connection')?.disabled).toBe(true);
  expect(f.authorize).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled();
  await f.updateSaved([]);
  expect(document.querySelector('button[aria-pressed]')).not.toBeNull();
  expect(document.querySelector('#printer-access-code')).toBeNull();
});
it.each(['different-identity', 'different-provider'])('does not hide an unadded printer with a %s', async difference => {
  const f = await render();
  const saved = structuredClone(f.existing);
  if (difference === 'different-identity') saved[0].identity.externalRefs = [{ namespace: 'fixture', value: 'different' }];
  else saved[0].routes[0].providerId = 'other-provider' as typeof saved[0]['routes'][0]['providerId'];
  await f.updateSaved(saved);
  expect(document.querySelector('button[aria-pressed]')).not.toBeNull();
  expect(document.querySelector('#printer-access-code')).not.toBeNull();
});
it('shows a safe authentication failure and clears the submitted code for a retry', async () => {
  await render(false, true); await enterCode(); await click('Add LAN connection');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Incorrect access code.');
  expect(document.querySelector<HTMLInputElement>('#printer-access-code')!.value).toBe('');
});
it('storage recovery filters physical identity, accepts a replacement code and refreshes only after success', async () => {
  const f = await render(true, false, true);
  expect(document.body.textContent).not.toContain('Another printer');
  expect(document.querySelector<HTMLInputElement>('#printer-access-code')!.type).toBe('password');
  await enterCode(); await click('Authorize access');
  expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({ existingPrinterId: 'printer', candidate, accessCode: 'ABCDEFGH' }));
  expect(f.authorized).toHaveBeenCalledOnce(); expect(f.stopped).toHaveBeenCalledOnce();
});
