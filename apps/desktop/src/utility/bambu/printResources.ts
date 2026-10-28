import m0 from '../../../../../packages/slicer-wasm/cpp/resources/printers/BL-P001.json';
import m1 from '../../../../../packages/slicer-wasm/cpp/resources/printers/BL-P002.json';
import m2 from '../../../../../packages/slicer-wasm/cpp/resources/printers/C11.json';
import m3 from '../../../../../packages/slicer-wasm/cpp/resources/printers/C12.json';
import m4 from '../../../../../packages/slicer-wasm/cpp/resources/printers/C13.json';
import m5 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N1.json';
import m6 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N2S.json';
import m7 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N6.json';
import m8 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N7.json';
import m9 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N9.json';
import m10 from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1C.json';
import m11 from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1C2.json';
import m12 from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1D.json';
import m13 from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1E.json';
import m14 from '../../../../../packages/slicer-wasm/cpp/resources/printers/O1S.json';
import ids from '../../../../../packages/slicer-wasm/cpp/resources/printers/bambu_filament_ids.json';
import blacklist from '../../../../../packages/slicer-wasm/cpp/resources/printers/filaments_blacklist.json';
import nozzleInfo from '../../../../../packages/slicer-wasm/cpp/resources/info/nozzle_info.json';
import { record, type Report } from './telemetry';
const models: Record<string, unknown> = {'BL-P001': m0, 'BL-P002': m1, 'C11': m2, 'C12': m3, 'C13': m4, 'N1': m5, 'N2S': m6, 'N6': m7, 'N7': m8, 'N9': m9, 'O1C': m10, 'O1C2': m11, 'O1D': m12, 'O1E': m13, 'O1S': m14};
function merge(base: Report, patch: Report): Report {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(record(result[key]), record(value)) : value;
  return result;
}
export function printerPrintProfile(model: string | null, version = '00.00.00.00'): Report {
  const canonical = Object.keys(models).find(key => key === model || record(record(models[key])['00.00.00.00']).display_name === model || String(record(record(models[key])['00.00.00.00']).display_name).replace('Bambu Lab ', '') === model);
  let result: Report = {};
  for (const [key, patch] of Object.entries(record(models[canonical ?? ''])).sort(([a], [b]) => a.localeCompare(b)))
    if (key <= version) result = merge(result, record(patch));
  return result;
}
export const filamentCatalog = ids.filaments as Record<string, { bambu_id: string; name: string; type: string; vendor: string }>;
export const printerFilamentId = (id: string) => filamentCatalog[id]?.bambu_id ?? id;
export const filamentRules = blacklist.blacklist as Report[];
export const nozzleHardness = nozzleInfo.nozzle_hrc as Record<string, number>;
