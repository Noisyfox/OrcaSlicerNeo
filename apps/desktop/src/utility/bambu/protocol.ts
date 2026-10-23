/** Pinned Orca compatibility defaults, never a source of attached hardware topology. */
import h2d from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1D.json';
import h2dPro from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1E.json';
import { record, type Report } from './telemetry';
export function protocolReport(model: string | null, report: Report): Report {
  const profile = model === 'O1D' || model === 'H2D' || model === 'Bambu Lab H2D' ? h2d
    : model === 'O1E' || model === 'H2D Pro' || model === 'Bambu Lab H2D Pro' ? h2dPro : undefined;
  const base = record(record(profile)['00.00.00.00']);
  // Actual reports/manifest override reference defaults, including explicit false.
  return { ...record(base.print), ...report, ...record(record(report.capabilities).flags) };
}
