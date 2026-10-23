// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { AccountProvider, AccountState, ProviderId } from '@orca/service-provider';
import { AccountSettings, HomeAccounts } from './AccountControls';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => cleanup());
function provider() {
  let state: AccountState = { status: 'signed-out', error: null };
  const listeners = new Set<() => void>();
  const account: AccountProvider['account'] = {
    getState: vi.fn(async () => state), onStateChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    login: vi.fn(async () => ({ ok: true as const, value: undefined })), logout: vi.fn(async () => ({ ok: true as const, value: undefined })),
    getSettings: vi.fn(async () => [{ key: 'region', label: 'Region', value: 'Others', choices: [{ value: 'Others', label: 'Others' }, { value: 'China', label: 'China' }] as const }]),
    setSetting: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
  return { value: { id: 'bambu' as ProviderId, name: 'Bambu Lab', account }, listeners,
    change: (value: AccountState) => { state = value; listeners.forEach(listener => listener()); } };
}
async function render(accounts: AccountProvider[], settings = false) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<PlatformProvider value={{ accounts } as unknown as PlatformCapabilities}>{settings ? <AccountSettings /> : <HomeAccounts />}</PlatformProvider>));
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  return container;
}
it('reflects provider state on Home, focuses login again while signing in, and signs out without exposing identity or credentials', async () => {
  const p = provider(); const container = await render([p.value]);
  expect(container.textContent).toContain('Sign in to Bambu Lab');
  await act(async () => container.querySelector('button')!.click()); expect(p.value.account.login).toHaveBeenCalledOnce();
  await act(async () => p.change({ status: 'signing-in', error: null }));
  expect(container.textContent).toContain('Show login');
  await act(async () => container.querySelector('button')!.click()); expect(p.value.account.login).toHaveBeenCalledTimes(2);
  await act(async () => p.change({ status: 'signed-in', account: { displayName: 'User', avatarUrl: null }, error: null }));
  expect(container.textContent).toContain('User');
  await act(async () => container.querySelector('button')!.click()); expect(p.value.account.logout).toHaveBeenCalledOnce();
  cleanup(); expect(p.listeners.size).toBe(0); cleanup = () => {};
});
it('shows authentication expiry and unavailable-plugin state without presenting raw failures', async () => {
  const p = provider(); const container = await render([p.value]);
  await act(async () => p.change({ status: 'signed-out', error: { code: 'authentication', message: 'Login information expired. Please sign in again.' } }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('expired');
  await act(async () => p.change({ status: 'unavailable', error: { code: 'unavailable', message: 'Bambu networking is unavailable.' } }));
  expect(container.querySelector('button')?.disabled).toBe(true);
});
it('provides no account execution entry on hosts with no account providers', async () => {
  expect((await render([])).textContent).toBe('');
});
it('shows provider settings without creating another login entry', async () => {
  const p = provider(); const container = await render([p.value], true);
  expect(container.textContent).toContain('Region'); expect(container.textContent).toContain('Others');
  expect(container.textContent).not.toContain('Sign in');
  expect(p.value.account.login).not.toHaveBeenCalled();
});

it('shows the signed-in avatar, falls back on image failure, and clears it on logout', async () => {
  const p = provider(); const container = await render([p.value]);
  expect(container.querySelector('img')).toBeNull();
  const signIn = (avatarUrl: string | null) => act(async () => p.change({ status: 'signed-in', account: { displayName: 'User', avatarUrl }, error: null }));
  await signIn('data:image/png;base64,first');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,first');
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('[aria-label="Default account avatar"]')).not.toBeNull();
  await signIn('data:image/png;base64,second');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,second');
  await signIn(null);
  expect(container.querySelector('[aria-label="Default account avatar"]')).not.toBeNull();
  await act(async () => p.change({ status: 'signed-out', error: null }));
  expect(container.querySelector('[role="img"], img')).toBeNull();
});
