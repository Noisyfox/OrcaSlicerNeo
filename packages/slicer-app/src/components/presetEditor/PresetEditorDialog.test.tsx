// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionMeta, PresetDraftKind, PresetDraftMutationRequest, PresetDraftMutationResult, PresetDraftSnapshot } from '@slicer/client';
import { PresetEditorDialog } from './PresetEditorDialog';
import {
  FILAMENT_PRESET_EDITOR_MANIFEST,
  PRINTER_PRESET_EDITOR_MANIFEST,
  presetEditorFields,
} from './presetEditorManifests';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let roots: Root[] = [];

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

  if (kind === 'printer') {
    sourceValues.printable_height = '230';
    effectiveValues.printable_height = options.modified ? '245' : '230';
    optionMetadata.printable_height = { type: 'float', label: 'Build height', tooltip: 'Height of the build volume', min: 1, max: 1000 };
    optionMetadata.printer_agent = { type: 'enum', label: 'Printer Agent', tooltip: 'Network agent selector', enum_values: ['default'] };
    optionMetadata.machine_start_gcode = { type: 'string', label: 'Machine start script', tooltip: 'Distinctive machine start help text' };
    optionMetadata.printer_notes = { type: 'string', label: 'Printer notes', tooltip: 'Notes tooltip' };
    optionMetadata.time_cost = { type: 'string', label: 'Time cost' };
    optionMetadata.support_multi_bed_types = { type: 'bool', label: 'Multiple beds' };
  } else {
    optionMetadata.filament_type = { type: 'enum', label: 'Filament type', enum_values: ['PLA', 'PETG'], enum_labels: ['PLA', 'PETG'] };
    optionMetadata.filament_vendor = { type: 'string', label: 'Vendor' };
    optionMetadata.filament_diameter = { type: 'float', label: 'Diameter' };
    optionMetadata.default_filament_colour = { type: 'strings', label: 'Default colour' };
    optionMetadata.enable_pressure_advance = { type: 'bool', label: 'Pressure advance' };
  }
  const modifiedKey = kind === 'printer' ? 'printable_height' : 'filament_flow_ratio';
  if (options.modified) effectiveValues[modifiedKey] = '245';

  return {
    ok: true,
    version: 1,
    kind,
    canonicalName: kind === 'printer' ? 'Printer Canonical' : 'Filament Canonical',
    draftExists: options.draftExists ?? true,
    modified: options.modified ?? false,
    overrides: options.modified ? { [kind === 'printer' ? 'printable_height' : 'filament_flow_ratio']: '245' } : {},
    sourceValues,
    effectiveValues,
    optionMetadata,
    revision: 1,
  };
}

function mutationSuccess(snapshot: PresetDraftSnapshot, request: PresetDraftMutationRequest): PresetDraftMutationResult {
  const next = { ...snapshot };
  let overrides = { ...snapshot.overrides };
  let effectiveValues = { ...snapshot.effectiveValues };
  if (request.action === 'set') {
    overrides[request.key] = request.value;
    effectiveValues[request.key] = request.value;
  } else if (request.action === 'reset-field') {
    delete overrides[request.key];
    effectiveValues[request.key] = snapshot.sourceValues[request.key] ?? '';
  } else if (request.action === 'reset-category') {
    for (const key of request.keys) {
      delete overrides[key];
      effectiveValues[key] = snapshot.sourceValues[key] ?? '';
    }
  } else {
    overrides = {};
    effectiveValues = { ...snapshot.sourceValues };
  }
  return {
    ...next,
    overrides,
    effectiveValues,
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
    ok: false, version: 1, error: 'mutation fixture not configured',
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

async function press(input: HTMLInputElement, key: string) {
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
      expect(pageTabs).toEqual(manifest.pages.map((page) => page.title));

      for (const [pageIndex, page] of manifest.pages.entries()) {
        if (pageIndex > 0) await click(document.querySelector(`[data-testid="preset-editor-page-tab-${page.id}"]`));
        expect(groupHeadings(page.id)).toEqual(page.groups.map((optionGroup) => optionGroup.title));
        expect(visibleFieldKeys(page.id)).toEqual(page.groups.flatMap((optionGroup) => optionGroup.fields.map((field) => field.key)));
      }
    },
  );

  it('expands the Printer Extruder template into ordered per-extruder pages from the effective nozzle vector', async () => {
    const source = snapshotFor('printer');
    const snapshot: PresetDraftSnapshot = {
      ...source,
      sourceValues: { ...source.sourceValues, nozzle_diameter: '0.4' },
      effectiveValues: { ...source.effectiveValues, nozzle_diameter: '0.4,0.6' },
    };
    const template = PRINTER_PRESET_EDITOR_MANIFEST.pages.find((page) => page.id === 'extruder');
    if (!template) throw new Error('expected the explicit Printer Extruder page template');

    await mount(snapshot);
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

  it('marks a modified draft and lists the numbered slots sharing its Filament source', async () => {
    await mount(snapshotFor('filament', { modified: true }), vi.fn(), [3, 1, 3]);
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')?.textContent).toBe('Project draft');
    expect(document.querySelector('[data-testid="preset-editor-source-filament_flow_ratio"]')?.textContent).toBe('source:filament_flow_ratio');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_flow_ratio"]')?.textContent).toBe('245');
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
      ['nozzle_diameter', 'extruder'],
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

  it('marks Filament arrays and specialized controls visibly read-only', async () => {
    await mount(snapshotFor('filament'));
    const cases = [
      ['filament_flow_ratio', 'filament'],
      ['adaptive_pressure_advance_model', 'filament'],
      ['filament_start_gcode', 'advanced'],
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
    const visibleActions = [...document.querySelectorAll('[role="dialog"] button')].map((button) => button.textContent?.trim());
    expect(visibleActions).toContain('Close');
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

  it('commits boolean, enum, and colour controls immediately', async () => {
    const source = snapshotFor('filament');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-input-filament_type"]'));
    const petg = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'PETG');
    if (!petg) throw new Error('expected PETG select option');
    await act(async () => {
      petg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      petg.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set', key: 'filament_type', value: 'PETG' }));

    await click(document.querySelector('[data-testid="preset-editor-input-enable_pressure_advance"]'));
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set', key: 'enable_pressure_advance', value: '1' }));

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    const colour = document.querySelector('[data-testid="preset-editor-input-default_filament_colour"]') as HTMLInputElement;
    await act(async () => {
      colour.value = '#223344';
      colour.dispatchEvent(new Event('input', { bubbles: true }));
      colour.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set', key: 'default_filament_colour', value: '#223344' }));
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
    const onMutate = vi.fn(async () => ({ ok: false as const, version: 1 as const, errorCode: 'stale_revision', error: 'stale native draft' }));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '240');
    await press(height, 'Enter');
    expect(height.value).toBe('240');
    expect(document.querySelector('[data-testid="preset-editor-error-printable_height"]')?.textContent).toBe('stale native draft');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');
  });
});
