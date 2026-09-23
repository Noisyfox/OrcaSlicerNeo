import { useEffect, useMemo, useState } from 'react';
import type { OptionMeta, PresetDraftSnapshot } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  FILAMENT_PRESET_EDITOR_MANIFEST,
  PRINTER_PRESET_EDITOR_MANIFEST,
  type PresetEditorManifest,
  type PresetEditorManifestField,
  type PresetEditorManifestGroup,
  type PresetEditorManifestPage,
} from './presetEditorManifests';

export interface PresetEditorDialogProps {
  /** One native target at a time. Pass null when there is no active editor. */
  readonly snapshot: PresetDraftSnapshot | null;
  /** Current one-based rack slots that select this Filament source. */
  readonly referencedFilamentSlots?: readonly number[];
  readonly onClose: () => void;
}

interface RoutedField {
  readonly page: PresetEditorManifestPage;
  readonly group: PresetEditorManifestGroup;
  readonly field: PresetEditorManifestField;
}

function manifestFor(snapshot: PresetDraftSnapshot): PresetEditorManifest {
  return snapshot.kind === 'printer'
    ? PRINTER_PRESET_EDITOR_MANIFEST
    : FILAMENT_PRESET_EDITOR_MANIFEST;
}

function printerExtruderCount(snapshot: PresetDraftSnapshot): number | null {
  const serialized = snapshot.effectiveValues.nozzle_diameter ?? snapshot.sourceValues.nozzle_diameter;
  if (!serialized) return null;
  const diameters = serialized.split(',');
  if (diameters.some((diameter) => {
    const value = Number(diameter.trim());
    return !Number.isFinite(value) || value <= 0;
  })) return null;
  return diameters.length;
}

function pageInstances(manifest: PresetEditorManifest, snapshot: PresetDraftSnapshot): PresetEditorManifestPage[] {
  return manifest.pages.flatMap((page) => {
    if (manifest.kind !== 'printer' || page.id !== 'extruder') return [page];
    const count = printerExtruderCount(snapshot);
    if (count === null) return [page];
    return Array.from({ length: count }, (_, index) => ({
      ...page,
      id: `extruder-${index + 1}`,
      title: `Extruder ${index + 1}`,
    }));
  });
}

function labelFor(field: PresetEditorManifestField, metadata: OptionMeta | undefined): string {
  return metadata?.label ?? metadata?.full_label ?? field.key;
}

function displayValue(values: Readonly<Record<string, string>>, key: string): string {
  const value = values[key];
  if (value === undefined) return '—';
  return value.length === 0 ? '(empty)' : value;
}

function searchText(field: PresetEditorManifestField, metadata: OptionMeta | undefined): string {
  return [field.key, metadata?.label, metadata?.full_label, metadata?.tooltip]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLocaleLowerCase();
}

function FieldValue({
  field,
  metadata,
  snapshot,
  page,
  group,
}: {
  field: PresetEditorManifestField;
  metadata: OptionMeta | undefined;
  snapshot: PresetDraftSnapshot;
  page?: PresetEditorManifestPage;
  group?: PresetEditorManifestGroup;
}) {
  const label = labelFor(field, metadata);
  const readOnly = field.access === 'read-only';
  const tooltip = metadata?.tooltip;
  return (
    <article
      data-testid={`preset-editor-field-${field.key}`}
      data-field-key={field.key}
      data-field-access={field.access}
      data-native-type={metadata?.type ?? 'unknown'}
      data-native-min={metadata?.min}
      data-native-max={metadata?.max}
      aria-disabled={readOnly || undefined}
      title={tooltip}
      className="min-w-0 rounded-md border bg-background/70 px-3 py-2"
    >
      {page && group && <p className="mb-1 text-[0.7rem] text-muted-foreground" data-testid={`preset-editor-context-${field.key}`}>
        {page.title} / {group.title}
      </p>}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={label}>{label}</p>
          <code className="break-all text-[0.7rem] text-muted-foreground">{field.key}</code>
        </div>
        {readOnly && <span
          data-testid={`preset-editor-readonly-${field.key}`}
          title={field.readOnlyReason}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
        >Read only</span>}
      </div>
      {readOnly && field.readOnlyReason && <p className="mt-1 text-[0.7rem] text-muted-foreground">{field.readOnlyReason}</p>}
      <dl className="mt-2 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Source</dt>
        <dd data-testid={`preset-editor-source-${field.key}`} className="break-all">{displayValue(snapshot.sourceValues, field.key)}</dd>
        <dt className="text-muted-foreground">Effective</dt>
        <dd data-testid={`preset-editor-effective-${field.key}`} className="break-all">{displayValue(snapshot.effectiveValues, field.key)}</dd>
      </dl>
    </article>
  );
}

function FieldGroup({
  page,
  group,
  snapshot,
}: {
  page: PresetEditorManifestPage;
  group: PresetEditorManifestGroup;
  snapshot: PresetDraftSnapshot;
}) {
  const titleId = `preset-editor-group-title-${page.id}-${group.id}`;
  return (
    <section
      data-testid={`preset-editor-group-${page.id}-${group.id}`}
      aria-labelledby={titleId}
      className="min-w-0 space-y-2"
    >
      <h3 id={titleId} className="text-sm font-semibold">{group.title}</h3>
      <div className="grid min-w-0 gap-2 xl:grid-cols-2">
        {group.fields.map((field) => <FieldValue
          key={field.key}
          field={field}
          metadata={snapshot.optionMetadata[field.key]}
          snapshot={snapshot}
          page={page}
          group={group}
        />)}
      </div>
    </section>
  );
}

function routedFields(pages: readonly PresetEditorManifestPage[]): RoutedField[] {
  return pages.flatMap((page) => page.groups.flatMap((group) =>
    group.fields.map((field) => ({ page, group, field }))));
}

function referencedSlotsLabel(slots: readonly number[]): string {
  if (slots.length === 0) return 'No current filament slots use this source.';
  const ordered = [...new Set(slots)].sort((left, right) => left - right);
  const slotLabels = ordered.map((slot) => `slot ${slot}`);
  const slotsText = slotLabels.length === 1
    ? slotLabels[0]
    : `${slotLabels.slice(0, -1).join(', ')} and ${slotLabels.at(-1)}`;
  return `Used by ${slotsText}. Editing this source affects those slots.`;
}

export function PresetEditorDialog({ snapshot, referencedFilamentSlots = [], onClose }: PresetEditorDialogProps) {
  const manifest = snapshot ? manifestFor(snapshot) : null;
  const pages = useMemo(() => manifest && snapshot ? pageInstances(manifest, snapshot) : [], [manifest, snapshot]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const targetKey = snapshot ? `${snapshot.kind}:${snapshot.canonicalName}` : '';

  useEffect(() => {
    setActivePageId(null);
    setSearch('');
  }, [targetKey]);

  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null;
  const query = search.trim().toLocaleLowerCase();
  const searchResults = useMemo(() => {
    if (!manifest || !snapshot || !query) return [];
    return routedFields(pages).filter(({ field }) =>
      searchText(field, snapshot.optionMetadata[field.key]).includes(query));
  }, [manifest, pages, query, snapshot]);

  const showSearchResults = query.length > 0;
  return (
    <Dialog open={snapshot !== null} onOpenChange={(open) => { if (!open && snapshot) onClose(); }}>
      {snapshot && manifest && <DialogContent
        data-testid="preset-editor-dialog"
        className="flex max-h-[88vh] w-[min(94vw,72rem)] max-w-none flex-col gap-4 overflow-hidden p-5"
      >
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle id="preset-editor-title" data-testid="preset-editor-title" className="truncate text-lg">
              {snapshot.canonicalName}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {snapshot.kind === 'printer' ? 'Printer preset' : 'Filament preset'}
            </DialogDescription>
            {snapshot.kind === 'filament' && <p
              data-testid="preset-editor-slot-reference"
              className="mt-1 text-xs text-muted-foreground"
            >{referencedSlotsLabel(referencedFilamentSlots)}</p>}
          </div>
          {snapshot.modified && <span
            data-testid="preset-editor-project-draft"
            className="shrink-0 rounded border px-2 py-1 text-xs"
          >Project draft</span>}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <Input
            type="search"
            aria-label={`Search ${snapshot.kind} preset settings`}
            data-testid="preset-editor-search"
            placeholder="Search by name, key, or help text"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />

          {!showSearchResults && <div role="tablist" aria-label="Preset setting pages" className="flex shrink-0 gap-1 overflow-x-auto border-b">
            {pages.map((page) => <button
              key={page.id}
              id={`preset-editor-tab-${page.id}`}
              type="button"
              role="tab"
              aria-selected={activePage?.id === page.id}
              aria-controls={`preset-editor-page-${page.id}`}
              data-testid={`preset-editor-page-tab-${page.id}`}
              onClick={() => { setActivePageId(page.id); setSearch(''); }}
              className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            >{page.title}</button>)}
          </div>}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {showSearchResults ? (
              <div data-testid="preset-editor-search-results" className="space-y-3">
                {searchResults.length === 0
                  ? <p className="py-4 text-sm text-muted-foreground">No matching settings.</p>
                  : searchResults.map(({ page, group, field }) => <FieldValue
                    key={`${page.id}:${group.id}:${field.key}`}
                    field={field}
                    metadata={snapshot.optionMetadata[field.key]}
                    snapshot={snapshot}
                    page={page}
                    group={group}
                  />)}
              </div>
            ) : activePage ? (
              <div
                id={`preset-editor-page-${activePage.id}`}
                role="tabpanel"
                aria-labelledby={`preset-editor-tab-${activePage.id}`}
                data-testid={`preset-editor-page-${activePage.id}`}
                className="space-y-5 pb-1"
              >
                {activePage.groups.map((optionGroup) => <FieldGroup
                  key={optionGroup.id}
                  page={activePage}
                  group={optionGroup}
                  snapshot={snapshot}
                />)}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose} data-testid="preset-editor-close">Close</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  );
}
