// packages/slicer-app/src/components/settings/OptionField.tsx
import type { OptionMeta, NativeScopedConfigTarget } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { useEffect, useRef, useState } from 'react';
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
  target: NativeScopedConfigTarget = { scope: 'project' },
): Promise<void> {
  const mutation = await commitSharedConfigurationMutation(platform, optionKey, next, target);
  invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
}

export function OptionField({ optionKey, meta, target = { scope: 'project' } }: {
  optionKey: string;
  meta: OptionMeta;
  target?: NativeScopedConfigTarget;
}) {
  const platform = usePlatform();
  const value = useSettingsStore((s) => {
    if (target.scope === 'project') return s.values[optionKey] ?? meta.default ?? '';
    const id = target.id === undefined ? '' : String(target.id);
    return s.nativeScopedConfig[target.scope === 'object' ? 'objects' : 'parts'][id]?.[optionKey]
      ?? meta.default ?? '';
  });
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const committing = useRef(false);
  const setError = useSlicerStore((s) => s.setError);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = async (next: string) => {
    if (committing.current) return;
    committing.current = true;
    try {
      await commitOptionFieldChange(platform, optionKey, next, target);
      const state = useSettingsStore.getState();
      const id = target.id === undefined ? '' : String(target.id);
      const effective = target.scope === 'project'
        ? state.values[optionKey]
        : state.nativeScopedConfig[target.scope === 'object' ? 'objects' : 'parts'][id]?.[optionKey];
      setDraft(effective ?? next);
    } catch (error) {
      setError(errorText(error));
    } finally {
      committing.current = false;
    }
  };
  const commitDraft = () => {
    if (draft === value) return;
    void commit(draft);
  };
  const cancelDraft = () => setDraft(value);
  const changeDiscrete = (next: string) => {
    setDraft(next);
    // Scoped overrides cannot know their affected plate set until the native
    // transaction returns. Shared project settings retain the existing
    // immediate invalidation behavior.
    if (target.scope === 'project') invalidateAfterSharedConfigurationMutation();
    void commit(next);
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
          onCheckedChange={(checked) => changeDiscrete(checked ? '1' : '0')}
        />
      </div>
    );
  }

  if (meta.type === 'enum' && meta.enum_values?.length) {
    return (
      <div className={row}>
        <Label className={labelCls} title={label}>{label}</Label>
        <Select value={value} onValueChange={(v) => v != null && changeDiscrete(v)}>
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
        value={draft}
        min={meta.min}
        max={meta.max}
        type={numeric ? 'number' : 'text'}
        step={meta.type === 'int' ? 1 : 'any'}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commitDraft(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); focused.current = false; commitDraft(); }
          else if (e.key === 'Escape') { e.preventDefault(); focused.current = false; cancelDraft(); e.currentTarget.blur(); }
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          // A draft must invalidate stale preview output immediately, while
          // the Worker/history write remains deferred until commit.
          if (target.scope === 'project') invalidateAfterSharedConfigurationMutation();
        }}
        className="flex-1"
      />
    </div>
  );
}
