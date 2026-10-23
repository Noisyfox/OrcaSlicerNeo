import type * as D from '@orca/printer-control/domain';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length < 1024;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);
export function isBambuCommandPayload(value: unknown): value is D.PrinterCommand {
  if (!object(value) || !exact(value, ['type', 'params']) || !object(value.params)) return false;
  const p = value.params;
  switch (value.type) {
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
