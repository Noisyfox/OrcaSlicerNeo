// apps/desktop/src/renderer/src/components/settings/SettingsPanel.tsx
import { useMemo } from 'react';
import type { PresetInfo } from '@slicer/client';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { OptionField } from './OptionField';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

const PROCESS_KEYS = [
  'layer_height', 'wall_loops', 'top_shell_layers', 'bottom_shell_layers',
  'sparse_infill_density', 'sparse_infill_pattern', 'enable_support',
  'nozzle_temperature', 'nozzle_temperature_initial_layer',
  'hot_plate_temp_initial_layer', 'print_speed', 'outer_wall_speed',
  'sparse_infill_speed', 'travel_speed',
];

type PresetKind = 'printer' | 'print' | 'filament';

export function SettingsPanel() {
  const metadata = useSettingsStore((s) => s.metadata);
  const printers = useSettingsStore((s) => s.printers);
  const prints = useSettingsStore((s) => s.prints);
  const filaments = useSettingsStore((s) => s.filaments);
  const selectedPrinter = useSettingsStore((s) => s.selectedPrinter);
  const selectedPrint = useSettingsStore((s) => s.selectedPrint);
  const selectedFilament = useSettingsStore((s) => s.selectedFilament);
  const setSelections = useSettingsStore((s) => s.setSelections);
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);
  const setError = useSlicerStore((s) => s.setError);

  // Only render option keys the metadata actually declares (no duplicated
  // schema — PROCESS_KEYS is a render hint, not the schema).
  const processKeys = useMemo(
    () => PROCESS_KEYS.filter((k) => metadata?.[k] !== undefined),
    [metadata],
  );

  // M4: the picker drives the REAL bridge selection (selectPreset) and
  // persists the authoritative app config back through main. The response
  // carries all three selections — a printer change re-runs the compat
  // tail and moves print/filament with it, so we sync all three at once.
  async function handleSelectPreset(kind: PresetKind, name: string) {
    try {
      const r = await slicerClient.selectPreset(kind, name);
      if (!r.ok) throw new Error(r.error ?? 'selectPreset failed');
      setSelections(r.printer.name, r.print.name, r.filament.name);
      const cfg = await slicerClient.getAppConfig();
      if (!cfg.ok) throw new Error(cfg.error ?? 'getAppConfig failed');
      await window.orca.appConfig.save(cfg);
    } catch (err) {
      setError(`select ${kind}: ${String(err)}`);
    }
  }

  if (!metadata) {
    return <div className="p-3 text-xs text-muted-foreground">Loading presets…</div>;
  }

  return (
    <div className="space-y-4 p-3">
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Presets</h2>
        <PresetRow label="Printer" items={printers} value={selectedPrinter} onValue={(v) => handleSelectPreset('printer', v)} testId="preset-select" />
        <PresetRow label="Process" items={prints} value={selectedPrint} onValue={(v) => handleSelectPreset('print', v)} />
        <PresetRow label="Filament" items={filaments} value={selectedFilament} onValue={(v) => handleSelectPreset('filament', v)} />
      </section>
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Process</h2>
        {processKeys.map((k) => (
          <OptionField key={k} optionKey={k} meta={metadata[k]} />
        ))}
      </section>
    </div>
  );
}

// Installed (visible) presets first; the rest in a dimmed, disabled
// "Not installed" group. The grouping comes from the bridge's REAL
// set_visible_from_appconfig result — never client-side logic (v1 has no
// install/uninstall UI, so the group is inert).
function PresetRow({ label, items, value, onValue, testId }: {
  label: string;
  items: PresetInfo[];
  value: string;
  onValue: (name: string) => void;
  testId?: string;
}) {
  const installed = items.filter((p) => p.is_visible);
  const hidden = items.filter((p) => !p.is_visible);
  if (installed.length === 0 && hidden.length === 0) return null;
  return (
    <div className="space-y-1 py-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || undefined} onValueChange={(v) => v != null && onValue(v)}>
        <SelectTrigger className="h-8 text-xs" data-testid={testId}>
          <SelectValue placeholder="— select —" />
        </SelectTrigger>
        <SelectContent>
          {installed.map((p) => (
            <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
          ))}
          {hidden.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                Not installed
              </div>
              {hidden.map((p) => (
                <SelectItem key={p.name} value={p.name} disabled>{p.name}</SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
