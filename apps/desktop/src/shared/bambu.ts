import type { AccountSetting, AccountState } from '@orca/service-provider';
import type { Result, SavedPrinter } from '@orca/printer-control/domain';

export const BAMBU_REGIONS = ['China', 'AsiaPacific', 'NorthAmerica', 'Europe', 'Others'] as const;
export type BambuRegion = typeof BAMBU_REGIONS[number];
export type BambuRead = 'account.state' | 'account.settings' | 'printers.saved';
export type BambuChange = 'account' | 'printers';
export interface BambuReadResults {
  'account.state': AccountState;
  'account.settings': readonly AccountSetting[];
  'printers.saved': Result<readonly SavedPrinter[]>;
}
export interface BambuBridge {
  read<K extends BambuRead>(request: K): Promise<BambuReadResults[K]>;
  onChanged(listener: (change: BambuChange) => void): () => void;
}
/** Only main supplies these paths; neither the app renderer nor a login page can choose them. */
export interface BambuHostConfig {
  addonPath: string;
  pluginPath: string;
  directory: string;
  certificateDirectory: string;
  osType: 'windows' | 'windows_arm' | 'macos' | 'linux';
  osVersion: string;
}
export function isBambuRead(value: unknown): value is BambuRead {
  return value === 'account.state' || value === 'account.settings' || value === 'printers.saved';
}
export function isBambuChange(value: unknown): value is BambuChange { return value === 'account' || value === 'printers'; }
export function unavailableBambuAccount(): AccountState {
  return { status: 'unavailable', error: { code: 'unavailable', message: 'Bambu networking is unavailable.' } };
}
export function isBambuReadResult(kind: BambuRead, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (kind === 'account.state') {
    if (object.status === 'signed-in') {
      const account = object.account as Record<string, unknown> | undefined;
      return Boolean(account && typeof account.displayName === 'string' && (account.avatarUrl === null || typeof account.avatarUrl === 'string') && object.error === null
        && Object.keys(account).every(key => key === 'displayName' || key === 'avatarUrl')
        && Object.keys(object).every(key => ['status', 'account', 'error'].includes(key)));
    }
    if (object.status === 'signed-out' || object.status === 'restoring' || object.status === 'signing-in') return object.error === null && Object.keys(object).every(key => key === 'status' || key === 'error');
    return object.status === 'unavailable' && JSON.stringify(value) === JSON.stringify(unavailableBambuAccount());
  }
  if (kind === 'account.settings') return Array.isArray(value) && value.length === 1 && object[0] !== null
    && JSON.stringify((value as AccountSetting[])[0]?.choices) === JSON.stringify(bambuRegionChoices)
    && (value as AccountSetting[])[0]?.key === 'region' && (value as AccountSetting[])[0]?.label === 'Region'
    && BAMBU_REGIONS.includes((value as AccountSetting[])[0]?.value as BambuRegion)
    && Object.keys((value as AccountSetting[])[0]).every(key => ['key', 'label', 'value', 'choices'].includes(key));
  // No printer publication until the Cloud/LAN implementation increments.
  return object.ok === true && Array.isArray(object.value) && object.value.length === 0 && Object.keys(object).every(key => key === 'ok' || key === 'value');
}
export const bambuRegionChoices = BAMBU_REGIONS.map(value => ({ value, label: ({ AsiaPacific: 'Asia Pacific', NorthAmerica: 'North America' } as Record<string, string>)[value] ?? value })) as [AccountSetting['choices'][0], ...AccountSetting['choices'][0][]];
