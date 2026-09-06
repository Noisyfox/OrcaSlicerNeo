// packages/slicer-app/src/components/settings/OptionField.tsx
import type { OptionMeta } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { errorText } from '@orca/slicer-runtime';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { commitSharedConfigurationMutation, invalidateAfterSharedConfigurationMutation } from './configurationActions';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export async function commitOptionFieldChange(
  platform: Parameters<typeof commitSharedConfigurationMutation>[0],
  optionKey: string,
  next: string,
): Promise<void> {
  await commitSharedConfigurationMutation(platform);
  useSettingsStore.getState().setValue(optionKey, next);
  invalidateAfterSharedConfigurationMutation();
}

export function OptionField({ optionKey, meta }: { optionKey: string; meta: OptionMeta }) {
  const platform = usePlatform();
  const value = useSettingsStore((s) => s.values[optionKey] ?? meta.default ?? '');
  const setError = useSlicerStore((s) => s.setError);
  const change = async (next: string) => {
    try {
      // A settings override belongs to a new configuration. The shared
      // helper commits the authoritative bridge transaction before changing
      // the local value, so a rejection cannot look committed in the UI.
      await commitOptionFieldChange(platform, optionKey, next);
    } catch (error) {
      setError(errorText(error));
    }
  };
  const label = meta.label ?? optionKey;

  // Fixed-width label column (w-32) keeps the value column vertically aligned
  // across all rows; the value control flexes to fill the rest of the row.
  const row = 'flex items-center gap-1 py-0.5 min-h-7';
  const labelCls = 'w-32 shrink-0 truncate text-xs text-muted-foreground';

  if (meta.type === 'bool') {
    return (
      <div className={row}>
        <Label htmlFor={optionKey} className={labelCls} title={label}>{label}</Label>
        <Checkbox
          id={optionKey}
          checked={value === '1'}
          onCheckedChange={(checked) => change(checked ? '1' : '0')}
        />
      </div>
    );
  }

  if (meta.type === 'enum' && meta.enum_values?.length) {
    return (
      <div className={row}>
        <Label className={labelCls} title={label}>{label}</Label>
        <Select value={value} onValueChange={(v) => v != null && change(v)}>
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
        onChange={(e) => change(e.target.value)}
        className="flex-1"
      />
    </div>
  );
}
