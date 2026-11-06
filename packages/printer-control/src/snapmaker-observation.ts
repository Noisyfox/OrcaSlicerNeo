/** U1 object normalization. Missing device data stays unknown, including load state. */
import type * as D from './domain';
import { record, fail } from './moonraker-http';

const id = <K extends string>(value: string) => value as D.Id<K>;
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
export const u1ToolId = (index: number) => id<'tool'>(`snapmaker-tool:${index}`);
export const u1PathId = (index: number) => id<'path'>(`snapmaker-path:${index}`);

/** SnapmakerPrinterAgent::combine_filament_type, including its base-PLA default. */
export function u1FilamentType(type: string | null, subtype: string | null): string {
  const base = type?.trim().toUpperCase() || 'PLA';
  if (!type?.trim()) return base;
  const sub = subtype?.trim().toUpperCase();
  if (sub === 'CF' || sub === 'GF') return `${base}-${sub}`;
  if (sub === 'SNAPSPEED' || sub === 'HS') return `${base} HIGH SPEED`;
  if (sub && ['SILK', 'WOOD', 'MATTE', 'MARBLE'].includes(sub)) return `${base} ${sub}`;
  return base;
}
export interface FilamentMatchInput { manufacturer: string; materialType: string; colorRgba: string }
export type FilamentMatcher = (materials: readonly FilamentMatchInput[]) => Promise<readonly (string | null)[]>;
export async function matchU1Materials(inventory: D.MaterialInventory, match: FilamentMatcher): Promise<void> {
  const materials = inventory.state.slots.flatMap(slot => slot.material.kind === 'known' && slot.material.value ? [slot.material.value] : []);
  if (!materials.length) return;
  const ids = await match(materials.map(m => ({ manufacturer: m.manufacturer ?? '', materialType: m.materialType!,
    colorRgba: m.color?.kind === 'solid' ? m.color.rgba : '#FFFFFFFF' })));
  if (ids.length !== materials.length) fail('invalid-request', 'Invalid native filament matching result');
  materials.forEach((material, i) => { material.catalogRefs = ids[i] ? [{ namespace: 'orca-filament', value: ids[i]! }] : []; });
}

export function u1MaterialInventory(status: Record<string, unknown>, target: D.PrinterTarget, revision: string): D.MaterialInventory {
  const config = record(status.print_task_config);
  if (!Object.keys(config).length) fail('unsupported', 'U1 material information is unavailable');
  const now = Date.now();
  const known = <T>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', observedAtMs: null, receivedAtMs: now, sourceRouteId: target.routeId });
  const value = (key: string, i: number): unknown => Array.isArray(config[key]) ? config[key][i] : undefined;
  const text = (key: string, i: number) => {
    const item = value(key, i);
    return typeof item === 'string' && item.trim() && item !== 'NONE' ? item : null;
  };
  const heads = [0, 1, 2, 3];
  const topology: D.MaterialTopology = {
    units: heads.map(i => ({ id: id<'material-unit'>(`snapmaker-holder:${i}`), name: `Toolhead ${i + 1}`, kind: 'manual-holder', sensorIds: [] })),
    slots: heads.map(i => ({ id: id<'slot'>(`snapmaker-slot:${i}`), unitId: id<'material-unit'>(`snapmaker-holder:${i}`), name: `Filament ${i + 1}` })),
    paths: heads.map(i => ({ id: u1PathId(i), slotId: id<'slot'>(`snapmaker-slot:${i}`), toolId: u1ToolId(i), loading: 'automatic' })), dryers: [],
  };
  return { topologyRevision: revision, topology, toolIds: heads.map(u1ToolId), state: {
    inventoryRevision: JSON.stringify([revision, status]),
    slots: heads.map(i => {
      const present = value('filament_exist', i);
      const type = text('filament_type', i);
      const subtype = text('filament_sub_type', i);
      const color = text('filament_color_rgba', i);
      const vendor = text('filament_vendor', i);
      const metadata: D.MaterialMetadata = {
        materialType: u1FilamentType(type, subtype),
        manufacturer: vendor,
        color: { kind: 'solid', rgba: color ? `#${color}` : '#FFFFFFFF' },
        diameterMm: null, nozzleTemperatureRangeC: null, presetRef: null, catalogRefs: [],
      };
      return { slotId: topology.slots[i].id,
        presence: typeof present === 'boolean' ? known(present ? 'present' as const : 'empty' as const) : unknown,
        material: present === true ? known(metadata) : present === false ? known(null) : unknown,
        remaining: unknown, spoolIdentity: unknown };
    }),
    tools: heads.map(i => {
      const sensor = record(status[`filament_motion_sensor e${i}_filament`]);
      const loaded = sensor.enabled === true && typeof sensor.filament_detected === 'boolean' ? sensor.filament_detected : null;
      const feed = record(record(status[`filament_feed ${i < 2 ? 'left' : 'right'}`])[`extruder${i}`]);
      const stage = typeof feed.channel_state === 'string' ? feed.channel_state : '';
      const activity: D.MaterialState['tools'][number]['activity'] = !stage ? unknown : known(stage.endsWith('_fail') ? 'error' : stage.startsWith('load_') && stage !== 'load_finish' ? 'loading' : stage.startsWith('unload_') && stage !== 'unload_finish' ? 'unloading' : 'idle');
      return { toolId: u1ToolId(i), selectedPathId: unknown,
        loadedPathId: loaded === null ? unknown : known(loaded ? u1PathId(i) : null), activity };
    }), dryers: [],
  } };
}
