import type * as D from '@orca/printer-control/domain';
import { id } from './telemetry';
/** Slice indices are left-to-right; Bambu's physical main tool is on the right. */
export const physicalTool = (index: number, count: number) => count === 2 ? 1 - index : index;
export const known = <T>(reading: D.Reading<T>) => reading.kind === 'known' && reading.freshness === 'fresh' ? reading.value : undefined;
export const sameType = (a: string | null | undefined, b: string) => !!a && a.toUpperCase() === b.toUpperCase();
function lab(color: string): number[] | null {
  if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) return null;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92);
  const [x, y, z] = [(r * .4124 + g * .3576 + b * .1805) / .95047, r * .2126 + g * .7152 + b * .0722, (r * .0193 + g * .1192 + b * .9505) / 1.08883].map(v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** Orca GuiColor::calc_color_distance uses CIE76, not RGB distance. */
function distance(a: string, b: string | null): number {
  const first = lab(a), second = b && lab(b);
  if (!first || !second) return Infinity;
  if ((a.slice(7) || 'FF').toUpperCase() !== (b!.slice(7) || 'FF').toUpperCase()) return Infinity;
  return Math.hypot(...first.map((v, i) => v - second[i]));
}
export function mapMaterials(request: D.PrintPreparationRequest, inventory: D.MaterialInventory) {
  const candidates: D.PrintPreparation['candidates'][number][] = [];
  const bindings = request.suggest ? [] : [...request.bindings];
  const issues: D.PrintIssue[] = [];
  const paths = inventory.topology.paths;
  const external = (path: D.MaterialPath) => inventory.topology.units.find(unit => unit.id === inventory.topology.slots.find(slot => slot.id === path.slotId)?.unitId)?.kind === 'manual-holder';
  for (const material of request.requirements.materials) {
    const tool = id<'tool'>(`tool:${physicalTool(material.toolIndex, request.requirements.nozzleDiameters.length)}`);
    const legal = paths.filter(path => path.toolId === tool).filter(path => {
      const slot = inventory.state.slots.find(s => s.slotId === path.slotId);
      return !!slot && (external(path) || known(slot.presence) === 'present');
    });
    for (const path of legal) {
      const state = inventory.state.slots.find(slot => slot.slotId === path.slotId)!;
      const metadata = known(state.material);
      if (!external(path) && metadata?.materialType && !sameType(metadata.materialType, material.type)) continue;
      const slot = inventory.topology.slots.find(slot => slot.id === path.slotId)!;
      const unit = inventory.topology.units.find(unit => unit.id === slot.unitId)!;
      const color = metadata?.color?.kind === 'solid' ? metadata.color.rgba : metadata?.color?.rgba[0] ?? null;
      candidates.push({ materialKey: material.key, pathId: path.id, label: `${unit.name} · ${slot.name}`, color, materialType: metadata?.materialType ?? null });
    }
    if (request.suggest) {
      const choices = candidates.filter(c => c.materialKey === material.key && sameType(c.materialType, material.type));
      const ams = choices.filter(c => !external(paths.find(p => p.id === c.pathId)!));
      const nearest = (ams.length ? ams : choices).sort((a, b) => distance(material.color, a.color) - distance(material.color, b.color))[0];
      const holders = legal.filter(external);
      const pathId = nearest?.pathId ?? (holders.length === 1 ? holders[0].id : undefined);
      if (pathId) bindings.push({ materialKey: material.key, pathId });
    }
    const selection = bindings.find(b => b.materialKey === material.key);
    const path = selection && legal.find(p => p.id === selection.pathId);
    if (!path) { issues.push({ id: `mapping:${material.key}`, materialKey: material.key, severity: 'block', message: 'Choose an occupied, reachable material source.' }); continue; }
    const metadata = known(inventory.state.slots.find(s => s.slotId === path.slotId)!.material);
    if (!metadata?.materialType) issues.push({ id: `unknown-material:${path.id}`, materialKey: material.key, severity: 'warning', message: 'Material type is unknown and cannot be checked.' });
    else if (!sameType(metadata.materialType, material.type)) issues.push({ id: `material-type:${path.id}:${metadata.materialType}:${material.type}`, materialKey: material.key,
      severity: external(path) ? 'warning' : 'block', message: `Source contains ${metadata.materialType}; the slice requires ${material.type}.` });
    if (!external(path) && bindings.some(other => paths.find(p => p.id === other.pathId)?.slotId === path.slotId && request.requirements.materials.some(m => m.key === other.materialKey && !sameType(m.type, material.type))))
      issues.push({ id: `reuse:${path.id}`, severity: 'block', message: 'AMS source reuse requires the same material type.' });
  }
  if (new Set(bindings.map(b => b.materialKey)).size !== bindings.length || bindings.some(b => !request.requirements.materials.some(m => m.key === b.materialKey)))
    issues.push({ id: 'invalid-bindings', severity: 'block', message: 'Material bindings do not match this slice.' });
  return { candidates, bindings, issues, external };
}
