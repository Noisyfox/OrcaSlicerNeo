// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OptionMeta, PresetDraftKind, PresetDraftSnapshot } from '@slicer/client';
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

async function mount(snapshot: PresetDraftSnapshot | null, onClose = vi.fn(), referencedFilamentSlots?: readonly number[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<PresetEditorDialog snapshot={snapshot} referencedFilamentSlots={referencedFilamentSlots} onClose={onClose} />);
  });
  return { container, root, onClose };
}

async function click(element: Element | null) {
  if (!element) throw new Error('expected a clickable element');
  await act(async () => { (element as HTMLElement).click(); });
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
    await act(async () => { root.render(<PresetEditorDialog snapshot={snapshotFor('printer')} onClose={vi.fn()} />); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer Canonical');

    await act(async () => { root.render(<PresetEditorDialog snapshot={snapshotFor('filament')} onClose={vi.fn()} />); });
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
});
