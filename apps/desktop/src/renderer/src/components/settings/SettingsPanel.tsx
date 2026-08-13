// apps/desktop/src/renderer/src/components/settings/SettingsPanel.tsx
import { useMemo } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
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

export function SettingsPanel() {
  const metadata = useSettingsStore((s) => s.metadata);
  const printers = useSettingsStore((s) => s.printers);
  const prints = useSettingsStore((s) => s.prints);
  const filaments = useSettingsStore((s) => s.filaments);
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);

  // Only render option keys the metadata actually declares (no duplicated
  // schema — PROCESS_KEYS is a render hint, not the schema).
  const processKeys = useMemo(
    () => PROCESS_KEYS.filter((k) => metadata?.[k] !== undefined),
    [metadata],
  );

  if (!metadata) {
    return <div className="p-3 text-xs text-muted-foreground">Loading presets…</div>;
  }

  return (
    <div className="space-y-4 p-3">
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Presets</h2>
        <PresetRow label="Printer" items={printers} value={values['printer'] ?? ''} onValue={(v) => setValue('printer', v)} />
        <PresetRow label="Process" items={prints} value={values['print'] ?? ''} onValue={(v) => setValue('print', v)} />
        <PresetRow label="Filament" items={filaments} value={values['filament'] ?? ''} onValue={(v) => setValue('filament', v)} />
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

function PresetRow({ label, items, value, onValue }: {
  label: string;
  items: string[];
  value: string;
  onValue: (v: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1 py-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || undefined} onValueChange={onValue}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="— select —" />
        </SelectTrigger>
        <SelectContent>
          {items.map((name) => (
            <SelectItem key={name} value={name}>{name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
