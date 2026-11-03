import type { OrcaModule } from './types';

/** Agent-facing Orca metadata, not a shared printer-domain format. No live
 * project or retained-slice receipt is created by remote inspection. */
export interface RemotePrintMetadata {
  configuration: Record<string, string | boolean | string[] | number[]>;
  targets: Array<{
    plateIndex: number;
    gcodePath: string;
    thumbnailPath: string;
    printerModelId: string;
    nozzleDiameters: string;
    nozzleFlowTypes: string;
    filamentMap: number[];
    duration: string;
    weight: string;
    toolpathOutside: boolean;
    configuration: RemotePrintMetadata['configuration'];
    materials: Array<{
      index: number; type: string; color: string; presetId: string; brand: string;
      usedGrams: number; usedMeters: number; nozzleDiameter: number; nozzleFlowType: string;
    }>;
    warnings: Array<{ message: string; code: string }>;
  }>;
}

export const REMOTE_PRINT_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

/** Only call inside an isolated Worker. This intentionally bypasses createClient
 * initialization: remote metadata must not need or activate installed presets. */
export function inspectRemotePrintBundle(module: OrcaModule, bytes: Uint8Array): RemotePrintMetadata {
  if (!bytes.byteLength || bytes.byteLength > REMOTE_PRINT_BUNDLE_MAX_BYTES) {
    throw new Error('Inspection bundle exceeds its size limit');
  }
  const input = module._malloc(bytes.byteLength);
  if (!input) throw new Error('Cannot allocate inspection bytes');
  let output = 0;
  try {
    module.HEAPU8.set(bytes, input);
    output = Number(module.ccall('orc_inspect_remote_print', 'number', ['string'],
      [JSON.stringify({ pointer: input, length: bytes.byteLength })]));
    if (!output) throw new Error('Cannot allocate inspection result');
    const result = JSON.parse(module.UTF8ToString(output)) as RemotePrintMetadata & { ok: boolean; error?: string };
    if (!result.ok) throw new Error(result.error || 'Sliced-3MF inspection failed');
    return { configuration: result.configuration, targets: result.targets };
  } finally {
    if (output) module._free(output);
    module._free(input);
  }
}
