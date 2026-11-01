/** Host-private protocol decoding and pinned Orca compatibility defaults. */
import h2d from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1D.json';
import h2dPro from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1E.json';
import type * as D from '@orca/printer-control/domain';

/** Shared protocol field decoding; independent of telemetry and resource lookup. */
export type Report = Record<string, unknown>;
export const record = (value: unknown): Report => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Report : {};
export const records = (value: unknown): Report[] => Array.isArray(value) ? value.map(record) : [];
export const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : undefined;
export const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^\d+$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
export const id = <K extends string>(value: string) => value as D.Id<K>;
export const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
/** Compatibility defaults never establish attached hardware topology. */
export function protocolReport(model: string | null, report: Report): Report {
  const profile = model === 'O1D' || model === 'H2D' || model === 'Bambu Lab H2D' ? h2d
    : model === 'O1E' || model === 'H2D Pro' || model === 'Bambu Lab H2D Pro' ? h2dPro : undefined;
  const base = record(record(profile)['00.00.00.00']);
  // Actual reports/manifest override reference defaults, including explicit false.
  return { ...record(base.print), ...report, ...record(record(report.capabilities).flags) };
}
