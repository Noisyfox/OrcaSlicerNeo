import type * as D from '@orca/printer-control/domain';
import type { TelemetryProjection } from './telemetry';
import type { Report } from './protocol';

/** Shared host-private contracts. No feature implementation or device owner imports. */
export interface BambuDeviceContext extends TelemetryProjection { target: D.PrinterTarget; configurationRevision: string; model: string | null }
export interface BambuObjectSkippingContext { snapshot: D.PrintObjectSnapshot; labels: ReadonlyMap<D.Id<'print-object'>, number> }
export interface BambuRecoveryContext extends BambuDeviceContext { recovery: { action: D.PrinterAction; command: PreparedCommand }[] }
export interface CommandContext extends BambuDeviceContext { objectSkipping?: BambuObjectSkippingContext; recovery?: BambuRecoveryContext['recovery'] }
export interface PreparedProtocolCommand {
  label: string; section: 'print' | 'system'; fields: Report; qos: number;
  /** Only explicit report predicates confirm completion; without one, ACK ends tracking as accepted. */
  confirmed?: (next: TelemetryProjection) => boolean;
}
export interface PreparedCommand {
  commands: readonly [PreparedProtocolCommand, ...PreparedProtocolCommand[]];
  continueOnFailure: boolean;
}
