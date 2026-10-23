import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type { AccountProvider, AccountResult, AccountSetting, AccountState } from '@orca/service-provider';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function AccountAvatar({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground">
    {url && !failed
      ? <img src={url} alt="Account avatar" className="size-full object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <UserRound aria-label="Default account avatar" role="img" className="size-5" />}
  </div>;
}

function AccountCard({ provider }: { provider: AccountProvider }) {
  const [state, setState] = useState<AccountState>({ status: 'restoring', error: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true; let generation = 0;
    const read = () => {
      const current = ++generation;
      void provider.account.getState().then(value => { if (live && current === generation) { setState(value); setError(null); } })
        .catch(() => { if (live && current === generation) setState({ status: 'unavailable', error: { code: 'unavailable', message: 'Account service is unavailable.' } }); });
    };
    const stop = provider.account.onStateChanged(read); read();
    return () => { live = false; stop(); };
  }, [provider]);
  const run = async (action: () => Promise<AccountResult<void>>) => {
    setBusy(true); setError(null);
    try { const result = await action(); if (!result.ok) setError(result.error.message); }
    catch { setError('The account request failed. Please try again.'); }
    finally { setBusy(false); }
  };
  return <section aria-label={`${provider.name} account`} className="rounded-xl border border-border p-4">
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {state.status === 'signed-in' && <AccountAvatar key={state.account.avatarUrl} url={state.account.avatarUrl} />}
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{state.status === 'signed-in' ? state.account.displayName : provider.name}</h2>
          <p className="truncate text-sm text-muted-foreground" role="status">
            {state.status === 'signed-in' ? provider.name : state.status === 'restoring' ? 'Restoring account…'
              : state.status === 'signing-in' ? 'Complete sign in in the login window or browser.' : state.status === 'unavailable' ? 'Unavailable' : 'Not signed in'}
          </p>
        </div>
      </div>
      {state.status === 'signed-in'
        ? <Button variant="outline" disabled={busy} onClick={() => void run(() => provider.account.logout())}>Sign out</Button>
        : <Button variant="outline" disabled={busy || state.status === 'restoring' || state.status === 'unavailable'} onClick={() => void run(() => provider.account.login())}>
          {state.status === 'signing-in' ? 'Show login' : `Sign in to ${provider.name}`}</Button>}
    </div>
    {(error || state.error) && <p role="alert" className="mt-2 text-sm text-destructive">{error ?? state.error?.message}</p>}
  </section>;
}
export function HomeAccounts() {
  const { accounts } = usePlatform();
  return accounts.length ? <div className="space-y-3">{accounts.map(provider => <AccountCard key={provider.id} provider={provider} />)}</div> : null;
}
function ProviderSettings({ provider }: { provider: AccountProvider }) {
  const [settings, setSettings] = useState<readonly AccountSetting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true; let generation = 0;
    const read = () => { const current = ++generation; void provider.account.getSettings().then(value => { if (live && current === generation) setSettings(value); })
      .catch(() => { if (live && current === generation) setError('Account settings are unavailable.'); }); };
    const stop = provider.account.onStateChanged(read); read();
    return () => { live = false; stop(); };
  }, [provider]);
  const change = async (key: string, value: string) => {
    setBusy(true); setError(null);
    try {
      const result = await provider.account.setSetting(key, value);
      if (!result.ok) setError(result.error.message);
      else setSettings(await provider.account.getSettings());
    } catch { setError('The account setting could not be changed.'); }
    finally { setBusy(false); }
  };
  return <section aria-label={`${provider.name} settings`} className="space-y-2 border-t pt-4">
    <h3 className="text-sm font-medium">{provider.name}</h3>
    {settings.map(setting => <div key={setting.key} className="space-y-1">
      <label className="text-sm" htmlFor={`account-${provider.id}-${setting.key}`}>{setting.label}</label>
      <Select value={setting.value} items={setting.choices} disabled={busy} onValueChange={value => { if (value !== null) void change(setting.key, value); }}>
        <SelectTrigger id={`account-${provider.id}-${setting.key}`} aria-label={`${provider.name} ${setting.label}`}><SelectValue /></SelectTrigger>
        <SelectContent>{setting.choices.map(choice => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>)}
    <p className="text-xs text-muted-foreground">Account settings apply immediately. Changing region signs out the current account.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
export function AccountSettings() {
  const { accounts } = usePlatform();
  return <>{accounts.map(provider => <ProviderSettings key={provider.id} provider={provider} />)}</>;
}
