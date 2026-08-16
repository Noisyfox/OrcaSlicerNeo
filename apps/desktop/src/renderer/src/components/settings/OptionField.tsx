// apps/desktop/src/renderer/src/components/settings/OptionField.tsx
import type { OptionMeta } from '@slicer/client';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export function OptionField({ optionKey, meta }: { optionKey: string; meta: OptionMeta }) {
  const value = useSettingsStore((s) => s.values[optionKey] ?? meta.default ?? '');
  const setValue = useSettingsStore((s) => s.setValue);
  const label = meta.label ?? optionKey;

  if (meta.type === 'bool') {
    return (
      <div className="flex items-center justify-between py-1">
        <Label htmlFor={optionKey} className="text-xs text-muted-foreground">{label}</Label>
        <Checkbox
          id={optionKey}
          checked={value === '1'}
          onChange={(e) => setValue(optionKey, e.target.checked ? '1' : '0')}
        />
      </div>
    );
  }

  if (meta.type === 'enum' && meta.enum_values?.length) {
    return (
      <div className="space-y-1 py-1">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <Select value={value} onValueChange={(v) => v != null && setValue(optionKey, v)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder={value} />
          </SelectTrigger>
          <SelectContent>
            {meta.enum_values.map((ev) => (
              <SelectItem key={ev} value={ev}>{ev}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="space-y-1 py-1">
      <Label htmlFor={optionKey} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={optionKey}
        className="h-8 text-xs"
        value={value}
        min={meta.min}
        max={meta.max}
        type={['float', 'int'].includes(meta.type) ? 'number' : 'text'}
        step={meta.type === 'int' ? 1 : 'any'}
        onChange={(e) => setValue(optionKey, e.target.value)}
      />
    </div>
  );
}
