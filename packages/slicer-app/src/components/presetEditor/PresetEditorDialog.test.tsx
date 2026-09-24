// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OptionMeta,
  PresetDraftEditorBinding,
  PresetDraftEditorScalarType,
  PresetDraftEditorValue,
  PresetDraftKind,
  PresetDraftMutationRequest,
  PresetDraftMutationResult,
  PresetDraftSnapshot,
} from '@slicer/client';
import { PresetEditorDialog } from './PresetEditorDialog';
import {
  FILAMENT_PRESET_EDITOR_MANIFEST,
  PRINTER_PRESET_EDITOR_MANIFEST,
  presetEditorFields,
} from './presetEditorManifests';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let roots: Root[] = [];

type TestVector = { scalarType: PresetDraftEditorScalarType; metadataType: OptionMeta['type']; values: PresetDraftEditorValue[]; guiType?: PresetDraftEditorBinding['guiType']; multiline?: boolean; isCode?: boolean; nullable?: boolean; enumOptions?: PresetDraftEditorBinding['enumOptions'] };

function bindingFor(vector: TestVector, value: PresetDraftEditorValue = vector.values[0] ?? null): PresetDraftEditorBinding {
  return {
    scalarType: vector.scalarType,
    index: 0,
    elementCount: vector.values.length,
    nullable: vector.nullable ?? false,
    guiType: vector.guiType ?? 'undefined',
    guiFlags: vector.guiType === 'f_enum_open' ? 'show_value' : '',
    multiline: vector.multiline ?? false,
    isCode: vector.isCode ?? false,
    readOnly: false,
    sourceValue: vector.values[0] ?? null,
    effectiveValue: value,
    ...(vector.enumOptions ? { enumOptions: vector.enumOptions } : {}),
  };
}

function snapshotFor(kind: PresetDraftKind, options: { modified?: boolean; draftExists?: boolean } = {}): PresetDraftSnapshot {
  const manifest = kind === 'printer' ? PRINTER_PRESET_EDITOR_MANIFEST : FILAMENT_PRESET_EDITOR_MANIFEST;
  const fields = presetEditorFields(manifest);
  const sourceValues = Object.fromEntries(fields.map(({ key }) => [key, `source:${key}`]));
  const effectiveValues = { ...sourceValues };
  const optionMetadata: Record<string, OptionMeta> = Object.fromEntries(fields.map(({ key }) => [key, {
    type: 'string',
    label: `Label ${key}`,
    tooltip: `Help ${key}`,
  }]));
  const editorBindings: Record<string, PresetDraftEditorBinding> = {};

  if (kind === 'printer') {
    sourceValues.printable_height = '230';
    effectiveValues.printable_height = options.modified ? '245' : '230';
    const nozzleDiameter: TestVector = { scalarType: 'float', metadataType: 'floats', values: [0.4, 0.6] };
    sourceValues.nozzle_diameter = JSON.stringify([0.4]);
    effectiveValues.nozzle_diameter = JSON.stringify(nozzleDiameter.values);
    optionMetadata.nozzle_diameter = { type: 'floats', label: 'Nozzle diameter' };
    editorBindings.nozzle_diameter = { ...bindingFor(nozzleDiameter), elementCount: 2 };
    optionMetadata.printable_height = { type: 'float', label: 'Build height', tooltip: 'Height of the build volume', min: 1, max: 1000 };
    optionMetadata.printer_agent = { type: 'enum', label: 'Printer Agent', tooltip: 'Network agent selector', enum_values: ['default'] };
    optionMetadata.machine_start_gcode = { type: 'string', label: 'Machine start script', tooltip: 'Distinctive machine start help text' };
    optionMetadata.printer_notes = { type: 'string', label: 'Printer notes', tooltip: 'Notes tooltip' };
    optionMetadata.time_cost = { type: 'string', label: 'Time cost' };
    optionMetadata.support_multi_bed_types = { type: 'bool', label: 'Multiple beds' };
  } else {
    const vectors: Record<string, TestVector> = {
      filament_flow_ratio: { scalarType: 'float', metadataType: 'floats', values: [1, 0.98] },
      filament_type: { scalarType: 'string', metadataType: 'strings', values: ['PLA'], guiType: 'f_enum_open' },
      filament_soluble: { scalarType: 'bool', metadataType: 'bools', values: [false] },
      filament_adaptive_volumetric_speed: {
        scalarType: 'bool', metadataType: 'bools', values: [null], nullable: true,
      },
      default_filament_colour: { scalarType: 'string', metadataType: 'strings', values: ['#F2754E'], guiType: 'color' },
      filament_diameter: { scalarType: 'float', metadataType: 'floats', values: [1.75, 2.85] },
      filament_adhesiveness_category: { scalarType: 'int', metadataType: 'ints', values: [0] },
      filament_shrink: { scalarType: 'percent', metadataType: 'percents', values: [100] },
      overhang_fan_threshold: {
        scalarType: 'enum', metadataType: 'enums', values: [2],
        enumOptions: [
          { value: 0, name: '0%', label: '0%' },
          { value: 1, name: '10%', label: '10%' },
          { value: 2, name: '25%', label: '25%' },
          { value: 3, name: '50%', label: '50%' },
          { value: 4, name: '75%', label: '75%' },
          { value: 5, name: '95%', label: '95%' },
        ],
      },
      filament_start_gcode: { scalarType: 'string', metadataType: 'strings', values: ['G28\nM104 S220\n'], multiline: true, isCode: true },
      filament_change_extrusion_role_gcode: { scalarType: 'string', metadataType: 'strings', values: ['; role change\n'], multiline: true, isCode: true },
      filament_end_gcode: { scalarType: 'string', metadataType: 'strings', values: ['M104 S0\n'], multiline: true, isCode: true },
      filament_notes: { scalarType: 'string', metadataType: 'strings', values: [''], multiline: true },
    };
    for (const [key, vector] of Object.entries(vectors)) {
      const values = [...vector.values];
      if (options.modified && key === 'filament_flow_ratio') values[0] = 0.92;
      sourceValues[key] = JSON.stringify(vector.values);
      effectiveValues[key] = JSON.stringify(values);
      optionMetadata[key] = {
        type: vector.metadataType,
        label: key === 'filament_type' ? 'Filament type' : `Label ${key}`,
        ...(vector.enumOptions ? {
          enum_values: vector.enumOptions.map(({ name }) => name),
          enum_labels: vector.enumOptions.map(({ label }) => label),
        } : {}),
      };
      editorBindings[key] = bindingFor(vector, values[0] ?? null);
    }
    optionMetadata.filament_vendor = { type: 'string', label: 'Vendor' };
    optionMetadata.enable_pressure_advance = { type: 'bool', label: 'Pressure advance' };
  }
  const modifiedKey = kind === 'printer' ? 'printable_height' : 'filament_flow_ratio';
  if (options.modified && kind === 'printer') effectiveValues[modifiedKey] = '245';

  return {
    ok: true,
    kind,
    canonicalName: kind === 'printer' ? 'Printer Canonical' : 'Filament Canonical',
    draftExists: options.draftExists ?? true,
    modified: options.modified ?? false,
    overrides: options.modified ? { [kind === 'printer' ? 'printable_height' : 'filament_flow_ratio']: '245' } : {},
    sourceValues,
    effectiveValues,
    optionMetadata,
    editorBindings,
    revision: 1,
  };
}

function mutationSuccess(snapshot: PresetDraftSnapshot, request: PresetDraftMutationRequest): PresetDraftMutationResult {
  const next = { ...snapshot };
  let overrides = { ...snapshot.overrides };
  let effectiveValues = { ...snapshot.effectiveValues };
  let editorBindings = { ...snapshot.editorBindings };
  if (request.action === 'set-element') {
    const binding = snapshot.editorBindings[request.key];
    if (!binding || request.index >= binding.elementCount) throw new Error('missing native element fixture');
    const rawValues = JSON.parse(effectiveValues[request.key] ?? snapshot.sourceValues[request.key] ?? '[]') as PresetDraftEditorValue[];
    rawValues[request.index] = request.value;
    const serialized = JSON.stringify(rawValues);
    overrides[request.key] = serialized;
    effectiveValues[request.key] = serialized;
    editorBindings[request.key] = { ...binding, effectiveValue: request.value };
  } else if (request.action === 'set') {
    overrides[request.key] = request.value;
    effectiveValues[request.key] = request.value;
  } else if (request.action === 'reset-field') {
      delete overrides[request.key];
      effectiveValues[request.key] = snapshot.sourceValues[request.key] ?? '';
      const binding = snapshot.editorBindings[request.key];
      if (binding) editorBindings[request.key] = { ...binding, effectiveValue: binding.sourceValue };
  } else if (request.action === 'reset-category') {
    for (const key of request.keys) {
      delete overrides[key];
      effectiveValues[key] = snapshot.sourceValues[key] ?? '';
      if (snapshot.editorBindings[key]) editorBindings[key] = snapshot.editorBindings[key];
    }
  } else {
    overrides = {};
    effectiveValues = { ...snapshot.sourceValues };
    editorBindings = { ...snapshot.editorBindings };
  }
  return {
    ...next,
    overrides,
    effectiveValues,
    editorBindings,
    draftExists: request.action === 'reset-preset' ? false : true,
    modified: Object.keys(overrides).length > 0,
    revision: snapshot.revision + 1,
    historyEntryDelta: 1,
    revisionBefore: snapshot.revision,
    revisionAfter: snapshot.revision + 1,
    dirty: true,
    affectedPlateIds: ['plate-1'],
    allPlateResultsInvalidated: true,
    plateSession: {} as never,
    filamentSession: {} as never,
    historyStatus: {} as never,
    nativeScopedConfig: {} as never,
  } as PresetDraftMutationResult;
}

async function mount(
  snapshot: PresetDraftSnapshot | null,
  onClose = vi.fn(),
  referencedFilamentSlots?: readonly number[],
  onMutate: (request: PresetDraftMutationRequest) => Promise<PresetDraftMutationResult> = async () => ({
    ok: false, error: 'mutation fixture not configured',
  }),
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  function Harness() {
    const [current, setCurrent] = useState(snapshot);
    const mutate = async (request: PresetDraftMutationRequest) => {
      const result = await onMutate(request);
      if (result.ok) setCurrent(result);
      return result;
    };
    const target = snapshot ? { kind: snapshot.kind, canonicalName: snapshot.canonicalName } : null;
    return <PresetEditorDialog
      target={target}
      snapshot={current}
      referencedFilamentSlots={referencedFilamentSlots}
      onClose={onClose}
      onMutate={mutate}
    />;
  }
  await act(async () => {
    root.render(<Harness />);
  });
  return { container, root, onClose };
}

async function click(element: Element | null) {
  if (!element) throw new Error('expected a clickable element');
  await act(async () => { (element as HTMLElement).click(); });
}

async function changeInput(input: HTMLInputElement, value: string) {
  if (!input) throw new Error(`missing input; visible controls: ${[...document.querySelectorAll('[data-testid^="preset-editor-input-"]')].map((node) => node.getAttribute('data-testid')).join(', ')}`);
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function press(input: HTMLInputElement | HTMLTextAreaElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function enterSearch(value: string) {
  const input = document.querySelector('[data-testid="preset-editor-search"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function groupHeadings(pageId: string): string[] {
  return [...document.querySelectorAll(`[data-testid="preset-editor-page-${pageId}"] section h3`)]
    .map((heading) => heading.textContent ?? '');
}

function visibleFieldKeys(pageId: string): string[] {
  return [...document.querySelectorAll(`[data-testid="preset-editor-page-${pageId}"] [data-testid^="preset-editor-field-"]`)]
    .map((field) => field.getAttribute('data-field-key') ?? '');
}

beforeEach(() => {
  if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent, configurable: true });
});

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  document.body.innerHTML = '';
});

describe('PresetEditorDialog', () => {
  it.each([FILAMENT_PRESET_EDITOR_MANIFEST, PRINTER_PRESET_EDITOR_MANIFEST])(
    'renders the declared page, group, and field order for $kind',
    async (manifest) => {
      await mount(snapshotFor(manifest.kind));
      const pageTabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
        .map((tab) => tab.textContent ?? '');
      expect(pageTabs).toEqual(manifest.pages.flatMap((page) => page.id === 'extruder'
        ? ['Extruder 1', 'Extruder 2'] : [page.title]));

      for (const [pageIndex, page] of manifest.pages.entries()) {
        const pageId = page.id === 'extruder' ? 'extruder-1' : page.id;
        if (pageIndex > 0 || page.id === 'extruder')
          await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
        expect(groupHeadings(pageId)).toEqual(page.groups.map((optionGroup) => optionGroup.title));
        expect(visibleFieldKeys(pageId)).toEqual(page.groups.flatMap((optionGroup) => optionGroup.fields.map((field) => field.key)));
      }
    },
  );

  it('expands the Printer Extruder template from the effective native scalar count', async () => {
    const source = snapshotFor('printer');
    const template = PRINTER_PRESET_EDITOR_MANIFEST.pages.find((page) => page.id === 'extruder');
    if (!template) throw new Error('expected the explicit Printer Extruder page template');

    await mount(source);
    const pageTabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
      .map((tab) => tab.textContent ?? '');
    expect(pageTabs).toEqual(PRINTER_PRESET_EDITOR_MANIFEST.pages.flatMap((page) =>
      page.id === 'extruder' ? ['Extruder 1', 'Extruder 2'] : [page.title]));

    for (const index of [1, 2]) {
      const pageId = `extruder-${index}`;
      await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
      expect(groupHeadings(pageId)).toEqual(template.groups.map((optionGroup) => optionGroup.title));
      expect(visibleFieldKeys(pageId)).toEqual(template.groups.flatMap((optionGroup) =>
        optionGroup.fields.map((field) => field.key)));
      expect(document.querySelector('[data-testid="preset-editor-context-nozzle_diameter"]')?.textContent)
        .toContain(`Extruder ${index} / Basic information`);
      expect(document.querySelector('[data-testid="preset-editor-field-nozzle_diameter"]')?.getAttribute('data-field-access'))
        .toBe('read-only');
    }
  });

  it('shows source and effective values while only showing the draft marker for modified state', async () => {
    await mount(snapshotFor('printer', { draftExists: true, modified: false }));
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer Canonical');
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-source-printable_height"]')?.textContent).toBe('230');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');
    expect(document.querySelector('[data-testid="preset-editor-field-printable_height"]')?.getAttribute('data-native-min')).toBe('1');
    expect(document.querySelector('[data-testid="preset-editor-field-printable_height"]')?.getAttribute('data-native-max')).toBe('1000');
  });

  it('highlights overridden options, groups, and page tabs and clears only the reset category', async () => {
    const base = snapshotFor('printer', { modified: true });
    const source: PresetDraftSnapshot = {
      ...base,
      overrides: { ...base.overrides, printer_variant: 'custom-variant', machine_start_gcode: 'G28' },
      effectiveValues: { ...base.effectiveValues, printer_variant: 'custom-variant', machine_start_gcode: 'G28' },
    };
    let current = source;
    await mount(source, vi.fn(), undefined, async (request) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = result;
      return result;
    });

    const label = (key: string) => document.querySelector(`[data-testid="preset-editor-option-label-${key}"]`);
    for (const key of ['printable_height', 'printer_variant']) {
      expect(label(key)?.getAttribute('data-draft-override-highlight')).toBe('true');
      expect(label(key)?.classList.contains('config-override-label')).toBe(true);
    }
    expect(label('printer_model')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(label('printer_model')?.classList.contains('config-override-label')).toBe(false);
    expect(document.querySelector('[data-testid="preset-editor-control-printable_height"]')?.classList.contains('config-override-label')).toBe(false);

    const tab = (page: string) => document.querySelector(`[data-testid="preset-editor-page-tab-${page}"]`);
    const group = (page: string, id: string) => document.querySelector(`[data-testid="preset-editor-group-title-${page}-${id}"]`);
    for (const page of ['basic-information', 'machine-gcode']) {
      expect(tab(page)?.getAttribute('data-draft-override-highlight')).toBe('true');
      expect(tab(page)?.classList.contains('config-override-label')).toBe(true);
    }
    expect(tab('motion-ability')?.getAttribute('data-draft-override-highlight')).toBe('false');
    for (const id of ['identity', 'printable-space']) {
      expect(group('basic-information', id)?.getAttribute('data-draft-override-highlight')).toBe('true');
      expect(group('basic-information', id)?.classList.contains('config-override-label')).toBe(true);
    }
    expect(group('basic-information', 'advanced')?.getAttribute('data-draft-override-highlight')).toBe('false');

    await click(document.querySelector('[data-testid="preset-editor-reset-field-printable_height"]'));
    expect(label('printable_height')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(group('basic-information', 'printable-space')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(group('basic-information', 'identity')?.getAttribute('data-draft-override-highlight')).toBe('true');
    expect(tab('basic-information')?.getAttribute('data-draft-override-highlight')).toBe('true');

    await click(document.querySelector('[data-testid="preset-editor-reset-category-basic-information"]'));
    for (const key of ['printable_height', 'printer_variant']) {
      expect(label(key)?.getAttribute('data-draft-override-highlight')).toBe('false');
      expect(label(key)?.classList.contains('config-override-label')).toBe(false);
    }
    expect(tab('basic-information')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(tab('machine-gcode')?.getAttribute('data-draft-override-highlight')).toBe('true');
    for (const id of ['identity', 'printable-space']) {
      expect(group('basic-information', id)?.getAttribute('data-draft-override-highlight')).toBe('false');
    }

    await click(tab('machine-gcode'));
    expect(group('machine-gcode', 'machine-start-gcode')?.getAttribute('data-draft-override-highlight')).toBe('true');
    expect(group('machine-gcode', 'file-header-gcode')?.getAttribute('data-draft-override-highlight')).toBe('false');
  });

  it('marks a modified draft and lists the numbered slots sharing its Filament source', async () => {
    await mount(snapshotFor('filament', { modified: true }), vi.fn(), [3, 1, 3]);
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')?.textContent).toBe('Project draft');
    expect(document.querySelector('[data-testid="preset-editor-source-filament_flow_ratio"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_flow_ratio"]')?.textContent).toBe('0.92');
    expect(document.querySelector('[data-testid="preset-editor-slot-reference"]')?.textContent)
      .toBe('Used by slot 1 and slot 3. Editing this source affects those slots.');
  });

  it('searches keys, native labels, and tooltips across pages while retaining their context', async () => {
    await mount(snapshotFor('printer'));

    await enterSearch('printer_notes');
    expect(document.querySelectorAll('[data-testid^="preset-editor-field-"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-context-printer_notes"]')?.textContent)
      .toContain('Notes / Notes');

    await enterSearch('Printer Agent');
    expect(document.querySelectorAll('[data-testid^="preset-editor-field-"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-context-printer_agent"]')?.textContent)
      .toContain('Basic information / Advanced');

    await enterSearch('Distinctive machine start help text');
    expect(document.querySelectorAll('[data-testid^="preset-editor-field-"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-context-machine_start_gcode"]')?.textContent)
      .toContain('Machine G-code / Machine start G-code');
  });

  it('marks Printer topology and specialized fields visibly read-only', async () => {
    await mount(snapshotFor('printer'));
    const cases = [
      ['printer_technology', 'basic-information'],
      ['printer_model', 'basic-information'],
      ['printer_variant', 'basic-information'],
      ['printer_structure', 'basic-information'],
      ['single_extruder_multi_material', 'multimaterial'],
      ['extruders_count', 'multimaterial'],
      ['default_filament_profile', 'multimaterial'],
      ['nozzle_diameter', 'extruder-1'],
      ['printable_area', 'basic-information'],
    ] as const;
  let activePage = 'basic-information';
    for (const [key, pageId] of cases) {
      if (pageId !== activePage) {
        await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
        activePage = pageId;
      }
      const field = document.querySelector(`[data-testid="preset-editor-field-${key}"]`);
      expect(field?.getAttribute('data-field-access')).toBe('read-only');
      expect(document.querySelector(`[data-testid="preset-editor-readonly-${key}"]`)?.textContent).toBe('Read only');
    }
  });

  it('keeps genuine lists and specialized controls visibly read-only', async () => {
    await mount(snapshotFor('filament'));
    const cases = [
      ['filament_flow_ratio', 'filament'],
      ['adaptive_pressure_advance_model', 'filament'],
      ['filament_ramming_parameters', 'multimaterial'],
      ['compatible_printers', 'dependencies'],
    ] as const;
    let activePage = 'filament';
    for (const [key, pageId] of cases) {
      if (pageId !== activePage) {
        await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
        activePage = pageId;
      }
      const field = document.querySelector(`[data-testid="preset-editor-field-${key}"]`);
      expect(field?.getAttribute('data-field-access')).toBe('read-only');
      expect(document.querySelector(`[data-testid="preset-editor-readonly-${key}"]`)?.textContent).toBe('Read only');
    }
  });

  it('marks every unbound native vector type read-only, including percent, enum, float-or-percent, and colour vectors', async () => {
    const base = snapshotFor('filament');
    const vectorTypes: Record<string, OptionMeta['type']> = {
      filament_flow_ratio: 'floats',
      filament_adhesiveness_category: 'ints',
      filament_type: 'strings',
      filament_soluble: 'bools',
      filament_shrink: 'percents',
      overhang_fan_threshold: 'enums',
      filament_diameter: 'floats_or_percents',
      default_filament_colour: 'strings',
    };
    const editorBindings = { ...base.editorBindings };
    const optionMetadata = { ...base.optionMetadata };
    for (const [key, type] of Object.entries(vectorTypes)) {
      delete editorBindings[key];
      optionMetadata[key] = { ...optionMetadata[key], type };
    }
    await mount({ ...base, editorBindings, optionMetadata });

    for (const [key, type] of Object.entries(vectorTypes)) {
      await enterSearch(key);
      const field = document.querySelector(`[data-testid="preset-editor-field-${key}"]`);
      expect(field?.getAttribute('data-native-type')).toBe(type);
      expect(field?.getAttribute('aria-disabled')).toBe('true');
      expect(document.querySelector(`[data-testid="preset-editor-readonly-${key}"]`)?.textContent).toBe('Read only');
      expect(document.querySelector(`[data-testid="preset-editor-input-${key}"]`)).toBeNull();
    }
  });

  it('keeps one modal and one active source when the single target changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const printerSnapshot = snapshotFor('printer');
    await act(async () => { root.render(<PresetEditorDialog target={{ kind: 'printer', canonicalName: printerSnapshot.canonicalName }} snapshot={printerSnapshot} onClose={vi.fn()} onMutate={vi.fn()} />); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer Canonical');

    const filamentSnapshot = snapshotFor('filament');
    await act(async () => { root.render(<PresetEditorDialog target={{ kind: 'filament', canonicalName: filamentSnapshot.canonicalName }} snapshot={filamentSnapshot} onClose={vi.fn()} onMutate={vi.fn()} />); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Filament Canonical');
    expect(document.querySelectorAll('[data-testid="preset-editor-close"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-close"]')?.getAttribute('aria-label')).toBe('Close preset editor');
    expect(document.querySelector('[data-testid="preset-editor-close"] svg')).not.toBeNull();
    const visibleActions = [...document.querySelectorAll('[role="dialog"] button')].map((button) => button.textContent?.trim());
    expect(visibleActions).not.toContain('Close');
    expect(visibleActions).not.toEqual(expect.arrayContaining(['Save', 'Apply', 'Cancel']));
    expect(document.querySelector('[data-testid="preset-editor-search"]')?.getAttribute('type')).toBe('search');
  });

  it('closes through the sole dialog action', async () => {
    const onClose = vi.fn();
    await mount(snapshotFor('printer'), onClose);
    await click(document.querySelector('[data-testid="preset-editor-close"]'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('commits numeric and text controls only on Enter or blur and restores local text on Escape', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '250');
    expect(onMutate).not.toHaveBeenCalled();
    await press(height, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set', key: 'printable_height', value: '250' }));

    const notes = document.querySelector('[data-testid="preset-editor-input-time_cost"]') as HTMLInputElement;
    await changeInput(notes, 'local edit');
    expect(onMutate).toHaveBeenCalledOnce();
    await press(notes, 'Escape');
    expect(onMutate).toHaveBeenCalledOnce();
    expect(notes.value).toBe('source:time_cost');

    await changeInput(notes, 'blur commit');
    await act(async () => { notes.blur(); });
    expect(onMutate).toHaveBeenCalledTimes(2);
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set', key: 'time_cost', value: 'blur commit' }));
  });

  it('commits a bound float element and preserves the rest of the raw native vector', async () => {
    const source = snapshotFor('filament');
    let receipt: PresetDraftMutationResult | undefined;
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      receipt = mutationSuccess(source, request);
      return receipt;
    });
    await mount(source, vi.fn(), undefined, onMutate);
    const diameter = document.querySelector('[data-testid="preset-editor-input-filament_diameter"]') as HTMLInputElement;
    await changeInput(diameter, '2.1');
    await press(diameter, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_diameter', scalarType: 'float', index: 0, value: 2.1 }));
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_diameter"]')?.textContent).toBe('2.1');
    expect(receipt?.ok && receipt.effectiveValues.filament_diameter).toBe(JSON.stringify([2.1, 2.85]));
  });

  it('rejects malformed scalar text locally and clamps a numeric value to native metadata bounds', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;

    await changeInput(height, '1.2junk');
    await press(height, 'Enter');
    expect(onMutate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="preset-editor-error-printable_height"]')?.textContent)
      .toBe('Enter a valid number.');

    await changeInput(height, '-5');
    await press(height, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'set', key: 'printable_height', value: '1',
    }));
    expect(height.value).toBe('1');
  });

  it('commits open enum text, native boolean, and colour vector elements', async () => {
    const source = snapshotFor('filament');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    const type = document.querySelector('[data-testid="preset-editor-input-filament_type"]') as HTMLInputElement;
    await changeInput(type, 'Custom PETG blend');
    await press(type, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_type', scalarType: 'string', index: 0, value: 'Custom PETG blend' }));

    await click(document.querySelector('[data-testid="preset-editor-input-filament_soluble"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_soluble', scalarType: 'bool', index: 0, value: true }));

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    const colour = document.querySelector('[data-testid="preset-editor-input-default_filament_colour"]') as HTMLInputElement;
    await act(async () => {
      colour.value = '#223344';
      colour.dispatchEvent(new Event('input', { bubbles: true }));
      colour.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'default_filament_colour', scalarType: 'string', index: 0, value: '#223344' }));
  });

  it('uses numeric native enum options, integer and percent element values, and a distinct nullable empty string', async () => {
    const sourceBase = snapshotFor('filament');
    const nullableNotes: PresetDraftEditorBinding = {
      ...sourceBase.editorBindings.filament_notes!, nullable: true, sourceValue: null, effectiveValue: null,
    };
    const source: PresetDraftSnapshot = {
      ...sourceBase,
      editorBindings: { ...sourceBase.editorBindings, filament_notes: nullableNotes },
      sourceValues: { ...sourceBase.sourceValues, filament_notes: JSON.stringify([null]) },
      effectiveValues: { ...sourceBase.effectiveValues, filament_notes: JSON.stringify([null]) },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-cooling"]'));
    const threshold = document.querySelector('[data-testid="preset-editor-input-overhang_fan_threshold"]');
    await click(threshold);
    const fiftyPercent = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === '50%');
    if (!fiftyPercent) throw new Error('expected native closed-enum option 50%');
    await act(async () => {
      fiftyPercent.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      fiftyPercent.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'overhang_fan_threshold', scalarType: 'enum', value: 3 }));

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    expect(document.querySelector('[data-testid="preset-editor-input-filament_adaptive_volumetric_speed"]')?.textContent)
      .toContain('Not set');
    const category = document.querySelector('[data-testid="preset-editor-input-filament_adhesiveness_category"]') as HTMLInputElement;
    await changeInput(category, '3');
    await press(category, 'Enter');
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_adhesiveness_category', scalarType: 'int', value: 3 }));

    const shrink = document.querySelector('[data-testid="preset-editor-input-filament_shrink"]') as HTMLInputElement;
    await changeInput(shrink, '95');
    await press(shrink, 'Enter');
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_shrink', scalarType: 'percent', value: 95 }));
    expect(document.querySelector('[data-testid="preset-editor-input-filament_shrink"]')?.parentElement?.textContent)
      .toContain('%');

    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    expect(document.querySelector('[data-testid="preset-editor-source-filament_notes"]')?.textContent).toBe('(null)');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe('(null)');
    await click(document.querySelector('[data-testid="preset-editor-null-filament_notes"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_notes', scalarType: 'string', value: '' }));
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe('(empty)');
  });

  it('keeps a native float-or-percent object distinct from a percent scalar', async () => {
    const base = snapshotFor('filament');
    // No currently loaded preset source exposes this vector type; this isolated
    // projection fixture exercises the generic binding contract itself.
    const floatOrPercent: PresetDraftEditorBinding = {
      ...base.editorBindings.filament_diameter!,
      scalarType: 'float_or_percent',
      elementCount: 1,
      sourceValue: { value: 0.5, percent: true },
      effectiveValue: { value: 0.5, percent: true },
    };
    const snapshot: PresetDraftSnapshot = {
      ...base,
      sourceValues: { ...base.sourceValues, filament_diameter: JSON.stringify([{ value: 0.5, percent: true }]) },
      effectiveValues: { ...base.effectiveValues, filament_diameter: JSON.stringify([{ value: 0.5, percent: true }]) },
      optionMetadata: { ...base.optionMetadata, filament_diameter: { type: 'float_or_percent' } },
      editorBindings: { ...base.editorBindings, filament_diameter: floatOrPercent },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(snapshot, request));
    await mount(snapshot, vi.fn(), undefined, onMutate);
    const input = document.querySelector('[data-testid="preset-editor-input-filament_diameter"]') as HTMLInputElement;
    expect(input.value).toBe('0.5');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_diameter"]')?.textContent).toBe('0.5%');
    expect(document.querySelector('[data-testid="preset-editor-unit-filament_diameter"]')?.textContent?.toLowerCase()).toContain('percent');
    await changeInput(input, '1.25');
    await press(input, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_diameter', scalarType: 'float_or_percent', value: { value: 1.25, percent: true } }));
  });

  it('edits Filament scripts in a multiline control and keeps the full source script visible', async () => {
    const source = snapshotFor('filament');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-page-tab-advanced"]'));
    const startGcode = document.querySelector('[data-testid="preset-editor-input-filament_start_gcode"]') as HTMLTextAreaElement;
    expect(startGcode.tagName).toBe('TEXTAREA');
    expect(startGcode.value).toBe('G28\nM104 S220\n');
    expect(document.querySelector('[data-testid="preset-editor-source-filament_start_gcode"]')?.textContent)
      .toBe('G28\nM104 S220\n');
    await changeTextarea(startGcode, 'G28\nM104 S205\nM140 S60\n');
    await act(async () => { startGcode.blur(); });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_start_gcode', scalarType: 'string', index: 0, value: 'G28\nM104 S205\nM140 S60\n' }));
  });

  it('sends explicit field and category reset scopes and a title reset-preset command', async () => {
    const sourceBase = snapshotFor('printer', { modified: true });
    const source: PresetDraftSnapshot = {
      ...sourceBase,
      overrides: { ...sourceBase.overrides, printer_variant: 'custom-variant' },
      effectiveValues: { ...sourceBase.effectiveValues, printer_variant: 'custom-variant' },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-printable_height"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reset-field', key: 'printable_height' }));
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).not.toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');

    const activePage = PRINTER_PRESET_EDITOR_MANIFEST.pages[0]!;
    await click(document.querySelector(`[data-testid="preset-editor-reset-category-${activePage.id}"]`));
    expect(onMutate).toHaveBeenLastCalledWith({
      kind: 'printer', canonicalName: 'Printer Canonical', expectedRevision: 2,
      action: 'reset-category', keys: activePage.groups.flatMap((optionGroup) => optionGroup.fields.map((field) => field.key)),
    });
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(false);

    await click(document.querySelector('[data-testid="preset-editor-reset-preset"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reset-preset' }));
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets quoted multiline Filament notes from the typed source binding without a follow-up set', async () => {
    const base = snapshotFor('filament');
    const sourceNotes = 'Source "notes" with quotes\nand a second line\n';
    const source: PresetDraftSnapshot = {
      ...base,
      sourceValues: { ...base.sourceValues, filament_notes: JSON.stringify([sourceNotes]) },
      effectiveValues: { ...base.effectiveValues, filament_notes: JSON.stringify([sourceNotes]) },
      editorBindings: {
        ...base.editorBindings,
        filament_notes: { ...base.editorBindings.filament_notes!, sourceValue: sourceNotes, effectiveValue: sourceNotes },
      },
    };
    let current = source;
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = result;
      return result;
    });
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    const notes = document.querySelector('[data-testid="preset-editor-input-filament_notes"]') as HTMLTextAreaElement;
    await changeTextarea(notes, 'Edited "notes"\nwith another line\n');
    await act(async () => { notes.blur(); });
    expect(notes.value).toBe('Edited "notes"\nwith another line\n');
    await click(document.querySelector('[data-testid="preset-editor-reset-field-filament_notes"]'));

    expect(notes.value).toBe(sourceNotes);
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe(sourceNotes);
    expect(onMutate.mock.calls.map(([request]) => request.action)).toEqual(['set-element', 'reset-field']);
  });

  it('restores nullable text and percent controls from typed field reset bindings without extra sets', async () => {
    const base = snapshotFor('filament');
    const nullableNotes: PresetDraftEditorBinding = {
      ...base.editorBindings.filament_notes!, nullable: true, sourceValue: null, effectiveValue: null,
    };
    const source: PresetDraftSnapshot = {
      ...base,
      editorBindings: { ...base.editorBindings, filament_notes: nullableNotes },
      sourceValues: { ...base.sourceValues, filament_notes: JSON.stringify([null]) },
      effectiveValues: { ...base.effectiveValues, filament_notes: JSON.stringify([null]) },
    };
    let current = source;
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = result;
      return result;
    });
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    const notes = document.querySelector('[data-testid="preset-editor-input-filament_notes"]') as HTMLTextAreaElement;
    await click(document.querySelector('[data-testid="preset-editor-null-filament_notes"]'));
    expect(notes.disabled).toBe(false);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-filament_notes"]'));
    expect(notes.value).toBe('');
    expect(document.querySelector('[data-testid="preset-editor-null-filament_notes"]')?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe('(null)');

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    const shrink = document.querySelector('[data-testid="preset-editor-input-filament_shrink"]') as HTMLInputElement;
    await changeInput(shrink, '95');
    await press(shrink, 'Enter');
    await click(document.querySelector('[data-testid="preset-editor-reset-field-filament_shrink"]'));
    expect(shrink.value).toBe('100');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_shrink"]')?.textContent).toBe('100%');
    expect(onMutate.mock.calls.map(([request]) => request.action)).toEqual([
      'set-element', 'reset-field', 'set-element', 'reset-field',
    ]);
  });

  it('excludes layout-only manifest fields from a category reset while retaining native read-only keys', async () => {
    const base = snapshotFor('printer');
    const sourceValues: Record<string, string> = { ...base.sourceValues };
    const effectiveValues: Record<string, string> = { ...base.effectiveValues, manual_filament_change: '1' };
    const optionMetadata: Record<string, OptionMeta> = { ...base.optionMetadata };
    delete sourceValues.extruders_count;
    delete effectiveValues.extruders_count;
    delete optionMetadata.extruders_count;
    const source: PresetDraftSnapshot = {
      ...base,
      sourceValues,
      effectiveValues,
      optionMetadata,
      overrides: { manual_filament_change: '1' },
      modified: true,
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-multimaterial"]'));
    await click(document.querySelector('[data-testid="preset-editor-reset-category-multimaterial"]'));
    const request = onMutate.mock.calls.at(-1)?.[0] as Extract<PresetDraftMutationRequest, { action: 'reset-category' }>;
    expect(request.action).toBe('reset-category');
    expect(request.keys).toContain('single_extruder_multi_material');
    expect(request.keys).toContain('manual_filament_change');
    expect(request.keys).not.toContain('extruders_count');
  });

  it('retains an empty draft after resetting its last field override', async () => {
    const source = snapshotFor('printer', { modified: true });
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-printable_height"]'));
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps rejected text visible with the native error and leaves effective state untouched', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async () => ({ ok: false as const, errorCode: 'stale_revision', error: 'stale native draft' }));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '240');
    await press(height, 'Enter');
    expect(height.value).toBe('240');
    expect(document.querySelector('[data-testid="preset-editor-error-printable_height"]')?.textContent).toBe('stale native draft');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');
  });
});
