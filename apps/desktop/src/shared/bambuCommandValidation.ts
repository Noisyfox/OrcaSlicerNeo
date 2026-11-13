import { isStorageFileRef } from './bambuStorage';
import { isPrintOptions } from './bambuSubmission';
import type * as D from '@orca/platform-contract';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length < 1024;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);
export function isPrintObjectContextRef(value: unknown): value is D.PrintObjectContextRef {
  return object(value) && exact(value, ['printerId', 'routeId', 'configurationRevision', 'taskId', 'token']) && Object.values(value).every(text);
}
export function isBambuCommandPayload(value: unknown): value is D.PrinterCommand {
  if (!object(value) || !exact(value, ['type', 'params']) || !object(value.params)) return false;
  const p = value.params;
  switch (value.type) {
    case 'jobs.start': return Object.keys(p).every(k => ['source', 'inspection', 'bindings', 'options', 'acknowledgedIssues', 'allowAbnormalStorage'].includes(k)) &&
      isStorageFileRef(p.source) && object(p.inspection) && exact(p.inspection, ['id', 'targetId']) && text(p.inspection.id) && text(p.inspection.targetId) &&
      Array.isArray(p.bindings) && p.bindings.length <= 64 && p.bindings.every(b => object(b) && exact(b, ['materialKey', 'pathId']) && text(b.materialKey) && text(b.pathId)) &&
      (p.options === undefined || isPrintOptions(p.options)) && (p.allowAbnormalStorage === undefined || typeof p.allowAbnormalStorage === 'boolean') &&
      (p.acknowledgedIssues === undefined || Array.isArray(p.acknowledgedIssues) && p.acknowledgedIssues.length <= 256 && p.acknowledgedIssues.every(text));
    case 'files.delete': return exact(p, ['target']) && isStorageFileRef(p.target);
    case 'materials.configure': {
      if (!text(p.slotId) || !Array.isArray(p.acknowledgedWarningIds) || p.acknowledgedWarningIds.length > 128 || !p.acknowledgedWarningIds.every(text)) return false;
      if (p.intent === 'reset') return exact(p, ['slotId', 'intent', 'acknowledgedWarningIds']);
      if (p.intent !== 'confirm' || !exact(p, ['slotId', 'intent', 'preset', 'color', 'acknowledgedWarningIds'])
        || !(p.color === null || object(p.color) && exact(p.color, ['kind', 'rgba']) &&
          (p.color.kind === 'solid' && typeof p.color.rgba === 'string' && /^#[\da-fA-F]{8}$/.test(p.color.rgba)
            || p.color.kind === 'gradient' && Array.isArray(p.color.rgba) && p.color.rgba.length >= 2 && p.color.rgba.length <= 4
              && p.color.rgba.every((color: unknown) => typeof color === 'string' && /^#[\da-fA-F]{8}$/.test(color))))) return false;
      if (p.preset === null) return true;
      const preset = p.preset;
      const ref = (value: unknown) => object(value) && exact(value, ['namespace', 'value']) && text(value.namespace) && text(value.value);
      return object(preset) && exact(preset, ['key', 'label', 'materialType', 'manufacturer', 'catalogRefs', 'presetRef', 'nozzleTemperatureRangeC'])
        && text(preset.key) && text(preset.label) && text(preset.materialType) && (preset.manufacturer === null || text(preset.manufacturer))
        && Array.isArray(preset.catalogRefs) && preset.catalogRefs.length > 0 && preset.catalogRefs.length <= 16 && preset.catalogRefs.every(ref)
        && (preset.presetRef === null || ref(preset.presetRef)) && (preset.nozzleTemperatureRangeC === null || object(preset.nozzleTemperatureRangeC)
          && exact(preset.nozzleTemperatureRangeC, ['min', 'max']) && finite(preset.nozzleTemperatureRangeC.min) && finite(preset.nozzleTemperatureRangeC.max));
    }
    case 'jobs.skipObjects': return exact(p, ['contextRef', 'objectIds', 'intent']) && isPrintObjectContextRef(p.contextRef)
      && Array.isArray(p.objectIds) && p.objectIds.length > 0 && p.objectIds.length <= 64 && p.objectIds.every(text)
      && new Set(p.objectIds).size === p.objectIds.length && ['skip-selected', 'cancel-print'].includes(String(p.intent));
    case 'jobs.pause': case 'jobs.resume': case 'jobs.cancel': case 'hardware.refreshNozzles': return exact(p, []);
    case 'jobs.setSpeed': return exact(p, ['modeId']) && text(p.modeId);
    case 'thermal.setTarget': return exact(p, ['heaterId', 'targetC']) && text(p.heaterId) && finite(p.targetC);
    case 'fans.setSpeed': return exact(p, ['fanId', 'speedFraction']) && text(p.fanId) && finite(p.speedFraction);
    case 'lights.set': return exact(p, ['lightId', 'on']) && text(p.lightId) && typeof p.on === 'boolean';
    case 'motion.home': return exact(p, ['motionGroupId', 'axes']) && text(p.motionGroupId) && Array.isArray(p.axes) && p.axes.length > 0 && p.axes.length <= 3 && p.axes.every(axis => ['x', 'y', 'z'].includes(axis)) && new Set(p.axes).size === p.axes.length;
    case 'motion.jog': return text(p.motionGroupId) && ['x', 'y', 'z'].includes(String(p.axis)) && (p.kind === 'step'
      ? exact(p, ['motionGroupId', 'axis', 'kind', 'stepId', 'direction']) && text(p.stepId) && ['positive', 'negative'].includes(String(p.direction))
      : p.kind === 'distance' && exact(p, ['motionGroupId', 'axis', 'kind', 'distanceMm', 'speedMmPerSecond']) && finite(p.distanceMm) && finite(p.speedMmPerSecond));
    case 'extrusion.move': return exact(p, ['extruderId', 'distanceMm', 'speed']) && text(p.extruderId) && finite(p.distanceMm) && object(p.speed)
      && (p.speed.kind === 'device-controlled' ? exact(p.speed, ['kind']) : p.speed.kind === 'specified' && exact(p.speed, ['kind', 'mmPerSecond']) && finite(p.speed.mmPerSecond));
    case 'tools.select': case 'materials.unload': return exact(p, ['toolId']) && text(p.toolId);
    case 'materials.load': case 'materials.switch': return exact(p, ['pathId']) && text(p.pathId);
    case 'actions.invoke': return exact(p, ['actionRef']) && object(p.actionRef) && exact(p.actionRef, ['printerId', 'routeId', 'configurationRevision', 'token']) && Object.values(p.actionRef).every(text);
    default: return false;
  }
}
