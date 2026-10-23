/** Private main ↔ utility protocol. Never exposed through the application preload. */
import type { AccountResult } from '@orca/service-provider';
export type LoginCompletion =
  | { kind: 'ticket'; ticket: string; autotestToken?: string }
  | { kind: 'user'; data: Record<string, unknown>; autotestToken?: string }
  | { kind: 'tokens'; token: string; refresh: string; expires: string; refreshExpires: string };
export interface BambuHostInputs {
  'printers.refresh': null;
  'login.begin': null;
  'login.command': { attempt: number };
  'login.prepare': { attempt: number; completion: LoginCompletion };
  'login.complete': { attempt: number };
  'login.cancel': { attempt: number };
  'login.fail': { attempt: number };
  'account.logout': null;
  'account.setting': { key: string; value: string };
}
export interface BambuHostResults {
  'printers.refresh': AccountResult<void>;
  'login.begin': { attempt: number; url: string };
  'login.command': string;
  'login.prepare': AccountResult<void>;
  'login.complete': AccountResult<void>;
  'login.cancel': AccountResult<void>;
  'login.fail': AccountResult<void>;
  'account.logout': AccountResult<void>;
  'account.setting': AccountResult<void>;
}
export type BambuHostMethod = keyof BambuHostInputs;
export type BambuHostRequest = { [K in BambuHostMethod]: { method: K; input: BambuHostInputs[K] } }[BambuHostMethod];
export function isBambuHostRequest(value: unknown): value is BambuHostRequest {
  if (!value || typeof value !== 'object') return false;
  const { method, input } = value as BambuHostRequest;
  if (method === 'printers.refresh' || method === 'login.begin' || method === 'account.logout') return input === null;
  if (!input || typeof input !== 'object') return false;
  if (method === 'account.setting') return typeof input.key === 'string' && typeof input.value === 'string';
  if (!['login.command', 'login.prepare', 'login.complete', 'login.cancel', 'login.fail'].includes(method) || !('attempt' in input) || !Number.isSafeInteger(input.attempt)) return false;
  if (method !== 'login.prepare') return true;
  const c = input.completion;
  return Boolean(c && typeof c === 'object' && (
    (c.kind === 'ticket' && typeof c.ticket === 'string' && c.ticket.length > 0)
    || (c.kind === 'user' && c.data && typeof c.data === 'object' && !Array.isArray(c.data))
    || (c.kind === 'tokens' && [c.token, c.refresh, c.expires, c.refreshExpires].every(v => typeof v === 'string') && c.token.length > 0)));
}
