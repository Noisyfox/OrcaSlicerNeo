import { describe, expect, it } from 'vitest';
import type { NativeScopedConfigSnapshot, OptionMetadata } from '@slicer/client';
import { projectScopedConfigurationFields, resolveScopedConfigurationTarget } from './scopedConfigurationProjection';

const metadata: OptionMetadata = {
  layer_height: { type: 'float', label: 'Layer height', category: 'Quality', scopes: ['project', 'plate', 'object', 'part'] },
  enable_support: { type: 'bool', label: 'Supports', category: 'Support', scopes: ['project', 'object', 'part'] },
  extruder: { type: 'int', label: 'Extruder', category: 'Material', scopes: ['project', 'object', 'part'] },
  custom_gcode: { type: 'string', label: 'G-code', category: 'G-code', scopes: ['project'] },
};

const baseValues = { layer_height: '0.2', enable_support: '0', extruder: '1' };
const snapshot: NativeScopedConfigSnapshot = {
  project: { layer_height: '0.25' },
  plates: { 'plate-1': { layer_height: '0.3' } },
  objects: { '10': { enable_support: '1' } },
  parts: { '20': { layer_height: '0.4' } },
};

const structure = [{
  id: 10, index: 0, name: 'Cube', printable: true, instanceCount: 1,
  volumes: [{ id: 20, index: 0, name: 'Modifier', type: 'parameter_modifier' as const, isSplittable: false }],
  instances: [{ id: 30, index: 0, printable: true }],
}];

describe('scoped configuration projection', () => {
  it('resolves empty, whole-object, and part selections without falling back on mixed selections', () => {
    expect(resolveScopedConfigurationTarget({
      selectionKind: 'empty', selectedVolumes: [], activePlateId: 'plate-1', activePlateLabel: 'Plate 1', structure,
    })).toMatchObject({ scope: 'plate', label: 'Plate 1', visibleScopes: ['preset', 'project', 'plate'] });
    expect(resolveScopedConfigurationTarget({
      selectionKind: 'instance', selectedVolumes: [{ objectId: 10, volumeId: 20 }], activePlateId: 'plate-1', structure,
    })).toMatchObject({ scope: 'object', targets: [{ id: '10' }] });
    expect(resolveScopedConfigurationTarget({
      selectionKind: 'part', selectedVolumes: [{ objectId: 10, volumeId: 20 }], activePlateId: 'plate-1', structure,
    })).toMatchObject({ scope: 'part', targets: [{ id: '20', objectId: '10' }] });
    expect(resolveScopedConfigurationTarget({
      selectionKind: 'mixed', selectedVolumes: [{ objectId: 10, volumeId: 20 }], activePlateId: 'plate-1', structure,
    })).toMatchObject({ scope: 'invalid', targets: [] });
  });

  it('projects only the selection-visible chain and reports nearest provenance', () => {
    const resolution = resolveScopedConfigurationTarget({
      selectionKind: 'part', selectedVolumes: [{ objectId: 10, volumeId: 20 }], activePlateId: 'plate-1', structure,
    });
    const fields = projectScopedConfigurationFields({ mode: 'scoped', metadata, baseValues, snapshot, resolution });
    expect(fields.find((field) => field.key === 'layer_height')).toMatchObject({ value: '0.4', source: 'part', local: true });
    expect(fields.find((field) => field.key === 'enable_support')).toMatchObject({ value: '1', source: 'object' });
    expect(fields.some((field) => field.key === 'extruder')).toBe(false);
    expect(fields.some((field) => field.key === 'custom_gcode')).toBe(false);
  });

  it('keeps Project mode on the Project map even when a selection has deeper overrides', () => {
    const resolution = resolveScopedConfigurationTarget({
      selectionKind: 'part', selectedVolumes: [{ objectId: 10, volumeId: 20 }], activePlateId: 'plate-1', structure,
    });
    const fields = projectScopedConfigurationFields({ mode: 'project', metadata, baseValues, snapshot, resolution });
    expect(fields.find((field) => field.key === 'layer_height')).toMatchObject({
      value: '0.25', source: 'project', local: true, mixed: false,
    });
    expect(fields.find((field) => field.key === 'enable_support')).toMatchObject({
      value: '0', source: 'preset', local: false, mixed: false,
    });
  });

  it('marks differing same-scope targets as Mixed instead of showing the first value', () => {
    const resolution = resolveScopedConfigurationTarget({
      selectionKind: 'object', selectedVolumes: [{ objectId: 10, volumeId: 20 }, { objectId: 11, volumeId: 21 }], activePlateId: 'plate-1', structure,
    });
    const fields = projectScopedConfigurationFields({
      mode: 'scoped', metadata, baseValues,
      snapshot: { ...snapshot, objects: { '10': { enable_support: '1' }, '11': { enable_support: '0' } } }, resolution,
    });
    expect(fields.find((field) => field.key === 'enable_support')).toMatchObject({ value: null, mixed: true, source: 'object' });
  });
});
