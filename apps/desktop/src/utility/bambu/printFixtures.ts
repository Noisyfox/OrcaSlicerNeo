/** Deterministic print fixtures; no network or physical-device acceptance implied. */
import type * as D from '@orca/printer-control/domain';
import { BambuTelemetry, id } from './telemetry';
export const printTarget: D.PrinterTarget = { printerId: id('bambu:fixture'), routeId: id('bambu:fixture:agent') };
export const printRequirements: D.PrintRequirements = {
  contentId: 'plate-1:revision-1:generation-1', plateId: 'plate-1', printerModel: 'Bambu Lab H2D', printerModelId: 'O1D',
  nozzleDiameters: [.4, .4], nozzleFlowTypes: ['Standard', 'Standard'], filamentMap: [2, 1, 1], requiresDynamicMapping: false, bedType: 'High Temp Plate', durationSeconds: 100, layerCount: 50, weightGrams: 2, timelapseWarningCode: 0, toolpathOutside: false, warnings: [],
  materials: [0, 2].map((index, i) => ({ key: `filament-${index}`, index, toolIndex: i ? 0 : 1, type: 'PLA', color: i ? '#00FF00' : '#FF0000', presetId: 'OFDSrzZ8', presetName: 'Generic PLA', brand: 'Generic', nozzleDiameter: .4, nozzleFlowType: 'Standard', requiredNozzleHardness: 3, usedGrams: 1, usedMeters: .3 })),
};
export function printContext(patch: Record<string, unknown> = {}) {
  const telemetry = new BambuTelemetry();
  const report = { msg: 0, gcode_state: 'IDLE', cfg: '0', fun: ((1n << 7n) | (1n << 28n) | (1n << 48n)).toString(16), aux: '1000', stat: '0', fun2: '8',
    device: { type: 1, extruder: { state: 0x12, info: [{ id: 0, hnow: 0, temp: 25 }, { id: 1, hnow: 1, temp: 25 }] }, nozzle: { info: [{ id: 0, type: '0S01', diameter: .4 }, { id: 1, type: '0S01', diameter: .4 }] } },
    ams: { tray_exist_bits: '11', ams: [{ id: 0, info: '1', tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000FF' }] }, { id: 1, info: '101', tray: [{ id: 0, tray_type: 'PLA', tray_color: '00FF00FF' }] }] },
    vir_slot: [{ id: 255, tray_type: 'PETG' }, { id: 254, tray_type: 'PLA' }], ...patch };
  telemetry.accept(JSON.stringify({ print: { command: 'push_status', ...report } }));
  const identity: D.PrinterIdentity = { id: printTarget.printerId, displayName: 'H2D', manufacturer: 'Bambu Lab', model: 'O1D', serialNumber: 'fixture', externalRefs: [] };
  return { ...telemetry.project(printTarget, identity), target: printTarget, model: 'O1D', configurationRevision: 'r1' };
}
export const printRequest = (): D.PrintPreparationRequest => ({ target: { ...printTarget, expectedConfigurationRevision: 'r1' }, requirements: structuredClone(printRequirements), options: { timelapse: false }, bindings: [], suggest: true, allowAbnormalStorage: false });
