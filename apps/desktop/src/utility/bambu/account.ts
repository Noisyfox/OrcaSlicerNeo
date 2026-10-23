import type { BambuNative, NativeEvent, NativeHttpResult } from '@orca/bambu-native';
import type { AccountError, AccountResult, AccountState } from '@orca/service-provider';
import { BAMBU_REGIONS, type BambuChange, type BambuRegion } from '../../shared/bambu';
import type { BambuHostRequest, BambuHostResults, LoginCompletion } from '../../shared/bambuHost';
import { BambuDevices } from './devices';
import type { BambuRepository } from './repository';

const success = (): AccountResult<void> => ({ ok: true, value: undefined });
const failure = (code: AccountError['code'], message: string): AccountResult<void> => ({ ok: false, error: { code, message } });
function body(result: NativeHttpResult): Record<string, unknown> {
  if (result.result !== 0) throw new Error('Bambu request failed');
  const value: unknown = JSON.parse(result.body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
  return value as Record<string, unknown>;
}
const string = (value: unknown) => typeof value === 'string' ? value : '';
export const bambuCountry = (region: BambuRegion) => region === 'China' ? 'CN' : ['Europe', 'NorthAmerica'].includes(region) ? 'US' : 'Others';

/** Serializes account transitions; raw login material stays in the utility/main login boundary. */
export class BambuAccount {
  state: AccountState = { status: 'restoring', error: null };
  private tail: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private activeAttempt: number | null = null;
  private prepared: unknown = null;
  private lastLogin = 0;
  constructor(private readonly native: BambuNative, private readonly repository: BambuRepository,
    private readonly publish: (change: BambuChange) => void, private readonly devices: BambuDevices, private readonly now = () => Date.now()) {}
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
  }
  private notify() { this.publish('account'); }
  private async summarize() {
    this.state = { status: 'signed-in', account: { displayName: await this.native.getUserNickname() || await this.native.getUserName(), avatarUrl: await this.native.getUserAvatar() || null }, error: null };
  }
  private async connected() {
    this.lastLogin = this.now();
    // Orca calls both even when the UI does not currently show a device page.
    const connected = await this.native.connectServer();
    const devices = await this.devices.refresh(() => this.native.getUserPrintInfo());
    if (connected !== 0 || !devices) throw new Error('Cloud connection unavailable');
  }
  async restore() {
    if (await this.native.isUserLoggedIn()) { this.devices.activate(); await this.summarize(); await this.connected().catch(() => { this.state = { ...this.state, error: { code: 'network', message: 'The cloud connection is unavailable. Please try again.' } }; }); }
    else this.state = { status: 'signed-out', error: null };
  }
  handle(request: BambuHostRequest): Promise<BambuHostResults[keyof BambuHostResults]> {
    return this.queue(async () => {
      if (request.method === 'printers.refresh') return await this.devices.refresh(() => this.native.getUserPrintInfo()) ? success() : failure('network', 'The cloud device list could not be refreshed.');
      if (request.method === 'account.logout') return this.logout();
      if (request.method === 'account.setting') {
        if (request.input.key !== 'region' || !BAMBU_REGIONS.includes(request.input.value as BambuRegion)) return failure('invalid-setting', 'Select a supported region.');
        const region = request.input.value as BambuRegion;
        if ((await this.repository.read()).region === region) return success();
        const result = await this.logout(); if (!result.ok) return result;
        if (await this.native.setCountryCode(bambuCountry(region)) !== 0) return failure('unavailable', 'The region could not be changed.');
        await this.repository.update(state => ({ ...state, region })); this.notify(); return success();
      }
      if (request.method === 'login.begin') {
        if (this.state.status === 'signed-in') throw new Error('Already signed in');
        const host = new URL(await this.native.getBambuLabHost());
        if (host.protocol !== 'https:' || !['bambulab.com', 'bambulab.cn'].includes(host.hostname)) throw new Error('Unsupported login host');
        this.prepared = null; this.activeAttempt = ++this.attempt;
        this.state = { status: 'signing-in', error: null }; this.notify();
        return { attempt: this.activeAttempt, url: new URL('/en-US/sign-in', host).href };
      }
      if (request.input.attempt !== this.activeAttempt) return failure('authentication', 'This login is no longer active.');
      if (request.method === 'login.command') return this.native.buildLoginCommand();
      if (request.method === 'login.cancel') {
        this.prepared = null; this.activeAttempt = null; this.state = { status: 'signed-out', error: null }; this.notify(); return success();
      }
      if (request.method === 'login.fail') {
        this.state = { status: 'signing-in', error: { code: 'network', message: 'The login page could not be loaded. Please try again.' } }; this.notify(); return success();
      }
      try {
        if (request.method === 'login.prepare') { this.prepared = null; this.prepared = await this.loginPayload(request.input.completion); return success(); }
        if (!this.prepared) throw new Error('Login not prepared');
        const payload = this.prepared; this.prepared = null;
        await this.native.changeUser(JSON.stringify(payload));
        if (!await this.native.isUserLoggedIn()) throw new Error('Login failed');
        this.activeAttempt = null;
        this.devices.activate(); await this.summarize(); this.notify();
        // Failure to list/connect is not a failed login and never clears the session.
        await this.connected().catch(() => { this.state = { ...this.state, error: { code: 'network', message: 'Signed in. The cloud connection is unavailable.' } }; });
        this.notify(); return success();
      } catch {
        this.state = { status: 'signing-in', error: { code: 'authentication', message: 'Login failed. Please try again.' } }; this.notify();
        return failure('authentication', 'Login failed. Please try again.');
      }
    });
  }
  private async loginPayload(completion: LoginCompletion) {
    if (completion.kind === 'user') return { command: 'user_login', data: { ...completion.data, autotest_token: completion.autotestToken ?? '' } };
    let token: string; let refresh: string; let expires: string; let refreshExpires: string;
    if (completion.kind === 'ticket') {
      const response = body(await this.native.getMyToken(completion.ticket));
      token = string(response.accessToken); refresh = string(response.refreshToken);
      // Match std::to_string(double) in Orca's ticket flow.
      expires = typeof response.expiresIn === 'number' ? response.expiresIn.toFixed(6) : '';
      refreshExpires = typeof response.refreshExpiresIn === 'number' ? response.refreshExpiresIn.toFixed(6) : '';
    } else { ({ token, refresh, expires, refreshExpires } = completion); }
    if (!token) throw new Error('Missing token');
    const profile = body(await this.native.getMyProfile(token));
    return { command: 'user_login', data: { token, refresh_token: refresh, expires_in: expires, refresh_expires_in: refreshExpires,
      autotest_token: completion.kind === 'ticket' ? completion.autotestToken ?? '' : '',
      user: { uid: string(profile.uidStr), name: string(profile.name), account: string(profile.account), avatar: string(profile.avatar) } } };
  }
  private async logout(expired = false): Promise<AccountResult<void>> {
    this.prepared = null; this.activeAttempt = null; ++this.attempt;
    if (await this.native.logout(true) !== 0) return failure('network', 'Sign out failed. Please try again.');
    this.devices.clear();
    this.state = { status: 'signed-out', error: expired ? { code: 'authentication', message: 'Login information expired. Please sign in again.' } : null };
    this.notify(); return success();
  }
  onEvent(event: NativeEvent) {
    if (event.type !== 'server-connected' && event.type !== 'http-error') return;
    void this.queue(async () => {
      if (this.state.status !== 'signed-in') return;
      if ((event.type === 'server-connected' && event.args[0] === 5)
        || (event.type === 'http-error' && event.args[0] === 401 && this.now() - this.lastLogin > 30_000)) {
        await this.logout(true); return;
      }
      if (event.type === 'server-connected') {
        // Orca restores the selected native machine twice in this callback.
        await this.native.setSelectedMachine(await this.native.getSelectedMachine());
        await this.native.setSelectedMachine(await this.native.getSelectedMachine());
      }
      if (event.type === 'http-error' && event.args[0] !== 401) this.state = { ...this.state, error: { code: 'network', message: 'The cloud connection is unavailable. Please try again.' } };
      this.notify();
    }).catch(() => { /* Never forward native error bodies. */ });
  }
  async close() { await this.tail; }
}
