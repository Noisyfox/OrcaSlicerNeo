import type { FilamentRoutingSelector, FilamentRoutingTargetRequest, FilamentSessionSnapshot, OptionMetadata, SlicerClient } from '@slicer/client';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import type { ScopedConfigurationField, ScopedTargetResolution } from './scopedConfigurationProjection';

const featureOptions = [
  ['outer_wall_filament_id', 'outer-wall', 'Outer walls'],
  ['inner_wall_filament_id', 'inner-wall', 'Inner walls'],
  ['sparse_infill_filament_id', 'sparse-infill', 'Sparse infill'],
  ['internal_solid_filament_id', 'internal-solid-infill', 'Internal solid infill'],
  ['top_surface_filament_id', 'top-surface', 'Top surface'],
  ['bottom_surface_filament_id', 'bottom-surface', 'Bottom surface'],
] as const;

function routingTargets(resolution: ScopedTargetResolution): Required<FilamentRoutingTargetRequest>[] {
  if (resolution.scope !== 'object' && resolution.scope !== 'part') return [];
  return resolution.targets.map(target => ({
    kind: target.scope === 'part' ? 'model-part' : 'object', id: Number(target.id),
  }));
}

export function featureFilamentFields(
  metadata: OptionMetadata, resolution: ScopedTargetResolution, snapshot: FilamentSessionSnapshot | null,
): ScopedConfigurationField[] {
  const targets = routingTargets(resolution);
  if (!snapshot?.routing || targets.length === 0) return [];
  const routeKey = (id: number, selector: FilamentRoutingSelector) => `${id}:${selector}`;
  const selectedIds = new Set(targets.map(target => target.id));
  const routesByKey = new Map(snapshot.routing
    .filter(row => row.target === targets[0].kind && selectedIds.has(row.id))
    .map(row => [routeKey(row.id, row.selector), row]));
  const result: ScopedConfigurationField[] = [];
  for (const [key, selector, label] of featureOptions) {
    const routes = targets.flatMap(target => {
      const route = routesByKey.get(routeKey(target.id, selector));
      return route ? [route] : [];
    });
    // The native session only admits printable model parts and complete selections.
    if (routes.length !== targets.length) continue;
    const values = routes.map(route => route.inherited ? 'inherit' : String(route.explicitSlot));
    const effective = routes[0].effectiveSlot;
    const local = values.some(value => value !== 'inherit');
    const mixed = values.some(value => value !== values[0]);
    result.push({
      key, label, category: 'Filament for Features', meta: metadata[key] ?? { type: 'int' },
      local, mixed, resettable: true, value: values[0],
      source: mixed ? 'mixed' : local ? targets[0].kind === 'model-part' ? 'part' : 'object' : 'project',
      filamentRoute: { selector, effectiveSlot: routes.every(route => route.effectiveSlot === effective) ? effective : null },
    });
  }
  return result;
}

export async function setFeatureFilament(
  runtime: SlicerClient, resolution: ScopedTargetResolution, selector: FilamentRoutingSelector, value: string,
): Promise<string> {
  const targets = routingTargets(resolution);
  if (targets.length === 0) throw new Error('The filament routing target has changed.');
  const before = useFilamentSessionStore.getState();
  const selected = before.snapshot?.slots.find(slot => String(slot.slot) === value);
  const localValue = value === 'inherit' ? null : value === '0' ? 0 : undefined;
  const result = await before.run(runtime, async () => {
    const current = useFilamentSessionStore.getState().snapshot;
    const slot = localValue !== undefined ? localValue : current?.slots.find(slot => slot.logicalId === selected?.logicalId)?.slot;
    if (!current || slot === undefined)
      return { ok: false, version: 1, error: 'The selected filament slot is no longer available.', errorCode: 'unsupported_reference' };
    return runtime.setFilamentRouting({ version: 1, revision: current.revisions.session, selector, slot, targets });
  });
  if (!result.ok) throw new Error(result.error);
  const published = result.result.snapshot.routing?.find(row =>
    row.selector === selector && row.target === targets[0].kind && row.id === targets[0].id);
  if (!published) throw new Error('The updated filament route is unavailable.');
  return published.inherited ? 'inherit' : String(published.explicitSlot);
}
