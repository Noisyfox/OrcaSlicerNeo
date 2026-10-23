/** Host-neutral capabilities. Account identity and credentials remain provider-owned. */
export type ProviderId = string & { readonly __idKind: 'provider' };
export interface ServiceProvider {
  readonly id: ProviderId;
  readonly name: string;
}
export interface AccountError {
  code: 'unavailable' | 'authentication' | 'network' | 'invalid-setting' | 'busy';
  /** Safe for presentation; never include native payloads or credentials. */
  message: string;
}
export type AccountResult<T> = { ok: true; value: T } | { ok: false; error: AccountError };
export interface AccountSummary {
  displayName: string;
  avatarUrl: string | null;
}
export type AccountState =
  | { status: 'unavailable'; error: AccountError }
  | { status: 'restoring' | 'signed-out' | 'signing-in'; error: AccountError | null }
  | { status: 'signed-in'; account: AccountSummary; error: AccountError | null };
/** Non-secret provider settings, e.g. the provider's login region. */
export interface AccountSetting {
  key: string;
  label: string;
  value: string;
  choices: readonly [{ value: string; label: string }, ...{ value: string; label: string }[]];
}
export interface ProviderAccount {
  /** Local state; reading it does not start login. */
  getState(): Promise<AccountState>;
  /** State invalidation only. Subscribe before reading; unsubscribe does not log out. */
  onStateChanged(listener: () => void): () => void;
  /** Open/focus provider-owned login UI. Completion is reported through account state. */
  login(): Promise<AccountResult<void>>;
  logout(): Promise<AccountResult<void>>;
  getSettings(): Promise<readonly AccountSetting[]>;
  /** Provider validates values and handles any required logout before applying a change. */
  setSetting(key: string, value: string): Promise<AccountResult<void>>;
}
export interface AccountProvider extends ServiceProvider {
  readonly account: ProviderAccount;
}
