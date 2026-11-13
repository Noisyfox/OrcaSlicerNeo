/** Agent-owned local configuration forms. Explicit reads may contain credentials. */
import type { Id, Result, TargetRequest } from './common';
import type { ConfiguredPrinterModel } from './printer';
import type { PrintPreferences } from './print-options';

export interface PrinterConfigurationField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'password';
  required: boolean;
  placeholder: string;
  defaultValue: string;
}

export interface PrinterConfigurationForm {
  hostId: Id<'agent-host'>;
  fields: readonly PrinterConfigurationField[];
  supportsModelSelection: boolean;
}

export interface PrinterConfigurationDraft {
  typeId: Id<'printer-type'>;
  displayName: string;
  values: Readonly<Record<string, string>>;
  printerModel: ConfiguredPrinterModel | null;
}

export interface SavePrinterConfigurationRequest extends PrinterConfigurationDraft {
  requestId: Id<'request'>;
  hostId: Id<'agent-host'>;
  /** Null creates a printer. An edit revalidates the original route revision. */
  target: TargetRequest | null;
}

export interface PrinterConfigurations {
  /** Local-only explicit form read. Values must never enter observations or diagnostics. */
  read(target: TargetRequest): Promise<Result<PrinterConfigurationDraft>>;
  /** Validate and persist atomically in the owning agent, without contacting the printer. */
  save(request: SavePrinterConfigurationRequest): Promise<Result<null>>;
}

export const PRINTER_CONFIGURATION_VERSION = 1 as const;
export const BUILT_IN_PRINTER_DRIVER_IDS = ['moonraker', 'snapmaker'] as const;
export type BuiltInPrinterDriverId = typeof BUILT_IN_PRINTER_DRIVER_IDS[number];
export type PrinterDriverId = BuiltInPrinterDriverId;

export interface PrinterConfiguration {
  id: string;
  displayName: string;
  driverId: PrinterDriverId;
  consoleUrl: string;
  apiBaseUrl: string;
  /** Kept complete in the configuration document; never included in errors. */
  apiKey: string;
  /** Omitted means no user-configured model restriction. */
  printerModel?: ConfiguredPrinterModel;
  /** Stable identity learned during explicit discovery/adoption; never a configured profile. */
  discoveredIdentity?: { manufacturer: string; model: string; serialNumber: string };
}

export interface PrinterConfigurationDocument {
  version: typeof PRINTER_CONFIGURATION_VERSION;
  printers: PrinterConfiguration[];
  /** Stable physical printer IDs, including providers without manual connection entries. */
  printPreferences?: Record<string, PrintPreferences>;
  /** Explicit global opt-in matching Orca's abnormal-storage override. */
  allowAbnormalStorage?: boolean;
}
