import type {
  NativeScopedConfigScope,
  NativeScopedConfigSnapshot,
  NativeScopedConfigTarget,
  OptionMeta,
  OptionMetadata,
} from '@slicer/client';
import type { ModelObjectStructure } from '@slicer/client';
import type { SelectionKind } from '../viewport/SceneInteractionController';

export type ConfigurationMode = 'project' | 'scoped';
export type ScopedValueSource = 'preset' | NativeScopedConfigScope | 'mixed';

export interface ScopedSelectionVolume {
  readonly objectId: number;
  readonly volumeId: number;
}

export interface ScopedConfigurationTarget extends NativeScopedConfigTarget {
  readonly label: string;
  readonly objectId?: string;
}

export interface ScopedTargetResolution {
  readonly scope: NativeScopedConfigScope | 'invalid';
  readonly targets: readonly ScopedConfigurationTarget[];
  readonly label: string;
  readonly visibleScopes: readonly ('preset' | NativeScopedConfigScope)[];
  readonly disabledReason?: string;
}

export interface ScopedConfigurationField {
  readonly key: string;
  readonly label: string;
  readonly category: string;
  readonly meta: OptionMeta;
  readonly value: string | null;
  readonly mixed: boolean;
  readonly source: ScopedValueSource;
  readonly local: boolean;
  readonly resettable: boolean;
}

const EXCLUDED_KEY = /(?:filament|rack|ams|gcode|layer[_-]?range)/i;

/** Generic Project/Scoped intentionally excludes typed material and opaque
 * native domains. Scene-only Prime Tower coordinates are also excluded. */
export function isGenericScopedKey(key: string, meta?: OptionMeta): boolean {
  if (key === 'extruder' || key === 'wipe_tower_x' || key === 'wipe_tower_y') return false;
  if (EXCLUDED_KEY.test(key)) return false;
  if (!meta || meta.type === 'unknown') return false;
  return true;
}

export function isKeyEligibleForScope(
  key: string,
  meta: OptionMeta,
  scope: NativeScopedConfigScope,
): boolean {
  if (!isGenericScopedKey(key, meta)) return false;
  return meta.scopes?.includes(scope) === true;
}

function valuesForScope(snapshot: NativeScopedConfigSnapshot, scope: NativeScopedConfigScope, id?: string): Readonly<Record<string, string>> {
  if (scope === 'project') return snapshot.project;
  if (!id) return {};
  const bucket = scope === 'plate' ? snapshot.plates : scope === 'object' ? snapshot.objects : snapshot.parts;
  return bucket[id] ?? {};
}

function objectName(structure: readonly ModelObjectStructure[], id: string): string {
  return structure.find((object) => String(object.id) === id)?.name ?? `Object ${id}`;
}

function volumeName(structure: readonly ModelObjectStructure[], id: string): { name: string; objectId?: string } {
  for (const object of structure) {
    const volume = object.volumes.find((candidate) => String(candidate.id) === id);
    if (volume) {
      // Native config uses one `part` scope for every model volume kind, but
      // the target label should preserve the distinction visible in the
      // scene (modifier, negative volume, support blocker/enforcer, etc.).
      const prefix =
        volume.type === 'parameter_modifier'
          ? 'Modifier'
          : volume.type === 'negative_volume'
            ? 'Negative volume'
            : volume.type === 'support_blocker'
              ? 'Support blocker'
              : volume.type === 'support_enforcer'
                ? 'Support enforcer'
                : 'Part';
      return { name: `${prefix}: ${volume.name}`, objectId: String(object.id) };
    }
  }
  return { name: `Volume ${id}` };
}

/** Resolve exactly the selection classes admitted by SceneInteractionController. */
export function resolveScopedConfigurationTarget(args: {
  selectionKind: SelectionKind;
  selectedVolumes: readonly ScopedSelectionVolume[];
  activePlateId: string | null;
  activePlateLabel?: string;
  structure?: readonly ModelObjectStructure[];
  wipeTowerSelected?: boolean;
}): ScopedTargetResolution {
  const structure = args.structure ?? [];
  if (args.wipeTowerSelected)
    return {
      scope: 'invalid', targets: [], label: 'No scoped target', visibleScopes: ['preset'],
      disabledReason: 'Select an object or model volume to edit scoped configuration.',
    };
  if (args.selectedVolumes.length === 0) {
    if (!args.activePlateId)
      return {
        scope: 'invalid', targets: [], label: 'No active plate', visibleScopes: ['preset', 'project'],
        disabledReason: 'An active plate is required for an empty selection.',
      };
    return {
      scope: 'plate',
      targets: [{ scope: 'plate', id: args.activePlateId, label: args.activePlateLabel ?? args.activePlateId }],
      label: args.activePlateLabel ?? args.activePlateId,
      visibleScopes: ['preset', 'project', 'plate'],
    };
  }
  if (args.selectionKind === 'mixed' || args.selectionKind === 'empty')
    return {
      scope: 'invalid', targets: [], label: 'Mixed selection', visibleScopes: ['preset', 'project'],
      disabledReason: 'Select only whole objects, or sibling parts from one object and instance.',
    };
  if (args.selectionKind === 'object' || args.selectionKind === 'instance') {
    const ids = [...new Set(args.selectedVolumes.map((volume) => String(volume.objectId)))];
    const targets = ids.map((id) => ({ scope: 'object' as const, id, label: objectName(structure, id) }));
    return {
      scope: 'object', targets, label: targets.length === 1 ? `Object: ${targets[0].label}` : `${targets.length} objects`,
      visibleScopes: ['preset', 'project', 'object'],
    };
  }
  const seen = new Set<string>();
  const targets: ScopedConfigurationTarget[] = [];
  for (const volume of args.selectedVolumes) {
    const id = String(volume.volumeId);
    if (seen.has(id)) continue;
    seen.add(id);
    const info = volumeName(structure, id);
    targets.push({ scope: 'part', id, objectId: String(volume.objectId), label: info.name });
  }
  if (targets.length === 0)
    return {
      scope: 'invalid', targets: [], label: 'No scoped target', visibleScopes: ['preset', 'project'],
      disabledReason: 'The selected model volume is unavailable.',
    };
  return {
    scope: 'part', targets,
    label: targets.length === 1 ? `${targets[0].label}` : `${targets.length} volumes`,
    visibleScopes: ['preset', 'project', 'object', 'part'],
  };
}

function sourceFor(values: readonly { source: ScopedValueSource }[]): ScopedValueSource {
  const first = values[0]?.source ?? 'preset';
  return values.every((value) => value.source === first) ? first : 'mixed';
}

function effectiveForTarget(
  key: string,
  base: Readonly<Record<string, string>>,
  snapshot: NativeScopedConfigSnapshot,
  target: ScopedConfigurationTarget,
  visibleScopes: readonly ('preset' | NativeScopedConfigScope)[],
): { value: string; source: ScopedValueSource; local: boolean } {
  const sources: Array<['preset' | NativeScopedConfigScope, Readonly<Record<string, string>>]> = [['preset', base]];
  for (const scope of visibleScopes) {
    if (scope === 'preset') continue;
    if (scope === 'object' && target.scope === 'part') {
      sources.push(['object', valuesForScope(snapshot, 'object', target.objectId)]);
      continue;
    }
    if (scope === target.scope)
      sources.push([scope, valuesForScope(snapshot, scope, target.id === undefined ? undefined : String(target.id))]);
    else if (scope === 'project') sources.push(['project', snapshot.project]);
    else if (scope === 'plate' && target.scope === 'plate') sources.push(['plate', valuesForScope(snapshot, 'plate', String(target.id))]);
  }
  let value = base[key] ?? '';
  let source: ScopedValueSource = 'preset';
  let local = false;
  for (const [candidateSource, values] of sources) {
    if (Object.hasOwn(values, key)) {
      value = values[key];
      source = candidateSource;
      if (candidateSource === target.scope) local = true;
    }
  }
  return { value, source, local };
}

/** Derive the complete selection-limited catalogue from native metadata and
 * disposable native local maps. */
export function projectScopedConfigurationFields(args: {
  mode: ConfigurationMode;
  metadata: OptionMetadata;
  baseValues: Readonly<Record<string, string>>;
  snapshot: NativeScopedConfigSnapshot;
  resolution: ScopedTargetResolution;
  search?: string;
}): ScopedConfigurationField[] {
  const scope = args.mode === 'project' ? 'project' : args.resolution.scope;
  if (scope === 'invalid') return [];
  const visibleScopes = args.mode === 'project' ? ['preset', 'project'] as const : args.resolution.visibleScopes;
  const targets = args.mode === 'project'
    ? [{ scope: 'project' as const, label: 'Project' }]
    : args.resolution.targets;
  if (targets.length === 0) return [];
  const query = args.search?.trim().toLocaleLowerCase() ?? '';
  return Object.entries(args.metadata)
    .filter(([key, meta]) => isKeyEligibleForScope(key, meta, scope))
    .map(([key, meta]) => {
      const resolved = targets.map((target) => effectiveForTarget(key, args.baseValues, args.snapshot, target, visibleScopes));
      const value = resolved[0]?.value ?? '';
      const mixed = resolved.some((entry) => entry.value !== value);
      const local = resolved.some((entry) => entry.local);
      return {
        key,
        label: meta.label ?? meta.full_label ?? key,
        category: meta.category ?? 'General',
        meta,
        value: mixed ? null : value,
        mixed,
        source: sourceFor(resolved),
        local,
        resettable: isGenericScopedKey(key, meta),
      };
    })
    .filter((field) => !query || `${field.key} ${field.label} ${field.category}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.category.localeCompare(right.category) || left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
}

export function localKeysForTarget(snapshot: NativeScopedConfigSnapshot, target: NativeScopedConfigTarget): string[] {
  return Object.keys(valuesForScope(snapshot, target.scope, target.id === undefined ? undefined : String(target.id)));
}
