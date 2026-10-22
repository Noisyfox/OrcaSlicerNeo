import type { AccountProvider, AccountState, ServiceProvider } from '../src';
declare const provider: AccountProvider;
const identity: ServiceProvider = provider;
void identity;
void provider.account.login();
void provider.account.logout();
void provider.account.setSetting('region', 'Others');
function present(state: AccountState) {
  if (state.status === 'signed-in') {
    const name: string = state.account.displayName;
    // @ts-expect-error Provider credentials are not account presentation data.
    state.account.token;
    return name;
  }
  // @ts-expect-error Logged-out and restoring states have no account summary.
  state.account;
}
void present;
// @ts-expect-error Account-only services do not require printer functionality.
provider.printers;
