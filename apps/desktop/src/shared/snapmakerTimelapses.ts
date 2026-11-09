import type { U1TimelapsePage } from '@orca/printer-control';
import type { Result } from '@orca/printer-control/domain';

type Scope = { printerId: string; configurationDigest: string };

export interface SnapmakerTimelapseCalls {
  list: { input: Scope & { id: string; page: number; rows: number }; output: Result<U1TimelapsePage> };
  open: { input: Scope & { video: string }; output: Result<{ id: string; url: string }> };
  delete: { input: Scope & { dateIndex: string }; output: Result<null> };
  cancel: { input: { id: string }; output: Result<null> };
  close: { input: { id: string }; output: Result<null> };
}
export interface SnapmakerTimelapseBridge {
  call<K extends keyof SnapmakerTimelapseCalls>(method: K, input: SnapmakerTimelapseCalls[K]['input']): Promise<SnapmakerTimelapseCalls[K]['output']>;
}
