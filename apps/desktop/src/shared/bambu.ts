import type { AccountError, AccountResult, AccountSetting, AccountState } from '@orca/service-provider';
import { isBambuDevice, type BambuDevice } from './bambuDevices';
import type { Result } from '@orca/printer-control/domain';

export const BAMBU_REGIONS = ['China', 'AsiaPacific', 'NorthAmerica', 'Europe', 'Others'] as const;
export type BambuRegion = typeof BAMBU_REGIONS[number];
export type BambuRead = 'account.state' | 'account.settings' | 'printers.saved';
export type BambuChange = 'account' | 'printers';
export interface BambuReadResults {
  'account.state': AccountState;
  'account.settings': readonly AccountSetting[];
  'printers.saved': Result<readonly BambuDevice[]>;
}
export type BambuCommand = { action: 'printers.refresh' } | { action: 'login' } | { action: 'logout' } | { action: 'setting'; key: string; value: string };
export function isBambuCommand(value: unknown): value is BambuCommand {
  if (!value || typeof value !== 'object') return false;
  const v = value as BambuCommand;
  return v.action === 'printers.refresh' || v.action === 'login' || v.action === 'logout' || (v.action === 'setting' && typeof v.key === 'string' && typeof v.value === 'string');
}
export interface BambuBridge {
  command(request: BambuCommand): Promise<AccountResult<void>>;
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
      return Boolean(account && typeof account.displayName === 'string' && (account.avatarUrl === null || typeof account.avatarUrl === 'string') && isAccountError(object.error)
        && Object.keys(account).every(key => key === 'displayName' || key === 'avatarUrl')
        && Object.keys(object).every(key => ['status', 'account', 'error'].includes(key)));
    }
    if (object.status === 'signed-out' || object.status === 'restoring' || object.status === 'signing-in') return isAccountError(object.error) && Object.keys(object).every(key => key === 'status' || key === 'error');
    return object.status === 'unavailable' && isAccountError(object.error) && object.error !== null && Object.keys(object).every(key => key === 'status' || key === 'error');
  }
  if (kind === 'account.settings') return Array.isArray(value) && value.length === 1 && object[0] !== null
    && JSON.stringify((value as AccountSetting[])[0]?.choices) === JSON.stringify(bambuRegionChoices)
    && (value as AccountSetting[])[0]?.key === 'region' && (value as AccountSetting[])[0]?.label === 'Region'
    && BAMBU_REGIONS.includes((value as AccountSetting[])[0]?.value as BambuRegion)
    && Object.keys((value as AccountSetting[])[0]).every(key => ['key', 'label', 'value', 'choices'].includes(key));
  return object.ok === true && Array.isArray(object.value) && object.value.every(isBambuDevice) && new Set(object.value.map(device => device.deviceId)).size === object.value.length && Object.keys(object).every(key => key === 'ok' || key === 'value');
}
export const bambuRegionChoices = BAMBU_REGIONS.map(value => ({ value, label: ({ AsiaPacific: 'Asia Pacific', NorthAmerica: 'North America' } as Record<string, string>)[value] ?? value })) as [AccountSetting['choices'][0], ...AccountSetting['choices'][0][]];

function isAccountError(value: unknown): value is AccountError | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const error = value as AccountError;
  return ['unavailable', 'authentication', 'network', 'invalid-setting', 'busy'].includes(error.code) && typeof error.message === 'string'
    && Object.keys(value).every(key => key === 'code' || key === 'message');
}
