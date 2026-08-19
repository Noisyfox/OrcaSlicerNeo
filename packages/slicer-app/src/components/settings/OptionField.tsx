// apps/desktop/src/renderer/src/components/settings/OptionField.tsx
import type { OptionMeta } from '@slicer/client';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function OptionField({ optionKey, meta }: { optionKey: string; meta: OptionMeta }) {
  const value = useSettingsStore((s) => s.values[optionKey] ?? meta.default ?? '');
  const setValue = useSettingsStore((s) => s.setValue);
  const label = meta.label ?? optionKey;

  // Fixed-width label column (w-32) keeps the value column vertically aligned
  // across all rows; the value control flexes to fill the rest of the row.
  const row = 'flex items-center gap-2 py-1';
  const labelCls = 'w-32 shrink-0 truncate text-xs text-muted-foreground';

  if (meta.type === 'bool') {
    return (
      <div className={row}>
        <Label htmlFor={optionKey} className={labelCls} title={label}>{label}</Label>
        <Checkbox
          id={optionKey}
          checked={value === '1'}
          onCheckedChange={(checked) => setValue(optionKey, checked ? '1' : '0')}
        />
      </div>
    );
  }

  if (meta.type === 'enum' && meta.enum_values?.length) {
    return (
      <div className={row}>
        <Label className={labelCls} title={label}>{label}</Label>
        <Select value={value} onValueChange={(v) => v != null && setValue(optionKey, v)}>
          <SelectTrigger className="flex-1">
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

  const numeric = meta.type === 'float' || meta.type === 'int';

  return (
    <div className={row}>
      <Label htmlFor={optionKey} className={labelCls} title={label}>{label}</Label>
      <Input
        id={optionKey}
        value={value}
        min={meta.min}
        max={meta.max}
        type={numeric ? 'number' : 'text'}
        step={meta.type === 'int' ? 1 : 'any'}
        onChange={(e) => setValue(optionKey, e.target.value)}
        className="flex-1"
      />
    </div>
  );
}
