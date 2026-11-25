import type { FilamentRoutingProjection, FilamentRoutingSelector, FilamentRoutingTargetRequest, OptionMetadata, SlicerClient } from '@slicer/client';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import type { ScopedConfigurationField, ScopedTargetResolution } from './scopedConfigurationProjection';

export const featureOptions = [
  ['outer_wall_filament_id', 'outer-wall', 'Outer walls'],
  ['inner_wall_filament_id', 'inner-wall', 'Inner walls'],
  ['sparse_infill_filament_id', 'sparse-infill', 'Sparse infill'],
  ['internal_solid_filament_id', 'internal-solid-infill', 'Internal solid infill'],
  ['top_surface_filament_id', 'top-surface', 'Top surface'],
  ['bottom_surface_filament_id', 'bottom-surface', 'Bottom surface'],
] as const;

function routingTargets(resolution: ScopedTargetResolution): Required<FilamentRoutingTargetRequest>[] {
  if (resolution.scope === 'project') return [{ kind: 'project', id: 0 }];
  if (resolution.scope !== 'object' && resolution.scope !== 'part') return [];
  return resolution.targets.map(target => ({
    kind: target.scope === 'part' ? 'model-part' : 'object', id: Number(target.id),
  }));
}

export function featureFilamentFields(
  metadata: OptionMetadata, resolution: ScopedTargetResolution, routing: readonly FilamentRoutingProjection[] | undefined,
): ScopedConfigurationField[] {
  const targets = routingTargets(resolution);
  if (!routing || targets.length === 0) return [];
  const kind = targets[0].kind;
  const scope = kind === 'model-part' ? 'part' : kind;
  const routeKey = (target: FilamentRoutingProjection['target'], id: number, selector: FilamentRoutingSelector) =>
    `${target}:${id}:${selector}`;
  const selectedIds = new Set(targets.map(target => target.id));
  const routesByKey = new Map(routing
    .filter(row => row.target === 'project' || (kind === 'model-part' && row.target === 'object') ||
      (row.target === kind && selectedIds.has(row.id)))
    .map(row => [routeKey(row.target, row.id, row.selector), row]));
  const result: ScopedConfigurationField[] = [];
  for (const [key, selector, label] of featureOptions) {
    const routes = targets.flatMap(target => {
      const route = routesByKey.get(routeKey(kind, target.id, selector));
      return route ? [route] : [];
    });
    // The native session only admits printable model parts and complete selections.
    if (routes.length !== targets.length) continue;
    const projectSlot = routesByKey.get(routeKey('project', 0, selector))?.explicitSlot ?? 0;
    const values = routes.map(route => {
      if (!route.inherited) return route.explicitSlot;
      const object = kind === 'model-part' ? routesByKey.get(routeKey('object', route.objectId, selector)) : undefined;
      return object && !object.inherited ? object.explicitSlot : projectSlot;
    });
    const effective = routes[0].effectiveSlot;
    const local = routes.some(route => !route.inherited && (kind !== 'project' || route.explicitSlot !== 0));
    const mixed = values.some(value => value !== values[0]);
    result.push({
      key, label, category: 'Filament for Features', meta: metadata[key] ?? { type: 'int' },
      local, mixed, resettable: true, value: String(values[0]),
      source: mixed ? 'mixed' : local ? scope : 'project',
      filamentRoute: { selector, effectiveSlot: routes.every(route => route.effectiveSlot === effective) ? effective : null },
    });
  }
  return result;
}

export async function setFeatureFilament(
  runtime: SlicerClient, resolution: ScopedTargetResolution, selector: FilamentRoutingSelector, requestedSlot: number | null,
): Promise<number | undefined> {
  const targets = routingTargets(resolution);
  if (targets.length === 0) throw new Error('The filament routing target has changed.');
  const before = useFilamentSessionStore.getState();
  const selected = before.snapshot?.slots.find(slot => slot.slot === requestedSlot);
  const result = await before.run(runtime, async () => {
    const current = useFilamentSessionStore.getState().snapshot;
    const slot = requestedSlot === null || requestedSlot === 0 ? requestedSlot
      : current?.slots.find(slot => slot.logicalId === selected?.logicalId)?.slot;
    if (!current || slot === undefined)
      return { ok: false, version: 1, error: 'The selected filament slot is no longer available.', errorCode: 'unsupported_reference' };
    return runtime.setFilamentRouting({ version: 1, revision: current.revisions.session, selector, slot, targets });
  });
  if (!result.ok) throw new Error(result.error);
  return result.result.mutation.slot;
}
