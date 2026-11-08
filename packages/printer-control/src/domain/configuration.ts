/** Agent-owned local configuration forms. Explicit reads may contain credentials. */
import type { Id, Result, TargetRequest } from './common';
import type { ConfiguredPrinterModel } from './printer';

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
