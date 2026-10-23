import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BambuNative } from '@orca/bambu-native';
import { BambuAccount } from './account';
import { BambuRepository } from './repository';
import type { BambuHostRequest } from '../../shared/bambuHost';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-account-')); directories.push(directory);
  const repository = new BambuRepository(directory); const calls: string[] = []; let loggedIn = false; let time = 100_000;
  const native = {
    isUserLoggedIn: vi.fn(async () => loggedIn), getBambuLabHost: vi.fn(async () => 'https://bambulab.com'),
    getMyToken: vi.fn(async () => { calls.push('token'); return { result: 0, httpCode: 200, body: JSON.stringify({ accessToken: 'secret', refreshToken: 'refresh', expiresIn: 3600 }) }; }),
    getMyProfile: vi.fn(async () => { calls.push('profile'); return { result: 0, httpCode: 200, body: JSON.stringify({ uidStr: 'private-user-id', name: 'User', account: 'private-email', avatar: '' }) }; }),
    changeUser: vi.fn(async (_payload: string) => { calls.push('change'); loggedIn = true; return 0; }),
    getUserNickname: vi.fn(async () => 'User'), getUserName: vi.fn(async () => 'User'), getUserAvatar: vi.fn(async () => ''),
    connectServer: vi.fn(async () => { calls.push('connect'); return 0; }),
    getUserPrintInfo: vi.fn(async () => { calls.push('printers'); return { result: 0, httpCode: 200, body: '{}' }; }),
    logout: vi.fn(async (_request: boolean) => { calls.push('logout'); loggedIn = false; return 0; }),
    setCountryCode: vi.fn(async (_country: string) => { calls.push('country'); return 0; }),
    getSelectedMachine: vi.fn(async () => ''), setSelectedMachine: vi.fn(async () => 0),
    buildLoginCommand: vi.fn(async () => '{"command":"studio_userlogin"}'),
  };
  const publish = vi.fn(); const account = new BambuAccount(native as unknown as BambuNative, repository, publish, () => time);
  await account.restore();
  const begin = async () => (await account.handle({ method: 'login.begin', input: null }) as { attempt: number }).attempt;
  const signIn = async () => { const attempt = await begin(); await account.handle({ method: 'login.prepare', input: { attempt, completion: { kind: 'ticket', ticket: 'ticket' } } }); await account.handle({ method: 'login.complete', input: { attempt } }); return attempt; };
  return { account, native, repository, calls, publish, begin, signIn, advance: (ms: number) => { time += ms; } };
}
it('exchanges tickets with plugin exports, closes the preparation boundary before change_user, and follows post-login calls', async () => {
  const f = await fixture(); const attempt = await f.begin();
  await f.account.handle({ method: 'login.prepare', input: { attempt, completion: { kind: 'ticket', ticket: 'ticket' } } });
  expect(f.calls).toEqual(['token', 'profile']); expect(f.native.changeUser).not.toHaveBeenCalled();
  await f.account.handle({ method: 'login.complete', input: { attempt } });
  expect(f.calls).toEqual(['token', 'profile', 'change', 'connect', 'printers']);
  expect(JSON.parse(f.native.changeUser.mock.calls[0][0] as unknown as string)).toMatchObject({ data: { token: 'secret', expires_in: '3600.000000', user: { uid: 'private-user-id' } } });
  expect(f.account.state).toEqual({ status: 'signed-in', account: { displayName: 'User', avatarUrl: null }, error: null });
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain('secret');
});
it('keeps remembered LAN records while changing region and rejects late prior-login replies', async () => {
  const f = await fixture(); const attempt = await f.signIn();
  await f.repository.update(state => ({ ...state, lan: [{ deviceId: 'd', name: 'P', ip: '192.0.2.1', model: 'X1', accessCode: 'private-code' }] }));
  expect(await f.account.handle({ method: 'account.setting', input: { key: 'region', value: 'China' } })).toEqual({ ok: true, value: undefined });
  expect(f.calls.slice(-2)).toEqual(['logout', 'country']); expect(f.native.setCountryCode).toHaveBeenCalledWith('CN');
  expect((await f.repository.read()).lan[0].accessCode).toBe('private-code');
  expect(await f.account.handle({ method: 'login.complete', input: { attempt } })).toMatchObject({ ok: false });
  expect(f.account.state.status).toBe('signed-out');
  await f.account.handle({ method: 'account.setting', input: { key: 'region', value: 'Invalid' } });
  expect((await f.repository.read()).region).toBe('China');
});
it('uses Orca 401 grace timing, expires on server code 5, and preserves sessions on network errors', async () => {
  const f = await fixture(); await f.signIn();
  f.account.onEvent({ type: 'http-error', args: [401, 'private'] }); await f.account.close();
  expect(f.native.logout).not.toHaveBeenCalled();
  f.account.onEvent({ type: 'http-error', args: [503, 'private'] }); await f.account.close();
  expect(f.account.state).toMatchObject({ status: 'signed-in', error: { code: 'network' } });
  f.advance(30_001); f.account.onEvent({ type: 'http-error', args: [401, 'private'] }); await f.account.close();
  expect(f.account.state).toMatchObject({ status: 'signed-out', error: { code: 'authentication' } });
  await f.signIn(); f.account.onEvent({ type: 'server-connected', args: [5, 0] }); await f.account.close();
  expect(f.native.logout).toHaveBeenCalledTimes(2); expect(f.native.logout).toHaveBeenLastCalledWith(true);
});
it('retains signed-in state when the post-login device request fails and never logs out during disposal', async () => {
  const f = await fixture(); f.native.getUserPrintInfo.mockRejectedValueOnce(new Error('private-response'));
  await f.signIn(); expect(f.account.state).toMatchObject({ status: 'signed-in', error: { code: 'network' } });
  await f.account.close(); expect(f.native.logout).not.toHaveBeenCalled();
});
it('does not change the current session for failed token exchange or cancelled/stale login attempts', async () => {
  const f = await fixture(); const attempt = await f.begin();
  f.native.getMyToken.mockResolvedValueOnce({ result: -1, httpCode: 500, body: 'private-response' });
  const request: BambuHostRequest = { method: 'login.prepare', input: { attempt, completion: { kind: 'ticket', ticket: 'ticket' } } };
  expect(await f.account.handle(request)).toMatchObject({ ok: false, error: { code: 'authentication' } });
  expect(f.native.changeUser).not.toHaveBeenCalled();
  await f.account.handle({ method: 'login.cancel', input: { attempt } });
  expect(await f.account.handle(request)).toMatchObject({ ok: false });
  expect(f.account.state).toEqual({ status: 'signed-out', error: null });
});

it('reports native failure return codes without skipping post-login calls or clearing the account', async () => {
  const f = await fixture(); f.native.connectServer.mockResolvedValueOnce(-1);
  await f.signIn(); expect(f.native.getUserPrintInfo).toHaveBeenCalledOnce();
  expect(f.account.state).toMatchObject({ status: 'signed-in', error: { code: 'network' } });
  expect(f.native.logout).not.toHaveBeenCalled();
});
